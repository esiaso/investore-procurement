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
assets; **slice 9** links the hospital HMIS (FHIR R4, generic REST or HL7 v2) for
patient-level dispensing, and **slice 10** adds the over-the-counter point of sale
(M-Pesa, shifts and cash-up, offline tills).

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
  the scanned delivery note or invoice when they submit it in the portal. The *Documents*
  register (slice 12) searches them all.

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

### HL7 v2

For an HMIS that speaks HL7 v2 rather than FHIR, choose protocol **HL7 v2 (MLLP)**:

* **In**: ADT^A01/A02/A03/A04/A05/A08/A11/A28/A31 (patient, visit, allergies, insurer)
  and pharmacy orders RDE^O11 / OMP^O09, over MLLP (the API listens on
  `HL7_MLLP_PORT`, 2576 in compose; not in the worker) or `POST /api/v1/integration/hmis/hl7`
  (ER7 text, API key with the `hmis` scope). Every message is answered with an ACK: **AA**
  accepted, **AE** something in it could not be applied (it waits on the dashboard to be
  mapped and reprocessed), **AR** unreadable. A resent message (same MSH-10) is not
  applied twice.
* **Out**: dispense records as **RDS^O13** and charges as **DFT^P03** (CG charge / CD
  credit), sent over MLLP to the HMIS address (`mllp://host:port`) and accepted only on
  an AA; AE is retried with back-off, AR fails and is listed.
* There is no query in v2: the HMIS sends ADT (or PID/PV1 in the order) before orders,
  so patient search / import and polling are not available. Field positions are in
  `HMIS_ASSUMPTIONS`.

### Mock HMIS

`mock-hmis` compose service (port 8090; FHIR under `/fhir`) seeded with the sample
patients SIL-000101…105 and their visits. It is not a real HMIS. Control endpoints:
`POST /_mock/prescriptions` (a prescriber writes orders),
`POST /_mock/orders/:id/status`, `POST /_mock/failure {"mode":"offline"|"timeout"|"http500"|"http400","count":n}`,
`GET /_mock/state`, `POST /_mock/reset`. It also receives HL7 v2 over MLLP on port 2575 (`GET /_mock/hl7`,
`POST /_mock/hl7/failure {"mode":"offline"|"timeout"|"AE"|"AR","count":n}`). Without the container (`SAMPLE_HMIS_URL` empty) the
API uses an in-process mock.

Sample data: the sample patients linked to the mock HMIS, billing in the HMIS, outlets /
wards / insurer / seven drug codes mapped, an outpatient order with an allergy alert,
an inpatient daily-supply order dispensed on the ward round, an order with an unmapped
code (on the dashboard) and gloves charged to a surgical admission.

New permissions: `hmis.read`, `hmis.manage`, `patients.charge`. New settings:
`hmis.defaultOutlets`, `hmis.requestTimeoutMs`, `hmis.maxAttempts`,
`hmis.retryBaseSeconds`, `hmis.alertAfterMinutes`, `hmis.patientRefreshHours`. New jobs:
`hmis.dispatch`, `hmis.poll`, `hmis.monitor`.

## Over-the-counter point of sale (slice 10)

Walk-in sales at the pharmacy counter: same stock (FEFO), prices and eTIMS engine as
dispensing, separate from the prescription workflow.

### Tills, shifts and cash-up

* **Tills** (*POS setup → Tills*, `pos.manage`) sell from a store (its stock and its eTIMS
  control unit) with a default price list.
* A cashier opens a **shift** on a till with an opening float (one open shift per till
  and per cashier). The **X report** (any time) and the **Z report** (at close) show
  sales by payment mode, voids, refunds, discounts, payments taken on account,
  overrides, M-Pesa codes not yet confirmed and the **expected cash** (float + cash kept
  + cash taken on account − cash paid out for voids / refunds).
* **Cash-up**: the cashier counts the drawer (by denomination). A variance within
  `pos.varianceTolerance` (KES 50) closes the shift; outside it waits for a supervisor
  (`pos.approve_variance`, never the cashier) to accept or reject it (*Shifts & cash-up*).

### Selling

* **Fast checkout** (*Till*): scan a barcode / GTIN or search by brand, generic or code
  (Enter adds, F2 search, F9 pay); quantities in base units, so loose tablets are sold
  from a pack; touch-friendly. Stock left and low stock (at or below the reorder level)
  show at the till.
* **OTC controls**: each item has a sales class (OTC, P pharmacy-only, POM
  prescription-only, CD controlled; items without one use `pos.defaultSalesClass`, P).
  **Controlled drugs cannot be sold**; P and POM need a pharmacist (`pos.approve_pom`:
  the seller, or a pharmacist entering their credentials), POM also a prescription
  reference. A generic can carry a **limit per sale** across its brands (e.g. paracetamol).
* **Safety**: the basket is checked for interactions (and against the customer’s
  purchases in the last `pharmacy.activeMedicationDays`, plus allergies / pregnancy when the
  customer is linked to a patient). A blocking interaction needs a pharmacist and a
  reason.
* **Pricing**: the customer’s price list, else the till’s (retail, staff, corporate…);
  **promotions** (per item or category, from a minimum quantity, for a period) apply
  automatically; manual discounts up to the role limit in `pos.discountLimits` (cashier
  5%, pharmacist 15%), above it a supervisor with `pos.override` authorises.
* **Payments**: cash with change, **M-Pesa** — STK Push (Daraja Lipa na M-Pesa Online: the
  customer confirms on their phone; the result arrives by callback, or by query when it
  is late; times out after `mpesa.stkTimeoutSeconds`), a payment made to the till /
  paybill picked from the C2B confirmations, or a code typed by the cashier (accepted
  but flagged until Safaricom confirms it; `pos.manualMpesaRequiresMatch` makes the match
  mandatory) — card (slip number), **split** payments, **on account** for customers with a
  credit limit, and **loyalty** points. An M-Pesa payment pays one sale only.
* **eTIMS on every sale**: each sale is a tax invoice queued to eTIMS; the thermal receipt
  carries the CU invoice number and QR. **Voids** (current shift, `pos.void` or a
  supervisor) and **refunds** (`pos.refund`) are credit notes only, with stock back on its
  batch; the money paid out is counted in the refunding cashier’s shift.
* **Customers** (optional): name, phone, KRA PIN for business buyers (printed on the
  invoice), price list, credit limit and statement (payments on account at the till),
  loyalty (`pos.loyalty`: 1 point per KES 100 paid, a point worth KES 1, from 50 points).
* Every void, refund, discount override, pharmacist approval, interaction override,
  payment on account and refused offline sale is a `pos_event` (append-only).

### Offline

The till keeps a snapshot of its catalog (prices, promotions, sales class, limits,
stock), customers and payment modes in the browser. When the API cannot be reached the
till keeps selling: each sale gets a client id and is queued on the till, the receipt
says “eTIMS PENDING — not an official receipt”, and sold stock comes off the snapshot.
Back online the queue is sent (`POST /pos/sales/sync`) and each sale becomes an invoice
**once** (the client id makes resending harmless); eTIMS receives it then. Offline:
no controlled drugs, P / POM only when the seller is a pharmacist, M-Pesa by code (STK
needs the connection). A sale refused at sync (e.g. no stock left, older than
`pos.offlineMaxHours`) is listed on the till and in *POS reports*. Close the shift after
the queue is sent.

### M-Pesa (Daraja)

