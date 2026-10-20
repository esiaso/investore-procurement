import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { EntityManager } from 'typeorm';
import { BatchHoldStatus, Permissions, StockTxnType, ValuationMethod } from '@sil/shared';
import { StockTransaction } from './inventory.entities';

/** One change to one store × bin × batch. */
export interface MovementLine {
  txnType: StockTxnType;
  storeId: string;
  binId: string | null;
  itemId: string;
  batchId: string;
  /** Signed change to on hand (base units). */
  quantity: number;
  /** Signed change to in transit (base units). */
  inTransitDelta?: number;
  /**
   * Cost per base unit for stock entering the store (receipts, transfer
   * legs). Outflows and gains without a cost use the store's current cost.
   */
  unitCost?: number;
  counterpartStoreId?: string | null;
  reasonCode?: string | null;
  fefoOverrideReason?: string | null;
  departmentId?: string | null;
  patientRef?: string | null;
}

export interface PostingContext {
  sourceDocType: string;
  sourceDocId?: string | null;
  sourceDocNo?: string | null;
  /** Business date (YYYY-MM-DD). */
  effectiveDate: string;
  /** Acting user; null for system postings (seed, migrations). */
  userId: string | null;
  /** Permissions of the acting user; null = system (no role checks). */
  permissions: ReadonlySet<string> | null;
  /** Witness for controlled drugs (must differ from userId). */
  secondSignerId?: string | null;
  valuationMethod: ValuationMethod;
}

export class StockRuleError extends BadRequestException {
  constructor(code: string, message: string, details?: Record<string, unknown>) {
    super({ statusCode: 400, code, message, ...details });
  }
}

/**
 * Movement types that take stock out for use: they must not touch unusable
 * batches (held, expired, in a quarantine bin) or stock reserved for requisitions.
 */
const CONSUMING: ReadonlySet<StockTxnType> = new Set([StockTxnType.TRANSFER_DISPATCH, StockTxnType.ISSUE, StockTxnType.DISPENSE]);
/**
 * Outflows that leave reserved stock alone. Returns to suppliers may take held,
 * expired or quarantined stock (that is usually why it goes back), but not
 * stock promised to a requisition. Adjustments and stock takes record physical
 * facts and are not limited by reservations.
 */
const RESPECTS_RESERVATIONS: ReadonlySet<StockTxnType> = new Set([...CONSUMING, StockTxnType.SUPPLIER_RETURN]);
/** Inflows that bring stock in at a given cost (WAC is recalculated). */
const COST_INFLOWS: ReadonlySet<StockTxnType> = new Set([
  StockTxnType.OPENING,
  StockTxnType.RECEIPT,
  StockTxnType.TRANSFER_RECEIPT,
  StockTxnType.RETURN_IN,
  StockTxnType.DISPENSE_RETURN,
]);

const round4 = (n: number) => Math.round(n * 10_000) / 10_000;

interface BatchInfo {
  id: string;
  item_id: string;
  batch_no: string;
  expiry_date: string | null;
  unit_cost: string;
  hold_status: BatchHoldStatus;
  is_controlled: boolean;
  is_cold_chain: boolean;
  item_code: string;
}

/**
 * The only way stock changes. Writes ledger rows and balances in the caller's
 * transaction, locking every touched balance row (and the WAC row) with
 * SELECT … FOR UPDATE in a deterministic order. Throws StockRuleError on:
 * negative stock, expired/held batches being consumed, locked periods, items
 * frozen by a stock take, missing controlled-drug witness, missing
 * cold-chain/controlled permission.
 */
