# SIL Procurement, Supply Chain & Inventory

A procurement, supply chain and inventory system for a private hospital in Kenya.
**Slice 1** covers the foundations: authentication and RBAC, organisation structure,
audit trail, configuration (tax, numbering, locale) and the product catalog
(generics ↔ brands, units, bulk import). **Slice 2** adds inventory (ledger, FEFO,
transfers, adjustments, stock takes), **slice 3** procurement (approvals, suppliers,
budgets, PR → RFQ → PO → GRN → invoice), and **slice 4** internal requisitions from
wards, reservations, issues, back-orders, department and supplier returns and
departmental consumption. **Slice 5** adds background jobs (BullMQ worker), AMC and
reorder levels, reorder and expiry alerts, and reorder/near-expiry reports. Slices 6–8
add pharmacy, billing and KRA eTIMS, strategic procurement, and logistics, quality and
assets; **slice 9** links the hospital HMIS (FHIR R4) for patient-level dispensing.

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
| Mailpit (every email the system sends) | http://localhost:8025 |

Host ports are configurable in `.env` (`WEB_PORT`, `API_PORT`, `POSTGRES_PORT`,
`REDIS_PORT`). On Windows with WSL, `localhost:3000` may already be taken by WSL's
port relay; if the API URL hangs, set `API_PORT=3001`. The web app only uses 8080.

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
| `ward.incharge` | Department / Ward In-charge (Medical Ward) | – |
| `ward.nurse` | Department / Ward Staff (Medical Ward) | – |
| `surg.incharge`, `surg.nurse` | In-charge / staff, Surgical Ward | – |
| `mat.incharge`, `mat.nurse` | In-charge / staff, Maternity | – |
| `finance` | Finance / Accounts | all |
| `accountant` | Finance / Accounts (second user, so capture ≠ approval) | all |
| `tender` | Tender / Evaluation Committee Member | – |
| `scm` | Supply Chain Manager | all |
| `supplier`, `supplier2` | Supplier portal (linked to SUP0001 / SUP0002) | – |
| `auditor` | Auditor (read-only) | all |
| `management` | Hospital Management | all |

"all" means the role holds the `store.all` permission. Sample brand and manufacturer
names are typical of the Kenyan market; **prices, PPB registration numbers
(`PPB/SAMPLE/…`) and GTINs (GS1 restricted prefix `2`) are made up.** Tax categories on
sample items are illustrative and must be confirmed by Finance.

### Running the tests

```bash
docker compose --profile test run --build --rm test
```

This (re)builds the test image from the current code (without `--build`, an image left
over from an earlier run is reused), waits for Postgres and Redis, then runs:

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
| `DATA_ENCRYPTION_KEY` | dev placeholder | 64 hex chars; encrypts supplier bank accounts |
| `SMTP_URL` | – (`smtp://mailpit:1025` in compose) | empty = mail stays queued in `email_outbox` |
| `MAIL_POLL_SECONDS` | `10` | outbox sender interval |
| `JOBS_MODE` | `inline` (`queue` in compose) | `queue` = BullMQ + the worker service; `inline` = run jobs in the calling process; `off` |
| `SAMPLE_ETIMS_URL` | – (`http://mock-etims:8088/etims-api` in compose) | sample data only: the mock control unit the sample pharmacies use; empty = in-process mock |
| `MOCK_ETIMS_PORT` | `8088` | port of the `mock-etims` service |
| `CHROMIUM_PATH` | – | Chromium for PDFs; default is Playwright's bundled browser (installed in the Docker image) |
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

## Inventory (slice 2)

All stock lives in base units in `stock_balance` (store × bin × batch: `on_hand ≥ 0`,
`reserved`, `in_transit`). Every change is explained by rows in `stock_transaction`, an
append-only ledger (a trigger blocks UPDATE/DELETE/TRUNCATE). The only writer is
`postMovements()` (`apps/api/src/modules/inventory/posting.ts`). In the caller's
transaction it locks every touched balance row (and the WAC row) with
`SELECT … FOR UPDATE` in a fixed order, then writes the ledger and the balances
together. It rejects:

* negative on-hand or in-transit stock (also enforced by CHECK constraints);
* consuming expired batches, or batches on hold (quarantine / recall / expired);
* receiving an already-expired batch (opening balances may load one);
* postings dated on or before the store's **period lock** date;
* items frozen by an active **stock take** (a full count freezes the whole store);
* **controlled drugs** without a second, different signatory who holds
  `inventory.handle_controlled`, and controlled or **cold-chain** items moved by users
  without `inventory.handle_controlled` / `inventory.handle_cold_chain`.

The invariant *Σ ledger = balance* is tested with fast-check property tests, and can be
checked at any time:

* `GET /api/v1/inventory/reconciliation[?storeId=]` reports drift;
  `POST …/reconciliation/repair` rewrites drifted balances from the ledger (audited).
* `pnpm --filter @sil/api inventory:reconcile [-- --store <id>] [-- --repair]` is the job
  form; it exits 1 on drift. It becomes a BullMQ repeatable job when the queue arrives.

| Feature | Endpoints (`/api/v1/inventory/…`) | Notes |
|---|---|---|
| Stock on hand | `GET stock?storeId&binId&itemId&genericId&batchId&categoryId&search&holdStatus&expired&expiringWithinDays&groupBy=batch\|item` | Values shown only with `inventory.valuation`. |
| Bin card | `GET ledger?storeId&itemId[&batchId&from&to]` | Running balance. |
| FEFO | `GET fefo?storeId&itemId&quantity[&asOf]` | Earliest non-expired, not-held batch first (tie-break: received date); spans batches and bins; reports shortfall. |
| Valuation | `GET valuation?groupBy=store\|category\|item&asOf` | Σ ledger value up to the date. WAC per item per store by default; FIFO (batch cost) via `inventory.valuationMethod`. |
| Batches / holds | `GET batches`, `PUT batches/:id/hold` | `inventory.batch_hold`. |
| Period locks | `GET/PUT period-locks` | `inventory.period_lock`. |
| Receipts | `GET/POST receipts` | Opening balances and a temporary stock-in until GRNs (slice 3). Creates batches. |
| Adjustments | `POST adjustments`, `…/:id/submit\|approve\|reject`, `GET adjustments/reasons` | Configurable reason codes with direction. Approver ≠ submitter. Above `inventory.adjustmentSecondApprovalThreshold`, a second, different approver is required. Posts on final approval. |
| Transfers | `POST transfers`, `…/:id/dispatch\|receive\|cancel` | Requested by the receiving store. Dispatch picks by FEFO and moves stock to in-transit at the destination; manual picks need `inventory.override_fefo` plus a reason (recorded on the ledger). Receipt can be partial: the shortfall is written off from in-transit with a reason code. |
| Stock takes | `POST stock-takes`, `…/:id/freeze\|counts\|submit\|approve\|cancel` | Full or cycle. Freeze takes a snapshot and blocks movements. Blind counts hide system quantities while counting. Variance review, then approval by someone other than the submitter, which posts the variances. |