*POS setup → M-Pesa* (`pos.manage`): sandbox or production, shortcode, paybill or buy
goods (till number), consumer key / secret and passkey (stored encrypted), and the public
base URL Safaricom calls back. The screen shows the STK and C2B callback URLs to register;
they carry a secret token (Daraja sends no credentials) and are the only unauthenticated
routes (`/api/v1/callbacks/mpesa/...`). **MOCK** mode answers like Daraja without
Safaricom: phones ending 000 fail (insufficient funds), 111 are cancelled, 222 never
answer (time out), 333 are refused; others pay. M-Pesa refunds (B2C reversal) are not
automated: refund in cash or by a manual M-Pesa payment.

### Reports

*POS reports* (`pos.reports`): sales by cashier, shift, item, category, payment mode or
hour with **OTC margin** (net of VAT less the FEFO batch cost, net of refunds), and the
voids / refunds / overrides log; CSV export. Shift totals are on *Shifts & cash-up*.

Sample data: tills OPD-TILL-1 and MP-TILL-1, M-Pesa in mock mode, a corporate credit
customer and a walk-in customer, a paracetamol promotion and an OTC limit.

New permissions: `pos.sell`, `pos.approve_pom`, `pos.override`, `pos.void`, `pos.refund`,
`pos.approve_variance`, `pos.manage`, `pos.reports`. New settings: `pos.discountLimits`,
`pos.varianceTolerance`, `pos.defaultSalesClass`, `pos.loyalty`, `pos.offlineMaxHours`,
`pos.manualMpesaRequiresMatch`, `mpesa.stkTimeoutSeconds`. Numbering: Z (shifts), CUS (customers).
Payment mode LOYALTY. Generic field `maxQtyPerSale`.

## QuickBooks Online (slice 11)

The *QuickBooks* screen (Pharmacy & billing) posts purchases, sales and inventory
movements to a QuickBooks Online company. Documents are posted in previewed batches,
each one once, with retries and a reconciliation against the QuickBooks trial balance.

### Connection (*Connection* tab, `accounting.manage`)

Create an app on developer.intuit.com (scope `com.intuit.quickbooks.accounting`). Then
enter its client id and secret (the secret is stored encrypted) and register the
redirect URI shown (`https://<host>/api/v1/callbacks/quickbooks`). Choose sandbox or
production and press *Connect to QuickBooks*.

Intuit sends the browser back to the callback. The one-time OAuth state is checked, and
the access and refresh tokens are stored encrypted. The access token is refreshed before
it expires: on use, and hourly by the `accounting.refresh` job, which also reads the
company name and the books **closing date**. *Disconnect* revokes the token.

**MOCK** is an in-process QuickBooks company with a chart of accounts, classes and tax
codes. It is used for training and tests and never contacts Intuit.

*Inventory journals from* is the go-live date: documents and stock movements before it
are not posted.

### Mappings (*Mappings* tab)

Every local key is mapped to a QuickBooks account, class or tax code picked from the
company's own lists. Gaps are counted per kind.

* **Control accounts:** AP, AR, GRNI (goods received not invoiced), VAT input and
  output, stock in transit, stock adjustments, write-offs, opening balance equity, and
  the default bank.
* **Per item category:** inventory, cost of sales, sales income and departmental
  consumption. A sub-category falls back to its parent's mapping.
* **Per payment mode:** the bank or clearing account for sales modes (CASH, MPESA,
  CARD, LOYALTY…) and for supplier payment methods (EFT…). Credit modes (INSURANCE,
  CORPORATE, CREDIT) go to receivables.
* **Per tax category:** the QuickBooks tax code.
* **Classes (optional):** per store / outlet, and per department for consumption.

### What is posted

| Here | QuickBooks |
|---|---|
| Approved, matched supplier invoice | **Bill**: debit GRNI (input VAT separately unless `purchasing.costIncludesVat`), credit AP |
| Payment voucher | **Bill payment** linked to its bill |
| Credited return to supplier | **Vendor credit**: debit AP, credit GRNI |
| Sale paid in full by one non-credit mode | **Sales receipt** to the payment-mode account |
| Any other sale (split tender, credit customer, insurer share) | **Invoice** to the customer, plus a **Payment** per amount paid now |
| Credit note | **Refund receipt** (money paid back), else **Credit memo** |
| Payer settlement (*Settlements* tab) | **Payment** applied to the insurer's invoices |
| POS payment on account | **Payment** from the customer |
| Stock ledger for a closed day or month (`accounting.journalFrequency`) | **Journal entry** (see below) |

Customers:
* an invoice with a payer is booked to that payer;
* a till customer is booked to that customer;
* anything else goes to `accounting.walkInCustomer`.

Vendors and customers are found by name or created once, and their QuickBooks ids are
kept. Products are one non-inventory item per category, or one per item when
`accounting.syncItems` is on. Prices are VAT inclusive (`TaxInclusive`) with the mapped
tax codes.

The **inventory journal** posts each period's stock-ledger value changes against their
counter-accounts, by store class. This keeps the QuickBooks inventory accounts equal to
the local valuation:
* receipts and supplier returns → GRNI;
* dispenses and sales → cost of sales;
* issues and department returns → consumption (department class);
* expiry, damage and disposal → write-offs;
* other adjustments and count variances → adjustments;
* transfers → stock in transit;
* opening stock → opening balance equity.

### Batches, errors and retries

1. *Post* previews a period: it builds every document not yet in QuickBooks and
   validates it. A document missing a mapping is **BLOCKED** and lists what to map. A
   document dated on or before the closing date is blocked as *Period closed*.
2. *Post N to QuickBooks* sends the READY documents in dependency order: bills before
   their payments, invoices before theirs.
3. Each document is unique per (QuickBooks type, local document) and is never posted
   twice. Its posting id is sent as QuickBooks' `requestid`, so a resent request is not
   duplicated in QuickBooks either.

When QuickBooks is unreachable, returns 5xx or rate-limits, the document waits as
**PENDING**. It is retried with back-off (`accounting.retryBaseSeconds`, up to
`accounting.maxAttempts`) by the `accounting.dispatch` job.

A rejected document is **FAILED** and appears in *Postings & errors*. Fix the cause
(usually a mapping), then use *Rebuild and send*, which rebuilds it from its source.

### Reconciliation

The reconciliation compares, per account and period:
* what the local documents amount to;
* what was posted;
* the QuickBooks movement (trial balance at the end less the day before the start).

A difference means something was entered or changed in QuickBooks; *still to post* is
the rest. The local stock value is also compared with the QuickBooks inventory accounts.

Sample data: the mock company is connected and every sample category, store, tax
category and payment mode is mapped. Nothing is posted until a batch is previewed.

New permissions: `accounting.read`, `accounting.manage`, `accounting.post` (Finance /
Accounts has all three).

New settings:
* `accounting.journalFrequency` (MONTHLY)
* `accounting.syncItems`
* `accounting.walkInCustomer`
* `accounting.maxAttempts`
* `accounting.retryBaseSeconds`
* `accounting.requestTimeoutMs`

Jobs: `accounting.dispatch` (every 5 min) and `accounting.refresh` (hourly). Numbering:
QBB (batches) and RCV (payer settlements). `customer_ledger.mode_code` records how a
payment on account was made.

## Reports, dashboards and documents (slice 12)

### Reports (*Reports* screen)

Every report is filterable by date range, store, category (sub-categories included),
item, supplier or department, as the report allows. Reports stay within the user's
store scope. Each one is shown on screen, with a totals row and notes on how it is
worked out, and downloads as **CSV**, **Excel** (titled, filters listed, typed cells) or
**PDF**. Each export is logged in `report_run`.

