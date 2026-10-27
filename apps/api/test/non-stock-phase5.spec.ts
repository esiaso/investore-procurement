import { sharedMockPayouts } from '../src/modules/payments/mpesa-payouts';
import { PettyCashService } from '../src/modules/petty-cash/petty-cash.service';
import { Client, createTestApp, idByCode, loggedIn, TestContext, uniq } from './helpers';

const day = (d = 0) =>
  new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Nairobi', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(Date.now() + d * 86_400_000));

const bin = (c: Client, path: string) =>
  c.get(path).buffer(true).parse((r, cb) => {
    const chunks: Buffer[] = [];
    r.on('data', (d: Buffer) => chunks.push(d));
    r.on('end', () => cb(null, Buffer.concat(chunks)));
  });

describe('Non-stock procurement phase 5: petty cash', () => {
  let ctx: TestContext;
  const c: Record<string, Client> = {};
  const ids: Record<string, string> = {};
  const q = async (sql: string, p: unknown[] = []) => ctx.ds.query(sql, p);
  const one = async (sql: string, p: unknown[] = []) => (await q(sql, p))[0];
  const LIMIT = 30_000;

  /** Approves the current step as the expected person. */
  const approveAs = async (docId: string, username: string, expect = 200) => {
    const ar = await one(`SELECT id FROM approval_request WHERE document_id = $1 AND status = 'PENDING'`, [docId]);
    if (!c[username]) c[username] = await loggedIn(ctx, username);
    return c[username].post(`/approvals/${ar.id}/approve`, {}).expect(expect);
  };
  /** HOD → Finance (→ Finance manager above 10,000). */
  const approveChain = async (id: string, amount: number) => {
    await approveAs(id, 'ward.incharge');
    await approveAs(id, 'finance');
    if (amount > 10_000) await approveAs(id, 'finance.manager');
  };
  const float = async () => (await c.finance.get('/petty-cash/floats').expect(200)).body.find((f: { id: string }) => f.id === ids.float);
  const req = async (id: string, who = 'accountant') => (await c[who].get(`/petty-cash/requests/${id}`).expect(200)).body;
  const request = (body: Record<string, unknown>, who = 'ward.nurse') =>
    c[who].post('/petty-cash/requests', { floatId: ids.float, kind: 'PAYMENT', payeeType: 'VENDOR', departmentId: ids.IPD_MED, method: 'CASH', glAccountId: ids.gl, ...body });

  beforeAll(async () => {
    ctx = await createTestApp();
    for (const u of ['finance', 'accountant', 'finance.manager', 'ward.nurse', 'ward.incharge', 'surg.nurse', 'proc.officer']) c[u] = await loggedIn(ctx, u);
    ids.IPD_MED = await idByCode(ctx.ds, 'department', 'IPD-MED');
    ids.ADMIN = await idByCode(ctx.ds, 'department', 'ADMIN');
    ids.IPD_SURG = await idByCode(ctx.ds, 'department', 'IPD-SURG');
    ids.gl = await idByCode(ctx.ds, 'gl_account', '5100');
    ids.accountant = (await one(`SELECT id FROM app_user WHERE username = 'accountant'`)).id;
  });

  afterAll(async () => {
    await ctx.close();
  });

  it('sets up a float with its custodian, limits and opening cash', async () => {
    const base = { code: uniq('PC').toUpperCase().replace(/[^A-Z0-9-]/g, '').slice(0, 20), name: 'Ward petty cash', departmentId: ids.ADMIN, custodianId: ids.accountant, floatLimit: LIMIT, replenishThreshold: 8_000, mpesaEnabled: true };
    await c.finance.post('/petty-cash/floats', { ...base, perTransactionLimit: 40_000 }).expect(400);
    await c['ward.nurse'].post('/petty-cash/floats', { ...base, perTransactionLimit: 15_000 }).expect(403);
    ids.float = (await c.finance.post('/petty-cash/floats', { ...base, perTransactionLimit: 15_000, openingBalance: LIMIT }).expect(201)).body.id;
    expect(await float()).toMatchObject({ balance: LIMIT, available: LIMIT, custodianName: 'Atieno Accountant', belowThreshold: false });
  });

  it('validates limits and payees', async () => {
    expect((await request({ payeeName: 'X', purpose: 'Too much at once', amount: 16_000 }).expect(400)).body.code).toBe('OVER_LIMIT');
    expect((await request({ payeeName: 'X', purpose: 'Bad phone number', amount: 1_000, method: 'MPESA_B2C', payeePhone: '0812345678' }).expect(400)).body.code).toBe('INVALID_PAYEE');
    expect((await request({ payeeName: 'X', purpose: 'Cents on M-PESA', amount: 1_000.5, method: 'MPESA_B2C', payeePhone: '0712345678' }).expect(400)).body.code).toBe('WHOLE_SHILLINGS');
  });

  describe('a payment: every approval level, then only the custodian pays', () => {
    let id: string;

    it('is blocked (and logged) until fully approved; the custodian never approves', async () => {
      id = (await request({ payeeName: 'Kamau Plumbers', purpose: 'Unblock the ward sluice drain', amount: 3_000, submit: true }).expect(201)).body.id;
      expect((await req(id)).status).toBe('PENDING_APPROVAL');
      expect((await c.accountant.post(`/petty-cash/requests/${id}/disburse`, {}).expect(409)).body.code).toBe('NOT_APPROVED');
      await approveAs(id, 'ward.incharge'); // level 1: HOD of the cost centre
      await c.accountant.post(`/petty-cash/requests/${id}/disburse`, {}).expect(409); // level 2 still open
      await approveAs(id, 'accountant', 403); // the custodian may not approve
      await approveAs(id, 'finance');
      expect((await req(id)).status).toBe('APPROVED');
      expect((await c.finance.post(`/petty-cash/requests/${id}/disburse`, {}).expect(403)).body.code).toBe('NOT_CUSTODIAN');
      const blocked = await one(`SELECT COUNT(*)::int AS n FROM audit_log WHERE action = 'PETTY_CASH_RELEASE_BLOCKED' AND entity_id = $1`, [id]);
      expect(blocked.n).toBe(3);
      const history = (await c.finance.get(`/approvals/history?type=PCV&id=${id}`).expect(200)).body;
      expect(history[0].actions.filter((a: { action: string }) => a.action === 'APPROVE').map((a: { userName: string }) => a.userName)).toEqual(['Ward In-charge', 'Mwangi Finance'].map((n) => expect.stringContaining(n.split(' ')[0])));
    });

    it('the custodian pays cash; the cash book and balance move; the payee confirms', async () => {
      const r = (await c.accountant.post(`/petty-cash/requests/${id}/disburse`, { receivedByName: 'J. Kamau', reference: 'RCPT-881' }).expect(200)).body;
      expect(r).toMatchObject({ status: 'DISBURSED', disbursedOn: day(), reference: 'RCPT-881', receivedByName: 'J. Kamau', disbursedByName: 'Atieno Accountant' });
      expect((await float()).balance).toBe(LIMIT - 3_000);
      expect(await one(`SELECT type, amount::float AS amount, balance_after::float AS b FROM petty_cash_transaction WHERE ref_id = $1`, [id])).toEqual({ type: 'DISBURSEMENT', amount: -3_000, b: LIMIT - 3_000 });
      await c['surg.nurse'].post(`/petty-cash/requests/${id}/acknowledge`).expect(403);
      expect((await c['ward.nurse'].post(`/petty-cash/requests/${id}/acknowledge`).expect(200)).body.acknowledgedAt).toBeTruthy();
      await c.accountant.post(`/petty-cash/requests/${id}/disburse`, {}).expect(409); // paid once
      const pdf = await bin(c['ward.nurse'], `/petty-cash/requests/${id}/pdf`).expect(200);
      expect((pdf.body as Buffer).subarray(0, 4).toString()).toBe('%PDF');
      await c['surg.nurse'].get(`/petty-cash/requests/${id}`).expect(403);
      await c['ward.nurse'].get('/petty-cash/requests?scope=all').expect(403);
    });

    it('same payee and amount again needs a justification', async () => {
      const dup = await request({ payeeName: 'kamau plumbers', purpose: 'Second drain job', amount: 3_000, submit: true }).expect(409);
      expect(dup.body).toMatchObject({ code: 'POSSIBLE_DUPLICATE' });
      const ok = (await request({ payeeName: 'Kamau Plumbers', purpose: 'Second drain job', amount: 3_000, submit: true, duplicateJustification: 'A different drain, in the maternity annex' }).expect(201)).body;
      expect(ok.duplicate?.id).toBe(id);
      await approveChain(ok.id, 3_000);
      await c.accountant.post(`/petty-cash/requests/${ok.id}/disburse`, {}).expect(200);
    });
  });

  it('over 10,000 needs the finance manager too; requests cannot commit more than the float holds', async () => {
    const big = (await request({ payeeName: 'Ace Glaziers', purpose: 'Replace broken ward windows', amount: 12_000, submit: true }).expect(201)).body;
    await approveAs(big.id, 'ward.incharge');
    await approveAs(big.id, 'finance');
    await c.accountant.post(`/petty-cash/requests/${big.id}/disburse`, {}).expect(409); // level 3 open
    // 24,000 in hand, 12,000 committed: 14,000 is more than is available.
    const tooMuch = (await request({ payeeName: 'Other', purpose: 'Painting the corridor', amount: 14_000 }).expect(201)).body;
    expect((await c['ward.nurse'].post(`/petty-cash/requests/${tooMuch.id}/submit`).expect(409)).body.code).toBe('INSUFFICIENT_FLOAT');
    await approveAs(big.id, 'finance.manager');
    await c.accountant.post(`/petty-cash/requests/${big.id}/disburse`, {}).expect(200);
    expect((await float()).balance).toBe(LIMIT - 18_000);
  });

  describe('advances', () => {
    let adv: string;

    it('are paid with a retirement date; no second advance while one is unretired; a low float asks for a top-up', async () => {
      adv = (await request({ kind: 'ADVANCE', payeeType: 'STAFF', purpose: 'Transport and meals for the outreach clinic', amount: 5_000, submit: true }).expect(201)).body.id;
      expect((await request({ kind: 'ADVANCE', payeeType: 'STAFF', purpose: 'Another advance while one is open', amount: 1_000 }).expect(409)).body.code).toBe('ADVANCE_OUTSTANDING');
      await approveChain(adv, 5_000);
      const r = (await c.accountant.post(`/petty-cash/requests/${adv}/disburse`, {}).expect(200)).body;
      expect(r).toMatchObject({ status: 'DISBURSED', payeeName: 'Moraa Nurse', retirementDueOn: day(7) });
      // 30,000 − 3,000 − 3,000 − 12,000 − 5,000 = 7,000: below the 8,000 threshold.
      const rp = await one(`SELECT id, status, amount::float AS amount, balance_at_request::float AS b FROM petty_cash_replenishment WHERE float_id = $1`, [ids.float]);
      expect(rp).toMatchObject({ status: 'PENDING_APPROVAL', amount: 23_000, b: 7_000 });
      ids.replenishment = rp.id;
    });

    it('retires with receipts: the unspent balance goes back into the float', async () => {
      await c.accountant.post(`/petty-cash/requests/${adv}/retirement/verify`, { accept: true }).expect(409); // nothing submitted
      const sub = (await c['ward.nurse'].post(`/petty-cash/requests/${adv}/retirement`, { lines: [{ description: 'Matatu fares', amount: 3_200, receiptRef: 'T-1' }, { description: 'Lunch for 4', amount: 800 }] }).expect(200)).body;
      expect(sub).toMatchObject({ status: 'RETIREMENT_SUBMITTED', spentAmount: 4_000, refundAmount: 1_000 });
      await c['ward.nurse'].post(`/petty-cash/requests/${adv}/retirement/verify`, { accept: true }).expect(403);
      const done = (await c.accountant.post(`/petty-cash/requests/${adv}/retirement/verify`, { accept: true, comment: 'Receipts in order' }).expect(200)).body;
      expect(done).toMatchObject({ status: 'RETIRED', retiredByName: 'Atieno Accountant' });
      expect((await float()).balance).toBe(8_000);
      // Retired: a new advance is allowed again.
      await request({ kind: 'ADVANCE', payeeType: 'STAFF', purpose: 'Next outreach clinic', amount: 1_000 }).expect(201);
    });

    it('overdue advances are chased', async () => {
      const other = (await request({ kind: 'ADVANCE', payeeType: 'STAFF', departmentId: ids.IPD_SURG, purpose: 'Training workshop costs', amount: 1_500, submit: true }, 'surg.nurse').expect(201)).body.id;
      await approveAs(other, 'surg.incharge');
      await approveAs(other, 'finance');
      await c.accountant.post(`/petty-cash/requests/${other}/disburse`, {}).expect(200);
      await q(`UPDATE petty_cash_request SET retirement_due_on = $2 WHERE id = $1`, [other, day(-1)]);
      expect((await ctx.app.get(PettyCashService).remindRetirements()).overdue).toBeGreaterThanOrEqual(1);
      expect((await req(other, 'surg.nurse')).overdue).toBe(true);
      expect(await one(`SELECT COUNT(*)::int AS n FROM notification n JOIN app_user u ON u.id = n.user_id WHERE u.username = 'surg.nurse' AND n.title LIKE '%overdue for retirement'`)).toEqual({ n: 1 });
    });
  });

  describe('M-PESA', () => {
    it('B2C after final approval only, once; the result moves the float', async () => {
      const before = (await float()).balance;
      const id = (await request({ payeeName: 'Otieno (casual)', purpose: 'Casual labour: moving beds', amount: 1_000, method: 'MPESA_B2C', payeePhone: '0712345678', submit: true }).expect(201)).body.id;
      await c.accountant.post(`/petty-cash/requests/${id}/disburse`, {}).expect(409);
      await approveChain(id, 1_000);
      const n = sharedMockPayouts.requests.length;
      const results = await Promise.all([1, 2].map(() => c.accountant.post(`/petty-cash/requests/${id}/disburse`, {})));
      expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
      expect(sharedMockPayouts.requests.length).toBe(n + 1);
      expect(sharedMockPayouts.requests[n]).toMatchObject({ method: 'MPESA_B2C', commandId: 'BusinessPayment', partyB: '254712345678', amount: 1_000 });
      expect((await req(id)).status).toBe('PROCESSING');
      expect((await float()).balance).toBe(before); // nothing moves before M-PESA confirms
      await sharedMockPayouts.deliverAll();
      const r = await req(id);
      expect(r).toMatchObject({ status: 'DISBURSED', attempts: [expect.objectContaining({ status: 'SUCCESS' })] });
      expect(r.reference).toBe(r.attempts[0].receiptNo);
      expect((await float()).balance).toBe(before - 1_000);
    });

    it('a failure goes to review; resolving it as not paid allows a fresh attempt', async () => {
      const id = (await request({ payeeName: 'Wanjiru (casual)', purpose: 'Casual labour: cleaning', amount: 500, method: 'MPESA_B2C', payeePhone: '0712345000', submit: true }).expect(201)).body.id;
      await approveChain(id, 500);
      await c.accountant.post(`/petty-cash/requests/${id}/disburse`, {}).expect(200);
      await sharedMockPayouts.deliverAll();
      expect((await req(id)).status).toBe('FAILED');
      const review = (await c.finance.get('/petty-cash/requests?scope=all&review=true&pageSize=100').expect(200)).body.items.map((x: { id: string }) => x.id);
      expect(review).toContain(id);
      await c.finance.post(`/petty-cash/requests/${id}/resolve`, { outcome: 'FAILED', note: 'Not on the statement' }).expect(200);
      expect((await req(id)).status).toBe('APPROVED');
    });
  });

  describe('replenishment, counts and the cash book', () => {
    it('the replenishment has its own approval; the custodian receives the cash', async () => {
      await c.accountant.post(`/petty-cash/replenishments/${ids.replenishment}/receive`, { reference: 'CHQ-1001' }).expect(409);
      await approveAs(ids.replenishment, 'accountant', 403); // custodian
      await approveAs(ids.replenishment, 'finance.manager');
      await c.finance.post(`/petty-cash/replenishments/${ids.replenishment}/receive`, { reference: 'CHQ-1001' }).expect(403); // not the custodian
      const before = (await float()).balance;
      const rp = (await c.accountant.post(`/petty-cash/replenishments/${ids.replenishment}/receive`, { reference: 'CHQ-1001' }).expect(200)).body;
      expect(rp.status).toBe('RECEIVED');
      expect((await float()).balance).toBe(before + 23_000);
      expect((await c.accountant.post('/petty-cash/replenishments', { floatId: ids.float, amount: 50_000 }).expect(400)).body.code).toBe('OVER_FLOAT_LIMIT');
    });

    it('a cash count records the variance and tells the managers', async () => {
      const f = await float();
      const count = (await c.accountant.post(`/petty-cash/floats/${ids.float}/counts`, { counted: f.balance - 100, notes: 'Short by 100' }).expect(201)).body;
      expect(count).toMatchObject({ expected: f.balance, counted: f.balance - 100, variance: -100 });
      expect(await one(`SELECT COUNT(*)::int AS n FROM notification n JOIN app_user u ON u.id = n.user_id WHERE u.username = 'finance' AND n.title LIKE '%cash count variance -100'`)).toEqual({ n: 1 });
    });

    it('the cash book adds up: opening + top-ups + refunds − payments = closing', async () => {
      const s = (await c.finance.get(`/petty-cash/floats/${ids.float}/statement?from=${day()}&to=${day()}`).expect(200)).body;
      const f = await float();
      expect(s.opening).toBe(0);
      expect(s.totals).toMatchObject({ OPENING: LIMIT, REPLENISHMENT: 23_000, REFUND: 1_000 });
      expect(s.totals.DISBURSEMENT).toBe(-(3_000 + 3_000 + 12_000 + 5_000 + 1_500 + 1_000));
      expect(s.closing).toBe(f.balance);
      expect(s.closing).toBe(s.opening + Object.values(s.totals as Record<string, number>).reduce((a, b) => a + b, 0));
      expect(s.balanced).toBe(true);
      expect(s.counts).toEqual([expect.objectContaining({ variance: -100 })]);
    });
  });
});
