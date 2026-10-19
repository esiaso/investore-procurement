import type { INestApplicationContext } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { ApprovalActionType, DocumentType, RequisitionPriority, SessionUser } from '@sil/shared';
import { RequestContext } from '../../common/request-context';
import { ApprovalsService } from '../../modules/approvals/approvals.service';
import { GrnsService } from '../../modules/purchasing/grns.service';
import { InvoicesService } from '../../modules/purchasing/invoices.service';
import { PurchaseOrdersService } from '../../modules/purchasing/purchase-orders.service';
import { RequisitionsService } from '../../modules/purchasing/requisitions.service';
import { RfqsService } from '../../modules/purchasing/rfqs.service';
import { UsersService } from '../../modules/users/users.service';

/**
 * Sample procurement documents at every stage, created through the real
 * services (approvals, budgets, stock posting) so the data is consistent:
 *  - a draft and a pending requisition;
 *  - a full chain PR → RFQ (3 quotes) → award → PO → GRN (inspected, posted) → invoice → payment;
 *  - a part-delivered contract-price PO with an invoice flagged for a price variance;
 *  - an emergency receipt awaiting regularisation.
 * Runs once (skipped when any requisition exists).
 */
export async function seedSamplePurchasing(app: INestApplicationContext, log: (m: string) => void = (m) => console.log(`[seed] ${m}`)) {
  const ds = app.get(DataSource);
  const [{ n }] = await ds.query(`SELECT count(*)::int AS n FROM purchase_requisition`);
  const [{ f }] = await ds.query(`SELECT count(*)::int AS f FROM facility WHERE code = 'SIL-NBI'`);
  if (n > 0 || f === 0) return;

  const users = app.get(UsersService);
  const prs = app.get(RequisitionsService);
  const rfqs = app.get(RfqsService);
  const pos = app.get(PurchaseOrdersService);
  const grns = app.get(GrnsService);
  const invoices = app.get(InvoicesService);
  const approvals = app.get(ApprovalsService);

  const actors = new Map<string, SessionUser>();
  for (const u of ['ward.incharge', 'pharmacist', 'proc.officer', 'proc.manager', 'storekeeper', 'quality', 'tender', 'finance', 'accountant']) {
    const [row] = await ds.query(`SELECT id FROM app_user WHERE username = $1`, [u]);
    const s = row ? await users.findForSession(row.id) : null;
    if (!s) {
      log(`sample purchasing skipped: user ${u} missing`);
      return;
    }
    actors.set(u, s);
  }
  const as = <T>(username: string, fn: (u: SessionUser) => Promise<T>) => {
    const u = actors.get(username)!;
    return RequestContext.run({ userId: u.id, username: u.username, storeIds: u.storeIds }, () => fn(u));
  };
  const approveAll = async (docType: string, docId: string, approvers: string[]) => {
    for (const a of approvers) {
      const [req] = await ds.query(`SELECT id FROM approval_request WHERE document_type = $1 AND document_id = $2 AND status = 'PENDING'`, [docType, docId]);
      if (!req) return;
      await as(a, (u) => approvals.act(req.id, u, ApprovalActionType.APPROVE, 'Sample approval'));
    }
  };

  const id = async (sql: string, params: unknown[] = []) => (await ds.query(sql, params))[0]?.id as string;
  const ms = await id(`SELECT id FROM store WHERE code = 'MS'`);
  const mp = await id(`SELECT id FROM store WHERE code = 'MP'`);
  const ipdMed = await id(`SELECT id FROM department WHERE code = 'IPD-MED'`);
  const pharmDept = await id(`SELECT id FROM department WHERE code = 'PHARM'`);
  const wardBudget = await id(`SELECT id FROM budget WHERE vote_head = 'WARD-SUPPLIES'`);
  const pharmBudget = await id(`SELECT id FROM budget WHERE vote_head = 'PHARMA'`);
  const supplies: { id: string }[] = await ds.query(`SELECT id FROM item WHERE generic_id IS NULL AND NOT is_cold_chain ORDER BY code LIMIT 3`);
  const drugs: { id: string }[] = await ds.query(
    `SELECT i.id FROM item i JOIN contract_price c ON c.item_id = i.id JOIN supplier s ON s.id = c.supplier_id
      WHERE s.code = 'SUP0001' AND NOT i.is_controlled AND NOT i.is_cold_chain ORDER BY i.code LIMIT 3`,
  );
  const [s1, s2, s3, s5] = await Promise.all(['SUP0002', 'SUP0003', 'SUP0005', 'SUP0001'].map((c) => id(`SELECT id FROM supplier WHERE code = $1`, [c])));
  const plus = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);

  // 1. Draft and pending requisitions.
  await as('pharmacist', (u) =>
    prs.create({ departmentId: pharmDept, storeId: mp, budgetId: pharmBudget, justification: 'Monthly top-up (sample draft)', lines: drugs.slice(0, 2).map((d) => ({ itemId: d.id, quantity: 500 })) }, u),
  );
  const pending = await as('pharmacist', (u) =>
    prs.create({ departmentId: pharmDept, storeId: mp, budgetId: pharmBudget, justification: 'Antibiotics for the new IPD wing (sample)', priority: RequisitionPriority.URGENT, lines: drugs.map((d) => ({ itemId: d.id, quantity: 300 })) }, u),
  );
  await as('pharmacist', (u) => prs.submit(pending.id, u));

  // 2. Full chain through RFQ.
  const pr = await as('ward.incharge', (u) =>
    prs.create(
      { departmentId: ipdMed, storeId: ms, budgetId: wardBudget, justification: 'Ward consumables for the quarter (sample)', requiredBy: plus(14), lines: supplies.map((s) => ({ itemId: s.id, quantity: 200 })) },
      u,
    ),
  );
  await as('ward.incharge', (u) => prs.submit(pr.id, u));
  await approveAll(DocumentType.PURCHASE_REQUISITION, pr.id, ['proc.manager']);
  const rfq = await as('proc.officer', () => rfqs.create({ requisitionId: pr.id, title: 'Ward consumables Q4 (sample)', closingDate: plus(7), supplierIds: [s1, s2, s3] }));
  await as('proc.officer', () => rfqs.send(rfq.id));
  const prices = [[9, 7.5, 3], [8.5, 8, 2.8], [9.5, 7, 3.2]];
  for (const [k, supplierId] of [s1, s2, s3].entries()) {
    await as('proc.officer', () =>
      rfqs.recordQuotation(rfq.id, {
        supplierId,
        deliveryDays: [5, 7, 3][k],
        compliant: true,
        lines: rfq.lines!.map((l, j) => ({ rfqLineId: l.id, unitPrice: prices[k][j] })),
      }),
    );
  }
  const comparison = await as('proc.officer', () => rfqs.comparison(rfq.id));
  const awards = comparison.lines.map((l) => ({ rfqLineId: l.rfqLineId, quotationLineId: l.quotes.find((q) => q.lowestCompliant)!.quotationLineId }));
  const awarded = await as('proc.officer', (u) => rfqs.award(rfq.id, { awards, expectedDelivery: plus(10) }, u));
  for (const poId of awarded.purchaseOrderIds) {
    await as('proc.officer', (u) => pos.submit(poId, u));
    await approveAll(DocumentType.PURCHASE_ORDER, poId, ['proc.manager']);
    await as('proc.officer', (u) => pos.send(poId, u));
  }
  const firstPo = await pos.get(awarded.purchaseOrderIds[0]);
  const grn = await as('storekeeper', (u) =>
    grns.create(
      {
        purchaseOrderId: firstPo.id,
        deliveryNoteNo: 'DN-SAMPLE-001',
        lines: firstPo.lines!.map((l, i) => ({ poLineId: l.id, quantity: l.quantity, batchNo: `SMP-${i + 1}-001`, expiryDate: plus(500) })),
      },
      u,
    ),
  );
  await as('storekeeper', (u) => grns.submitForInspection(grn.id, u));
  await as('quality', (u) =>
    grns.inspect(
      grn.id,
      {
        lines: grn.lines!.map((l, i) => ({
          lineId: l.id,
          acceptedQty: i === 0 ? l.receivedBaseQty - 5 : l.receivedBaseQty,
          rejectedQty: i === 0 ? 5 : 0,
          rejectionReason: i === 0 ? 'Packaging damaged (sample)' : undefined,
        })),
      },
      u,
    ),
  );
  await as('tender', (u) => grns.inspect(grn.id, {}, u));
  await as('storekeeper', (u) => grns.post(grn.id, {}, u));
  const posted = await pos.get(firstPo.id);
  const inv = await as('accountant', (u) =>
    invoices.create(
      {
        purchaseOrderId: posted.id,
        supplierInvoiceNo: 'SINV-1001',
        invoiceDate: plus(0),
        lines: posted.lines!.filter((l) => l.receivedBaseQty > 0).map((l) => ({ poLineId: l.id, quantity: l.receivedBaseQty / l.conversionFactor, unitPrice: l.unitPrice })),
      },
      u,
    ),
  );
  await as('accountant', (u) => invoices.submit(inv.id, u));
  await approveAll(DocumentType.SUPPLIER_INVOICE, inv.id, ['finance']);
  await as('finance', () => invoices.pay(inv.id, { paidOn: plus(0), paymentReference: 'EFT-SAMPLE-0001', method: 'EFT' }));

  // 3. Contract-price PO, part-delivered, invoice with a price variance.
  const cpo = await as('proc.officer', (u) =>
    pos.create({ supplierId: s5, storeId: mp, departmentId: pharmDept, budgetId: pharmBudget, expectedDelivery: plus(5), lines: drugs.map((d) => ({ itemId: d.id, quantity: 400 })) }, u),
  );
  await as('proc.officer', (u) => pos.submit(cpo.id, u));
  await approveAll(DocumentType.PURCHASE_ORDER, cpo.id, ['proc.manager', 'finance']);
  await as('proc.officer', (u) => pos.send(cpo.id, u));
  const pgrn = await as('pharmacist', (u) =>
    grns.create({ purchaseOrderId: cpo.id, lines: [{ poLineId: cpo.lines![0].id, quantity: 250, batchNo: 'CP-001', expiryDate: plus(420) }] }, u),
  );
  await as('pharmacist', (u) => grns.submitForInspection(pgrn.id, u));
  await as('quality', (u) => grns.inspect(pgrn.id, { lines: pgrn.lines!.map((l) => ({ lineId: l.id, acceptedQty: l.receivedBaseQty, rejectedQty: 0 })) }, u));
  await as('tender', (u) => grns.inspect(pgrn.id, {}, u));
  await as('pharmacist', (u) => grns.post(pgrn.id, {}, u));
  await as('accountant', (u) =>
    invoices.create(
      { purchaseOrderId: cpo.id, supplierInvoiceNo: 'AMANI-7781', invoiceDate: plus(0), lines: [{ poLineId: cpo.lines![0].id, quantity: 250, unitPrice: Math.round(cpo.lines![0].unitPrice * 1.08 * 100) / 100 }] },
      u,
    ),
  );

  // 4. Emergency receipt without a PO.
  const egrn = await as('storekeeper', (u) =>
    grns.create(
      { supplierId: s2, storeId: ms, emergencyReason: 'Theatre ran out over the weekend (sample)', lines: [{ itemId: supplies[0].id, quantity: 50, unitPrice: 8, batchNo: 'EM-001', expiryDate: plus(600) }] },
      u,
    ),
  );
  await as('storekeeper', (u) => grns.submitForInspection(egrn.id, u));
  await as('quality', (u) => grns.inspect(egrn.id, { lines: egrn.lines!.map((l) => ({ lineId: l.id, acceptedQty: l.receivedBaseQty, rejectedQty: 0 })) }, u));
  await as('tender', (u) => grns.inspect(egrn.id, {}, u));
  await as('storekeeper', (u) => grns.post(egrn.id, {}, u));

  log('sample purchasing: requisitions, RFQ with 3 quotations, POs, GRNs (incl. emergency), invoices and a payment');
}