New settings: `inventory.valuationMethod` (`WAC`/`FIFO`),
`inventory.adjustmentSecondApprovalThreshold` (currency) and
`inventory.expiryWarningDays` (`[30, 60, 90, 180]`). Reason codes live in
`adjustment_reason`. New permission codes are granted to the built-in roles once, when
the seed first sees them.

The sample stock seed puts opening balances on every seeded item across the stores:
454 batches (11 quarantined) with expiries spread from already expired through ≤30, ≤60,
≤90 and ≤180 days to two years out. Controlled drugs sit in CD bins and cold-chain items
in fridges.

### Load test

`pnpm --filter @sil/api load-test` builds a separate database (`LOAD_DATABASE_URL`,
default `…/silp_load`) holding the sample hospital, ~32k extra balance rows and
**1,000,001 ledger rows**, then times the endpoints through the full HTTP stack. Results
on a developer laptop (Docker Desktop on Windows), median of 3:

| Query | ms |
|---|---:|
| Stock on hand, all stores, batch level (page 1) | 89 |
| Stock on hand, all stores, item level (page 1) | 56 |
| Stock on hand, main store, page 20 | 53 |
| Stock on hand, search "amox" | 122 |
| Stock on hand, by generic | 37 |
| Stock on hand, by category, item level | 59 |
| Stock on hand, expiring within 90 days | 49 |
| Bin card, busiest item (page 1 / last page) | 19 / 25 |
| Valuation by store, today | 480 |
| Valuation by category, 1 year ago | 332 |
| Reconciliation (full ledger scan) | 1051 |

## Procurement (slice 3)

Modules: `approvals` (core: workflows, requests, delegations, notifications and document
links), `suppliers`, `budgets`, `mail` (outbox + PDF) and `purchasing` (requisitions,
RFQs, POs, GRNs, invoices and payment vouchers).

### Approval engine

A workflow is matched on document type, amount band `[min, max)`, and optionally
department and item category. The most specific match wins (department + category >
one of them > neither), then priority. Its ordered steps are approved by a role or a
named user. Each step can approve, reject, or return for amendment; reject and return
need a comment. Documents register handlers (`onApproved/onRejected/onReturned`) that
run inside the approval transaction, so a handler can still stop an approval (for
example a BLOCK budget).

Rules:

* the requester can never approve their own document;
* each step must be approved by a different person;
* delegations (from, to, date window) let a delegate act **on behalf of** an approver,
  and that is recorded on the action.

Approvers are notified in-app; the bell in the header polls every 30 s. Email
notifications come later.

Default workflows (KES, VAT inclusive; edit them under **Approvals → Workflows**):

| Code | Document | Band | Steps |
|---|---|---|---|
| PR-1 | Requisition | < 100,000 | Procurement Manager |
| PR-2 | Requisition | 100,000 – 1,000,000 | Procurement Manager → Supply Chain Manager |
| PR-3 | Requisition | ≥ 1,000,000 | Procurement Manager → Supply Chain Manager → Hospital Management |
| PR-CD | Requisition containing CNS/controlled category items | any | Pharmacist → Procurement Manager |
| PO-1 | Purchase order | < 500,000 | Procurement Manager |
| PO-2 | Purchase order | 500,000 – 5,000,000 | Procurement Manager → Finance |
| PO-3 | Purchase order | ≥ 5,000,000 | Procurement Manager → Finance → Hospital Management |
| INV-1 | Supplier invoice | any | Finance |
| SR-1 | Internal requisition (slice 4) | any | Ward in-charge **of the requesting department** |

Stock adjustments (slice 2) keep their own two-level approval; they are **not yet**
moved onto this engine. That needs a data migration of open adjustments and is left as
a follow-up.

### Suppliers and budgets

* **Suppliers**:
  * KRA PIN validated (`A|P` + 9 digits + letter);
  * contacts, categories supplied, prequalification status and expiry,
    active / suspended / blacklisted with a reason;
  * licence and certificate metadata with expiry dates (`GET /suppliers/documents/expiring?days=60`);
  * bank account number stored **AES-256-GCM encrypted** (`DATA_ENCRYPTION_KEY`),
    shown masked, decrypted only for `suppliers.bank`, redacted in the audit log;
  * performance (on-time delivery, quality rejects, price variance) recomputed from
    every posted GRN.

  Only active suppliers whose prequalification has not expired can be invited or
  ordered from. A simple contract price list (supplier × item × validity) backs
  contract-price POs; full contracts come in slice 7.
* **Budgets** per department × vote head × financial year:
  * PO approval commits (or, for amendments, adjusts) the commitment;
  * cancellation or closing releases what is still open;
  * an approved invoice releases the matching commitment and books the actual;
  * each budget is either WARN (a warning is returned) or BLOCK (submission and
    approval are refused) when exceeded.

  Entries are an append-only ledger (`budget_entry`).

### Documents

* **Requisition**: lines from the item master in base units, justification, priority
  (routine/urgent/emergency), required-by date and optional budget. Only the requester
  edits or submits it.
* **RFQ**: raised from an approved PR, sent to eligible suppliers (email queued).
  Quotations are captured per line. The comparative sheet ranks quotes compliant
  first, then price, then delivery. Awarding anything but the lowest compliant quote
  needs a justification. The award creates one draft PO per winning supplier.
* **Purchase order**:
  * created from an approved PR (prices from the contract list, or the PR estimate),
    from an RFQ award, or directly from the contract price list;
  * lines in an ordering unit (e.g. BOX) with its conversion to base units; VAT per
    line from the item's tax category;
  * approval by amount band, then **send** queues an email to the supplier with the
    **PDF** attached (Playwright/Chromium HTML→PDF, logo placeholder, approval stamps;
    `GET /purchase-orders/:id/pdf`);
  * **amendments** create a new version that needs re-approval, with every version's
    snapshot kept; a rejected amendment restores the previous version;
  * cancel (with reason, only if nothing was received) or close (releases the
    remaining commitment); partial deliveries are tracked per line.
* **GRN**:
  * against a PO, or an **emergency receipt** without one (`purchasing.emergency_receipt`
    + reason, flagged until regularised by linking a PO);
  * per line: quantity in the delivery unit, converted to base units, batch,
    mfg/expiry (required for batch-tracked items, expired goods refused), bin;
  * over-receipt beyond `purchasing.overReceiptTolerancePct` is refused;
  * the **inspection committee** records accepted and rejected quantities with
    reasons; posting needs `purchasing.inspectionCommitteeMinMembers` distinct
    inspectors, and the receiver cannot inspect their own GRN;
  * posting sends accepted quantities to stock through `postMovements()` (RECEIPT at
    base cost, VAT added when `purchasing.costIncludesVat`) and creates a
    return-to-supplier note for rejects;
  * the receiver must not be the PR requester or a PO approver.