| Group | Reports |
|---|---|
| Inventory | Stock status / on hand (by item, store, category or batch, valued from the stock ledger); stock movement summary (opening, receipts, issues, adjustments, closing); item ledger / bin card with running balance; consumption by department / cost centre; GRN, issue, transfer and adjustment registers; stock-take variance; near-expiry; expired; reorder; stock-out; dead stock; inventory turnover and days of inventory |
| Pharmacy performance | Prescriptions and items dispensed (per pharmacist, outlet, day, month); dispensing turnaround (average, median, 90th percentile); revenue, cost of sales and gross margin (by item, category, payer, outlet); top-moving and slow / non-moving items; ABC and VED analysis; fill rate and stock-out frequency; interaction alerts raised vs overridden; expiry losses and write-offs (value and % of average stock) |
| Purchasing | PO status; outstanding POs (value still to come, days late); supplier performance (orders, deliveries, lead time, on time %, rejected %, returns); price history and variance |
| Supply chain | KPIs: lead times, OTIF, requisition fill rate, stock-outs, months of stock, turnover, wastage |

Who can run a report depends on the permissions it uses: `inventory.read`,
`inventory.valuation`, `pharmacy.read`, `purchasing.read`, `billing.read` / `pos.reports`,
or `procurement.kpis`.

How the figures are worked out:
* Valuation and turnover come from the stock ledger (the same figures as *Inventory →
  Valuation*).
* Margin is sales net of VAT and credit notes, less the FEFO batch cost of what was sold.
* Consumption is dispensed plus issued, net of returns.
* ABC class uses the `reports.abcThresholds` setting.
* VED is set per generic (*Generics → VED class*). The sample data classifies the common
  generics.

**Scheduled reports** (`reports.schedule`): *Email on a schedule* on any report.
* **Timing:** daily, weekly (weekday) or monthly (day 1–28), at a local hour.
* **Content:** a period worked out on the day (yesterday, last 7 / 30 days, last week,
  last month, month to date) and a format (Excel, PDF, CSV).
* **Recipients:** a list of email addresses.

The report runs with the owner's permissions and stores at the time it is sent. It goes
through the mail outbox with the file attached, via the `reports.scheduled` job (every
15 minutes). If a run fails (for example the owner lost the permission), the error shows
on the *Scheduled* tab. *Send now* sends it straight away.

### Dashboard

The home page shows tiles for the user's role, within their stores:
* **My work:** approvals waiting.
* **Pharmacy:** prescriptions waiting, dispenses today, overrides.
* **Stock:** expired, near-expiry, reorder, stock-outs, requisitions to issue.
* **Value:** stock value, value expiring, write-offs this month.
* **Procurement:** outstanding and late orders, deliveries awaiting inspection, spend
  this month, invoices to pay.
* **Sales:** today and this month.
* **Integrations:** eTIMS, HMIS and QuickBooks errors.
* **Documents:** supplier documents expiring.

It also shows six-month trends (stock value, write-offs, orders, sales). Each tile opens
the screen or report behind it (`GET /dashboard`).

### Documents (*Documents* screen, `documents.read`)

The **register** searches every file attached across the system: delivery notes on
GRNs, supplier licences, bid documents, disposal and service certificates, complaint
and recall evidence, asset documents, and adjustment attachments.
* **Search:** by file name, record number, note or SHA-256.
* **Filters:** record type, category, date, and earlier versions.
* **Each row:** links to its record and downloads the file.
* **Visibility:** only records the user's other permissions and stores allow.

**Expiring supplier documents** lists licences and certificates expired or expiring
within 30–180 days. Files keep their versions as before (uploading the same name adds a
version).

New permissions:
* `reports.schedule`: procurement, pharmacist, finance, supply chain and management.
* `documents.read`: procurement, stores, quality, finance, supply chain, auditor and
  management.

New settings:
* `reports.abcThresholds`
* `reports.deadStockDays`
* `reports.nearExpiryDays`
* `reports.maxRows`

Job: `reports.scheduled`. Generic field `vedClass`.

## Non-stock procurement — phase 1: approval engine, requisitions → purchase requisitions

Goods and services that are not held in stock go through the same purchasing cycle as
stock items. Examples: consultancy, repairs, utilities, office services, and capital
items expensed directly.

Each purchase line now has a **line type**: `STOCK`, `NON_STOCK_GOODS`, `SERVICE` or
`CAPEX_EXPENSED`. A non-stock line carries a description, a unit, an optional catalog
item and category, a **GL account** and a project. Non-stock lines never change stock
levels.

### Staff requisitions (*Procurement → My requisitions*)

Any staff member (`requisitions.create`) raises a requisition (`REQ-2026-00001`) for
their own department or on behalf of another.
* **Header:** department / cost centre, project, priority, date required, justification,
  attachments (quotes, specifications, photos) and an optional budget line.
* **Lines:**
  * Stock lines name a catalog item and the store that issues it.
  * Non-stock lines need a description and an estimated cost.
  * The GL account is optional by default; setting `requisitions.requireGlAccount` makes it
    required.

**Submitting.** The budget is checked first. The budget's own WARN or BLOCK setting
applies: a warning is shown, or the submission is refused.

**Approving.** The requisition goes through the approval matrix (`REQ`). The default rule
is the head of department (Department in-charge of that department); above 500,000 the
Finance manager also approves.

**After approval:**
* Stock lines automatically become an approved internal store requisition: stock is
  reserved and the store is told.
* Non-stock lines join the **procurement queue**.

Statuses: Draft → Submitted → Approved → Partly converted / Converted → Closed;
Rejected, Returned (amend and resubmit), Cancelled. Each line shows where it is: the
store requisition, or the purchase requisition it was put on. *PDF* prints the
requisition with its approval signatures.

### Procurement queue → purchase requisition (*Procurement → Procurement queue*)

Procurement (`requisitions.read_all`, `purchasing.consolidate`) sees approved non-stock
lines from every department.
* Select lines from any departments and create **one purchase requisition**.
* The PR records the owning department, delivery location, procurement method (Direct,
  RFQ, tender…), suggested suppliers and justification.
* Each PR line keeps a link to its requisition line.
* The PR is a draft. It is submitted and approved like any other PR (value bands).
* If the PR is rejected or cancelled, its lines go back to the queue.
* The document chain shows REQ → SR and REQ → PR.

Quoting and ordering (LPO / LSO) are covered in phase 2 below. Service acceptance and
payment of non-stock lines arrive in phases 3–4.

### Approval engine (shared by every document)

*Approvals → Workflows* (`approvals.manage`).

**Rules.** A rule matches by document type, amount band (base currency), department,
item category and **currency**. The most specific rule wins, then priority.

**Steps.** Each step can set:
* **approvals needed** (a parallel level: any N different role holders);
* **remind after** N hours (once);
* **escalate after** N hours to a role, whose members can then act on the step too.

The `approvals.escalate` job runs every 15 minutes and records REMIND / ESCALATE actions
in the history.

**Editing a rule.** Editing a workflow while documents are in approval keeps the old
version for them (renamed `CODE~v1`, inactive). The change applies to documents
submitted afterwards.

**Segregation of duties:**
* The requester never approves.
* Each approval in a cycle is by a different person.
* A document can name further users who may not approve it, for example the preparer of
  a payment.

**Records.** Every action records the channel (in app / email link), IP and device.

**Approve by email link.** Each approver's email has a personal link
(`/approve/<token>`) to approve, reject or return without signing in:
* the link is single use and bound to that approver and step;
* it expires after `approvals.linkExpiryHours` (72);
* only its SHA-256 is stored.

Approval emails follow each user's notification preference (*APPROVALS* category). SMS
links wait for an SMS provider.

### Finance master data (*Accounts & currencies*)

* **GL accounts** (`finance.gl_manage`). Imported from QuickBooks (*Import from
  QuickBooks*), or maintained here.
* **Projects** (`projects.manage`).
* **Currencies and exchange rates** (`finance.exchange_rates`). KES is the base; other
  currencies use the latest rate on or before a date.

