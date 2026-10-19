# SIL Procurement, Supply Chain & Inventory

A procurement, supply chain and inventory system for a private hospital in Kenya.
**Slice 1** covers the foundations: authentication and RBAC, organisation structure,
audit trail, configuration (tax, numbering, locale) and the product catalog
(generics ↔ brands, units, bulk import). **Slice 2** adds inventory (ledger, FEFO,
transfers, adjustments, stock takes), **slice 3** procurement (approvals, suppliers,
budgets, PR → RFQ → PO → GRN → invoice), and **slice 4** internal requisitions from
wards, reservations, issues, back-orders, department and supplier returns and
departmental consumption.

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
| `DATA_ENCRYPTION_KEY` | dev placeholder | 64 hex chars; encrypts supplier bank accounts |
| `SMTP_URL` | – (`smtp://mailpit:1025` in compose) | empty = mail stays queued in `email_outbox` |
| `MAIL_POLL_SECONDS` | `10` | outbox sender interval |
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
  patient/encounter reference per line (free text until the HMIS link in slice 9).
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

## Known limitations / next slices

* Redis is only the session store for now. The mail outbox and reconciliation run as
  in-process pollers or scripts; BullMQ and MinIO arrive with the slices that need them.
* Dispensing to patients (POS), full contracts, eTIMS verification and the supplier
  portal are later slices. Patient references on requisitions are free text until the
  HMIS link (slice 9). The slice-2 stock receipt is still available for opening
  balances; normal purchases go through GRNs.
* Reservations are re-planned on issue, cancellation and on demand, not automatically
  when new stock is received. An adjustment or count that removes reserved stock leaves
  the reservation in place until the next issue re-plans it (reconciliation reports
  such rows as `overReservedCount`).
* Supplier documents are metadata only; file uploads arrive with MinIO.
* The `uq_stock_balance_location` constraint (`UNIQUE NULLS NOT DISTINCT`) and the
  ledger trigger are hand-written in the inventory migration; TypeORM cannot express
  them. Review any future `migration:generate` output so it does not drop them.
* The API image copies the full workspace (including dev dependencies) for simplicity;
  slim it with `pnpm deploy` before production.
* Money and quantities are `NUMERIC(18,4)` in the database and JavaScript numbers in the
  API. Use a decimal library when stock valuation arrives.