* **Supplier invoice**: captured against a PO and **three-way matched**
  per line, with tolerances `purchasing.matchQtyTolerancePct` /
  `purchasing.matchPriceTolerancePct`. Flags: not received, invoiced > received
  (including earlier invoices), invoiced > ordered, price variance. Supplier invoice
  numbers are unique per supplier. Approval goes through the engine. **eTIMS status is
  `NOT_CHECKED`**, the hook for KRA eTIMS verification in slice 6. Paying records a
  payment voucher (simple record for now).
* **Document chain**: PR → RFQ → PO → GRN → return / invoice → payment voucher are
  linked (`document_link`). `GET /documents/chain?type=&id=` walks the links both ways
  from any document; every detail screen shows the chain.

New settings: `mail.fromAddress`, `purchasing.matchQtyTolerancePct` (0),
`purchasing.matchPriceTolerancePct` (2), `purchasing.overReceiptTolerancePct` (0),
`purchasing.inspectionCommitteeMinMembers` (2) and `purchasing.costIncludesVat` (true).
`costIncludesVat` is on because the hospital cannot claim input VAT (confirmed by the
owner), so VAT paid becomes part of item cost, WAC and issue values. Budgets commit
the VAT-inclusive amount.

Mail is written to an outbox in the same transaction as the business change. A poller
in the API sends it over SMTP (Mailpit in development), retrying with back-off. Leave
`SMTP_URL` empty to keep mail queued.

Sample data: 15 fictional suppliers (labelled "Sample"; one suspended, one blacklisted,
one with expired prequalification), 70 contract prices, 7 budgets for the current FY,
and documents at every stage:

* a draft and a pending requisition;
* a full PR → RFQ (3 quotes) → PO → GRN (with a rejection and a return note) →
  invoice → payment chain;
* a part-delivered contract PO with an invoice flagged for a price variance;
* an emergency receipt awaiting regularisation.

## Wards, issues and returns (slice 4)

Departments and wards request stock from a store or pharmacy, the store issues it
FEFO, and its cost is charged to the department's cost centre.

### Internal requisitions (S11)

* Raised by department staff (`inventory.requisition`) for **their own department**:
  lines from the item master (base units), priority, required-by date and an optional
  patient/encounter reference per line (free text, or an HMIS encounter since slice 9).
* Approved through the approval engine. The default workflow `SR-1` has one step,
  **"Department in-charge"**. It uses a new approver type, `DEPARTMENT_ROLE`: holders of
  the role who belong to the requesting department, so the Surgical Ward in-charge
  cannot approve a Medical Ward requisition. The requester can never approve their
  own. Workflows can be edited under Approvals → Workflows, for example by value
  band or for controlled-drug categories.
* **Reservations.** On approval (`inventory.reserveOnApproval`), the outstanding
  quantity is reserved FEFO on specific batch/bin rows (`stock_balance.reserved`, with
  a `stock_reservation` row for each pick). Available = on hand − reserved. Issues,
  transfers and returns to supplier cannot take reserved stock. Adjustments and stock
  takes record physical facts and are not limited. Reservations are released on
  issue or cancellation and re-planned after each issue. **Re-plan reservations**
  tops them up when new stock arrives.
* Statuses: draft → pending approval → approved → partly issued (back-order) → issued,
  or **closed** when a back-order is cancelled with a reason.

### Issue vouchers

`GET /store-requisitions/:id/issue-plan` gives the FEFO picks for everything
outstanding, plus every usable batch/bin. `POST /store-requisitions/:id/issues`
posts the voucher.

* **FEFO**: earliest usable expiry first. Expired stock, held batches and stock in
  quarantine bins are never issued, even when picked by hand. Picks that differ from
  FEFO need `inventory.override_fefo` and a reason, which is recorded on the voucher and
  the ledger.
* **Partial issue**: by default everything usable is issued. The rest stays on
  **back-order** (`GET /store-requisitions/backorders`, "Back-orders" screen) and is
  filled later or cancelled. Asking for a specific quantity that isn't available is
  refused, so stock never goes negative.
* **Scan to confirm**: each pick can be confirmed by scanning the item barcode, GTIN or
  code, or the batch number. A code that doesn't match is refused. The setting
  `inventory.issueScanConfirm` decides whether scanning is `OPTIONAL` (default) or
  `REQUIRED` for every pick.
* Controlled drugs need a second signatory (witness username + password). The issuer
  must hold `inventory.handle_controlled`, and cold-chain items need
  `inventory.handle_cold_chain`, as for transfers.
* Posting writes `ISSUE` ledger rows charged to the department, valued at WAC (or FIFO
  per `inventory.valuationMethod`), and carries the patient reference.
* The voucher can be printed as a PDF (`GET /issues/:id/pdf`), with batch, expiry, bin,
  value and signature blocks.

### Department returns

* Raised by the department (or the store) from the issued lines that can still be
  returned. Each line has a reason code and a condition. The store posts the return
  (`inventory.dept_return`).
* **Resaleable** stock goes back on the same batch, to a usable bin. Expired or held
  batches cannot be returned as resaleable. **Damaged/expired** stock goes to the
  store's quarantine bin (`inventory.quarantineBinCode`, created on first use). Stock
  there is never picked, issued or transferred.
* A department cannot return more than was issued to it. The department is credited at
  the cost it was charged (`RETURN_IN` ledger rows).

### Returns to supplier

* **From stock**: supplier, store, reason code and batch lines. The GRN and PO are found
  automatically from the batch, or given explicitly. **Dispatch** posts
  `SUPPLIER_RETURN` out of stock. Expired, held and quarantined stock may go back;
  reserved stock may not. A return cannot exceed what was accepted on that GRN line.
* **GRN inspection rejects** create a dispatched return automatically (those goods
  never entered stock). Reason code: `purchasing.grnRejectReturnReason`.
* The return note is the hospital's debit note. The supplier's **credit note** (number,
  date, amount) is recorded against it, and any difference is shown. The return is
  linked into the document chain (PO → GRN → RTS). Existing slice-3 return notes are
  converted by the migration.

### Consumption and traceability

* `GET /consumption?from&to&groupBy=department|period|item|patient[&departmentId&storeId&itemId&categoryId&patientRef]`
  reports issues less returns, at the cost posted, per department/cost centre, month,
  item or patient reference. `format=csv` downloads the same report. It needs
  `inventory.consumption`. Users without `store.all` see their own department only.
* The **bin card** now shows from/to (department, other store, supplier or reason),
  patient and witness. `GET /inventory/batches/:id/trace` (the "Batch trace" screen) lists
  every movement of a batch (who, what, when, from, to, document), where it is now and
  which patients received it.
* Reconciliation also checks that reserved quantities equal the open reservations, and
  the repair fixes them.

### Reference data and settings

