import { Client, createTestApp, idByCode, loggedIn, TestContext, uniq } from './helpers';

describe('RBAC and store scoping', () => {
  let ctx: TestContext;
  let admin: Client;
  let storekeeper: Client;
  let mainStoreId: string;
  let pharmacyId: string;

  beforeAll(async () => {
    ctx = await createTestApp();
    admin = await loggedIn(ctx, 'admin');
    storekeeper = await loggedIn(ctx, 'storekeeper'); // assigned to MS only
    mainStoreId = await idByCode(ctx.ds, 'store', 'MS');
    pharmacyId = await idByCode(ctx.ds, 'store', 'MP');
  });
  afterAll(() => ctx.close());

  it('seeds every required role', async () => {
    const roles = await admin.get('/roles').expect(200);
    expect(roles.body.filter((r: { isSystem: boolean }) => r.isSystem).map((r: { code: string }) => r.code).sort()).toEqual(
      [
        'AUDITOR', 'FINANCE', 'HOSPITAL_MANAGEMENT', 'PHARMACIST', 'PHARMACY_TECHNICIAN', 'POS_CASHIER',
        'PROCUREMENT_MANAGER', 'PROCUREMENT_OFFICER', 'QUALITY_OFFICER', 'STOREKEEPER', 'SUPPLIER',
        'SUPPLY_CHAIN_MANAGER', 'SYSTEM_ADMIN', 'TENDER_COMMITTEE', 'WARD_IN_CHARGE', 'WARD_STAFF',
      ].sort(),
    );
  });

  it('requires a session for protected routes', async () => {
    await new Client(ctx).get('/items').expect(401);
  });

  it('enforces permissions per route', async () => {
    const cashier = await loggedIn(ctx, 'cashier');
    await cashier.get('/items').expect(200);
    const denied = await cashier.post('/generics', { innName: 'Nope' });
    expect(denied.status).toBe(403);
    expect(denied.body.message).toContain('catalog.manage');
    await cashier.get('/users').expect(403);

    const auditor = await loggedIn(ctx, 'auditor');
    await auditor.get('/audit-logs').expect(200);
    await auditor.post('/departments', {}).expect(403);
  });

  it('applies role permission changes immediately', async () => {
    const code = uniq('ROLE').replace('-', '_');
    const role = await admin.post('/roles', { code, name: 'Temp role', permissionCodes: [] }).expect(201);
    const username = uniq('rbac').toLowerCase();
    const user = await admin
      .post('/users', { username, fullName: 'Role Test', password: 'Initial#Pass2026', roleIds: [role.body.id] })
      .expect(201);
    await ctx.ds.query(`UPDATE app_user SET must_change_password = false WHERE id = $1`, [user.body.id]);
    const client = new Client(ctx);
    await client.login(username, 'Initial#Pass2026');
    await client.get('/items').expect(403);
    await admin.patch(`/roles/${role.body.id}`, { permissionCodes: ['catalog.read'] }).expect(200);
    await client.get('/items').expect(200);
  });

  it('limits store lists to assigned stores', async () => {
    const res = await storekeeper.get('/stores').expect(200);
    expect(res.body.items.map((s: { code: string }) => s.code)).toEqual(['MS']);
    const all = await admin.get('/stores').expect(200);
    expect(all.body.total).toBeGreaterThanOrEqual(6);
  });

  it('blocks direct access to another store (guard) and its bins (repository filter)', async () => {
    await storekeeper.get(`/stores/${mainStoreId}`).expect(200);
    await storekeeper.get(`/stores/${pharmacyId}`).expect(403);
    await storekeeper.get(`/bins?storeId=${pharmacyId}`).expect(403);

    const bins = await storekeeper.get('/bins?pageSize=100').expect(200);
    expect(bins.body.items.length).toBeGreaterThan(0);
    expect(bins.body.items.every((b: { storeId: string }) => b.storeId === mainStoreId)).toBe(true);

    const [pharmacyBin] = await ctx.ds.query(`SELECT id FROM bin WHERE store_id = $1 LIMIT 1`, [pharmacyId]);
    await storekeeper.get(`/bins/${pharmacyBin.id}`).expect(404);
    await storekeeper.patch(`/bins/${pharmacyBin.id}`, { name: 'hijack' }).expect(404);
  });

  it('lets a storekeeper manage bins only in their own store', async () => {
    const ok = await storekeeper.post('/bins', { storeId: mainStoreId, code: uniq('SK'), name: 'Shelf' });
    expect(ok.status).toBe(201);
    await storekeeper.post('/bins', { storeId: pharmacyId, code: uniq('SK'), name: 'Shelf' }).expect(403);
  });

  it('gives store.all holders every store', async () => {
    const scm = await loggedIn(ctx, 'scm');
    const me = await scm.get('/auth/me').expect(200);
    expect(me.body.storeIds).toBeNull();
    await scm.get(`/stores/${pharmacyId}`).expect(200);
  });
});
