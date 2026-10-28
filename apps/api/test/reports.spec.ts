import ExcelJS from 'exceljs';
import { ReportFrequency, ReportPeriod } from '@sil/shared';
import { nextRun, ReportsService, resolvePeriod } from '../src/modules/reports/reports.service';
import { API, Client, createTestApp, idByCode, loggedIn, TestContext, uniq } from './helpers';

const day = (d = 0) =>
  new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Nairobi', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(Date.now() + d * 86_400_000));

const PDF = Buffer.from('%PDF-1.4\n% test document\n1 0 obj << >> endobj\ntrailer << >>\n%%EOF\n');

/** Binary GET (exports). */
const bin = (c: Client, path: string) =>
  c.get(path).buffer(true).parse((r, cb) => {
    const chunks: Buffer[] = [];
    r.on('data', (d: Buffer) => chunks.push(d));
    r.on('end', () => cb(null, Buffer.concat(chunks)));
  });

type Report = { key: string; title: string; filters: string[]; required?: string[]; groupBy?: { value: string }[]; columns: { key: string; label: string; type: string }[] };
type Result = { columns: { key: string; label: string }[]; rows: Record<string, unknown>[]; totals?: Record<string, unknown>; criteria: string[] };

describe('Reports, dashboards and the documents register', () => {
  let ctx: TestContext;
  const c: Record<string, Client> = {};
  const ids: Record<string, string> = {};
  const from = day(-60);
  const to = day();
  const q = async (sql: string, p: unknown[] = []) => ctx.ds.query(sql, p);
  const one = async (sql: string, p: unknown[] = []) => (await q(sql, p))[0];
  const run = async (who: string, key: string, params: Record<string, string | number> = {}, status = 200) =>
    (await c[who].get(`/reports/${key}?${new URLSearchParams(Object.entries(params).map(([k, v]) => [k, String(v)]))}`).expect(status)).body as Result;

  beforeAll(async () => {
    ctx = await createTestApp();
    for (const u of ['admin', 'storekeeper', 'pharmacist', 'cashier', 'finance', 'management', 'scm']) c[u] = await loggedIn(ctx, u);
    Object.assign(ids, {
      MS: await idByCode(ctx.ds, 'store', 'MS'),
      MP: await idByCode(ctx.ds, 'store', 'MP'),
      OPD: await idByCode(ctx.ds, 'store', 'OPD-PH'),
      cat: await idByCode(ctx.ds, 'item_category', 'DRUG-ANALG'),
      tab: await idByCode(ctx.ds, 'unit_of_measure', 'TAB'),
      exempt: await idByCode(ctx.ds, 'tax_category', 'EXEMPT'),
    });
    const it = await one(`SELECT item_id FROM stock_balance WHERE store_id = $1 AND on_hand > 0 ORDER BY on_hand DESC LIMIT 1`, [ids.MS]);
    ids.item = it.item_id;
    // Sales from the OPD pharmacy: consumption (DISPENSE) at a known cost and price.
    await q(`UPDATE etims_config SET is_active = false`);
    const g = await c.admin.post('/generics', { innName: `Reportamol ${uniq('g')}`, strength: '1 g', dosageForm: 'Tablet', route: 'Oral', controlledSchedule: 'NONE' }).expect(201);
    ids.generic = g.body.id;
    ids.sold = (await c.admin.post('/items', { genericId: g.body.id, categoryId: ids.cat, name: `Report test ${uniq('i')}`, baseUomId: ids.tab, unitPrice: 50, taxCategoryId: ids.exempt, salesClass: 'OTC' }).expect(201)).body.id;
    await c.admin.post('/inventory/receipts', { storeId: ids.OPD, type: 'OPENING', lines: [{ itemId: ids.sold, batchNo: uniq('L'), expiryDate: day(300), quantity: 1000, unitCost: 20 }] }).expect(201);
    for (const qty of [100, 300]) await c.admin.post('/billing/invoices', { storeId: ids.OPD, source: 'OTC', lines: [{ itemId: ids.sold, quantity: qty }], payments: [{ modeCode: 'CASH', amount: qty * 50 }] }).expect(201);
  });

  afterAll(async () => {
    await ctx.close();
  });

  describe('catalog and permissions', () => {
    it('lists the reports a user may run', async () => {
      const all = (await c.admin.get('/reports').expect(200)).body as Report[];
      expect(all.length).toBeGreaterThanOrEqual(28);
      expect(all.map((r) => r.key)).toEqual(expect.arrayContaining(['stock-status', 'bin-card', 'grn-register', 'abc-ved', 'sales-margin', 'supply-chain-kpis', 'dead-stock', 'inventory-turnover', 'fill-rate']));
      const store = ((await c.storekeeper.get('/reports').expect(200)).body as Report[]).map((r) => r.key);
      expect(store).toContain('bin-card');
      expect(store).not.toContain('sales-margin');
      expect(store).not.toContain('stock-status'); // valuation permission
      await run('storekeeper', 'sales-margin', { from, to }, 403);
      await run('admin', 'no-such-report', {}, 404);
    });

    it('validates filters', async () => {
      await run('admin', 'grn-register', { from }, 400); // to required
      await run('admin', 'grn-register', { from: '2026-13-01', to }, 400);
      await run('admin', 'grn-register', { from: to, to: from }, 400);
      await run('admin', 'stock-status', { groupBy: 'colour' }, 400);
      await run('admin', 'stock-status', { storeId: 'x' }, 400);
      await run('admin', 'bin-card', { from, to, storeId: ids.MS }, 400); // itemId required
    });

    it('keeps users to their stores', async () => {
      await run('pharmacist', 'stock-status', { storeId: ids.MS }, 403);
      const mine = await run('pharmacist', 'stock-status', { groupBy: 'store' });
      const allowed = (await q(`SELECT s.name FROM store s WHERE s.code IN ('MP', 'OPD-PH', 'IPD-PH')`)).map((r: { name: string }) => r.name);
      expect(mine.rows.length).toBeGreaterThan(0);
      for (const r of mine.rows) expect(allowed).toContain(r.store);
    });
  });

  describe('every report runs', () => {
    it('with its filters and every grouping, returning rows that match its columns', async () => {
      const all = (await c.admin.get('/reports').expect(200)).body as Report[];
      for (const r of all) {
        const base: Record<string, string> = {};
        if (r.filters.includes('from')) Object.assign(base, { from, to });
        if (r.required?.includes('storeId')) base.storeId = ids.MS;
        if (r.required?.includes('itemId')) base.itemId = ids.item;
        if (r.required?.includes('floatId')) base.floatId = (await one(`SELECT id FROM petty_cash_float ORDER BY created_at LIMIT 1`))?.id;
        for (const g of r.groupBy?.map((x) => x.value) ?? [undefined]) {
          const res = await c.admin.get(`/reports/${r.key}?${new URLSearchParams({ ...base, ...(g ? { groupBy: g } : {}) })}`);
          if (res.status !== 200) throw new Error(`${r.key} ${g ?? ''}: ${res.status} ${JSON.stringify(res.body)}`);
          expect(res.body.columns.length).toBeGreaterThan(0);
          expect(Array.isArray(res.body.rows)).toBe(true);
          // Keys starting with "_" carry drill-down ids.
          for (const row of res.body.rows.slice(0, 5)) for (const k of Object.keys(row).filter((x) => !x.startsWith('_'))) expect(res.body.columns.map((x: { key: string }) => x.key)).toContain(k);
        }
      }
    });
  });

  describe('figures agree with the ledger', () => {
    it('stock status equals the inventory valuation', async () => {
      const s = await run('admin', 'stock-status', { groupBy: 'store' });
      const v = (await c.admin.get('/inventory/valuation?groupBy=store').expect(200)).body;
      expect(s.totals!.value).toBeCloseTo(v.total, 1);
    });

    it('the bin card ends at the balance on hand and the movement summary adds up', async () => {
      const card = await run('storekeeper', 'bin-card', { from: '2000-01-01', to, storeId: ids.MS, itemId: ids.item });
      expect(card.rows[0]).toMatchObject({ type: 'OPENING BALANCE', balance: 0 });
      const { on_hand } = await one(`SELECT SUM(on_hand)::float AS on_hand FROM stock_balance WHERE store_id = $1 AND item_id = $2`, [ids.MS, ids.item]);
      expect(card.totals!.balance).toBeCloseTo(on_hand, 4);
      const mv = await run('admin', 'stock-movement', { from, to, storeId: ids.MS });
      expect(mv.rows.length).toBeGreaterThan(0);
      for (const r of mv.rows as { opening: number; receipts: number; issues: number; adjustments: number; closing: number }[]) expect(r.opening + r.receipts - r.issues + r.adjustments).toBeCloseTo(r.closing, 3);
    });

    it('ABC-VED uses the VED class set on the generic', async () => {
      const abc = await run('admin', 'abc-ved', { from: '2000-01-01', to });
      expect(abc.rows.length).toBeGreaterThan(0);
      expect(abc.rows[0]).toMatchObject({ abc: 'A' });
      expect(abc.rows.at(-1)).toMatchObject({ cumulative: 100 });
      const { code } = await one(`SELECT code FROM item WHERE id = $1`, [ids.sold]);
      const mine = abc.rows.find((r) => r.code === code) as { value: number; abc: string; ved: string };
      expect(mine).toMatchObject({ value: 8000, ved: '—' });
      await c.admin.patch(`/generics/${ids.generic}`, { vedClass: 'V' }).expect(200);
      const again = await run('admin', 'abc-ved', { from: '2000-01-01', to });
      expect(again.rows.find((r) => r.code === code)).toMatchObject({ ved: 'V', class: `${mine.abc}V`, category: 'I' });
    });

    it('sales margin is revenue (excluding VAT) less the batch cost of what was sold', async () => {
      const m = await run('finance', 'sales-margin', { from: '2000-01-01', to, groupBy: 'store' });
      const { net } = await one(`SELECT COALESCE(SUM(CASE WHEN si.doc_type = 'CREDIT_NOTE' THEN -l.net_amount ELSE l.net_amount END), 0)::float AS net FROM sales_invoice si JOIN sales_invoice_line l ON l.invoice_id = si.id WHERE si.status = 'ISSUED'`);
      expect(m.totals!.revenue).toBeCloseTo(net, 1);
      expect(m.totals!.margin).toBeCloseTo(Number(m.totals!.revenue) - Number(m.totals!.cost), 1);
      const byItem = await run('finance', 'sales-margin', { from: '2000-01-01', to, groupBy: 'item', storeId: ids.OPD });
      const { code } = await one(`SELECT code FROM item WHERE id = $1`, [ids.sold]);
      expect(byItem.rows.find((r) => String(r.label).startsWith(code))).toMatchObject({ quantity: 400, revenue: 20000, cost: 8000, margin: 12000, marginPercent: 60 });
    });

    it('supply chain KPIs render for the period', async () => {
      const k = await run('management', 'supply-chain-kpis', { from, to });
      expect(k.rows.map((r) => r.metric)).toEqual(expect.arrayContaining(['On time in full (OTIF)', 'Requisition fill rate', 'Months of stock', 'Wastage rate', 'Order to delivery']));
    });
  });

  describe('exports', () => {
    it('CSV with column labels and a totals row', async () => {
      const res = await bin(c.admin, `/reports/grn-register/export?format=csv&from=${from}&to=${to}`).expect(200);
      expect(res.headers['content-type']).toMatch(/text\/csv/);
      expect(res.headers['content-disposition']).toMatch(/grn-register-\d{8}\.csv/);
      const text = (res.body as Buffer).toString('utf8');
      expect(text.split('\r\n')[0]).toBe('GRN,Received,Supplier,Store,Order,Delivery note,Status,Emergency,Lines,Value in stock');
      expect(text).toMatch(/\r\nTotal,/);
    });

    it('Excel with title, filters and typed cells', async () => {
      const res = await bin(c.admin, `/reports/near-expiry/export?format=xlsx&days=400`).expect(200);
      const wb = new ExcelJS.Workbook();
      await wb.xlsx.load((res.body as Buffer) as never);
      const ws = wb.worksheets[0];
      expect(ws.getCell('A2').value).toBe('Near-expiry stock');
      expect(ws.getCell('A3').value).toBe('Days: 400');
      const header = ws.getRow(6).values as unknown[];
      expect(header).toEqual(expect.arrayContaining(['Store', 'Batch', 'Expiry', 'Value']));
      expect(typeof ws.getRow(7).getCell(8).value).toBe('number');
    });

    it('PDF', async () => {
      const res = await bin(c.admin, `/reports/stock-movement/export?format=pdf&from=${from}&to=${to}&storeId=${ids.MS}`).expect(200);
      expect(res.headers['content-type']).toBe('application/pdf');
      expect((res.body as Buffer).subarray(0, 4).toString()).toBe('%PDF');
      await c.admin.get(`/reports/stock-movement/export?format=docx&from=${from}&to=${to}`).expect(400);
      const logged = await one(`SELECT COUNT(*)::int AS n FROM report_run WHERE report_key = 'stock-movement' AND format = 'pdf'`);
      expect(logged.n).toBeGreaterThan(0);
    });
  });

  describe('scheduled reports', () => {
    it('resolves periods and next run times in local time', () => {
      expect(resolvePeriod(ReportPeriod.YESTERDAY, '2026-03-01')).toEqual({ from: '2026-02-28', to: '2026-02-28' });
      expect(resolvePeriod(ReportPeriod.LAST_WEEK, '2026-10-28')).toEqual({ from: '2026-10-19', to: '2026-10-25' }); // a Wednesday
      expect(resolvePeriod(ReportPeriod.LAST_MONTH, '2026-01-15')).toEqual({ from: '2025-12-01', to: '2025-12-31' });
      expect(resolvePeriod(ReportPeriod.MONTH_TO_DATE, '2026-10-27')).toEqual({ from: '2026-10-01', to: '2026-10-27' });
      const tz = 'Africa/Nairobi';
      const after = new Date('2026-10-27T05:00:00Z'); // 08:00 EAT, Tuesday
      expect(nextRun({ frequency: ReportFrequency.DAILY, hour: 7, weekday: null, monthDay: null }, after, tz).toISOString()).toBe('2026-10-28T04:00:00.000Z');
      expect(nextRun({ frequency: ReportFrequency.DAILY, hour: 9, weekday: null, monthDay: null }, after, tz).toISOString()).toBe('2026-10-27T06:00:00.000Z');
      expect(nextRun({ frequency: ReportFrequency.WEEKLY, hour: 7, weekday: 1, monthDay: null }, after, tz).toISOString()).toBe('2026-11-02T04:00:00.000Z');
      expect(nextRun({ frequency: ReportFrequency.MONTHLY, hour: 6, weekday: null, monthDay: 1 }, after, tz).toISOString()).toBe('2026-11-01T03:00:00.000Z');
    });

    it('emails a report on its schedule as its owner, with the file attached', async () => {
      const body = { name: 'Weekly near-expiry', reportKey: 'grn-register', filters: { storeId: ids.MS }, period: 'LAST_30_DAYS', format: 'xlsx', frequency: 'WEEKLY', hour: 7, weekday: 1, recipients: ['Stores@Example.org', 'stores@example.org', 'scm@example.org'] };
      await c.storekeeper.post('/reports/schedules', body).expect(403); // no reports.schedule
      await c.scm.post('/reports/schedules', { ...body, frequency: 'MONTHLY' }).expect(400); // no day of the month
      const s = (await c.scm.post('/reports/schedules', body).expect(201)).body;
      expect(s.recipients).toEqual(['stores@example.org', 'scm@example.org']);
      expect(s.filters).toEqual({ storeId: ids.MS });
      expect(new Date(s.nextRunAt).getUTCDay()).toBe(1);
      await c.management.put(`/reports/schedules/${s.id}`, body).expect(403); // someone else's
      expect((await c.management.get('/reports/schedules').expect(200)).body.find((x: { id: string }) => x.id === s.id)).toBeUndefined();

      // Due: the job sends it and moves the next run on.
      await q(`UPDATE report_schedule SET next_run_at = now() - interval '1 minute' WHERE id = $1`, [s.id]);
      const svc = ctx.app.get(ReportsService);
      expect(await svc.runDue()).toMatchObject({ due: 1, sent: 1 });
      const mails = await q(`SELECT to_address, subject, attachments FROM email_outbox WHERE source_doc_type = 'REPORT_SCHEDULE' AND source_doc_id = $1 ORDER BY to_address`, [s.id]);
      expect(mails.map((m: { to_address: string }) => m.to_address)).toEqual(['scm@example.org', 'stores@example.org']);
      expect(mails[0].subject).toBe(`Weekly near-expiry (${day(-30)} to ${day(-1)})`);
      const att = mails[0].attachments[0];
      expect(att).toMatchObject({ kind: 'REPORT_RUN', filename: expect.stringMatching(/^grn-register-\d{8}\.xlsx$/) });
      const run = await one(`SELECT filters, store_scope, user_id FROM report_run WHERE id = $1`, [att.id]);
      expect(run.filters).toEqual({ storeId: ids.MS, from: day(-30), to: day(-1) });
      const file = await svc.renderRun(att.id);
      const wb = new ExcelJS.Workbook();
      await wb.xlsx.load(file.body as never);
      expect(wb.worksheets[0].getCell('A2').value).toBe('GRN register');
      const after = await one(`SELECT next_run_at, last_run_at, last_error FROM report_schedule WHERE id = $1`, [s.id]);
      expect(new Date(after.next_run_at).getTime()).toBeGreaterThan(Date.now());
      expect(after.last_error).toBeNull();
      expect(await svc.runDue()).toMatchObject({ due: 0 });

      // Send now; a schedule the owner can no longer run records the error.
      expect((await c.scm.post(`/reports/schedules/${s.id}/send`).expect(200)).body.queued).toBe(2);
      await c.scm.delete(`/reports/schedules/${s.id}`).expect(204);
    });

    it('records why a scheduled report could not run', async () => {
      const s = (await c.management.post('/reports/schedules', { name: 'Margin', reportKey: 'sales-margin', period: 'YESTERDAY', format: 'csv', frequency: 'DAILY', hour: 6, recipients: ['md@example.org'] }).expect(201)).body;
      // The report goes away from the owner's role after scheduling.
      await q(`UPDATE report_schedule SET owner_id = (SELECT id FROM app_user WHERE username = 'storekeeper'), next_run_at = now() WHERE id = $1`, [s.id]);
      expect(await ctx.app.get(ReportsService).runDue()).toMatchObject({ sent: 0 });
      expect((await one(`SELECT last_error FROM report_schedule WHERE id = $1`, [s.id])).last_error).toMatch(/can no longer run/);
      await q(`DELETE FROM report_schedule WHERE id = $1`, [s.id]);
    });
  });

  describe('dashboard', () => {
    it('shows tiles for the role, within the user’s stores', async () => {
      const admin = (await c.admin.get('/dashboard').expect(200)).body;
      const keys = admin.tiles.map((t: { key: string }) => t.key);
      expect(keys).toEqual(expect.arrayContaining(['approvals', 'rx-waiting', 'stockout', 'stock-value', 'open-pos', 'sales-today', 'etims', 'quickbooks', 'docs-expiring']));
      const v = (await c.admin.get('/inventory/valuation').expect(200)).body;
      expect(admin.tiles.find((t: { key: string }) => t.key === 'stock-value').value).toBeCloseTo(v.total, 1);
      expect(admin.trends.map((t: { key: string }) => t.key)).toEqual(expect.arrayContaining(['stock-value', 'ordered', 'sales']));
      expect(admin.trends[0].points).toHaveLength(6);

      const cashier = (await c.cashier.get('/dashboard').expect(200)).body.tiles.map((t: { key: string }) => t.key);
      expect(cashier).toEqual(expect.arrayContaining(['sales-today']));
      expect(cashier).not.toContain('stock-value');
      expect(cashier).not.toContain('open-pos');

      const store = (await c.storekeeper.get('/dashboard').expect(200)).body.tiles;
      const [{ n }] = await q(`SELECT COUNT(*)::int AS n FROM stock_alert WHERE status = 'OPEN' AND type = 'STOCKOUT' AND store_id = $1`, [ids.MS]);
      expect(store.find((t: { key: string }) => t.key === 'stockout').value).toBe(n);
    });
  });

  describe('documents register', () => {
    /** A draft adjustment (a store record that takes attachments). */
    const adjustment = async (storeId = ids.MS) => {
      const a = (await c.admin.post('/inventory/adjustments', { storeId, reasonCode: 'FOUND', submit: false, lines: [{ itemId: ids.item, newBatchNo: uniq('F'), newBatchExpiryDate: day(200), quantity: 1 }] }).expect(201)).body;
      return { id: a.id as string, number: a.number as string };
    };

    it('lists attachments across records, with their owner, and expiring supplier documents', async () => {
      const grn = await adjustment();
      const name = `${uniq('dn')}.pdf`;
      await c.admin.agent.post(`${API}/attachments`).set('x-csrf-token', c.admin.csrf).field('ownerType', 'STOCK_ADJUSTMENT').field('ownerId', grn.id).field('category', 'DELIVERY_NOTE').attach('file', PDF, { filename: name, contentType: 'application/pdf' }).expect(201);
      const reg = (await c.scm.get(`/documents/register?search=${name.slice(0, 9)}`).expect(200)).body;
      expect(reg.items[0]).toMatchObject({ fileName: name, ownerType: 'STOCK_ADJUSTMENT', ownerTypeName: 'Stock adjustment', owner: grn.number, link: '/adjustments', category: 'DELIVERY_NOTE', version: 1 });
      // By the record's number too; facets list what the user may see.
      expect((await c.scm.get(`/documents/register?search=${grn.number}`).expect(200)).body.total).toBeGreaterThan(0);
      const facets = (await c.scm.get('/documents/register/facets').expect(200)).body;
      expect(facets.ownerTypes.map((t: { value: string }) => t.value)).toEqual(expect.arrayContaining(['GRN', 'STOCK_ADJUSTMENT', 'SUPPLIER_DOCUMENT']));
      expect(facets.categories).toContain('DELIVERY_NOTE');
      await c.cashier.get('/documents/register').expect(403);

      const sup = await one(`SELECT id FROM supplier WHERE status::text <> 'BLACKLISTED' LIMIT 1`);
      await c.admin.post(`/suppliers/${sup.id}/documents`, { documentType: 'PPB_LICENCE', reference: uniq('PPB'), expiresOn: day(20) }).expect(201);
      const exp = (await c.scm.get('/documents/register/expiring?days=30').expect(200)).body;
      expect(exp.find((d: { supplierId: string; daysLeft: number }) => d.supplierId === sup.id && d.daysLeft === 20)).toBeTruthy();
      expect((await c.scm.get('/documents/register/expiring?days=5').expect(200)).body.find((d: { supplierId: string; daysLeft: number }) => d.supplierId === sup.id && d.daysLeft === 20)).toBeUndefined();
    });

    it('applies store scope to store records', async () => {
      const mp = await adjustment(ids.MP);
      const name = `${uniq('scoped')}.pdf`;
      await c.admin.agent.post(`${API}/attachments`).set('x-csrf-token', c.admin.csrf).field('ownerType', 'STOCK_ADJUSTMENT').field('ownerId', mp.id).field('category', 'DELIVERY_NOTE').attach('file', PDF, { filename: name, contentType: 'application/pdf' }).expect(201);
      const grn = await adjustment();
      await c.admin.agent.post(`${API}/attachments`).set('x-csrf-token', c.admin.csrf).field('ownerType', 'STOCK_ADJUSTMENT').field('ownerId', grn.id).field('category', 'DELIVERY_NOTE').attach('file', PDF, { filename: name, contentType: 'application/pdf' }).expect(201);
      // The main store's storekeeper sees the main store's file, not the main pharmacy's.
      expect((await c.storekeeper.get(`/documents/register?search=${name}`).expect(200)).body.items.map((d: { ownerId: string }) => d.ownerId)).toEqual([grn.id]);
      expect((await c.scm.get(`/documents/register?search=${name}`).expect(200)).body.total).toBe(2);
    });
  });
});
