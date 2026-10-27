import { EntityManager } from 'typeorm';
import { NotificationCategory } from '@sil/shared';
import { NotificationsService } from '../approvals/notifications.service';

export interface SourceRequisition {
  userId: string;
  requisitionId: string;
  number: string;
}

/**
 * Staff requisitions (and their requesters) behind a purchase requisition, a
 * purchase order or some of its lines, through the consolidated PR lines.
 */
export async function sourceRequisitions(m: EntityManager, by: { prId?: string; poId?: string; poLineIds?: string[] }): Promise<SourceRequisition[]> {
  const params: unknown[] = [];
  const conds: string[] = [];
  if (by.prId) conds.push(`pl.requisition_id = $${params.push(by.prId)}`);
  if (by.poId) conds.push(`ol.purchase_order_id = $${params.push(by.poId)}`);
  if (by.poLineIds?.length) conds.push(`ol.id = ANY($${params.push(by.poLineIds)}::uuid[])`);
  if (!conds.length) return [];
  return m.query(
    `SELECT DISTINCT sr.requested_by AS "userId", sr.id AS "requisitionId", sr.number
       FROM staff_requisition sr JOIN staff_requisition_line sl ON sl.requisition_id = sr.id
       JOIN purchase_requisition_line pl ON pl.id = sl.pr_line_id
       LEFT JOIN purchase_order_line ol ON ol.requisition_line_id = pl.id
      WHERE ${conds.join(' OR ')}`,
    params,
  );
}

/** Tells each requester where their requisition has got to (A7 milestones). */
export async function notifyRequesters(
  m: EntityManager,
  notifications: NotificationsService,
  by: { prId?: string; poId?: string; poLineIds?: string[] },
  message: (req: SourceRequisition) => { title: string; body?: string },
  except: string[] = [],
): Promise<number> {
  const reqs = (await sourceRequisitions(m, by)).filter((r) => !except.includes(r.userId));
  for (const r of reqs) {
    const msg = message(r);
    await notifications.dispatch(m, [r.userId], NotificationCategory.REQUISITIONS, { ...msg, link: `/staff-requisitions/${r.requisitionId}` });
  }
  return reqs.length;
}
