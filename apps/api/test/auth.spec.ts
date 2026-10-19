import { authenticator } from 'otplib';
import { Client, createTestApp, loggedIn, TestContext, API, uniq } from './helpers';
import { TEST_PASSWORD } from './env';

describe('Authentication', () => {
  let ctx: TestContext;
  let admin: Client;

  beforeAll(async () => {
    ctx = await createTestApp();
    admin = await loggedIn(ctx, 'admin');
  });
  afterAll(() => ctx.close());

  async function createUser(username: string, password = 'Initial#Pass2026') {
    const [role] = await ctx.ds.query(`SELECT id FROM role WHERE code = 'PHARMACY_TECHNICIAN'`);
    const res = await admin.post('/users', { username, fullName: 'Test User', password, roleIds: [role.id] });
    expect(res.status).toBe(201);
    return res.body;
  }

  it('rejects state-changing requests without a CSRF token', async () => {
    const client = new Client(ctx);
    await client.agent.post(`${API}/auth/login`).send({ username: 'admin', password: TEST_PASSWORD }).expect(403);
  });

  it('logs in with a server-side session cookie and logs out', async () => {
    const client = new Client(ctx);
    const res = await client.login('pharmacist');
    expect(res.status).toBe(200);
    expect(res.body.twoFactorRequired).toBe(false);
    expect(res.body.user.username).toBe('pharmacist');
    expect(res.body.user).not.toHaveProperty('passwordHash');
    const cookie = String(res.headers['set-cookie']);
    expect(cookie).toMatch(/silp\.sid=/);
    expect(cookie).toMatch(/HttpOnly/i);

    const me = await client.get('/auth/me').expect(200);
    expect(me.body.permissions).toContain('catalog.read');

    await client.post('/auth/logout').expect(204);
    await client.get('/auth/me').expect(401);
  });

  it('rejects a wrong password with a generic message and audits it', async () => {
    const client = new Client(ctx);
    const res = await client.login('pharmacist', 'Wrong#Password1');
    expect(res.status).toBe(401);
    expect(res.body.message).toBe('Invalid username or password');
    const unknown = await client.login('no.such.user', 'Wrong#Password1');
    expect(unknown.body.message).toBe('Invalid username or password');

    const [row] = await ctx.ds.query(
      `SELECT * FROM audit_log WHERE action = 'LOGIN_FAILED' AND after->>'username' = 'pharmacist' ORDER BY id DESC LIMIT 1`,
    );
    expect(row.after.reason).toBe('bad_password');
  });

  it('locks the account after the configured number of failures', async () => {
    const username = uniq('lock').toLowerCase();
    await createUser(username);
    const [{ value: max }] = await ctx.ds.query(`SELECT value FROM system_setting WHERE key = 'security.maxFailedLogins'`);
    const client = new Client(ctx);
    for (let i = 0; i < max; i++) expect((await client.login(username, 'Bad#Password999')).status).toBe(401);
    const locked = await client.login(username, 'Initial#Pass2026');
    expect(locked.status).toBe(401);
    expect(locked.body.code).toBe('LOCKED');
  });

  it('forces a password change for admin-created users and enforces the password policy', async () => {
    const username = uniq('new').toLowerCase();
    await createUser(username);
    const client = new Client(ctx);
    expect((await client.login(username, 'Initial#Pass2026')).status).toBe(200);

    const blocked = await client.get('/items');
    expect(blocked.status).toBe(403);
    expect(blocked.body.code).toBe('PASSWORD_CHANGE_REQUIRED');

    const weak = await client.post('/auth/change-password', { currentPassword: 'Initial#Pass2026', newPassword: 'short' });
    expect(weak.status).toBe(400);
    expect(weak.body.code).toBe('PASSWORD_POLICY');
    expect(weak.body.errors.length).toBeGreaterThan(0);

    await client
      .post('/auth/change-password', { currentPassword: 'Initial#Pass2026', newPassword: 'Better#Passw0rd2026' })
      .expect(204);
    await client.get('/items').expect(200);
  });

  it('rejects creating a user with a password that breaks the policy', async () => {
    const [role] = await ctx.ds.query(`SELECT id FROM role WHERE code = 'POS_CASHIER'`);
    const res = await admin.post('/users', { username: 'weak.user', fullName: 'Weak', password: 'password', roleIds: [role.id] });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('PASSWORD_POLICY');
  });

  it('enrols TOTP and then requires the second factor at login', async () => {
    const username = uniq('totp').toLowerCase();
    await createUser(username);
    const client = new Client(ctx);
    await client.login(username, 'Initial#Pass2026');
    await client.post('/auth/change-password', { currentPassword: 'Initial#Pass2026', newPassword: 'Totp#Passw0rd2026' }).expect(204);

    const setup = await client.post('/auth/2fa/setup').expect(200);
    expect(setup.body.otpauthUrl).toMatch(/^otpauth:\/\/totp\//);
    expect(setup.body.qrDataUrl).toMatch(/^data:image\/png;base64,/);
    await client.post('/auth/2fa/enable', { code: '000000' }).expect(400);
    await client.post('/auth/2fa/enable', { code: authenticator.generate(setup.body.secret) }).expect(204);

    // Secret is stored encrypted.
    const [row] = await ctx.ds.query(`SELECT totp_secret_enc FROM app_user WHERE username = $1`, [username]);
    expect(row.totp_secret_enc).not.toContain(setup.body.secret);

    await client.post('/auth/logout').expect(204);
    const fresh = new Client(ctx);
    const step1 = await fresh.login(username, 'Totp#Passw0rd2026');
    expect(step1.status).toBe(200);
    expect(step1.body).toMatchObject({ twoFactorRequired: true, user: null });
    await fresh.get('/auth/me').expect(401);

    await fresh.post('/auth/2fa/verify', { code: '123456' }).expect(401);
    const step2 = await fresh.post('/auth/2fa/verify', { code: authenticator.generate(setup.body.secret) });
    expect(step2.status).toBe(200);
    fresh.csrf = step2.body.csrfToken;
    expect(step2.body.user.totpEnabled).toBe(true);
    await fresh.get('/auth/me').expect(200);
  });

  it('kicks out a user as soon as they are deactivated', async () => {
    const username = uniq('deact').toLowerCase();
    const user = await createUser(username);
    const client = new Client(ctx);
    await client.login(username, 'Initial#Pass2026');
    await client.get('/auth/me').expect(200);
    await admin.patch(`/users/${user.id}`, { isActive: false }).expect(200);
    await client.get('/auth/me').expect(401);
  });
});
