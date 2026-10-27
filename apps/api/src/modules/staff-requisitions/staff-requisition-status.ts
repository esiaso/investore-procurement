import { EntityManager } from 'typeorm';
import { StaffRequisitionLineStatus, StaffRequisitionStatus } from '@sil/shared';
import { StaffRequisition, StaffRequisitionLine } from './staff-requisitions.entities';

/** Approved requisitions whose non-stock lines procurement can still pick up. */
export const IN_PROCUREMENT = [StaffRequisitionStatus.APPROVED, StaffRequisitionStatus.PARTLY_CONVERTED];

/**
 * Status from the lines once approved: every line routed (store or PR) or
 * cancelled → CONVERTED; some → PARTLY_CONVERTED; none → APPROVED; all
 * delivered → CLOSED.
 */
export async function refreshStaffRequisitionStatus(m: EntityManager, id: string): Promise<StaffRequisitionStatus> {
  const r = await m.findOneByOrFail(StaffRequisition, { id });
  if (![...IN_PROCUREMENT, StaffRequisitionStatus.CONVERTED].includes(r.status)) return r.status;
  const lines = await m.find(StaffRequisitionLine, { where: { requisitionId: id } });
  const live = lines.filter((l) => l.status !== StaffRequisitionLineStatus.CANCELLED);
  const open = live.filter((l) => l.status === StaffRequisitionLineStatus.OPEN).length;
  const delivered = live.length > 0 && live.every((l) => l.status === StaffRequisitionLineStatus.DELIVERED);
  r.status = delivered
    ? StaffRequisitionStatus.CLOSED
    : open === 0
      ? StaffRequisitionStatus.CONVERTED
      : open < live.length
        ? StaffRequisitionStatus.PARTLY_CONVERTED
        : StaffRequisitionStatus.APPROVED;
  await m.save(r);
  return r.status;
}

/**
 * A consolidated purchase requisition was rejected or cancelled: its source
 * lines go back to the procurement queue.
 */
export async function releasePurchaseRequisitionLines(m: EntityManager, purchaseRequisitionId: string): Promise<number> {
  const [rows]: [{ id: string; requisition_id: string }[], number] = await m.query(
    `UPDATE staff_requisition_line sl SET status = 'OPEN', pr_line_id = NULL
       FROM purchase_requisition_line pl
      WHERE pl.requisition_id = $1 AND sl.pr_line_id = pl.id AND sl.status = 'ON_PR'
      RETURNING sl.id, sl.requisition_id`,
    [purchaseRequisitionId],
  );
  for (const reqId of new Set(rows.map((r) => r.requisition_id))) await refreshStaffRequisitionStatus(m, reqId);
  return rows.length;
}
