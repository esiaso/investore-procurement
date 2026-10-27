import { threeWayMatch } from '../src/modules/purchasing/matching';
import { certificateKind } from '../src/modules/logistics/service-certificates.service';
import { PurchaseLineType } from '@sil/shared';
import { Client, createTestApp, idByCode, loggedIn, TestContext, uniq } from './helpers';

const bin = (c: Client, path: string) =>
  c.get(path).buffer(true).parse((r, cb) => {
    const chunks: Buffer[] = [];
    r.on('data', (d: Buffer) => chunks.push(d));
    r.on('end', () => cb(null, Buffer.concat(chunks)));
  });

const day = (d = 0) =>
  new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Nairobi', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(Date.now() + d * 86_400_000));

describe('three-way match tolerances (unit)', () => {
  const base = { poLineId: 'l', label: 'Line 1', orderedQty: 10, receivedQty: 10, previouslyInvoicedQty: 0, invoicedQty: 10, poUnitPrice: 1000 };
  it('a price difference must be within the percentage and, when set, the absolute amount', () => {
    // +1% = 10 per unit, 100 on the line.
    expect(threeWayMatch([{ ...base, invoiceUnitPrice: 1010 }], { quantityPct: 0, pricePct: 2 })).toEqual([]);
    expect(threeWayMatch([{ ...base, invoiceUnitPrice: 1010 }], { quantityPct: 0, pricePct: 2, priceAbs: 150 })).toEqual([]);
    const over = threeWayMatch([{ ...base, invoiceUnitPrice: 1010 }], { quantityPct: 0, pricePct: 2, priceAbs: 50 });
    expect(over.map((v) => v.code)).toEqual(['PRICE_VARIANCE']);
    expect(over[0].message).toContain('+100 on the line');
    expect(threeWayMatch([{ ...base, invoiceUnitPrice: 1030 }], { quantityPct: 0, pricePct: 2, priceAbs: 1000 }).map((v) => v.code)).toEqual(['PRICE_VARIANCE']);
  });

  it('names certificates by what they cover', () => {
    expect(certificateKind([PurchaseLineType.SERVICE])).toBe('Service acceptance certificate');
    expect(certificateKind([PurchaseLineType.SERVICE, PurchaseLineType.NON_STOCK_GOODS])).toBe('Goods received note (non-stock)');
    expect(certificateKind([PurchaseLineType.STOCK])).toBe('Service / works completion certificate');
  });
});

