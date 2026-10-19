import fc from 'fast-check';
import { BatchHoldStatus, StockTxnType, ValuationMethod } from '@sil/shared';
import { allocateFefo, FefoCandidate, fefoCompare, isUsable } from '../src/modules/inventory/fefo';
import { MovementLine, postMovements, StockRuleError } from '../src/modules/inventory/posting';
import { createTestApp, idByCode, TestContext, uniq } from './helpers';

const day = (n: number) => new Date(Date.UTC(2026, 0, 1) + n * 86_400_000).toISOString().slice(0, 10);

const candidateArb: fc.Arbitrary<FefoCandidate> = fc.record({
  batchId: fc.uuid(),
  binId: fc.option(fc.constantFrom('b1', 'b2', 'b3'), { nil: null }),
  batchNo: fc.string({ minLength: 1, maxLength: 6 }),
  expiryDate: fc.option(fc.integer({ min: 0, max: 400 }).map(day), { nil: null }),
  receivedAt: fc.integer({ min: 0, max: 400 }).map(day),
  holdStatus: fc.constantFrom(BatchHoldStatus.NONE, BatchHoldStatus.NONE, BatchHoldStatus.NONE, BatchHoldStatus.QUARANTINE, BatchHoldStatus.RECALL),
  available: fc.integer({ min: 0, max: 500 }),
});

describe('FEFO allocation (property-based)', () => {
  const params = fc.tuple(fc.array(candidateArb, { maxLength: 12 }), fc.integer({ min: 1, max: 3000 }), fc.integer({ min: 0, max: 400 }).map(day));

  it('allocates exactly min(requested, usable) and reports the rest as shortfall', () => {
    fc.assert(
      fc.property(params, ([candidates, qty, asOf]) => {
        const r = allocateFefo(candidates, qty, asOf);
        const usable = candidates.filter((c) => isUsable(c, asOf)).reduce((s, c) => s + c.available, 0);
        expect(r.allocated).toBe(Math.min(qty, usable));
        expect(r.allocated + r.shortfall).toBe(qty);
        expect(r.allocations.reduce((s, a) => s + a.quantity, 0)).toBe(r.allocated);
      }),
    );
  });

  it('never takes from expired or held batches, nor more than a batch has', () => {
    fc.assert(
      fc.property(params, ([candidates, qty, asOf]) => {
        const r = allocateFefo(candidates, qty, asOf);
        for (const a of r.allocations) {
          const source = candidates.filter((c) => c.batchId === a.batchId && c.binId === a.binId);
          expect(source.some((c) => isUsable(c, asOf))).toBe(true);
          expect(a.quantity).toBeGreaterThan(0);
          expect(a.quantity).toBeLessThanOrEqual(Math.max(...source.map((c) => c.available)));
          expect(a.expiryDate === null || a.expiryDate > asOf).toBe(true);
        }
      }),
    );
  });

  it('only uses a later-expiring batch once every earlier usable batch is exhausted', () => {
    fc.assert(
      fc.property(params, ([candidates, qty, asOf]) => {
        const r = allocateFefo(candidates, qty, asOf);
        const ordered = candidates.filter((c) => c.available > 0 && isUsable(c, asOf)).sort(fefoCompare);
        // The allocation is a prefix of the FEFO order; all but the last are taken in full.
        r.allocations.forEach((a, i) => {
          expect(a.batchId).toBe(ordered[i].batchId);
          if (i < r.allocations.length - 1) expect(a.quantity).toBe(ordered[i].available);
        });
        for (let i = 1; i < r.allocations.length; i++) {
          const prev = r.allocations[i - 1].expiryDate;
          const cur = r.allocations[i].expiryDate;
          if (prev !== null && cur !== null) expect(prev <= cur).toBe(true);
          if (prev === null) expect(cur).toBeNull();
        }
      }),
    );
  });
});