New permissions: `inventory.requisition`, `inventory.issue`, `inventory.dept_return`,
`inventory.supplier_return`, `inventory.consumption`. There is a new role, **Department /
Ward Staff**, and sample users `ward.nurse`, `surg.incharge`, `surg.nurse`,
`mat.incharge` and `mat.nurse`.

There are configurable return reason codes (`GET/POST/PUT /return-reasons`: department,
supplier or both). New settings: `inventory.reserveOnApproval` (true),
`inventory.issueScanConfirm` (`OPTIONAL`), `inventory.quarantineBinCode` (`QUARANTINE`)
and `purchasing.grnRejectReturnReason` (`INSPECTION_REJECT`). The numbering scheme
`DRT` covers department returns; `SR` and `ISS` already existed.

Sample data covers three wards: requisitions at every stage (draft, pending,
rejected, approved and reserved, fully issued with a patient line, and partly issued
with a back-order), a posted department return (resaleable + damaged to quarantine)
and a draft one, and a supplier return of the damaged stock with a credit note.

## Stock planning, alerts and background jobs (slice 5)

### Background jobs (BullMQ)

Jobs are named handlers registered by modules (`JobsService`). With `JOBS_MODE=queue`
(the compose default), the API puts work on a BullMQ queue in Redis. The **`worker`**
compose service (`node dist/worker.js`) runs it and keeps the schedules from the
setting `jobs.schedules` (cron, in `locale.timezone`):

| Job | Default schedule | Does |
|---|---|---|
| `inventory.reconcile` | 02:00 daily | Checks balances and reservations against the ledger and notifies reconcilers of any problem. It only reports; repairs stay a manual, audited action. |
| `stock.amc` | 02:30 daily | Recalculates AMC and AUTO levels. |
| `stock.expiry` | 00:15 daily | Puts expired batches on hold (`EXPIRED`) and raises near-expiry alerts. |
| `stock.reorder` | hourly 06:00–20:00 | Raises and resolves reorder and stock-out alerts. |
| `stores.replan` | on stock arrival | Re-reserves stock for open back-orders. |

Every run is recorded in `job_run`. **Background jobs** (`jobs.run`, `GET /jobs`,
`POST /jobs/:name/run`) shows the schedules and last results, and lets you run a
job now. In tests and the local dev server, `JOBS_MODE=inline` runs jobs in-process;
`off` disables them. All jobs are safe to re-run.

### Store item settings and AMC

* `store_item_setting` per item per store holds min, max, reorder level, reorder qty,
  safety stock, lead time, review period, and the mode **AUTO** or **MANUAL**.
* **AMC** (average monthly consumption) comes from the ledger over
  `stock.amcWindowDays` (90). It counts the movements in `stock.amcTxnTypes`: issues to
  departments, plus transfers out for stores that supply others. Returns from
  departments are netted off. Days with no stock are left out
  (`stock.amcExcludeStockoutDays`), with a floor of `stock.amcMinDays` (14), so
  stock-outs don't understate demand.
* **AUTO levels**: daily use = AMC / 30.
  - Safety stock = daily use × `stock.safetyStockDays` (7). Min is the safety stock.
  - Reorder level = daily use × lead time + safety stock.
  - Max = reorder level + daily use × review period.
  - Reorder qty = max − reorder level.
  - Lead time and review period are per item, defaulting to `stock.defaultLeadTimeDays` (14) and `stock.defaultReviewPeriodDays` (30).
* **MANUAL** keeps the levels you enter; only the AMC is refreshed. Editing a level on
  the **Stock levels** screen switches the row to MANUAL.

### Reorder engine and alerts

* Position = available (on hand − reserved, usable stock only), plus open PO
  quantities and stock in transit when `stock.reorderIncludeOnOrder` is on. An item is
  flagged at or below its reorder level. The suggestion tops up to max (or adds the
  reorder qty when there's no max).
* Each item also shows a stock-out flag and days of stock remaining.
* **Alerts** (`stock_alert`) are de-duplicated:
  - A reorder or stock-out alert stays open while the condition holds and resolves when it clears. A later crossing raises a new one.
  - A near-expiry alert fires **once per batch × store × horizon**. Horizons come from the item category (`expiryAlertDays`), or else from `inventory.expiryWarningDays` (30/60/90/180). A batch first seen inside several horizons records all of them but is announced once, at the tightest.
  - Expired batches are put on hold automatically, with one alert each.
* Alerts go to users with `inventory.alerts` who can access the store. They arrive in
  the notification bell and by **email** (Mailpit in dev), grouped into one message per
  store and alert type. **My account → Notifications** lets each user switch in-app,
  email or SMS on or off per category. SMS goes through a `Notifier` adapter, which is
  a stub that logs and sends nothing until a provider is chosen. Email follows
  `notify.emailDefault` until the user changes it.

### Reports and actions

* **Suggested reorder** (`GET /stock-planning/reorder`, with CSV/Excel export).
  Select items, adjust the quantities, then press one button:
  - for stores that buy (no parent store), a **draft purchase requisition**, which then follows the slice 3 approval workflow;
  - for satellite stores, a **transfer request** to the parent store.
* **Near expiry** (`GET /stock-planning/expiry`, with CSV/Excel export) shows the value,
  the days needed to use the batch up at this store's AMC, an "at risk" flag, and the
  store with the highest AMC as a redistribution target. Actions:
  - **redistribute**: a transfer raised by the sending store;
  - **return to supplier**: the slice 4 flow;
  - **write off**: an adjustment with the reason `stock.disposalReasonCode` (EXPIRY), approved as usual. Once posted, it has a **disposal certificate** PDF (`GET /stock-planning/disposal-certificate/:adjustmentId`, or the button on the adjustment).
* **Dashboard widgets** for stock roles: items at reorder level, stock-outs, expired
  stock value, new expiry alerts, and near-expiry value by horizon.

### Back-orders follow the stock

When stock arrives (GRN posted, transfer received, receipt, or resaleable department
return), `stores.replan` reserves it for open requisitions at that store, most
urgent and oldest first. It tells the issuing store which back-orders can now be
filled. This removes the slice 4 limitation.

New permissions: `inventory.planning`, `inventory.alerts`, `jobs.run`. Sample data: the
jobs run once on a fresh database. A few Main Store and Main Pharmacy items get
MANUAL levels just above their stock, so the reorder report has suggestions despite
the short sample history.

## Pharmacy, billing and KRA eTIMS (slice 6)

### Pharmacy

* **Patients** are a minimal cache (hospital no., name, date of birth, sex, weight,
  pregnancy, payer/scheme and member no., allergies). The HMIS stays the patient
  register (slice 9).
* **Prescriptions** are written at generic level (dose, frequency, duration, route,
  quantity in base units). The **worklist** per outlet lists open prescriptions oldest
  first, with waiting time and alert badges; it refreshes every 30 s.
* **Clinical checks** run when a prescription is received, again at verification and at
  each dispense, against the other lines and the patient's **active medications**
  (dispensed in the last `pharmacy.activeMedicationDays`, 30):
  - interactions from an `InteractionSource` (the internal `drug_interaction` table,
    keyed on INN or `class:<therapeutic class>`; combination products are checked by
    component);
  - allergies by substance or class ("penicillins" matches *Penicillin antibiotic*);
  - duplicate therapy (same substance: moderate; same class: minor);
  - minimum age and pregnancy (flags on the generic).
* Severities in `pharmacy.blockingSeverities` (contraindicated, major) **block
  verification and dispensing** until a pharmacist (`pharmacy.verify`) overrides each
  alert with a reason. Overrides cannot be edited or deleted (database trigger) and are
  listed in *Drug interactions → Alerts raised vs overridden* (CSV export). Moderate
  and minor alerts are shown inline in colour.
* The starter interaction set is labelled **DEMO** — illustrative, not a clinical
  reference. Import a licensed set as CSV (`inn_a,inn_b,severity,mechanism,management[,source]`,
  checked first, upserted by pair).
* **Dispensing**: any brand of the prescribed generic (substitution recorded), FEFO
  batches (picking other batches needs `inventory.override_fefo` and a reason),
  partial supply, controlled drugs with a witness. Each dispense records batch per
  patient (`dispense_line`), posts `DISPENSE` ledger movements and issues the sales
  invoice. Timestamps: received → verified → first dispensed → completed.
* **Returns** of dispensed medicines raise a credit note (eTIMS) and put the stock back
  on the same batches; undispensed balances can be cancelled with a reason.

### Billing

* **Price lists** (retail, staff, corporate, insurance): VAT-inclusive prices from the
  item's VAT-exclusive price ± the list adjustment, or explicit per-item prices.
  **Payers** carry a price list and a patient co-pay %; the invoice splits each line.
* VAT per line from the item's tax category and the tax tables (`computeLine`:
  tax = gross × r / (100 + r)). Tax categories map to eTIMS tax types (A exempt, B 16%,
  C zero-rated, D non-VAT, E 8%).
