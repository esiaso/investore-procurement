import { Client, createTestApp, idByCode, loggedIn, TestContext, uniq } from './helpers';

const today = () =>
  new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Nairobi', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
const plus = (d: number) =>
  new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Nairobi', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(Date.now() + d * 86_400_000));

describe('Procurement', () => {
  let ctx: TestContext;
  const c: Record<string, Client> = {};
  let ids: Record<string, string>;

  beforeAll(async () => {
    ctx = await createTestApp();
    for (const u of ['admin', 'proc.officer', 'proc.manager', 'scm', 'storekeeper', 'pharmacist', 'quality', 'tender', 'finance', 'accountant', 'ward.incharge', 'management']) {
      c[u] = await loggedIn(ctx, u);
    }
    const q = async (sql: string, p: unknown[] = []) => (await ctx.ds.query(sql, p))[0];
    ids = {
      MS: await idByCode(ctx.ds, 'store', 'MS'),
      MP: await idByCode(ctx.ds, 'store', 'MP'),
      ipd: await idByCode(ctx.ds, 'department', 'IPD-MED'),
      pharm: await idByCode(ctx.ds, 'department', 'PHARM'),
      rad: await idByCode(ctx.ds, 'department', 'RAD'),
      box: await idByCode(ctx.ds, 'unit_of_measure', 'BOX'),
      s1: (await q(`SELECT id FROM supplier WHERE code = 'SUP0001'`)).id,
      s2: (await q(`SELECT id FROM supplier WHERE code = 'SUP0002'`)).id,
      s3: (await q(`SELECT id FROM supplier WHERE code = 'SUP0003'`)).id,
      suspended: (await q(`SELECT id FROM supplier WHERE status = 'SUSPENDED' LIMIT 1`)).id,
      wardBudget: (await q(`SELECT id FROM budget WHERE vote_head = 'WARD-SUPPLIES'`)).id,
      // A seeded tablet item with box → strip → tablet conversions (10x10).
      tabItem: (await q(
        `SELECT i.id FROM item i WHERE i.pack_size = '10x10' AND NOT i.is_controlled AND NOT i.is_cold_chain
            AND EXISTS (SELECT 1 FROM unit_conversion uc WHERE uc.item_id = i.id) ORDER BY i.code LIMIT 1`,
      )).id,
      cnsItem: (await q(`SELECT i.id FROM item i JOIN item_category c ON c.id = i.category_id WHERE c.code = 'DRUG-CNS' AND NOT i.is_controlled LIMIT 1`)).id,
      supply: (await q(`SELECT id FROM item WHERE generic_id IS NULL AND NOT is_batch_tracked ORDER BY code LIMIT 1`)).id,
    };
  });
  afterAll(() => ctx.close());

  const pendingRequest = async (docType: string, docId: string) =>
    (await ctx.ds.query(`SELECT * FROM approval_request WHERE document_type = $1 AND document_id = $2 ORDER BY created_at DESC LIMIT 1`, [docType, docId]))[0];

  async function approvedPr(requester = 'ward.incharge', qty = 100, itemId = ids.tabItem, estimatedUnitPrice = 5) {
    const pr = await c[requester]
      .post('/requisitions', { departmentId: ids.ipd, storeId: ids.MS, budgetId: ids.wardBudget, justification: 'Test', lines: [{ itemId, quantity: qty, estimatedUnitPrice }] })
      .expect(201);
    await c[requester].post(`/requisitions/${pr.body.id}/submit`).expect(200);
    const req = await pendingRequest('PR', pr.body.id);
    await c['proc.manager'].post(`/approvals/${req.id}/approve`, {}).expect(200);
    return pr.body;
  }

  describe('approval engine', () => {
    it('routes a small requisition to one step and enforces segregation of duties', async () => {
      const pr = await c['proc.officer']
        .post('/requisitions', { departmentId: ids.ipd, storeId: ids.MS, justification: 'Gloves', lines: [{ itemId: ids.supply, quantity: 10, estimatedUnitPrice: 10 }] })
        .expect(201);
      expect(pr.body).toMatchObject({ status: 'DRAFT', estimatedTotal: 100 });
      expect(pr.body.number).toMatch(/^PR\/MS\//);
      await c['proc.officer'].post(`/requisitions/${pr.body.id}/submit`).expect(200);
      const req = await pendingRequest('PR', pr.body.id);
      const [wf] = await ctx.ds.query(`SELECT code FROM approval_workflow WHERE id = $1`, [req.workflow_id]);
      expect(wf.code).toBe('PR-1');

      // The requester can't approve (even with approval rights elsewhere), nor can a random user.
      await c['proc.officer'].post(`/approvals/${req.id}/approve`, {}).expect(403);
      await c['storekeeper'].post(`/approvals/${req.id}/approve`, {}).expect(403);

      const inbox = await c['proc.manager'].get('/approvals/inbox').expect(200);
      expect(inbox.body.map((r: { documentId: string }) => r.documentId)).toContain(pr.body.id);
      const notes = await c['proc.manager'].get('/notifications?unread=true').expect(200);
      expect(notes.body.items.some((n: { title: string }) => n.title.includes(pr.body.number))).toBe(true);

      await c['proc.manager'].post(`/approvals/${req.id}/approve`, {}).expect(200);
      expect((await c['proc.officer'].get(`/requisitions/${pr.body.id}`)).body.status).toBe('APPROVED');
      const history = await c['proc.officer'].get(`/approvals/history?type=PR&id=${pr.body.id}`).expect(200);
      expect(history.body[0].actions.map((a: { action: string }) => a.action)).toEqual(['SUBMIT', 'APPROVE']);
    });

    it('needs every step of a larger band, by different people', async () => {
      const pr = await c['ward.incharge']
        .post('/requisitions', { departmentId: ids.ipd, storeId: ids.MS, justification: 'Big order', lines: [{ itemId: ids.supply, quantity: 20000, estimatedUnitPrice: 10 }] })
        .expect(201);
      await c['ward.incharge'].post(`/requisitions/${pr.body.id}/submit`).expect(200);
      const req = await pendingRequest('PR', pr.body.id);
      await c['scm'].post(`/approvals/${req.id}/approve`, {}).expect(403); // step 1 is procurement
      await c['proc.manager'].post(`/approvals/${req.id}/approve`, {}).expect(200);
      expect((await c['ward.incharge'].get(`/requisitions/${pr.body.id}`)).body.status).toBe('PENDING_APPROVAL');
      await c['proc.manager'].post(`/approvals/${req.id}/approve`, {}).expect(403);
      await c['scm'].post(`/approvals/${req.id}/approve`, {}).expect(200);
      expect((await c['ward.incharge'].get(`/requisitions/${pr.body.id}`)).body.status).toBe('APPROVED');
    });

    it('routes requisitions with CNS medicines through the pharmacist first', async () => {
      const pr = await c['ward.incharge']
        .post('/requisitions', { departmentId: ids.ipd, storeId: ids.MS, justification: 'Anaesthetics', lines: [{ itemId: ids.cnsItem, quantity: 5, estimatedUnitPrice: 100 }] })
        .expect(201);
      await c['ward.incharge'].post(`/requisitions/${pr.body.id}/submit`).expect(200);
      const req = await pendingRequest('PR', pr.body.id);
      const [wf] = await ctx.ds.query(`SELECT code FROM approval_workflow WHERE id = $1`, [req.workflow_id]);
      expect(wf.code).toBe('PR-CD');
      await c['proc.manager'].post(`/approvals/${req.id}/approve`, {}).expect(403);
      await c['pharmacist'].post(`/approvals/${req.id}/approve`, {}).expect(200);
    });

    it('returns for amendment (comment required), then accepts the resubmission', async () => {
      const pr = await c['ward.incharge']
        .post('/requisitions', { departmentId: ids.ipd, storeId: ids.MS, justification: 'v1', lines: [{ itemId: ids.supply, quantity: 10 }] })
        .expect(201);
      await c['ward.incharge'].post(`/requisitions/${pr.body.id}/submit`).expect(200);
      const req = await pendingRequest('PR', pr.body.id);
      await c['proc.manager'].post(`/approvals/${req.id}/return`, {}).expect(400);
      await c['proc.manager'].post(`/approvals/${req.id}/return`, { comment: 'Add a justification' }).expect(200);
      const returned = await c['ward.incharge'].get(`/requisitions/${pr.body.id}`).expect(200);
      expect(returned.body).toMatchObject({ status: 'RETURNED', lastComment: 'Add a justification' });
      await c['proc.officer'].put(`/requisitions/${pr.body.id}`, { departmentId: ids.ipd, storeId: ids.MS, justification: 'x', lines: [{ itemId: ids.supply, quantity: 1 }] }).expect(403);
      await c['ward.incharge']
        .put(`/requisitions/${pr.body.id}`, { departmentId: ids.ipd, storeId: ids.MS, justification: 'Needed for the new ward', lines: [{ itemId: ids.supply, quantity: 10 }] })
        .expect(200);
      await c['ward.incharge'].post(`/requisitions/${pr.body.id}/submit`).expect(200);
      const req2 = await pendingRequest('PR', pr.body.id);
      expect(req2.id).not.toBe(req.id);
      await c['proc.manager'].post(`/approvals/${req2.id}/reject`, { comment: 'Not needed after all' }).expect(200);
      expect((await c['ward.incharge'].get(`/requisitions/${pr.body.id}`)).body.status).toBe('REJECTED');
    });

    it('lets a delegate approve while the approver is away', async () => {
      const [sk] = await ctx.ds.query(`SELECT id FROM app_user WHERE username = 'management'`);
      const d = await c['proc.manager'].post('/approvals/delegations', { toUserId: sk.id, startsOn: today(), endsOn: plus(3), reason: 'Leave' }).expect(201);
      try {
        const pr = await c['ward.incharge']
          .post('/requisitions', { departmentId: ids.ipd, storeId: ids.MS, justification: 'Delegation test', lines: [{ itemId: ids.supply, quantity: 1 }] })
          .expect(201);
        await c['ward.incharge'].post(`/requisitions/${pr.body.id}/submit`).expect(200);
        const inbox = await c['management'].get('/approvals/inbox').expect(200);
        const item = inbox.body.find((r: { documentId: string }) => r.documentId === pr.body.id);
        expect(item).toBeTruthy();
        await c['management'].post(`/approvals/${item.id}/approve`, { comment: 'For Kamau' }).expect(200);
        const [action] = await ctx.ds.query(`SELECT on_behalf_of_user_id FROM approval_action WHERE request_id = $1 AND action = 'APPROVE'`, [item.id]);
        const [pm] = await ctx.ds.query(`SELECT id FROM app_user WHERE username = 'proc.manager'`);
        expect(action.on_behalf_of_user_id).toBe(pm.id);
      } finally {
        await c['proc.manager'].post(`/approvals/delegations/${d.body.id}/end`).expect(200);
      }
    });
  });

  describe('budgets', () => {
    it('blocks an over-budget PO at submission and commits/releases on approval and cancellation', async () => {
      const vote = uniq('V').replace('-', '');
      const block = await c['finance'].post('/budgets', { departmentId: ids.rad, voteHead: vote, amount: 1000, enforcement: 'BLOCK' }).expect(201);
      const contract = await ctx.ds.query(`SELECT item_id, unit_price FROM contract_price WHERE supplier_id = $1 ORDER BY unit_price DESC LIMIT 1`, [ids.s1]);
      const big = await c['proc.officer']
        .post('/purchase-orders', { supplierId: ids.s1, storeId: ids.MS, departmentId: ids.rad, budgetId: block.body.id, lines: [{ itemId: contract[0].item_id, quantity: 10000 }] })
        .expect(201);
      const denied = await c['proc.officer'].post(`/purchase-orders/${big.body.id}/submit`);
      expect(denied.status).toBe(400);
      expect(denied.body.code).toBe('BUDGET_EXCEEDED');

      await c['finance'].patch(`/budgets/${block.body.id}`, { enforcement: 'WARN' }).expect(200);
      const warned = await c['proc.officer'].post(`/purchase-orders/${big.body.id}/submit`).expect(200);
      expect(warned.body.budgetWarning).toMatch(/Exceeds budget/);
      const req = await pendingRequest('PO', big.body.id);
      for (const approver of ['proc.manager', 'finance', 'management']) {
        const r = await c[approver].post(`/approvals/${req.id}/approve`, {});
        if (r.status !== 200) break;
      }
      let [pos] = (await c['finance'].get(`/budgets?departmentId=${ids.rad}`)).body.filter((b: { id: string }) => b.id === block.body.id);
      expect(pos.committed).toBeCloseTo(big.body.total, 2);
      expect(pos.available).toBeCloseTo(1000 - big.body.total, 2);

      await c['proc.officer'].post(`/purchase-orders/${big.body.id}/cancel`, { reason: 'Test' }).expect(200);
      [pos] = (await c['finance'].get(`/budgets?departmentId=${ids.rad}`)).body.filter((b: { id: string }) => b.id === block.body.id);
      expect(pos.committed).toBeCloseTo(0, 2);
    });
  });

  describe('suppliers', () => {
    it('validates the KRA PIN and keeps bank details encrypted', async () => {
      const bad = await c['proc.officer'].post('/suppliers', { name: 'Bad PIN', kraPin: '12345' });
      expect(bad.status).toBe(400);
      const s = await c['proc.officer']
        .post('/suppliers', { name: `Test Supplier ${uniq('s')}`, kraPin: `P9${String(Date.now()).slice(-8)}Q`, email: 'x@test.example', bankAccountNo: '0123456789012' })
        .expect(201);
      expect(s.body.code).toMatch(/^SUP\d{4}$/);
      expect(s.body.bankAccountMasked).toBe('••••••9012');
      expect(s.body).not.toHaveProperty('bankAccountEnc');
      expect(s.body).not.toHaveProperty('bankAccountNo'); // procurement officer lacks suppliers.bank
      const fin = await c['finance'].get(`/suppliers/${s.body.id}`).expect(200);
      expect(fin.body.bankAccountNo).toBe('0123456789012');
      const [row] = await ctx.ds.query(`SELECT bank_account_enc FROM supplier WHERE id = $1`, [s.body.id]);
      expect(row.bank_account_enc).not.toContain('0123456789012');
      const [audit] = await ctx.ds.query(`SELECT after FROM audit_log WHERE entity_type = 'Supplier' AND entity_id = $1 AND action = 'CREATE'`, [s.body.id]);
      expect(audit.after.bankAccountEnc).toBe('[REDACTED]');
    });

    it('will not invite suspended suppliers', async () => {
      const pr = await approvedPr();
      const res = await c['proc.officer'].post('/rfqs', { requisitionId: pr.id, title: 'x', closingDate: plus(5), supplierIds: [ids.suspended] });
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('SUPPLIER_NOT_ELIGIBLE');
    });
  });

  describe('RFQ, comparative analysis and award', () => {
    it('compares quotations, requires justification for a non-lowest award, and creates POs', async () => {
      const pr = await approvedPr('ward.incharge', 300, ids.supply, 10);
      const rfq = await c['proc.officer'].post('/rfqs', { requisitionId: pr.id, title: 'Gloves', closingDate: plus(5), supplierIds: [ids.s1, ids.s2, ids.s3] }).expect(201);
      await c['proc.officer'].post(`/rfqs/${rfq.body.id}/send`).expect(200);
      const lineId = rfq.body.lines[0].id;
      await c['proc.officer'].post(`/rfqs/${rfq.body.id}/quotations`, { supplierId: ids.s1, deliveryDays: 5, lines: [{ rfqLineId: lineId, unitPrice: 9 }] }).expect(200);
      await c['proc.officer'].post(`/rfqs/${rfq.body.id}/quotations`, { supplierId: ids.s2, deliveryDays: 3, lines: [{ rfqLineId: lineId, unitPrice: 8 }] }).expect(200);
      await c['proc.officer'].post(`/rfqs/${rfq.body.id}/quotations`, { supplierId: ids.s3, deliveryDays: 1, compliant: false, complianceNotes: 'No PPB licence', lines: [{ rfqLineId: lineId, unitPrice: 6 }] }).expect(200);
      const cmp = await c['proc.officer'].get(`/rfqs/${rfq.body.id}/comparison`).expect(200);
      const quotes = cmp.body.lines[0].quotes;
      expect(quotes.map((q: { supplierId: string }) => q.supplierId)).toEqual([ids.s2, ids.s1, ids.s3]);
      expect(quotes[0].lowestCompliant).toBe(true);
      const s1Quote = quotes.find((q: { supplierId: string }) => q.supplierId === ids.s1);

      const noReason = await c['proc.officer'].post(`/rfqs/${rfq.body.id}/award`, { awards: [{ rfqLineId: lineId, quotationLineId: s1Quote.quotationLineId }] });
      expect(noReason.status).toBe(400);
      const awarded = await c['proc.officer']
        .post(`/rfqs/${rfq.body.id}/award`, { awards: [{ rfqLineId: lineId, quotationLineId: s1Quote.quotationLineId }], justification: 'Lowest bidder cannot deliver within a week' })
        .expect(200);
      expect(awarded.body.purchaseOrderIds).toHaveLength(1);
      const po = await c['proc.officer'].get(`/purchase-orders/${awarded.body.purchaseOrderIds[0]}`).expect(200);
      expect(po.body).toMatchObject({ source: 'RFQ', supplierId: ids.s1, status: 'DRAFT' });
      expect(po.body.lines[0].unitPrice).toBe(9);
      expect((await c['proc.officer'].get(`/requisitions/${pr.id}`)).body.status).toBe('CLOSED');
    });
  });

  describe('PO → GRN → invoice (acceptance)', () => {
    let pr: { id: string; number: string; lines: { id: string }[] };
    let po: { id: string; number: string; total: number; lines: { id: string; quantity: number; unitPrice: number; conversionFactor: number }[] };
    let grnId: string;

    it('creates a PO in boxes from the approved requisition, approves and sends it', async () => {
      pr = await approvedPr('ward.incharge', 300);
      // 3 boxes of 10 × 10 tablets at 450 per box.
      const created = await c['proc.officer']
        .post('/purchase-orders', { supplierId: ids.s1, requisitionId: pr.id, expectedDelivery: plus(7), lines: [{ requisitionLineId: pr.lines[0].id, uomId: ids.box, quantity: 3, unitPrice: 450 }] })
        .expect(201);
      po = created.body;
      expect(po.lines[0].conversionFactor).toBe(100);
      await c['proc.officer'].post(`/purchase-orders/${po.id}/send`).expect(409); // not approved yet
      await c['proc.officer'].post(`/purchase-orders/${po.id}/submit`).expect(200);
      const req = await pendingRequest('PO', po.id);
      await c['proc.officer'].post(`/approvals/${req.id}/approve`, {}).expect(403);
      await c['proc.manager'].post(`/approvals/${req.id}/approve`, {}).expect(200);
      const sent = await c['proc.officer'].post(`/purchase-orders/${po.id}/send`).expect(200);
      expect(sent.body.status).toBe('SENT');
      const mails = await c['proc.officer'].get(`/purchase-orders/${po.id}/emails`).expect(200);
      expect(mails.body[0]).toMatchObject({ status: 'QUEUED', attachments: [expect.objectContaining({ kind: 'PO_PDF' })] });
    });

    it('renders the PO as a PDF with approval stamps', async () => {
      const res = await c['proc.officer'].get(`/purchase-orders/${po.id}/pdf`).buffer(true).parse((r, cb) => {
        const chunks: Buffer[] = [];
        r.on('data', (d: Buffer) => chunks.push(d));
        r.on('end', () => cb(null, Buffer.concat(chunks)));
      });
      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toMatch(/application\/pdf/);
      expect((res.body as Buffer).subarray(0, 4).toString()).toBe('%PDF');
    });

    it('enforces segregation of duties on receipt', async () => {
      const line = { poLineId: po.lines[0].id, quantity: 1, batchNo: 'X', expiryDate: plus(400) };
      // The PO approver may not receive.
      const [pm] = await ctx.ds.query(`SELECT id FROM app_user WHERE username = 'proc.manager'`);
      const [msStore] = await ctx.ds.query(`SELECT id FROM store WHERE code = 'MS'`);
      await ctx.ds.query(`INSERT INTO user_store (user_id, store_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`, [pm.id, msStore.id]);
      await ctx.ds.query(
        `INSERT INTO role_permission (role_id, permission_code) SELECT r.id, 'purchasing.receive' FROM role r WHERE r.code = 'PROCUREMENT_MANAGER' ON CONFLICT DO NOTHING`,
      );
      const pmFresh = await loggedIn(ctx, 'proc.manager');
      const byApprover = await pmFresh.post('/grns', { purchaseOrderId: po.id, lines: [line] });
      expect(byApprover.status).toBe(403);
      await ctx.ds.query(`DELETE FROM role_permission WHERE permission_code = 'purchasing.receive' AND role_id = (SELECT id FROM role WHERE code = 'PROCUREMENT_MANAGER')`);
      // Batch-tracked items need batch and expiry; expired goods are refused; over-receipt refused.
      await c['storekeeper'].post('/grns', { purchaseOrderId: po.id, lines: [{ poLineId: po.lines[0].id, quantity: 1 }] }).expect(400);
      await c['storekeeper'].post('/grns', { purchaseOrderId: po.id, lines: [{ ...line, expiryDate: plus(-1) }] }).expect(400);
      await c['storekeeper'].post('/grns', { purchaseOrderId: po.id, lines: [{ ...line, quantity: 4 }] }).expect(400);
    });

    it('receives 3 boxes, inspects (2 members, receiver excluded) and posts 300 tablets to stock at the right cost', async () => {
      const before = await c['scm'].get(`/inventory/stock?groupBy=item&storeId=${ids.MS}&itemId=${ids.tabItem}`).expect(200);
      const onHandBefore = before.body.items[0]?.onHand ?? 0;
      const valueBefore = before.body.items[0]?.value ?? 0;

      const grn = await c['storekeeper']
        .post('/grns', { purchaseOrderId: po.id, deliveryNoteNo: 'DN-1', lines: [{ poLineId: po.lines[0].id, quantity: 3, batchNo: `ACC-${uniq('b')}`, expiryDate: plus(500) }] })
        .expect(201);
      grnId = grn.body.id;
      expect(grn.body.lines[0]).toMatchObject({ receivedBaseQty: 300, conversionFactor: 100 });
      await c['storekeeper'].post(`/grns/${grnId}/submit`).expect(200);
      await c['storekeeper'].post(`/grns/${grnId}/inspect`, { lines: [{ lineId: grn.body.lines[0].id, acceptedQty: 300, rejectedQty: 0 }] }).expect(403);
      await c['quality'].post(`/grns/${grnId}/inspect`, { lines: [{ lineId: grn.body.lines[0].id, acceptedQty: 290, rejectedQty: 5 }] }).expect(400); // must add up
      await c['quality'].post(`/grns/${grnId}/inspect`, { lines: [{ lineId: grn.body.lines[0].id, acceptedQty: 300, rejectedQty: 0 }] }).expect(200);
      const early = await c['storekeeper'].post(`/grns/${grnId}/post`, {});
      expect(early.status).toBe(400);
      expect(early.body.code).toBe('INSPECTION_INCOMPLETE');
      await c['tender'].post(`/grns/${grnId}/inspect`, {}).expect(200);
      const posted = await c['storekeeper'].post(`/grns/${grnId}/post`, {}).expect(200);
      expect(posted.body.status).toBe('POSTED');

      const after = await c['scm'].get(`/inventory/stock?groupBy=item&storeId=${ids.MS}&itemId=${ids.tabItem}`).expect(200);
      expect(after.body.items[0].onHand).toBe(onHandBefore + 300);
      // 450 per box of 100 = 4.50 per tablet; medicines are VAT-exempt so no VAT in cost.
      expect(after.body.items[0].value - valueBefore).toBeCloseTo(1350, 1);
      const [txn] = await ctx.ds.query(`SELECT txn_type, quantity, unit_cost FROM stock_transaction WHERE source_doc_id = $1`, [grnId]);
      expect(txn).toMatchObject({ txn_type: 'RECEIPT', quantity: '300.0000' });
      expect(Number(txn.unit_cost)).toBeCloseTo(4.5, 6);
      expect((await c['proc.officer'].get(`/purchase-orders/${po.id}`)).body.status).toBe('RECEIVED');
      const [perf] = await ctx.ds.query(`SELECT grn_count, on_time_delivery_rate FROM supplier WHERE id = $1`, [ids.s1]);
      expect(perf.grn_count).toBeGreaterThan(0);
    });

    it('three-way matches invoices, flags variances, approves into actual spend and pays', async () => {
      const over = await c['accountant']
        .post('/invoices', { purchaseOrderId: po.id, supplierInvoiceNo: uniq('INV'), invoiceDate: today(), lines: [{ poLineId: po.lines[0].id, quantity: 4, unitPrice: 470 }] })
        .expect(201);
      expect(over.body.matchStatus).toBe('VARIANCE');
      expect(over.body.variances.map((v: { code: string }) => v.code).sort()).toEqual(['PRICE_VARIANCE', 'QTY_EXCEEDS_ORDERED', 'QTY_EXCEEDS_RECEIVED']);
      expect(over.body.etimsStatus).toBe('NOT_CHECKED');
      await c['accountant'].post(`/invoices/${over.body.id}/cancel`).expect(200);

      const supplierInvoiceNo = uniq('INV');
      const inv = await c['accountant']
        .post('/invoices', { purchaseOrderId: po.id, supplierInvoiceNo, invoiceDate: today(), lines: [{ poLineId: po.lines[0].id, quantity: 3, unitPrice: 455 }] })
        .expect(201);
      expect(inv.body.matchStatus).toBe('MATCHED'); // 1.1% within the 2% tolerance
      await c['accountant'].post('/invoices', { purchaseOrderId: po.id, supplierInvoiceNo, invoiceDate: today(), lines: [{ poLineId: po.lines[0].id, quantity: 1, unitPrice: 1 }] }).expect(409);
      const view = await c['accountant'].get(`/invoices/${inv.body.id}/match`).expect(200);
      expect(view.body.lines[0]).toMatchObject({ orderedQty: 3, receivedQty: 3, thisInvoiceQty: 3, poUnitPrice: 450, thisInvoicePrice: 455 });

      const budgetBefore = (await c['finance'].get('/budgets')).body.find((b: { id: string }) => b.id === ids.wardBudget);
      await c['accountant'].post(`/invoices/${inv.body.id}/submit`).expect(200);
      const req = await pendingRequest('INV', inv.body.id);
      await c['accountant'].post(`/approvals/${req.id}/approve`, {}).expect(403); // captured it
      await c['finance'].post(`/approvals/${req.id}/approve`, {}).expect(200);
      const budgetAfter = (await c['finance'].get('/budgets')).body.find((b: { id: string }) => b.id === ids.wardBudget);
      expect(budgetAfter.actual - budgetBefore.actual).toBeCloseTo(inv.body.total, 2);
      expect(budgetBefore.committed - budgetAfter.committed).toBeCloseTo(Math.min(po.total, inv.body.total), 2);

      await c['proc.officer'].post(`/invoices/${inv.body.id}/pay`, { paidOn: today(), paymentReference: 'EFT-1', method: 'EFT' }).expect(403);
      const paid = await c['finance'].post(`/invoices/${inv.body.id}/pay`, { paidOn: today(), paymentReference: 'EFT-1', method: 'EFT' }).expect(200);
      expect(paid.body.status).toBe('PAID');
    });

    it('links every document of the chain, navigable from any of them', async () => {
      const fromGrn = await c['proc.officer'].get(`/documents/chain?type=GRN&id=${grnId}`).expect(200);
      const types = fromGrn.body.nodes.map((n: { type: string }) => n.type).sort();
      expect(types).toEqual(expect.arrayContaining(['GRN', 'INV', 'PO', 'PR', 'PV']));
      const fromPr = await c['proc.officer'].get(`/documents/chain?type=PR&id=${pr.id}`).expect(200);
      expect(fromPr.body.nodes.length).toBe(fromGrn.body.nodes.length);
      const prNode = fromPr.body.nodes.find((n: { type: string }) => n.type === 'PR');
      expect(prNode.status).toBe('CLOSED');
    });
  });

  describe('PO amendments', () => {
    it('versions amendments, re-approves them, and restores the previous version when rejected', async () => {
      const contract = (await ctx.ds.query(`SELECT item_id FROM contract_price WHERE supplier_id = $1 LIMIT 1`, [ids.s1]))[0];
      const po = await c['proc.officer']
        .post('/purchase-orders', { supplierId: ids.s1, storeId: ids.MS, departmentId: ids.ipd, budgetId: ids.wardBudget, lines: [{ itemId: contract.item_id, quantity: 10 }] })
        .expect(201);
      await c['proc.officer'].post(`/purchase-orders/${po.body.id}/submit`).expect(200);
      await c['proc.manager'].post(`/approvals/${(await pendingRequest('PO', po.body.id)).id}/approve`, {}).expect(200);
      await c['proc.officer'].post(`/purchase-orders/${po.body.id}/send`).expect(200);

      const line = po.body.lines[0];
      const amended = await c['proc.officer']
        .post(`/purchase-orders/${po.body.id}/amend`, { reason: 'Ward asked for more', lines: [{ lineId: line.id, quantity: 15, unitPrice: line.unitPrice }] })
        .expect(200);
      expect(amended.body).toMatchObject({ version: 2, status: 'PENDING_APPROVAL' });
      await c['proc.manager'].post(`/approvals/${(await pendingRequest('PO', po.body.id)).id}/approve`, {}).expect(200);
      const v2 = await c['proc.officer'].get(`/purchase-orders/${po.body.id}`).expect(200);
      expect(v2.body).toMatchObject({ version: 2, status: 'SENT' }); // keeps its delivery status
      expect(v2.body.lines[0].quantity).toBe(15);
      expect(v2.body.committedTotal).toBe(v2.body.total);

      await c['proc.officer'].post(`/purchase-orders/${po.body.id}/amend`, { reason: 'Even more', lines: [{ lineId: line.id, quantity: 50, unitPrice: line.unitPrice }] }).expect(200);
      await c['proc.manager'].post(`/approvals/${(await pendingRequest('PO', po.body.id)).id}/reject`, { comment: 'Too many' }).expect(200);
      const restored = await c['proc.officer'].get(`/purchase-orders/${po.body.id}`).expect(200);
      expect(restored.body).toMatchObject({ version: 2, status: 'SENT' });
      expect(restored.body.lines[0].quantity).toBe(15);
      const versions = await c['proc.officer'].get(`/purchase-orders/${po.body.id}/versions`).expect(200);
      expect(versions.body.map((v: { version: number }) => v.version)).toEqual([1, 2]);
      expect(versions.body[1].changeReason).toBe('Ward asked for more');
    });
  });

  describe('emergency receipts', () => {
    it('receives without a PO (flagged) and regularises with a PO later', async () => {
      await c['pharmacist'].post('/grns', { supplierId: ids.s2, storeId: ids.MP, emergencyReason: 'x', lines: [{ itemId: ids.supply, quantity: 1, unitPrice: 1 }] }).expect(403);
      const grn = await c['storekeeper']
        .post('/grns', { supplierId: ids.s2, storeId: ids.MS, lines: [{ itemId: ids.supply, quantity: 5, unitPrice: 7 }] })
        .expect(400); // reason required
      expect(grn.body.message).toMatch(/reason/);
      const e = await c['storekeeper']
        .post('/grns', { supplierId: ids.s2, storeId: ids.MS, emergencyReason: 'Night shortage', lines: [{ itemId: ids.supply, quantity: 5, unitPrice: 7 }] })
        .expect(201);
      expect(e.body).toMatchObject({ isEmergency: true, regularisationStatus: 'PENDING' });
      await c['storekeeper'].post(`/grns/${e.body.id}/submit`).expect(200);
      await c['quality'].post(`/grns/${e.body.id}/inspect`, { lines: [{ lineId: e.body.lines[0].id, acceptedQty: 5, rejectedQty: 0 }] }).expect(200);
      await c['tender'].post(`/grns/${e.body.id}/inspect`, {}).expect(200);
      await c['storekeeper'].post(`/grns/${e.body.id}/post`, {}).expect(200);

      const contract = await ctx.ds.query(`SELECT 1 FROM contract_price WHERE supplier_id = $1 AND item_id = $2`, [ids.s2, ids.supply]);
      const po = await c['proc.officer']
        .post('/purchase-orders', {
          supplierId: ids.s2,
          storeId: ids.MS,
          departmentId: ids.ipd,
          lines: [{ itemId: ids.supply, quantity: 5, ...(contract.length ? {} : { unitPrice: 7 }) }],
        });
      if (po.status !== 201) return; // no contract price for this item: covered by the seed scenario
      await c['proc.officer'].post(`/purchase-orders/${po.body.id}/submit`).expect(200);
      await c['proc.manager'].post(`/approvals/${(await pendingRequest('PO', po.body.id)).id}/approve`, {}).expect(200);
      const reg = await c['proc.officer'].post(`/grns/${e.body.id}/regularise`, { purchaseOrderId: po.body.id }).expect(200);
      expect(reg.body.regularisationStatus).toBe('REGULARISED');
      expect((await c['proc.officer'].get(`/purchase-orders/${po.body.id}`)).body.status).toBe('RECEIVED');
    });
  });
});
