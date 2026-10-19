# SIL Procurement, Supply Chain & Inventory

A procurement, supply chain and inventory system for a private hospital in Kenya.
**Slice 1** covers the foundations: authentication and RBAC, organisation structure,
audit trail, configuration (tax, numbering, locale) and the product catalog
(generics ↔ brands, units, bulk import).

Defaults are KES, VAT 16% with zero-rated and exempt categories, Africa/Nairobi time,
DD/MM/YYYY dates and a January financial-year start. **All of these live in database
config tables, not in code.**

---

## Quick start (Docker only)

You only need Docker Desktop (or Docker Engine with Compose v2).

```bash
docker compose up --build
```

| What | URL |
|---|---|
| Web app | http://localhost:8080 |
| API | http://localhost:3000/api/v1 |
| OpenAPI (Swagger UI) | http://localhost:3000/api/v1/docs (JSON at `/api/v1/openapi.json`) |

On first start the API runs the migrations and seeds a sample hospital:
6 stores (main store, main pharmacy, and OPD/IPD/theatre/emergency satellite pharmacies)
with bins, 12 departments/cost centres, one user per role, and **233 catalog items**
(96 generics with Kenyan-market brands, plus 41 non-drug supplies).

### Sample logins

Every sample user gets the password in `SEED_DEFAULT_PASSWORD` (the development
value is in [`.env.example`](.env.example) and in the `docker-compose.yml` defaults).

| Username | Role | Store scope |
|---|---|---|
| `admin` | System Admin | all |
| `proc.officer` | Procurement Officer | all |
| `proc.manager` | Procurement Manager / Approver | all |
| `storekeeper` | Storekeeper | Main Store |
| `pharmacist` | Pharmacist | Main, OPD and IPD pharmacies |
| `pharm.tech` | Pharmacy Technician | OPD Pharmacy |
| `cashier` | POS Cashier | OPD Pharmacy |
| `quality` | Cold-chain / Quality Officer | all |
| `ward.incharge` | Department / Ward In-charge | – |
| `finance` | Finance / Accounts | all |
| `tender` | Tender / Evaluation Committee Member | – |
| `scm` | Supply Chain Manager | all |
| `supplier` | Supplier (portal) | – |
| `auditor` | Auditor (read-only) | all |
| `management` | Hospital Management | all |

"all" means the role holds the `store.all` permission. Sample brand and manufacturer
names are typical of the Kenyan market; **prices, PPB registration numbers
(`PPB/SAMPLE/…`) and GTINs (GS1 restricted prefix `2`) are made up.** Tax categories on
sample items are illustrative and must be confirmed by Finance.

### Running the tests

```bash
docker compose --profile test run --rm test
```

This builds the test image, waits for Postgres and Redis, then runs:

* **API** (Jest + Supertest) against the real Postgres (`silp_test` database, wiped and
  re-migrated on every run) and Redis (DB 1). It covers auth (CSRF, lockout, forced
  password change, TOTP 2FA, deactivation), RBAC and store scoping, the audit log
  (diffs, redaction, append-only trigger, rollback), numbering (FY rules, concurrency,
  rollback, per-store schemes), generic–brand mapping and substitution, units, and
  import validation.
* **Web** (Vitest + Testing Library): login/2FA forms, role-aware navigation, keyboard
  shortcuts, the brands panel and date/money formatting.

---

## Local development (without the API/web containers)

Prerequisites: Node 22 LTS, pnpm 10 (`corepack enable`), Docker for Postgres and Redis.

```bash
cp .env.example .env
docker compose up -d postgres redis
pnpm install
pnpm build:shared
pnpm db:seed          # runs migrations, then seeds reference + sample data
pnpm dev:api          # http://localhost:3000/api/v1
pnpm dev:web          # http://localhost:5173 (proxies /api to :3000)
pnpm test             # api + web tests (needs postgres + redis running)
```

The API scripts load the root `.env` when it exists (`node --env-file-if-exists`), and
the defaults in `apps/api/src/config/env.ts` match `.env.example`. The tests ignore
`.env` and use `TEST_DATABASE_URL` / `TEST_REDIS_URL`, which default to the
localhost compose services.

Other scripts:

| Command | Purpose |
|---|---|
| `pnpm db:migrate` | run pending migrations |
| `pnpm --filter @sil/api db:migration:generate src/database/migrations/<Name>` | generate a migration from entity changes |
| `pnpm --filter @sil/api db:seed -- --reference-only` | seed config and reference data only (no sample hospital) |
| `pnpm typecheck` | type-check every package |

