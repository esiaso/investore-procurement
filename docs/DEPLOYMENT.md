# Deployment guide

How to run SIL Procurement & Inventory in production: what to install, how to
configure it, how to put it behind TLS, wire up the M-PESA and QuickBooks
callbacks, run the background jobs, back it up and watch it.

The development setup (`docker compose up`) is described in the [README](../README.md).
It is **not** a production configuration: it uses placeholder secrets, plain HTTP,
the mock M-PESA, eTIMS and HMIS services and a legacy MinIO image.

---

## 1. What runs where

| Component | What it is | Notes |
|---|---|---|
| **api** | Node 22, NestJS (`apps/api`, `node dist/main.js`) | Stateless; run 2+ behind a load balancer. Migrations: let **one** process run them (section 3) — TypeORM does not lock against two running them at once. |
| **worker** | Same image, `node dist/worker.js` | Runs the queued and scheduled background jobs (BullMQ). Run exactly one; let the orchestrator restart it. |
| **web** | Static React build behind nginx (`docker/nginx/default.conf`) | Serves the SPA and proxies `/api/` to the API. |
| **PostgreSQL 16** | Database | The only system of record. Back it up (section 8). |
| **Redis 7** | Sessions, job queue, rate-limit counters | Persistence on (`appendonly yes`). Losing it signs everyone out and drops queued jobs (they are re-scheduled); no business data lives there. |
| **S3-compatible object store** | Attachments (delivery notes, certificates, contracts, generated PDFs) | AWS S3, or a maintained MinIO / Ceph / Wasabi… Back it up with the database. |
| **SMTP relay** | Outgoing mail (POs, RFQs, approvals, reports) | Mail is queued in `email_outbox` and retried. |
| **Chromium** | PDF rendering (POs, vouchers, certificates, reports) | Bundled in the API image (Playwright). |

Minimum for a single hospital: 2 vCPU / 4 GB for API + worker, 2 vCPU / 4 GB for
PostgreSQL with SSD storage, Redis 512 MB. The load test in section 10 ran on a laptop.

The `Dockerfile` builds every image: `--target api` (API and worker), `--target web`.

```bash
docker build --target api -t silp-api:$(git rev-parse --short HEAD) .
docker build --target web -t silp-web:$(git rev-parse --short HEAD) .
```

---

## 2. Environment variables

`NODE_ENV=production` turns on the production start-up checks: the API **refuses to
start** with development placeholder secrets, `COOKIE_SECURE=false`, non-HTTPS
`CORS_ORIGINS` / `APP_PUBLIC_URL`, the M-PESA simulator, or (with M-PESA on) a
non-HTTPS callback URL or a callback token shorter than 24 characters. The error lists
every problem at once.

Generate secrets with:

```bash
openssl rand -base64 48   # SESSION_SECRET, MPESA_PAYOUT_CALLBACK_TOKEN (use only [A-Za-z0-9_-]: tr '+/' '-_' | tr -d '=')
openssl rand -hex 32      # TOTP_ENCRYPTION_KEY, DATA_ENCRYPTION_KEY
```

Keep them in your secret store (Vault, AWS/GCP secret manager, Docker/Kubernetes
secrets), never in the repository or the database. **Back up `TOTP_ENCRYPTION_KEY`
and `DATA_ENCRYPTION_KEY` separately from the database backups**: without them the
2FA secrets and supplier bank details in a restored database cannot be read, and
anyone holding both a backup and the keys can read them.

### Core