export async function postMovements(
  manager: EntityManager,
  lines: MovementLine[],
  ctx: PostingContext,
): Promise<StockTransaction[]> {
  if (!lines.length) return [];
  for (const l of lines) {
    if (!Number.isFinite(l.quantity) || !Number.isFinite(l.inTransitDelta ?? 0)) {
      throw new StockRuleError('INVALID_QUANTITY', 'Quantity must be a number');
    }
    if (round4(l.quantity) === 0 && round4(l.inTransitDelta ?? 0) === 0) {
      throw new StockRuleError('INVALID_QUANTITY', 'Movement quantity cannot be zero');
    }
  }

  // ---- reference data
  const batchIds = [...new Set(lines.map((l) => l.batchId))];
  const batches: BatchInfo[] = await manager.query(
    `SELECT b.id, b.item_id, b.batch_no, to_char(b.expiry_date, 'YYYY-MM-DD') AS expiry_date, b.unit_cost, b.hold_status,
            i.is_controlled, i.is_cold_chain, i.code AS item_code
       FROM batch b JOIN item i ON i.id = b.item_id
      WHERE b.id = ANY($1::uuid[])`,
    [batchIds],
  );
  const batchById = new Map(batches.map((b) => [b.id, b]));
  for (const l of lines) {
    const b = batchById.get(l.batchId);
    if (!b) throw new StockRuleError('UNKNOWN_BATCH', 'Batch not found');
    if (b.item_id !== l.itemId) throw new StockRuleError('BATCH_ITEM_MISMATCH', 'Batch belongs to another item');
  }

  // ---- period locks
  const storeIds = [...new Set(lines.flatMap((l) => [l.storeId]))];
  const locks: { store_id: string; locked_until: string }[] = await manager.query(
    `SELECT store_id, to_char(locked_until, 'YYYY-MM-DD') AS locked_until FROM store_period_lock WHERE store_id = ANY($1::uuid[])`,
    [storeIds],
  );
  for (const lock of locks) {
    if (ctx.effectiveDate <= lock.locked_until) {
      throw new StockRuleError('PERIOD_LOCKED', `Postings on or before ${lock.locked_until} are locked for this store`);
    }
  }

  // ---- stock-take freeze
  // A full count freezes the whole store; a cycle count freezes its items.
  if (!lines.every((l) => l.txnType === StockTxnType.STOCK_TAKE)) {
    const counts: { store_id: string; number: string; type: string; item_ids: string[] }[] = await manager.query(
      `SELECT store_id, number, type, item_ids::text[] AS item_ids FROM stock_take
        WHERE status IN ('COUNTING', 'REVIEW') AND store_id = ANY($1::uuid[])`,
      [storeIds],
    );
    for (const l of lines) {
      if (l.txnType === StockTxnType.STOCK_TAKE) continue;
      const hit = counts.find((c) => c.store_id === l.storeId && (c.type === 'FULL' || c.item_ids.includes(l.itemId)));
      if (hit) {
        const b = batchById.get(l.batchId)!;
        throw new StockRuleError('FROZEN_BY_STOCK_TAKE', `Item ${b.item_code} is frozen by stock take ${hit.number}`);
      }
    }
  }

  // ---- item handling restrictions
  for (const b of batches) {
    if (ctx.permissions) {
      if (b.is_controlled && !ctx.permissions.has(Permissions.INVENTORY_HANDLE_CONTROLLED)) {
        throw new ForbiddenException(`Item ${b.item_code} is a controlled drug; you may not move it`);
      }
      if (b.is_cold_chain && !ctx.permissions.has(Permissions.INVENTORY_HANDLE_COLD_CHAIN)) {
        throw new ForbiddenException(`Item ${b.item_code} is a cold-chain item; you may not move it`);
      }
    }
    if (b.is_controlled && ctx.userId) {
      if (!ctx.secondSignerId) {
        throw new StockRuleError('SECOND_SIGNATURE_REQUIRED', `Item ${b.item_code} is a controlled drug: a second person must sign off`);
      }
      if (ctx.secondSignerId === ctx.userId) {
        throw new StockRuleError('SECOND_SIGNATURE_REQUIRED', 'The second signatory must be a different user');
      }
    }
  }

  // ---- batch usability
  const binIds = [...new Set(lines.map((l) => l.binId).filter((b): b is string => !!b))];
  const quarantineBins = new Set<string>(
    binIds.length
      ? (await manager.query(`SELECT id FROM bin WHERE id = ANY($1::uuid[]) AND is_quarantine`, [binIds])).map((r: { id: string }) => r.id)
      : [],
  );
  for (const l of lines) {
    const b = batchById.get(l.batchId)!;
    const expired = !!b.expiry_date && b.expiry_date <= ctx.effectiveDate;
    if (CONSUMING.has(l.txnType) && l.quantity < 0) {
      if (b.hold_status !== BatchHoldStatus.NONE) {
        throw new StockRuleError('BATCH_ON_HOLD', `Batch ${b.batch_no} is on hold (${b.hold_status})`);
      }
      if (expired) throw new StockRuleError('BATCH_EXPIRED', `Batch ${b.batch_no} expired on ${b.expiry_date}`);
      if (l.binId && quarantineBins.has(l.binId)) {
        throw new StockRuleError('BIN_QUARANTINED', `Batch ${b.batch_no} is in a quarantine bin and cannot be used`);
      }
    }
    if (l.txnType === StockTxnType.RECEIPT && expired) {
      throw new StockRuleError('BATCH_EXPIRED', `Cannot receive expired batch ${b.batch_no}`);
    }
  }

  // ---- lock balance rows (deterministic order avoids deadlocks)
  const keyOf = (l: { storeId: string; binId: string | null; batchId: string }) => `${l.storeId}|${l.binId ?? ''}|${l.batchId}`;
  const keys = [...new Map(lines.map((l) => [keyOf(l), l])).values()].sort((a, b) => keyOf(a).localeCompare(keyOf(b)));
  const balances = new Map<string, { id: string; onHand: number; inTransit: number; reserved: number }>();
  for (const k of keys) {
    await manager.query(
      `INSERT INTO stock_balance (store_id, bin_id, item_id, batch_id) VALUES ($1, $2, $3, $4)
       ON CONFLICT ON CONSTRAINT uq_stock_balance_location DO NOTHING`,
      [k.storeId, k.binId, k.itemId, k.batchId],
    );
    const [row] = await manager.query(
      `SELECT id, on_hand, in_transit, reserved FROM stock_balance
        WHERE store_id = $1 AND bin_id IS NOT DISTINCT FROM $2 AND batch_id = $3 FOR UPDATE`,
      [k.storeId, k.binId, k.batchId],
    );
    balances.set(keyOf(k), { id: row.id, onHand: Number(row.on_hand), inTransit: Number(row.in_transit), reserved: Number(row.reserved) });
  }

  // ---- WAC rows
  const wac = new Map<string, number>();
  const wacKeys = [...new Set(lines.map((l) => `${l.storeId}|${l.itemId}`))].sort();
  for (const k of wacKeys) {
    const [storeId, itemId] = k.split('|');
    const [row] = await manager.query(
      `SELECT avg_cost FROM item_store_cost WHERE store_id = $1 AND item_id = $2 FOR UPDATE`,
      [storeId, itemId],
    );
    if (row) wac.set(k, Number(row.avg_cost));
  }
  const storeItemQty = async (storeId: string, itemId: string): Promise<number> => {
    const [r] = await manager.query(
      `SELECT COALESCE(SUM(on_hand), 0) AS q FROM stock_balance WHERE store_id = $1 AND item_id = $2`,
      [storeId, itemId],
    );
    return Number(r.q);
  };

  // ---- apply line by line
  const rows: Partial<StockTransaction>[] = [];
  for (const l of lines) {
    const b = batchById.get(l.batchId)!;
    const bal = balances.get(keyOf(l))!;
    const q = round4(l.quantity);
    const t = round4(l.inTransitDelta ?? 0);
    const newOnHand = round4(bal.onHand + q);
    const newInTransit = round4(bal.inTransit + t);
    if (newOnHand < 0) {
      throw new StockRuleError('INSUFFICIENT_STOCK', `Not enough stock of ${b.item_code} batch ${b.batch_no}: ${bal.onHand} available`, {
        itemId: l.itemId,
        batchId: l.batchId,
        available: bal.onHand,
      });
    }
    if (newInTransit < 0) throw new StockRuleError('INSUFFICIENT_IN_TRANSIT', `In-transit quantity for ${b.batch_no} would go negative`);
    if (q < 0 && RESPECTS_RESERVATIONS.has(l.txnType) && newOnHand < bal.reserved) {
      const free = Math.max(0, round4(bal.onHand - bal.reserved));
      throw new StockRuleError(
        'INSUFFICIENT_STOCK',
        `Not enough unreserved stock of ${b.item_code} batch ${b.batch_no}: ${free} available (${bal.reserved} reserved for requisitions)`,
        { itemId: l.itemId, batchId: l.batchId, available: free, reserved: bal.reserved },
      );
    }

    const wacKey = `${l.storeId}|${l.itemId}`;
    const currentCost =
      ctx.valuationMethod === ValuationMethod.FIFO ? Number(b.unit_cost) : (wac.get(wacKey) ?? Number(b.unit_cost));
    let cost: number;
    if (q > 0 && COST_INFLOWS.has(l.txnType)) {
      if (l.unitCost === undefined || l.unitCost < 0) throw new StockRuleError('COST_REQUIRED', 'A unit cost is required for stock entering the store');
      cost = l.unitCost;
      // Weighted average over stock on hand in this store.
      const before = await storeItemQty(l.storeId, l.itemId);
      const prevAvg = wac.get(wacKey) ?? cost;
      const avg = before + q > 0 ? (before * prevAvg + q * cost) / (before + q) : cost;
      wac.set(wacKey, avg);
    } else if (l.unitCost !== undefined && t !== 0) {
      cost = l.unitCost; // in-transit legs carry the dispatch cost
    } else {
      cost = currentCost;
    }
    const valueDelta = round4((q + t) * cost);

    await manager.query(
      `UPDATE stock_balance SET on_hand = on_hand + $2, in_transit = in_transit + $3, updated_at = now() WHERE id = $1`,
      [bal.id, q, t],
    );
    bal.onHand = newOnHand;
    bal.inTransit = newInTransit;

    rows.push({
      txnType: l.txnType,
      storeId: l.storeId,
      binId: l.binId,
      itemId: l.itemId,
      batchId: l.batchId,
      quantity: q,
      inTransitDelta: t,
      unitCost: cost,
      valueDelta,
      counterpartStoreId: l.counterpartStoreId ?? null,
      sourceDocType: ctx.sourceDocType,
      sourceDocId: ctx.sourceDocId ?? null,
      sourceDocNo: ctx.sourceDocNo ?? null,
      reasonCode: l.reasonCode ?? null,
      fefoOverrideReason: l.fefoOverrideReason ?? null,
      departmentId: l.departmentId ?? null,
      patientRef: l.patientRef ?? null,
      userId: ctx.userId,
      secondSignerId: ctx.secondSignerId ?? null,
      effectiveDate: ctx.effectiveDate,
    });
  }

  for (const [k, avg] of wac) {
    const [storeId, itemId] = k.split('|');
    await manager.query(
      `INSERT INTO item_store_cost (store_id, item_id, avg_cost, updated_at) VALUES ($1, $2, $3, now())
       ON CONFLICT (store_id, item_id) DO UPDATE SET avg_cost = EXCLUDED.avg_cost, updated_at = now()`,
      [storeId, itemId, avg],
    );
  }

  const repo = manager.getRepository(StockTransaction);
  const inserted = await repo.insert(rows.map((r) => repo.create(r)));
  return rows.map((r, i) => ({ ...r, id: String(inserted.identifiers[i].id) }) as StockTransaction);
}

