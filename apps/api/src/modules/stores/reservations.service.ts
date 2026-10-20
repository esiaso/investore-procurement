import { Injectable } from '@nestjs/common';
import { EntityManager, IsNull } from 'typeorm';
import { allocateFefo, loadFefoCandidates } from '../inventory/fefo';
import { StockReservation } from '../inventory/inventory.entities';
import { changeReserved } from '../inventory/posting';
import { StoreRequisition, StoreRequisitionLine } from './stores.entities';

const round4 = (n: number) => Math.round(n * 10_000) / 10_000;

export const outstanding = (l: Pick<StoreRequisitionLine, 'requestedQty' | 'issuedQty' | 'cancelledQty'>) =>
  Math.max(0, round4(l.requestedQty - l.issuedQty - l.cancelledQty));

/**
 * Stock reservations for internal requisitions. A reservation is a FEFO pick
 * held on specific balance rows; available stock = on hand − reserved.
 * Reservations are re-planned on every issue (released, then the outstanding
 * quantity is reserved again), so they follow FEFO as stock moves.
 */
@Injectable()
export class ReservationsService {
  /** Reserves the outstanding quantity of every line (as far as stock allows). Returns the shortfall per line. */
  async reserve(m: EntityManager, sr: StoreRequisition, asOf: string): Promise<Map<string, number>> {
    const lines = await m.find(StoreRequisitionLine, { where: { requisitionId: sr.id }, order: { lineNo: 'ASC' } });
    const shortfall = new Map<string, number>();
    for (const line of lines) {
      const held = await this.heldFor(m, line.id);
      const need = round4(outstanding(line) - held);
      if (need <= 0) continue;
      // Lock the item's balance rows so two approvals cannot reserve the same stock.
      await m.query(`SELECT id FROM stock_balance WHERE store_id = $1 AND item_id = $2 ORDER BY id FOR UPDATE`, [sr.storeId, line.itemId]);
      const fefo = allocateFefo(await loadFefoCandidates(m, line.itemId, sr.storeId, { purpose: 'ISSUE', departmentId: sr.departmentId }), need, asOf);
      if (fefo.shortfall > 0) shortfall.set(line.id, fefo.shortfall);
      if (!fefo.allocations.length) continue;
      await changeReserved(
        m,
        fefo.allocations.map((a) => ({ storeId: sr.storeId, binId: a.binId, batchId: a.batchId, delta: a.quantity })),
      );
      await m.save(
        fefo.allocations.map((a) =>
          m.create(StockReservation, {
            requisitionId: sr.id,
            requisitionLineId: line.id,
            storeId: sr.storeId,
            binId: a.binId,
            itemId: line.itemId,
            batchId: a.batchId,
            quantity: a.quantity,
          }),
        ),
      );
    }
    return shortfall;
  }

  /** Releases every open reservation of a requisition (issue, cancel, re-plan). */
  async release(m: EntityManager, requisitionId: string, lineIds?: string[]): Promise<void> {
    const open = await m.find(StockReservation, { where: { requisitionId, releasedAt: IsNull() }, lock: { mode: 'pessimistic_write' } });
    const rows = lineIds ? open.filter((r) => lineIds.includes(r.requisitionLineId)) : open;
    if (!rows.length) return;
    await changeReserved(
      m,
      rows.map((r) => ({ storeId: r.storeId, binId: r.binId, batchId: r.batchId, delta: -r.quantity })),
    );
    const now = new Date();
    for (const r of rows) r.releasedAt = now;
    await m.save(rows);
  }

  async heldFor(m: EntityManager, lineId: string): Promise<number> {
    const [r] = await m.query(
      `SELECT COALESCE(SUM(quantity), 0)::float AS q FROM stock_reservation WHERE requisition_line_id = $1 AND released_at IS NULL`,
      [lineId],
    );
    return r.q;
  }

  /** Open reservations per line of a requisition, with batch details. */
  async forRequisition(m: EntityManager, requisitionId: string) {
    return m.query(
      `SELECT r.requisition_line_id AS "requisitionLineId", r.batch_id AS "batchId", b.batch_no AS "batchNo",
              to_char(b.expiry_date, 'YYYY-MM-DD') AS "expiryDate", r.bin_id AS "binId", bn.code AS "binCode", r.quantity::float AS quantity
         FROM stock_reservation r JOIN batch b ON b.id = r.batch_id LEFT JOIN bin bn ON bn.id = r.bin_id
        WHERE r.requisition_id = $1 AND r.released_at IS NULL
        ORDER BY b.expiry_date NULLS LAST, b.batch_no`,
      [requisitionId],
    );
  }
}
