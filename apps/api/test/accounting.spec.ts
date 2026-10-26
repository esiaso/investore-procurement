import { randomUUID } from 'node:crypto';
import { sharedMockQbo as qbo } from '../src/modules/accounting/qbo';
import { AccountingService } from '../src/modules/accounting/accounting.service';
import { SAMPLE_QBO_MAPPINGS } from '../src/database/seeds/sample-accounting';
import { API, Client, createTestApp, idByCode, loggedIn, TestContext, uniq } from './helpers';

const day = (d = 0) =>
  new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Nairobi', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(Date.now() + d * 86_400_000));

type Posting = { id: string; docType: string; localDocType: string; localDocId: string; localDocNo: string | null; amount: number; status: string; error: string | null; externalId: string | null; entries: { account: string; amount: number; classId?: string | null }[]; payload: Record<string, unknown> };

describe('QuickBooks Online (mapping, batch posting, retries, reconciliation)', () => {
  let ctx: TestContext;
  const c: Record<string, Client> = {};
  const ids: Record<string, string> = {};
  const inv: Record<string, string> = {};
  const today = day();
  const q = async (sql: string, p: unknown[] = []) => ctx.ds.query(sql, p);
  const one = async (sql: string, p: unknown[] = []) => (await q(sql, p))[0];
  const posting = async (docType: string, localDocId: string): Promise<Posting> => {
    const row = await one(`SELECT id FROM accounting_posting WHERE doc_type = $1 AND local_doc_id = $2`, [docType, localDocId]);
    return (await c.finance.get(`/accounting/postings/${row.id}`).expect(200)).body;
  };
  const preview = async (body: Record<string, unknown>) => (await c.finance.post('/accounting/batches', body).expect(201)).body as { id: string; items: Posting[]; summary: { docType: string; count: number }[] };
  const find = (items: Posting[], docType: string, localDocId: string) => items.find((i) => i.docType === docType && i.localDocId === localDocId);
  const sell = async (lines: { itemId: string; quantity: number }[], payments: { modeCode: string; amount: number; reference?: string }[], customer?: Record<string, unknown>) =>
    (await c.admin.post('/billing/invoices', { storeId: ids.OPD, source: 'OTC', lines, payments, customer }).expect(201)).body as { id: string; number: string; totalAmount: number };

  async function product(price: number, tax: string) {
    const g = await c.admin.post('/generics', { innName: `Qbomol ${uniq('g')}`, strength: '1 g', dosageForm: 'Tablet', route: 'Oral', therapeuticClass: 'QBO test', controlledSchedule: 'NONE' }).expect(201);
    const item = await c.admin.post('/items', { genericId: g.body.id, categoryId: ids.drugCat, name: `QBO test ${uniq('i')}`, baseUomId: ids.tab, unitPrice: price, taxCategoryId: tax, salesClass: 'OTC' }).expect(201);
    await c.scm.post('/inventory/receipts', { storeId: ids.OPD, type: 'OPENING', lines: [{ itemId: item.body.id, batchNo: uniq('L'), expiryDate: day(400), quantity: 500, unitCost: 20 }] }).expect(201);
    return item.body.id as string;
  }

  beforeAll(async () => {
    ctx = await createTestApp();
    qbo.reset();
    for (const u of ['admin', 'scm', 'finance', 'cashier']) c[u] = await loggedIn(ctx, u);
    Object.assign(ids, {
      OPD: await idByCode(ctx.ds, 'store', 'OPD-PH'),
      MS: await idByCode(ctx.ds, 'store', 'MS'),
      drugCat: await idByCode(ctx.ds, 'item_category', 'DRUG-ANALG'),
      tab: await idByCode(ctx.ds, 'unit_of_measure', 'TAB'),
      exempt: await idByCode(ctx.ds, 'tax_category', 'EXEMPT'),
      standard: await idByCode(ctx.ds, 'tax_category', 'STANDARD'),
      ipdMed: await idByCode(ctx.ds, 'department', 'IPD-MED'),
    });
    await q(`UPDATE etims_config SET is_active = false`);
    ids.plain = await product(50, ids.exempt);
    ids.vat = await product(100, ids.standard); // VAT exclusive: sells at 116
    ids.payer = (await c.finance.post('/billing/payers', { code: uniq('NHIF'), name: `Test Insurer ${uniq('p')}`, type: 'INSURANCE', coPayPercent: 10 }).expect(201)).body.id;
  });

  afterAll(async () => {
    qbo.reset();
    await ctx.close();
  });

  describe('connection', () => {
    it('only accounting users see it; OAuth checks the state, stores the tokens and reads the company', async () => {
      await c.cashier.get('/accounting/connection').expect(403);
      await c.finance.put('/accounting/connection', { provider: 'QBO', environment: 'SANDBOX' }).expect(400); // needs the Intuit app
      await c.finance.put('/accounting/connection', { provider: 'MOCK', redirectUri: `${API}/callbacks/quickbooks` }).expect(200);
      const { url } = (await c.finance.post('/accounting/connection/authorize').expect(200)).body;
      const bad = await c.finance.agent.get(url.replace(/state=[^&]+/, 'state=forged')).expect(302);
      expect(bad.headers.location).toMatch(/error=.*state/);
      const ok = await c.finance.agent.get(url).expect(302);
      expect(ok.headers.location).toBe('/accounting/quickbooks?connected=1');
      const conn = (await c.finance.get('/accounting/connection').expect(200)).body;
      expect(conn).toMatchObject({ connected: true, realmId: '9130357000000001', companyName: 'SIL Hospital (mock QuickBooks)' });
      expect(conn.accessTokenEnc).toBeUndefined();
      // The state is single use.
      await c.finance.agent.get(url).expect(302).expect('location', /error=/);
    });

    it('lists QuickBooks accounts, classes and tax codes; refreshes an expired token', async () => {
      await q(`UPDATE accounting_connection SET access_expires_at = now() - interval '1 minute'`);
      const lists = (await c.finance.get('/accounting/lists').expect(200)).body;
      expect(lists.accounts).toEqual(expect.arrayContaining([{ id: '33', name: 'Goods received not invoiced', AccountType: 'Other Current Liability' }]));
      expect(lists.classes.length).toBeGreaterThan(3);
      expect(lists.taxCodes.map((t: { name: string }) => t.name)).toContain('VAT 16%');
      expect(new Date((await one(`SELECT access_expires_at FROM accounting_connection`)).access_expires_at).getTime()).toBeGreaterThan(Date.now() + 1_800_000);
    });
  });

  describe('sales, mappings and posting', () => {
    beforeAll(async () => {
      inv.cash = (await sell([{ itemId: ids.plain, quantity: 2 }], [{ modeCode: 'CASH', amount: 100 }])).id;
      inv.split = (await sell([{ itemId: ids.vat, quantity: 1 }], [{ modeCode: 'CASH', amount: 50 }, { modeCode: 'MPESA', amount: 66, reference: 'QBO1234XYZ' }])).id;
      inv.payer = (await sell([{ itemId: ids.plain, quantity: 10 }], [{ modeCode: 'CASH', amount: 50 }], { name: 'Jane Patient', payerId: ids.payer })).id;
      inv.credit = (await c.finance.post(`/billing/invoices/${inv.cash}/credit-notes`, { reason: 'Returned unopened', restock: true }).expect(201)).body.id;
    });

    it('the preview blocks documents whose accounts are not mapped, saying what to map', async () => {
      const b = await preview({ from: today, to: today, kinds: ['SALES'] });
      const r = find(b.items, 'SALES_RECEIPT', inv.cash)!;
      expect(r).toMatchObject({ status: 'BLOCKED', error: expect.stringMatching(/^Map: (?=.*payment account for payment mode CASH)(?=.*category income for category DRUG-ANALG)/) });
      const mp = (await c.finance.get('/accounting/mappings').expect(200)).body;
      expect(mp.keys.SYSTEM.map((k: { code: string }) => k.code)).toEqual(expect.arrayContaining(['AP', 'AR', 'GRNI', 'STOCK_WRITE_OFF']));
      await c.cashier.put('/accounting/mappings', { kind: 'SYSTEM', localKey: 'AR', externalId: '10' }).expect(403);
      for (const [kind, localKey, externalId] of SAMPLE_QBO_MAPPINGS) await c.finance.put('/accounting/mappings', { kind, localKey, externalId }).expect(200);
    });

    let batch: { id: string; items: Posting[]; summary: { docType: string; count: number }[] };
    it('previews each sale as QuickBooks will get it, with the local double entry', async () => {
      batch = await preview({ from: today, to: today, kinds: ['SALES'] });
      const cash = find(batch.items, 'SALES_RECEIPT', inv.cash)!;
      expect(cash).toMatchObject({ status: 'READY', amount: 100 });
      expect(cash.entries).toEqual([{ account: '1', amount: 100 }, { account: '40', amount: -100, classId: '102' }]);
      // Split tender: an invoice and a payment per mode.
      const split = find(batch.items, 'INVOICE', inv.split)!;
      expect(split.entries).toEqual(expect.arrayContaining([{ account: '10', amount: 116 }, { account: '40', amount: -100, classId: '102' }, { account: '21', amount: -16 }]));
      expect(batch.items.filter((i) => i.localDocType === 'SALES_PAYMENT' && (i.payload.PrivateNote as string).endsWith((split.payload.DocNumber as string)))).toHaveLength(2);
      // Insurer: invoice to the payer (customer), the patient's co-pay as a payment.
      const payer = find(batch.items, 'INVOICE', inv.payer)!;
      expect(payer.amount).toBe(500);
      expect((payer.payload.CustomerRef as { $ref: { localKey: string } }).$ref.localKey).toBe(`payer:${ids.payer}`);
      // The refund went back in cash: a refund receipt.
      expect(find(batch.items, 'REFUND_RECEIPT', inv.credit)).toMatchObject({ status: 'READY', amount: 100 });
      expect(batch.summary.map((s) => s.docType)).toEqual(expect.arrayContaining(['SALES_RECEIPT', 'INVOICE', 'PAYMENT', 'REFUND_RECEIPT']));
    });

    it('posts the batch in order: customers and products created once, payments linked to their invoices', async () => {
      const res = (await c.finance.post(`/accounting/batches/${batch.id}/post`).expect(200)).body;
      expect(res.items.filter((i: Posting) => i.status === 'FAILED').map((i: Posting) => `${i.localDocNo}: ${i.error}`)).toEqual([]);
      for (const [t, id] of [['SALES_RECEIPT', inv.cash], ['INVOICE', inv.split], ['INVOICE', inv.payer], ['REFUND_RECEIPT', inv.credit]]) expect(await posting(t, id)).toMatchObject({ status: 'POSTED', externalId: expect.any(String) });
      const invoiceQbo = (await posting('INVOICE', inv.split)).externalId!;
      const pays = qbo.all('Payment').filter((p) => ((p.Line ?? []) as { LinkedTxn?: { TxnId: string }[] }[]).some((l) => l.LinkedTxn?.[0]?.TxnId === invoiceQbo));
      expect(pays.map((p) => p.TotalAmt).sort()).toEqual([50, 66]);
      expect(pays.map((p) => (p.DepositToAccountRef as { value: string }).value).sort()).toEqual(['1', '2']);
      const customers = qbo.all('Customer').map((x) => x.DisplayName);
      expect(customers.filter((n) => n === 'Walk-in customers')).toHaveLength(1);
      expect(customers.some((n) => String(n).startsWith('Test Insurer'))).toBe(true);
      expect(qbo.all('Item').filter((x) => x.Name === 'Sales - DRUG-ANALG')).toHaveLength(1);
      const refs = (await c.finance.get('/accounting/external-refs').expect(200)).body;
      expect(refs.filter((r: { localKey: string }) => r.localKey === 'walk-in')).toHaveLength(1);
    });

    it('never posts a document twice (not previewed again; QuickBooks dedupes a resent request)', async () => {
      const again = await preview({ from: today, to: today, kinds: ['SALES'] });
      expect(find(again.items, 'SALES_RECEIPT', inv.cash)).toBeUndefined();
      const p = await posting('SALES_RECEIPT', inv.cash);
      const count = qbo.all('SalesReceipt').length;
      const acc = ctx.app.get(AccountingService);
      expect(await acc.send(p.id)).toBe('SKIPPED');
      // Even if the row were sent again, the request id makes QuickBooks return the first one.
      await q(`UPDATE accounting_posting SET status = 'READY' WHERE id = $1`, [p.id]);
      expect(await acc.send(p.id)).toBe('POSTED');
      expect((await posting('SALES_RECEIPT', inv.cash)).externalId).toBe(p.externalId);
      expect(qbo.all('SalesReceipt')).toHaveLength(count);
    });

    it('settles insurer invoices and posts the settlement as a payment against them', async () => {
      const owed = (await c.finance.get(`/accounting/settlements/outstanding/${ids.payer}`).expect(200)).body;
      expect(owed).toEqual([expect.objectContaining({ id: inv.payer, owed: 450 })]);
      const base = { payerId: ids.payer, receivedOn: today, modeCode: 'BANK', reference: 'EFT-998877' };
      await c.finance.post('/accounting/settlements', { ...base, amount: 500, allocations: [{ invoiceId: inv.payer, amount: 500 }] }).expect(400);
      await c.finance.post('/accounting/settlements', { ...base, amount: 400, allocations: [{ invoiceId: inv.payer, amount: 450 }] }).expect(400);
      const s = (await c.finance.post('/accounting/settlements', { ...base, amount: 450, allocations: [{ invoiceId: inv.payer, amount: 450 }] }).expect(201)).body;
      expect(s.number).toMatch(/^RCV\//);
      expect((await c.finance.get(`/accounting/settlements/outstanding/${ids.payer}`).expect(200)).body).toEqual([]);
      const b = await preview({ from: today, to: today, kinds: ['SALES'] });
      expect(find(b.items, 'PAYMENT', s.id)).toMatchObject({ status: 'READY', localDocType: 'PAYER_SETTLEMENT', entries: [{ account: '3', amount: 450 }, { account: '10', amount: -450 }] });
      await c.finance.post(`/accounting/batches/${b.id}/post`).expect(200);
      const posted = await posting('PAYMENT', s.id);
      expect(posted.status).toBe('POSTED');
      const qp = qbo.all('Payment').find((p) => p.Id === posted.externalId)!;
      expect((qp.Line as { LinkedTxn: { TxnId: string }[] }[])[0].LinkedTxn[0].TxnId).toBe((await posting('INVOICE', inv.payer)).externalId);
    });
  });

  describe('failures, retries and closed periods', () => {
    it('a transient QuickBooks error is retried with back-off by the dispatch job', async () => {
      const id = (await sell([{ itemId: ids.plain, quantity: 1 }], [{ modeCode: 'CASH', amount: 50 }])).id;
      const b = await preview({ from: today, to: today, kinds: ['SALES'] });
      qbo.failure = { mode: 'http500', count: 1 };
      const res = (await c.finance.post(`/accounting/batches/${b.id}/post`).expect(200)).body;
      expect(res.totals.retry).toBe(1);
      const p = await posting('SALES_RECEIPT', id);
      expect(p).toMatchObject({ status: 'PENDING', error: expect.stringMatching(/HTTP 500/) });
      const acc = ctx.app.get(AccountingService);
      expect(await acc.dispatch()).toMatchObject({ posted: 0 }); // not due yet
      await q(`UPDATE accounting_posting SET next_attempt_at = now() WHERE id = $1`, [p.id]);
      expect(await acc.dispatch()).toMatchObject({ posted: 1 });
      expect(await posting('SALES_RECEIPT', id)).toMatchObject({ status: 'POSTED', error: null });
    });

    it('a rejected document goes to the error list and can be reprocessed', async () => {
      const id = (await sell([{ itemId: ids.plain, quantity: 3 }], [{ modeCode: 'MPESA', amount: 150, reference: 'QBO5555ABC' }])).id;
      const b = await preview({ from: today, to: today, kinds: ['SALES'] });
      qbo.failure = { mode: 'http400', count: 1 };
      await c.finance.post(`/accounting/batches/${b.id}/post`).expect(200);
      const p = await posting('SALES_RECEIPT', id);
      expect(p).toMatchObject({ status: 'FAILED', error: expect.stringMatching(/Mock rejected/) });
      const errors = (await c.finance.get('/accounting/postings?status=FAILED').expect(200)).body;
      expect(errors.items.map((i: Posting) => i.id)).toContain(p.id);
      expect((await c.finance.post(`/accounting/postings/${p.id}/reprocess`).expect(200)).body).toMatchObject({ status: 'POSTED', externalId: expect.any(String) });
      await c.finance.post(`/accounting/postings/${p.id}/reprocess`).expect(409);
    });

    it('nothing is posted into a period closed in QuickBooks', async () => {
      const id = (await sell([{ itemId: ids.plain, quantity: 1 }], [{ modeCode: 'CASH', amount: 50 }])).id;
      qbo.bookCloseDate = today;
      expect((await c.finance.post('/accounting/connection/refresh').expect(200)).body.closingDate).toBe(today);
      const b = await preview({ from: today, to: today, kinds: ['SALES'] });
      expect(find(b.items, 'SALES_RECEIPT', id)).toMatchObject({ status: 'BLOCKED', error: `Period closed: the books are closed up to ${today}` });
      qbo.bookCloseDate = null;
      await c.finance.put('/accounting/connection', { provider: 'MOCK', redirectUri: `${API}/callbacks/quickbooks`, closingDate: null }).expect(200);
      const p = await posting('SALES_RECEIPT', id);
      expect((await c.finance.post(`/accounting/postings/${p.id}/reprocess`).expect(200)).body.status).toBe('POSTED');
    });
  });

  describe('purchases and inventory journals', () => {
    it('posts matched supplier invoices as bills (to GRNI at stock cost), their payments and supplier credits', async () => {
      // A matched, approved invoice for 10 × 100 + 16% VAT, paid by EFT, and a credited return (inserted directly).
      const sup = await one(`SELECT id FROM supplier WHERE code = 'SUP0001'`);
      const user = await one(`SELECT id FROM app_user WHERE username = 'finance'`);
      const uom = ids.tab;
      const dept = ids.ipdMed;
      const [po] = await q(`INSERT INTO purchase_order (supplier_id, number, currency, order_date, source, department_id, store_id) VALUES ($1, $2, 'KES', $3, 'REQUISITION', $4, $5) RETURNING id`, [sup.id, uniq('PO'), today, dept, ids.MS]);
      const [pl] = await q(
        `INSERT INTO purchase_order_line (purchase_order_id, line_no, item_id, uom_id, conversion_factor, quantity, unit_price, tax_category_id, tax_rate_percent, line_subtotal, line_tax, line_total) VALUES ($1, 1, $2, $3, 1, 10, 100, $4, 16, 1000, 160, 1160) RETURNING id`,
        [po.id, ids.vat, uom, ids.standard],
      );
      const [si] = await q(
        `INSERT INTO supplier_invoice (number, captured_by, invoice_date, purchase_order_id, supplier_invoice_no, supplier_id, status, match_status, subtotal, tax_total, total) VALUES ($1, $2, $3, $4, $5, $6, 'APPROVED', 'MATCHED', 1000, 160, 1160) RETURNING id`,
        [uniq('INV'), user.id, today, po.id, uniq('SUPINV'), sup.id],
      );
      await q(`INSERT INTO supplier_invoice_line (invoice_id, po_line_id, quantity, unit_price, tax_amount, line_total) VALUES ($1, $2, 10, 100, 160, 1160)`, [si.id, pl.id]);
      const [pv] = await q(`INSERT INTO payment_voucher (invoice_id, method, payment_reference, paid_on, amount, number) VALUES ($1, 'EFT', 'EFT-QBO-1', $2, 1160, $3) RETURNING id`, [si.id, today, uniq('PV')]);
      const [rts] = await q(
        `INSERT INTO return_to_supplier (number, supplier_id, store_id, reason_code, status, source, return_date, total_value, credit_note_no, credit_note_date, credit_note_amount) VALUES ($1, $2, $3, 'DAMAGED', 'CREDITED', 'STOCK', $4, 200, 'CN-77', $4, 200) RETURNING id`,
        [uniq('RTS'), sup.id, ids.MS, today],
      );

      const b = await preview({ from: today, to: today, kinds: ['PURCHASES'] });
      expect(find(b.items, 'BILL', si.id)).toMatchObject({ status: 'READY', amount: 1160, entries: [{ account: '33', amount: 1160, classId: '100' }, { account: '20', amount: -1160 }] }); // VAT is part of stock cost (purchasing.costIncludesVat)
      expect(find(b.items, 'BILL_PAYMENT', pv.id)).toMatchObject({ status: 'READY', entries: [{ account: '20', amount: 1160 }, { account: '3', amount: -1160 }] });
      expect(find(b.items, 'VENDOR_CREDIT', rts.id)).toMatchObject({ status: 'READY', entries: [{ account: '20', amount: 200 }, { account: '33', amount: -200, classId: '100' }] });
      // Bills go first even though the payment sorts before them by kind in the list.
      const res = (await c.finance.post(`/accounting/batches/${b.id}/post`).expect(200)).body;
      expect(res.totals.failed).toBe(0);
      const bill = await posting('BILL', si.id);
      const pay = await posting('BILL_PAYMENT', pv.id);
      expect([bill.status, pay.status, (await posting('VENDOR_CREDIT', rts.id)).status]).toEqual(['POSTED', 'POSTED', 'POSTED']);
      const bp = qbo.all('BillPayment').find((x) => x.Id === pay.externalId)!;
      expect((bp.Line as { LinkedTxn: { TxnId: string }[] }[])[0].LinkedTxn[0].TxnId).toBe(bill.externalId);
      expect(qbo.all('Vendor').filter((v) => (qbo.all('Bill').find((x) => x.Id === bill.externalId)!.VendorRef as { value: string }).value === v.Id)).toHaveLength(1);
    });

    it('journals a closed month of stock movements against GRNI, consumption (by department) and adjustments', async () => {
      const [{ item_id, batch_id }] = await q(`SELECT b.item_id, b.id AS batch_id FROM batch b JOIN item i ON i.id = b.item_id WHERE i.category_id = $1 LIMIT 1`, [ids.drugCat]);
      const ins = `INSERT INTO stock_transaction (txn_type, store_id, item_id, batch_id, quantity, unit_cost, value_delta, department_id, reason_code, source_doc_type, source_doc_id, effective_date) VALUES ($1, $2, $3, $4, 0, 0, $5, $6, $7, 'TEST', $8, '2020-01-15')`;
      await q(ins, ['ISSUE', ids.MS, item_id, batch_id, -200, ids.ipdMed, null, randomUUID()]);
      await q(ins, ['ADJUSTMENT', ids.MS, item_id, batch_id, 200, null, 'COUNT_GAIN', randomUUID()]);
      const b = await preview({ from: '2020-01-01', to: '2020-01-31', kinds: ['INVENTORY'] });
      const j = find(b.items, 'JOURNAL', '2020-01')!;
      expect(j).toMatchObject({ status: 'READY', amount: 200 });
      expect(j.entries).toEqual(expect.arrayContaining([{ account: '60', amount: 200, classId: '110' }, { account: '62', amount: -200, classId: '100' }]));
      expect(j.entries.find((e) => e.account === '30')).toBeUndefined(); // stock value unchanged over the month
      await c.finance.post(`/accounting/batches/${b.id}/post`).expect(200);
      expect(await posting('JOURNAL', '2020-01')).toMatchObject({ status: 'POSTED' });
      expect(qbo.all('JournalEntry').some((x) => x.DocNumber === 'INV-2020-01')).toBe(true);
    });
  });

  it('reconciles what was posted with the QuickBooks trial balance', async () => {
    const r = (await c.finance.get(`/accounting/reconciliation?from=${today}&to=${today}`).expect(200)).body;
    const cash = r.accounts.find((a: { account: string }) => a.account === '1');
    expect(cash).toMatchObject({ name: 'Cash on hand', difference: 0 });
    expect(cash.posted).toBe(cash.quickbooks);
    expect(r.accounts.filter((a: { difference: number }) => a.difference !== 0)).toEqual([]);
    expect(r.balanced).toBe(true);
    // A transaction typed straight into QuickBooks shows as a difference.
    qbo.ledger.push({ txnType: 'Deposit', txnId: 'x', date: today, account: '1', amount: 25, classId: null });
    const r2 = (await c.finance.get(`/accounting/reconciliation?from=${today}&to=${today}`).expect(200)).body;
    expect(r2.balanced).toBe(false);
    expect(r2.accounts.find((a: { account: string }) => a.account === '1').difference).toBe(-25);
    qbo.ledger.pop();
  });

  it('disconnects (tokens revoked and dropped)', async () => {
    const conn = (await c.finance.post('/accounting/connection/disconnect').expect(200)).body;
    expect(conn.connected).toBe(false);
    await c.finance.get('/accounting/lists').expect(409);
  });
});