describe('ledger invariant (property-based, against Postgres)', () => {
  let ctx: TestContext;
  let stores: string[];
  let bins: (string | null)[];
  let itemId: string;
  let batches: string[];

  beforeAll(async () => {
    ctx = await createTestApp();
    stores = [await idByCode(ctx.ds, 'store', 'OPD-PH'), await idByCode(ctx.ds, 'store', 'ER-PH')];
    const [b1] = await ctx.ds.query(`SELECT id FROM bin WHERE code = 'OPD-01'`);
    bins = [null, b1.id];
    const [item] = await ctx.ds.query(
      `INSERT INTO item (code, category_id, name, base_uom_id, unit_price, tax_category_id, is_batch_tracked)
       SELECT $1, c.id, 'Invariant item', u.id, 1, t.id, true FROM item_category c, unit_of_measure u, tax_category t
        WHERE c.code = 'SUP-GEN' AND u.code = 'PCS' AND t.code = 'STANDARD' RETURNING id`,
      [uniq('INV')],
    );
    itemId = item.id;
    batches = [];
    for (const [i, expiry] of ['2099-01-01', '2099-06-01', null].entries()) {
      const [b] = await ctx.ds.query(
        `INSERT INTO batch (item_id, batch_no, expiry_date, unit_cost) VALUES ($1, $2, $3, $4) RETURNING id`,
        [itemId, `P${i}`, expiry, 5 + i],
      );
      batches.push(b.id);
    }
  });
  afterAll(() => ctx.close());

  const op = fc.record({
    kind: fc.constantFrom('receive', 'adjust', 'dispatch', 'transit'),
    store: fc.integer({ min: 0, max: 1 }),
    bin: fc.integer({ min: 0, max: 1 }),
    batch: fc.integer({ min: 0, max: 2 }),
    qty: fc.integer({ min: 1, max: 60 }),
    cost: fc.integer({ min: 1, max: 30 }),
    sign: fc.boolean(),
  });

  it('keeps every balance equal to the sum of its ledger rows, whatever is posted', async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(op, { minLength: 1, maxLength: 15 }), async (ops) => {
        for (const o of ops) {
          const storeId = stores[o.store];
          const binId = o.store === 0 ? bins[o.bin] : null;
          const base = { storeId, binId, itemId, batchId: batches[o.batch] };
          const lines: MovementLine[] =
            o.kind === 'receive'
              ? [{ ...base, txnType: StockTxnType.RECEIPT, quantity: o.qty, unitCost: o.cost }]
              : o.kind === 'adjust'
                ? [{ ...base, txnType: StockTxnType.ADJUSTMENT, quantity: o.sign ? o.qty : -o.qty }]
                : o.kind === 'dispatch'
                  ? [
                      { ...base, txnType: StockTxnType.TRANSFER_DISPATCH, quantity: -o.qty, counterpartStoreId: stores[1 - o.store] },
                    ]
                  : [{ ...base, binId: null, txnType: StockTxnType.TRANSFER_DISPATCH, quantity: 0, inTransitDelta: o.sign ? o.qty : -o.qty, unitCost: o.cost }];
          try {
            await ctx.ds.transaction((m) =>
              postMovements(m, lines, {
                sourceDocType: 'TEST',
                effectiveDate: '2026-10-19',
                userId: null,
                permissions: null,
                valuationMethod: ValuationMethod.WAC,
              }),
            );
          } catch (e) {
            // Rejected postings (e.g. negative stock) must leave no trace.
            if (!(e instanceof StockRuleError)) throw e;
          }
        }
        const drift = await ctx.ds.query(
          `SELECT b.id FROM stock_balance b
             LEFT JOIN (SELECT store_id, bin_id, batch_id, SUM(quantity) q, SUM(in_transit_delta) t FROM stock_transaction
                         WHERE item_id = $1 GROUP BY 1, 2, 3) l
               ON l.store_id = b.store_id AND l.bin_id IS NOT DISTINCT FROM b.bin_id AND l.batch_id = b.batch_id
            WHERE b.item_id = $1 AND (b.on_hand <> COALESCE(l.q, 0) OR b.in_transit <> COALESCE(l.t, 0) OR b.on_hand < 0 OR b.in_transit < 0)`,
          [itemId],
        );
        expect(drift).toEqual([]);
      }),
      { numRuns: 25 },
    );
  });
});
