import { evaluateQuotations } from '../src/modules/purchasing/rfqs.service';
import { renderPurchaseOrderHtml } from '../src/modules/purchasing/po-pdf';
import { PurchaseOrdersService } from '../src/modules/purchasing/purchase-orders.service';
import { Client, createTestApp, idByCode, loggedIn, TestContext, uniq } from './helpers';

/** Binary GET (PDFs). */
const bin = (c: Client, path: string) =>
  c.get(path).buffer(true).parse((r, cb) => {
    const chunks: Buffer[] = [];
    r.on('data', (d: Buffer) => chunks.push(d));
    r.on('end', () => cb(null, Buffer.concat(chunks)));
  });

const day = (d = 0) =>
  new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Nairobi', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(Date.now() + d * 86_400_000));

describe('evaluateQuotations (unit)', () => {
  const q = (name: string, total: number, scores: number[], compliant = true, linesQuoted = 2) => ({ name, total, compliant, linesQuoted, scores: scores.map((technicalScore) => ({ technicalScore })) });

  it('price only: the lowest complete compliant quotation wins', () => {
    const r = evaluateQuotations([q('a', 100, []), q('b', 80, []), q('c', 50, [], false), q('d', 40, [], true, 1)], { technicalWeight: 0, passMark: 70, allLines: 2 });
    expect(r.map((x) => [x.name, x.financialScore, x.recommended])).toEqual([['a', 80, false], ['b', 100, true], ['c', null, false], ['d', null, false]]);
  });

  it('weighted: below the pass mark is out even if cheaper; combined = technical × w + financial × (1 − w)', () => {
    const r = evaluateQuotations([q('cheap', 80, [60, 60]), q('good', 100, [90, 80]), q('ok', 90, [75, 75])], { technicalWeight: 40, passMark: 70, allLines: 2 });
    const by = Object.fromEntries(r.map((x) => [x.name, x]));
    expect(by.cheap).toMatchObject({ technicalScore: 60, financialScore: 100, passes: false, rank: null, recommended: false });
    // good: 85 × 0.4 + 80 × 0.6 = 82; ok: 75 × 0.4 + 88.89 × 0.6 = 83.33 → ok ranks first.
    expect(by.good).toMatchObject({ technicalScore: 85, financialScore: 80, combinedScore: 82, rank: 2, recommended: false });
    expect(by.ok).toMatchObject({ technicalScore: 75, financialScore: 88.89, combinedScore: 83.33, rank: 1, recommended: true });
  });
});

