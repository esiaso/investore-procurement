import { authenticator } from 'otplib';
import request from 'supertest';
import { contentDisposition } from '../src/modules/files/files.module';
import { resetEnvCache } from '../src/config/env';
import { API, Client, createTestApp, loggedIn, TestContext, uniq } from './helpers';

// Go-live hardening: sign-in limits, 2FA guessing, API docs switch, safe download names.
// A low sign-in limit for this suite only (test/env.ts resets it for the next file).
process.env.AUTH_RATE_LIMIT_PER_MINUTE = '25';
process.env.API_DOCS = 'false';
resetEnvCache();

describe('Security hardening', () => {
  let ctx: TestContext;
  let admin: Client;

  beforeAll(async () => {
    ctx = await createTestApp();
    admin = await loggedIn(ctx, 'admin');
  });
  afterAll(() => ctx.close());

  /** A user with TOTP enabled; returns the username and secret. */
  async function totpUser() {
    const username = uniq('sec').toLowerCase();
    const [role] = await ctx.ds.query(`SELECT id FROM role WHERE code = 'PHARMACY_TECHNICIAN'`);
    await admin.post('/users', { username, fullName: 'Sec Test', password: 'Initial#Pass2026', roleIds: [role.id] }).expect(201);
    const c = new Client(ctx);
    await c.login(username, 'Initial#Pass2026');
    await c.post('/auth/change-password', { currentPassword: 'Initial#Pass2026', newPassword: 'Totp#Passw0rd2026' }).expect(204);
    const setup = await c.post('/auth/2fa/setup').expect(200);
    await c.post('/auth/2fa/enable', { code: authenticator.generate(setup.body.secret) }).expect(204);
    return { username, secret: setup.body.secret as string };
  }

  /** A 6-digit code that is not valid in the current, previous or next step. */
  function wrongCode(secret: string) {
    const valid = new Set([-30, 0, 30].map((d) => authenticator.clone({ epoch: Date.now() + d * 1000 }).generate(secret)));
    for (let i = 0; ; i++) {
      const code = String(100000 + i);
      if (!valid.has(code)) return code;
    }
  }

  it('drops a pending 2FA login after 5 wrong codes and counts them towards the lockout', async () => {
    const { username, secret } = await totpUser();
    const c = new Client(ctx);
    expect((await c.login(username, 'Totp#Passw0rd2026')).body.twoFactorRequired).toBe(true);
    for (let i = 0; i < 4; i++) expect((await c.post('/auth/2fa/verify', { code: wrongCode(secret) })).body.message).toBe('Invalid code');
    const fifth = await c.post('/auth/2fa/verify', { code: wrongCode(secret) }).expect(401);
    expect(fifth.body.message).toMatch(/sign in again/);
    // Even the right code is refused now: the pending login is gone.
    expect((await c.post('/auth/2fa/verify', { code: authenticator.generate(secret) })).body.message).toMatch(/sign in again|Login expired/);

    // Five wrong codes = five failed logins: the account is locked.
    const [u] = await ctx.ds.query(`SELECT locked_until FROM app_user WHERE username = $1`, [username]);
    expect(new Date(u.locked_until).getTime()).toBeGreaterThan(Date.now());
    const again = new Client(ctx);
    expect((await again.login(username, 'Totp#Passw0rd2026')).body.code).toBe('LOCKED');
    await ctx.ds.query(`UPDATE app_user SET locked_until = NULL, failed_login_count = 0 WHERE username = $1`, [username]);
  });

  it('limits sign-in attempts per caller', async () => {
    await ctx.redis.del(await keys('silp:rl:auth:*'));
    const codes: number[] = [];
    for (let i = 0; i < 30; i++) codes.push((await request(ctx.app.getHttpServer()).post(`${API}/auth/login`).send({ username: 'nobody', password: 'x' })).status);
    expect(codes.slice(0, 25)).not.toContain(429);
    expect(codes.slice(25)).toEqual([429, 429, 429, 429, 429]);
    // Approval links share the sign-in budget.
    await request(ctx.app.getHttpServer()).get(`${API}/approval-links/whatever`).expect(429);
    // Other endpoints are not affected.
    await admin.get('/auth/me').expect(200);
    await ctx.redis.del(await keys('silp:rl:auth:*'));
  });

  it('can switch the API docs off', async () => {
    await request(ctx.app.getHttpServer()).get(`${API}/openapi.json`).expect(404);
  });

  it('sends attachments under a safe file name', () => {
    expect(contentDisposition('invoice "final".pdf')).toBe(`attachment; filename="invoice final.pdf"; filename*=UTF-8''invoice%20final.pdf`);
    const h = contentDisposition('ankara\r\nSet-Cookie: x=1 – ñ.pdf', true);
    expect(h).not.toMatch(/[\r\n]/);
    expect(h.startsWith('inline; filename="ankaraSet-Cookie: x=1 _ _.pdf"')).toBe(true);
    expect(contentDisposition('')).toBe(`attachment; filename="file"; filename*=UTF-8''file`);
  });

  it('creates a system administrator with a one-time password that must be changed', async () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { createAdmin, oneTimePassword } = require('../src/database/seeds/create-admin');
    for (let i = 0; i < 50; i++) expect(oneTimePassword()).toMatch(/^(?=.*[A-Z])(?=.*[a-z])(?=.*\d)(?=.*[^A-Za-z\d]).{20}$/);
    const username = uniq('root').toLowerCase();
    const password = await createAdmin(ctx.ds, { username, fullName: 'Go-live Admin' });
    await expect(createAdmin(ctx.ds, { username, fullName: 'Again' })).rejects.toThrow(/already exists/);

    const c = new Client(ctx);
    const res = await c.login(username, password);
    expect(res.status).toBe(200);
    expect(res.body.user.mustChangePassword).toBe(true);
    expect(res.body.user.roles.map((r: { code: string }) => r.code)).toEqual(['SYSTEM_ADMIN']);
    await c.get('/users').expect(403); // nothing until the password is changed
    await c.post('/auth/change-password', { currentPassword: password, newPassword: 'Golive#Admin2026x' }).expect(204);
    await c.get('/users').expect(200);
  });

  async function keys(pattern: string): Promise<string[]> {
    const out: string[] = [];
    for await (const k of ctx.redis.scanIterator({ MATCH: pattern })) out.push(k);
    return out.length ? out : ['silp:rl:none'];
  }
});