* **Payment modes** (cash, M-Pesa with its code, card, insurance, corporate, credit),
  each mapped to an eTIMS payment type. An unpaid patient share goes on account
  (`billing.patientCreditMode`).
* Buyer KRA PIN is validated when given; B2C sales need none.
* **Sales invoices** are immutable once issued (trigger); corrections are **credit
  notes** linked to the original. OTC and patient-chargeable consumables are sold at
  *Sales & receipts → New sale*.
* **Receipts**: 80 mm thermal or A4 PDF in the TIS layout with the SCU block (CU date
  and time, CU ID, CU invoice no., receipt counter, internal data and signature in
  groups of 4, QR). Until eTIMS accepts the invoice it prints **"eTIMS PENDING — THIS IS
  NOT AN OFFICIAL RECEIPT"**; the signed receipt is reprintable (marked COPY).
* **HMIS**: `POST /api/v1/integration/invoices` with an API key in `x-api-key`
  (created by an admin under `/api-clients`, shown once, stored hashed). The key acts
  as a service user (its permissions and stores apply, the audit trail names it).
  `externalRef` (the HMIS bill id) makes the call idempotent (409 with the existing
  invoice id). HMIS charges do not move stock unless `deductStock` is set.

### eTIMS

* One **control unit per selling outlet** (*KRA eTIMS → Control units*): OSCU, VSCU or
  MOCK, PIN, branch id (each outlet is its own KRA branch), device serial.
  Initialisation stores the communication key encrypted.
* **Code tables and item classes** sync daily (`etims.codes`). Local codes are mapped
  (tax category, unit of measure, packaging, item class per category or item,
  country). **Items without a mapping cannot be invoiced**; the console lists them.
  Items are registered (`saveItem`) before their first sale or stock movement.
* Every document goes through the **outbox** (`etims_outbox`): idempotency key per
  document, dependencies (item registration before sale, sale before its stock-out),
  one sender at a time (`FOR UPDATE SKIP LOCKED`), exponential back-off for timeouts,
  5xx and offline (`etims.retryBaseSeconds` × 2ⁿ, capped at 1 h, up to
  `etims.maxAttempts`); business errors fail at once. An accepted document is never
  sent again. At the till the sale waits `etims.syncWaitMs` (4 s) for the signed
  receipt, then stays queued for `etims.dispatch` (every minute).
* Every call is logged (`etims_transmission`) with the key masked. Documents not
  accepted within `etims.alertAfterMinutes` (60) alert users with `etims.manage`
  (`etims.monitor`). *Outbox* shows status, attempts and the call log, and reprocesses
  failed documents (re-resolving mappings).
* **Stock movements** (`etims.stock`, every 15 min): new ledger rows per outlet become
  stock in/out messages (receipts, returns, transfers, issues, write-offs/disposals,
  dispenses), each followed by the item's stock master.
* **Purchases** (`etims.purchases`, hourly, and at invoice capture): supplier sales to
  the hospital are fetched and matched to captured supplier invoices by supplier PIN
  and invoice number. Unmatched invoices get eTIMS status `NOT_ON_ETIMS` and a
  **NOT_ON_ETIMS variance in the three-way match**. Purchases can be confirmed or
  rejected on eTIMS. Declared imports can be linked to items.
* **Mock**: `mock-etims` compose service (port 8088; OSCU paths under `/etims-api`,
  VSCU at the root). It is not KRA. Inject failures with
  `POST /_mock/failure {"mode":"offline"|"timeout"|"http500"|"business","count":n}`.
  Sample outlets (Main, OPD and IPD pharmacies) use it.
