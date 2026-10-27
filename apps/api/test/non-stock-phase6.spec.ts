import { sharedMockQbo as qbo } from '../src/modules/accounting/qbo';
import { SAMPLE_QBO_MAPPINGS } from '../src/database/seeds/sample-accounting';
import { sharedMockPayouts } from '../src/modules/payments/mpesa-payouts';
import { API, Client, createTestApp, idByCode, loggedIn, TestContext, uniq } from './helpers';

const day = (d = 0) =>
  new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Nairobi', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(Date.now() + d * 86_400_000));

type Posting = { id: string; docType: string; localDocType: string; localDocId: string; localDocNo: string | null; amount: number; status: string; error: string | null; externalId: string | null; syncToken: string | null; entries: { account: string; amount: number; classId?: string | null }[]; payload: Record<string, unknown> };
type Line = { Amount: number; AccountBasedExpenseLineDetail?: { AccountRef?: { value: string }; ClassRef?: { value: string } }; LinkedTxn?: { TxnId: unknown; TxnType: string; TxnLineId?: string }[]; JournalEntryLineDetail?: { PostingType: string; AccountRef: { value: string } } };

describe('Non-stock procurement phase 6: QuickBooks Online', () => {
  let ctx: TestContext;
  const c: Record<string, Client> = {};
  const ids: Record<string, string> = {};
  const today = day();
  const q = async (sql: string, p: unknown[] = []) => ctx.ds.query(sql, p);
  const one = async (sql: string, p: unknown[] = []) => (await q(sql, p))[0];
  const setting = (key: string, value: unknown) => q(`UPDATE system_setting SET value = $2::jsonb WHERE key = $1`, [key, JSON.stringify(value)]);
  const preview = async (kinds = ['PURCHASES', 'PETTY_CASH']) => (await c.finance.post('/accounting/batches', { from: today, to: today, kinds }).expect(201)).body as { id: string; items: Posting[] };
  const post = async (batchId: string) => (await c.finance.post(`/accounting/batches/${batchId}/post`).expect(200)).body as { items: Posting[]; totals: { posted: number; failed: number; retry: number } };
  const posting = async (docType: string, localDocId: string): Promise<Posting> => {
    const row = await one(`SELECT id FROM accounting_posting WHERE doc_type = $1 AND local_doc_id = $2`, [docType, localDocId]);
    return (await c.finance.get(`/accounting/postings/${row.id}`).expect(200)).body;
  };
  const find = (items: Posting[], docType: string, localDocId: string) => items.find((i) => i.docType === docType && i.localDocId === localDocId)!;
  const approveAs = async (docId: string, username: string) => {
    const ar = await one(`SELECT id FROM approval_request WHERE document_id = $1 AND status = 'PENDING'`, [docId]);
    if (!c[username]) c[username] = await loggedIn(ctx, username);
    await c[username].post(`/approvals/${ar.id}/approve`, {}).expect(200);
  };
  /** Approves whatever is pending on a document, by role. */
  const approveAll = async (docId: string) => {
    for (let i = 0; i < 4; i++) {
      const ar = await one(`SELECT id FROM approval_request WHERE document_id = $1 AND status = 'PENDING' ORDER BY created_at DESC LIMIT 1`, [docId]);
      if (!ar) return;
      const step = await one(`SELECT s.role_id, s.approver_type FROM approval_request r JOIN approval_step s ON s.workflow_id = r.workflow_id AND s.sequence = r.current_step WHERE r.id = $1`, [ar.id]);
      const who = await one(
        `SELECT u.username FROM user_role ur JOIN app_user u ON u.id = ur.user_id WHERE ur.role_id = $1 AND u.is_active
           AND u.id NOT IN (SELECT requested_by FROM approval_request WHERE id = $2) AND u.id NOT IN (SELECT user_id FROM approval_action WHERE request_id = $2 AND user_id IS NOT NULL)
           AND NOT (u.id = ANY(SELECT jsonb_array_elements_text(excluded_user_ids)::uuid FROM approval_request WHERE id = $2))
           AND ($3 <> 'DEPARTMENT_ROLE' OR u.department_id = (SELECT department_id FROM approval_request WHERE id = $2)) ORDER BY u.username LIMIT 1`,
        [step.role_id, ar.id, step.approver_type],
      );
      await approveAs(docId, who.username);
    }
  };

  /** QuickBooks rows point into the in-process mock company, which every QuickBooks spec resets: start and end clean. */
  const clearQbo = async () => {
    await q(`DELETE FROM accounting_posting`);
    await q(`DELETE FROM accounting_batch`);
    await q(`DELETE FROM account_mapping`);
    await q(`DELETE FROM accounting_external_ref`);
  };

  beforeAll(async () => {
    ctx = await createTestApp();
    qbo.reset();
    await clearQbo();
    sharedMockPayouts.reset();
    for (const u of ['admin', 'finance', 'finance.manager', 'accountant', 'ward.nurse', 'ward.incharge', 'proc.officer', 'storekeeper']) c[u] = await loggedIn(ctx, u);
    Object.assign(ids, {
      IPD_MED: await idByCode(ctx.ds, 'department', 'IPD-MED'),
      MS: await idByCode(ctx.ds, 'store', 'MS'),
      glRepairs: await idByCode(ctx.ds, 'gl_account', '5110'),
      glFurniture: await idByCode(ctx.ds, 'gl_account', '1600'),
      glOffice: await idByCode(ctx.ds, 'gl_account', '5100'),
      glTravel: await idByCode(ctx.ds, 'gl_account', '5600'),
      glPetty: await idByCode(ctx.ds, 'gl_account', '1020'),
      pcs: await idByCode(ctx.ds, 'unit_of_measure', 'PCS'),
      accountant: (await one(`SELECT id FROM app_user WHERE username = 'accountant'`)).id,
    });
    ids.supplier = (await one(`SELECT id, name FROM supplier WHERE status = 'ACTIVE' AND email IS NOT NULL ORDER BY code DESC LIMIT 1`)).id;
    // Connected to the mock company with the sample mappings.
    await c.finance.put('/accounting/connection', { provider: 'MOCK', redirectUri: `${API}/callbacks/quickbooks` }).expect(200);
    const { url } = (await c.finance.post('/accounting/connection/authorize').expect(200)).body;
    await c.finance.agent.get(url).expect(302);
    for (const [kind, localKey, externalId] of SAMPLE_QBO_MAPPINGS) await c.finance.put('/accounting/mappings', { kind, localKey, externalId }).expect(200);
    await setting('purchasing.autoApproveMatchedInvoices', true);
  });

  afterAll(async () => {
    await setting('purchasing.autoApproveMatchedInvoices', false);
    await setting('accounting.autoSync', false);
    await clearQbo();
    qbo.reset();
    await ctx.close();
  });

  describe('purchase order → bill → payment (WHT, M-PESA charges)', () => {
    let po: { id: string; number: string; lines: { id: string; lineType: string; quantity: number; unitPrice: number }[] };

    it('an approved LSO/LPO becomes a QuickBooks purchase order: non-stock lines on their GL account, cost-centre class', async () => {
      const req = (await c['ward.nurse'].post('/staff-requisitions', {
        departmentId: ids.IPD_MED,
        justification: 'Phase 6',
        submit: true,
        lines: [
          { lineType: 'SERVICE', description: 'Service the oxygen concentrators', quantity: 1, estimatedUnitCost: 45_000, glAccountId: ids.glRepairs },
          { lineType: 'NON_STOCK_GOODS', description: 'Visitor chairs', quantity: 4, uomId: ids.pcs, estimatedUnitCost: 12_500, glAccountId: ids.glFurniture },
        ],
      }).expect(201)).body;
      await approveAll(req.id);
      const full = (await c['ward.nurse'].get(`/staff-requisitions/${req.id}`).expect(200)).body;
      const pr = (await c['proc.officer'].post('/staff-requisitions/consolidate', { lineIds: full.lines.map((l: { id: string }) => l.id), departmentId: ids.IPD_MED, storeId: ids.MS, justification: 'Phase 6' }).expect(201)).body;
      await c['proc.officer'].post(`/requisitions/${pr.id}/submit`).expect(200);
      await approveAll(pr.id);
      const prFull = (await c['proc.officer'].get(`/requisitions/${pr.id}`).expect(200)).body;
      po = (await c['proc.officer'].post('/purchase-orders', { requisitionId: pr.id, supplierId: ids.supplier, lines: prFull.lines.map((l: { id: string }) => ({ requisitionLineId: l.id })) }).expect(201)).body;
      await c['proc.officer'].post(`/purchase-orders/${po.id}/submit`).expect(200);
      await approveAll(po.id);

      const b = await preview(['PURCHASES']);
      const p = find(b.items, 'PURCHASE_ORDER', po.id);
      expect(p).toMatchObject({ status: 'READY', amount: 95_000, entries: [] });
      const lines = p.payload.Line as Line[];
      expect(lines.map((l) => [l.AccountBasedExpenseLineDetail!.AccountRef!.value, l.AccountBasedExpenseLineDetail!.ClassRef!.value])).toEqual([
        ['64', '110'],
        ['67', '110'],
      ]);
      expect(p.payload).toMatchObject({ POStatus: 'Open', DocNumber: po.number.slice(0, 21) });
      await post(b.id);
      const sent = await posting('PURCHASE_ORDER', po.id);
      expect(sent).toMatchObject({ status: 'POSTED', syncToken: '0' });
      expect(qbo.all('PurchaseOrder').find((x) => x.Id === sent.externalId)).toBeTruthy();
      expect(qbo.ledger.filter((e) => e.txnType === 'PurchaseOrder')).toEqual([]); // non-posting
    });

    it('an amended order is updated in QuickBooks with its SyncToken', async () => {
      po = (await c['proc.officer'].get(`/purchase-orders/${po.id}`).expect(200)).body;
      await c['proc.officer']
        .post(`/purchase-orders/${po.id}/amend`, { reason: 'Supplier discount', lines: po.lines.map((l) => ({ lineId: l.id, quantity: l.quantity, unitPrice: l.lineType === 'SERVICE' ? 44_000 : l.unitPrice })) })
        .expect(200);
      await approveAll(po.id);
      const b = await preview(['PURCHASES']);
      expect(find(b.items, 'PURCHASE_ORDER', po.id)).toMatchObject({ status: 'READY', amount: 94_000 });
      await post(b.id);
      const updated = await posting('PURCHASE_ORDER', po.id);
      expect(updated).toMatchObject({ status: 'POSTED', syncToken: '1' });
      const inQbo = qbo.all('PurchaseOrder').find((x) => x.Id === updated.externalId)!;
      expect(inQbo.SyncToken).toBe('1');
      expect((inQbo.Line as Line[])[0].Amount).toBe(44_000);
      // A stale SyncToken is refused by QuickBooks.
      const token = [...qbo.validTokens].pop()!;
      const stale = await qbo.call({ realmId: 'x', accessToken: token, method: 'POST', path: 'purchaseorder', body: { ...inQbo, SyncToken: '0' } });
      expect(stale.status).toBe(400);
      expect(JSON.stringify(stale.body)).toContain('Stale Object Error');
    });

    it('the bill is linked to the purchase order lines; the paid voucher sends WHT as a vendor credit and M-PESA charges as an expense', async () => {
      po = (await c['proc.officer'].get(`/purchase-orders/${po.id}`).expect(200)).body;
      await c['proc.officer'].post(`/purchase-orders/${po.id}/send`).expect(200);
      const svc = po.lines.find((l) => l.lineType === 'SERVICE')!;
      const chairs = po.lines.find((l) => l.lineType !== 'SERVICE')!;
      const cert = (await c.storekeeper.post('/service-certificates', { purchaseOrderId: po.id, periodTo: today, workDone: 'Serviced and delivered', lines: [{ poLineId: svc.id, quantity: 1 }, { poLineId: chairs.id, quantity: 4 }] }).expect(201)).body;
      await c['ward.nurse'].post(`/service-certificates/${cert.id}/accept`).expect(200);
      const inv = (await c.accountant.post('/invoices', { purchaseOrderId: po.id, supplierInvoiceNo: uniq('SI'), invoiceDate: today, lines: [{ poLineId: svc.id, quantity: 1, unitPrice: 44_000 }, { poLineId: chairs.id, quantity: 4, unitPrice: 12_500 }] }).expect(201)).body;
      expect(inv).toMatchObject({ matchStatus: 'MATCHED', whtTotal: 2_200 });
      await c.accountant.post(`/invoices/${inv.id}/submit`).expect(200);
      ids.invoice = inv.id;
      // Net = 94,000 + 16% VAT − 5% WHT on the service = 109,040 − 2,200 = 106,840.
      const pv = (await c.accountant.post('/payment-vouchers', { supplierId: ids.supplier, method: 'MPESA_PAYBILL', payeeShortcode: '888880', payeeAccountRef: 'HOSP-9', invoices: [{ invoiceId: inv.id }] }).expect(201)).body;
      expect(pv).toMatchObject({ grossAmount: 109_040, whtAmount: 2_200, amount: 106_840 });
      await c.accountant.post(`/payment-vouchers/${pv.id}/submit`).expect(200);
      await approveAs(pv.id, 'finance.manager');
      await c.finance.post(`/payment-vouchers/${pv.id}/release`, {}).expect(200);
      await sharedMockPayouts.deliverAll();
      expect((await c.finance.get(`/payment-vouchers/${pv.id}`).expect(200)).body.status).toBe('PAID');
      ids.voucher = pv.id;
      ids.payout = (await one(`SELECT id FROM mpesa_payout WHERE voucher_id = $1 AND status = 'SUCCESS'`, [pv.id])).id;

      const b = await preview(['PURCHASES']);
      const bill = find(b.items, 'BILL', inv.id);
      expect(bill.status).toBe('READY');
      const bl = bill.payload.Line as Line[];
      expect(bl.map((l) => l.AccountBasedExpenseLineDetail!.AccountRef!.value)).toEqual(['64', '67']);
      const poId = (await posting('PURCHASE_ORDER', po.id)).externalId;
      expect(bl.map((l) => l.LinkedTxn)).toEqual([[{ TxnId: poId, TxnType: 'PurchaseOrder', TxnLineId: '1' }], [{ TxnId: poId, TxnType: 'PurchaseOrder', TxnLineId: '2' }]]);
      // VAT is part of cost here (purchasing.costIncludesVat), as for stock.
      expect(bill.entries).toEqual([{ account: '64', amount: 51_040, classId: '110' }, { account: '67', amount: 58_000, classId: '110' }, { account: '20', amount: -109_040 }]);

      const wht = find(b.items, 'VENDOR_CREDIT', pv.id);
      expect(wht).toMatchObject({ status: 'READY', localDocType: 'PAYMENT_VOUCHER_WHT', amount: 2_200, entries: [{ account: '20', amount: 2_200 }, { account: '23', amount: -2_200 }] });
      const pay = find(b.items, 'BILL_PAYMENT', pv.id);
      expect(pay).toMatchObject({ status: 'READY', amount: 106_840, entries: [{ account: '20', amount: 106_840 }, { account: '6', amount: -106_840 }] });
      expect(pay.payload).toMatchObject({ TotalAmt: 106_840, CheckPayment: { BankAccountRef: { value: '6' } } });
      expect((pay.payload.Line as Line[]).map((l) => [l.Amount, l.LinkedTxn![0].TxnType])).toEqual([[109_040, 'Bill'], [2_200, 'VendorCredit']]);
      const charges = find(b.items, 'PURCHASE', ids.payout);
      expect(charges).toMatchObject({ status: 'READY', localDocType: 'MPESA_CHARGES', amount: 52, entries: [{ account: '65', amount: 52 }, { account: '6', amount: -52 }] });

      const done = await post(b.id);
      expect(done.totals.failed).toBe(0);
      for (const [t, id] of [['BILL', inv.id], ['VENDOR_CREDIT', pv.id], ['BILL_PAYMENT', pv.id], ['PURCHASE', ids.payout]]) expect((await posting(t, id)).status).toBe('POSTED');
      // In QuickBooks: the vendor owes nothing on this bill; WHT payable and charges are booked.
      const billId = (await posting('BILL', inv.id)).externalId;
      const mine = [billId, (await posting('VENDOR_CREDIT', pv.id)).externalId, (await posting('BILL_PAYMENT', pv.id)).externalId];
      const ap = qbo.ledger.filter((e) => e.account === '20' && ['Bill', 'VendorCredit', 'BillPayment'].includes(e.txnType) && mine.includes(e.txnId));
      expect(ap.reduce((s, e) => s + e.amount, 0)).toBeCloseTo(0, 2);
      // (Other suites' documents of the day go to the same mock company: look at this voucher's only.)
      const chargesId = (await posting('PURCHASE', ids.payout)).externalId;
      expect(qbo.ledger.filter((e) => e.account === '23' && mine.includes(e.txnId)).reduce((s, e) => s + e.amount, 0)).toBeCloseTo(-2_200, 2);
      expect(qbo.ledger.filter((e) => e.account === '65' && e.txnId === chargesId).reduce((s, e) => s + e.amount, 0)).toBeCloseTo(52, 2);
    });

    it('a foreign-currency bill carries its currency and rate; the ledger is in shillings', async () => {
      const svc = po.lines.find((l) => l.lineType === 'SERVICE')!;
      const usd = await one(
        `INSERT INTO supplier_invoice (number, supplier_id, supplier_invoice_no, purchase_order_id, invoice_date, status, match_status, subtotal, tax_total, total, currency, exchange_rate, base_total, captured_by)
         VALUES ($1, $2, $3, $4, $5, 'APPROVED', 'MATCHED', 100, 16, 116, 'USD', 130, 15080, $6) RETURNING id`,
        [uniq('INV'), ids.supplier, uniq('USD'), po.id, today, ids.accountant],
      );
      await q(`INSERT INTO supplier_invoice_line (invoice_id, po_line_id, quantity, unit_price, tax_amount, line_total) VALUES ($1, $2, 1, 100, 16, 116)`, [usd.id, svc.id]);
      const b = await preview(['PURCHASES']);
      const bill = find(b.items, 'BILL', usd.id);
      expect(bill.payload).toMatchObject({ CurrencyRef: { value: 'USD' }, ExchangeRate: 130 });
      expect(bill).toMatchObject({ amount: 15_080, entries: [{ account: '64', amount: 15_080, classId: '110' }, { account: '20', amount: -15_080 }] });
      await post(b.id);
      const id = (await posting('BILL', usd.id)).externalId;
      expect(qbo.ledger.filter((e) => e.txnId === id && e.account === '20').reduce((s, e) => s + e.amount, 0)).toBeCloseTo(-15_080, 2);
    });
  });

  describe('petty cash', () => {
    it('payments, advances and their retirement, and replenishments become expenses, journals and transfers', async () => {
      ids.float = (await c.finance.post('/petty-cash/floats', { code: uniq('Q').toUpperCase().replace(/[^A-Z0-9-]/g, '').slice(0, 20), name: 'QBO float', departmentId: ids.IPD_MED, custodianId: ids.accountant, floatLimit: 20_000, perTransactionLimit: 10_000, replenishThreshold: 2_000, glAccountId: ids.glPetty, mpesaEnabled: true, openingBalance: 20_000 }).expect(201)).body.id;
      const ask = async (body: Record<string, unknown>) => {
        const r = (await c['ward.nurse'].post('/petty-cash/requests', { floatId: ids.float, kind: 'PAYMENT', payeeType: 'VENDOR', departmentId: ids.IPD_MED, method: 'CASH', submit: true, ...body }).expect(201)).body;
        await approveAs(r.id, 'ward.incharge');
        await approveAs(r.id, 'finance');
        await c.accountant.post(`/petty-cash/requests/${r.id}/disburse`, {}).expect(200);
        return r.id as string;
      };
      ids.pay = await ask({ payeeName: 'Tap repairs', purpose: 'Fix the sluice room tap', amount: 3_000, glAccountId: ids.glOffice });
      ids.adv = await ask({ kind: 'ADVANCE', payeeType: 'STAFF', purpose: 'Outreach transport', amount: 4_800, glAccountId: ids.glTravel });
      await c['ward.nurse'].post(`/petty-cash/requests/${ids.adv}/retirement`, { lines: [{ description: 'Matatu fares', amount: 3_400 }, { description: 'Meals', amount: 400 }] }).expect(200);
      await c.accountant.post(`/petty-cash/requests/${ids.adv}/retirement/verify`, { accept: true }).expect(200);
      ids.rp = (await c.accountant.post('/petty-cash/replenishments', { floatId: ids.float, amount: 6_000 }).expect(201)).body.id;
      await approveAs(ids.rp, 'finance.manager');
      await c.accountant.post(`/petty-cash/replenishments/${ids.rp}/receive`, { reference: 'CHQ-77' }).expect(200);

      const b = await preview(['PETTY_CASH']);
      expect(find(b.items, 'PURCHASE', ids.pay)).toMatchObject({ status: 'READY', amount: 3_000, entries: [{ account: '64', amount: 3_000, classId: '110' }, { account: '5', amount: -3_000 }] });
      expect(find(b.items, 'PURCHASE', ids.pay).payload).toMatchObject({ AccountRef: { value: '5' }, PaymentType: 'Cash' });
      expect(find(b.items, 'JOURNAL', ids.adv)).toMatchObject({ localDocType: 'PETTY_CASH_ADVANCE', entries: [{ account: '24', amount: 4_800 }, { account: '5', amount: -4_800 }] });
      const ret = find(b.items, 'JOURNAL', `R:${ids.adv}`);
      expect(ret).toMatchObject({ localDocType: 'PETTY_CASH_RETIREMENT', entries: [{ account: '66', amount: 3_400, classId: '110' }, { account: '66', amount: 400, classId: '110' }, { account: '5', amount: 1_000 }, { account: '24', amount: -4_800 }] });
      expect(find(b.items, 'TRANSFER', ids.rp)).toMatchObject({ amount: 6_000, payload: { FromAccountRef: { value: '3' }, ToAccountRef: { value: '5' }, Amount: 6_000 } });
      const done = await post(b.id);
      expect(done.totals.failed).toBe(0);
      // Staff advances are cleared in QuickBooks; the petty cash account moved like the cash book.
      const mine = [await posting('PURCHASE', ids.pay), await posting('JOURNAL', ids.adv), await posting('JOURNAL', `R:${ids.adv}`), await posting('TRANSFER', ids.rp)].map((p) => p.externalId);
      expect(qbo.ledger.filter((e) => e.account === '24' && mine.includes(e.txnId)).reduce((s, e) => s + e.amount, 0)).toBeCloseTo(0, 2);
      expect(qbo.ledger.filter((e) => e.account === '5' && mine.includes(e.txnId)).reduce((s, e) => s + e.amount, 0)).toBeCloseTo(-3_000 - 4_800 + 1_000 + 6_000, 2);
    });
  });

  describe('sync engine', () => {
    it('blocked (mapping) and failed postings are logged and retried; every document shows its sync status', async () => {
      // An unmapped GL account blocks the posting with what to fix.
      await q(`DELETE FROM account_mapping WHERE kind = 'GL_ACCOUNT' AND local_key = '5300'`);
      const gl5300 = await idByCode(ctx.ds, 'gl_account', '5300');
      const r = (await c['ward.nurse'].post('/petty-cash/requests', { floatId: ids.float, kind: 'PAYMENT', payeeType: 'VENDOR', payeeName: 'Stationers', departmentId: ids.IPD_MED, method: 'CASH', purpose: 'Printer paper for the ward', amount: 900, glAccountId: gl5300, submit: true }).expect(201)).body;
      await approveAs(r.id, 'ward.incharge');
      await approveAs(r.id, 'finance');
      await c.accountant.post(`/petty-cash/requests/${r.id}/disburse`, {}).expect(200);
      const b = await preview(['PETTY_CASH']);
      expect(find(b.items, 'PURCHASE', r.id)).toMatchObject({ status: 'BLOCKED', error: 'Map: QuickBooks account for GL 5300' });
      const st = (await c['ward.nurse'].get(`/accounting/sync-status?ids=${r.id},${ids.pay},${ids.invoice},${ids.voucher},${ids.adv},00000000-0000-0000-0000-000000000000`).expect(200)).body;
      expect(st.map((x: { status: string }) => x.status)).toEqual(['FAILED', 'SYNCED', 'SYNCED', 'SYNCED', 'SYNCED', 'NOT_QUEUED']);

      // Mapped, then QuickBooks is briefly down: retried with back-off, posted once.
      await c.finance.put('/accounting/mappings', { kind: 'GL_ACCOUNT', localKey: '5300', externalId: '66' }).expect(200);
      qbo.failure = { mode: 'http500', count: 1 };
      const p = await posting('PURCHASE', r.id);
      await c.finance.post(`/accounting/postings/${p.id}/reprocess`).expect(200);
      expect((await posting('PURCHASE', r.id)).status).toBe('PENDING');
      await q(`UPDATE accounting_posting SET next_attempt_at = now() WHERE id = $1`, [p.id]);
      await c.admin.post('/jobs/accounting.dispatch/run', {}).expect(200);
      expect((await posting('PURCHASE', r.id)).status).toBe('POSTED');
      expect(qbo.all('Purchase').filter((x) => x.DocNumber === (r.number as string).slice(0, 21))).toHaveLength(1);
    });

    it('automatic sync queues and posts new documents when switched on', async () => {
      const r = (await c['ward.nurse'].post('/petty-cash/requests', { floatId: ids.float, kind: 'PAYMENT', payeeType: 'VENDOR', payeeName: 'Plumber', departmentId: ids.IPD_MED, method: 'CASH', purpose: 'Replace a shower head', amount: 700, glAccountId: ids.glOffice, submit: true }).expect(201)).body;
      await approveAs(r.id, 'ward.incharge');
      await approveAs(r.id, 'finance');
      await c.accountant.post(`/petty-cash/requests/${r.id}/disburse`, {}).expect(200);
      expect((await c.finance.post('/accounting/auto-sync').expect(200)).body).toEqual({ skipped: 'accounting.autoSync is off' });
      await setting('accounting.autoSync', true);
      const res = (await c.finance.post('/accounting/auto-sync').expect(200)).body;
      expect(res.posted).toBeGreaterThanOrEqual(1);
      expect((await posting('PURCHASE', r.id)).status).toBe('POSTED');
      // Nothing new: nothing is sent twice.
      const again = (await c.finance.post('/accounting/auto-sync').expect(200)).body;
      expect(again.posted).toBe(0);
    });

    it('vendors: PULL links existing QuickBooks vendors to suppliers, PUSH creates the rest', async () => {
      const s = await one(`SELECT s.id, s.name FROM supplier s WHERE s.status = 'ACTIVE' AND NOT EXISTS (SELECT 1 FROM accounting_external_ref r WHERE r.entity = 'VENDOR' AND r.local_key = s.id::text) ORDER BY s.code LIMIT 1`);
      (qbo as unknown as { put(t: string, e: Record<string, unknown>): unknown }).put('Vendor', { DisplayName: s.name, Active: true });
      const pulled = (await c.finance.post('/accounting/vendors/sync', { direction: 'PULL' }).expect(200)).body;
      expect(pulled.linked).toBeGreaterThanOrEqual(1);
      expect(await one(`SELECT 1 AS ok FROM accounting_external_ref WHERE entity = 'VENDOR' AND local_key = $1`, [s.id])).toEqual({ ok: 1 });
      const before = qbo.all('Vendor').length;
      const pushed = (await c.finance.post('/accounting/vendors/sync', { direction: 'PUSH' }).expect(200)).body;
      expect(qbo.all('Vendor').length).toBe(before + pushed.pushed);
      expect((await one(`SELECT COUNT(*)::int AS n FROM supplier s WHERE s.status = 'ACTIVE' AND NOT EXISTS (SELECT 1 FROM accounting_external_ref r WHERE r.entity = 'VENDOR' AND r.local_key = s.id::text)`)).n).toBe(0);
    });

    it('reconciles the new accounts with QuickBooks', async () => {
      const rec = (await c.finance.get(`/accounting/reconciliation?from=${today}&to=${today}`).expect(200)).body;
      for (const a of ['23', '24', '65']) {
        const row = rec.accounts.find((x: { account: string }) => x.account === a);
        expect(row).toMatchObject({ difference: 0, toPost: 0 });
      }
    });
  });
});