The sample data adds 16 GL accounts, 3 projects and USD / EUR / GBP rates.

### Configuration added

| | |
|---|---|
| Environment | `APP_PUBLIC_URL` — web address used in approval emails |
| Settings | `approvals.linkExpiryHours`, `requisitions.requireGlAccount` |
| Permissions | `requisitions.create` (all staff roles), `requisitions.read_all`, `purchasing.consolidate`, `finance.gl_manage`, `projects.manage`, `finance.exchange_rates` |
| Role | Finance Manager / CFO (sample user `finance.manager`) |
| Numbering | REQ `{PREFIX}-{FY}-{SEQ}` |
| Jobs | `approvals.escalate` (every 15 min) |
| Notification categories | APPROVALS, REQUISITIONS |
| API | `/staff-requisitions` (+ `/queue`, `/consolidate`, `/:id/submit`, `/:id/cancel`, `/:id/pdf`), `/gl-accounts`, `/projects`, `/currencies`, `/exchange-rates`, `/approval-links/:token` (public) |

## Non-stock procurement — phase 2: RFQ, quotation evaluation, LPO / LSO

A purchase requisition with non-stock lines (or a mix) goes on an RFQ or straight to an
order, like a stock PR.

### Requisition status

The PR shows where it stands:
* **RFQ issued**: an RFQ is open on it.
* **Partially fulfilled**: some lines are ordered.
* **LPO raised**: every non-stock line is ordered.
* **Closed**: a stock-only PR that is fully ordered.

Cancelling or expiring an order gives its quantities back to the PR.

### RFQ (*Purchasing → RFQs*)

**Lines.** An RFQ copies the PR lines, including descriptions, units and GL accounts for
non-stock lines.

**Sending.** Each invited supplier is emailed the RFQ with its PDF attached; *PDF* prints
the same document.
* At least `purchasing.rfqMinSuppliers` (3) suppliers must be invited.
* Otherwise *Send invitations* needs a justification, and is refused with `MIN_SUPPLIERS`
  without one. The justification is kept on the RFQ.

**Quotations.**
* A quotation can be in any currency that has an exchange rate. Blank means the base
  currency.
* Each quotation records delivery days, payment terms and compliance.
* The comparison converts every price to KES at today's rate and also shows the quoted
  price.

**Closing bidding.** *Close bidding* stops further quotations (status **Closed**).

### Evaluation

*Evaluation set-up* is done before scoring starts. It sets:
* the **technical weight** (0–100 %);
* the **pass mark** (default `purchasing.rfqPassMark`, 70);
* the **evaluation committee**.

**Scores.** The financial and combined scores are calculated as follows:
* financial score = lowest complete compliant total ÷ this total × 100;
* technical score = the committee's average;
* combined score = technical × weight + financial × (100 − weight).

With a weight of 0 the award is on price alone. A quotation below the pass mark cannot be
recommended, however cheap it is.

**Committee scoring.** Once bidding is closed, each committee member scores every
compliant quotation (0–100, with a comment) on the RFQ page.
* Only members can score.
* Non-compliant quotations are not scored.

**Completing the evaluation.** When every score is in, *Complete evaluation* records the
committee's recommendation. The status becomes **Evaluated** and the top-ranked supplier
is marked as recommended.

### Award

**Pre-selection.** The award pre-selects the recommended supplier, or the lowest compliant
quote when nothing is recommended.

**Justification.** Awarding any line past the lowest compliant quote needs a
justification (`JUSTIFICATION_REQUIRED`).

**Evaluation first.** With a technical weight above 0 the RFQ must be evaluated before it
is awarded.

**The order.** The award creates one draft order per supplier:
* in the quotation currency, with the exchange rate fixed on the order;
* with the delivery address / site.

### LPO / LSO

An order with only non-stock lines is a **Local purchase order**. If every line is a
service it is a **Local service order**. The order kind is used in the title, the PDF and
the email subject.

**Non-stock lines:**
* They use the description and the order unit. The default unit is `purchasing.nonStockUom`:
  JOB for services, PCS otherwise.
* VAT uses `purchasing.nonStockTaxCategory` (STANDARD).
* **Withholding tax** is `purchasing.whtRates` by line type (default: 5 % on services). It
  is calculated on the pre-VAT amount and can be overridden per line.
* The order shows the WHT total and the **net payable**.

**Order header.**
* `expiresOn` is the order date + `purchasing.lpoValidityDays` (60).
* `terms` defaults to `purchasing.lpoTerms`.
* A foreign-currency order also stores `baseTotal` in KES.

**Approval and budget.** Approval bands and the budget commitment use the KES value. The
approval request records the order currency, so the matrix can route foreign-currency
orders separately.

**Sending.** With `purchasing.autoSendOnApproval` on, an approved order is emailed to the
supplier at once. Otherwise it waits for *Send to supplier*.

**Expiry.** The `purchasing.expireOrders` job runs nightly at 01:30. It expires approved or
sent orders past their validity that have nothing received or invoiced:
* the budget commitment is released;
* the quantities go back to the PR;
* procurement is notified.

**Amending.** Amending an LPO or LSO works as for a PO: a new version and re-approval on
the new value.

**Receiving.** Non-stock lines are never received into a store; a GRN refuses them
(`NON_STOCK_LINE`). The requesting department accepts them in phase 3 (GRN / service
acceptance certificate).

### Configuration added

| | |
|---|---|
| Settings | `purchasing.rfqMinSuppliers` (3), `purchasing.rfqPassMark` (70), `purchasing.whtRates` ({SERVICE: 5}), `purchasing.nonStockTaxCategory` (STANDARD), `purchasing.nonStockUom` ({SERVICE: JOB, default: PCS}), `purchasing.lpoValidityDays` (60), `purchasing.lpoTerms`, `purchasing.autoSendOnApproval` (false) |
| Units | JOB (job / service), LOT |
| Statuses | PR: RFQ_ISSUED, PARTIALLY_FULFILLED, LPO_RAISED; RFQ: CLOSED, EVALUATED; PO: EXPIRED (INVOICED and PAID are reserved for phases 3–4) |
| Jobs | `purchasing.expireOrders` (`30 1 * * *`) |
| API | `POST /rfqs/:id/send` {fewerSuppliersJustification}, `GET /rfqs/:id/pdf`, `POST /rfqs/:id/close`, `PUT /rfqs/:id/evaluation`, `POST /rfqs/:id/scores`, `POST /rfqs/:id/evaluate`; quotation `currency`, `paymentTermsDays`, `notes`; award `deliveryAddress`; PO `currency`, `deliveryAddress`, `terms`, `expiresOn`, line `taxCategoryId`, `whtRatePercent` |
| Migration | `1762300000000-NonStockPhase2` |

## Non-stock procurement — phase 3: acceptance, invoices, delivery to the final user

### Receiving non-stock goods and services (*Logistics → Service certificates*)

Non-stock lines are never received into a store; GRNs refuse them. Instead the delivery is
recorded on an **acceptance certificate**. It extends the slice-8 service completion
certificate and is printed as:
* a **Service acceptance certificate** when every line is a service;
* a **Goods received note (non-stock)** otherwise.

**Recording the delivery.** A storekeeper, or anyone with `services.certify` /
`purchasing.receive`, records it with *Record delivery / completed work*.
* For each line, enter the **accepted** quantity, plus any **rejected** quantity with its
  reason. A partial delivery is fine.
* Add inspection notes and attachments (signed note, job card, photos).
* The buyer who raised the order, or anyone who approved it, cannot record it.

**Sign-off when the order was bought for staff requisitions.**
* The draft waits for the **requester**, or a member of the requesting department with
  `services.certify` (e.g. the ward in-charge), to **Accept delivery** or **Reject** it
  (with a reason).
