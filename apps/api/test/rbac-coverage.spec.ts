import { RequestMethod } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { ModulesContainer, Reflector } from '@nestjs/core';
import { ANY_PERMISSIONS_KEY, IS_PUBLIC_KEY, PERMISSIONS_KEY } from '../src/common/decorators';
import { createTestApp, TestContext } from './helpers';

/**
 * Every route needs a permission unless it is listed here. PUBLIC routes take
 * no session (callbacks authenticate by a path secret); LOGIN routes take any
 * signed-in user and check access to the record themselves (owner, approver,
 * department). A new route without @RequirePermissions fails this test until
 * it is reviewed and added.
 */
const REVIEWED = new Set(
  [
    'LOGIN GET /currencies',
    'LOGIN GET /exchange-rates',
    'LOGIN GET /gl-accounts',
    'LOGIN GET /projects',
    'LOGIN GET /accounting/sync-status',
    'LOGIN GET /approvals/delegations',
    'LOGIN GET /approvals/history',
    'LOGIN GET /approvals/inbox',
    'LOGIN GET /attachments',
    'LOGIN GET /attachments/:id/download',
    'LOGIN GET /auth/me',
    'LOGIN GET /dashboard',
    'LOGIN GET /handovers',
    'LOGIN GET /handovers/:id',
    'LOGIN GET /notifications',
    'LOGIN GET /notifications/preferences',
    'LOGIN GET /petty-cash/requests/:id',
    'LOGIN GET /petty-cash/requests/:id/pdf',
    'LOGIN GET /reports',
    'LOGIN GET /reports/:key',
    'LOGIN GET /reports/:key/export',
    'LOGIN GET /return-reasons',
    'LOGIN GET /service-certificates/:id',
    'LOGIN GET /service-certificates/:id/pdf',
    'LOGIN GET /service-certificates/awaiting-me',
    'LOGIN GET /staff-requisitions',
    'LOGIN GET /staff-requisitions/:id',
    'LOGIN GET /staff-requisitions/:id/pdf',
    'LOGIN GET /users/directory',
    'LOGIN POST /approvals/:id/approve',
    'LOGIN POST /approvals/:id/reject',
    'LOGIN POST /approvals/:id/return',
    'LOGIN POST /approvals/delegations',
    'LOGIN POST /approvals/delegations/:id/end',
    'LOGIN POST /auth/2fa/disable',
    'LOGIN POST /auth/2fa/enable',
    'LOGIN POST /auth/2fa/setup',
    'LOGIN POST /auth/change-password',
    'LOGIN POST /auth/logout',
    'LOGIN POST /handovers/:id/acknowledge',
    'LOGIN POST /notifications/read',
    'LOGIN POST /petty-cash/requests/:id/acknowledge',
    'LOGIN POST /staff-requisitions/:id/cancel',
    'LOGIN PUT /notifications/preferences',
    'PUBLIC GET /approval-links/:token',
    'PUBLIC GET /auth/csrf',
    'PUBLIC GET /callbacks/quickbooks',
    'PUBLIC GET /health',
    'PUBLIC GET /settings/public',
    'PUBLIC POST /approval-links/:token',
    'PUBLIC POST /auth/2fa/verify',
    'PUBLIC POST /auth/login',
    'PUBLIC POST /callbacks/mpesa-payouts/result/:token',
    'PUBLIC POST /callbacks/mpesa-payouts/reversal/:token/:id',
    'PUBLIC POST /callbacks/mpesa-payouts/status/:token/:id',
    'PUBLIC POST /callbacks/mpesa-payouts/timeout/:token',
    'PUBLIC POST /callbacks/mpesa/c2b/confirmation/:token',
    'PUBLIC POST /callbacks/mpesa/c2b/validation/:token',
    'PUBLIC POST /callbacks/mpesa/stk/:token',
  ],
);

describe('RBAC coverage', () => {
  let ctx: TestContext;
  beforeAll(async () => (ctx = await createTestApp()));
  afterAll(() => ctx.close());

  function routes() {
    const r = new Reflector();
    const out: { access: string; route: string }[] = [];
    for (const mod of ctx.app.get(ModulesContainer).values()) {
      for (const w of mod.controllers.values()) {
        const cls = w.metatype as (new (...a: unknown[]) => unknown) | null;
        if (!cls) continue;
        const base = String(Reflect.getMetadata(PATH_METADATA, cls) ?? '');
        for (const name of Object.getOwnPropertyNames(cls.prototype)) {
          const h = cls.prototype[name];
          if (name === 'constructor' || typeof h !== 'function' || Reflect.getMetadata(METHOD_METADATA, h) === undefined) continue;
          const targets = [h, cls];
          const perms = [...(r.getAllAndOverride<string[]>(PERMISSIONS_KEY, targets) ?? []), ...(r.getAllAndOverride<string[]>(ANY_PERMISSIONS_KEY, targets) ?? [])];
          const access = r.getAllAndOverride<boolean>(IS_PUBLIC_KEY, targets) ? 'PUBLIC' : perms.length ? 'PERM' : 'LOGIN';
          const path = `/${base}/${String(Reflect.getMetadata(PATH_METADATA, h))}`.replace(/\/+/g, '/').replace(/(.)\/$/, '$1');
          out.push({ access, route: `${access} ${RequestMethod[Reflect.getMetadata(METHOD_METADATA, h)]} ${path}` });
        }
      }
    }
    return out;
  }

  it('has a permission on every route not reviewed as public or login-only', () => {
    const all = routes();
    expect(all.length).toBeGreaterThan(500);
    expect(all.filter((x) => x.access !== 'PERM' && !REVIEWED.has(x.route)).map((x) => x.route)).toEqual([]);
    // And the list holds nothing stale.
    const live = new Set(all.map((x) => x.route));
    expect([...REVIEWED].filter((x) => !live.has(x))).toEqual([]);
  });
});
