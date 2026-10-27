import { PaymentMethod } from '@sil/shared';
import { DarajaPayoutGateway, parsePayoutResult, sharedMockPayouts } from '../src/modules/payments/mpesa-payouts';
import { normalisePayee } from '../src/modules/payments/payout-rules';
import { parseCsv } from '../src/modules/payments/reconciliation.service';
import request from 'supertest';
import { API, Client, createTestApp, idByCode, loggedIn, TestContext, uniq } from './helpers';

const day = (d = 0) =>
  new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Nairobi', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(Date.now() + d * 86_400_000));

const bin = (c: Client, path: string) =>
  c.get(path).buffer(true).parse((r, cb) => {
    const chunks: Buffer[] = [];
    r.on('data', (d: Buffer) => chunks.push(d));
    r.on('end', () => cb(null, Buffer.concat(chunks)));
  });

// ------------------------------------------------------------------ unit

describe('M-PESA payouts (unit)', () => {
  const cfg = {
    mode: 'sandbox' as const,
    baseUrl: 'https://sandbox.example',
    consumerKey: 'ck',
    consumerSecret: 'cs',
    shortcode: '600981',
    initiatorName: 'testapi',
    securityCredential: 'SECRET-CREDENTIAL',
    callbackBaseUrl: 'https://hospital.example',
    callbackToken: 'tok',
    callbackAllowedIps: [],
    timeoutMs: 1000,
  };
  const urls = { result: 'https://h/result', timeout: 'https://h/timeout', status: (id: string) => `https://h/status/${id}`, reversal: (id: string) => `https://h/rev/${id}` };
  const realFetch = global.fetch;
  afterEach(() => {
    global.fetch = realFetch;
  });

  it('caches the OAuth token, sends B2C / B2B to the right APIs and never keeps the security credential', async () => {
    const calls: { url: string; body?: Record<string, unknown> }[] = [];
    global.fetch = jest.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      if (url.includes('/oauth/')) return new Response(JSON.stringify({ access_token: 'T', expires_in: '3599' }), { status: 200 });
      return new Response(JSON.stringify({ ConversationID: 'AG_1', OriginatorConversationID: 'x', ResponseCode: '0', ResponseDescription: 'Accept the service request successfully.' }), { status: 200 });
    }) as unknown as typeof fetch;
    const g = new DarajaPayoutGateway(cfg, urls);
    const b2c = await g.dispatch({ originatorConversationId: 'PV1-1-a', method: PaymentMethod.MPESA_B2C, commandId: 'BusinessPayment', amount: 1500, partyB: '254708374149', accountRef: null, remarks: 'PV1' });
    const b2b = await g.dispatch({ originatorConversationId: 'PV2-1-b', method: PaymentMethod.MPESA_TILL, commandId: 'BusinessBuyGoods', amount: 2500, partyB: '174379', accountRef: null, remarks: 'PV2' });
    expect(calls.filter((c) => c.url.includes('/oauth/'))).toHaveLength(1);
    expect(calls[1]).toMatchObject({ url: 'https://sandbox.example/mpesa/b2c/v3/paymentrequest', body: { OriginatorConversationID: 'PV1-1-a', CommandID: 'BusinessPayment', Amount: 1500, PartyA: '600981', PartyB: '254708374149', ResultURL: 'https://h/result', SecurityCredential: 'SECRET-CREDENTIAL' } });
    expect(calls[2]).toMatchObject({ url: 'https://sandbox.example/mpesa/b2b/v1/paymentrequest', body: { CommandID: 'BusinessBuyGoods', RecieverIdentifierType: '2', PartyB: '174379' } });
    expect(b2c).toMatchObject({ outcome: 'ACCEPTED', conversationId: 'AG_1' });
    expect(JSON.stringify(b2c)).not.toContain('SECRET-CREDENTIAL');
    expect(JSON.stringify(b2b)).not.toContain('SECRET-CREDENTIAL');
  });

  it('a timeout or a 5xx is UNKNOWN (never "failed"); a 4xx is REJECTED', async () => {
    const answers = [
      () => {
        throw new Error('The operation was aborted due to timeout');
      },
      () => new Response('{}', { status: 503 }),
      () => new Response(JSON.stringify({ errorCode: '400.002.02', errorMessage: 'Bad Request - Invalid PartyB' }), { status: 400 }),
    ];
    let i = 0;
    global.fetch = jest.fn(async (url: string) => {
      if (url.includes('/oauth/')) return new Response(JSON.stringify({ access_token: 'T', expires_in: '3599' }), { status: 200 });
      return answers[i++]();
    }) as unknown as typeof fetch;
    const g = new DarajaPayoutGateway(cfg, urls);
    const req = { originatorConversationId: 'o', method: PaymentMethod.MPESA_B2C, commandId: 'BusinessPayment', amount: 10, partyB: '254708374149', accountRef: null, remarks: 'x' };
    expect((await g.dispatch(req)).outcome).toBe('UNKNOWN');
    expect((await g.dispatch(req)).outcome).toBe('UNKNOWN');
    expect(await g.dispatch(req)).toMatchObject({ outcome: 'REJECTED', code: '400.002.02' });
  });

  it('parses B2C and B2B results (receipt, recipient, charges, completion time)', () => {
    const b2c = parsePayoutResult({
      Result: {
        ResultType: 0, ResultCode: 0, ResultDesc: 'ok', OriginatorConversationID: 'o1', ConversationID: 'c1', TransactionID: 'NLJ7RT61SV',
        ResultParameters: { ResultParameter: [{ Key: 'TransactionAmount', Value: 10 }, { Key: 'TransactionReceipt', Value: 'NLJ7RT61SV' }, { Key: 'ReceiverPartyPublicName', Value: '254708374149 - John Doe' }, { Key: 'TransactionCompletedDateTime', Value: '19.12.2026 11:45:50' }] },
      },
    });
    expect(b2c).toMatchObject({ resultCode: '0', receiptNo: 'NLJ7RT61SV', amount: 10, recipientName: 'John Doe', completedAt: new Date('2026-12-19T08:45:50Z') });
    const b2b = parsePayoutResult({ Result: { ResultCode: 0, ResultDesc: 'ok', ConversationID: 'c2', TransactionID: 'QKA81LK5CY', ResultParameters: { ResultParameter: [{ Key: 'Amount', Value: 5000 }, { Key: 'DebitPartyCharges', Value: 'Business Pay Bill Charge|KES|77.00' }, { Key: 'TransCompletedTime', Value: '20261027101530' }] } } });
    expect(b2b).toMatchObject({ receiptNo: 'QKA81LK5CY', charges: 77, amount: 5000 });
  });

  it('validates and normalises payees', () => {
    expect(normalisePayee(PaymentMethod.MPESA_B2C, { payeePhone: '0712 345 678' }).payeePhone).toBe('254712345678');
    expect(normalisePayee(PaymentMethod.MPESA_B2C, { payeePhone: '+254 110 123456' }).payeePhone).toBe('254110123456');
    expect(() => normalisePayee(PaymentMethod.MPESA_B2C, { payeePhone: '0812345678' })).toThrow(/not a Kenyan mobile/);
    expect(() => normalisePayee(PaymentMethod.MPESA_PAYBILL, { payeeShortcode: '888880' })).toThrow(/account/);
    expect(normalisePayee(PaymentMethod.MPESA_TILL, { payeeShortcode: '174379' })).toEqual({ payeePhone: null, payeeShortcode: '174379', payeeAccountRef: null });
  });

  it('reads quoted CSV', () => {
    expect(parseCsv('a,"b, c",d\r\n1,"say ""hi""",3\n')).toEqual([['a', 'b, c', 'd'], ['1', 'say "hi"', '3']]);
  });
});