* The requester is notified, and *My requisitions* shows it under *Waiting for you*.
* The officer's *Post* is refused with `ACCEPTANCE_REQUIRED`.
* For other orders, the certifying officer posts it as before.

**Accepting:**
* The accepted quantities count as received on the order: PARTIALLY_RECEIVED, then
  RECEIVED. This is what the 3-way match uses. **Stock levels never change.**
* The requisition lines record the **received** quantity.
* A **service** accepted by the requester themself counts as **delivered** to them.
* Goods wait to be handed over, and the requester is told they have been received.

### Supplier invoices

* Non-stock lines can be invoiced.
* The invoice uses the order's **currency**, at the exchange rate on the invoice date, and
  stores a **base total** (KES).
* **Withholding tax** is worked out from the order lines' rates. The invoice shows the WHT
  total and the **net payable** (deducted at payment in phase 4).

**Price tolerance in the 3-way match.** A price difference must be within
`purchasing.matchPriceTolerancePct` (2 %) **and**, when `purchasing.matchPriceToleranceAbs`
is above 0, within that amount per line (|invoice − order price| × quantity, in the
order currency). The quantity checks are as before.

**Approval:**
* With `purchasing.autoApproveMatchedInvoices` on, an invoice that matches within
  tolerance is approved when submitted, with no workflow; a comment records this.
* Exceptions (any variance) always go through the approval workflow. The amount is in KES
  and the currency is recorded.
* Approval books the **actual** against the budget in KES and releases the commitment.

**Order status.** When the order is fully received and every line is covered by approved
invoices, it becomes **INVOICED**.

**Invoice statuses.** Captured → Pending approval → Approved → (Scheduled → Partially paid
→) Paid, plus Rejected, Returned and Cancelled. The match status (Matched / Variance) is
shown alongside. Scheduled and Partially paid are used from phase 4.

### Delivery to the final user (hand-over)

**Handing over.** On the requisition page, *Delivery to the requester* shows each non-stock
line as ordered, received, delivered and waiting. Procurement or stores
(`purchasing.handover`) use *Hand over*:
* to the requester, or an active colleague in the requesting department;
* only what has been received and not yet handed over (`NOT_RECEIVED`);
* with the condition, notes and attachments.

The receiver is told the items are **ready for collection**.

**Confirming.** The hand-over is confirmed in one of two ways:
* **in the app:** the receiver opens the hand-over and clicks *I have received these*;
* **at the counter:** the officer clicks *Send code to the receiver*, and the receiver gets
  a 6-digit one-time code.
  * Only its SHA-256 is stored.
  * It is valid for `requisitions.handoverOtpMinutes` (15).
  * After `requisitions.handoverOtpMaxAttempts` (5) wrong codes it is void (410) and a new
    code must be sent.

The channel, time and IP are recorded.

**Delivered lines and closing.**
* Confirmed quantities count as delivered.
* **Stock lines** count as delivered when their store requisition line is fully issued.
* The requisition **closes automatically** when every line is delivered (or cancelled),
  and the requester is told.

### Milestone notifications to the requester

Requisitions category (in app / email per preference):
* the purchase request is approved;
* the LPO / LSO is issued (first send only);
* a delivery is waiting for their acceptance;
* goods are received from the supplier;
* goods are ready for collection, plus the one-time code;
* the requisition is delivered and closed.

### Document chain

REQ → PR → (RFQ) → PO → SCC (acceptance) → INV → HOV (hand-over); stock lines
REQ → SR → ISS.

### Configuration added

| | |
|---|---|
| Settings | `purchasing.matchPriceToleranceAbs` (0), `purchasing.autoApproveMatchedInvoices` (false), `requisitions.handoverOtpMinutes` (15), `requisitions.handoverOtpMaxAttempts` (5) |
| Permission | `purchasing.handover` (procurement officer / manager, SCM, storekeeper) |
| Numbering | HOV `{PREFIX}-{FY}-{SEQ}` |
| Statuses | Certificate: REJECTED; invoice: SCHEDULED, PARTIALLY_PAID (phase 4); PO: INVOICED; hand-over: PENDING / ACKNOWLEDGED / CANCELLED |
| API | `POST /service-certificates/:id/accept`, `/:id/reject` {reason}, `GET /service-certificates/awaiting-me`; certificate lines `rejectedQty`, `rejectionReason`; `/handovers` (list `?requisitionId=&mine=true&status=`, create, `/:id/acknowledge`, `/:id/otp`, `/:id/otp/verify` {code}, `/:id/cancel`); invoice `currency`, `exchangeRate`, `baseTotal`, `whtTotal`; requisition `deliverable` |
| Migration | `1762400000000-NonStockPhase3`. Existing invoices take their order's currency and rate; already-posted certificates set the received quantities on requisition lines. |

GL posting of accepted non-stock lines (expense / asset accounts) goes to QuickBooks with
the bill in phase 6. Received-not-invoiced accruals are in the phase 7 reports.

## Non-stock procurement — phase 4: payments and M-PESA payouts

### Payment vouchers (*Payments → Payables / Payment vouchers*)

**Payables** lists the approved invoices that are still owed:
* outstanding amount, and what is not yet on a voucher;
* due date and **ageing** (current, 1–30, 31–60, 61–90, 90+ days).

**Preparing a voucher** (`payments.prepare`). Select one supplier's invoices in one currency.
* Each invoice can be paid in full or in part.
* **Withholding tax** is deducted in proportion to the part paid. The voucher shows the
  amount settled, the WHT and the cash paid to the supplier.
* Methods:
  * Bank transfer (EFT), cheque, cash;
  * **M-PESA PayBill** (B2B, PayBill + account);
  * **M-PESA Till** (B2B buy goods);
  * **M-PESA B2C** (phone).
* M-PESA payees are validated. Phones are normalised to 2547… / 2541…. M-PESA pays KES
  in whole shillings only.
* Invoices on a voucher are **Scheduled**. An invoice cannot be put on more vouchers than
  it has left to pay.

**Approval.** The voucher goes through the approval matrix (`PV`):
* `PV-1`: up to 1,000,000, approved by the Finance manager.
* `PV-2`: above that, by the Finance manager, then Hospital management.

The preparer can never approve their own voucher.

**Releasing the payment** (`payments.release`). Release is technically blocked until
**every** approval level is complete. The releaser is **neither the preparer nor an
approver**. Every blocked attempt is written to the audit log
(`PAYMENT_RELEASE_BLOCKED`) with its reason.
* Bank, cheque and cash payments need the bank reference or cheque number.
* M-PESA payments are dispatched.

**When it is paid:**
* Each invoice's **paid amount** goes up and the invoice becomes **Partially paid** or
  **Paid**.
* When every invoice of an Invoiced order is paid, the order is **Paid**.
* The voucher PDF prints the invoices, WHT, net amount and the approval signatures.

**Statuses.** Draft → Pending approval → Approved → Processing (M-PESA) → Paid. Also:
* Failed or Review (the review queue);
* Reversed;
* Returned, Rejected, Cancelled.

The old one-step *Record payment* on an invoice is gone; it is refused with
`USE_PAYMENT_VOUCHER`. Older vouchers were migrated as paid, each with one line for its
invoice.

### M-PESA payouts (Daraja B2C / B2B)

Payouts go through a `PaymentGateway` interface (`apps/api/src/modules/payments/gateway.ts`).
Bank APIs can be added behind it later. There are two implementations:
* **Daraja:** B2C `BusinessPayment`, B2B `BusinessPayBill` / `BusinessBuyGoods`,
  Transaction Status and Reversal.
  * The OAuth token is cached until a minute before it expires.
  * Sandbox or production is chosen by `MPESA_PAYOUT_MODE`.