| Variable | Production value | Notes |
|---|---|---|
| `NODE_ENV` | `production` | Enables the checks above; default M-PESA mode `off`; API docs off. |
| `PORT` | `3000` | |
| `DATABASE_URL` | `postgres://silp:…@db:5432/silp?sslmode=require` | Use TLS to a managed database. |
| `REDIS_URL` | `redis://:password@redis:6379/0` (or `rediss://`) | Shared by every API and worker process. |
| `SESSION_SECRET` | 48+ random bytes | Rotating it signs everyone out. |
| `SESSION_IDLE_TIMEOUT_MINUTES` / `SESSION_ABSOLUTE_TIMEOUT_HOURS` | `30` / `12` | |
| `COOKIE_SECURE` | `true` | Required in production. |
| `TRUST_PROXY` | `true` | Behind nginx / a load balancer, so the client IP (audit log, rate limits, M-PESA IP allow-list) is right. The API trusts **one** proxy hop: make sure the hop in front of it sets `X-Forwarded-For`. |
| `CORS_ORIGINS` | `https://procure.example.org` | The web origin(s). |
| `APP_PUBLIC_URL` | `https://procure.example.org` | Links in e-mails (approve / reject). |
| `TOTP_ENCRYPTION_KEY` / `DATA_ENCRYPTION_KEY` | 64 hex chars each | See above. Cannot be changed once data is encrypted with them (no re-keying tool yet). |
| `DB_MIGRATIONS_RUN` | `false` everywhere, with a release step (recommended); or `true` on a single API replica only | Release step: `pnpm db:migrate:prod` in the API image (`docker run --rm --env-file prod.env silp-api pnpm db:migrate:prod`). |
| `SEED_ON_START` | `false` | Never load the sample hospital in production. Reference data: `run-seed.js --reference-only` (section 3). |
| `SEED_DEFAULT_PASSWORD` | unset | Only for sample data. |
| `JOBS_MODE` | `queue` | `inline` runs jobs inside API requests: development only. |
| `API_DOCS` | unset (off) | `true` to serve `/api/v1/docs` and `/api/v1/openapi.json`. |
| `AUTH_RATE_LIMIT_PER_MINUTE` | `60` | Per IP, on login, 2FA and e-mailed approval links, counted in Redis across processes. Raise it if many users sign in through one NAT address at shift change. On top of the per-account lockout (5 wrong passwords **or 2FA codes** → 15 minutes, settings `security.*`). |
| `CALLBACK_RATE_LIMIT_PER_MINUTE` | `120` | Per IP, on `/api/v1/callbacks/…`, counted in Redis. |
| `IMPORT_MAX_FILE_MB` | `10` | |
| `DB_LOGGING` | `false` | Never `true` in production (logs parameters). |

### Mail, files, PDFs

| Variable | Production value | Notes |
|---|---|---|
| `SMTP_URL` | `smtps://user:pass@smtp.example.org:465` | Empty = mail stays queued. |
| `MAIL_POLL_SECONDS` | `10` | |
| `STORAGE_DRIVER` | `s3` | `local` is for development. |
| `S3_ENDPOINT` | empty for AWS, else the MinIO / provider URL | |
| `S3_REGION`, `S3_BUCKET`, `S3_ACCESS_KEY`, `S3_SECRET_KEY` | | Give the key access to this bucket only. Keep the bucket private (the API streams files to users after checking permissions); turn on versioning if the provider has it. |
| `CHROMIUM_PATH` | unset | The image has Playwright's Chromium. Set only to use another browser binary. |

### M-PESA payouts (supplier and petty-cash payments, Daraja B2C / B2B)

| Variable | Notes |
|---|---|
| `MPESA_PAYOUT_MODE` | `off` (default in production), `sandbox` or `production`. `mock` is refused in production. With `off`, releasing an M-PESA payment answers 503; cheque / EFT vouchers work as usual. |
| `MPESA_PAYOUT_BASE_URL` | `https://sandbox.safaricom.co.ke` or `https://api.safaricom.co.ke` |
| `MPESA_PAYOUT_CONSUMER_KEY` / `…_CONSUMER_SECRET` | From the Daraja app. |
| `MPESA_PAYOUT_SHORTCODE` | Paying B2C / B2B shortcode. |
| `MPESA_PAYOUT_INITIATOR_NAME` / `…_SECURITY_CREDENTIAL` | The API initiator and its password encrypted with Safaricom's public certificate. |
| `MPESA_PAYOUT_CALLBACK_BASE_URL` | Public `https://` base Safaricom calls back, e.g. `https://procure.example.org`. |
| `MPESA_PAYOUT_CALLBACK_TOKEN` | ≥ 24 random URL-safe characters; part of the callback path. |
| `MPESA_PAYOUT_CALLBACK_ALLOWED_IPS` | Comma-separated Safaricom callback source IPs (ask Safaricom for the current list). Recommended. |
| `MPESA_PAYOUT_TIMEOUT_MS` | `20000` |