// ------------------------------------------------------------------ integration

describe('Non-stock procurement phase 4: payments and M-PESA payouts', () => {
  let ctx: TestContext;
  const c: Record<string, Client> = {};
  const ids: Record<string, string> = {};
  const q = async (sql: string, p: unknown[] = []) => ctx.ds.query(sql, p);
  const one = async (sql: string, p: unknown[] = []) => (await q(sql, p))[0];
  const setting = (key: string, value: unknown) => q(`UPDATE system_setting SET value = $2::jsonb WHERE key = $1`, [key, JSON.stringify(value)]);
  const TOKEN = 'mock-callback-token';

  /** An approved invoice of the test supplier on the test order. */
  const invoice = async (total: number, wht = 0, dueInDays = 30) =>
    (
      await one(
        `INSERT INTO supplier_invoice (number, supplier_id, supplier_invoice_no, purchase_order_id, invoice_date, due_date, status, match_status, subtotal, tax_total, total, currency, exchange_rate, base_total, wht_total, captured_by)
         VALUES ($1, $2, $3, $4, $5, $6, 'APPROVED', 'MATCHED', $7, 0, $7, 'KES', 1, $7, $8, $9) RETURNING id`,
        [uniq('INV'), ids.supplier, uniq('SI'), ids.po, day(-50), day(dueInDays), total, wht, ids.accountantId],
      )
    ).id as string;

  /** Draft → approved by the finance manager. */
  const approvedVoucher = async (body: Record<string, unknown>) => {
    const v = (await c.accountant.post('/payment-vouchers', { supplierId: ids.supplier, ...body }).expect(201)).body;
    await c.accountant.post(`/payment-vouchers/${v.id}/submit`).expect(200);
    const ar = await one(`SELECT id FROM approval_request WHERE document_id = $1 AND status = 'PENDING'`, [v.id]);
    await c['finance.manager'].post(`/approvals/${ar.id}/approve`, {}).expect(200);
    return v.id as string;
  };
  const voucher = async (id: string) => (await c.finance.get(`/payment-vouchers/${id}`).expect(200)).body;
  const due = () => q(`UPDATE mpesa_payout SET next_check_at = now() - interval '1 second' WHERE next_check_at IS NOT NULL`);

  beforeAll(async () => {
    ctx = await createTestApp();
    sharedMockPayouts.reset();
    for (const u of ['admin', 'accountant', 'finance', 'finance.manager', 'proc.officer', 'storekeeper', 'ward.nurse', 'ward.incharge']) c[u] = await loggedIn(ctx, u);
    ids.accountantId = (await one(`SELECT id FROM app_user WHERE username = 'accountant'`)).id;
    ids.supplier = (await one(`SELECT id FROM supplier WHERE status = 'ACTIVE' ORDER BY code DESC LIMIT 1`)).id;
    ids.other = (await one(`SELECT id FROM supplier WHERE status = 'ACTIVE' AND id <> $1 ORDER BY code LIMIT 1`, [ids.supplier])).id;
    // An order to hang the invoices on (a service requisition → PR → direct LSO).
    const MS = await idByCode(ctx.ds, 'store', 'MS');
    const req = (await c['ward.nurse'].post('/staff-requisitions', { departmentId: await idByCode(ctx.ds, 'department', 'IPD-MED'), justification: 'Phase 4', submit: true, lines: [{ lineType: 'SERVICE', description: 'Generator service', quantity: 1, estimatedUnitCost: 30_000 }] }).expect(201)).body;
    const arReq = await one(`SELECT id FROM approval_request WHERE document_id = $1 AND status = 'PENDING'`, [req.id]);
    await c['ward.incharge'].post(`/approvals/${arReq.id}/approve`, {}).expect(200);
    const full = (await c['ward.nurse'].get(`/staff-requisitions/${req.id}`).expect(200)).body;
    const pr = (await c['proc.officer'].post('/staff-requisitions/consolidate', { lineIds: full.lines.map((l: { id: string }) => l.id), departmentId: await idByCode(ctx.ds, 'department', 'ADMIN'), storeId: MS, justification: 'Phase 4' }).expect(201)).body;
    await c['proc.officer'].post(`/requisitions/${pr.id}/submit`).expect(200);
    for (let i = 0; i < 3; i++) {
      const ar = await one(`SELECT r.id, s.role_id FROM approval_request r JOIN approval_step s ON s.workflow_id = r.workflow_id AND s.sequence = r.current_step WHERE r.document_id = $1 AND r.status = 'PENDING'`, [pr.id]);
      if (!ar) break;
      const who = await one(`SELECT u.username FROM user_role ur JOIN app_user u ON u.id = ur.user_id WHERE ur.role_id = $1 AND u.is_active AND u.username <> 'proc.officer' AND u.id NOT IN (SELECT user_id FROM approval_action WHERE request_id = $2 AND user_id IS NOT NULL) ORDER BY u.username LIMIT 1`, [ar.role_id, ar.id]);
      if (!c[who.username]) c[who.username] = await loggedIn(ctx, who.username);
      await c[who.username].post(`/approvals/${ar.id}/approve`, {}).expect(200);
    }
    const prFull = (await c['proc.officer'].get(`/requisitions/${pr.id}`).expect(200)).body;
    ids.po = (await c['proc.officer'].post('/purchase-orders', { requisitionId: pr.id, supplierId: ids.supplier, lines: prFull.lines.map((l: { id: string }) => ({ requisitionLineId: l.id })) }).expect(201)).body.id;
    // The invoices below stand in for its received and approved bills.
    await q(`UPDATE purchase_order SET status = 'INVOICED' WHERE id = $1`, [ids.po]);
  });

  afterAll(async () => {
    await setting('payments.mpesaMaxAttempts', 3);
    await setting('payments.mpesaMaxStatusChecks', 6);
    await ctx.close();
  });

  describe('vouchers, approval and segregation of duties', () => {
    let a: string;
    let b: string;
    let pvId: string;

    it('lists payables with what is still to pay and ageing', async () => {
      a = await invoice(11_600, 500, -45); // 45 days overdue
      b = await invoice(23_200, 1_000, 10);
      const rows = (await c.accountant.get(`/payments/payables?supplierId=${ids.supplier}`).expect(200)).body;
      expect(rows.find((r: { id: string }) => r.id === a)).toMatchObject({ outstanding: 11_600, available: 11_600, bucket: '31-60' });
      expect(rows.find((r: { id: string }) => r.id === b)).toMatchObject({ bucket: 'CURRENT' });
    });

    it('validates the payee, the amounts and the batch', async () => {
      const bad = (body: Record<string, unknown>) => c.accountant.post('/payment-vouchers', { supplierId: ids.supplier, ...body });
      expect((await bad({ method: 'MPESA_PAYBILL', payeeShortcode: '888880', invoices: [{ invoiceId: a }] }).expect(400)).body.code).toBe('INVALID_PAYEE');
      expect((await bad({ method: 'MPESA_B2C', payeePhone: '0812345678', invoices: [{ invoiceId: a }] }).expect(400)).body.code).toBe('INVALID_PAYEE');
      expect((await bad({ method: 'EFT', invoices: [{ invoiceId: a, amount: 20_000 }] }).expect(400)).body.code).toBe('OVER_PAYMENT');
      await c.accountant.post('/payment-vouchers', { supplierId: ids.other, method: 'EFT', invoices: [{ invoiceId: a }] }).expect(400); // another supplier's invoice
      // WHT 500 on 11,600 leaves 11,100: M-PESA pays whole shillings, so this one is fine; a partial with cents is not.
      expect((await bad({ method: 'MPESA_TILL', payeeShortcode: '174379', invoices: [{ invoiceId: b, amount: 5_000 }] }).expect(400)).body.code).toBe('WHOLE_SHILLINGS');
    });

    it('batches invoices, with WHT in proportion; scheduled invoices cannot be paid twice', async () => {
      const v = (await c.accountant.post('/payment-vouchers', { supplierId: ids.supplier, method: 'EFT', invoices: [{ invoiceId: a }, { invoiceId: b, amount: 5_000 }], dueDate: day(3), narrative: 'October services' }).expect(201)).body;
      pvId = v.id;
      // b: 1,000 × 5,000 / 23,200 = 215.52 of WHT.
      expect(v).toMatchObject({ status: 'DRAFT', grossAmount: 16_600, whtAmount: 715.52, amount: 15_884.48, invoiceId: null });
      expect((await c.finance.get(`/invoices/${a}`).expect(200)).body.status).toBe('SCHEDULED');
      expect((await c.accountant.post('/payment-vouchers', { supplierId: ids.supplier, method: 'EFT', invoices: [{ invoiceId: a }] }).expect(400)).body.code).toBe('OVER_PAYMENT');
    });

    it('is blocked until every approval level is complete; preparer ≠ approver ≠ payer; blocked attempts are logged', async () => {
      const early = await c.finance.post(`/payment-vouchers/${pvId}/release`, { paymentReference: 'EFT-77' }).expect(409);
      expect(early.body.code).toBe('NOT_APPROVED');
      await c.accountant.post(`/payment-vouchers/${pvId}/submit`).expect(200);
      await c.finance.post(`/payment-vouchers/${pvId}/release`, { paymentReference: 'EFT-77' }).expect(409); // still pending
      const ar = await one(`SELECT id FROM approval_request WHERE document_id = $1 AND status = 'PENDING'`, [pvId]);
      await c.accountant.post(`/approvals/${ar.id}/approve`, {}).expect(403); // prepared it
      await c['finance.manager'].post(`/approvals/${ar.id}/approve`, {}).expect(200);
      expect((await voucher(pvId)).status).toBe('APPROVED');
      expect((await c.accountant.post(`/payment-vouchers/${pvId}/release`, { paymentReference: 'EFT-77' }).expect(403)).body.code).toBe('SEGREGATION_OF_DUTIES');
      expect((await c['finance.manager'].post(`/payment-vouchers/${pvId}/release`, { paymentReference: 'EFT-77' }).expect(403)).body.code).toBe('SEGREGATION_OF_DUTIES');
      await c['proc.officer'].post(`/payment-vouchers/${pvId}/release`, { paymentReference: 'EFT-77' }).expect(403); // no permission
      await c.finance.post(`/payment-vouchers/${pvId}/release`, {}).expect(400); // bank payments need the reference
      const blocked = await one(`SELECT COUNT(*)::int AS n FROM audit_log WHERE action = 'PAYMENT_RELEASE_BLOCKED' AND entity_id = $1`, [pvId]);
      expect(blocked.n).toBe(4);

      const paid = (await c.finance.post(`/payment-vouchers/${pvId}/release`, { paymentReference: 'EFT-77', paidOn: day() }).expect(200)).body;
      expect(paid).toMatchObject({ status: 'PAID', paymentReference: 'EFT-77', paidOn: day(), preparedByName: 'Atieno Accountant', releasedByName: 'Mwangi Finance' });
      expect((await c.finance.get(`/invoices/${a}`).expect(200)).body).toMatchObject({ status: 'PAID', paidAmount: 11_600 });
      expect((await c.finance.get(`/invoices/${b}`).expect(200)).body).toMatchObject({ status: 'PARTIALLY_PAID', paidAmount: 5_000 });
      const pdf = await bin(c.finance, `/payment-vouchers/${pvId}/pdf`).expect(200);
      expect((pdf.body as Buffer).subarray(0, 4).toString()).toBe('%PDF');
      const chain = (await c.finance.get(`/documents/chain?type=PV&id=${pvId}`).expect(200)).body;
      expect(chain.nodes.filter((n: { type: string }) => n.type === 'INV')).toHaveLength(2);
    });
  });

  describe('M-PESA', () => {
    it('B2B PayBill: dispatched once — double clicks and concurrent releases do not send it again; the callback pays it', async () => {
      const inv = await invoice(10_000);
      const id = await approvedVoucher({ method: 'MPESA_PAYBILL', payeeShortcode: '888880', payeeAccountRef: 'HOSP-001', invoices: [{ invoiceId: inv }] });
      const before = sharedMockPayouts.requests.length;
      const results = await Promise.all([1, 2, 3].map(() => c.finance.post(`/payment-vouchers/${id}/release`, {})));
      expect(results.map((r) => r.status).sort()).toEqual([200, 409, 409]);
      expect(sharedMockPayouts.requests.length).toBe(before + 1);
      const sent = sharedMockPayouts.requests[sharedMockPayouts.requests.length - 1];
      expect(sent).toMatchObject({ method: 'MPESA_PAYBILL', commandId: 'BusinessPayBill', amount: 10_000, partyB: '888880', accountRef: 'HOSP-001' });
      expect((await voucher(id)).status).toBe('PROCESSING');
      await c.finance.post(`/payment-vouchers/${id}/release`, {}).expect(409);

      const cb = sharedMockPayouts.callbackFor(sent.originatorConversationId)!;
      await request(ctx.app.getHttpServer()).post(`${API}/callbacks/mpesa-payouts/result/wrong-token`).send(cb.body).expect(404);
      const ack = await request(ctx.app.getHttpServer()).post(`${API}/callbacks/mpesa-payouts/result/${TOKEN}`).send(cb.body).expect(200);
      expect(ack.body).toEqual({ ResultCode: 0, ResultDesc: 'Accepted' });
      await request(ctx.app.getHttpServer()).post(`${API}/callbacks/mpesa-payouts/result/${TOKEN}`).send(cb.body).expect(200); // Daraja resends: no effect
      const v = await voucher(id);
      expect(v).toMatchObject({ status: 'PAID', paidOn: day() });
      expect(v.attempts).toEqual([expect.objectContaining({ attempt: 1, status: 'SUCCESS', charges: 52, recipientName: 'Mock Supplier Ltd', receiptNo: v.paymentReference })]);
      expect((await c.finance.get(`/invoices/${inv}`).expect(200)).body).toMatchObject({ status: 'PAID', paidAmount: 10_000 });
      const raw = await one(`SELECT request_body, result_body FROM mpesa_payout WHERE voucher_id = $1`, [id]);
      expect(raw.result_body.Result.ResultCode).toBe(0);
      ids.paybillVoucher = id;
    });

    it('B2C failure goes to the review queue, the reconcilers are told, and it can be released again', async () => {
      const inv = await invoice(4_000);
      const id = await approvedVoucher({ method: 'MPESA_B2C', payeePhone: '0712345000', invoices: [{ invoiceId: inv }] });
      await c.finance.post(`/payment-vouchers/${id}/release`, {}).expect(200);
      await sharedMockPayouts.deliverAll();
      const v = await voucher(id);
      expect(v.status).toBe('FAILED');
      expect(v.attempts[0]).toMatchObject({ status: 'FAILED', resultCode: '2001' });
      const review = (await c.finance.get('/payment-vouchers?review=true&pageSize=100').expect(200)).body.items.map((x: { id: string }) => x.id);
      expect(review).toContain(id);
      expect(await one(`SELECT COUNT(*)::int AS n FROM notification n JOIN app_user u ON u.id = n.user_id WHERE u.username = 'finance' AND n.title LIKE $1`, [`${v.number}: payment failed`])).toEqual({ n: 1 });
      expect((await c.finance.get(`/invoices/${inv}`).expect(200)).body.status).toBe('SCHEDULED');
      // Definitely not paid: releasing again makes a new attempt (new OriginatorConversationID).
      await c.finance.post(`/payment-vouchers/${id}/release`, {}).expect(200);
      const again = await voucher(id);
      expect(again.attempts).toHaveLength(2);
      const ocids = await q(`SELECT originator_conversation_id AS o FROM mpesa_payout WHERE voucher_id = $1`, [id]);
      expect(new Set(ocids.map((r: { o: string }) => r.o)).size).toBe(2);
      await sharedMockPayouts.deliverAll();
    });

    it('a refused request (Till) fails at once; nothing is pending', async () => {
      const inv = await invoice(3_000);
      const id = await approvedVoucher({ method: 'MPESA_TILL', payeeShortcode: '174333', invoices: [{ invoiceId: inv }] });
      await c.finance.post(`/payment-vouchers/${id}/release`, {}).expect(200);
      expect(await voucher(id)).toMatchObject({ status: 'FAILED', attempts: [expect.objectContaining({ status: 'FAILED', resultCode: '400.002.02' })] });
    });

    it('a timeout with unknown outcome is never re-sent: M-PESA is asked first, and it was paid', async () => {
      const inv = await invoice(6_000);
      const id = await approvedVoucher({ method: 'MPESA_B2C', payeePhone: '0712345444', invoices: [{ invoiceId: inv }] });
      await c.finance.post(`/payment-vouchers/${id}/release`, {}).expect(200);
      expect(await voucher(id)).toMatchObject({ status: 'PROCESSING', attempts: [expect.objectContaining({ status: 'UNKNOWN' })] });
      await c.finance.post(`/payment-vouchers/${id}/release`, {}).expect(409);
      const sentBefore = sharedMockPayouts.requests.filter((r) => r.partyB === '254712345444').length;
      await due();
      await c.finance.post('/payments/mpesa/follow-up').expect(200);
      expect(sharedMockPayouts.requests.filter((r) => r.partyB === '254712345444').length).toBe(sentBefore);
      expect(await voucher(id)).toMatchObject({ status: 'PAID', attempts: [expect.objectContaining({ status: 'SUCCESS' })] });
    });

    it('a request M-PESA never processed is retried with backoff, then goes to review', async () => {
      await setting('payments.mpesaMaxAttempts', 2);
      const inv = await invoice(7_000);
      const id = await approvedVoucher({ method: 'MPESA_B2C', payeePhone: '0712345555', invoices: [{ invoiceId: inv }] });
      await c.finance.post(`/payment-vouchers/${id}/release`, {}).expect(200);
      await due();
      await c.finance.post('/payments/mpesa/follow-up').expect(200); // not found → retry scheduled
      let v = await voucher(id);
      expect(v).toMatchObject({ status: 'PROCESSING', attempts: [expect.objectContaining({ status: 'FAILED', resultCode: 'NOT_PROCESSED' })] });
      await due();
      const r = (await c.finance.post('/payments/mpesa/follow-up').expect(200)).body;
      expect(r.retried).toBeGreaterThanOrEqual(1);
      expect((await voucher(id)).attempts).toHaveLength(2);
      await due();
      await c.finance.post('/payments/mpesa/follow-up').expect(200); // attempt 2 not found either → review
      v = await voucher(id);
      expect(v.status).toBe('FAILED');
      expect(v.attempts.map((a: { status: string }) => a.status)).toEqual(['FAILED', 'FAILED']);
    });

    it('no callback: the status query finds it; a queue timeout is asked about too', async () => {
      for (const phone of ['0712345222', '0712345666']) {
        const inv = await invoice(2_000);
        const id = await approvedVoucher({ method: 'MPESA_B2C', payeePhone: phone, invoices: [{ invoiceId: inv }] });
        await c.finance.post(`/payment-vouchers/${id}/release`, {}).expect(200);
        await sharedMockPayouts.deliverAll();
        await due();
        await c.finance.post('/payments/mpesa/follow-up').expect(200);
        expect((await voucher(id)).status).toBe('PAID');
      }
    });

    it('still no answer after the status checks: review, then resolved by hand from the statement', async () => {
      await setting('payments.mpesaMaxStatusChecks', 2);
      const spy = jest.spyOn(sharedMockPayouts, 'queryStatus').mockResolvedValue({ state: 'PENDING' });
      try {
        const inv = await invoice(2_500);
        const id = await approvedVoucher({ method: 'MPESA_B2C', payeePhone: '0712345222', invoices: [{ invoiceId: inv }] });
        await c.finance.post(`/payment-vouchers/${id}/release`, {}).expect(200);
        for (let i = 0; i < 2; i++) {
          await due();
          await c.finance.post('/payments/mpesa/follow-up').expect(200);
        }
        expect((await voucher(id)).status).toBe('REVIEW');
        await c.finance.post(`/payment-vouchers/${id}/release`, {}).expect(409); // the live attempt blocks any resend
        await c.finance.post(`/payment-vouchers/${id}/resolve`, { outcome: 'PAID', note: 'On the statement' }).expect(400);
        const done = (await c.finance.post(`/payment-vouchers/${id}/resolve`, { outcome: 'PAID', reference: 'QKM1RESOLV', note: 'Found on the M-PESA statement' }).expect(200)).body;
        expect(done).toMatchObject({ status: 'PAID', paymentReference: 'QKM1RESOLV' });
        expect(await one(`SELECT COUNT(*)::int AS n FROM audit_log WHERE action = 'PAYMENT_RESOLVED' AND entity_id = $1`, [id])).toEqual({ n: 1 });
      } finally {
        spy.mockRestore();
      }
    });

    it('reverses a paid M-PESA payment: the invoice is owed again', async () => {
      const id = ids.paybillVoucher;
      await c.finance.post(`/payment-vouchers/${id}/reverse`, { reason: 'Paid to the wrong PayBill account' }).expect(200);
      await c.finance.post(`/payment-vouchers/${id}/reverse`, { reason: 'Paid to the wrong PayBill account' }).expect(409); // already requested
      await sharedMockPayouts.deliverAll();
      const v = await voucher(id);
      expect(v).toMatchObject({ status: 'REVERSED', attempts: [expect.objectContaining({ status: 'REVERSED' })] });
      const invId = v.lines[0].invoiceId;
      expect((await c.finance.get(`/invoices/${invId}`).expect(200)).body).toMatchObject({ status: 'APPROVED', paidAmount: 0 });
    });

    it('reconciles the day against the imported statement and reports every exception', async () => {
      const paid: { receipt_no: string; amount: number }[] = await q(`SELECT receipt_no, amount::float AS amount FROM mpesa_payout WHERE status IN ('SUCCESS', 'REVERSED') AND receipt_no IS NOT NULL AND completed_at::date >= $1::date - 1 ORDER BY created_at`, [day()]);
      expect(paid.length).toBeGreaterThanOrEqual(4);
      const [first, second, ...rest] = paid;
      const now = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Africa/Nairobi', dateStyle: 'short', timeStyle: 'medium' }).format(new Date());
      const csv = [
        'Organisation statement,,,,',
        'Receipt No.,Completion Time,Details,Paid In,Withdrawn',
        `${first.receipt_no},${now},"Business Payment to 2547…, Mock",,${first.amount}`,
        `${second.receipt_no},${now},Business Payment,,${second.amount + 100}`, // amount mismatch
        ...rest.slice(1).map((p) => `${p.receipt_no},${now},Business Payment,,${p.amount}`), // the third one is missing
        `CHG1234567,${now},Business Pay Bill Charge,,52`,
        `ZZZ9999999,${now},Business Payment to unknown,,1500`,
        'not a row,,,,',
      ].join('\n');
      const imp = (await c.finance.post('/payments/mpesa/statements', { csv }).expect(200)).body;
      expect(imp).toEqual({ imported: rest.length + 3, skipped: 1 });
      const rec = (await c.finance.post('/payments/reconciliations', { from: day(), to: day() }).expect(201)).body;
      const kinds = rec.exceptions.map((e: { kind: string }) => e.kind);
      expect(rec.status).toBe('EXCEPTIONS');
      expect(kinds).toEqual(expect.arrayContaining(['AMOUNT_MISMATCH', 'NOT_ON_STATEMENT', 'NOT_IN_SYSTEM', 'CHARGES']));
      expect(rec.exceptions.find((e: { kind: string }) => e.kind === 'NOT_ON_STATEMENT').receiptNo).toBe(rest[0].receipt_no);
      expect(rec.matched).toBe(rest.length);
      expect(rec.accountBalance).toBe(1_000_000);
    });

    it('callback endpoints are rate-limited', async () => {
      const codes: number[] = [];
      for (let i = 0; i < 130; i++) codes.push((await request(ctx.app.getHttpServer()).post(`${API}/callbacks/mpesa-payouts/result/x`).send({})).status);
      expect(codes).toContain(429);
    });
  });
});