* Where the KRA OSCU/VSCU v2.0 and TIS v2.0 documents leave room for interpretation, the
  choices are listed in **`ETIMS_ASSUMPTIONS`**
  (`apps/api/src/modules/etims/etims-spec.ts`, also `GET /etims/assumptions` and the
  console's *Specification notes* tab). Review them with KRA during certification.

### Reports

*Tax & eTIMS reports*: VAT output by tax category (invoices less credit notes),
purchases by tax category (eTIMS-verified vs unverified), credit-note register, local
vs eTIMS reconciliation (counts and totals, documents not accepted, transmitted totals
that differ, gaps in the CU receipt counter) and eTIMS sync status. Interaction alerts
raised vs overridden are under *Drug interactions*.

New permissions: `patients.read/manage`, `pharmacy.read/prescription/verify/dispense/interactions`,
`billing.read/invoice/manage`, `etims.read/manage`. New settings: `etims.*`,
`billing.defaultPriceListCode`, `billing.patientCreditMode`,
`pharmacy.activeMedicationDays`, `pharmacy.blockingSeverities`; `stock.amcTxnTypes` now
counts dispenses.

## Strategic procurement (slice 7)

Defaults suit a private hospital: the public-procurement (PPADA) steps are an optional
rule set, **off** by default (`procurement.ppadaRuleSet`). Amounts are KES.

### Forecasting and supply planning

* **Demand forecast** per item × store from ledger consumption (`stock.amcTxnTypes`, less
  department and patient returns), behind one `Forecaster` interface: **AMC**,
  **moving average** and **Holt-Winters** (falls back to Holt's linear trend with under
  two seasons of history). `AUTO` (default) back-tests the last 3 months and keeps the
  method with the lowest MAPE per item. *Planning → Demand forecasting*.
* **Adjustment factors** (morbidity, new services, programmes) per item or category, a
  month range and optionally a store, multiply the forecast.
* **Suggested order** = forecast demand over lead time + review period + safety stock −
  position (available + on order + in transit). Selected suggestions become a draft PR
  (or a transfer request for a satellite store).
* **Accuracy**: each month, last month's actual consumption is compared with the forecast
  made before that month began (MAPE by method, worst items). Jobs `forecast.run` and
  `forecast.accuracy` run monthly.
* **Supply planning**: months of stock and pipeline months of stock per item, against
  `supply.minMonthsOfStock` / `supply.maxMonthsOfStock` (2 / 4), and a month-by-month
  order schedule (order by, arrival month, quantity).
* **Quantification** per programme: morbidity method (target population × coverage ×
  regimen share × units per patient-month × months, plus wastage) shown next to the
  consumption method (AMC × months), with the difference and the quantity to procure
  after usable stock. The target population is patients treated per month.
* **Funding sources** (donor stock): a batch's funding source can forbid **sale** and
  limit the **stores** and **departments** it may go to. FEFO skips restricted batches
  for sales, transfers and issues. *Donor stock* reports quantity, value, earliest expiry,
  monthly use and months of stock per donor.

### Plans and sourcing

* **Annual procurement plan** per department and financial year, each line on one of the
  department's **budget vote heads**, with a quarter and a sourcing method (blank = the
  one recommended for the line value). Approval workflow `APP-1` (procurement →
  finance → management). **Mid-year revisions** create a new version through approval;
  the approved version stays in force meanwhile and is restored if the revision is
  rejected. Every approved version is kept.
* **Consolidation** (`plans.consolidate`): approved departmental plans are added up by item
  and vote head into the hospital plan; the method is re-recommended for the combined value.
* **Planned vs procured vs spent**: approved POs of the plan's departments in the year for
  the same item, and approved/paid invoices against them.
* **Sourcing methods** (`procurement.sourcingMethods`), with value bands (KES, VAT
  inclusive): low-value < 50,000 · RFQ 50,000–1,000,000 (3 bidders) · open tender ≥
  1,000,000 · restricted tender < 5,000,000 (3 invited, justification) · RFP
  (justification) · direct (justification) · framework call-off (needs an active
  framework agreement covering the items). Requisitions are checked on submission.

### Tenders

Notice → bid documents → clarifications and addenda (emailed to everyone holding the
documents) → **sealed** bids (portal or the bid register; staff see who bid but no prices
until opening; late bids refused) → **opening** after the closing time with attendees,
minutes and price read-outs → **evaluation committee** (users with `tenders.evaluate`,
exactly one chair), each member signs a **conflict-of-interest declaration** before
scoring and a member with a conflict cannot score → **preliminary** (pass/fail by
majority), **technical** (weighted criteria adding up to 100, pass mark) and **financial**
(lowest qualified price ÷ price × 100) → combined score with the tender's technical
weight (0 = lowest evaluated price) → the chair records the **recommendation** (at least
`procurement.minEvaluationCommittee` = 3 scoring members) → **professional opinion** from
outside the committee → award approval `TND-1` (supply chain → management) → award and
regret emails → optional **standstill** (PPADA rule set, `procurement.standstillDays` =
14) → **contract signing**. Scores cannot be changed once the evaluation is locked (trigger).

### Contracts

* Contracts and **framework agreements**: prices, quantities (or price-only lines),
  validity, delivery and payment terms, **performance securities**, **milestones**.
* **Call-off orders** become draft POs at the contract prices within the remaining
  balances (`CONTRACT_BALANCE`) and the contract value (`CONTRACT_CEILING`), then follow
  the normal PO approval. Ordinary POs for a contract item from that supplier also use
  the contract price and count against the balance.
* **Variations** (end date, value, line prices and quantities) apply only after approval
  `CV-1` (procurement → finance).
* `contracts.alerts` (daily): contracts ending in 90 / 30 days and securities expiring in
  30 / 7 days notify contract managers; contracts past their end date become EXPIRED.

### Suppliers, agencies and KPIs

* **Scorecards** (monthly, `suppliers.scorecards`): on time, in full, quality (100 −
  reject rate), price compliance, documents, weighted 30 / 25 / 25 / 10 / 10. A score below
  60 opens a **corrective action** automatically.
* **Suspension, blacklisting and reinstatement** go through approval `SSN-1` (supply chain
  → management) and apply on their effective date; suspensions with an end date are
  lifted by `suppliers.sanctions`. Optional AGPO category and certificate on suppliers.
* **KEMSA / MEDS**: mark the supplier as a national agency, define **order templates**
  (store, cycle, fixed or forecast quantities); `agency.ordercycle` raises the draft POs
  when due. Delivery tracking (acknowledged → processing → dispatched → in transit; the
  GRN confirms delivery).
* **KPIs** for a period: PR → PO → GRN lead times, plan execution, savings against the
  requisition estimates, spend by supplier / category / method, % spend under contract,
  OTIF, forecast accuracy. With the PPADA rule set on: AGPO spend and a PPRA-style award
  report (`/procurement/ppra-report`).

### Supplier portal

Users linked to a supplier (`supplier`, `supplier2` in the sample data) get the portal
only: their own RFQs (quote), open tenders and those they are invited to (documents,
questions, bid, withdraw before closing), their own purchase orders (acknowledge, delivery
status, send delivery notes / invoices as metadata), invoices and payment status. Every
portal query is scoped to the user's supplier; other suppliers' records answer **404**.

New permissions: `forecasting.read/manage`, `plans.read/manage/consolidate`,
`tenders.read/manage/evaluate`, `contracts.read/manage`, `suppliers.performance`,
`procurement.kpis`, `portal.access`. New document types: APP, TND, CTR, CV, SSN.

## Logistics, quality and assets (slice 8)

### File storage (MinIO)

* Attachments live in **MinIO** (S3-compatible; compose service `minio`, console on
  port 9001). MinIO no longer publishes community images on Docker Hub or quay.io, so
  compose uses Bitnami's build of the 2024-10-13 release (`bitnamilegacy/minio`,
  unmaintained): **use a maintained MinIO build or another S3-compatible store in
  production** (`S3_ENDPOINT`, `S3_BUCKET`, `S3_ACCESS_KEY`, `S3_SECRET_KEY`).
  `STORAGE_DRIVER=local` stores files in `STORAGE_LOCAL_DIR` instead.