## Environment variables

| Variable | Default (dev) | Notes |
|---|---|---|
| `DATABASE_URL` | `postgres://silp:…@localhost:5432/silp` | |
| `REDIS_URL` | `redis://localhost:6379/0` | session store |
| `SESSION_SECRET` | dev placeholder | ≥ 32 chars; placeholders are refused when `NODE_ENV=production` |
| `SESSION_IDLE_TIMEOUT_MINUTES` | `30` | rolling idle timeout |
| `SESSION_ABSOLUTE_TIMEOUT_HOURS` | `12` | maximum session age after login |
| `COOKIE_SECURE` | `false` (true in production) | set `true` behind HTTPS |
| `TRUST_PROXY` | `false` (`true` in compose) | trust `X-Forwarded-For` from nginx, for correct audit IPs |
| `CORS_ORIGINS` | `http://localhost:5173,http://localhost:8080` | only needed when the web app is on another origin |
| `TOTP_ENCRYPTION_KEY` | dev placeholder | 64 hex chars; encrypts TOTP secrets (AES-256-GCM) |
| `DB_MIGRATIONS_RUN` | `true` | run migrations on boot |
| `SEED_ON_START` | `false` (`true` in compose) | seed reference + sample data on boot (idempotent) |
| `SEED_DEFAULT_PASSWORD` | – | password for sample users; required when seeding sample data |
| `IMPORT_MAX_FILE_MB` | `10` | upload size limit (the row limit is a DB setting) |
| `DB_LOGGING` | `false` | log SQL |
| `TEST_DATABASE_URL`, `TEST_REDIS_URL` | `…/silp_test`, `redis://…/1` | used by the API tests |

Business configuration is in the database, editable through the API (and seeded with
defaults):

* `system_setting`: currency, timezone, date format, FY start month, password policy,
  lockout threshold and duration, TOTP issuer, 2FA timeout, import row limit.
* `tax_category` + `tax_rate`: rates with effective-from/to dates; overlapping rates are
  rejected.
* `numbering_scheme`: prefix, format tokens (`{PREFIX} {STORE} {FY} {YYYY} {MM} {SEQ}`),
  padding and yearly reset, per document type and optionally per store.
* `role` / `permission` / `role_permission`: roles are data; permission codes are
  defined in `packages/shared/src/permissions.ts`.

---

## Architecture

```
apps/api         NestJS 11 modular monolith (TypeORM 0.3, PostgreSQL 16, Redis sessions)
apps/web         React 18 + Vite, MUI 6, MUI X DataGrid, TanStack Query, React Hook Form + Zod
packages/shared  enums, permission codes, Zod schemas and API types used by both
docker/          nginx config (web), Postgres init (creates the test database)
```

### API modules

Each module owns its entities; other modules only use its exported services.

| Module | Owns | Notes |
|---|---|---|
| `audit` | `AuditLog` | TypeORM subscriber writes a row in the **same transaction** as each insert/update/delete (user, IP, user agent, request id, before/after; only changed fields on update; secrets redacted). A DB trigger rejects UPDATE/DELETE/TRUNCATE. Join-table changes (roles, stores, permissions) are audited explicitly. |
| `settings` | `SystemSetting` | typed keys; `GET /settings/public` exposes locale and password policy to the login screen. |
| `tax` | `TaxCategory`, `TaxRate` | `rateFor(category, date)` resolves the rate in force on a date. |
| `numbering` | `NumberingScheme`, `DocumentSequence` | `next(type, {storeId, date, manager})`: counter row locked with `SELECT … FOR UPDATE`; pass the caller's transaction so numbers are gap-free. |
| `org` | `Facility`, `Store`, `Bin`, `Department` | stores and bins are store-scoped. |
| `rbac` | `Role`, `Permission` | |
| `users` | `User` | Argon2id (OWASP parameters), password policy from settings, lockout, forced change after an admin sets a password. |
| `auth` | – | Passport local strategy; server-side sessions in Redis (`express-session` + `connect-redis`), session id regenerated at login; CSRF synchroniser token (`GET /auth/csrf`, header `x-csrf-token`); optional TOTP 2FA (otplib) with an encrypted secret. |
| `catalog` | `Generic`, `Item`, `ItemCategory`, `UnitOfMeasure`, `UnitConversion` | see below |