Over-the-counter M-PESA (STK push / C2B at the pharmacy tills) is configured in the
application (*POS setup*): its keys are stored encrypted with
`DATA_ENCRYPTION_KEY` and its callback token can be rotated there.

QuickBooks Online is connected in the application (*QuickBooks → Connection*); the
client secret and tokens are stored encrypted. The redirect URI registered with
Intuit must be `https://<your host>/api/v1/callbacks/quickbooks`.

### Integrations

eTIMS (KRA) and the HMIS link are configured in the application. `SAMPLE_ETIMS_URL`,
`SAMPLE_HMIS_URL` and the `mock-*` services are for sample data only: do not deploy them.

---

## 3. First installation

1. Create the database and a role that owns it (`CREATE DATABASE silp OWNER silp`).
   The migrations need the `uuid-ossp` extension (created by the first migration;
   on managed PostgreSQL allow it for the role).
2. Run the migrations and load the reference data (roles, permissions, settings, tax
   rates, numbering schemes, units, approval workflows). **`--reference-only` matters**:
   without it the script also loads the sample hospital and its demo users.

   ```bash
   docker run --rm --env-file prod.env silp-api node dist/database/seeds/run-seed.js --reference-only
   ```

3. Create the first administrator (the reference data has no users). The one-time
   password is printed once and must be changed at first sign-in; then turn on 2FA
   under *My account*:

   ```bash
   docker run --rm --env-file prod.env silp-api node dist/database/seeds/create-admin.js jdoe "Jane Doe" jdoe@hospital.org
   ```

4. Start the API replicas, the worker, then the web front end; wait for
   `/api/v1/health` → 200.
5. In the application: departments, stores and bins, users and roles, approval
   workflows and bands (*Approvals*), chart of accounts (*Accounts & currencies*),
   QuickBooks connection and mappings (*QuickBooks*), tills (*POS setup*), eTIMS
   devices (*KRA eTIMS*), job schedules (*Background jobs*).

### Upgrades

Back up first (section 8). Run the migration release step, then deploy the new images. Migrations are forward-only in production: to roll back, restore
the backup taken before the upgrade. Read the release notes for new environment
variables (the start-up checks list anything missing or unsafe).

---

## 4. TLS and the reverse proxy

Terminate TLS in front of the web container (nginx, Caddy, a cloud load balancer).
Everything — the SPA, the API and the callbacks — is served from one origin.

Example nginx in front of the `web` container (or point `proxy_pass` straight at the
API for `/api/` and serve `apps/web/dist` yourself):

```nginx
server {
  listen 443 ssl http2;
  server_name procure.example.org;
  ssl_certificate     /etc/letsencrypt/live/procure.example.org/fullchain.pem;
  ssl_certificate_key /etc/letsencrypt/live/procure.example.org/privkey.pem;
  ssl_protocols TLSv1.2 TLSv1.3;
  server_tokens off;
  add_header Strict-Transport-Security "max-age=31536000; includeSubDomains" always;
  client_max_body_size 20m;

  location / {
    proxy_pass http://web:80;
    proxy_set_header Host $host;
    # Replace, not append: the API trusts one hop, so it must see the real client here.
    proxy_set_header X-Forwarded-For $remote_addr;
    proxy_set_header X-Forwarded-Proto https;
  }
}
server { listen 80; server_name procure.example.org; return 301 https://$host$request_uri; }
```

