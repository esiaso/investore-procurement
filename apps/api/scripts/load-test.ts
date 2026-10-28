/**
 * Load test. Builds a separate database (LOAD_DATABASE_URL, default
 * …/silp_load), then times the stock, document-list, report and dashboard
 * endpoints through the real HTTP stack.
 *
 * The database starts as a copy of the integration-test database
 * (LOAD_TEMPLATE_DATABASE, default silp_test; run `pnpm test:api` first), which
 * holds every kind of document the tests create, or as a fresh sample hospital
 * when there is no such database. Then: ~32k extra stock rows, ~1M ledger
 * rows, and every procurement / payment / petty-cash / approval / audit row
 * copied LOAD_DOC_COPIES times (default 3000; the audit log
 * LOAD_AUDIT_COPIES, default 200) over three years.
 *
 *   pnpm --filter @sil/api load-test            # build + measure
 *   pnpm --filter @sil/api load-test -- --reuse # measure an existing load DB
 */
import 'reflect-metadata';
import { Client as PgClient } from 'pg';
import { multiplyDocuments, synthesizePostings } from './load-documents';

const LOAD_URL = process.env.LOAD_DATABASE_URL ?? 'postgres://silp:silp_dev_password@localhost:5432/silp_load';
process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = LOAD_URL;
process.env.REDIS_URL = process.env.LOAD_REDIS_URL ?? process.env.TEST_REDIS_URL ?? 'redis://localhost:6379/2';
process.env.DB_MIGRATIONS_RUN = 'false';
process.env.SEED_DEFAULT_PASSWORD = process.env.SEED_DEFAULT_PASSWORD ?? 'Load#Passw0rd!2026';

const LEDGER_TARGET = Number(process.env.LOAD_LEDGER_ROWS ?? 1_000_000);
const EXTRA_BATCHES_PER_ITEM = Number(process.env.LOAD_EXTRA_BATCHES ?? 40);
const DOC_COPIES = Number(process.env.LOAD_DOC_COPIES ?? 3000);
/** The audit log is already the biggest table; fewer copies keep the build quick. */
const AUDIT_COPIES = Number(process.env.LOAD_AUDIT_COPIES ?? 200);
const TEMPLATE_DB = process.env.LOAD_TEMPLATE_DATABASE ?? 'silp_test';
/** The test database's users have the test password; a fresh sample hospital has SEED_DEFAULT_PASSWORD. */
const PASSWORDS = [process.env.SEED_DEFAULT_PASSWORD!, process.env.TEST_SEED_PASSWORD ?? 'Test#Passw0rd!2026'];

async function exec(sql: string, label: string, client: PgClient) {
  const t = Date.now();
  const r = await client.query(sql);
  console.log(`  ${label}: ${r.rowCount ?? ''} rows in ${((Date.now() - t) / 1000).toFixed(1)}s`);
}