describe('Production configuration checks', () => {
  const saved = { ...process.env };
  const prod = {
    NODE_ENV: 'production',
    SESSION_SECRET: 'k9Vx2pQ7wL4mN8rT1yU6sA3dF5gH0jZc',
    TOTP_ENCRYPTION_KEY: '0123456789abcdef'.repeat(4),
    DATA_ENCRYPTION_KEY: 'fedcba9876543210'.repeat(4),
    COOKIE_SECURE: 'true',
    CORS_ORIGINS: 'https://procure.example.org',
    MPESA_PAYOUT_MODE: '',
  };
  const load = (over: Record<string, string> = {}) => {
    Object.assign(process.env, prod, over);
    resetEnvCache();
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require('../src/config/env').loadEnv();
  };
  afterEach(() => {
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
    resetEnvCache();
  });

  it('switches M-PESA payouts off by default and refuses the simulator', () => {
    expect(load().mpesaPayout.mode).toBe('off');
    expect(() => load({ MPESA_PAYOUT_MODE: 'mock' })).toThrow(/not allowed in production/);
  });

  it('refuses plain-HTTP cookies, origins and callback URLs, and weak callback tokens', () => {
    expect(() => load({ COOKIE_SECURE: 'false' })).toThrow(/COOKIE_SECURE/);
    expect(() => load({ CORS_ORIGINS: 'http://procure.example.org' })).toThrow(/CORS_ORIGINS/);
    expect(() => load({ MPESA_PAYOUT_MODE: 'sandbox', MPESA_PAYOUT_CALLBACK_BASE_URL: 'http://x.example.org', MPESA_PAYOUT_CALLBACK_TOKEN: 'short' })).toThrow(
      /CALLBACK_BASE_URL[\s\S]*CALLBACK_TOKEN/,
    );
    expect(load({ MPESA_PAYOUT_MODE: 'sandbox', MPESA_PAYOUT_CALLBACK_BASE_URL: 'https://x.example.org', MPESA_PAYOUT_CALLBACK_TOKEN: 'a'.repeat(32) }).mpesaPayout.mode).toBe('sandbox');
  });

  it('turns the API docs off in production unless asked for', () => {
    expect(load().apiDocs).toBe(false);
    expect(load({ API_DOCS: 'true' }).apiDocs).toBe(true);
  });
});