* `attachment` rows are polymorphic (owner type + id), **versioned** (same owner,
  category and file name → new version; old versions stay downloadable) and keep the
  SHA-256 (checked on every download), MIME type, size and uploader. Limits:
  `files.maxSizeMb` (20) and `files.allowedMimeTypes`; PDF / PNG / JPEG content is
  sniffed so a renamed file is refused. Each owner type decides who may read and
  upload (permission + record visibility, e.g. store scope).
* Wired into supplier documents (scans), tender documents (downloadable by bidders in
  the portal), GRN delivery notes / certificates of analysis, write-off and disposal
  certificates, complaints, recalls, assets and service certificates; suppliers attach
  the scanned delivery note or invoice when they submit it in the portal. Full document
  management screens come in slice 12.

### Quality

* **Holds** (`quality.manage` places, `quality.release` decides; the person who placed a
  hold cannot decide it): inspection, investigation, complaint, excursion, recall. While
  any hold is open the batch is unusable in every store (issues, dispenses, sales,
  transfers); write-offs are still allowed. **Reject** raises a draft disposal.
* **Cold chain**: fridges / freezers / cold rooms per store (optionally mapped to bins),
  ranges per type (`coldChain.ranges`: fridge and cold room 2–8 °C, freezer −25 to
  −15 °C, ambient 15–25 °C). Manual readings and **logger CSV import** (a timestamp
  and a temperature column; local times are Nairobi). Out-of-range readings for at
  least `coldChain.excursionMinutes` (0 = any reading) open an **excursion** that
  **quarantines** the batches in the unit (cold-chain items of the store when the unit
  has no bins) when `coldChain.autoQuarantine` is on. A temperature entered on a GRN
  outside the fridge range holds the received cold-chain batches.
* **Complaints** with PPB fields (PQM / ADR report type, reference, date sent) and a
  printable report; anyone handling stock or patients can report, quality staff
  investigate and may quarantine the batch.
* **Recalls**: the notice (PPB, supplier, manufacturer or internal; item and batch
  numbers, or all batches) quarantines every affected batch in every store at once and
  alerts pharmacy and stores staff. The **trace** lists every store holding the batches
  and every issue to a department, dispense and sale (with the patient and phone) and
  transfer. Returns from wards or patients can be posted back into a store (still on
  recall hold). Closing rejects the holds (stock stays unusable until disposed of or
  returned) or releases them if the recall was withdrawn. Recall dashboard.
* **Disposal** of rejected, recalled, expired or obsolete stock: method (destruction,
  sale, return to supplier, donation, transfer), committee sign-offs
  (`disposal.minCommittee`, 2), approval workflows **DSL-1** (≤ 100,000: supply chain →
  finance) and **DSL-2** (above: + management). On approval the stock is written off
  (reason `DISPOSAL`); completion (place, agent / licensed handler, waste-transfer note,
  proceeds of a sale) generates the **certificate PDF stored in MinIO**. With the PPADA
  rule set on, a sale needs the public notice reference.

### Logistics

* **Distribution** from the main store to satellite stores: delivery routes (stop
  order), runs of transfer requests, **FEFO picking list** (bin, batch, expiry),
  confirmed picks (quantities can be cut), packing (packages), dispatch of the whole run
  (each transfer dispatched with its picks) with a **dispatch note / manifest PDF**, and
  **proof of delivery** per stop (received by, name as signed, time, discrepancies with a
  reason), which posts the transfer receipt.
* **Inbound shipments** against POs: shipped and expected dates (changes kept with the
  reason), carrier and tracking, partial receipts (GRNs name the shipment), delays
  (job `shipments.delays`, daily). **Lead-time history** per supplier (PO sent → first
  GRN: average, min, max, 90th percentile, late orders, slipped shipments); the monthly
  job `suppliers.leadtimes` stores the average, which becomes the default delivery date
  of new POs, and the scorecards show the average lead time and slipped shipments.
* **Service and works orders**: items in `services.categoryCodes` (`SVC`) cannot be
  received on a GRN; a **completion certificate** (period, work done, rating, quantities
  in the order unit) by someone who did not raise or approve the PO counts as received,
  so the invoice is three-way matched against it.
* **Assets**: items in `assets.categoryCodes` (`EQUIP`) become tagged assets on GRN
  posting (one per unit, tag `AST…`), with serial, location (store or department),
  custodian, warranty end and maintenance interval; moves and maintenance are logged and
  `assets.alerts` (daily) warns `assets.warrantyAlertDays` (60) / `assets.maintenanceAlertDays`
  (14) ahead, once per date. No depreciation.
* **Labels**: shelf labels (Code128 of the barcode, GTIN or item code, with the bin) and
  batch labels (**GS1 DataMatrix** with (01) GTIN, (17) expiry, (10) batch when the item
  has a valid GTIN, otherwise Code128 of code and batch), size `labels.size`.

New permissions: `quality.read/manage/release`, `recalls.manage`, `disposals.manage`,
`distribution.manage`, `shipments.manage`, `assets.read/manage`, `services.certify`,
`files.upload`. New document types: QH, PQC, RCL, DSL, DRN, SHP, AST, SCC.

## HMIS integration and patient-level dispensing (slice 9)

The hospital's HMIS/EMR stays the patient register; this system caches the minimum it
needs, receives medication orders, and sends back what was dispensed and charged. All
of it sits behind an **`HmisAdapter`** (FHIR R4 first, a generic REST/JSON contract,
and a **mock FHIR HMIS** for development and tests). HL7 v2 is not implemented; it would
be another adapter producing the same neutral records.

### Connection and mapping (*HMIS integration* screen, `hmis.manage`)