async function build() {
  const url = new URL(LOAD_URL);
  const name = url.pathname.slice(1);
  const admin = new URL(LOAD_URL);
  admin.pathname = '/postgres';
  const pg = new PgClient({ connectionString: admin.toString() });
  await pg.connect();
  await pg.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
  const template = (await pg.query(`SELECT 1 FROM pg_database WHERE datname = $1`, [TEMPLATE_DB])).rowCount ? TEMPLATE_DB : null;
  if (template) {
    console.log(`copying ${template}…`);
    await pg.query(`CREATE DATABASE "${name}" TEMPLATE "${template}"`);
  } else await pg.query(`CREATE DATABASE "${name}"`);
  await pg.end();

  const { DataSource } = await import('typeorm');
  const { typeOrmOptions } = await import('../src/database/typeorm-options');
  const { seedDatabase } = await import('../src/database/seeds/seed');
  const ds = await new DataSource(typeOrmOptions()).initialize();
  await ds.runMigrations();
  if (!template) {
    console.log('seeding sample hospital…');
    await seedDatabase(ds, { defaultPassword: process.env.SEED_DEFAULT_PASSWORD!, sample: true, log: () => undefined });
  }
  await ds.destroy();

  const c = new PgClient({ connectionString: LOAD_URL });
  await c.connect();
  console.log('generating bulk data…');
  // Extra batches for every batch-tracked item, stocked in the main store and main pharmacy.
  await exec(
    `INSERT INTO batch (item_id, batch_no, expiry_date, unit_cost, received_at)
     SELECT i.id, 'LOADB-' || g, CURRENT_DATE + ((g * 37) % 900 - 60), i.unit_price * 0.7, now() - (g || ' days')::interval
       FROM item i CROSS JOIN generate_series(1, ${EXTRA_BATCHES_PER_ITEM}) g WHERE i.is_batch_tracked`,
    'extra batches',
    c,
  );
  await exec(
    `INSERT INTO stock_balance (store_id, bin_id, item_id, batch_id, on_hand)
     SELECT s.id, NULL, b.item_id, b.id, 100 + (abs(hashtext(b.id::text || s.code)) % 900)
       FROM batch b CROSS JOIN store s WHERE b.batch_no LIKE 'LOADB-%' AND s.code IN ('MS', 'MP', 'OPD-PH', 'IPD-PH')`,
    'extra balances',
    c,
  );
  await exec(
    `INSERT INTO stock_transaction (txn_type, store_id, bin_id, item_id, batch_id, quantity, unit_cost, value_delta, source_doc_type, source_doc_no, effective_date, posted_at)
     SELECT 'OPENING', sb.store_id, sb.bin_id, sb.item_id, sb.batch_id, sb.on_hand, b.unit_cost, sb.on_hand * b.unit_cost,
            'OPENING', 'LOAD-OPENING', CURRENT_DATE - 1095, now() - interval '1095 days'
       FROM stock_balance sb JOIN batch b ON b.id = sb.batch_id WHERE b.batch_no LIKE 'LOADB-%'`,
    'opening ledger rows',
    c,
  );
  const [{ n: balances }] = (await c.query(`SELECT count(*)::int AS n FROM stock_balance`)).rows;
  const [{ n: existing }] = (await c.query(`SELECT count(*)::int AS n FROM stock_transaction`)).rows;
  const pairs = Math.max(0, Math.ceil((LEDGER_TARGET - existing) / 2));
  // Churn: matched in/out pairs on random balance rows over three years. Each pair nets to
  // zero, so balances still equal the ledger and reconciliation stays meaningful.
  await exec(
    `WITH bal AS (SELECT row_number() OVER () AS rn, store_id, bin_id, item_id, batch_id FROM stock_balance),
          g AS (SELECT g, 1 + (abs(hashtext(g::text)) % ${balances}) AS rn, 1 + (g % 25) AS q FROM generate_series(1, ${pairs}) g)
     INSERT INTO stock_transaction (txn_type, store_id, bin_id, item_id, batch_id, quantity, unit_cost, value_delta,
                                    source_doc_type, source_doc_no, effective_date, posted_at)
     SELECT CASE WHEN s.sign > 0 THEN 'RECEIPT' ELSE 'TRANSFER_DISPATCH' END::stock_txn_type,
            bal.store_id, bal.bin_id, bal.item_id, bal.batch_id, s.sign * g.q, 10, s.sign * g.q * 10,
            'LOAD', 'LOAD-' || g.g, CURRENT_DATE - (g.g % 1095), now() - ((g.g % 1095) || ' days')::interval + (s.sign || ' second')::interval
       FROM g JOIN bal ON bal.rn = g.rn CROSS JOIN (VALUES (1), (-1)) AS s(sign)`,
    'churn ledger rows',
    c,
  );
  console.log(`copying documents ×${DOC_COPIES}…`);
  await multiplyDocuments(c, DOC_COPIES, { perTable: { audit_log: Math.min(AUDIT_COPIES, DOC_COPIES) } });
  console.log(`  accounting_posting (synthesised): +${(await synthesizePostings(c)).toLocaleString()} rows`);
  await exec(`ANALYZE`, 'analyze', c);
  // Runaway queries are cancelled (the endpoint answers 500 and the case fails) instead of piling up.
  await c.query(`ALTER DATABASE "${new URL(LOAD_URL).pathname.slice(1)}" SET statement_timeout = '30s'`);
  await c.end();
}

