import { Client, createTestApp, loggedIn, TestContext, uniq } from './helpers';

describe('Audit log', () => {
  let ctx: TestContext;
  let admin: Client;
  let adminId: string;
  let facilityId: string;

  beforeAll(async () => {
    ctx = await createTestApp();
    admin = await loggedIn(ctx, 'admin');
    adminId = (await admin.get('/auth/me')).body.id;
    [{ id: facilityId }] = await ctx.ds.query(`SELECT id FROM facility LIMIT 1`);
  });
  afterAll(() => ctx.close());

  const entries = (entityType: string, entityId: string) =>
    ctx.ds.query(`SELECT * FROM audit_log WHERE entity_type = $1 AND entity_id = $2 ORDER BY id`, [entityType, entityId]);

  it('records create, update and delete with user, IP and before/after', async () => {
    const code = uniq('DEP');
    const created = await admin
      .post('/departments', { facilityId, code, name: 'Audit Dept', costCentreCode: uniq('CC') })
      .expect(201);
    const id = created.body.id;
    await admin.patch(`/departments/${id}`, { name: 'Audit Dept Renamed' }).expect(200);
    await admin.delete(`/departments/${id}`).expect(204);

    const rows = await entries('Department', id);
    expect(rows.map((r: { action: string }) => r.action)).toEqual(['CREATE', 'UPDATE', 'DELETE']);
    const [create, update, del] = rows;

    expect(create.user_id).toBe(adminId);
    expect(create.username).toBe('admin');
    expect(create.ip).toBeTruthy();
    expect(create.request_id).toBeTruthy();
    expect(create.before).toBeNull();
    expect(create.after).toMatchObject({ code, name: 'Audit Dept' });

    // Only changed fields, with old and new values.
    expect(update.before).toEqual({ name: 'Audit Dept' });
    expect(update.after).toEqual({ name: 'Audit Dept Renamed' });

    expect(del.before).toMatchObject({ id, name: 'Audit Dept Renamed' });
    expect(del.after).toBeNull();
  });

  it('fills created_by/updated_by on audited rows', async () => {
    const res = await admin.post('/uoms', { code: uniq('U'), name: 'Audit unit' }).expect(201);
    const [row] = await ctx.ds.query(`SELECT created_by, updated_by FROM unit_of_measure WHERE id = $1`, [res.body.id]);
    expect(row).toEqual({ created_by: adminId, updated_by: adminId });
  });

  it('never stores password hashes', async () => {
    const [role] = await ctx.ds.query(`SELECT id FROM role WHERE code = 'POS_CASHIER'`);
    const user = await admin
      .post('/users', { username: uniq('aud').toLowerCase(), fullName: 'Audit', password: 'Initial#Pass2026', roleIds: [role.id] })
      .expect(201);
    const rows = await entries('User', user.body.id);
    const create = rows.find((r: { action: string }) => r.action === 'CREATE');
    expect(create.after.passwordHash).toBe('[REDACTED]');
    expect(JSON.stringify(rows)).not.toMatch(/\$argon2id\$/);
    // Role assignment (join table) is audited explicitly.
    expect(rows.some((r: { after: { roleIds?: string[] } }) => r.after?.roleIds?.includes(role.id))).toBe(true);
  });

  it('is append-only at the database level', async () => {
    await expect(ctx.ds.query(`UPDATE audit_log SET action = 'X' WHERE id = (SELECT max(id) FROM audit_log)`)).rejects.toThrow(
      /append-only/,
    );
    await expect(ctx.ds.query(`DELETE FROM audit_log`)).rejects.toThrow(/append-only/);
    await expect(ctx.ds.query(`TRUNCATE audit_log`)).rejects.toThrow(/append-only/);
  });

  it('rolls the audit row back with the change', async () => {
    const before = Number((await ctx.ds.query(`SELECT count(*) FROM audit_log`))[0].count);
    // Duplicate code → unique violation inside the same transaction.
    await admin.post('/uoms', { code: 'TAB', name: 'Duplicate' }).expect(409);
    const after = Number((await ctx.ds.query(`SELECT count(*) FROM audit_log`))[0].count);
    expect(after).toBe(before);
  });

  it('is queryable through the API', async () => {
    const res = await admin.get('/audit-logs?entityType=Department&action=DELETE').expect(200);
    expect(res.body.total).toBeGreaterThan(0);
    expect(res.body.items[0].action).toBe('DELETE');
  });
});
