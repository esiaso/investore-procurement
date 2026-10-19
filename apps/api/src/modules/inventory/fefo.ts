import { EntityManager } from 'typeorm';
import { BatchHoldStatus } from '@sil/shared';

export interface FefoCandidate {
  batchId: string;
  binId: string | null;
  batchNo: string;
  expiryDate: string | null;
  receivedAt: string;
  holdStatus: BatchHoldStatus;
  /** On hand minus reserved. */
  available: number;
}

export interface FefoAllocation {
  batchId: string;
  binId: string | null;
  batchNo: string;
  expiryDate: string | null;
  quantity: number;
}

export interface FefoResult {
  allocations: FefoAllocation[];
  allocated: number;
  shortfall: number;
}

const round4 = (n: number) => Math.round(n * 10_000) / 10_000;

/** Usable on `asOf`: not on hold and expiring strictly after that date. */
export function isUsable(c: Pick<FefoCandidate, 'holdStatus' | 'expiryDate'>, asOf: string): boolean {
  return c.holdStatus === BatchHoldStatus.NONE && (c.expiryDate === null || c.expiryDate > asOf);
}

/** FEFO order: earliest expiry first (no expiry last), then earliest received, then stable keys. */
export function fefoCompare(a: FefoCandidate, b: FefoCandidate): number {
  if (a.expiryDate !== b.expiryDate) {
    if (a.expiryDate === null) return 1;
    if (b.expiryDate === null) return -1;
    return a.expiryDate < b.expiryDate ? -1 : 1;
  }
  if (a.receivedAt !== b.receivedAt) return a.receivedAt < b.receivedAt ? -1 : 1;
  if (a.batchNo !== b.batchNo) return a.batchNo < b.batchNo ? -1 : 1;
  return (a.binId ?? '').localeCompare(b.binId ?? '');
}

/**
 * Pure FEFO allocation: takes usable stock in FEFO order, spanning batches
 * and bins, and reports any shortfall. Never allocates more than available.
 */
export function allocateFefo(candidates: FefoCandidate[], quantity: number, asOf: string): FefoResult {
  let remaining = round4(quantity);
  const allocations: FefoAllocation[] = [];
  const usable = candidates.filter((c) => c.available > 0 && isUsable(c, asOf)).sort(fefoCompare);
  for (const c of usable) {
    if (remaining <= 0) break;
    const take = round4(Math.min(c.available, remaining));
    allocations.push({ batchId: c.batchId, binId: c.binId, batchNo: c.batchNo, expiryDate: c.expiryDate, quantity: take });
    remaining = round4(remaining - take);
  }
  const allocated = round4(quantity - remaining);
  return { allocations, allocated, shortfall: Math.max(0, remaining) };
}

/** Loads the candidates for an item in a store (stock in quarantine bins is never a candidate). */
export async function loadFefoCandidates(manager: EntityManager, itemId: string, storeId: string): Promise<FefoCandidate[]> {
  const rows = await manager.query(
    `SELECT sb.batch_id, sb.bin_id, b.batch_no, to_char(b.expiry_date, 'YYYY-MM-DD') AS expiry_date,
            to_char(b.received_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US') AS received_at,
            b.hold_status, (sb.on_hand - sb.reserved) AS available
       FROM stock_balance sb JOIN batch b ON b.id = sb.batch_id
       LEFT JOIN bin bn ON bn.id = sb.bin_id
      WHERE sb.item_id = $1 AND sb.store_id = $2 AND sb.on_hand - sb.reserved > 0
        AND NOT COALESCE(bn.is_quarantine, false)`,
    [itemId, storeId],
  );
  return rows.map(
    (r: Record<string, string>): FefoCandidate => ({
      batchId: r.batch_id,
      binId: r.bin_id,
      batchNo: r.batch_no,
      expiryDate: r.expiry_date,
      receivedAt: r.received_at,
      holdStatus: r.hold_status as BatchHoldStatus,
      available: Number(r.available),
    }),
  );
}

export async function selectBatches(
  manager: EntityManager,
  itemId: string,
  storeId: string,
  quantity: number,
  asOf: string,
): Promise<FefoResult> {
  return allocateFefo(await loadFefoCandidates(manager, itemId, storeId), quantity, asOf);
}

/** True when `chosen` is exactly what FEFO would pick (same batch/bin quantities). */
export function matchesFefo(chosen: { batchId: string; binId: string | null; quantity: number }[], fefo: FefoAllocation[]): boolean {
  const key = (a: { batchId: string; binId: string | null }) => `${a.batchId}|${a.binId ?? ''}`;
  const want = new Map(fefo.map((a) => [key(a), round4(a.quantity)]));
  const got = new Map<string, number>();
  for (const c of chosen) got.set(key(c), round4((got.get(key(c)) ?? 0) + c.quantity));
  if (want.size !== got.size) return false;
  for (const [k, q] of want) if (got.get(k) !== q) return false;
  return true;
}