**Access control** is three global guards in order: authenticated session →
`@RequirePermissions(...)` → `@StoreScoped('params.id' | 'query.storeId' | 'body.storeId')`.
Services also apply `StoreScope.apply(qb, 'bin.store_id')` to every query over
store-owned rows, so lists are filtered and single-row reads outside the user's stores
return 404. Users with `store.all` bypass scoping. Permissions are reloaded on every
request, so role changes and deactivations take effect immediately.

### Catalog

* **Generic**: INN, strength, dosage form, route (unique together), ATC code,
  therapeutic class, KEML flag, controlled schedule, storage, pregnancy and lactation notes.
* **Item / brand**: one generic has many items. Brand, manufacturer, PPB reg. no., pack
  size, GTIN (check digit validated, unique), barcode, base unit of issue, price (excl.
  VAT), sales class (OTC/P/POM/CD), tax category, and formulary, batch-tracked,
  cold-chain and controlled flags. Codes are auto-numbered from the `ITEM` scheme.
  Drug categories require a generic.
* **Categories** carry a JSONB `attributeSchema` (string/number/boolean/enum, required)
  for non-drug items, e.g. glove size or suture USP. Item `attributes` are validated
  against it.
* **Units**: every quantity is held in the item's base unit as `NUMERIC(18,4)`.
  `UnitConversion` rows (item-specific, e.g. box→strip→tablet, or global, e.g. L→mL)
  are walked in both directions: `GET /items/:id/convert?quantity=3&fromUomId=<BOX>`.
* **Substitution**: `GET /items/:id/equivalents` returns the other active brands of the
  same generic, cheapest first.
* **Search**: item search matches name, brand, code, GTIN/barcode, manufacturer and the
  generic's INN. Generic search also matches brand names. Trigram indexes back
  "contains" searches.

### Bulk import

`POST /api/v1/catalog/import/items?dryRun=true|false&skipDuplicates=true|false`
(multipart `file`, `.csv` or `.xlsx`). Download the template from
`GET /api/v1/catalog/import/items/template`.

Columns: `code` (blank = auto), `name`, `category_code`, `generic_inn`,
`generic_strength`, `generic_dosage_form`, `generic_route`, `atc_code`, `keml`,
`brand_name`, `manufacturer`, `ppb_reg_no`, `pack_size`, `gtin`, `base_uom`,
`unit_price`, `sales_class`, `tax_category`, `formulary`, `batch_tracked`, `cold_chain`,
`controlled`, plus `attr_<key>` for category attributes. Codes match case-insensitively;
Y/N for flags.

* Every row is validated (types, lookups, GTIN check digit, drug ⇒ generic, category
  attributes). Errors are reported by spreadsheet row and column.
* Duplicates are detected within the file and against the database, by code, GTIN, or
  same generic + brand + pack (name + pack for non-drugs).
* The import is **all-or-nothing** in one transaction. Any error blocks it; duplicates
  block it unless `skipDuplicates=true`. Missing generics are created once. Each new row
  is audited, plus an `IMPORT` summary entry.

### Web

The app has a login screen with a 2FA step and a forced password-change screen.
Navigation follows the user's permissions on a responsive layout (permanent drawer on
desktop, temporary on mobile). There are CRUD screens for stores, bins, departments,
users and roles. The generics screen shows each generic's mapped brands; the items
screen has category-specific attribute fields and a substitutes drawer. Also included:
an import screen (validate, review errors and duplicates, then import), an audit log
viewer, and a My account page (password change, 2FA enrolment with QR code).

Keyboard: `/` focuses the page search, `Alt+N` opens the New dialog, Enter submits
dialogs and Esc closes them.

---

## Known limitations / next slices

* Redis is only the session store for now; BullMQ jobs, Mailpit and MinIO arrive with
  the slices that need them (notifications, attachments).
* Stock (batches, expiry, movements), requisitions, purchasing, GRNs, POS and the
  supplier portal are later slices. The numbering schemes for PR/PO/GRN/SR/ISS/TRF/ADJ
  are already seeded.
* The API image copies the full workspace (including dev dependencies) for simplicity;
  slim it with `pnpm deploy` before production.
* Money and quantities are `NUMERIC(18,4)` in the database and JavaScript numbers in the
  API. Use a decimal library when stock valuation arrives.
