import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { sharedMockEtims } from '../src/modules/etims/mock/mock-etims';
import { sharedMockMpesa as mpesa } from '../src/modules/pos/mpesa';
import { API, Client, createTestApp, idByCode, loggedIn, TestContext, uniq } from './helpers';
import { TEST_PASSWORD } from './env';

const day = (d = 0) =>
  new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Nairobi', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(Date.now() + d * 86_400_000));

describe('OTC point of sale (tills, shifts, M-Pesa, offline, eTIMS)', () => {
  let ctx: TestContext;
  const c: Record<string, Client> = {};
  const ids: Record<string, string> = {};
  const pr: Record<string, Awaited<ReturnType<typeof product>>> = {};
  let terminalId: string;
  let shiftId: string;
  let token: string;
  const q = async (sql: string, p: unknown[] = []) => ctx.ds.query(sql, p);
  const one = async (sql: string, p: unknown[] = []) => (await q(sql, p))[0];
  const pharmacistCreds = { username: 'pharmacist', password: TEST_PASSWORD };
  const sale = (body: Record<string, unknown>, who = 'cashier') => c[who].post('/pos/sales', { terminalId, clientRef: randomUUID(), ...body });

  /** Generic + one brand with two batches at the OPD pharmacy (the earlier-expiring one first). */
  async function product(opts: { cls?: string | null; price?: number; controlled?: boolean; maxQty?: number; tax?: string; therapeuticClass?: string; stock?: number } = {}) {
    const inn = `Posamol ${uniq('g')}`;
    const g = await c.admin.post('/generics', { innName: inn, strength: '500 mg', dosageForm: 'Tablet', route: 'Oral', therapeuticClass: opts.therapeuticClass ?? `Class ${uniq('c')}`, controlledSchedule: 'NONE', maxQtyPerSale: opts.maxQty }).expect(201);
    const gtin = `5${String(Math.floor(Math.random() * 1e12)).padStart(12, '0')}`;
    const item = await c.admin
      .post('/items', { genericId: g.body.id, categoryId: ids.drugCat, name: `${inn} tablets`, brandName: 'PosBrand', baseUomId: ids.tab, unitPrice: opts.price ?? 10, taxCategoryId: opts.tax ?? ids.exempt, salesClass: opts.cls === undefined ? 'OTC' : opts.cls, isControlled: !!opts.controlled, barcode: gtin.slice(1) })
      .expect(201);
    const early = uniq('E');
    await c.scm.post('/inventory/receipts', { storeId: ids.OPD, type: 'OPENING', lines: [{ itemId: item.body.id, batchNo: uniq('L'), expiryDate: day(500), quantity: opts.stock ?? 300, unitCost: 4 }, { itemId: item.body.id, batchNo: early, expiryDate: day(60), quantity: 10, unitCost: 4 }], ...(opts.controlled ? { witness: { username: 'pharmacist', password: TEST_PASSWORD } } : {}) }).expect(201);
    return { id: item.body.id as string, genericId: g.body.id as string, inn: inn.toLowerCase(), barcode: gtin.slice(1), early: (await one(`SELECT id FROM batch WHERE item_id = $1 AND batch_no = $2`, [item.body.id, early])).id as string };
  }

  beforeAll(async () => {
    ctx = await createTestApp();
    mpesa.reset();
    for (const u of ['admin', 'scm', 'pharmacist', 'cashier', 'finance', 'pharm.tech']) c[u] = await loggedIn(ctx, u);
    Object.assign(ids, {
      OPD: await idByCode(ctx.ds, 'store', 'OPD-PH'),
      drugCat: await idByCode(ctx.ds, 'item_category', 'DRUG-ANALG'),
      tab: await idByCode(ctx.ds, 'unit_of_measure', 'TAB'),
      exempt: await idByCode(ctx.ds, 'tax_category', 'EXEMPT'),
      standard: await idByCode(ctx.ds, 'tax_category', 'STANDARD'),
    });
    // eTIMS: a mock control unit for the OPD pharmacy (every sale is a tax invoice).
    const kraPin = (await one(`SELECT kra_pin FROM facility LIMIT 1`)).kra_pin;
    await q(`UPDATE etims_config SET is_active = false WHERE store_id <> $1`, [ids.OPD]);
    const cfg = await c.finance.put('/etims/configs', { storeId: ids.OPD, adapter: 'MOCK', kraPin, branchId: '00', deviceSerial: `POS-CU-${uniq('d')}`, isActive: true }).expect(200);
    await c.finance.post(`/etims/configs/${cfg.body.id}/initialise`).expect(200);
    await c.finance.post('/etims/codes/sync').expect(200);
    await c.finance.put('/etims/mappings', { kind: 'ITEM_CLASS', localKey: 'category:DRUG', etimsCode: '5100000000' }).expect(200);

    pr.otc = await product({ price: 10 });
    pr.vat = await product({ cls: 'OTC', price: 100, tax: ids.standard }); // VAT-exclusive: sells at 116
    pr.pom = await product({ cls: 'POM', price: 30 });
    pr.p = await product({ cls: 'P', price: 20, therapeuticClass: 'Test anticoag' });
    pr.cd = await product({ cls: 'POM', controlled: true });
    pr.limited = await product({ price: 2, maxQty: 20 });
    pr.plain = await product({ cls: null, price: 5 }); // no class → pos.defaultSalesClass (P)
    await c.pharmacist.post('/pharmacy/interactions', { innA: pr.otc.inn, innB: 'class:test anticoag', severity: 'MAJOR', mechanism: 'Test', management: 'Avoid' }).expect(201);

    await c.cashier.post('/pos/terminals', { code: 'T1', name: 'Till 1', storeId: ids.OPD }).expect(403);
    terminalId = (await c.admin.post('/pos/terminals', { code: uniq('TILL'), name: 'OPD till 1', storeId: ids.OPD }).expect(201)).body.id;
    const m = await c.admin.put('/pos/mpesa/config', { environment: 'MOCK', shortcode: '174379', transactionType: 'CustomerBuyGoodsOnline', partyB: '5123456', callbackBaseUrl: 'https://pos.example' }).expect(200);
    expect(m.body.callbackUrls.stk).toMatch(/^https:\/\/pos\.example\/api\/v1\/callbacks\/mpesa\/stk\/.{20,}$/);
    token = m.body.callbackUrls.stk.split('/').pop();
  });

  afterAll(async () => {
    await q(`UPDATE etims_config SET is_active = false`);
    sharedMockEtims.reset();
    mpesa.reset();
    await ctx.close();
  });

  describe('shifts', () => {
    it('a cashier opens one shift per till with a float; nobody can sell without one', async () => {
      await sale({ lines: [{ itemId: pr.otc.id, quantity: 1 }], payments: [{ modeCode: 'CASH', amount: 10 }] }).expect(409);
      const s = await c.cashier.post('/pos/shifts', { terminalId, openingFloat: 1000 }).expect(201);
      shiftId = s.body.id;
      expect(s.body).toMatchObject({ status: 'OPEN', openingFloat: 1000, number: expect.stringMatching(/^Z\/OPD-PH\//), report: expect.objectContaining({ expectedCash: 1000 }) });
      await c.cashier.post('/pos/shifts', { terminalId, openingFloat: 0 }).expect(409);
      await c['pharm.tech'].post('/pos/shifts', { terminalId, openingFloat: 0 }).expect(409); // till taken
      expect((await c.cashier.get(`/pos/shifts/current?terminalId=${terminalId}`).expect(200)).body.id).toBe(shiftId);
    });
  });

  describe('selling', () => {
    it('finds items by barcode, sells loose tablets FEFO, gives change and issues an eTIMS invoice', async () => {
      const found = await c.cashier.get(`/pos/items?terminalId=${terminalId}&q=${pr.otc.barcode}`).expect(200);
      expect(found.body[0]).toMatchObject({ itemId: pr.otc.id, price: 10, salesClass: 'OTC', available: 310 });
      const r = await sale({ lines: [{ itemId: pr.otc.id, quantity: 7 }], payments: [{ modeCode: 'CASH', amount: 100 }] }).expect(201);
      expect(r.body).toMatchObject({ total: 70, change: 30, status: 'COMPLETED', offline: false });
      expect(r.body.invoice).toMatchObject({ source: 'OTC', totalAmount: 70, etimsStatus: 'ACCEPTED', cuInvoiceNo: expect.stringMatching(/^KRACU/) });
      expect(r.body.invoice.lines[0].allocations).toEqual([expect.objectContaining({ batchId: pr.otc.early, quantity: 7 })]);
      // VAT category on a standard-rated item.
      const v = await sale({ lines: [{ itemId: pr.vat.id, quantity: 1 }], payments: [{ modeCode: 'CASH', amount: 116 }] }).expect(201);
      expect(v.body.invoice).toMatchObject({ totalAmount: 116, totalTax: 16 });
      expect(v.body.invoice.lines[0]).toMatchObject({ taxTypeCode: 'B' });
    });

    it('blocks controlled drugs; prescription-only needs a prescription and a pharmacist; pharmacy-only needs a pharmacist; quantity limits apply', async () => {
      const cd = await sale({ lines: [{ itemId: pr.cd.id, quantity: 1 }], payments: [{ modeCode: 'CASH', amount: 50 }] }).expect(400);
      expect(cd.body.message).toMatch(/controlled drug/);
      const pom = { lines: [{ itemId: pr.pom.id, quantity: 2 }], payments: [{ modeCode: 'CASH', amount: 60 }] };
      expect((await sale(pom).expect(400)).body.code).toBe('PRESCRIPTION_REQUIRED');
      expect((await sale({ ...pom, prescriptionRef: 'RX-123' }).expect(403)).body.code).toBe('APPROVAL_REQUIRED');
      expect((await sale({ ...pom, prescriptionRef: 'RX-123', pharmacist: { username: 'pharmacist', password: 'wrong' } }).expect(400)).body.code).toBe('APPROVER_INVALID');
      await sale({ ...pom, prescriptionRef: 'RX-123', pharmacist: { username: 'pharm.tech', password: TEST_PASSWORD } }).expect(403); // not a pharmacist
      const ok = await sale({ ...pom, prescriptionRef: 'RX-123', pharmacist: pharmacistCreds }).expect(201);
      expect(ok.body).toMatchObject({ prescriptionRef: 'RX-123', pharmacistId: expect.any(String) });
      expect(ok.body.events).toEqual([expect.objectContaining({ type: 'PHARMACIST_APPROVAL', reason: 'RX-123' })]);
      await sale({ lines: [{ itemId: pr.plain.id, quantity: 1 }], payments: [{ modeCode: 'CASH', amount: 5 }] }).expect(403); // default class P
      await sale({ lines: [{ itemId: pr.plain.id, quantity: 1 }], payments: [{ modeCode: 'CASH', amount: 5 }] }, 'pharmacist').expect(409); // the pharmacist has no shift here
      const lim = await sale({ lines: [{ itemId: pr.limited.id, quantity: 21 }], payments: [{ modeCode: 'CASH', amount: 42 }] }).expect(400);
      expect(lim.body.message).toMatch(/at most 20 per sale/);
      await sale({ lines: [{ itemId: pr.limited.id, quantity: 20 }], payments: [{ modeCode: 'CASH', amount: 40 }] }).expect(201);
    });

    it('checks the basket for interactions: a blocking one needs a pharmacist and a reason', async () => {
      const lines = [{ itemId: pr.otc.id, quantity: 1 }, { itemId: pr.p.id, quantity: 1 }];
      const chk = await c.cashier.post('/pos/check', { terminalId, lines }).expect(200);
      expect(chk.body.needs).toMatchObject({ pharmacist: true, interactionReason: true, prescription: false });
      expect(chk.body.alerts).toEqual([expect.objectContaining({ type: 'INTERACTION', severity: 'MAJOR', blocking: true })]);
      const body = { lines, payments: [{ modeCode: 'CASH', amount: 30 }], pharmacist: pharmacistCreds };
      expect((await sale(body).expect(409)).body.code).toBe('INTERACTION_BLOCKED');
      const ok = await sale({ ...body, interactionOverrideReason: 'Short course; customer counselled' }).expect(201);
      expect(ok.body.events.map((e: { type: string }) => e.type).sort()).toEqual(['INTERACTION_OVERRIDE', 'PHARMACIST_APPROVAL']);
    });

    it('applies promotions automatically; manual discounts above the role limit need a supervisor', async () => {
      await c.cashier.post('/pos/promotions', { code: 'X', name: 'x', itemId: pr.otc.id, discountPercent: 20, startsOn: day(-1), endsOn: day(5) }).expect(403);
      await c.admin.post('/pos/promotions', { code: uniq('PR'), name: 'Posamol week', itemId: pr.limited.id, discountPercent: 20, minQty: 10, startsOn: day(-1), endsOn: day(5) }).expect(201);
      const chk = await c.cashier.post('/pos/check', { terminalId, lines: [{ itemId: pr.limited.id, quantity: 10 }, { itemId: pr.limited.id, quantity: 5 }] }).expect(200);
      expect(chk.body.lines.map((l: { discountPercent: number; gross: number }) => [l.discountPercent, l.gross])).toEqual([[20, 16], [0, 10]]);
      expect(chk.body).toMatchObject({ total: 26, discountAmount: 4, maxDiscountPercent: 5 });
      const disc = { lines: [{ itemId: pr.otc.id, quantity: 10, discountPercent: 10 }], payments: [{ modeCode: 'CASH', amount: 90 }] };
      expect((await sale(disc).expect(403)).body.code).toBe('APPROVAL_REQUIRED');
      const ok = await sale({ ...disc, supervisor: pharmacistCreds }).expect(201);
      expect(ok.body).toMatchObject({ total: 90, discountAmount: 10, overrideBy: expect.any(String) });
      expect(ok.body.events).toEqual([expect.objectContaining({ type: 'DISCOUNT_OVERRIDE', amount: 10 })]);
      await sale({ lines: [{ itemId: pr.otc.id, quantity: 10, discountPercent: 5 }], payments: [{ modeCode: 'CASH', amount: 95 }] }).expect(201); // within the limit
      // Payments must cover the total; only cash may exceed it.
      await sale({ lines: [{ itemId: pr.otc.id, quantity: 1 }], payments: [{ modeCode: 'CASH', amount: 5 }] }).expect(400);
      await sale({ lines: [{ itemId: pr.otc.id, quantity: 1 }], payments: [{ modeCode: 'CARD', amount: 20, reference: '1234' }] }).expect(400);
    });
  });

  describe('M-Pesa', () => {
    it('STK push paid by the customer settles the sale with its receipt; a payment is used once', async () => {
      await c.cashier.post('/pos/mpesa/stk', { terminalId, phone: '0700', amount: 50 }).expect(400);
      const push = await c.cashier.post('/pos/mpesa/stk', { terminalId, phone: '0712 345 678', amount: 50 }).expect(201);
      expect(mpesa.pushes.at(-1)).toMatchObject({ phone: '254712345678', amount: 50 });
      const st = await c.cashier.get(`/pos/mpesa/${push.body.id}`).expect(200);
      expect(st.body).toMatchObject({ status: 'SUCCESS', receiptNo: expect.stringMatching(/^MCK/) });
      const r = await sale({ lines: [{ itemId: pr.otc.id, quantity: 5 }], payments: [{ modeCode: 'MPESA', amount: 50, mpesaTransactionId: push.body.id }] }).expect(201);
      expect(r.body.invoice.payments).toEqual([expect.objectContaining({ modeCode: 'MPESA', amount: 50, reference: st.body.receiptNo })]);
      expect((await sale({ lines: [{ itemId: pr.otc.id, quantity: 5 }], payments: [{ modeCode: 'MPESA', amount: 50, mpesaTransactionId: push.body.id }] }).expect(409)).body.code).toBe('MPESA_ALREADY_USED');
    });

    it('failed and cancelled prompts cannot pay; a late callback (signed by the path token) completes a pending one', async () => {
      const poor = await c.cashier.post('/pos/mpesa/stk', { terminalId, phone: '0712345000', amount: 20 }).expect(201);
      expect((await c.cashier.get(`/pos/mpesa/${poor.body.id}`).expect(200)).body.status).toBe('FAILED');
      const cancel = await c.cashier.post('/pos/mpesa/stk', { terminalId, phone: '0712345111', amount: 20 }).expect(201);
      expect((await c.cashier.get(`/pos/mpesa/${cancel.body.id}`).expect(200)).body.status).toBe('CANCELLED');
      await sale({ lines: [{ itemId: pr.otc.id, quantity: 2 }], payments: [{ modeCode: 'MPESA', amount: 20, mpesaTransactionId: cancel.body.id }] }).expect(400);
      expect((await c.cashier.post('/pos/mpesa/stk', { terminalId, phone: '0712345333', amount: 20 }).expect(400)).body.code).toBe('MPESA_REJECTED');

      const slow = await c.cashier.post('/pos/mpesa/stk', { terminalId, phone: '0712345222', amount: 20 }).expect(201);
      expect(slow.body.status).toBe('PENDING');
      const body = { Body: { stkCallback: { MerchantRequestID: 'x', CheckoutRequestID: slow.body.checkoutRequestId, ResultCode: 0, ResultDesc: 'ok', CallbackMetadata: { Item: [{ Name: 'Amount', Value: 20 }, { Name: 'MpesaReceiptNumber', Value: 'SLW1234567' }, { Name: 'TransactionDate', Value: 20261026101500 }, { Name: 'PhoneNumber', Value: 254712345222 }] } } } };
      const server = ctx.app.getHttpServer();
      await request(server).post(`${API}/callbacks/mpesa/stk/wrong-token`).send(body).expect(404);
      const ack = await request(server).post(`${API}/callbacks/mpesa/stk/${token}`).send(body).expect(200);
      expect(ack.body).toEqual({ ResultCode: 0, ResultDesc: 'Accepted' });
      expect((await c.cashier.get(`/pos/mpesa/${slow.body.id}`).expect(200)).body).toMatchObject({ status: 'SUCCESS', receiptNo: 'SLW1234567', transactionDate: '2026-10-26T07:15:00.000Z' });
    });

    it('C2B confirmations can be picked by code; an unknown typed code is accepted but flagged for cash-up', async () => {
      const server = ctx.app.getHttpServer();
      await request(server).post(`${API}/callbacks/mpesa/c2b/validation/${token}`).send({}).expect(200);
      await request(server).post(`${API}/callbacks/mpesa/c2b/confirmation/${token}`).send({ TransID: 'C2BABC1234', TransAmount: '30.00', MSISDN: '254722000111', FirstName: 'Jane', TransTime: '20261026101500', BusinessShortCode: '174379' }).expect(200);
      const list = await c.cashier.get('/pos/mpesa/confirmations').expect(200);
      expect(list.body).toEqual(expect.arrayContaining([expect.objectContaining({ receiptNo: 'C2BABC1234', amount: 30, payerName: 'Jane' })]));
      const r = await sale({ lines: [{ itemId: pr.otc.id, quantity: 3 }], payments: [{ modeCode: 'MPESA', amount: 30, reference: 'c2babc1234' }] }).expect(201);
      expect(r.body.warnings).toEqual([]);
      const typed = await sale({ lines: [{ itemId: pr.otc.id, quantity: 1 }], payments: [{ modeCode: 'MPESA', amount: 10, reference: 'TYPED00001' }] }).expect(201);
      expect(typed.body.warnings).toEqual([expect.stringMatching(/not yet confirmed/)]);
      // Split payment: cash and card.
      const split = await sale({ lines: [{ itemId: pr.otc.id, quantity: 4 }], payments: [{ modeCode: 'CARD', amount: 25, reference: 'VISA-0099' }, { modeCode: 'CASH', amount: 20 }] }).expect(201);
      expect(split.body).toMatchObject({ change: 5 });
      expect(split.body.invoice.payments.map((p: { modeCode: string; amount: number }) => [p.modeCode, p.amount]).sort()).toEqual([['CARD', 25], ['CASH', 15]]);
    });
  });

  describe('customers', () => {
    let customerId: string;
    it('credit accounts within the limit; payments on account at the till; loyalty earned and redeemed', async () => {
      await c.cashier.post('/pos/customers', { name: 'Beta Ltd', phone: '0733000999', creditAllowed: true, creditLimit: 500 }).expect(400); // credit is set by managers
      customerId = (await c.admin.post('/pos/customers', { name: 'Beta Ltd', phone: '0733000999', creditAllowed: true, creditLimit: 500 }).expect(201)).body.id;
      await sale({ lines: [{ itemId: pr.otc.id, quantity: 30 }], payments: [{ modeCode: 'CREDIT', amount: 300 }] }).expect(400); // no customer
      const r = await sale({ customerId, lines: [{ itemId: pr.otc.id, quantity: 30 }], payments: [{ modeCode: 'CREDIT', amount: 300 }] }).expect(201);
      expect(r.body).toMatchObject({ pointsEarned: 0 });
      await sale({ customerId, lines: [{ itemId: pr.otc.id, quantity: 30 }], payments: [{ modeCode: 'CREDIT', amount: 300 }] }).expect(400); // over the limit
      const st = await c.cashier.post(`/pos/customers/${customerId}/payments`, { amount: 100, modeCode: 'CASH', terminalId }).expect(201);
      expect(st.body).toMatchObject({ balance: 200 });
      // Cash sale earns points (1 per 100); points pay later.
      const earn = await sale({ customerId, lines: [{ itemId: pr.otc.id, quantity: 60 }], payments: [{ modeCode: 'CASH', amount: 600 }] }).expect(201);
      expect(earn.body.pointsEarned).toBe(6);
      await q(`UPDATE customer SET loyalty_points = 60 WHERE id = $1`, [customerId]);
      await sale({ customerId, redeemPoints: 10, lines: [{ itemId: pr.otc.id, quantity: 6 }], payments: [{ modeCode: 'CASH', amount: 50 }] }).expect(400); // below minimum
      const red = await sale({ customerId, redeemPoints: 50, lines: [{ itemId: pr.otc.id, quantity: 6 }], payments: [{ modeCode: 'CASH', amount: 10 }] }).expect(201);
      expect(red.body.invoice.payments.map((p: { modeCode: string; amount: number }) => [p.modeCode, p.amount]).sort()).toEqual([['CASH', 10], ['LOYALTY', 50]]);
      expect((await one(`SELECT loyalty_points FROM customer WHERE id = $1`, [customerId])).loyalty_points).toBe(10);
      // A new customer can be captured with the sale (B2B: with a KRA PIN on the invoice).
      const nc = await sale({ newCustomer: { name: 'Gamma Traders', phone: '0700111222', kraPin: 'P051234567X' }, lines: [{ itemId: pr.otc.id, quantity: 1 }], payments: [{ modeCode: 'CASH', amount: 10 }] }).expect(201);
      expect(nc.body.invoice).toMatchObject({ customerName: 'Gamma Traders', customerPin: 'P051234567X' });
    });
  });

  describe('offline', () => {
    it('the till catalog has what an offline till needs; offline sales sync once each; refused ones are logged', async () => {
      const cat = await c.cashier.get(`/pos/terminals/${terminalId}/catalog`).expect(200);
      expect(cat.body.items.find((x: { itemId: string }) => x.itemId === pr.limited.id)).toMatchObject({ price: 2, salesClass: 'OTC', maxQtyPerSale: 20, promotion: null });
      expect(cat.body.customers.some((x: { name: string }) => x.name === 'Beta Ltd')).toBe(true);
      expect(cat.body).toMatchObject({ discountLimit: 5, paymentModes: expect.arrayContaining([expect.objectContaining({ code: 'MPESA' })]) });

      const at = new Date(Date.now() - 3_600_000).toISOString();
      const a = { terminalId, clientRef: randomUUID(), soldAt: at, offline: true, lines: [{ itemId: pr.otc.id, quantity: 2 }], payments: [{ modeCode: 'CASH', amount: 20 }] };
      const b = { ...a, clientRef: randomUUID(), payments: [{ modeCode: 'MPESA', amount: 20, reference: 'OFFLINE001' }] };
      const bad = { ...a, clientRef: randomUUID(), lines: [{ itemId: pr.cd.id, quantity: 1 }] };
      const tooOld = { ...a, clientRef: randomUUID(), soldAt: new Date(Date.now() - 100 * 3_600_000).toISOString() };
      const r1 = await c.cashier.post('/pos/sales/sync', { sales: [a, b, bad, tooOld] }).expect(200);
      expect(r1.body).toMatchObject({ created: 2, duplicates: 0, rejected: 2 });
      expect(r1.body.results.find((x: { clientRef: string }) => x.clientRef === bad.clientRef).error).toMatch(/controlled/);
      const r2 = await c.cashier.post('/pos/sales/sync', { sales: [a, b] }).expect(200);
      expect(r2.body).toMatchObject({ created: 0, duplicates: 2 });
      expect((await one(`SELECT count(*)::int AS n FROM pos_sale WHERE client_ref = ANY($1)`, [[a.clientRef, b.clientRef]])).n).toBe(2);
      const synced = await one(`SELECT ps.offline, ps.sold_at, si.etims_status FROM pos_sale ps JOIN sales_invoice si ON si.id = ps.invoice_id WHERE ps.client_ref = $1`, [a.clientRef]);
      expect(synced).toMatchObject({ offline: true, etims_status: 'ACCEPTED' });
      expect(new Date(synced.sold_at).toISOString()).toBe(at);
      expect((await one(`SELECT count(*)::int AS n FROM pos_event WHERE type = 'OFFLINE_REJECTED'`)).n).toBeGreaterThanOrEqual(2);
    });
  });

  describe('voids, refunds and cash-up', () => {
    it('voids (with a supervisor) and refunds (credit notes, stock back), all logged', async () => {
      const s = await sale({ lines: [{ itemId: pr.otc.id, quantity: 4 }, { itemId: pr.limited.id, quantity: 5 }], payments: [{ modeCode: 'CASH', amount: 50 }] }).expect(201);
      const stock = async () => (await one(`SELECT SUM(on_hand)::float AS q FROM stock_balance WHERE item_id = $1 AND store_id = $2`, [pr.otc.id, ids.OPD])).q;
      const before = await stock();
      await c.cashier.post(`/pos/sales/${s.body.id}/void`, { reason: 'Customer changed mind' }).expect(403);
      const v = await c.cashier.post(`/pos/sales/${s.body.id}/void`, { reason: 'Customer changed mind', supervisor: pharmacistCreds }).expect(200);
      expect(v.body).toMatchObject({ status: 'VOIDED' });
      expect(v.body.invoice.creditNotes).toEqual([expect.objectContaining({ totalAmount: 50 })]);
      expect(await stock()).toBe(before + 4);
      await c.cashier.post(`/pos/sales/${s.body.id}/void`, { reason: 'again', supervisor: pharmacistCreds }).expect(409);

      const s2 = await sale({ lines: [{ itemId: pr.otc.id, quantity: 10 }], payments: [{ modeCode: 'CASH', amount: 100 }] }).expect(201);
      await c.cashier.post(`/pos/sales/${s2.body.id}/refund`, { lines: [{ invoiceLineId: s2.body.invoice.lines[0].id, quantity: 3 }], reason: 'Unopened' }).expect(403);
      const rf = await c.pharmacist.post(`/pos/sales/${s2.body.id}/refund`, { lines: [{ invoiceLineId: s2.body.invoice.lines[0].id, quantity: 3 }], reason: 'Unopened' }).expect(200);
      expect(rf.body).toMatchObject({ status: 'PARTLY_REFUNDED' });
      expect(rf.body.events).toEqual([expect.objectContaining({ type: 'REFUND', amount: 30 })]);
      await expect(q(`UPDATE pos_event SET amount = 0 WHERE sale_id = $1`, [s2.body.id])).rejects.toThrow(/cannot be changed/);
    });

    it('the X report runs live; closing with the right cash needs nobody; a variance waits for a supervisor', async () => {
      const x = (await c.cashier.get(`/pos/shifts/${shiftId}`).expect(200)).body.report;
      expect(x.byMode.map((r: { mode: string }) => r.mode)).toEqual(expect.arrayContaining(['CASH', 'MPESA', 'CARD', 'CREDIT', 'LOYALTY']));
      expect(x.voids).toMatchObject({ count: 1, amount: 50, cash: 50 });
      expect(x.refunds).toMatchObject({ count: 0 }); // the pharmacist refunded without a shift of their own
      expect(x.accountPayments).toMatchObject({ count: 1, cash: 100 });
      expect(x.unverifiedMpesa.map((u: { receiptNo: string }) => u.receiptNo)).toEqual(expect.arrayContaining(['TYPED00001', 'OFFLINE001']));
      expect(x.sales.offline).toBe(2);
      const cash = x.byMode.find((r: { mode: string }) => r.mode === 'CASH').amount;
      expect(x.expectedCash).toBe(1000 + cash + 100 - 50);

      await c.cashier.post(`/pos/shifts/${shiftId}/close`, { countedCash: x.expectedCash, denominations: { '1000': 1 } }).expect(400);
      const closed = await c.cashier.post(`/pos/shifts/${shiftId}/close`, { countedCash: x.expectedCash - 200, note: 'Short' }).expect(200);
      expect(closed.body).toMatchObject({ status: 'CLOSED', variance: -200, varianceStatus: 'PENDING', report: expect.objectContaining({ countedCash: x.expectedCash - 200, variance: -200 }) });
      await sale({ lines: [{ itemId: pr.otc.id, quantity: 1 }], payments: [{ modeCode: 'CASH', amount: 10 }] }).expect(409);
      await c.cashier.post(`/pos/shifts/${shiftId}/variance`, { approve: true, note: 'ok' }).expect(403);
      const dec = await c.finance.post(`/pos/shifts/${shiftId}/variance`, { approve: false, note: 'Recover from cashier per policy' }).expect(200);
      expect(dec.body).toMatchObject({ varianceStatus: 'REJECTED', decisionNote: 'Recover from cashier per policy' });
      const pending = await c.finance.get('/pos/shifts?varianceStatus=REJECTED').expect(200);
      expect(pending.body.some((s: { id: string }) => s.id === shiftId)).toBe(true);
      // A balanced shift closes without a decision.
      const s2 = await c.cashier.post('/pos/shifts', { terminalId, openingFloat: 500 }).expect(201);
      await sale({ lines: [{ itemId: pr.otc.id, quantity: 2 }], payments: [{ modeCode: 'CASH', amount: 20 }] }).expect(201);
      const c2 = await c.cashier.post(`/pos/shifts/${s2.body.id}/close`, { countedCash: 520, denominations: { '500': 1, '20': 1 } }).expect(200);
      expect(c2.body).toMatchObject({ variance: 0, varianceStatus: 'NONE' });
    });

    it('reports sales by cashier, item, payment mode and hour with OTC margin; and voids, refunds and overrides', async () => {
      const from = day(-1);
      const to = day(1);
      await c.cashier.get(`/pos/reports/sales?from=${from}&to=${to}&groupBy=item`).expect(403);
      const byItem = await c.finance.get(`/pos/reports/sales?from=${from}&to=${to}&groupBy=item&storeId=${ids.OPD}`).expect(200);
      const otc = byItem.body.find((r: { key: string; quantity: number }) => r.key.includes("Posamol") && r.quantity > 100);
      expect(otc).toMatchObject({ cost: expect.any(Number), margin: expect.any(Number) });
      expect(otc.margin).toBeCloseTo(otc.net - otc.cost, 1);
      expect(otc.marginPct).toBeGreaterThan(0);
      const byCashier = await c.finance.get(`/pos/reports/sales?from=${from}&to=${to}&groupBy=cashier`).expect(200);
      expect(byCashier.body.map((r: { key: string }) => r.key)).toContain('Mutua Cashier');
      const byMode = await c.finance.get(`/pos/reports/sales?from=${from}&to=${to}&groupBy=mode`).expect(200);
      expect(byMode.body.map((r: { key: string }) => r.key)).toEqual(expect.arrayContaining(['CASH', 'MPESA', 'CARD', 'CREDIT', 'LOYALTY']));
      const hours = await c.finance.get(`/pos/reports/sales?from=${from}&to=${to}&groupBy=hour`).expect(200);
      expect(hours.body[0].key).toMatch(/^\d{2}:00$/);
      const csv = await c.finance.get(`/pos/reports/sales?from=${from}&to=${to}&groupBy=category&format=csv`).expect(200);
      expect(csv.headers['content-type']).toMatch(/text\/csv/);
      const ev = await c.finance.get(`/pos/reports/events?from=${from}&to=${to}`).expect(200);
      const types = ev.body.map((e: { type: string }) => e.type);
      expect(types).toEqual(expect.arrayContaining(['VOID_SALE', 'REFUND', 'DISCOUNT_OVERRIDE', 'PHARMACIST_APPROVAL', 'INTERACTION_OVERRIDE', 'ACCOUNT_PAYMENT', 'OFFLINE_REJECTED']));
      expect(ev.body.find((e: { type: string }) => e.type === 'VOID_SALE')).toMatchObject({ user: 'Mutua Cashier', approvedBy: 'Otieno Pharmacist', refundMode: 'CASH' });
    });
  });
});