* **Simulator** (`mock`, the default for development and tests).

**Credentials** are environment variables only, never in code or the database. The
security credential is never stored. Raw requests are kept for audit with it redacted.

**Never paid twice:**
* Releasing locks the voucher.
* The attempt is recorded before anything is sent, with a fresh
  `OriginatorConversationID`.
* A unique index allows only **one live or successful attempt per voucher**.
* Double clicks and concurrent releases get 409 `ALREADY_DISPATCHED` / `NOT_APPROVED`, and
  nothing more is sent.

**Outcomes:**

| Daraja answer | What happens |
|---|---|
| Accepted | Wait for the result callback. After `payments.mpesaFollowUpMinutes` (10) without one, M-PESA is asked with **Transaction Status**. |
| Refused (4xx) | The attempt failed, nothing was sent. The voucher goes to the review queue (*Failed*) and can be released again as a new attempt. |
| Timeout / network / 5xx | Outcome **unknown**. It is **never re-sent** before M-PESA has been asked what happened to it. |
| Status: found | Applied like the callback (paid, or failed). |
| Status: not processed | Re-sent with backoff (2, 4, … minutes) up to `payments.mpesaMaxAttempts` (3), then *Failed*. |
| Status: no answer | After `payments.mpesaMaxStatusChecks` (6) checks the voucher goes to **Review**. Its attempt stays live, so nothing is sent until someone resolves it. |

**Callbacks.** `/api/v1/callbacks/mpesa-payouts/{result|timeout}/:token`, and
`…/status/:token/:id` and `…/reversal/:token/:id`.
* They are public. The secret token in the path is checked in constant time. An optional
  allow-list of source IPs applies (`MPESA_PAYOUT_CALLBACK_ALLOWED_IPS`).
* All `/api/v1/callbacks/*` endpoints are **rate-limited** per IP
  (`CALLBACK_RATE_LIMIT_PER_MINUTE`, 120).
* The raw callback is stored, and it is applied **idempotently**: a repeated callback
  changes nothing.
* The result records the M-PESA **receipt**, the recipient name, the **charges** (B2B
  DebitPartyCharges) and the completion time.
* A late "paid" result for an attempt recorded as failed sends the voucher to review and
  is audited (`MPESA_RESULT_CONFLICT`).

**Review queue** (*Payment vouchers → Review queue*, `payments.reconcile`). After checking
the statement, *Resolve* the voucher as:
* **paid**, with the receipt; or
* **not paid**, which frees it for a fresh attempt.

Each resolution is audited (`PAYMENT_RESOLVED`). Reconcilers and the preparer are notified
of failures (notification category PAYMENTS).

**Reversal.** *Reverse on M-PESA* sends a Reversal request. When the result arrives, the
voucher is Reversed and the invoices are owed again.

**Simulator outcomes,** chosen by the last three digits of the phone, PayBill or Till:

| Ending | Outcome |
|---|---|
| …333 | Refused |
| …000 | Fails (insufficient funds) |
| …222 | No callback (found by the status query) |
| …444 | Timeout, but paid |
| …555 | Timeout, never processed |
| …666 | Queue timeout |
| Anything else | Paid |

In mock mode the callback token is `mock-callback-token` unless one is set.

### Reconciliation (*Payments → M-PESA reconciliation*)

**Importing the statement.** Upload or paste the organisation statement CSV exported from
the M-PESA portal (Receipt No., Completion Time, Details, Paid In, Withdrawn). Lines are
upserted by receipt.

**Matching.** *Reconcile* a day or range, or let the `payments.mpesaReconcile` job do the
previous day at 06:00. Successful and reversed payouts are matched by receipt and amount.

**Exceptions:**
* `NOT_ON_STATEMENT`
* `AMOUNT_MISMATCH`
* `NOT_IN_SYSTEM`
* `STATUS_MISMATCH`: on the statement while the attempt is failed or unknown.
* `PENDING`: no result yet.

Charge lines are totalled separately. The run records the account balance where the
gateway gives it, and reconcilers are notified of exceptions.

`payments.mpesaFollowUp` runs every 5 minutes. *Check pending payments now* runs it on
demand.

### Configuration added

| | |
|---|---|
| Environment | `MPESA_PAYOUT_MODE` (mock / sandbox / production), `MPESA_PAYOUT_BASE_URL`, `MPESA_PAYOUT_CONSUMER_KEY`, `MPESA_PAYOUT_CONSUMER_SECRET`, `MPESA_PAYOUT_SHORTCODE`, `MPESA_PAYOUT_INITIATOR_NAME`, `MPESA_PAYOUT_SECURITY_CREDENTIAL`, `MPESA_PAYOUT_CALLBACK_BASE_URL`, `MPESA_PAYOUT_CALLBACK_TOKEN`, `MPESA_PAYOUT_CALLBACK_ALLOWED_IPS`, `MPESA_PAYOUT_TIMEOUT_MS`, `CALLBACK_RATE_LIMIT_PER_MINUTE` |
| Settings | `payments.mpesaFollowUpMinutes` (10), `payments.mpesaMaxAttempts` (3), `payments.mpesaMaxStatusChecks` (6) |
| Permissions | `payments.prepare`, `payments.release`, `payments.reconcile` (Finance / Accounts and Finance manager) |
| Workflows | `PV-1` (≤ 1,000,000: Finance manager), `PV-2` (> 1,000,000: + Hospital management) |
| Jobs | `payments.mpesaFollowUp` (`*/5 * * * *`), `payments.mpesaReconcile` (`0 6 * * *`) |
| Notification category | PAYMENTS |
| API | `GET /payments/payables`; `/payment-vouchers` (list `?status=&review=true&supplierId=&method=`, create, `/:id/submit`, `/:id/release`, `/:id/resolve`, `/:id/reverse`, `/:id/cancel`, `/:id/pdf`); `POST /payments/mpesa/follow-up`; `POST /payments/mpesa/statements` {csv}; `/payments/reconciliations`; callbacks above |
| Migration | `1762500000000-NonStockPhase4` |

**Before production:**
* Run against the Daraja sandbox with the hospital's B2C/B2B shortcode, initiator and
  security credential.
* Register the callback base URL (HTTPS).
* Set Safaricom's callback IPs in `MPESA_PAYOUT_CALLBACK_ALLOWED_IPS`.

**Not yet covered:**
* Posting to QuickBooks (BillPayment with WHT, and charges to bank charges) is phase 6. The
  current BillPayment posting covers the voucher's invoices at their net amounts.
* The rate limit is per API process (in memory).

## Non-stock procurement — phase 5: petty cash

### Floats (*Payments → Petty cash floats*, `pettycash.manage`)

Each float (per branch or department) has:
* a **custodian**;
* a **float limit** (the imprest);
* a **per-transaction limit**;
* a **replenishment threshold**;
* a cash GL account;
* optionally, payment by **M-PESA**, plus a reference shortcode.

**The cash book.** The balance moves only through the cash book (`petty_cash_transaction`):
opening, replenishment, disbursement, refund, top-up and reversal, each with the balance
after it.

**Sample.** `PC-ADMIN` (Administration), held by the accountant, with 50,000 in hand.

### Requests and advances (*Payments → Petty cash*, `pettycash.request` — all staff)

**What a request holds.**
* A **payment** to a staff member or a vendor, or an **advance / imprest** (always to the
  requester).
* Purpose, expense account (GL), cost centre, optional project, amount and attachments
  (receipts, quotes).
* Payment method: **cash**, **M-PESA to a phone** (B2C), **PayBill + account** or **Till**
  (B2B).

**Checks before approval:**
* Amount ≤ the float's per-transaction limit (`OVER_LIMIT`).
* Amount ≤ what the float has **available**: balance minus requests pending, approved or
  processing (`INSUFFICIENT_FLOAT`).