describe('Non-stock procurement phase 2: RFQ, evaluation, LPO / LSO', () => {
  let ctx: TestContext;
  const c: Record<string, Client> = {};
  const ids: Record<string, string> = {};
  const q = async (sql: string, p: unknown[] = []) => ctx.ds.query(sql, p);
  const one = async (sql: string, p: unknown[] = []) => (await q(sql, p))[0];
  const pending = async (docId: string) => one(`SELECT id FROM approval_request WHERE document_id = $1 AND status = 'PENDING' ORDER BY created_at DESC LIMIT 1`, [docId]);
  const approveAll = async (docId: string) => {
    for (let i = 0; i < 4; i++) {
      const ar = await pending(docId);
      if (!ar) return;
      const step = await one(`SELECT s.role_id, s.approver_type FROM approval_request r JOIN approval_step s ON s.workflow_id = r.workflow_id AND s.sequence = r.current_step WHERE r.id = $1`, [ar.id]);
      const who = await one(
        `SELECT u.username FROM user_role ur JOIN app_user u ON u.id = ur.user_id WHERE ur.role_id = $1 AND u.is_active
           AND u.id NOT IN (SELECT requested_by FROM approval_request WHERE id = $2) AND u.id NOT IN (SELECT user_id FROM approval_action WHERE request_id = $2 AND user_id IS NOT NULL)
           AND ($3 <> 'DEPARTMENT_ROLE' OR u.department_id = (SELECT department_id FROM approval_request WHERE id = $2)) ORDER BY u.username LIMIT 1`,
        [step.role_id, ar.id, step.approver_type],
      );
      if (!c[who.username]) c[who.username] = await loggedIn(ctx, who.username);
      await c[who.username].post(`/approvals/${ar.id}/approve`, {}).expect(200);
    }
  };

  /** An approved purchase requisition consolidated from a ward requisition (service + goods). */
  async function approvedPr(lines: Record<string, unknown>[]) {
    const r = (await c['ward.nurse'].post('/staff-requisitions', { departmentId: ids.IPD_MED, justification: 'Phase 2 buying', lines, submit: true }).expect(201)).body;
    await approveAll(r.id);
    const req = (await c['ward.nurse'].get(`/staff-requisitions/${r.id}`).expect(200)).body;
    const pr = (await c['proc.officer'].post('/staff-requisitions/consolidate', { lineIds: req.lines.map((l: { id: string }) => l.id), departmentId: ids.ADMIN, storeId: ids.MS, justification: 'Phase 2 buying', budgetId: ids.budget }).expect(201)).body;
    await c['proc.officer'].post(`/requisitions/${pr.id}/submit`).expect(200);
    await approveAll(pr.id);
    return (await c['proc.officer'].get(`/requisitions/${pr.id}`).expect(200)).body;
  }

  beforeAll(async () => {
    ctx = await createTestApp();
    for (const u of ['admin', 'ward.nurse', 'ward.incharge', 'proc.officer', 'proc.manager', 'finance', 'accountant', 'scm', 'storekeeper']) c[u] = await loggedIn(ctx, u);
    Object.assign(ids, {
      MS: await idByCode(ctx.ds, 'store', 'MS'),
      IPD_MED: await idByCode(ctx.ds, 'department', 'IPD-MED'),
      ADMIN: await idByCode(ctx.ds, 'department', 'ADMIN'),
      glRepairs: await idByCode(ctx.ds, 'gl_account', '5110'),
      glFurniture: await idByCode(ctx.ds, 'gl_account', '1600'),
      pcs: await idByCode(ctx.ds, 'unit_of_measure', 'PCS'),
    });
    const sups: { id: string }[] = await q(`SELECT id FROM supplier WHERE status = 'ACTIVE' AND email IS NOT NULL ORDER BY code LIMIT 3`);
    [ids.s1, ids.s2, ids.s3] = sups.map((s) => s.id);
    ids.budget = (await c.finance.post('/budgets', { departmentId: ids.ADMIN, voteHead: uniq('NS').replace(/-/g, '_'), amount: 10_000_000, enforcement: 'WARN' }).expect(201)).body.id;
    await q(`INSERT INTO exchange_rate (currency_code, rate_date, rate, source) VALUES ('USD', $1, 130, 'test') ON CONFLICT (currency_code, rate_date) DO UPDATE SET rate = 130`, [day()]);
  });

  afterAll(async () => {
    await q(`UPDATE system_setting SET value = 'false'::jsonb WHERE key = 'purchasing.autoSendOnApproval'`);
    await ctx.close();
  });

  const service = { lineType: 'SERVICE', description: 'Service the theatre autoclave', quantity: 1, estimatedUnitCost: 45_000 };
  const goods = { lineType: 'NON_STOCK_GOODS', description: 'Ergonomic office chairs', quantity: 4, uomId: '', estimatedUnitCost: 12_500 };

  describe('RFQ → evaluation → award → LPO', () => {
    let pr: { id: string; lines: { id: string; lineType: string }[] };
    let rfqId: string;
    let lines: { id: string; description: string; lineType: string }[];
    let poId: string;

    it('raises an RFQ for non-stock lines; needs the minimum number of suppliers or a justification', async () => {
      pr = await approvedPr([{ ...service, glAccountId: ids.glRepairs }, { ...goods, uomId: ids.pcs, glAccountId: ids.glFurniture }]);
      const rfq = (await c['proc.officer'].post('/rfqs', { requisitionId: pr.id, title: 'Autoclave service and chairs', closingDate: day(7), supplierIds: [ids.s1, ids.s2] }).expect(201)).body;
      rfqId = rfq.id;
      lines = rfq.lines;
      expect(lines.map((l) => l.description).sort()).toEqual(['Ergonomic office chairs', 'Service the theatre autoclave']);
      expect((await c['proc.officer'].get(`/requisitions/${pr.id}`).expect(200)).body.status).toBe('RFQ_ISSUED');
      const short = await c['proc.officer'].post(`/rfqs/${rfqId}/send`, {}).expect(400);
      expect(short.body.code).toBe('MIN_SUPPLIERS');
      await q(`UPDATE rfq SET supplier_ids = $2 WHERE id = $1`, [rfqId, [ids.s1, ids.s2, ids.s3]]);
      await c['proc.officer'].put(`/rfqs/${rfqId}/evaluation`, { technicalWeight: 40, committeeUserIds: [] }).expect(400); // a technical part needs a committee
      const members = await q(`SELECT id FROM app_user WHERE username IN ('finance', 'accountant') ORDER BY username`);
      await c['proc.officer'].put(`/rfqs/${rfqId}/evaluation`, { technicalWeight: 40, passMark: 70, committeeUserIds: members.map((m: { id: string }) => m.id) }).expect(200);
      await c['proc.officer'].post(`/rfqs/${rfqId}/send`, {}).expect(200);
      const mails = await q(`SELECT subject, attachments FROM email_outbox WHERE source_doc_type = 'RFQ' AND source_doc_id = $1`, [rfqId]);
      expect(mails).toHaveLength(3);
      expect(mails[0].attachments[0]).toMatchObject({ kind: 'RFQ_PDF' });
      const pdf = await bin(c['proc.officer'], `/rfqs/${rfqId}/pdf`).expect(200);
      expect((pdf.body as Buffer).subarray(0, 4).toString()).toBe('%PDF');
    });

    it('captures quotations in different currencies and closes bidding', async () => {
      const svc = lines.find((l) => l.lineType === 'SERVICE')!.id;
      const chairs = lines.find((l) => l.lineType !== 'SERVICE')!.id;
      // s1 cheaper in KES but weak technically; s2 quotes in USD; s3 not compliant.
      await c['proc.officer'].post(`/rfqs/${rfqId}/quotations`, { supplierId: ids.s1, deliveryDays: 10, paymentTermsDays: 30, lines: [{ rfqLineId: svc, unitPrice: 36_000 }, { rfqLineId: chairs, unitPrice: 10_000 }] }).expect(200);
      await c['proc.officer'].post(`/rfqs/${rfqId}/quotations`, { supplierId: ids.s2, currency: 'USD', deliveryDays: 7, paymentTermsDays: 45, lines: [{ rfqLineId: svc, unitPrice: 300 }, { rfqLineId: chairs, unitPrice: 80 }] }).expect(200);
      await c['proc.officer'].post(`/rfqs/${rfqId}/quotations`, { supplierId: ids.s3, compliant: false, complianceNotes: 'No PPB licence', lines: [{ rfqLineId: svc, unitPrice: 20_000 }, { rfqLineId: chairs, unitPrice: 5_000 }] }).expect(200);
      await c.finance.post(`/rfqs/${rfqId}/scores`, { quotationId: (await one(`SELECT id FROM quotation WHERE rfq_id = $1 AND supplier_id = $2`, [rfqId, ids.s1])).id, technicalScore: 50 }).expect(409); // bidding still open
      await c['proc.officer'].post(`/rfqs/${rfqId}/close`).expect(200);
      await c['proc.officer'].post(`/rfqs/${rfqId}/quotations`, { supplierId: ids.s1, lines: [{ rfqLineId: svc, unitPrice: 1 }] }).expect(409); // closed
    });

    it('the committee scores, the evaluation recommends, the comparison shows every score', async () => {
      const qid = async (s: string) => (await one(`SELECT id FROM quotation WHERE rfq_id = $1 AND supplier_id = $2`, [rfqId, s])).id;
      await c['proc.officer'].post(`/rfqs/${rfqId}/scores`, { quotationId: await qid(ids.s1), technicalScore: 90 }).expect(403); // not on the committee
      await c.finance.post(`/rfqs/${rfqId}/scores`, { quotationId: await qid(ids.s3), technicalScore: 90 }).expect(400); // non-compliant
      await c.finance.post(`/rfqs/${rfqId}/scores`, { quotationId: await qid(ids.s1), technicalScore: 60 }).expect(200);
      await c.finance.post(`/rfqs/${rfqId}/scores`, { quotationId: await qid(ids.s2), technicalScore: 90 }).expect(200);
      await c.accountant.post(`/rfqs/${rfqId}/scores`, { quotationId: await qid(ids.s1), technicalScore: 60 }).expect(200);
      await c['proc.officer'].post(`/rfqs/${rfqId}/evaluate`, { recommendation: 'Waiting' }).expect(400); // accountant has not scored s2
      await c.accountant.post(`/rfqs/${rfqId}/scores`, { quotationId: await qid(ids.s2), technicalScore: 80, comment: 'Good references' }).expect(200);
      const res = (await c['proc.officer'].post(`/rfqs/${rfqId}/evaluate`, { recommendation: 'Supplier 2: technically sound and lowest in KES' }).expect(200)).body;
      const s1 = res.suppliers.find((s: { supplierId: string }) => s.supplierId === ids.s1);
      const s2 = res.suppliers.find((s: { supplierId: string }) => s.supplierId === ids.s2);
      // s1: 36,000 + 4 × 10,000 = 76,000 KES; s2: (300 + 4 × 80) × 130 = 80,600 KES.
      expect(s1).toMatchObject({ total: 76_000, technicalScore: 60, financialScore: 100, passes: false, recommended: false });
      expect(s2).toMatchObject({ total: 80_600, quotedTotal: 620, currency: 'USD', technicalScore: 85, financialScore: 94.29, combinedScore: 90.57, passes: true, recommended: true });
      expect(res.rfq).toMatchObject({ status: 'EVALUATED', recommendedSupplierId: ids.s2 });
      // Ranking per line is in KES: s1 is the lowest compliant on both lines.
      expect(res.lines.every((l: { quotes: { supplierId: string; lowestCompliant: boolean }[] }) => l.quotes.find((x) => x.lowestCompliant)!.supplierId === ids.s1)).toBe(true);
    });

    it('awarding past the lowest compliant quote needs a justification; the award becomes an LPO in the quotation currency', async () => {
      const cmp = (await c['proc.officer'].get(`/rfqs/${rfqId}/comparison`).expect(200)).body;
      const awards = cmp.lines.map((l: { rfqLineId: string; quotes: { supplierId: string; quotationLineId: string }[] }) => ({ rfqLineId: l.rfqLineId, quotationLineId: l.quotes.find((x) => x.supplierId === ids.s2)!.quotationLineId }));
      const no = await c['proc.officer'].post(`/rfqs/${rfqId}/award`, { awards }).expect(400);
      expect(no.body.code).toBe('JUSTIFICATION_REQUIRED');
      const res = (await c['proc.officer'].post(`/rfqs/${rfqId}/award`, { awards, justification: 'Recommended by the evaluation: supplier 1 failed the technical pass mark', deliveryAddress: 'Theatre 2, attention: Ward Sister' }).expect(200)).body;
      expect(res.purchaseOrderIds).toHaveLength(1);
      poId = res.purchaseOrderIds[0];
      const po = (await c['proc.officer'].get(`/purchase-orders/${poId}`).expect(200)).body;
      expect(po).toMatchObject({ currency: 'USD', exchangeRate: 130, subtotal: 620, taxTotal: 99.2, total: 719.2, baseTotal: 93_496, whtTotal: 15, deliveryAddress: 'Theatre 2, attention: Ward Sister', expiresOn: day(60) });
      expect(po.terms).toMatch(/eTIMS/);
      const svc = po.lines.find((l: { lineType: string }) => l.lineType === 'SERVICE');
      expect(svc).toMatchObject({ itemId: null, description: 'Service the theatre autoclave', quantity: 1, unitPrice: 300, whtRatePercent: 5, whtAmount: 15, uom: { code: 'JOB' } });
      expect(po.lines.find((l: { lineType: string }) => l.lineType === 'NON_STOCK_GOODS')).toMatchObject({ uom: { code: 'PCS' }, whtAmount: 0, glAccountId: ids.glFurniture });
      expect((await c['proc.officer'].get(`/requisitions/${pr.id}`).expect(200)).body.status).toBe('LPO_RAISED');
    });

    it('approves on the base-currency value, commits the budget in KES, prints and emails an LPO', async () => {
      await c['proc.officer'].post(`/purchase-orders/${poId}/submit`).expect(200);
      const ar = await one(`SELECT amount::float, currency FROM approval_request WHERE document_id = $1`, [poId]);
      expect(ar).toEqual({ amount: 93_496, currency: 'USD' });
      await approveAll(poId);
      const commit = await one(`SELECT SUM(amount)::float AS v FROM budget_entry WHERE budget_id = $1 AND source_doc_id = $2`, [ids.budget, poId]);
      expect(commit.v).toBe(93_496);
      const po = (await c['proc.officer'].get(`/purchase-orders/${poId}`).expect(200)).body;
      expect(po.status).toBe('APPROVED');
      const html = renderPurchaseOrderHtml(po, { name: 'Hospital', address: null, phone: null, email: null, kra_pin: null }, [], { short: 'LPO', long: 'Local purchase order' }, { dateFormat: 'dd/MM/yyyy', timezone: 'Africa/Nairobi' });
      expect(html).toContain('LOCAL PURCHASE ORDER');
      expect(html).toContain('Less withholding tax');
      expect(html).toContain('Valid until');
      expect(html).toContain('Service the theatre autoclave');
      const pdf = await bin(c['proc.officer'], `/purchase-orders/${poId}/pdf`).expect(200);
      expect((pdf.body as Buffer).subarray(0, 4).toString()).toBe('%PDF');
      await c['proc.officer'].post(`/purchase-orders/${poId}/send`).expect(200);
      const mail = await one(`SELECT subject FROM email_outbox WHERE source_doc_type = 'PO' AND source_doc_id = $1`, [poId]);
      expect(mail.subject).toMatch(/^Local purchase order /);
    });

    it('non-stock lines are never received into a store', async () => {
      const po = (await c['proc.officer'].get(`/purchase-orders/${poId}`).expect(200)).body;
      const res = await c.storekeeper.post('/grns', { purchaseOrderId: poId, storeId: ids.MS, receivedDate: day(), lines: [{ poLineId: po.lines[0].id, quantity: 1 }] });
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('NON_STOCK_LINE');
    });

    it('amends a non-stock LPO (new version, re-approval on the new value)', async () => {
      const po = (await c['proc.officer'].get(`/purchase-orders/${poId}`).expect(200)).body;
      await c['proc.officer']
        .post(`/purchase-orders/${poId}/amend`, { reason: 'Supplier discount', lines: po.lines.map((l: { id: string; quantity: number; unitPrice: number; lineType: string }) => ({ lineId: l.id, quantity: l.quantity, unitPrice: l.lineType === 'SERVICE' ? 250 : l.unitPrice })) })
        .expect(200);
      const v2 = (await c['proc.officer'].get(`/purchase-orders/${poId}`).expect(200)).body;
      expect(v2).toMatchObject({ version: 2, status: 'PENDING_APPROVAL', subtotal: 570, whtTotal: 12.5 });
      expect(v2.lines.find((l: { lineType: string }) => l.lineType === 'SERVICE')).toMatchObject({ description: 'Service the theatre autoclave', itemId: null });
      await approveAll(poId);
      expect((await c['proc.officer'].get(`/purchase-orders/${poId}`).expect(200)).body.status).toBe('SENT');
    });
  });

  describe('direct LSO, sending on approval, expiry', () => {
    it('a direct order for service lines is an LSO, emailed as soon as it is approved, and expires unused', async () => {
      await q(`UPDATE system_setting SET value = 'true'::jsonb WHERE key = 'purchasing.autoSendOnApproval'`);
      const pr = await approvedPr([{ ...service, description: 'Annual lift maintenance', estimatedUnitCost: 120_000 }]);
      const line = pr.lines[0];
      const po = (await c['proc.officer'].post('/purchase-orders', { requisitionId: pr.id, supplierId: ids.s1, lines: [{ requisitionLineId: line.id }] }).expect(201)).body;
      expect(po).toMatchObject({ currency: 'KES', exchangeRate: 1, subtotal: 120_000, whtTotal: 6_000, baseTotal: 139_200 });
      await c['proc.officer'].post(`/purchase-orders/${po.id}/submit`).expect(200);
      await approveAll(po.id);
      expect((await c['proc.officer'].get(`/purchase-orders/${po.id}`).expect(200)).body.status).toBe('SENT');
      expect((await one(`SELECT subject FROM email_outbox WHERE source_doc_type = 'PO' AND source_doc_id = $1`, [po.id])).subject).toMatch(/^Local service order /);
      expect((await c['proc.officer'].get(`/requisitions/${pr.id}`).expect(200)).body.status).toBe('LPO_RAISED');

      await q(`UPDATE purchase_order SET expires_on = $2 WHERE id = $1`, [po.id, day(-1)]);
      expect(await ctx.app.get(PurchaseOrdersService).expireOrders()).toMatchObject({ expired: 1 });
      expect((await c['proc.officer'].get(`/purchase-orders/${po.id}`).expect(200)).body.status).toBe('EXPIRED');
      // The requisition line is free to order again and the commitment is released.
      const back = (await c['proc.officer'].get(`/requisitions/${pr.id}`).expect(200)).body;
      expect(back).toMatchObject({ status: 'APPROVED', lines: [expect.objectContaining({ orderedQty: 0 })] });
      const open = await one(`SELECT COALESCE(SUM(amount), 0)::float AS v FROM budget_entry WHERE source_doc_id = $1`, [po.id]);
      expect(open.v).toBe(0);
    });
  });
});
