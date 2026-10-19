import { computeAmc, computeLevels } from '../src/modules/planning/planning-math';
import { Client, createTestApp, idByCode, loggedIn, TestContext, uniq } from './helpers';

const addDays = (days: number) =>
  new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Nairobi', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(Date.now() + days * 86_400_000));

describe('Stock planning, alerts and jobs', () => {
  let ctx: TestContext;
  const c: Record<string, Client> = {};
  let ids: Record<string, string>;

  beforeAll(async () => {
    ctx = await createTestApp();
    for (const u of ['admin', 'storekeeper', 'scm', 'proc.officer', 'pharmacist', 'ward.nurse', 'ward.incharge']) c[u] = await loggedIn(ctx, u);
    ids = {
      MS: await idByCode(ctx.ds, 'store', 'MS'),
      MP: await idByCode(ctx.ds, 'store', 'MP'),
      OPD: await idByCode(ctx.ds, 'store', 'OPD-PH'),
      ipd: await idByCode(ctx.ds, 'department', 'IPD-MED'),
      drugs: await idByCode(ctx.ds, 'item_category', 'DRUG'),
      tab: await idByCode(ctx.ds, 'unit_of_measure', 'TAB'),
      exempt: await idByCode(ctx.ds, 'tax_category', 'EXEMPT'),
      storekeeper: (await ctx.ds.query(`SELECT id FROM app_user WHERE username = 'storekeeper'`))[0].id,
    };
  });
  afterAll(() => ctx.close());

  async function newItem(categoryId?: string) {
    const g = await c.admin.post('/generics', { innName: `Planocillin ${uniq('g')}`, strength: '250 mg', dosageForm: 'Tablet', route: 'Oral', controlledSchedule: 'NONE' }).expect(201);
    const cat = categoryId ?? (await ctx.ds.query(`SELECT id FROM item_category WHERE code = 'DRUG-ANTIINF'`))[0].id;
    const item = await c.admin.post('/items', { genericId: g.body.id, categoryId: cat, name: `Planocillin ${uniq('i')}`, baseUomId: ids.tab, unitPrice: 5, taxCategoryId: ids.exempt }).expect(201);
    return item.body as { id: string; code: string; name: string };
  }

  async function stock(storeId: string, itemId: string, batches: { no: string; expiry: string; qty: number; cost?: number }[]) {
    await c.scm
      .post('/inventory/receipts', { storeId, type: 'OPENING', lines: batches.map((b) => ({ itemId, batchNo: b.no, expiryDate: b.expiry, quantity: b.qty, unitCost: b.cost ?? 2 })) })
      .expect(201);
  }

  async function issue(itemId: string, quantity: number) {
    const sr = await c['ward.nurse'].post('/store-requisitions', { departmentId: ids.ipd, storeId: ids.MS, lines: [{ itemId, quantity }], submit: true }).expect(201);
    const [req] = await ctx.ds.query(`SELECT id FROM approval_request WHERE document_id = $1 AND status = 'PENDING'`, [sr.body.id]);
    await c['ward.incharge'].post(`/approvals/${req.id}/approve`, {}).expect(200);
    await c.storekeeper.post(`/store-requisitions/${sr.body.id}/issues`, {}).expect(201);
    return sr.body.id as string;
  }

  const runJob = async (name: string, body: object = {}) => {
    const r = await c.scm.post(`/jobs/${name}/run`, body).expect(200);
    expect(r.body.run.status).toBe('SUCCEEDED');
    return r.body.run.result;
  };
  const setting = async (storeId: string, itemId: string) => (await ctx.ds.query(`SELECT * FROM store_item_setting WHERE store_id = $1 AND item_id = $2`, [storeId, itemId]))[0];
  const alerts = (itemId: string, type?: string) =>
    ctx.ds.query(`SELECT * FROM stock_alert WHERE item_id = $1 ${type ? 'AND type = $2' : ''} ORDER BY raised_at, horizon_days`, type ? [itemId, type] : [itemId]);
  const notes = async (userId: string, like: string) =>
    (await ctx.ds.query(`SELECT count(*)::int AS n FROM notification WHERE user_id = $1 AND body ILIKE $2`, [userId, `%${like}%`]))[0].n;
  const mails = async (to: string, like: string) =>
    (await ctx.ds.query(`SELECT count(*)::int AS n FROM email_outbox WHERE to_address = $1 AND body_text ILIKE $2`, [to, `%${like}%`]))[0].n;

  describe('jobs', () => {
    it('lists the registered jobs and runs reconciliation on demand (recorded in job_run)', async () => {
      const list = await c.scm.get('/jobs').expect(200);
      expect(list.body.mode).toBe('inline');
      expect(list.body.jobs.map((j: { name: string }) => j.name)).toEqual(expect.arrayContaining(['inventory.reconcile', 'stock.amc', 'stock.reorder', 'stock.expiry', 'stores.replan']));
      expect(list.body.jobs.find((j: { name: string }) => j.name === 'inventory.reconcile').schedule).toBe('0 2 * * *');
      const result = await runJob('inventory.reconcile');
      expect(result).toMatchObject({ driftCount: 0, reservationDriftCount: 0 });
      const runs = await c.scm.get('/jobs/runs?name=inventory.reconcile').expect(200);
      expect(runs.body[0]).toMatchObject({ status: 'SUCCEEDED', trigger: 'manual' });
      await c.storekeeper.post('/jobs/inventory.reconcile/run', {}).expect(403);
      await c.scm.post('/jobs/no.such.job/run', {}).expect(404);
    });
  });

  describe('AMC and reorder levels', () => {
    let item: { id: string; code: string; name: string };

    beforeAll(async () => {
      item = await newItem();
      await stock(ids.MS, item.id, [{ no: 'A1', expiry: addDays(300), qty: 200 }]);
      await issue(item.id, 60);
    });

    it('calculates AMC from issues (stock-out days left out) and AUTO levels; re-running changes nothing', async () => {
      await runJob('stock.amc', { storeId: ids.MS });
      const row = await setting(ids.MS, item.id);
      // Received and issued today: every earlier day of the window was a stock-out.
      const { amc } = computeAmc({ consumed: 60, windowDays: 90, stockoutDays: 89, excludeStockoutDays: true, minDays: 14 });
      expect(Number(row.amc)).toBeCloseTo(amc, 3);
      const lv = computeLevels({ amc, leadTimeDays: 14, reviewPeriodDays: 30, safetyStockDays: 7 });
      expect(row).toMatchObject({ mode: 'AUTO' });
      expect(Number(row.reorder_level)).toBe(lv.reorderLevel);
      expect(Number(row.max_level)).toBe(lv.maxLevel);
      expect(Number(row.reorder_qty)).toBe(lv.reorderQty);
      expect(Number(row.safety_stock)).toBe(lv.safetyStock);
      const again = await runJob('stock.amc', { storeId: ids.MS });
      expect(again.changed).toBe(0);
    });

    it('keeps manual levels when the AMC is recalculated', async () => {
      const row = await setting(ids.MS, item.id);
      const upd = await c.storekeeper.put(`/stock-planning/settings/${row.id}`, { reorderLevel: 999, maxLevel: 2000 }).expect(200);
      expect(upd.body.mode).toBe('MANUAL');
      await issue(item.id, 10);
      await runJob('stock.amc', { storeId: ids.MS });
      const after = await setting(ids.MS, item.id);
      expect(Number(after.reorder_level)).toBe(999);
      expect(Number(after.max_level)).toBe(2000);
      expect(Number(after.amc)).toBeGreaterThan(Number(row.amc)); // AMC still refreshed
      // Back to AUTO for the next tests.
      await c.storekeeper.put(`/stock-planning/settings/${row.id}`, { mode: 'AUTO' }).expect(200);
      await runJob('stock.amc', { storeId: ids.MS });
    });
  });

  describe('reorder engine and alerts', () => {
    let item: { id: string; code: string; name: string };
    let settingId: string;

    beforeAll(async () => {
      item = await newItem();
      await stock(ids.MS, item.id, [{ no: 'R1', expiry: addDays(300), qty: 50 }]);
      await runJob('stock.amc', { storeId: ids.MS });
      const s = await c.storekeeper.put(`/stock-planning/settings/${ids.MS}/${item.id}`, { reorderLevel: 100, maxLevel: 300, reorderQty: 200 }).expect(200);
      settingId = s.body.id;
    });

    it('raises one alert per crossing, notifies once (in-app + email), and resolves when stock recovers', async () => {
      await runJob('stock.reorder', { storeId: ids.MS });
      let open = (await alerts(item.id, 'REORDER')).filter((a: { status: string }) => a.status === 'OPEN');
      expect(open).toHaveLength(1);
      expect(await notes(ids.storekeeper, item.name)).toBe(1);
      expect(await mails('storekeeper@hospital.example', item.name)).toBe(1);

      // Idempotent: nothing new while the condition holds.
      await runJob('stock.reorder', { storeId: ids.MS });
      expect(await alerts(item.id, 'REORDER')).toHaveLength(1);
      expect(await notes(ids.storekeeper, item.name)).toBe(1);

      // Report row and suggestion: top up to max from available 50.
      const report = await c.storekeeper.get(`/stock-planning/reorder?storeId=${ids.MS}&itemId=${item.id}`).expect(200);
      expect(report.body[0]).toMatchObject({ available: 50, reorderLevel: 100, below: true, suggestedQty: 250 });

      await stock(ids.MS, item.id, [{ no: 'R2', expiry: addDays(300), qty: 100 }]);
      await runJob('stock.reorder', { storeId: ids.MS });
      const resolved = await alerts(item.id, 'REORDER');
      expect(resolved.map((a: { status: string }) => a.status)).toEqual(['RESOLVED']);

      // Dropping below again raises a new alert.
      await c.storekeeper.put(`/stock-planning/settings/${settingId}`, { reorderLevel: 500 }).expect(200);
      await runJob('stock.reorder', { storeId: ids.MS });
      open = (await alerts(item.id, 'REORDER')).filter((a: { status: string }) => a.status === 'OPEN');
      expect(open).toHaveLength(1);
      expect(await notes(ids.storekeeper, item.name)).toBe(2);
    });

    it('follows the user preference (email off, in-app on)', async () => {
      const prefs = await c.storekeeper.get('/notifications/preferences').expect(200);
      expect(prefs.body.find((p: { category: string }) => p.category === 'REORDER')).toMatchObject({ inApp: true, email: true, sms: false });
      await c.storekeeper.put('/notifications/preferences', { preferences: [{ category: 'REORDER', inApp: true, email: false, sms: false }] }).expect(200);
      try {
        const other = await newItem();
        await stock(ids.MS, other.id, [{ no: 'P1', expiry: addDays(300), qty: 5 }]);
        await c.storekeeper.put(`/stock-planning/settings/${ids.MS}/${other.id}`, { reorderLevel: 10, maxLevel: 20 }).expect(200);
        await runJob('stock.reorder', { storeId: ids.MS });
        expect(await notes(ids.storekeeper, other.name)).toBe(1);
        expect(await mails('storekeeper@hospital.example', other.name)).toBe(0);
      } finally {
        await c.storekeeper.put('/notifications/preferences', { preferences: [{ category: 'REORDER', inApp: true, email: true, sms: false }] }).expect(200);
      }
    });

    it('exports the report and turns suggestions into a draft PR (buying store) or a transfer request (satellite)', async () => {
      const csv = await c.storekeeper.get(`/stock-planning/reorder?storeId=${ids.MS}&belowOnly=true&format=csv`).expect(200);
      expect(csv.headers['content-type']).toMatch(/text\/csv/);
      expect(csv.text.split('\r\n')[0]).toMatch(/^Store,Item code,Item,Unit/);
      const xlsx = await c.storekeeper.get(`/stock-planning/reorder?storeId=${ids.MS}&belowOnly=true&format=xlsx`).buffer(true).parse((res, cb) => {
        const chunks: Buffer[] = [];
        res.on('data', (d: Buffer) => chunks.push(d));
        res.on('end', () => cb(null, Buffer.concat(chunks)));
      });
      expect(xlsx.status).toBe(200);
      expect((xlsx.body as Buffer).subarray(0, 2).toString()).toBe('PK');

      const row = (await c.storekeeper.get(`/stock-planning/reorder?storeId=${ids.MS}&itemId=${item.id}`)).body[0];
      const pr = await c['proc.officer']
        .post('/stock-planning/reorder/requisition', { storeId: ids.MS, departmentId: ids.ipd, lines: [{ itemId: item.id, quantity: row.suggestedQty }] })
        .expect(201);
      expect(pr.body.kind).toBe('PR');
      const doc = await c['proc.officer'].get(`/requisitions/${pr.body.id}`).expect(200);
      expect(doc.body).toMatchObject({ status: 'DRAFT', storeId: ids.MS });
      expect(doc.body.lines[0]).toMatchObject({ itemId: item.id, quantity: row.suggestedQty });
      // It then goes through the normal approval engine.
      await c['proc.officer'].post(`/requisitions/${pr.body.id}/submit`).expect(200);
      const [req] = await ctx.ds.query(`SELECT status FROM approval_request WHERE document_id = $1`, [pr.body.id]);
      expect(req.status).toBe('PENDING');

      // A satellite pharmacy asks its parent store instead.
      const t = await c.pharmacist.post('/stock-planning/reorder/requisition', { storeId: ids.OPD, lines: [{ itemId: item.id, quantity: 10 }] }).expect(201);
      expect(t.body.kind).toBe('TRANSFER');
      const [trf] = await ctx.ds.query(`SELECT from_store_id, to_store_id, status FROM stock_transfer WHERE id = $1`, [t.body.id]);
      expect(trf).toMatchObject({ from_store_id: ids.MP, to_store_id: ids.OPD, status: 'REQUESTED' });
    });
  });

  describe('expiry engine', () => {
    let item: { id: string; code: string; name: string };
    let batches: Record<string, string>;

    beforeAll(async () => {
      item = await newItem();
      await stock(ids.MS, item.id, [
        { no: 'E-20', expiry: addDays(20), qty: 10, cost: 3 },
        { no: 'E-50', expiry: addDays(50), qty: 10, cost: 3 },
        { no: 'E-100', expiry: addDays(100), qty: 10, cost: 3 },
        { no: 'E-PAST', expiry: addDays(-2), qty: 4, cost: 3 },
      ]);
      const rows = await ctx.ds.query(`SELECT id, batch_no FROM batch WHERE item_id = $1`, [item.id]);
      batches = Object.fromEntries(rows.map((r: { id: string; batch_no: string }) => [r.batch_no, r.id]));
    });

    it('fires each horizon once per batch, announces the tightest only, and holds expired batches', async () => {
      await runJob('stock.expiry');
      const near = await alerts(item.id, 'NEAR_EXPIRY');
      const by = (b: string) => near.filter((a: { batch_id: string }) => a.batch_id === batches[b]).map((a: { horizon_days: number }) => a.horizon_days);
      expect(by('E-20')).toEqual([30, 60, 90, 180]);
      expect(by('E-50')).toEqual([60, 90, 180]);
      expect(by('E-100')).toEqual([180]);
      // One message per run for the store, listing each batch once at its tightest horizon.
      const announced = near.filter((a: { notified_count: number }) => a.notified_count > 0).map((a: { horizon_days: number }) => a.horizon_days).sort();
      expect(announced).toEqual([180, 30, 60].sort());
      const [held] = await ctx.ds.query(`SELECT hold_status FROM batch WHERE id = $1`, [batches['E-PAST']]);
      expect(held.hold_status).toBe('EXPIRED');
      expect(await alerts(item.id, 'EXPIRED')).toHaveLength(1);

      // Re-running fires nothing new.
      await runJob('stock.expiry');
      expect(await alerts(item.id, 'NEAR_EXPIRY')).toHaveLength(near.length);
      expect(await alerts(item.id, 'EXPIRED')).toHaveLength(1);

      // Time passes: E-100 now has 40 days left → only the 60 and 90 day horizons are new.
      await ctx.ds.query(`UPDATE batch SET expiry_date = $2::date WHERE id = $1`, [batches['E-100'], addDays(40)]);
      await runJob('stock.expiry');
      expect(by('E-100')).toEqual([180]); // the earlier snapshot
      const later = (await alerts(item.id, 'NEAR_EXPIRY')).filter((a: { batch_id: string }) => a.batch_id === batches['E-100']).map((a: { horizon_days: number }) => a.horizon_days);
      expect(later.sort((a: number, b: number) => a - b)).toEqual([60, 90, 180]);
    });

    it('uses the category horizons when set', async () => {
      const cat = await c.admin.post('/item-categories', { code: uniq('CAT'), name: 'Short horizon test', isDrug: true, parentId: ids.drugs, expiryAlertDays: [45] }).expect(201);
      const it2 = await newItem(cat.body.id);
      await stock(ids.MS, it2.id, [{ no: 'C-40', expiry: addDays(40), qty: 5 }, { no: 'C-80', expiry: addDays(80), qty: 5 }]);
      await runJob('stock.expiry');
      const rows = await alerts(it2.id, 'NEAR_EXPIRY');
      expect(rows.map((a: { horizon_days: number }) => a.horizon_days)).toEqual([45]);
    });

    it('reports near-expiry value with a redistribution target, and redistributes or writes off with a disposal certificate', async () => {
      await ctx.ds.query(
        `INSERT INTO store_item_setting (store_id, item_id, mode, amc) VALUES ($1, $2, 'MANUAL', 500)
         ON CONFLICT (store_id, item_id) DO UPDATE SET amc = 500`,
        [ids.MP, item.id],
      );
      const rep = await c.storekeeper.get(`/stock-planning/expiry?storeId=${ids.MS}&horizonDays=60&search=${item.code}`).expect(200);
      const e20 = rep.body.find((r: { batchNo: string }) => r.batchNo === 'E-20');
      expect(e20).toMatchObject({ quantity: 10, value: 30, daysLeft: 20, atRisk: true, suggestedStore: { id: ids.MP, name: 'Main Pharmacy' } });
      expect(rep.body.some((r: { batchNo: string }) => r.batchNo === 'E-PAST')).toBe(false);
      const withExpired = await c.storekeeper.get(`/stock-planning/expiry?storeId=${ids.MS}&includeExpired=true&search=${item.code}`).expect(200);
      expect(withExpired.body.find((r: { batchNo: string }) => r.batchNo === 'E-PAST')).toMatchObject({ holdStatus: 'EXPIRED' });

      const trf = await c.storekeeper.post('/stock-planning/expiry/redistribute', { batchId: batches['E-20'], fromStoreId: ids.MS, toStoreId: ids.MP, quantity: 10 }).expect(201);
      expect(trf.body).toMatchObject({ fromStoreId: ids.MS, toStoreId: ids.MP, status: 'REQUESTED' });

      const wo = await c.storekeeper.post('/stock-planning/expiry/write-off', { storeId: ids.MS, lines: [{ batchId: batches['E-PAST'], quantity: 4 }], notes: 'Expired' }).expect(201);
      expect(wo.body).toMatchObject({ status: 'SUBMITTED', reasonCode: 'EXPIRY' });
      await c.storekeeper.get(`/stock-planning/disposal-certificate/${wo.body.id}`).expect(400); // not posted yet
      await c.scm.post(`/inventory/adjustments/${wo.body.id}/approve`).expect(200);
      const pdf = await c.storekeeper.get(`/stock-planning/disposal-certificate/${wo.body.id}`).buffer(true).parse((res, cb) => {
        const chunks: Buffer[] = [];
        res.on('data', (d: Buffer) => chunks.push(d));
        res.on('end', () => cb(null, Buffer.concat(chunks)));
      });
      expect(pdf.status).toBe(200);
      expect(pdf.headers['content-type']).toBe('application/pdf');
      expect((pdf.body as Buffer).subarray(0, 5).toString()).toBe('%PDF-');
    });

    it('shows dashboard figures', async () => {
      const d = await c.storekeeper.get(`/stock-planning/dashboard?storeId=${ids.MS}`).expect(200);
      expect(d.body.nearExpiry.map((b: { horizonDays: number }) => b.horizonDays)).toEqual([30, 60, 90, 180]);
      expect(d.body.reorderAlerts).toBeGreaterThan(0);
      expect(d.body.nearExpiry[0].value).toBeGreaterThan(0);
    });
  });

  describe('back-orders re-planned when stock arrives', () => {
    it('reserves new stock for open back-orders and tells the store', async () => {
      const item = await newItem();
      await stock(ids.MS, item.id, [{ no: 'B1', expiry: addDays(200), qty: 4 }]);
      const srId = await issue(item.id, 10); // 4 issued, 6 on back-order
      let sr = (await c.storekeeper.get(`/store-requisitions/${srId}`)).body;
      expect(sr).toMatchObject({ status: 'PARTIALLY_ISSUED' });
      expect(sr.lines[0]).toMatchObject({ outstandingQty: 6, reservedQty: 0 });

      await stock(ids.MS, item.id, [{ no: 'B2', expiry: addDays(250), qty: 20 }]);
      sr = (await c.storekeeper.get(`/store-requisitions/${srId}`)).body;
      expect(sr.lines[0].reservedQty).toBe(6);
      const [n] = await ctx.ds.query(`SELECT body FROM notification WHERE user_id = $1 AND title LIKE 'Back-orders ready%' ORDER BY created_at DESC LIMIT 1`, [ids.storekeeper]);
      expect(n.body).toContain(sr.number);
      const [run] = await ctx.ds.query(`SELECT trigger, status FROM job_run WHERE name = 'stores.replan' ORDER BY started_at DESC LIMIT 1`);
      expect(run).toMatchObject({ trigger: 'event', status: 'SUCCEEDED' });
    });
  });
});