* **Duplicates.** The same payee (phone, PayBill + account, staff user or name) and the
  same amount within `pettyCash.duplicateWindowDays` (7) is refused with
  `POSSIBLE_DUPLICATE`. With a justification it goes ahead, and approvers see
  "possible duplicate of …".
* **No new advance while one is unretired** (`ADVANCE_OUTSTANDING`).
* M-PESA only on floats that pay by M-PESA, in whole shillings; payees are validated.

**Approval chain** (approval matrix, `PCV`):

| Amount | Approvers |
|---|---|
| Up to 10,000 | Supervisor / HOD of the cost centre → Finance (coding and documents) |
| 10,000 – 50,000 | + Finance manager |
| Over 50,000 | + CEO / Medical director |

The engine supplies delegation, escalation, reminders, approve-by-email links, and IP and
device on every action. The requester and the **custodian never approve**.

### Disbursement

Payment is **technically blocked** until every level is approved. Only the **custodian of
the float** pays, and never a request they raised or approved. Each blocked attempt is
audited (`PETTY_CASH_RELEASE_BLOCKED`).

**Paying out:**
* **Cash.** The custodian records who collected it, and the cash book is updated. The payee
  confirms receipt in the app (*I received it*).
* **M-PESA.** It goes through the phase 4 payout engine. It is sent once only, with the same
  status checks, retries, review queue and reversal. The float moves only when M-PESA
  confirms.

### Advances: retirement

* An advance must be retired within `pettyCash.retirementDays` (7).
* The holder lists the receipts. The **custodian checks** them (never their own), then
  either accepts or returns them.
* **Accepting** puts the unspent balance back into the float (REFUND), or pays out an
  overspend (TOP_UP).
* The `pettyCash.retirementReminders` job (07:00 daily) chases overdue advances.

### Replenishment and reconciliation

**Automatic replenishment.** When a disbursement takes the float below its threshold, a
**replenishment** for the amount up to the limit goes for approval automatically. It can
also be raised by hand. Approval is `PCRP` (Finance manager), and the custodian never
approves it. The custodian then **receives** the cash, with its reference.

**Cash counts.** A count records the counted cash against the cash book. Any **variance** is
kept and the petty cash managers are told.

**Cash book / statement.** For a float and period, it shows:
* opening + replenishments + refunds − disbursements − top-ups (± reversals) = closing;
* every movement, with links to the vouchers;
* the counts and their variances.

The **petty cash voucher PDF** prints the approvals, who paid and who received. Advances
add their receipts.

### Shared M-PESA engine

The phase 4 payouts service now pays any document through a `PayoutOwner` interface
(`apps/api/src/modules/payments/payout-owner.ts`). Supplier vouchers (`PV`) and petty cash
(`PCV`) share the same idempotent attempts table. An attempt belongs to exactly one
document (check constraint), with one live attempt per document (unique indexes). M-PESA
reconciliation covers both.

### Configuration added

| | |
|---|---|
| Settings | `pettyCash.duplicateWindowDays` (7), `pettyCash.retirementDays` (7) |
| Permissions | `pettycash.request` (every staff role that raises requisitions), `pettycash.disburse` and `pettycash.manage` (Finance / Accounts, Finance manager) |
| Workflows | `PCV-1` (≤ 10,000), `PCV-2` (10,000–50,000), `PCV-3` (> 50,000), `PCRP-1` |
| Numbering | PCV `{PREFIX}-{FY}-{SEQ}`, PCRP |
| Jobs | `pettyCash.retirementReminders` (`0 7 * * *`) |
| Notification category | PETTY_CASH |
| API | `/petty-cash/floats` (+ `/:id/statement?from&to`, `/:id/counts`), `/petty-cash/requests` (list `?scope=mine\|custodian\|all&status&floatId&kind&review`, create/update, `/:id/submit`, `/:id/disburse`, `/:id/acknowledge`, `/:id/retirement`, `/:id/retirement/verify`, `/:id/resolve`, `/:id/reverse`, `/:id/cancel`, `/:id/pdf`), `/petty-cash/replenishments` (+ `/:id/submit`, `/:id/receive`, `/:id/cancel`) |
| Migration | `1762600000000-NonStockPhase5` |

**Not yet covered.** QuickBooks posting (petty cash expenses as Purchase / Expense,
replenishments as Transfer) is phase 6. The petty cash reports (spend by category,
department and user; outstanding advances; replenishment history) are phase 7.

## Non-stock procurement — phase 6: QuickBooks Online

This builds on the slice-11 QuickBooks integration: the OAuth connection with encrypted,
refreshed tokens; the sandbox / production / mock company; mappings; previewed batches;
retries; and reconciliation. Phase 6 adds the non-stock, payment and petty cash documents
to it.

### What is posted

| Local document | QuickBooks | Accounts / details |
|---|---|---|
| Approved LPO / LSO | **PurchaseOrder** (non-posting) | Stock lines → GRNI; non-stock lines → their GL account; class; tax code; currency and rate. An **amended** order is sent again as an **update** with its Id and **SyncToken**. |
| Approved supplier invoice (matched, or exception approved through the matrix) | **Bill** | Stock lines → GRNI (store class); non-stock lines → GL account (cost-centre class); input VAT unless `purchasing.costIncludesVat`; **CurrencyRef / ExchangeRate** for foreign invoices (ledger in KES); each line **linked to the QuickBooks purchase order line** when the PO was sent. Now includes Scheduled / Partially paid invoices. |
| Withholding tax on a paid voucher | **VendorCredit** to WHT payable | Applied by the bill payment. |
| Paid payment voucher | **BillPayment** | Bills settled in full for their share; the WHT credit applied; **TotalAmt = cash paid** from the method's account (PAYMENT_ACCOUNT, else M-PESA paying account / default bank). |
| M-PESA charges on a payout (voucher or petty cash) | **Purchase** | M-PESA account → bank charges. |
| Petty cash payment | **Purchase** (Cash) | Float cash account (M-PESA account for M-PESA) → expense GL, cost-centre class, vendor when known. |
| Petty cash advance | **JournalEntry** | Dr staff advances, Cr float. |
| Retirement of an advance | **JournalEntry** | Dr each receipt's GL (class); Dr float with the refund (or Cr with the overspend); Cr staff advances. |
| Petty cash replenishment (received) | **Transfer** | Bank → float. |

**GL accounts.** GL accounts imported from QuickBooks carry their QuickBooks id. Others
are mapped by code under *Mappings → GL accounts* (`GL_ACCOUNT`).

**Control accounts.** The new control accounts are `MPESA_CLEARING`, `WHT_PAYABLE`,
`BANK_CHARGES` and `STAFF_ADVANCES`.

**Classes.** Cost centres map to QuickBooks classes through `DEPARTMENT_CLASS`; stores
through `STORE_CLASS`.

**Sample data.** The sample mappings link every new account, and the sample GL accounts,
to the mock company.

### Sync engine

**The queue.** `accounting_posting` is the queue: one row per QuickBooks document.
* It is idempotent: the posting id is QuickBooks' `requestid`, and posted documents are
  never sent twice.
* It stores the **QuickBooks Id and SyncToken**, and the source version for purchase orders.
* Statuses are READY, BLOCKED (with what to map), PENDING (retrying with back-off),
  POSTED and FAILED.

**The error log.** *QuickBooks → Postings & errors* lists failed and blocked postings. Its retry action
rebuilds a posting from its source after a mapping is fixed, and sends it again.

**Automatic sync.** Set `accounting.autoSync` (off by default). The job
`accounting.autoSync` runs every 15 minutes and previews and posts new purchases, payments
and petty cash from `accounting.autoSyncFrom` (default: the last 30 days).
`accounting.dispatch` retries the rest. *Run automatic sync now* runs it on demand.