describe('Non-stock procurement phase 3: acceptance, invoices, delivery to the final user', () => {
  let ctx: TestContext;
  const c: Record<string, Client> = {};
  const ids: Record<string, string> = {};
  const q = async (sql: string, p: unknown[] = []) => ctx.ds.query(sql, p);
  const one = async (sql: string, p: unknown[] = []) => (await q(sql, p))[0];
  const setting = (key: string, value: unknown) => q(`UPDATE system_setting SET value = $2::jsonb WHERE key = $1`, [key, JSON.stringify(value)]);
  const notes = async (username: string, like: string) =>
    q(`SELECT n.title, n.body FROM notification n JOIN app_user u ON u.id = n.user_id WHERE u.username = $1 AND n.title LIKE $2 ORDER BY n.created_at`, [username, like]);
  const approveAll = async (docId: string) => {
    for (let i = 0; i < 4; i++) {
      const ar = await one(`SELECT id FROM approval_request WHERE document_id = $1 AND status = 'PENDING' ORDER BY created_at DESC LIMIT 1`, [docId]);
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
  const stockFootprint = async () => one(`SELECT COUNT(*)::int AS txns, COALESCE(SUM(on_hand), 0)::float AS onhand FROM stock_transaction t FULL JOIN (SELECT SUM(on_hand) AS on_hand FROM stock_balance) b ON false`);

  beforeAll(async () => {
    ctx = await createTestApp();
    for (const u of ['admin', 'ward.nurse', 'ward.incharge', 'surg.nurse', 'proc.officer', 'finance', 'accountant', 'storekeeper']) c[u] = await loggedIn(ctx, u);
    Object.assign(ids, {
      MS: await idByCode(ctx.ds, 'store', 'MS'),
      IPD_MED: await idByCode(ctx.ds, 'department', 'IPD-MED'),
      ADMIN: await idByCode(ctx.ds, 'department', 'ADMIN'),
      glRepairs: await idByCode(ctx.ds, 'gl_account', '5110'),
      glFurniture: await idByCode(ctx.ds, 'gl_account', '1600'),
      pcs: await idByCode(ctx.ds, 'unit_of_measure', 'PCS'),
      supplier: (await one(`SELECT id FROM supplier WHERE status = 'ACTIVE' AND email IS NOT NULL ORDER BY code LIMIT 1`)).id,
      nurse: (await one(`SELECT id FROM app_user WHERE username = 'ward.nurse'`)).id,
      stockItem: (await one(`SELECT b.item_id FROM stock_balance b JOIN item i ON i.id = b.item_id WHERE b.store_id = $1 AND b.on_hand > 50 AND NOT i.is_controlled ORDER BY b.on_hand DESC LIMIT 1`, [await idByCode(ctx.ds, 'store', 'MS')])).item_id,
    });
    ids.budget = (await c.finance.post('/budgets', { departmentId: ids.ADMIN, voteHead: uniq('NS3').replace(/-/g, '_'), amount: 10_000_000, enforcement: 'WARN' }).expect(201)).body.id;
  });

  afterAll(async () => {
    await setting('purchasing.autoApproveMatchedInvoices', false);
    await setting('purchasing.matchPriceToleranceAbs', 0);
    await ctx.close();
  });

  describe('the whole chain: REQ → PR → LPO → acceptance → invoice → hand-over', () => {
    let reqId: string;
    let reqNo: string;
    let prId: string;
    let po: { id: string; lines: { id: string; lineType: string; unitPrice: number }[] };
    let svcLine: string;
    let chairLine: string;
    let certId: string;
    let before: { txns: number; onhand: number };

    it('a requisition becomes an LSO/LPO; the requester hears when the PR is approved and the order is issued', async () => {
      before = await stockFootprint();
      const r = (await c['ward.nurse']
        .post('/staff-requisitions', {
          departmentId: ids.IPD_MED,
          justification: 'Phase 3 end to end',
          submit: true,
          lines: [
            { lineType: 'SERVICE', description: 'Recalibrate the ward ECG machine', quantity: 1, estimatedUnitCost: 45_000, glAccountId: ids.glRepairs },
            { lineType: 'NON_STOCK_GOODS', description: 'Bedside lockers', quantity: 4, uomId: ids.pcs, estimatedUnitCost: 12_500, glAccountId: ids.glFurniture },
          ],
        })
        .expect(201)).body;
      reqId = r.id;
      reqNo = r.number;
      await approveAll(reqId);
      const req = (await c['ward.nurse'].get(`/staff-requisitions/${reqId}`).expect(200)).body;
      const pr = (await c['proc.officer'].post('/staff-requisitions/consolidate', { lineIds: req.lines.map((l: { id: string }) => l.id), departmentId: ids.ADMIN, storeId: ids.MS, justification: 'Phase 3', budgetId: ids.budget }).expect(201)).body;
      prId = pr.id;
      await c['proc.officer'].post(`/requisitions/${prId}/submit`).expect(200);
      await approveAll(prId);
      expect(await notes('ward.nurse', `${reqNo}: purchase request approved`)).toHaveLength(1);

      const prFull = (await c['proc.officer'].get(`/requisitions/${prId}`).expect(200)).body;
      po = (await c['proc.officer'].post('/purchase-orders', { requisitionId: prId, supplierId: ids.supplier, lines: prFull.lines.map((l: { id: string }) => ({ requisitionLineId: l.id })) }).expect(201)).body;
      await c['proc.officer'].post(`/purchase-orders/${po.id}/submit`).expect(200);
      await approveAll(po.id);
      await c['proc.officer'].post(`/purchase-orders/${po.id}/send`).expect(200);
      await c['proc.officer'].post(`/purchase-orders/${po.id}/send`).expect(200); // a resend does not notify again
      expect(await notes('ward.nurse', `${reqNo}: LPO issued`)).toHaveLength(1);
      po = (await c['proc.officer'].get(`/purchase-orders/${po.id}`).expect(200)).body;
      svcLine = po.lines.find((l) => l.lineType === 'SERVICE')!.id;
      chairLine = po.lines.find((l) => l.lineType === 'NON_STOCK_GOODS')!.id;
    });

    it('the delivery is recorded (not by the buyer), with rejected quantities and reasons; posting it needs the requesting department', async () => {
      const body = { purchaseOrderId: po.id, periodTo: day(), workDone: 'ECG recalibrated and certified; lockers delivered, one damaged', lines: [{ poLineId: svcLine, quantity: 1 }, { poLineId: chairLine, quantity: 3, rejectedQty: 1 }] };
      await c['proc.officer'].post('/service-certificates', body).expect(403); // raised the order
      await c.storekeeper.post('/service-certificates', body).expect(400); // rejected without a reason
      body.lines[1] = { poLineId: chairLine, quantity: 3, rejectedQty: 1, rejectionReason: 'Door hinge broken' } as (typeof body.lines)[number];
      const cert = (await c.storekeeper.post('/service-certificates', body).expect(201)).body;
      certId = cert.id;
      expect(cert).toMatchObject({ kind: 'Goods received note (non-stock)', status: 'DRAFT', requisitions: [{ id: reqId, number: reqNo }] });
      expect(cert.lines.find((l: { poLineId: string }) => l.poLineId === chairLine)).toMatchObject({ quantity: 3, rejectedQty: 1, rejectionReason: 'Door hinge broken', item: 'Bedside lockers' });
      expect(await notes('ward.nurse', `${cert.number}: please confirm what was delivered`)).toHaveLength(1);
      const post = await c.storekeeper.post(`/service-certificates/${certId}/post`).expect(409);
      expect(post.body.code).toBe('ACCEPTANCE_REQUIRED');
    });

    it('only the requester (or their department) sees and signs it; nothing touches stock', async () => {
      await c['surg.nurse'].get(`/service-certificates/${certId}`).expect(403);
      await c['surg.nurse'].post(`/service-certificates/${certId}/accept`).expect(403);
      const mine = (await c['ward.nurse'].get('/service-certificates/awaiting-me').expect(200)).body;
      expect(mine.map((x: { id: string }) => x.id)).toContain(certId);
      expect((await c['ward.nurse'].get(`/service-certificates/${certId}`).expect(200)).body.canSign).toBe(true);
      const pdf = await bin(c['ward.nurse'], `/service-certificates/${certId}/pdf`).expect(200);
      expect((pdf.body as Buffer).subarray(0, 4).toString()).toBe('%PDF');

      const done = (await c['ward.nurse'].post(`/service-certificates/${certId}/accept`).expect(200)).body;
      expect(done).toMatchObject({ status: 'POSTED', acceptedByName: 'Moraa Nurse' });
      expect((await c['proc.officer'].get(`/purchase-orders/${po.id}`).expect(200)).body.status).toBe('PARTIALLY_RECEIVED');
      const req = (await c['ward.nurse'].get(`/staff-requisitions/${reqId}`).expect(200)).body;
      const svc = req.lines.find((l: { lineType: string }) => l.lineType === 'SERVICE');
      const lockers = req.lines.find((l: { lineType: string }) => l.lineType === 'NON_STOCK_GOODS');
      // The service, accepted by the requester herself, has reached her; the lockers wait to be handed over.
      expect(svc).toMatchObject({ receivedQty: 1, deliveredQty: 1, status: 'DELIVERED' });
      expect(lockers).toMatchObject({ receivedQty: 3, deliveredQty: 0, status: 'ON_PR' });
      expect(req.deliverable.find((d: { lineType: string }) => d.lineType === 'NON_STOCK_GOODS')).toMatchObject({ available: 3 });
      expect(await notes('ward.nurse', `${reqNo}: received from the supplier`)).toHaveLength(1);
      expect(await stockFootprint()).toEqual(before);
    });

    it('a refused delivery is not received', async () => {
      const cert = (await c.storekeeper.post('/service-certificates', { purchaseOrderId: po.id, periodTo: day(), workDone: 'Fourth locker (replacement)', lines: [{ poLineId: chairLine, quantity: 1 }] }).expect(201)).body;
      await c['ward.nurse'].post(`/service-certificates/${cert.id}/reject`, { reason: 'Wrong colour delivered' }).expect(200);
      expect((await c.storekeeper.get(`/service-certificates/${cert.id}`).expect(200)).body).toMatchObject({ status: 'REJECTED', rejectionReason: 'Wrong colour delivered' });
      expect((await c['proc.officer'].get(`/purchase-orders/${po.id}`).expect(200)).body.status).toBe('PARTIALLY_RECEIVED');
    });

    it('invoices are matched against what was accepted, with % and absolute price tolerances and withholding tax', async () => {
      const svcPrice = po.lines.find((l) => l.id === svcLine)!.unitPrice;
      const chairPrice = po.lines.find((l) => l.id === chairLine)!.unitPrice;
      const over = (await c.accountant.post('/invoices', { purchaseOrderId: po.id, supplierInvoiceNo: uniq('SI'), invoiceDate: day(), lines: [{ poLineId: svcLine, quantity: 1, unitPrice: svcPrice }, { poLineId: chairLine, quantity: 4, unitPrice: chairPrice }] }).expect(201)).body;
      expect(over.variances.map((v: { code: string }) => v.code)).toEqual(['QTY_EXCEEDS_RECEIVED']);
      expect(over.variances[0].message).toContain('Bedside lockers');
      await c.accountant.post(`/invoices/${over.id}/cancel`).expect(200);

      // +100 a locker is 0.8%: inside the 2% band but over a 200 absolute cap on 3 lockers (+300).
      await setting('purchasing.matchPriceToleranceAbs', 200);
      const inv = (await c.accountant.post('/invoices', { purchaseOrderId: po.id, supplierInvoiceNo: uniq('SI'), invoiceDate: day(), lines: [{ poLineId: svcLine, quantity: 1, unitPrice: svcPrice }, { poLineId: chairLine, quantity: 3, unitPrice: chairPrice + 100 }] }).expect(201)).body;
      expect(inv).toMatchObject({ matchStatus: 'VARIANCE', currency: 'KES', exchangeRate: 1, whtTotal: 2_250 });
      expect(inv.variances[0].message).toContain('+300 on the line');
      expect(inv.baseTotal).toBe(inv.total);
      await setting('purchasing.matchPriceToleranceAbs', 500);
      expect((await c.accountant.post(`/invoices/${inv.id}/rematch`).expect(200)).body.matchStatus).toBe('MATCHED');
      ids.invoice = inv.id;
    });

    it('a matched invoice can be approved without the workflow (setting); budget actuals in base currency', async () => {
      await setting('purchasing.autoApproveMatchedInvoices', true);
      const res = (await c.accountant.post(`/invoices/${ids.invoice}/submit`).expect(200)).body;
      expect(res).toMatchObject({ status: 'APPROVED', lastComment: expect.stringMatching(/automatically/) });
      expect(await one(`SELECT COUNT(*)::int AS n FROM approval_request WHERE document_id = $1`, [ids.invoice])).toEqual({ n: 0 });
      const actual = await one(`SELECT SUM(amount)::float AS v FROM budget_entry WHERE source_doc_id = $1 AND entry_type = 'ACTUAL'`, [ids.invoice]);
      expect(actual.v).toBe(res.baseTotal);
      // Not everything is received yet, so the order is not INVOICED.
      expect((await c['proc.officer'].get(`/purchase-orders/${po.id}`).expect(200)).body.status).toBe('PARTIALLY_RECEIVED');
    });

    it('the rest is accepted by the department in-charge; once invoiced in full the order is INVOICED', async () => {
      const cert = (await c.storekeeper.post('/service-certificates', { purchaseOrderId: po.id, periodTo: day(), workDone: 'Replacement locker', lines: [{ poLineId: chairLine, quantity: 1 }] }).expect(201)).body;
      await c['ward.incharge'].post(`/service-certificates/${cert.id}/accept`).expect(200);
      expect((await c['proc.officer'].get(`/purchase-orders/${po.id}`).expect(200)).body.status).toBe('RECEIVED');
      const chairPrice = po.lines.find((l) => l.id === chairLine)!.unitPrice;
      const inv = (await c.accountant.post('/invoices', { purchaseOrderId: po.id, supplierInvoiceNo: uniq('SI'), invoiceDate: day(), lines: [{ poLineId: chairLine, quantity: 1, unitPrice: chairPrice }] }).expect(201)).body;
      expect(inv.matchStatus).toBe('MATCHED');
      await c.accountant.post(`/invoices/${inv.id}/submit`).expect(200);
      expect((await c['proc.officer'].get(`/purchase-orders/${po.id}`).expect(200)).body.status).toBe('INVOICED');
      await setting('purchasing.autoApproveMatchedInvoices', false);
    });

    it('hands the lockers over: in the app, and at the counter with a one-time code; the requisition closes', async () => {
      const tooMany = await c['proc.officer'].post('/handovers', { requisitionId: reqId, lines: [{ requisitionLineId: (await one(`SELECT id FROM staff_requisition_line WHERE requisition_id = $1 AND line_type = 'NON_STOCK_GOODS'`, [reqId])).id, quantity: 5 }] }).expect(400);
      expect(tooMany.body.code).toBe('NOT_RECEIVED');
      const lockerLine = (await one(`SELECT id FROM staff_requisition_line WHERE requisition_id = $1 AND line_type = 'NON_STOCK_GOODS'`, [reqId])).id;
      await c['ward.nurse'].post('/handovers', { requisitionId: reqId, lines: [{ requisitionLineId: lockerLine, quantity: 1 }] }).expect(403); // no handover permission

      const h1 = (await c['proc.officer'].post('/handovers', { requisitionId: reqId, condition: 'GOOD', notes: 'Delivered to the ward', lines: [{ requisitionLineId: lockerLine, quantity: 2 }] }).expect(201)).body;
      expect(h1).toMatchObject({ status: 'PENDING', receivedByName: 'Moraa Nurse' });
      expect(await notes('ward.nurse', `${reqNo}: ready for collection`)).toHaveLength(1);
      await c['proc.officer'].post(`/handovers/${h1.id}/acknowledge`, {}).expect(403);
      const ack = (await c['ward.nurse'].post(`/handovers/${h1.id}/acknowledge`, { comment: 'Received in good order' }).expect(200)).body;
      expect(ack).toMatchObject({ status: 'ACKNOWLEDGED', ackChannel: 'IN_APP' });
      expect((await c['ward.nurse'].get('/handovers?mine=true&status=PENDING').expect(200)).body).toHaveLength(0);

      const h2 = (await c.storekeeper.post('/handovers', { requisitionId: reqId, lines: [{ requisitionLineId: lockerLine, quantity: 2 }] }).expect(201)).body;
      await c.storekeeper.post(`/handovers/${h2.id}/otp/verify`, { code: '123456' }).expect(400); // no code requested
      await c.storekeeper.post(`/handovers/${h2.id}/otp`).expect(200);
      const [sent] = await notes('ward.nurse', `${h2.number}: your collection code`);
      const code = /code (\d{6})/.exec(sent.body)![1];
      expect(JSON.stringify(await one(`SELECT * FROM handover WHERE id = $1`, [h2.id]))).not.toContain(code);
      const wrong = await c.storekeeper.post(`/handovers/${h2.id}/otp/verify`, { code: code === '000000' ? '111111' : '000000' }).expect(400);
      expect(wrong.body.code).toBe('WRONG_CODE');
      const done = (await c.storekeeper.post(`/handovers/${h2.id}/otp/verify`, { code }).expect(200)).body;
      expect(done).toMatchObject({ status: 'ACKNOWLEDGED', ackChannel: 'OTP' });

      const req = (await c['ward.nurse'].get(`/staff-requisitions/${reqId}`).expect(200)).body;
      expect(req.status).toBe('CLOSED');
      expect(req.lines.every((l: { status: string }) => l.status === 'DELIVERED')).toBe(true);
      expect(await notes('ward.nurse', `${reqNo}: delivered and closed`)).toHaveLength(1);
      expect(await stockFootprint()).toEqual(before);
    });

    it('the document chain runs from the requisition to the hand-overs', async () => {
      const chain = (await c['proc.officer'].get(`/documents/chain?type=REQ&id=${reqId}`).expect(200)).body;
      expect(chain.nodes.map((n: { type: string }) => n.type)).toEqual(expect.arrayContaining(['REQ', 'PR', 'PO', 'SCC', 'INV', 'HOV']));
    });
  });

  describe('one-time code limits', () => {
    it('too many wrong codes, or an expired code, need a new code', async () => {
      await setting('requisitions.handoverOtpMaxAttempts', 2);
      const r = (await c['ward.nurse'].post('/staff-requisitions', { departmentId: ids.IPD_MED, justification: 'OTP limits', submit: true, lines: [{ lineType: 'NON_STOCK_GOODS', description: 'Notice board', quantity: 1, uomId: ids.pcs, estimatedUnitCost: 3_000 }] }).expect(201)).body;
      await approveAll(r.id);
      // Received as if accepted (the receipt path is covered above).
      await q(`UPDATE staff_requisition_line SET received_qty = 1 WHERE requisition_id = $1`, [r.id]);
      const line = (await one(`SELECT id FROM staff_requisition_line WHERE requisition_id = $1`, [r.id])).id;
      const h = (await c.storekeeper.post('/handovers', { requisitionId: r.id, lines: [{ requisitionLineId: line, quantity: 1 }] }).expect(201)).body;
      await c.storekeeper.post(`/handovers/${h.id}/otp`).expect(200);
      const [sent] = await notes('ward.nurse', `${h.number}: your collection code`);
      const code = /code (\d{6})/.exec(sent.body)![1];
      const bad = code === '000000' ? '111111' : '000000';
      await c.storekeeper.post(`/handovers/${h.id}/otp/verify`, { code: bad }).expect(400);
      await c.storekeeper.post(`/handovers/${h.id}/otp/verify`, { code: bad }).expect(400);
      await c.storekeeper.post(`/handovers/${h.id}/otp/verify`, { code }).expect(410); // locked out
      await c.storekeeper.post(`/handovers/${h.id}/otp`).expect(200);
      await q(`UPDATE handover SET otp_expires_at = now() - interval '1 minute' WHERE id = $1`, [h.id]);
      await c.storekeeper.post(`/handovers/${h.id}/otp/verify`, { code: '123456' }).expect(410);
      await setting('requisitions.handoverOtpMaxAttempts', 5);
    });
  });

  describe('stock lines', () => {
    it('are delivered when the store issues them in full; a stock-only requisition then closes', async () => {
      const r = (await c['ward.nurse'].post('/staff-requisitions', { departmentId: ids.IPD_MED, storeId: ids.MS, justification: 'Ward stock', submit: true, lines: [{ lineType: 'STOCK', itemId: ids.stockItem, quantity: 2 }] }).expect(201)).body;
      await approveAll(r.id);
      const req = (await c['ward.nurse'].get(`/staff-requisitions/${r.id}`).expect(200)).body;
      expect(req.status).toBe('CONVERTED');
      const srId = req.lines[0].storeRequisition.id;
      await c.storekeeper.post(`/store-requisitions/${srId}/issues`, { collectedBy: 'Nurse Moraa' }).expect(201);
      const after = (await c['ward.nurse'].get(`/staff-requisitions/${r.id}`).expect(200)).body;
      expect(after).toMatchObject({ status: 'CLOSED', lines: [expect.objectContaining({ status: 'DELIVERED', deliveredQty: 2 })] });
    });
  });
});
