import { ReportsService } from '../src/modules/reports/reports.service';
import { Client, createTestApp, loggedIn, TestContext, uniq } from './helpers';

const day = (d = 0) =>
  new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Nairobi', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(Date.now() + d * 86_400_000));

const bin = (c: Client, path: string) =>
  c.get(path).buffer(true).parse((r, cb) => {
    const chunks: Buffer[] = [];
    r.on('data', (d: Buffer) => chunks.push(d));
    r.on('end', () => cb(null, Buffer.concat(chunks)));
  });

type Report = { key: string; group: string; filters: string[]; chart?: { x: string; series: string[] }; columns: { key: string; link?: { docType: string; idKey: string } }[] };

describe('Non-stock procurement phase 7: reports, dashboards, exports and schedules', () => {
  let ctx: TestContext;
  const c: Record<string, Client> = {};
  const ids: Record<string, string> = {};
  const q = async (sql: string, p: unknown[] = []) => ctx.ds.query(sql, p);
  const one = async (sql: string, p: unknown[] = []) => (await q(sql, p))[0];
  const run = async (who: string, key: string, params: Record<string, string> = {}, status = 200) => (await c[who].get(`/reports/${key}?${new URLSearchParams(params)}`).expect(status)).body;
  const from = day(-60);
  const to = day();

  beforeAll(async () => {
    ctx = await createTestApp();
    for (const u of ['admin', 'finance', 'accountant', 'ward.nurse', 'proc.officer']) c[u] = await loggedIn(ctx, u);
    ids.supplier = (await one(`SELECT id FROM supplier WHERE status = 'ACTIVE' ORDER BY code LIMIT 1`)).id;
    ids.accountant = (await one(`SELECT id FROM app_user WHERE username = 'accountant'`)).id;
    ids.float = (await one(`SELECT id FROM petty_cash_float WHERE code = 'PC-ADMIN'`))?.id;
    ids.ipdMed = (await one(`SELECT id FROM department WHERE code = 'IPD-MED'`)).id;
    // A (draft) order for the invoices below.
    const store = (await one(`SELECT id FROM store WHERE code = 'MS'`)).id;
    const item = (await one(`SELECT b.item_id FROM stock_balance b WHERE b.store_id = $1 AND b.on_hand > 0 LIMIT 1`, [store])).item_id;
    // (Reuse one when other suites have made some: the invoices only need an order of their supplier.)
    const existing = await one(`SELECT id, supplier_id FROM purchase_order ORDER BY created_at LIMIT 1`);
    if (existing) Object.assign(ids, { po: existing.id, supplier: existing.supplier_id });
    else ids.po = (await c['proc.officer'].post('/purchase-orders', { supplierId: ids.supplier, storeId: store, departmentId: ids.ipdMed, lines: [{ itemId: item, quantity: 1, unitPrice: 100 }] }).expect(201)).body.id;
  });

  afterAll(async () => {
    await ctx.close();
  });

  it('catalogue: the new groups are there for finance; reports stay behind their permissions', async () => {
    const all = (await c.finance.get('/reports').expect(200)).body as Report[];
    const keys = all.map((r) => r.key);
    for (const k of ['ap-ageing', 'payments-by-method', 'payment-schedule', 'mpesa-log', 'wht-vat-summary', 'petty-cash-book', 'petty-cash-spend', 'outstanding-advances', 'received-not-invoiced', 'match-exceptions', 'purchases-over-time']) {
      expect(keys).toContain(k);
    }
    expect(new Set(all.map((r) => r.group))).toEqual(expect.objectContaining(new Set(['PAYMENTS', 'PETTY_CASH'])));
    expect(all.find((r) => r.key === 'purchases-over-time')!.chart).toEqual({ type: 'line', x: 'period', series: ['value'] });
    expect(all.find((r) => r.key === 'open-lpos')!.columns[0].link).toEqual({ docType: 'PO', idKey: '_id' });
    await run('ward.nurse', 'ap-ageing', {}, 403);
    await run('proc.officer', 'petty-cash-book', { floatId: ids.float, from, to }, 403);
  });

  it('value of purchases over time adds up to the orders, with the change on the previous period', async () => {
    // The total is the base value of order lines excl. VAT.
    const r = await run('finance', 'purchases-over-time', { from, to, period: 'MONTH' });
    const [{ v }] = await q(
      `SELECT COALESCE(ROUND(SUM(l.line_subtotal * po.exchange_rate), 2), 0)::float AS v FROM purchase_order po JOIN purchase_order_line l ON l.purchase_order_id = po.id
        WHERE po.status IN ('APPROVED','SENT','PARTIALLY_RECEIVED','RECEIVED','INVOICED','PAID','CLOSED') AND po.order_date BETWEEN $1::date AND $2::date`,
      [from, to],
    );
    expect(r.totals.value).toBeCloseTo(v, 2);
    for (let i = 1; i < r.rows.length; i++) {
      const [prev, cur] = [r.rows[i - 1], r.rows[i]];
      expect(cur.previous).toBe(prev.value);
      if (prev.value) expect(cur.change).toBeCloseTo((100 * (cur.value - prev.value)) / prev.value, 1);
    }
    const bySupplier = await run('admin', 'purchases-over-time', { from, to, period: 'WEEK', groupBy: 'supplier' });
    expect(bySupplier.totals.value).toBeCloseTo(v, 2);
    expect(bySupplier.columns.map((x: { key: string }) => x.key)).toEqual(['period', 'supplier', 'value', 'previous', 'change']);
  });

  describe('payments', () => {
    beforeAll(async () => {
      // An invoice 45 days overdue, a quarter paid; paid twice over by two vouchers, with nothing received.
      ids.inv = (
        await one(
          `INSERT INTO supplier_invoice (number, supplier_id, supplier_invoice_no, purchase_order_id, invoice_date, due_date, status, match_status, subtotal, tax_total, total, currency, exchange_rate, base_total, paid_amount, captured_by)
           VALUES ($1, $2, $3, $4, $5, $6, 'PARTIALLY_PAID', 'MATCHED', 10000, 0, 10000, 'KES', 1, 10000, 2500, $7) RETURNING id`,
          [uniq('INV'), ids.supplier, uniq('SI'), ids.po, day(-75), day(-45), ids.accountant],
        )
      ).id;
      for (const n of [1, 2]) {
        const v = await one(
          `INSERT INTO payment_voucher (number, supplier_id, status, method, currency, gross_amount, wht_amount, amount, paid_on, payment_reference)
           VALUES ($1, $2, 'PAID', 'EFT', 'KES', 6000, 0, 6000, $3, $4) RETURNING id`,
          [uniq('PV'), ids.supplier, day(), `EFT-DUP-${n}`],
        );
        await q(`INSERT INTO payment_voucher_line (voucher_id, invoice_id, amount, wht_amount, net_amount) VALUES ($1, $2, 6000, 0, 6000)`, [v.id, ids.inv]);
      }
    });

    it('AP ageing puts what is owed in the right bucket; the total agrees with the ledger of invoices', async () => {
      const r = await run('finance', 'ap-ageing');
      const [{ v }] = await q(`SELECT COALESCE(ROUND(SUM((total - paid_amount) * exchange_rate), 2), 0)::float AS v FROM supplier_invoice WHERE status IN ('APPROVED','SCHEDULED','PARTIALLY_PAID') AND total > paid_amount`);
      expect(r.totals.total).toBeCloseTo(v, 2);
      const sup = (await one(`SELECT name FROM supplier WHERE id = $1`, [ids.supplier])).name;
      expect(r.rows.find((x: { supplier: string }) => x.supplier === sup).d60).toBeGreaterThanOrEqual(7_500);
      for (const row of r.rows) expect(row.current + row.d30 + row.d60 + row.d90 + row.over90).toBeCloseTo(row.total, 2);
    });

    it('control exceptions: an invoice paid twice, payments with nothing received, requests split under a threshold', async () => {
      // Two petty cash requests to one payee within days, each under the 10,000 level, together over it.
      const ask = async (amount: number) =>
        (await c['ward.nurse'].post('/petty-cash/requests', { floatId: ids.float, kind: 'PAYMENT', payeeType: 'VENDOR', payeeName: 'Split Vendor Ltd', departmentId: ids.ipdMed, method: 'CASH', purpose: 'Painting the corridor', amount, submit: true }).expect(201)).body;
      const a = await ask(6_000);
      const b = await ask(5_000);
      const r = await run('admin', 'control-exceptions', { from: day(-1), to: day(1) });
      const kinds = (k: string) => r.rows.filter((x: { kind: string }) => x.kind === k);
      expect(kinds('DUPLICATE_PAYMENT').find((x: { _docId: string }) => x._docId === ids.inv)).toMatchObject({ _docType: 'INV', amount: 10_000 });
      expect(kinds('PAID_WITHOUT_RECEIPT').length).toBeGreaterThanOrEqual(2);
      expect(kinds('POSSIBLE_SPLIT').map((x: { document: string }) => x.document)).toEqual(expect.arrayContaining([a.number, b.number]));
      expect(r.columns.find((x: { key: string }) => x.key === 'document').link).toEqual({ docType: '@_docType', idKey: '_docId' });
      // The approval audit trail shows who submitted them.
      const audit = await run('admin', 'approval-audit', { from: day(), to: day() });
      expect(audit.rows.filter((x: { document: string; action: string }) => [a.number, b.number].includes(x.document) && x.action === 'SUBMIT')).toHaveLength(2);
    });

    it('payments by method and the payment schedule add up', async () => {
      const r = await run('finance', 'payments-by-method', { from: day(), to: day(), method: 'EFT' });
      const [{ v }] = await q(`SELECT COALESCE(SUM(amount), 0)::float AS v FROM payment_voucher WHERE status = 'PAID' AND method = 'EFT' AND paid_on = $1::date`, [day()]);
      expect(r.totals.amount).toBeCloseTo(v, 2);
      const s = await run('finance', 'payment-schedule', { days: '365' });
      expect(s.totals.total).toBeCloseTo(s.rows.reduce((t: number, x: { total: number }) => t + x.total, 0), 2);
      if (s.rows.length) expect(s.rows[s.rows.length - 1].cumulative).toBeCloseTo(s.totals.total, 2);
    });
  });

  describe('petty cash', () => {
    it('the cash book: opening + receipts − disbursements = closing = the float balance', async () => {
      const r = await run('finance', 'petty-cash-book', { floatId: ids.float, from: day(-365), to: day() });
      const opening = r.rows[0].balance;
      expect(r.rows[0].type).toBe('OPENING BALANCE');
      expect(opening + r.totals.receipts - r.totals.payments).toBeCloseTo(r.totals.balance, 2);
      const f = await one(`SELECT balance::float AS b FROM petty_cash_float WHERE id = $1`, [ids.float]);
      expect(r.totals.balance).toBeCloseTo(f.b, 2);
    });

    it('pending requests show the approval level and who it waits for', async () => {
      const r = await run('finance', 'petty-cash-pending', { floatId: ids.float });
      const mine = r.rows.filter((x: { level: string | null }) => x.level === 'Supervisor / HOD');
      expect(mine.length).toBeGreaterThanOrEqual(1);
      expect(mine[0].awaiting).toContain('Ward In-charge'.split(' ')[0]);
    });
  });

  describe('exports and schedules', () => {
    it('exports to Excel, CSV and PDF', async () => {
      const xlsx = await bin(c.finance, '/reports/ap-ageing/export?format=xlsx').expect(200);
      expect(xlsx.headers['content-type']).toMatch(/spreadsheetml/);
      expect((xlsx.body as Buffer).subarray(0, 2).toString()).toBe('PK');
      const csv = await c.finance.get('/reports/ap-ageing/export?format=csv').expect(200);
      expect(csv.text.split('\n')[0]).toMatch(/Supplier/);
      const pdf = await bin(c.finance, `/reports/petty-cash-book/export?format=pdf&floatId=${ids.float}&from=${day(-30)}&to=${day()}`).expect(200);
      expect((pdf.body as Buffer).subarray(0, 4).toString()).toBe('%PDF');
    });

    it('emails a payments report on its schedule', async () => {
      const s = (await c.admin.post('/reports/schedules', { name: 'Weekly cash requirement', reportKey: 'payment-schedule', filters: { days: 60 }, period: 'LAST_30_DAYS', format: 'xlsx', frequency: 'WEEKLY', hour: 7, weekday: 1, recipients: ['finance@example.org'] }).expect(201)).body;
      await q(`UPDATE report_schedule SET next_run_at = now() - interval '1 minute' WHERE id = $1`, [s.id]);
      expect(await ctx.app.get(ReportsService).runDue()).toMatchObject({ sent: 1 });
      const mail = await one(`SELECT subject, attachments FROM email_outbox WHERE source_doc_type = 'REPORT_SCHEDULE' AND source_doc_id = $1`, [s.id]);
      expect(mail.subject).toMatch(/Weekly cash requirement/);
      expect(mail.attachments[0]).toMatchObject({ kind: 'REPORT_RUN' });
      await q(`DELETE FROM report_schedule WHERE id = $1`, [s.id]);
    });
  });

  it('dashboard: approvals, open orders, this month vs last, petty cash in hand, failed M-PESA and QuickBooks', async () => {
    const d = (await c.finance.get('/dashboard').expect(200)).body;
    const tile = (k: string) => d.tiles.find((t: { key: string }) => t.key === k);
    for (const k of ['approvals', 'open-lpo-value', 'spend', 'petty-cash', 'advances-overdue', 'mpesa-review', 'quickbooks']) expect(tile(k)).toBeTruthy();
    expect(tile('spend').hint).toMatch(/last month/);
    const [{ v }] = await q(`SELECT COALESCE(SUM(balance), 0)::float AS v FROM petty_cash_float WHERE is_active`);
    expect(tile('petty-cash').value).toBeCloseTo(v, 2);
    const nurse = (await c['ward.nurse'].get('/dashboard').expect(200)).body;
    expect(nurse.tiles.find((t: { key: string }) => t.key === 'petty-cash')).toBeUndefined();
  });
});