async function measure() {
  const { Test } = await import('@nestjs/testing');
  const request = (await import('supertest')).default;
  const { AppModule } = await import('../src/app.module');
  const { configureApp, createRedisClient } = await import('../src/bootstrap');
  const { loadEnv } = await import('../src/config/env');
  const { DataSource } = await import('typeorm');

  const env = loadEnv();
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  const app = moduleRef.createNestApplication({ logger: ['error'] });
  const redis = await createRedisClient(env);
  configureApp(app as never, env, redis);
  await app.init();
  const ds = app.get(DataSource);
  const agent = request.agent(app.getHttpServer());
  const csrf = (await agent.get('/api/v1/auth/csrf')).body.csrfToken;
  let login: { status: number; body: unknown } = { status: 0, body: null };
  for (const password of PASSWORDS) {
    login = await agent.post('/api/v1/auth/login').set('x-csrf-token', csrf).send({ username: 'admin', password });
    if (login.status === 200 && !(login.body as { code?: string }).code) break;
  }
  if (login.status !== 200) throw new Error(`login failed: ${JSON.stringify(login.body)}`);

  const [{ n: ledger }] = await ds.query(`SELECT count(*)::int AS n FROM stock_transaction`);
  const [{ n: balances }] = await ds.query(`SELECT count(*)::int AS n FROM stock_balance`);
  const [ms] = await ds.query(`SELECT id FROM store WHERE code = 'MS'`);
  const [busy] = await ds.query(
    `SELECT item_id, count(*)::int AS n FROM stock_transaction WHERE store_id = $1 GROUP BY item_id ORDER BY n DESC LIMIT 1`,
    [ms.id],
  );
  const [gen] = await ds.query(`SELECT generic_id FROM item WHERE id = $1`, [busy.item_id]);
  const [cat] = await ds.query(`SELECT id FROM item_category WHERE code = 'DRUG-ANTIINF'`);
  const lastPage = Math.ceil(busy.n / 50);
  console.log(`\ndataset: ${ledger.toLocaleString()} ledger rows, ${balances.toLocaleString()} balance rows; busiest item has ${busy.n.toLocaleString()} ledger rows in MS`);
  const sizes = await ds.query(`SELECT relname AS t, n_live_tup::int AS n FROM pg_stat_user_tables WHERE relname = ANY($1) ORDER BY n_live_tup DESC`, [['purchase_order', 'purchase_order_line', 'supplier_invoice', 'payment_voucher', 'mpesa_payout', 'petty_cash_request', 'staff_requisition', 'approval_request', 'approval_action', 'document_link', 'accounting_posting', 'audit_log']]);
  console.log(sizes.map((x: { t: string; n: number }) => `${x.t} ${x.n.toLocaleString()}`).join(', ') + '\n');

  const cases: [string, string][] = [
    ['stock on hand, all stores, batch level (page 1)', '/inventory/stock?pageSize=50'],
    ['stock on hand, all stores, item level (page 1)', '/inventory/stock?groupBy=item&pageSize=50'],
    ['stock on hand, main store, page 20', `/inventory/stock?storeId=${ms.id}&pageSize=50&page=20`],
    ['stock on hand, search "amox"', '/inventory/stock?search=amox&pageSize=50'],
    ['stock on hand, by generic', `/inventory/stock?genericId=${gen.generic_id}&pageSize=50`],
    ['stock on hand, by category, item level', `/inventory/stock?categoryId=${cat.id}&groupBy=item&pageSize=50`],
    ['stock on hand, expiring within 90 days', '/inventory/stock?expiringWithinDays=90&pageSize=50'],
    ['bin card, busiest item (page 1)', `/inventory/ledger?storeId=${ms.id}&itemId=${busy.item_id}&pageSize=50`],
    ['bin card, busiest item (last page)', `/inventory/ledger?storeId=${ms.id}&itemId=${busy.item_id}&pageSize=50&page=${lastPage}`],
    ['valuation by store, today', '/inventory/valuation?groupBy=store'],
    ['valuation by category, 1 year ago', `/inventory/valuation?groupBy=category&asOf=${new Date(Date.now() - 365 * 86_400_000).toISOString().slice(0, 10)}`],
    ['reconciliation (full ledger scan)', '/inventory/reconciliation'],
    ['dashboard', '/dashboard'],
    ['purchase orders (page 1)', '/purchase-orders?pageSize=50'],
    ['purchase orders, search', '/purchase-orders?search=LPO&pageSize=50'],
    ['supplier invoices (page 1)', '/invoices?pageSize=50'],
    ['GRNs (page 1)', '/grns?pageSize=50'],
    ['RFQs (page 1)', '/rfqs?pageSize=50'],
    ['payment vouchers (page 1)', '/payment-vouchers?pageSize=50'],
    ['payables', '/payments/payables'],
    ['petty cash requests (page 1)', '/petty-cash/requests?pageSize=50'],
    ['staff requisitions (page 1)', '/staff-requisitions?pageSize=50'],
    ['procurement queue', '/staff-requisitions/queue?pageSize=50'],
    ['approvals inbox', '/approvals/inbox'],
    ['documents register (page 1)', '/documents/register?pageSize=50'],
    ['QuickBooks postings (page 1)', '/accounting/postings?pageSize=50'],
  ];
  // Every report, every grouping, over three years.
  const from = new Date(Date.now() - 3 * 365 * 86_400_000).toISOString().slice(0, 10);
  const to = new Date().toISOString().slice(0, 10);
  const [float] = await ds.query(`SELECT id FROM petty_cash_float ORDER BY created_at LIMIT 1`);
  type Def = { key: string; filters: string[]; required?: string[]; groupBy?: { value: string }[] };
  for (const r of (await agent.get('/api/v1/reports')).body as Def[]) {
    const base: Record<string, string> = {};
    if (r.filters.includes('from')) Object.assign(base, { from, to });
    if (r.required?.includes('storeId')) base.storeId = ms.id;
    if (r.required?.includes('itemId')) base.itemId = busy.item_id;
    if (r.required?.includes('floatId') && float) base.floatId = float.id;
    for (const g of r.groupBy?.map((x) => x.value) ?? [undefined]) {
      cases.push([`report ${r.key}${g ? ` by ${g}` : ''}`, `/reports/${r.key}?${new URLSearchParams({ ...base, ...(g ? { groupBy: g } : {}) })}`]);
    }
  }
  const results: { label: string; ms: number; status: number }[] = [];
  for (const [label, path] of cases) {
    const times: number[] = [];
    let status = 0;
    for (let i = 0; i < 3 && !(i === 1 && times[0] >= 2000); i++) {
      const t = process.hrtime.bigint();
      // A query that takes longer than this fails the run anyway: do not wait for it.
      const res = await agent.get(`/api/v1${path}`).timeout(30_000).catch(() => ({ status: 0, body: 'timed out after 30 s' }));
      times.push(Number(process.hrtime.bigint() - t) / 1e6);
      status = res.status;
      if (res.status !== 200) console.error(label, res.status, JSON.stringify(res.body).slice(0, 300));
    }
    times.sort((a, b) => a - b);
    // Median of 3; a case over 2 s on its first run is timed once.
    const ms = Math.round(times[Math.floor(times.length / 2)]);
    results.push({ label, ms, status });
    if (status !== 200 || ms >= 2000) console.error(`  slow: ${label} ${ms} ms (${status})`);
  }
  const slow = results.filter((r) => r.status !== 200 || r.ms >= 2000);
  console.log(`${results.length} queries, ${slow.length} failing or over 2 s; slowest: ${[...results].sort((a, b) => b.ms - a.ms).slice(0, 5).map((r) => `${r.label} ${r.ms} ms`).join('; ')}\n`);
  console.log('| Query | Median of 3 (ms) | Under 2 s |');
  console.log('|---|---:|:---:|');
  for (const r of results) console.log(`| ${r.label} | ${r.ms} | ${r.status === 200 && r.ms < 2000 ? 'yes' : 'NO'} |`);
  await app.close();
  await redis.quit();
  if (slow.length) process.exitCode = 1;
}

(async () => {
  if (!process.argv.includes('--reuse')) await build();
  else {
    // An existing load database: bring it to the current schema first.
    const { DataSource } = await import('typeorm');
    const { typeOrmOptions } = await import('../src/database/typeorm-options');
    const ds = await new DataSource(typeOrmOptions()).initialize();
    await ds.runMigrations();
    await ds.destroy();
  }
  await measure();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
