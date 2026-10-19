import type { INestApplicationContext } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { ApprovalActionType, DocumentType, RequisitionPriority, ReturnCondition, SessionUser } from '@sil/shared';
import { RequestContext } from '../../common/request-context';
import { ApprovalsService } from '../../modules/approvals/approvals.service';
import { SupplierReturnsService } from '../../modules/purchasing/supplier-returns.service';
import { DepartmentReturnsService } from '../../modules/stores/department-returns.service';
import { IssuesService } from '../../modules/stores/issues.service';
import { StoreRequisitionsService } from '../../modules/stores/store-requisitions.service';
import { UsersService } from '../../modules/users/users.service';

/**
 * Sample internal requisitions from three wards to the Main Store, created
 * through the real services (approvals, reservations, FEFO issues, returns):
 *  - a draft, one pending approval, one rejected, one approved (stock reserved);
 *  - a fully issued requisition (with a patient reference) and a partly issued
 *    one with a back-order;
 *  - department returns (resaleable + damaged to quarantine, and a draft);
 *  - a return of the damaged stock to the supplier, with a credit note.
 * Runs once (skipped when any internal requisition exists).
 */
export async function seedSampleStores(app: INestApplicationContext, log: (m: string) => void = (m) => console.log(`[seed] ${m}`)) {
  const ds = app.get(DataSource);
  const [{ n }] = await ds.query(`SELECT count(*)::int AS n FROM store_requisition`);
  const [{ f }] = await ds.query(`SELECT count(*)::int AS f FROM facility WHERE code = 'SIL-NBI'`);
  if (n > 0 || f === 0) return;

  const users = app.get(UsersService);
  const srs = app.get(StoreRequisitionsService);
  const issues = app.get(IssuesService);
  const deptReturns = app.get(DepartmentReturnsService);
  const supplierReturns = app.get(SupplierReturnsService);
  const approvals = app.get(ApprovalsService);

  const actors = new Map<string, SessionUser>();
  for (const u of ['ward.nurse', 'ward.incharge', 'surg.nurse', 'surg.incharge', 'mat.nurse', 'mat.incharge', 'storekeeper', 'finance']) {
    const [row] = await ds.query(`SELECT id FROM app_user WHERE username = $1`, [u]);
    const s = row ? await users.findForSession(row.id) : null;
    if (!s) {
      log(`sample stores skipped: user ${u} missing`);
      return;
    }
    actors.set(u, s);
  }
  const as = <T>(username: string, fn: (u: SessionUser) => Promise<T>) => {
    const u = actors.get(username)!;
    return RequestContext.run({ userId: u.id, username: u.username, storeIds: u.storeIds }, () => fn(u));
  };
  const act = async (docId: string, username: string, action: ApprovalActionType, comment?: string) => {
    const [req] = await ds.query(`SELECT id FROM approval_request WHERE document_type = $1 AND document_id = $2 AND status = 'PENDING'`, [DocumentType.STORE_REQUISITION, docId]);
    if (req) await as(username, (u) => approvals.act(req.id, u, action, comment));
  };

  const id = async (sql: string, params: unknown[] = []) => (await ds.query(sql, params))[0]?.id as string;
  const ms = await id(`SELECT id FROM store WHERE code = 'MS'`);
  const dept = {
    med: await id(`SELECT id FROM department WHERE code = 'IPD-MED'`),
    surg: await id(`SELECT id FROM department WHERE code = 'IPD-SURG'`),
    mat: await id(`SELECT id FROM department WHERE code = 'MAT'`),
  };
  const s1 = await id(`SELECT id FROM supplier WHERE code = 'SUP0001'`);
  // Items with usable stock in the Main Store that ward staff may handle (no controlled / cold-chain).
  const items: { id: string; usable: number }[] = await ds.query(
    `SELECT i.id, SUM(sb.on_hand - sb.reserved)::float AS usable
       FROM stock_balance sb JOIN item i ON i.id = sb.item_id JOIN batch b ON b.id = sb.batch_id
      WHERE sb.store_id = $1 AND NOT i.is_controlled AND NOT i.is_cold_chain AND b.hold_status = 'NONE'
        AND (b.expiry_date IS NULL OR b.expiry_date > CURRENT_DATE + 30)
      GROUP BY i.id HAVING SUM(sb.on_hand - sb.reserved) >= 60
      ORDER BY i.id LIMIT 8`,
    [ms],
  );
  if (items.length < 6) {
    log('sample stores skipped: not enough stock in the Main Store');
    return;
  }
  const qty = (i: number, share: number) => Math.max(1, Math.floor(items[i].usable * share));
  const line = (i: number, share: number, patientRef?: string) => ({ itemId: items[i].id, quantity: qty(i, share), patientRef });

  // Medical ward: a draft and an approved requisition (stock reserved, waiting to be issued).
  await as('ward.nurse', (u) => srs.create({ departmentId: dept.med, storeId: ms, notes: 'Weekly top-up (sample draft)', lines: [line(0, 0.05), line(1, 0.05)] }, u));
  const approved = await as('ward.nurse', (u) =>
    srs.create({ departmentId: dept.med, storeId: ms, priority: RequisitionPriority.URGENT, notes: 'Ward stock-out (sample)', lines: [line(2, 0.1), line(3, 0.1)], submit: true }, u),
  );
  await act(approved.id, 'ward.incharge', ApprovalActionType.APPROVE, 'Approved (sample)');

  // Surgical ward: pending approval, and one fully issued (one line for a named patient).
  await as('surg.nurse', (u) => srs.create({ departmentId: dept.surg, storeId: ms, notes: 'Theatre list tomorrow (sample)', lines: [line(4, 0.05)], submit: true }, u));
  const issued = await as('surg.nurse', (u) =>
    srs.create({ departmentId: dept.surg, storeId: ms, notes: 'Post-op ward supplies (sample)', lines: [line(0, 0.1), line(5, 0.1, 'IP-2026-00117')], submit: true }, u),
  );
  await act(issued.id, 'surg.incharge', ApprovalActionType.APPROVE);
  const voucher = await as('storekeeper', (u) => issues.issue(issued.id, { collectedBy: 'Halima (sample)' }, u));

  // Maternity: rejected, and partly issued with a back-order (asks for more than the store has).
  const rejected = await as('mat.nurse', (u) => srs.create({ departmentId: dept.mat, storeId: ms, lines: [line(1, 0.5)], submit: true }, u));
  await act(rejected.id, 'mat.incharge', ApprovalActionType.REJECT, 'Quantity far above usual use (sample)');
  const [{ usable: left }] = await ds.query(
    `SELECT COALESCE(SUM(sb.on_hand - sb.reserved), 0)::float AS usable FROM stock_balance sb JOIN batch b ON b.id = sb.batch_id LEFT JOIN bin bn ON bn.id = sb.bin_id
      WHERE sb.store_id = $1 AND sb.item_id = $2 AND b.hold_status = 'NONE' AND NOT COALESCE(bn.is_quarantine, false)
        AND (b.expiry_date IS NULL OR b.expiry_date > CURRENT_DATE)`,
    [ms, items[5].id],
  );
  const partial = await as('mat.nurse', (u) =>
    srs.create(
      { departmentId: dept.mat, storeId: ms, priority: RequisitionPriority.URGENT, notes: 'Labour ward (sample back-order)', lines: [line(2, 0.05), { itemId: items[5].id, quantity: Math.floor(left) + 40 }], submit: true },
      u,
    ),
  );
  await act(partial.id, 'mat.incharge', ApprovalActionType.APPROVE);
  await as('storekeeper', (u) => issues.issue(partial.id, { collectedBy: 'Nafula (sample)' }, u));

  // Returns from the surgical ward: 2 back on the shelf, 1 damaged to quarantine (posted), and a draft.
  const ivl = voucher.lines.find((l) => l.quantity >= 3) ?? voucher.lines[0];
  const posted = await as('surg.nurse', (u) =>
    deptReturns.create(
      {
        departmentId: dept.surg,
        storeId: ms,
        notes: 'Unused after discharge (sample)',
        lines: [
          { itemId: ivl.itemId, batchId: ivl.batchId, issueVoucherLineId: ivl.id, quantity: Math.min(2, ivl.quantity - 1), reasonCode: 'DISCHARGED', condition: ReturnCondition.RESALEABLE },
          { itemId: ivl.itemId, batchId: ivl.batchId, issueVoucherLineId: ivl.id, quantity: 1, reasonCode: 'DAMAGED', condition: ReturnCondition.DAMAGED },
        ],
      },
      u,
    ),
  );
  await as('storekeeper', (u) => deptReturns.post(posted.id, {}, u));
  const other = voucher.lines.find((l) => l.id !== ivl.id);
  if (other) {
    await as('surg.nurse', (u) =>
      deptReturns.create(
        { departmentId: dept.surg, storeId: ms, lines: [{ itemId: other.itemId, batchId: other.batchId, issueVoucherLineId: other.id, quantity: 1, reasonCode: 'NOT_USED', condition: ReturnCondition.RESALEABLE }] },
        u,
      ),
    );
  }

  // The damaged unit goes back to the supplier, who issues a credit note.
  const [q] = await ds.query(
    `SELECT sb.batch_id, sb.bin_id, sb.on_hand::float AS q FROM stock_balance sb JOIN bin bn ON bn.id = sb.bin_id
      WHERE bn.is_quarantine AND sb.store_id = $1 AND sb.on_hand > 0 LIMIT 1`,
    [ms],
  );
  if (q) {
    const rts = await as('storekeeper', () =>
      supplierReturns.create({ supplierId: s1, storeId: ms, reasonCode: 'DAMAGED', notes: 'Damaged on the ward (sample)', lines: [{ batchId: q.batch_id, binId: q.bin_id, quantity: q.q }] }),
    );
    await as('storekeeper', (u) => supplierReturns.dispatch(rts.id, {}, u));
    await as('finance', (u) =>
      supplierReturns.recordCredit(rts.id, { creditNoteNo: 'CN-SAMPLE-001', creditNoteDate: new Date().toISOString().slice(0, 10), amount: rts.totalValue }, u),
    );
  }
  log('sample stores: 6 internal requisitions, 2 issue vouchers (1 back-order), 2 department returns, 1 return to supplier');
}