export interface ReservationChange {
  storeId: string;
  binId: string | null;
  batchId: string;
  /** Signed change to reserved. */
  delta: number;
}

/**
 * The only way `stock_balance.reserved` changes (the reservations service keeps
 * the matching stock_reservation rows). Locks rows in the same order as
 * postMovements. Reserving more than is on hand and unreserved is refused;
 * releasing never takes reserved below zero.
 */
export async function changeReserved(manager: EntityManager, changes: ReservationChange[]): Promise<void> {
  const keyOf = (c: ReservationChange) => `${c.storeId}|${c.binId ?? ''}|${c.batchId}`;
  const merged = new Map<string, ReservationChange>();
  for (const c of changes) {
    const k = keyOf(c);
    const prev = merged.get(k);
    merged.set(k, prev ? { ...prev, delta: round4(prev.delta + c.delta) } : { ...c, delta: round4(c.delta) });
  }
  for (const k of [...merged.keys()].sort()) {
    const c = merged.get(k)!;
    if (c.delta === 0) continue;
    const [row] = await manager.query(
      `SELECT id, on_hand, reserved FROM stock_balance
        WHERE store_id = $1 AND bin_id IS NOT DISTINCT FROM $2 AND batch_id = $3 FOR UPDATE`,
      [c.storeId, c.binId, c.batchId],
    );
    if (!row) throw new StockRuleError('INSUFFICIENT_STOCK', 'Nothing on hand to reserve');
    const next = round4(Number(row.reserved) + c.delta);
    if (c.delta > 0 && next > Number(row.on_hand)) {
      throw new StockRuleError('INSUFFICIENT_STOCK', `Only ${round4(Number(row.on_hand) - Number(row.reserved))} can still be reserved`);
    }
    await manager.query(`UPDATE stock_balance SET reserved = $2, updated_at = now() WHERE id = $1`, [row.id, Math.max(0, next)]);
  }
}
