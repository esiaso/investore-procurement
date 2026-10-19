import { Client, createTestApp, idByCode, loggedIn, TestContext, uniq } from './helpers';
import { TEST_PASSWORD } from './env';

const addDays = (days: number) => {
  // Nairobi date, matching the API's "today".
  const now = new Date(Date.now() + days * 86_400_000);
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Nairobi', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
};
const TODAY = addDays(0);

describe('Inventory', () => {
  let ctx: TestContext;
  let admin: Client;
  let storekeeper: Client; // MS only; no controlled-drug permission
  let pharmacist: Client; // MP, OPD, IPD; controlled + approvals
  let scm: Client; // all stores, approvals, FEFO override, reconcile
  let finance: Client;
  let quality: Client;
  let ids: Record<string, string>;
  const witness = { username: 'pharm.tech', password: TEST_PASSWORD };

  beforeAll(async () => {
    ctx = await createTestApp();
    [admin, storekeeper, pharmacist, scm, finance, quality] = await Promise.all(
      ['admin', 'storekeeper', 'pharmacist', 'scm', 'finance', 'quality'].map((u) => loggedIn(ctx, u)),
    );
    ids = {
      MS: await idByCode(ctx.ds, 'store', 'MS'),
      MP: await idByCode(ctx.ds, 'store', 'MP'),
      cat: await idByCode(ctx.ds, 'item_category', 'DRUG-ANTIINF'),
      tab: await idByCode(ctx.ds, 'unit_of_measure', 'TAB'),
      exempt: await idByCode(ctx.ds, 'tax_category', 'EXEMPT'),
    };
    const [bin] = await ctx.ds.query(`SELECT b.id FROM bin b JOIN store s ON s.id = b.store_id WHERE s.code = 'MS' AND b.code = 'A-01'`);
    ids.msBin = bin.id;
  });
  afterAll(() => ctx.close());

  async function newItem(opts: { controlled?: boolean; coldChain?: boolean } = {}) {
    const g = await admin
      .post('/generics', {
        innName: `Stockocillin ${uniq('g')}`,
        strength: '250 mg',
        dosageForm: 'Tablet',
        route: 'Oral',
        controlledSchedule: opts.controlled ? 'SCHEDULE_I' : 'NONE',
      })
      .expect(201);
    const item = await admin
      .post('/items', {
        genericId: g.body.id,
        categoryId: ids.cat,
        name: `Stockocillin ${uniq('i')}`,
        baseUomId: ids.tab,
        unitPrice: 20,
        taxCategoryId: ids.exempt,
        isControlled: !!opts.controlled,
        isColdChain: !!opts.coldChain,
      })
      .expect(201);
    return item.body.id as string;
  }

  /** Receives batches into a store; returns batch ids by batch number. */
  async function receive(client: Client, storeId: string, itemId: string, batches: { no: string; expiry: string; qty: number; cost: number }[], type = 'RECEIPT', extra = {}) {
    const res = await client.post('/inventory/receipts', {
      storeId,
      type,
      lines: batches.map((b) => ({ itemId, batchNo: b.no, expiryDate: b.expiry, quantity: b.qty, unitCost: b.cost })),
      ...extra,
    });
    return res;
  }

  async function batchIds(itemId: string): Promise<Record<string, string>> {
    const rows = await ctx.ds.query(`SELECT id, batch_no FROM batch WHERE item_id = $1`, [itemId]);
    return Object.fromEntries(rows.map((r: { id: string; batch_no: string }) => [r.batch_no, r.id]));
  }

  async function itemStock(client: Client, storeId: string, itemId: string) {
    const res = await client.get(`/inventory/stock?groupBy=item&storeId=${storeId}&itemId=${itemId}`).expect(200);
    return res.body.items[0] ?? { onHand: 0, inTransit: 0, usable: 0 };
  }

  describe('receipts, FEFO and valuation', () => {
    let itemId: string;
    let b: Record<string, string>;

    beforeAll(async () => {
      itemId = await newItem();
      await receive(storekeeper, ids.MS, itemId, [{ no: 'OLD', expiry: addDays(-5), qty: 30, cost: 8 }], 'OPENING').then((r) => expect(r.status).toBe(201));
      const res = await receive(storekeeper, ids.MS, itemId, [
        { no: 'LATE', expiry: addDays(200), qty: 100, cost: 10 },
        { no: 'SOON', expiry: addDays(40), qty: 50, cost: 12 },
      ]);
      expect(res.status).toBe(201);
      expect(res.body.number).toMatch(/^RCPT\/MS\//);
      b = await batchIds(itemId);
    });

    it('rejects receiving an already-expired batch (opening balances may load it)', async () => {
      const res = await receive(storekeeper, ids.MS, itemId, [{ no: 'DEAD', expiry: addDays(-1), qty: 1, cost: 1 }]);
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('BATCH_EXPIRED');
    });

    it('requires batch number and expiry for batch-tracked items', async () => {
      const res = await storekeeper.post('/inventory/receipts', { storeId: ids.MS, type: 'RECEIPT', lines: [{ itemId, quantity: 1, unitCost: 1 }] });
      expect(res.status).toBe(400);
    });

    it('updates balances and the weighted average cost', async () => {
      const s = await itemStock(scm, ids.MS, itemId);
      expect(s.onHand).toBe(180);
      expect(s.usable).toBe(150); // expired batch excluded
      expect(s.batches).toBe(3);
      expect(s.nearestExpiry).toBe(addDays(-5));
      const [{ avg_cost }] = await ctx.ds.query(`SELECT avg_cost FROM item_store_cost WHERE store_id = $1 AND item_id = $2`, [ids.MS, itemId]);
      expect(Number(avg_cost)).toBeCloseTo((30 * 8 + 100 * 10 + 50 * 12) / 180, 5);
      expect(s.value).toBeCloseTo(30 * 8 + 100 * 10 + 50 * 12, 2);
    });

    it('hides values from users without inventory.valuation', async () => {
      const s = await itemStock(storekeeper, ids.MS, itemId);
      expect(s.value).toBeNull();
    });

    it('suggests FEFO picks, skipping expired stock and reporting shortfall', async () => {
      const res = await storekeeper.get(`/inventory/fefo?storeId=${ids.MS}&itemId=${itemId}&quantity=120`).expect(200);
      expect(res.body.allocations.map((a: { batchNo: string; quantity: number }) => [a.batchNo, a.quantity])).toEqual([
        ['SOON', 50],
        ['LATE', 70],
      ]);
      expect(res.body.shortfall).toBe(0);
      const short = await storekeeper.get(`/inventory/fefo?storeId=${ids.MS}&itemId=${itemId}&quantity=500`).expect(200);
      expect(short.body.allocated).toBe(150);
      expect(short.body.shortfall).toBe(350);
    });

    it('keeps the bin card running balance', async () => {
      const res = await storekeeper.get(`/inventory/ledger?storeId=${ids.MS}&itemId=${itemId}`).expect(200);
      expect(res.body.total).toBe(3);
      expect(res.body.items.at(-1).balance).toBe(180);
      expect(res.body.items[0].txnType).toBe('OPENING');
    });

    it('values stock as at a date', async () => {
      const today = await scm.get(`/inventory/valuation?storeId=${ids.MS}&groupBy=item`).expect(200);
      const row = today.body.rows.find((r: { itemId: string }) => r.itemId === itemId);
      expect(row.value).toBeCloseTo(1840, 2);
      const before = await scm.get(`/inventory/valuation?storeId=${ids.MS}&groupBy=item&asOf=${addDays(-1)}`).expect(200);
      expect(before.body.rows.find((r: { itemId: string }) => r.itemId === itemId)).toBeUndefined();
      await storekeeper.get('/inventory/valuation').expect(403);
    });

    it('uses batch cost for outflows when FIFO is selected', async () => {
      await admin.put('/settings/inventory.valuationMethod', { value: 'FIFO' }).expect(200);
      try {
        const adj = await storekeeper
          .post('/inventory/adjustments', { storeId: ids.MS, reasonCode: 'DAMAGE', lines: [{ itemId, batchId: b.LATE, quantity: -1 }] })
          .expect(201);
        expect(adj.body.lines[0].unitCost).toBe(10);
        await scm.post(`/inventory/adjustments/${adj.body.id}/approve`).expect(200);
        const [row] = await ctx.ds.query(`SELECT unit_cost, value_delta FROM stock_transaction WHERE source_doc_id = $1`, [adj.body.id]);
        expect(Number(row.unit_cost)).toBe(10);
        expect(Number(row.value_delta)).toBe(-10);
      } finally {
        await admin.put('/settings/inventory.valuationMethod', { value: 'WAC' }).expect(200);
      }
    });
  });

  describe('transfers', () => {
    let itemId: string;
    let b: Record<string, string>;

    beforeAll(async () => {
      itemId = await newItem();
      await receive(storekeeper, ids.MS, itemId, [
        { no: 'T-LATE', expiry: addDays(300), qty: 100, cost: 10 },
        { no: 'T-SOON', expiry: addDays(60), qty: 50, cost: 10 },
        { no: 'T-MID', expiry: addDays(150), qty: 30, cost: 10 },
      ]).then((r) => expect(r.status).toBe(201));
      b = await batchIds(itemId);
    });

    it('requests, dispatches by FEFO into transit, and receives with a discrepancy', async () => {
      const valueBefore = (await scm.get(`/inventory/valuation?groupBy=item`).expect(200)).body.rows.find((r: { itemId: string }) => r.itemId === itemId).value;
      // Requested by the receiving store.
      await storekeeper.post('/inventory/transfers', { fromStoreId: ids.MP, toStoreId: ids.MS, lines: [{ itemId, quantity: 1 }] }).expect(201);
      const t = await pharmacist.post('/inventory/transfers', { fromStoreId: ids.MS, toStoreId: ids.MP, lines: [{ itemId, quantity: 70 }] }).expect(201);
      expect(t.body.number).toMatch(/^TRF\/MP\//);
      await pharmacist.post(`/inventory/transfers/${t.body.id}/dispatch`, {}).expect(403); // no access to MS

      const d = await storekeeper.post(`/inventory/transfers/${t.body.id}/dispatch`, {}).expect(200);
      expect(d.body.status).toBe('DISPATCHED');
      const allocs = d.body.lines[0].allocations.sort((x: { dispatchedQty: number }, y: { dispatchedQty: number }) => y.dispatchedQty - x.dispatchedQty);
      expect(allocs.map((a: { batch: { batchNo: string }; dispatchedQty: number }) => [a.batch.batchNo, a.dispatchedQty])).toEqual([
        ['T-SOON', 50],
        ['T-MID', 20],
      ]);
      expect((await itemStock(scm, ids.MS, itemId)).onHand).toBe(110);
      const inTransit = await itemStock(scm, ids.MP, itemId);
      expect(inTransit).toMatchObject({ onHand: 0, inTransit: 70 });

      const late = allocs.find((a: { batch: { batchNo: string } }) => a.batch.batchNo === 'T-MID');
      const noReason = await pharmacist.post(`/inventory/transfers/${t.body.id}/receive`, { allocations: [{ allocationId: late.id, receivedQty: 15 }] });
      expect(noReason.status).toBe(400);
      const r = await pharmacist
        .post(`/inventory/transfers/${t.body.id}/receive`, {
          allocations: [{ allocationId: late.id, receivedQty: 15, discrepancyReasonCode: 'TRANSIT_LOSS', discrepancyNotes: 'Carton crushed' }],
        })
        .expect(200);
      expect(r.body.status).toBe('RECEIVED_WITH_DISCREPANCY');
      expect(await itemStock(scm, ids.MP, itemId)).toMatchObject({ onHand: 65, inTransit: 0 });

      // Value is conserved apart from the 5 units lost in transit.
      const valueAfter = (await scm.get(`/inventory/valuation?groupBy=item`).expect(200)).body.rows.find((x: { itemId: string }) => x.itemId === itemId).value;
      expect(valueAfter).toBeCloseTo(valueBefore - 5 * 10, 2);
      await pharmacist.post(`/inventory/transfers/${t.body.id}/receive`, {}).expect(409);
    });

    it('needs inventory.override_fefo and a reason to pick out of FEFO order', async () => {
      const t = await pharmacist.post('/inventory/transfers', { fromStoreId: ids.MS, toStoreId: ids.MP, lines: [{ itemId, quantity: 5 }] }).expect(201);
      const lineId = t.body.lines[0].id;
      const picks = [{ batchId: b['T-LATE'], binId: null, quantity: 5 }];
      await storekeeper.post(`/inventory/transfers/${t.body.id}/dispatch`, { lines: [{ lineId, picks }], fefoOverrideReason: 'x' }).expect(403);
      await scm.post(`/inventory/transfers/${t.body.id}/dispatch`, { lines: [{ lineId, picks }] }).expect(400);
      await scm.post(`/inventory/transfers/${t.body.id}/dispatch`, { lines: [{ lineId, picks }], fefoOverrideReason: 'Ward wants long-dated stock' }).expect(200);
      const [row] = await ctx.ds.query(
        `SELECT fefo_override_reason FROM stock_transaction WHERE source_doc_id = $1 AND quantity < 0`,
        [t.body.id],
      );
      expect(row.fefo_override_reason).toBe('Ward wants long-dated stock');
    });

    it('refuses to move a quarantined batch and FEFO skips it', async () => {
      await storekeeper.put(`/inventory/batches/${b['T-LATE']}/hold`, { holdStatus: 'QUARANTINE', reason: 'x' }).expect(403);
      await quality.put(`/inventory/batches/${b['T-LATE']}/hold`, { holdStatus: 'QUARANTINE', reason: 'Suspected cold-chain break' }).expect(200);
      try {
        const fefo = await storekeeper.get(`/inventory/fefo?storeId=${ids.MS}&itemId=${itemId}&quantity=50`).expect(200);
        expect(fefo.body.allocations.map((a: { batchNo: string }) => a.batchNo)).toEqual(['T-MID']);
        expect(fefo.body.shortfall).toBe(40);
        const t = await pharmacist.post('/inventory/transfers', { fromStoreId: ids.MS, toStoreId: ids.MP, lines: [{ itemId, quantity: 5 }] }).expect(201);
        const res = await scm.post(`/inventory/transfers/${t.body.id}/dispatch`, {
          lines: [{ lineId: t.body.lines[0].id, picks: [{ batchId: b['T-LATE'], binId: null, quantity: 5 }] }],
          fefoOverrideReason: 'test',
        });
        expect(res.status).toBe(400);
        expect(res.body.code).toBe('BATCH_ON_HOLD');
        await pharmacist.post(`/inventory/transfers/${t.body.id}/cancel`).expect(200);
      } finally {
        await quality.put(`/inventory/batches/${b['T-LATE']}/hold`, { holdStatus: 'NONE' }).expect(200);
      }
      // Hold changes are audited.
      const [audit] = await ctx.ds.query(
        `SELECT after FROM audit_log WHERE entity_type = 'Batch' AND entity_id = $1 AND action = 'UPDATE' ORDER BY id DESC LIMIT 1`,
        [b['T-LATE']],
      );
      expect(audit.after.holdStatus).toBe('NONE');
    });
  });

  describe('adjustments', () => {
    let itemId: string;
    let b: Record<string, string>;
    beforeAll(async () => {
      itemId = await newItem();
      await receive(storekeeper, ids.MS, itemId, [{ no: 'A1', expiry: addDays(100), qty: 20, cost: 50 }]).then((r) => expect(r.status).toBe(201));
      b = await batchIds(itemId);
    });

    it('validates the reason code direction', async () => {
      const res = await storekeeper.post('/inventory/adjustments', { storeId: ids.MS, reasonCode: 'FOUND', lines: [{ itemId, batchId: b.A1, quantity: -1 }] });
      expect(res.status).toBe(400);
      const unknown = await storekeeper.post('/inventory/adjustments', { storeId: ids.MS, reasonCode: 'NOPE', lines: [{ itemId, batchId: b.A1, quantity: -1 }] });
      expect(unknown.status).toBe(400);
    });

    it('needs approval by someone other than the submitter', async () => {
      const adj = await storekeeper
        .post('/inventory/adjustments', { storeId: ids.MS, reasonCode: 'DAMAGE', lines: [{ itemId, batchId: b.A1, quantity: -2 }] })
        .expect(201);
      expect(adj.body).toMatchObject({ status: 'SUBMITTED', requiresSecondApproval: false });
      await storekeeper.post(`/inventory/adjustments/${adj.body.id}/approve`).expect(403);
      const ok = await scm.post(`/inventory/adjustments/${adj.body.id}/approve`).expect(200);
      expect(ok.body.status).toBe('POSTED');
      expect((await itemStock(scm, ids.MS, itemId)).onHand).toBe(18);
      const [row] = await ctx.ds.query(`SELECT reason_code, user_id FROM stock_transaction WHERE source_doc_id = $1`, [adj.body.id]);
      expect(row.reason_code).toBe('DAMAGE');
    });

    it('requires a second, different approver above the value threshold', async () => {
      await admin.put('/settings/inventory.adjustmentSecondApprovalThreshold', { value: 100 }).expect(200);
      try {
        const adj = await storekeeper
          .post('/inventory/adjustments', { storeId: ids.MS, reasonCode: 'THEFT', lines: [{ itemId, batchId: b.A1, quantity: -3 }] })
          .expect(201);
        expect(adj.body).toMatchObject({ requiresSecondApproval: true, totalValue: 150 });
        const first = await scm.post(`/inventory/adjustments/${adj.body.id}/approve`).expect(200);
        expect(first.body.status).toBe('PARTIALLY_APPROVED');
        expect((await itemStock(scm, ids.MS, itemId)).onHand).toBe(18); // not posted yet
        await scm.post(`/inventory/adjustments/${adj.body.id}/approve`).expect(403);
        const second = await finance.post(`/inventory/adjustments/${adj.body.id}/approve`).expect(200);
        expect(second.body.status).toBe('POSTED');
        expect((await itemStock(scm, ids.MS, itemId)).onHand).toBe(15);
      } finally {
        await admin.put('/settings/inventory.adjustmentSecondApprovalThreshold', { value: 50000 }).expect(200);
      }
    });

    it('rejects negative stock at posting time', async () => {
      const adj = await storekeeper
        .post('/inventory/adjustments', { storeId: ids.MS, reasonCode: 'LOSS', lines: [{ itemId, batchId: b.A1, quantity: -999 }] })
        .expect(201);
      const res = await scm.post(`/inventory/adjustments/${adj.body.id}/approve`);
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('INSUFFICIENT_STOCK');
      const after = await scm.get(`/inventory/adjustments/${adj.body.id}`).expect(200);
      expect(after.body.status).toBe('SUBMITTED'); // rolled back
      await scm.post(`/inventory/adjustments/${adj.body.id}/reject`, { reason: 'Wrong quantity' }).expect(200);
    });

    it('blocks postings in a locked period', async () => {
      await storekeeper.put('/inventory/period-locks', { storeId: ids.MS, lockedUntil: TODAY }).expect(403);
      await finance.put('/inventory/period-locks', { storeId: ids.MS, lockedUntil: TODAY }).expect(200);
      try {
        const res = await receive(storekeeper, ids.MS, itemId, [{ no: 'A2', expiry: addDays(100), qty: 1, cost: 1 }]);
        expect(res.status).toBe(400);
        expect(res.body.code).toBe('PERIOD_LOCKED');
      } finally {
        await finance.put('/inventory/period-locks', { storeId: ids.MS, lockedUntil: '2000-01-01' }).expect(200);
      }
    });
  });

  describe('stock takes', () => {
    let itemId: string;
    beforeAll(async () => {
      itemId = await newItem();
      await receive(storekeeper, ids.MS, itemId, [
        { no: 'S1', expiry: addDays(100), qty: 40, cost: 5 },
        { no: 'S2', expiry: addDays(200), qty: 60, cost: 5 },
      ]).then((r) => expect(r.status).toBe(201));
    });

    it('freezes, counts blind, reviews variances and posts on approval', async () => {
      const st = await storekeeper.post('/inventory/stock-takes', { storeId: ids.MS, type: 'CYCLE', blind: true, itemIds: [itemId] }).expect(201);
      const frozen = await storekeeper.post(`/inventory/stock-takes/${st.body.id}/freeze`).expect(200);
      expect(frozen.body.status).toBe('COUNTING');
      expect(frozen.body.lines).toHaveLength(2);
      expect(frozen.body.lines.every((l: { systemQty: number | null }) => l.systemQty === null)).toBe(true); // blind

      // Frozen items cannot move.
      const blocked = await receive(storekeeper, ids.MS, itemId, [{ no: 'S1', expiry: addDays(100), qty: 1, cost: 5 }]);
      expect(blocked.status).toBe(400);
      expect(blocked.body.code).toBe('FROZEN_BY_STOCK_TAKE');
      // An overlapping count cannot start.
      const other = await storekeeper.post('/inventory/stock-takes', { storeId: ids.MS, type: 'CYCLE', itemIds: [itemId] }).expect(201);
      await storekeeper.post(`/inventory/stock-takes/${other.body.id}/freeze`).expect(409);
      await storekeeper.post(`/inventory/stock-takes/${other.body.id}/cancel`).expect(200);

      await storekeeper.post(`/inventory/stock-takes/${st.body.id}/submit`).expect(400); // nothing counted yet
      const lines = frozen.body.lines.map((l: { id: string; batch: { batchNo: string } }) => ({
        lineId: l.id,
        countedQty: l.batch.batchNo === 'S1' ? 38 : 60,
      }));
      await storekeeper.post(`/inventory/stock-takes/${st.body.id}/counts`, { lines }).expect(200);
      const review = await storekeeper.post(`/inventory/stock-takes/${st.body.id}/submit`).expect(200);
      expect(review.body.status).toBe('REVIEW');
      const s1 = review.body.lines.find((l: { batch: { batchNo: string } }) => l.batch.batchNo === 'S1');
      expect(s1).toMatchObject({ systemQty: 40, countedQty: 38, variance: -2, varianceValue: -10 });

      await storekeeper.post(`/inventory/stock-takes/${st.body.id}/approve`).expect(403); // no approve permission
      const posted = await scm.post(`/inventory/stock-takes/${st.body.id}/approve`).expect(200);
      expect(posted.body.status).toBe('POSTED');
      expect((await itemStock(scm, ids.MS, itemId)).onHand).toBe(98);
      const rows = await ctx.ds.query(`SELECT txn_type, quantity FROM stock_transaction WHERE source_doc_id = $1`, [st.body.id]);
      expect(rows).toEqual([{ txn_type: 'STOCK_TAKE', quantity: '-2.0000' }]);

      // Unfrozen again.
      await receive(storekeeper, ids.MS, itemId, [{ no: 'S1', expiry: addDays(100), qty: 2, cost: 5 }]).then((r) => expect(r.status).toBe(201));
    });
  });

  describe('controlled and cold-chain items', () => {
    it('needs a second, different, authorised signatory for controlled drugs', async () => {
      const itemId = await newItem({ controlled: true });
      const lines = [{ no: 'CD1', expiry: addDays(300), qty: 10, cost: 100 }];
      const none = await receive(pharmacist, ids.MP, itemId, lines);
      expect(none.status).toBe(400);
      expect(none.body.code).toBe('SECOND_SIGNATURE_REQUIRED');
      const self = await receive(pharmacist, ids.MP, itemId, lines, 'RECEIPT', { witness: { username: 'pharmacist', password: TEST_PASSWORD } });
      expect(self.status).toBe(400);
      const badPw = await receive(pharmacist, ids.MP, itemId, lines, 'RECEIPT', { witness: { username: 'pharm.tech', password: 'wrong' } });
      expect(badPw.body.code).toBe('WITNESS_INVALID');
      const unauthorised = await receive(pharmacist, ids.MP, itemId, lines, 'RECEIPT', { witness: { username: 'cashier', password: TEST_PASSWORD } });
      expect(unauthorised.status).toBe(403);

      const ok = await receive(pharmacist, ids.MP, itemId, lines, 'RECEIPT', { witness });
      expect(ok.status).toBe(201);
      const [row] = await ctx.ds.query(
        `SELECT t.second_signer_id, u.username FROM stock_transaction t JOIN app_user u ON u.id = t.second_signer_id WHERE t.source_doc_id = $1`,
        [ok.body.id],
      );
      expect(row.username).toBe('pharm.tech');

      // The storekeeper may not handle controlled drugs at all.
      const sk = await receive(storekeeper, ids.MS, itemId, [{ no: 'CD2', expiry: addDays(300), qty: 1, cost: 100 }], 'RECEIPT', { witness });
      expect(sk.status).toBe(403);
    });

    it('restricts cold-chain items to permitted roles', async () => {
      const itemId = await newItem({ coldChain: true });
      const code = uniq('NOCOLD').replace('-', '_');
      const role = await admin.post('/roles', { code, name: 'No cold chain', permissionCodes: ['inventory.read', 'inventory.receive'] }).expect(201);
      const username = uniq('nocold').toLowerCase();
      const user = await admin
        .post('/users', { username, fullName: 'No Cold', password: 'Initial#Pass2026', roleIds: [role.body.id], storeIds: [ids.MS] })
        .expect(201);
      await ctx.ds.query(`UPDATE app_user SET must_change_password = false WHERE id = $1`, [user.body.id]);
      const client = new Client(ctx);
      await client.login(username, 'Initial#Pass2026');
      const res = await receive(client, ids.MS, itemId, [{ no: 'CC1', expiry: addDays(90), qty: 5, cost: 300 }]);
      expect(res.status).toBe(403);
      expect(res.body.message).toMatch(/cold-chain/);
      expect((await receive(storekeeper, ids.MS, itemId, [{ no: 'CC1', expiry: addDays(90), qty: 5, cost: 300 }])).status).toBe(201);
    });
  });

  describe('scoping, reconciliation and ledger integrity', () => {
    it('scopes stock to the user\'s stores', async () => {
      await storekeeper.get(`/inventory/stock?storeId=${ids.MP}`).expect(403);
      const res = await storekeeper.get('/inventory/stock?pageSize=100').expect(200);
      expect(res.body.items.length).toBeGreaterThan(0);
      expect(res.body.items.every((r: { storeCode: string }) => r.storeCode === 'MS')).toBe(true);
    });

    it('seeds stock with expired, near-expiry and quarantined batches', async () => {
      const expired = await scm.get('/inventory/stock?expired=true&pageSize=1').expect(200);
      expect(expired.body.total).toBeGreaterThan(0);
      const soon = await scm.get('/inventory/stock?expiringWithinDays=30&pageSize=1').expect(200);
      expect(soon.body.total).toBeGreaterThan(expired.body.total);
      const held = await scm.get('/inventory/stock?holdStatus=QUARANTINE&pageSize=1').expect(200);
      expect(held.body.total).toBeGreaterThan(0);
    });

    it('finds no drift, detects drift, and repairs it', async () => {
      const clean = await scm.get('/inventory/reconciliation').expect(200);
      expect(clean.body.driftCount).toBe(0);
      expect(clean.body.checked).toBeGreaterThan(800);
      const [bal] = await ctx.ds.query(`SELECT id, store_id FROM stock_balance WHERE on_hand > 10 LIMIT 1`);
      await ctx.ds.query(`UPDATE stock_balance SET on_hand = on_hand + 1 WHERE id = $1`, [bal.id]);
      const drift = await scm.get(`/inventory/reconciliation?storeId=${bal.store_id}`).expect(200);
      expect(drift.body.driftCount).toBe(1);
      expect(drift.body.drift[0].on_hand - drift.body.drift[0].ledger_on_hand).toBe(1);
      await storekeeper.post('/inventory/reconciliation/repair').expect(403);
      const fixed = await scm.post(`/inventory/reconciliation/repair?storeId=${bal.store_id}`).expect(200);
      expect(fixed.body.repaired).toBe(1);
      expect((await scm.get('/inventory/reconciliation').expect(200)).body.driftCount).toBe(0);
    });

    it('keeps the ledger append-only', async () => {
      await expect(ctx.ds.query(`UPDATE stock_transaction SET quantity = 0 WHERE id = (SELECT max(id) FROM stock_transaction)`)).rejects.toThrow(/append-only/);
      await expect(ctx.ds.query(`DELETE FROM stock_transaction`)).rejects.toThrow(/append-only/);
    });

    it('never lets on-hand go negative at the database level', async () => {
      const [bal] = await ctx.ds.query(`SELECT id FROM stock_balance LIMIT 1`);
      await expect(ctx.ds.query(`UPDATE stock_balance SET on_hand = -1 WHERE id = $1`, [bal.id])).rejects.toThrow(/check constraint/);
    });
  });
});