* One connection: protocol (FHIR / REST / MOCK), base URL, token or API key (stored
  encrypted with `DATA_ENCRYPTION_KEY`, never returned), the hospital-number identifier
  system, **who bills** (`LOCAL`: sales invoice + eTIMS here; `HMIS`: charges go to the
  patient's HMIS bill and no local invoice is raised), whether dispense records are sent
  back and whether orders are polled. *Test connection* calls FHIR `/metadata`.
* **Code mappings**: HMIS drug code → generic (or a brand item); dispensing location →
  pharmacy outlet; ward → department; payer/scheme → payer. A drug code that equals an
  item code or GTIN needs no mapping. Orders without a mapped location go to the
  outlet in `hmis.defaultOutlets` for the encounter class (OPD, IPD, EMERGENCY, DAY_CASE).

### Patients, encounters and orders in

* **Patients** are looked up in the HMIS (*Patients → Find in HMIS*, by hospital number or
  name) and cached with demographics, pregnancy, weight, payer and allergies; a cached
  patient is re-read when older than `hmis.patientRefreshHours`. **Encounters** (visit or
  admission: class, ward, bed, payer, attending) are cached too and listed under
  *Encounters* with everything dispensed and charged to them.
* **Orders** (FHIR `MedicationRequest`) arrive by polling (`hmis.poll`, every minute, since
  the last order seen) or by push to `POST /api/v1/integration/hmis/fhir` (Bundle or
  resource; `application/fhir+json`) or `/integration/hmis/events` (REST), with an API
  key that has the **`hmis`** scope. Orders of one `groupIdentifier` become one
  prescription on the outlet worklist, with dose, frequency, duration, route, quantity
  (or dose × frequency × duration), prescriber, the HMIS order id and drug code per line.
  The clinical checks run as for any prescription. A stopped / cancelled order cancels
  its undispensed balance; changes to an order already received are logged and not
  applied.
* **Idempotency**: every resource version is logged once (`hmis_message`, key = resource
  type, id and `meta.versionId` or a content hash); repeats are counted and ignored, so
  a resent Bundle never creates a second prescription.

### Dispensing, charges and records out

* Dispensing is unchanged (verification, interaction/allergy override, FEFO, brand
  substitution, partial supply, controlled-drug witness). For an HMIS encounter:
  - billing **HMIS**: each batch line given becomes a **patient charge** priced from the
    payer's price list and posted as a FHIR `ChargeItem`; payments are refused here
    (they are taken in the HMIS, which issues the tax invoice for its bill);
  - billing **LOCAL**: the dispense is invoiced here as before, and the invoice lines are
    recorded as the encounter's charges (nothing goes to the HMIS bill).
  - a `MedicationDispense` per batch line (batch, expiry, brand, substitution, order and
    encounter) is sent back so it shows on the patient record / MAR.
* Each dispense batch line, issue line and consumption line is charged **once**
  (unique key) — no double charging. **Returns** put the stock back on the same batch,
  post a negative charge against the original HMIS charge (or a credit note when
  billed here) and update the `MedicationDispense` with the net quantity.
* **Inpatients**: orders marked daily or unit-dose supply (extension
  `supply-mode`) appear on **Ward supply** (inpatient pharmacy, by ward and bed): what
  each line needs today = daily quantity − given today, capped at what is left. The
  round dispenses everything chosen, one dispense per prescription. Ward stock top-ups
  stay internal requisitions (slice 4).
* **Consumables charged to patients**: a requisition line can name the admitted patient
  (encounter); issuing it charges the patient. Ward staff record ward / theatre stock
  used on a patient under *Encounters → Charge ward consumables* (no stock moves — it
  was issued to the ward already). HMIS-posted charges can be reversed (`patients.charge`).
* Outbound messages are a transactional outbox: written with the dispense or charge,
  sent at once and otherwise by `hmis.dispatch` (every minute) with back-off
  (`hmis.retryBaseSeconds` × 2ⁿ, capped at 1 h, up to `hmis.maxAttempts`) for network
  errors, timeouts, 5xx, 408 and 429; other 4xx fail at once. A dispense never waits for
  the HMIS.

### Monitoring

* *HMIS integration → Dashboard*: connection health and last poll, counts in/out, the
  retry queue, failed messages (reprocess), **unmapped drug codes** (map, then reprocess)
  and the last 24 hours (with ignored repeats). *Messages* is the full log in and out
  (payload as received / sent, request, response, HTTP status, attempts). `hmis.monitor`
  (every 15 min) alerts users with `hmis.manage` once per message failed or unsent after
  `hmis.alertAfterMinutes`.
* Interpretation choices (extensions, quantity rules, reversal as negative `ChargeItem`…)
  are listed in **`HMIS_ASSUMPTIONS`** (`apps/api/src/modules/hmis/hmis-spec.ts`, also
  `GET /hmis/assumptions` and the *Specification notes* tab). Review them with the HMIS
  vendor.

### Mock HMIS

`mock-hmis` compose service (port 8090; FHIR under `/fhir`) seeded with the sample
patients SIL-000101…105 and their visits. It is not a real HMIS. Control endpoints:
`POST /_mock/prescriptions` (a prescriber writes orders),
`POST /_mock/orders/:id/status`, `POST /_mock/failure {"mode":"offline"|"timeout"|"http500"|"http400","count":n}`,
`GET /_mock/state`, `POST /_mock/reset`. Without the container (`SAMPLE_HMIS_URL` empty) the
API uses an in-process mock.

Sample data: the sample patients linked to the mock HMIS, billing in the HMIS, outlets /
wards / insurer / seven drug codes mapped, an outpatient order with an allergy alert,
an inpatient daily-supply order dispensed on the ward round, an order with an unmapped
code (on the dashboard) and gloves charged to a surgical admission.

New permissions: `hmis.read`, `hmis.manage`, `patients.charge`. New settings:
`hmis.defaultOutlets`, `hmis.requestTimeoutMs`, `hmis.maxAttempts`,
`hmis.retryBaseSeconds`, `hmis.alertAfterMinutes`, `hmis.patientRefreshHours`. New jobs:
`hmis.dispatch`, `hmis.poll`, `hmis.monitor`.

## Known limitations / next slices

* Redis holds sessions and the BullMQ job queue. The mail outbox is still sent by a
  poller in the API process.
* Schedule changes in `jobs.schedules` apply when the worker restarts.
* The reorder engine evaluates items that have a store item setting. The AMC job
  creates these for every item with ledger history in a store; add one by hand
  (Stock levels → PUT `/stock-planning/settings/:storeId/:itemId`) for a new item with
  no history.
* PPADA disposal and the full public-sector reporting set are not implemented (only the
  optional standstill, AGPO tracking and PPRA award report). Patients are a local cache
  and patient references on requisitions are free text unless the line names an HMIS encounter.
* HMIS: a department return of consumables charged to a patient does not reverse the
  charge by itself; reverse it on the encounter (HMIS billing) or raise a credit note
  (local billing). HL7 v2 is not implemented.
* eTIMS has been exercised against the mock control unit only. KRA sandbox
  certification (OSCU or VSCU) still has to be done with the hospital's PIN and device;
  see `ETIMS_ASSUMPTIONS`. Reverse invoicing is a hook only (no KRA format yet).
* The interaction set shipped is a DEMO set; load a licensed one before go-live. The slice-2 stock receipt is still available for opening
  balances; normal purchases go through GRNs.
* Reservations are re-planned on issue, cancellation, on demand and (slice 5) when
  stock arrives. An adjustment or count that removes reserved stock leaves
  the reservation in place until the next issue re-plans it (reconciliation reports
  such rows as `overReservedCount`).
* Attachments are not virus-scanned; add a scanner (e.g. ClamAV) in front of MinIO before go-live.
* A quality hold applies to the batch in every store (the safe choice); there is no hold on one store's stock only.
* The `uq_stock_balance_location` constraint (`UNIQUE NULLS NOT DISTINCT`) and the
  ledger trigger are hand-written in the inventory migration; TypeORM cannot express
  them. Review any future `migration:generate` output so it does not drop them.
* The API image copies the full workspace (including dev dependencies) for simplicity;
  slim it with `pnpm deploy` before production.
* Money and quantities are `NUMERIC(18,4)` in the database and JavaScript numbers in the
  API. Use a decimal library when stock valuation arrives.
