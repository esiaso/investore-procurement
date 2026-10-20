import { EntityManager } from 'typeorm';
import { StockTxnType } from '@sil/shared';
import { allocateFefo, loadFefoCandidates, matchesFefo } from '../inventory/fefo';
import { MovementLine, PostingContext, postMovements, StockRuleError } from '../inventory/posting';

export interface Allocation {
  batchId: string;
  binId: string | null;
  quantity: number;
  unitCost: number;
}

/**
 * Takes stock for a sale or dispense: FEFO over usable, unreserved stock
 * (expired, held and quarantined stock never qualifies), or the given picks.
 * Posts DISPENSE movements and returns what was taken at what cost.
 * `overridden` is true when the picks differ from FEFO (caller checks permission).
 */
export async function takeStock(
  m: EntityManager,
  ctx: PostingContext,
  storeId: string,
  lines: { key: string; itemId: string; quantity: number; patientRef?: string | null; picks?: { batchId: string; binId: string | null; quantity: number }[]; fefoOverrideReason?: string | null }[],
): Promise<{ allocations: Map<string, Allocation[]>; overridden: boolean }> {
  const plan: { key: string; itemId: string; batchId: string; binId: string | null; quantity: number; patientRef: string | null; override: string | null }[] = [];
  let overridden = false;
  for (const l of lines) {
    const fefo = allocateFefo(await loadFefoCandidates(m, l.itemId, storeId), l.quantity, ctx.effectiveDate);
    let picks = fefo.allocations.map((a) => ({ batchId: a.batchId, binId: a.binId, quantity: a.quantity }));
    if (l.picks?.length) {
      const total = Math.round(l.picks.reduce((s, p) => s + p.quantity, 0) * 10_000) / 10_000;
      if (total !== Math.round(l.quantity * 10_000) / 10_000) throw new StockRuleError('PICKS_MISMATCH', `Picks must add up to ${l.quantity}`);
      if (!matchesFefo(l.picks, fefo.allocations)) overridden = true;
      picks = l.picks;
    } else if (fefo.shortfall > 0) {
      throw new StockRuleError('INSUFFICIENT_STOCK', `Only ${fefo.allocated} usable in stock for an item needing ${l.quantity}`, { itemId: l.itemId, shortfall: fefo.shortfall });
    }
    for (const p of picks) plan.push({ key: l.key, itemId: l.itemId, batchId: p.batchId, binId: p.binId ?? null, quantity: p.quantity, patientRef: l.patientRef ?? null, override: l.picks?.length ? (l.fefoOverrideReason ?? null) : null });
  }
  const movements: MovementLine[] = plan.map((p) => ({
    txnType: StockTxnType.DISPENSE,
    storeId,
    binId: p.binId,
    itemId: p.itemId,
    batchId: p.batchId,
    quantity: -p.quantity,
    patientRef: p.patientRef,
    fefoOverrideReason: overridden ? p.override : null,
  }));
  const posted = await postMovements(m, movements, ctx);
  const allocations = new Map<string, Allocation[]>();
  plan.forEach((p, i) => {
    allocations.set(p.key, [...(allocations.get(p.key) ?? []), { batchId: p.batchId, binId: p.binId, quantity: p.quantity, unitCost: posted[i].unitCost }]);
  });
  return { allocations, overridden };
}

/** Puts returned stock back on the batches it came from (DISPENSE_RETURN at the original cost). */
export async function returnStock(m: EntityManager, ctx: PostingContext, storeId: string, items: { itemId: string; allocations: Allocation[]; quantity: number; patientRef?: string | null }[]) {
  const movements: MovementLine[] = [];
  for (const it of items) {
    let left = it.quantity;
    for (const a of it.allocations) {
      if (left <= 0) break;
      const q = Math.min(a.quantity, left);
      movements.push({ txnType: StockTxnType.DISPENSE_RETURN, storeId, binId: a.binId, itemId: it.itemId, batchId: a.batchId, quantity: q, unitCost: a.unitCost, patientRef: it.patientRef ?? null });
      left = Math.round((left - q) * 10_000) / 10_000;
    }
  }
  if (movements.length) await postMovements(m, movements, ctx);
}