**Sync status on every document.** Purchase orders, invoices, payment vouchers and petty
cash vouchers show a **QuickBooks: synced / pending / failed / not sent** chip. Its tooltip
shows each posting, its QuickBooks id and any error (`GET /accounting/sync-status?ids=`).

**Vendors.** *Link QuickBooks vendors* (PULL) links existing vendors to suppliers by KRA PIN
(tax id) or name. *Create missing vendors* (PUSH) creates the rest. Vendors are otherwise
created on first use.

The mock company now supports PurchaseOrder, Purchase, Transfer, updates with
`SyncToken` (a stale token is refused, as QuickBooks does), vendor credits applied in bill
payments, and foreign-currency transactions.

### Configuration added

| | |
|---|---|
| Settings | `accounting.autoSync` (false), `accounting.autoSyncFrom` ('' = last 30 days) |
| Jobs | `accounting.autoSync` (`*/15 * * * *`) |
| Mappings | `GL_ACCOUNT`; SYSTEM `MPESA_CLEARING`, `WHT_PAYABLE`, `BANK_CHARGES`, `STAFF_ADVANCES`; PAYMENT_ACCOUNT for `CHEQUE`, `MPESA_PAYBILL`, `MPESA_TILL`, `MPESA_B2C` |
| Batch kinds | `PETTY_CASH` (new); `PURCHASES` now includes purchase orders, WHT credits and M-PESA charges |
| API | `GET /accounting/sync-status?ids=`, `POST /accounting/vendors/sync` {direction: PULL \| PUSH}, `POST /accounting/auto-sync` |
| Migration | `1762700000000-NonStockPhase6` |

**Not yet covered:**
* QuickBooks webhooks / CDC (changes made in QuickBooks flowing back) are not
  implemented. Vendor and account changes are picked up by *Link QuickBooks vendors* and
  *Import from QuickBooks* (GL accounts).
* Reversed M-PESA payments and reversed petty cash are not posted automatically; correct
  them in QuickBooks.
* Foreign-currency bill payments use the invoice's rate (no realised exchange gain or
  loss).
* As before, the integration has been exercised against the mock company only. Connect an
  Intuit sandbox company before production.

## Non-stock procurement — phase 7: reports, dashboards, exports and schedules

The 24 reports of the specification are on *Reports* (`apps/api/src/modules/reports/definitions/nonstock.ts`
plus the existing purchasing reports). They use the slice-12 report engine, so every
report has:
* **filters**;
* **CSV / Excel / PDF export**;
* **scheduled email delivery** (*Email on a schedule*, the `reports.scheduled` job);
* the user's store scope.

**Drill-down.** Document numbers link to the document: requisition, purchase request,
RFQ, order, certificate, invoice, payment voucher, petty cash voucher or replenishment.

**Charts.** Trend reports draw a chart above the table.

**New filters:** project, user, currency, petty cash float, payment method, and the
period bucket (day / week / month / quarter / year), next to the existing date range,
store, department / cost centre, supplier, category, status and grouping.

### The reports

**Procurement**

| # | Report | Key |
|---|---|---|
| 1 | Pending requisitions: age, approval step and who it waits for | `pending-requisitions` |
| 2 | Pending purchase requests: status, value, days pending | `pending-prs` |
| 3 | Open orders / LPOs: not received, partly received, delivery overdue, expiring | `open-lpos` (and `outstanding-pos`) |
| 4 | RFQ status, evaluation, recommendation, award and justification | `rfq-awards` |
| 5 | GRN / service acceptance register; received-not-invoiced accruals | `grn-register`, `acceptance-register`, `received-not-invoiced` |
| 6 | Three-way match exceptions | `match-exceptions` |
| 7 | **Value of purchases over time**: by day / week / month / quarter / year, by department, supplier, category or GL account, with the previous period and change %, and a trend chart | `purchases-over-time` |
| 8 | Supplier performance: lead time, on-time %, rejection rate, returns, **price variance %** (new) | `supplier-performance` |
| 9 | Procurement cycle time: requisition → approval → PR → order → receipt → payment → delivery | `procurement-cycle-time` |
| 10 | Budget vs committed vs actual vs paid, per budget line / cost centre | `budget-vs-actual` |
| 11 | Delivered to final users vs outstanding | `delivered-to-users` |

**Payments**

| # | Report | Key |
|---|---|---|
| 12 | AP ageing: current, 1–30, 31–60, 61–90, 90+ | `ap-ageing` |
| 13 | Payments by method (bank, cheque, M-PESA B2B / B2C, cash), per period; petty cash alongside | `payments-by-method` |
| 14 | Payment schedule / cash requirement by week, with the running total | `payment-schedule` |
| 15 | M-PESA log and reconciliation: status, receipt, charges, on the statement or not | `mpesa-log` |
| 16 | Withholding tax and VAT summary, per supplier (KRA PIN) or month | `wht-vat-summary` |

**Petty cash**

| # | Report | Key |
|---|---|---|
| 17 | Petty cash book: opening, receipts, disbursements, closing | `petty-cash-book` |
| 18 | Pending requests by approval level and approver (or custodian, when approved) | `petty-cash-pending` |
| 19 | Spend by category (GL), department, user or month; advances counted by their receipts | `petty-cash-spend` |
| 20 | Outstanding advances and overdue retirements | `outstanding-advances` |
| 21 | Replenishments and cash-count variances | `petty-cash-replenishments` |

**Audit and integration**

| # | Report | Key |
|---|---|---|
| 22 | Approval audit trail: who, when, step, decision, delegation (on behalf of), channel, IP | `approval-audit` |
| 23 | QuickBooks sync status and errors | `quickbooks-sync` |
| 24 | Payment control exceptions: duplicate payments (an invoice settled more than once; the same petty cash payee and amount within the duplicate window), **possible splits** (several requests by one requester, or orders to one supplier, within 3 days, each under an approval threshold of the matrix and together over it), and payments with nothing received or accepted | `control-exceptions` |

### Dashboard

New tiles, by permission:
* **Open orders / LPOs (value)**.
* **Ordered this month**, with the change on last month.
* **Petty cash in hand**, with floats below their replenishment level.
* **Advances overdue for retirement**.
* **M-PESA payments failed or in review**.
* **Approved invoices to pay**, now pointing at *Payables*.

These sit next to the existing *Waiting for my approval* and *QuickBooks errors* tiles.

### Configuration added

| | |
|---|---|
| Report groups | PAYMENTS, PETTY_CASH, AUDIT |
| Report filters | `projectId`, `userId`, `currency`, `floatId`, `method`, `period` |
| Report columns | optional `link` (drill-down); report definitions may declare a `chart` |
| Permissions | each report keeps to its area: purchasing / requisitions, payments, petty cash, `audit.read`, accounting |

Report totals are checked against independent queries in `test/non-stock-phase7.spec.ts`.

## Known limitations / next slices

* Reports run on the live database (no reporting replica or pre-aggregation); very
  long periods over millions of ledger rows are slower than two seconds. Scheduled
  reports are capped at `reports.maxRows` rows.
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
  (local billing).
* POS: M-Pesa refunds are not automated (no B2C reversal). Loyalty points redeemed on a
  partly refunded sale are not given back (a full void or refund does). The offline
  queue lives in the till’s browser storage: clearing it before syncing loses those sales.
* QuickBooks has been exercised against the mock company only; connect an Intuit sandbox
  company before production. Documents are not updated or voided in QuickBooks after
  posting: correct them there, or with a credit note here. QuickBooks Desktop and Xero
  are not supported (the AccountingAdapter interface is where another one would go).
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