With two proxies (this one and the `web` container's nginx) the client address
reaches the API as the last `X-Forwarded-For` entry only if the outer proxy
**replaces** the header as above. If you put the API directly behind one proxy, the
default `$proxy_add_x_forwarded_for` is fine.

The `web` image already sends `Content-Security-Policy`, `X-Frame-Options: DENY`,
`X-Content-Type-Options` and `Referrer-Policy`; the API adds Helmet's headers.

---

## 5. Callbacks

Public endpoints (no session; everything else needs a signed-in user and a permission —
a test fails the build if a new route forgets one):

| Path | Called by | Protection |
|---|---|---|
| `POST /api/v1/callbacks/mpesa-payouts/{result,timeout}/<token>` and `…/{status,reversal}/<token>/<id>` | Safaricom (payout results) | Secret token in the path (constant-time compare, 404 on mismatch), optional source-IP allow-list, rate limit, idempotent processing. |
| `POST /api/v1/callbacks/mpesa/{stk,c2b/validation,c2b/confirmation}/<token>` | Safaricom (till payments) | Token from *POS setup* (rotatable), rate limit, idempotent. |
| `GET /api/v1/callbacks/quickbooks` | Intuit OAuth redirect | One-time `state` bound to the connection attempt. |
| `GET/POST /api/v1/approval-links/<token>` | Approvers from e-mail | Single-use hashed token per approver and step, expiry, rate limit. |
| `POST /api/v1/auth/login`, `/auth/2fa/verify` | Users | CSRF token, rate limit, per-account lockout. |
| `GET /api/v1/health` | Monitoring | Reports database reachability only. |

Checklist before going live with M-PESA payouts:

1. `MPESA_PAYOUT_CALLBACK_BASE_URL` reachable from the internet over HTTPS with a
   publicly trusted certificate (Safaricom does not call self-signed endpoints).
2. Test from outside: `curl -X POST https://procure.example.org/api/v1/callbacks/mpesa-payouts/result/wrong-token -d '{}'`
   → `404`; with the right token and `{}` → `200 {"ResultCode":0,…}`.
3. Set `MPESA_PAYOUT_CALLBACK_ALLOWED_IPS` and check a sandbox payment still completes.
4. In `sandbox` mode, pay a small voucher end to end: release → callback → voucher
   *Paid* with the M-PESA receipt; then a reversal.
5. Switch to `production` keys and do one small live payment before the first real run.

The rate limits answer `429` with `Retry-After`; Safaricom retries callbacks.

---

## 6. Background jobs

With `JOBS_MODE=queue` the API enqueues jobs in Redis and the **worker** runs them.
Schedules are the `jobs.schedules` setting (cron expressions; *Background jobs*
shows them, their history and lets you run one now); every run is recorded in `job_run`.

| Job | Does |
|---|---|
| `payments.mpesaFollowUp` | Queries M-PESA for payouts with no result; retries those never processed, else sends them to review. **Essential when M-PESA is on.** |
| `accounting.autoSync`, `accounting.dispatch`, `accounting.refresh` | QuickBooks: queue new documents, post / retry, refresh the token. |
| `approvals.escalate` | Reminders and escalation of overdue approvals. |
| `purchasing.expireOrders` | Expire LPOs / LSOs past validity. |
| `pettyCash.retirementReminders` | Overdue advance reminders. |
| `reports.scheduled` | E-mail scheduled reports. |
| `stock.reorder`, `stock.expiry`, `stock.amc`, `stores.replan`, `inventory.reconcile` | Inventory alerts, AMC, back-orders, ledger check. |
| `etims.*`, `hmis.*` | eTIMS and HMIS queues and monitors (when configured). |
| `forecast.*`, `suppliers.*`, `contracts.alerts`, `tenders.close`, `assets.alerts`, `shipments.delays`, `agency.ordercycle` | Planning and supplier housekeeping. |

If the worker is down nothing is lost — work queues up and runs when it returns — but
M-PESA results are not followed up, approvals do not escalate and mail is still sent
(the outbox sender runs in the API).

---

## 7. Security checklist

Done in the application (hardening pass, October 2026):

- Session cookies `HttpOnly`, `SameSite=Lax`, `Secure`; session id regenerated at
  login; idle and absolute timeouts; CSRF synchronizer token on every state change.
- Passwords: argon2, policy, lockout; TOTP 2FA with encrypted secrets; **wrong 2FA codes
  count towards the lockout, and a pending 2FA login is dropped after 5 wrong codes**.
- Per-IP rate limits on sign-in, approval links and callbacks, **shared through Redis**
  so they hold with several API processes (falls back to per-process if Redis is down).
- RBAC on every route (a test lists the few public / signed-in-only routes and fails
  on any new route without a permission); record-level checks on requisitions,
  petty cash, handovers, certificates and attachments; store scoping.
- Segregation of duties (requester ≠ approver, preparer ≠ releaser), blocked attempts
  audited; one M-PESA payout per document enforced by the database.
- Input validation (whitelist DTOs, unknown fields rejected), parameterised SQL,
  uploads checked by type, magic bytes and size, download names sanitised.
- Secrets only in the environment; supplier bank details, till keys, QuickBooks tokens
  and TOTP secrets encrypted at rest; M-PESA requests stored with credentials redacted;
  phone numbers masked in logs.
- Production refuses unsafe configuration (section 2); API docs off by default.
- Dependencies upgraded (October 2026): nodemailer 10, AWS SDK, playwright 1.64,
  csv-parse 7, plus overrides for body-parser, multer, fast-xml-parser.

Known and accepted (re-check at each release with `pnpm audit --prod`):

| Package | Advisory | Why accepted for now |
|---|---|---|
| react-router 6 | Open redirect via backslash in `<Link>`; error deserialisation | Fixed only in 7.x (a major upgrade). The app builds links from its own routes, never from user input. Plan the v7 upgrade. |
| zod 3 (web) | Memory exhaustion on oversized collections | Runs in the user's own browser on their own form input. Fixed only in zod 4. |
| js-yaml (via @nestjs/swagger) | CPU use with crafted merge keys | Only used to render the API docs, which are off in production. |
| uuid 8 (via exceljs) | Bounds check in v3/v5/v6 with a caller buffer | exceljs only calls `v4()`. |

Your side: TLS (section 4); firewall the database and Redis to the app hosts; Redis
password; least-privilege S3 key; restricted SSH; OS patching; secret rotation plan;
a named owner for the alerts in section 9.

---

## 8. Backups and restore

Scripts in `ops/backup/` (bash; need `pg_dump` / `pg_restore` / `psql` **of the
server's major version**, `openssl`, and the `aws` CLI when attachments are in S3):

| Script | Does |
|---|---|
| `backup.sh` | `pg_dump` (custom format) + an archive of the attachment store + exact row counts, SHA-256 checksums and a manifest, into `BACKUP_DIR/<UTC timestamp>/`; optional AES-256 encryption (`BACKUP_PASSPHRASE_FILE`); prunes backups older than `BACKUP_RETENTION_DAYS` (14). A failed run leaves nothing behind and exits non-zero. |
| `restore.sh <dir>` | Verifies checksums, restores the database (refuses a non-empty database unless `RESTORE_CONFIRM=yes`) and the attachments. Stop the API and worker first. |
| `verify-restore.sh [dir]` | Restore drill: restores the newest backup into a scratch database (`VERIFY_DATABASE_URL`, its name must contain `restore`) and a temporary directory, checks every table's row count and that every attachment the database references is present, then drops the scratch copy. |

They read the same variables as the API (`DATABASE_URL`, `STORAGE_DRIVER`, `S3_*`,
`STORAGE_LOCAL_DIR`), or an `.env` file via `ENV_FILE=`. If the client tools are not
installed on the host, run them in the database container:

```bash
export PG_DUMP="docker exec -i silp-postgres-1 pg_dump" PG_RESTORE="docker exec -i silp-postgres-1 pg_restore" PSQL="docker exec -i silp-postgres-1 psql"
# DATABASE_URL then uses the address as seen from inside that container.
```

Suggested schedule (crontab of a backup user):

```cron
# Nightly backup at 01:30, weekly restore drill on Sunday 04:00, health check every 5 minutes.
30 1 * * *  ENV_FILE=/etc/silp/backup.env /opt/silp/ops/backup/backup.sh        >> /var/log/silp-backup.log 2>&1
0  4 * * 0  ENV_FILE=/etc/silp/backup.env /opt/silp/ops/backup/verify-restore.sh >> /var/log/silp-backup.log 2>&1
*/5 * * * * ENV_FILE=/etc/silp/backup.env /opt/silp/ops/monitoring/check.sh       > /var/run/silp-check.txt 2>&1 || /opt/silp/alert.sh
```

Copy `BACKUP_DIR` off the server (another region / provider: `aws s3 sync`, rclone,
restic). Keep the backup passphrase and the `TOTP_` / `DATA_ENCRYPTION_KEY` in the
secret store, not next to the backups. For a recovery point better than a day, add
PostgreSQL WAL archiving (e.g. pgBackRest or your provider's point-in-time recovery);
these scripts remain the portable, tested full backup.

Tested (October 2026) on the integration-test database (198 tables, 16,799 rows,
41 attachments), with encryption, for both local and MinIO (S3) attachment storage:
the drill passes; a corrupted backup is refused by the checksum check; an attachment
missing from the archive fails the drill; a backup that fails half-way leaves nothing.

Restoring production: stop API and worker → `RESTORE_CONFIRM=yes ops/backup/restore.sh <dir>`
→ run the migration step (for migrations newer than the backup) → API → worker → web. Sessions
are in Redis: users sign in again. M-PESA payouts sent after the backup was taken are
not in the restored database: reconcile them from the M-PESA statement
(*M-PESA reconciliation*) before releasing anything.

---

## 9. Monitoring

- **Liveness**: `GET /api/v1/health` (200 when the API can reach the database; 503
  otherwise). Use it for the load balancer and container health checks.
- **`ops/monitoring/check.sh`**: one line per check, exit 0 / 1 (warning) / 2
  (critical), for cron, Nagios / Icinga or any monitor that runs a command. Checks
  the health endpoint, the database, failed background jobs and a silent worker,
  the e-mail outbox, M-PESA payouts with no result and vouchers in review, failed
  QuickBooks postings, the eTIMS and HMIS queues, and the age of the newest backup.
- **Logs**: the API and worker log to stdout (Nest logger); collect them with your
  platform (Docker logging driver, journald, CloudWatch, Loki). Alert on `ERROR`
  lines and on HTTP 5xx from the proxy. No secrets, tokens or full phone numbers are
  logged; do not turn on `DB_LOGGING` in production.
- **In the application**: *Reports* (audit group: approval trail, QuickBooks sync
  status, control exceptions), *Background jobs* (history), *Payment vouchers* (filter
  *Review*), *M-PESA reconciliation*, *QuickBooks* (errors and retries), *Audit log*.
- **Infrastructure**: PostgreSQL (connections, replication / backup age, disk, slow
  queries — `log_min_duration_statement = 1000`), Redis memory, disk space for
  `BACKUP_DIR`, certificate expiry.

What to alert on, and who acts:

| Signal | Meaning | Action |
|---|---|---|
| health 503 / API down | Database unreachable or API crashed | Ops |
| worker silent > 90 min | Worker down | Ops: restart; jobs catch up |
| M-PESA payout with no result > 1 h, voucher in review | Daraja did not call back | Finance: check the M-PESA statement, resolve the voucher (never re-pay blindly) |
| QuickBooks postings failed | Mapping missing, period closed, token expired | Finance / accounts |
| e-mail outbox growing | SMTP down or rejecting | Ops |
| backup older than 26 h, drill failed | Backups broken | Ops — treat as an incident |
| bursts of 429 on callbacks or login | Misconfigured client or an attack | Ops / security |

---

## 10. Performance

`pnpm --filter @sil/api load-test` builds a separate database from the integration-test
database (run `pnpm test:api` first) and multiplies it: 1 M stock-ledger rows, and every
procurement, payment, petty-cash, approval and audit document copied 3,000 times over
three years. It then times every stock, list, dashboard and report endpoint (every
report, every grouping, three-year period) through the full HTTP stack and fails if
any is not under 2 s. Results are in the README (*Load test*).
