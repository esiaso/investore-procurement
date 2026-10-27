import { BadRequestException, ConflictException, Injectable, Logger, NotFoundException, OnModuleInit } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { randomBytes } from 'node:crypto';
import { DataSource, EntityManager, In } from 'typeorm';
import { AccountingProvider, AccountMappingKind, DocumentType, ExternalEntity, PostingDocType, PostingStatus, QboEnvironment, SessionUser } from '@sil/shared';
import { decryptField, encryptField } from '../../common/crypto';
import { loadEnv } from '../../config/env';
import { round2 } from '../billing/tax-calc';
import { JobsService } from '../jobs/jobs.service';
import { NumberingService } from '../numbering/numbering.service';
import { SettingsService } from '../settings/settings.service';
import { ConnectionDto, MappingDto, PostingQueryDto, PreviewDto, SettlementDto } from './accounting.dto';
import { AccountingBatch, AccountingConnection, AccountingPosting, AccountMapping, ExternalRef, PayerSettlement } from './accounting.entities';
import { AccountingAdapter, faultText, QboAdapter, QboError, readTrialBalance, sharedMockQbo } from './qbo';

const CODE = 'QBO';
const key = () => loadEnv().dataEncryptionKey;
const enc = (v: string) => encryptField(key(), v);
const dec = (v: string | null | undefined) => (v ? decryptField(key(), v) : '');

/** Control accounts the postings need (AccountMappingKind.SYSTEM). */
export const SYSTEM_ACCOUNTS: Record<string, string> = {
  AP: 'Accounts payable',
  AR: 'Accounts receivable',
  GRNI: 'Goods received not invoiced (clearing)',
  VAT_INPUT: 'VAT recoverable (input)',
  VAT_OUTPUT: 'VAT payable (output)',
  STOCK_IN_TRANSIT: 'Stock in transit between stores',
  STOCK_ADJUSTMENT: 'Stock adjustments and count variances',
  STOCK_WRITE_OFF: 'Stock write-offs (expiry, damage, disposal)',
  OPENING_BALANCE: 'Opening balance equity (opening stock)',
  BANK: 'Default bank account for supplier payments',
};
const WRITE_OFF_REASONS = new Set(['EXPIRY', 'DISPOSAL', 'DAMAGE', 'BREAKAGE', 'THEFT', 'LOSS', 'TRANSIT_LOSS']);
const ORDER: PostingDocType[] = [
  PostingDocType.BILL,
  PostingDocType.VENDOR_CREDIT,
  PostingDocType.BILL_PAYMENT,
  PostingDocType.SALES_RECEIPT,
  PostingDocType.INVOICE,
  PostingDocType.PAYMENT,
  PostingDocType.REFUND_RECEIPT,
  PostingDocType.CREDIT_MEMO,
  PostingDocType.JOURNAL,
];
const ENTITY_PATH: Record<PostingDocType, string> = {
  BILL: 'bill',
  BILL_PAYMENT: 'billpayment',
  VENDOR_CREDIT: 'vendorcredit',
  SALES_RECEIPT: 'salesreceipt',
  INVOICE: 'invoice',
  PAYMENT: 'payment',
  REFUND_RECEIPT: 'refundreceipt',
  CREDIT_MEMO: 'creditmemo',
  JOURNAL: 'journalentry',
};

/** What a document becomes: QuickBooks body (with {$ref} / {$posting} placeholders) and the local entries. */
interface Built {
  docType: PostingDocType;
  localDocType: string;
  localDocId: string;
  localDocNo: string | null;
  txnDate: string;
  amount: number;
  entries: { account: string; amount: number; classId?: string | null }[];
  payload: Record<string, unknown>;
  missing: string[];
}

/** Placeholder for master data created in QuickBooks when the document is sent. */
type MasterRef = { $ref: { entity: ExternalEntity; localKey: string; name: string; categoryId?: string; itemId?: string } };

/**
 * QuickBooks Online: connection (OAuth 2.0), mappings, master data, and
 * posting of purchases (bills, bill payments, vendor credits), sales (sales
 * receipts or invoices with payments, refund receipts / credit memos, payer
 * settlements, payments on account) and period inventory journals. Posted in
 * previewed batches, each document once; retries with back-off; reconciliation
 * of local totals with QuickBooks.
 */
@Injectable()
export class AccountingService implements OnModuleInit {
  private readonly log = new Logger('QuickBooks');

  constructor(
    @InjectDataSource() private readonly ds: DataSource,
    private readonly settings: SettingsService,
    private readonly numbering: NumberingService,
    private readonly jobs: JobsService,
  ) {}

  onModuleInit() {
    this.jobs.register('accounting.dispatch', 'Retry QuickBooks postings that are waiting (back-off)', () => this.dispatch());
    this.jobs.register('accounting.refresh', 'Refresh the QuickBooks token and the books closing date', () => this.refreshJob());
  }

  // ------------------------------------------------------------------ connection and OAuth

  private async conn(m: EntityManager = this.ds.manager, secrets = false): Promise<AccountingConnection | null> {
    const qb = m.getRepository(AccountingConnection).createQueryBuilder('c').where('c.code = :c', { c: CODE });
    if (secrets) qb.addSelect(['c.clientSecretEnc', 'c.accessTokenEnc', 'c.refreshTokenEnc', 'c.oauthState']);
    return qb.getOne();
  }

  async getConnection() {
    const c = await this.conn(this.ds.manager, true);
    if (!c) return null;
    const { clientSecretEnc, accessTokenEnc, refreshTokenEnc, oauthState: _s, ...rest } = c;
    return { ...rest, hasClientSecret: !!clientSecretEnc, connected: !!(accessTokenEnc && refreshTokenEnc && c.realmId) };
  }

  async saveConnection(dto: ConnectionDto) {
    if (dto.provider === AccountingProvider.QBO && (!dto.clientId || !dto.redirectUri)) throw new BadRequestException('QuickBooks needs the app client id and the redirect URI registered with Intuit');
    const repo = this.ds.getRepository(AccountingConnection);
    const row = (await this.conn(this.ds.manager, true)) ?? repo.create({ code: CODE });
    const changedApp = row.id && (row.provider !== dto.provider || row.environment !== (dto.environment ?? QboEnvironment.SANDBOX) || row.clientId !== (dto.clientId ?? null));
    Object.assign(row, {
      provider: dto.provider,
      environment: dto.environment ?? QboEnvironment.SANDBOX,
      clientId: dto.clientId ?? null,
      redirectUri: dto.redirectUri ?? null,
      journalsFrom: dto.journalsFrom ?? row.journalsFrom ?? null,
      closingDate: dto.closingDate === undefined ? row.closingDate : dto.closingDate,
      isActive: dto.isActive ?? true,
    });
    if (dto.clientSecret) row.clientSecretEnc = enc(dto.clientSecret);
    // Another app or company: the old tokens no longer apply.
    if (changedApp) Object.assign(row, { accessTokenEnc: null, refreshTokenEnc: null, realmId: null, connectedAt: null });
    await repo.save(row);
    return this.getConnection();
  }

  private adapter(c: AccountingConnection): AccountingAdapter {
    return c.provider === AccountingProvider.MOCK ? sharedMockQbo : QboAdapter.forEnvironment(c.environment);
  }

  /** URL to send the user to Intuit's consent screen (the mock comes straight back). */
  async startOAuth() {
    const c = await this.conn(this.ds.manager, true);
    if (!c) throw new ConflictException('Save the QuickBooks settings first');
    const state = randomBytes(18).toString('base64url');
    await this.ds.getRepository(AccountingConnection).update(c.id, { oauthState: state });
    const redirectUri = c.redirectUri ?? '/api/v1/callbacks/quickbooks';
    return { url: this.adapter(c).authorizeUrl({ clientId: c.clientId ?? 'mock', redirectUri, state }) };
  }

  /** Intuit's redirect: checks the state, exchanges the code, stores the tokens and the company. */
  async oauthCallback(q: { code?: string; state?: string; realmId?: string; error?: string }, actorId: string | null) {
    const c = await this.conn(this.ds.manager, true);
    if (!c || !q.state || q.state !== c.oauthState) throw new BadRequestException('This QuickBooks authorisation was not started here (state mismatch)');
    if (q.error || !q.code || !q.realmId) throw new BadRequestException(`QuickBooks did not authorise: ${q.error ?? 'no code'}`);
    const t = await this.adapter(c).exchangeCode({ code: q.code, redirectUri: c.redirectUri ?? '/api/v1/callbacks/quickbooks', clientId: c.clientId ?? 'mock', clientSecret: dec(c.clientSecretEnc) }, await this.settings.get('accounting.requestTimeoutMs'));
    Object.assign(c, {
      realmId: q.realmId,
      accessTokenEnc: enc(t.accessToken),
      refreshTokenEnc: enc(t.refreshToken),
      accessExpiresAt: new Date(Date.now() + t.expiresIn * 1000),
      refreshExpiresAt: new Date(Date.now() + t.refreshExpiresIn * 1000),
      oauthState: null,
      connectedAt: new Date(),
      connectedBy: actorId,
      lastError: null,
    });
    await this.ds.getRepository(AccountingConnection).save(c);
    await this.refreshCompany().catch((e) => this.log.warn(`company info: ${(e as Error).message}`));
    return this.getConnection();
  }

  async disconnect() {
    const c = await this.conn(this.ds.manager, true);
    if (!c) return null;
    if (c.refreshTokenEnc) await this.adapter(c).revoke({ token: dec(c.refreshTokenEnc), clientId: c.clientId ?? 'mock', clientSecret: dec(c.clientSecretEnc) }, 10_000);
    await this.ds.getRepository(AccountingConnection).update(c.id, { accessTokenEnc: null, refreshTokenEnc: null, accessExpiresAt: null, refreshExpiresAt: null, connectedAt: null });
    return this.getConnection();
  }

  /** A valid access token (refreshed when it expires within 5 minutes). */
  private async token(force = false): Promise<{ c: AccountingConnection; accessToken: string }> {
    const c = await this.conn(this.ds.manager, true);
    if (!c?.isActive || !c.refreshTokenEnc || !c.realmId) throw new ConflictException('QuickBooks is not connected');
    if (!force && c.accessTokenEnc && c.accessExpiresAt && c.accessExpiresAt.getTime() - Date.now() > 300_000) return { c, accessToken: dec(c.accessTokenEnc) };
    const t = await this.adapter(c).refresh({ refreshToken: dec(c.refreshTokenEnc), clientId: c.clientId ?? 'mock', clientSecret: dec(c.clientSecretEnc) }, await this.settings.get('accounting.requestTimeoutMs'));
    await this.ds.getRepository(AccountingConnection).update(c.id, {
      accessTokenEnc: enc(t.accessToken),
      refreshTokenEnc: enc(t.refreshToken),
      accessExpiresAt: new Date(Date.now() + t.expiresIn * 1000),
      refreshExpiresAt: new Date(Date.now() + t.refreshExpiresIn * 1000),
    });
    return { c, accessToken: t.accessToken };
  }

  /** One API call; an expired token is refreshed once. Network / 5xx / 429 → retryable QboError. */
  private async api(method: 'GET' | 'POST', path: string, body?: unknown, requestId?: string): Promise<Record<string, unknown>> {
    const timeout = await this.settings.get('accounting.requestTimeoutMs');
    let { c, accessToken } = await this.token();
    let r = await this.adapter(c).call({ realmId: c.realmId!, accessToken, method, path, body, requestId }, timeout);
    if (r.status === 401) {
      ({ c, accessToken } = await this.token(true));
      r = await this.adapter(c).call({ realmId: c.realmId!, accessToken, method, path, body, requestId }, timeout);
    }
    if (r.network) throw new QboError(r.error ?? 'QuickBooks could not be reached', true);
    if (r.status >= 500 || r.status === 429) throw new QboError(`QuickBooks HTTP ${r.status}: ${faultText(r.body)}`, true);
    if (r.status >= 400) throw new QboError(faultText(r.body));
    return r.body ?? {};
  }

  private async query<T = Record<string, unknown>>(entity: string, where?: [string, string]): Promise<T[]> {
    const sql = `select * from ${entity}${where ? ` where ${where[0]} = '${where[1].replace(/'/g, "\\'")}'` : ''} maxresults 1000`;
    const body = await this.api('GET', `query?query=${encodeURIComponent(sql)}`);
    return ((body.QueryResponse as Record<string, unknown> | undefined)?.[entity] as T[] | undefined) ?? [];
  }

  /** Company name and the books closing date from QuickBooks (job accounting.refresh too). */
  async refreshCompany() {
    const c = await this.conn();
    if (!c?.realmId) return null;
    const info = await this.api('GET', `companyinfo/${c.realmId}`);
    const prefs = await this.api('GET', 'preferences');
    const close = ((prefs.Preferences as Record<string, unknown> | undefined)?.AccountingInfoPrefs as { BookCloseDate?: string } | undefined)?.BookCloseDate ?? null;
    await this.ds.getRepository(AccountingConnection).update(c.id, { companyName: ((info.CompanyInfo as { CompanyName?: string } | undefined)?.CompanyName ?? c.companyName) || null, ...(close ? { closingDate: close } : {}), lastError: null });
    return this.getConnection();
  }

  async refreshJob() {
    const c = await this.conn();
    if (!c?.connectedAt || !c.isActive) return { skipped: true };
    try {
      await this.token(true);
      await this.refreshCompany();
      return { refreshed: true };
    } catch (e) {
      await this.ds.getRepository(AccountingConnection).update(c.id, { lastError: (e as Error).message.slice(0, 1000) });
      return { error: (e as Error).message };
    }
  }

  /** QuickBooks accounts, classes and tax codes for the mapping screens. */
  async lists() {
    const [accounts, classes, taxCodes] = await Promise.all([this.query('Account'), this.query('Class'), this.query('TaxCode')]);
    const pick = (rows: Record<string, unknown>[], extra?: string) => rows.map((r) => ({ id: String(r.Id), name: String(r.Name ?? r.FullyQualifiedName), ...(extra ? { [extra]: r[extra] } : {}) }));
    return { accounts: pick(accounts, 'AccountType'), classes: pick(classes), taxCodes: pick(taxCodes) };
  }

  // ------------------------------------------------------------------ mappings

  async mappings() {
    const rows = await this.ds.getRepository(AccountMapping).find({ order: { kind: 'ASC', localKey: 'ASC' } });
    // What still needs a mapping, so the screen can list the gaps.
    const [cats, stores, depts, taxes, modes] = await Promise.all([
      this.ds.query(`SELECT code, name FROM item_category ORDER BY code`),
      this.ds.query(`SELECT code, name FROM store WHERE is_active ORDER BY code`),
      this.ds.query(`SELECT code, name FROM department WHERE is_active ORDER BY code`),
      this.ds.query(`SELECT code, name FROM tax_category ORDER BY code`),
      this.ds.query(`SELECT code, name FROM payment_mode WHERE is_active AND NOT is_credit ORDER BY code`),
    ]);
    const methods: { method: string }[] = await this.ds.query(`SELECT DISTINCT upper(method) AS method FROM payment_voucher ORDER BY 1`);
    return {
      mappings: rows,
      keys: {
        CATEGORY_INVENTORY: cats,
        CATEGORY_COGS: cats,
        CATEGORY_INCOME: cats,
        CATEGORY_CONSUMPTION: cats,
        STORE_CLASS: stores,
        DEPARTMENT_CLASS: depts,
        TAX_CODE: taxes,
        PAYMENT_ACCOUNT: [...modes, ...methods.filter((x) => !modes.some((m: { code: string }) => m.code === x.method)).map((x) => ({ code: x.method, name: `Supplier payments by ${x.method}` }))],
        SYSTEM: Object.entries(SYSTEM_ACCOUNTS).map(([code, name]) => ({ code, name })),
      },
    };
  }

  async saveMapping(dto: MappingDto) {
    const repo = this.ds.getRepository(AccountMapping);
    const row = (await repo.findOneBy({ kind: dto.kind, localKey: dto.localKey })) ?? repo.create({ kind: dto.kind, localKey: dto.localKey });
    Object.assign(row, { externalId: dto.externalId, externalName: dto.externalName ?? null });
    return repo.save(row);
  }

  async deleteMapping(id: string) {
    const r = await this.ds.getRepository(AccountMapping).delete({ id });
    if (!r.affected) throw new NotFoundException('Mapping not found');
  }

  // ------------------------------------------------------------------ building documents

  /** Mapping lookups for one build run; a missing one is recorded, not thrown. */
  private async mapper(m: EntityManager) {
    const rows = await m.find(AccountMapping);
    const index = new Map(rows.map((r) => [`${r.kind}|${r.localKey}`, r.externalId]));
    const cats: { id: string; code: string; parent_id: string | null }[] = await m.query(`SELECT id, code, parent_id FROM item_category`);
    const catById = new Map(cats.map((c) => [c.id, c]));
    return {
      get(kind: AccountMappingKind, k: string | null | undefined, missing: string[], label?: string): string {
        const v = k ? index.get(`${kind}|${k}`) : undefined;
        if (!v) missing.push(`${kind.replace(/_/g, ' ').toLowerCase()} for ${label ?? k ?? '(none)'}`);
        return v ?? '';
      },
      optional(kind: AccountMappingKind, k: string | null | undefined): string | null {
        return k ? (index.get(`${kind}|${k}`) ?? null) : null;
      },
      /** Category accounts fall back to the nearest mapped parent category. */
      category(kind: AccountMappingKind, categoryId: string, missing: string[]): string {
        let c = catById.get(categoryId);
        const first = c?.code;
        while (c) {
          const v = index.get(`${kind}|${c.code}`);
          if (v) return v;
          c = c.parent_id ? catById.get(c.parent_id) : undefined;
        }
        missing.push(`${kind.replace(/_/g, ' ').toLowerCase()} for category ${first ?? categoryId}`);
        return '';
      },
    };
  }

  private ref(v: string | null) {
    return v ? { value: v } : undefined;
  }

  /** Bills from approved, matched supplier invoices (debit GRNI; input VAT unless VAT is part of stock cost). */
  private async buildBills(m: EntityManager, mp: Awaited<ReturnType<AccountingService['mapper']>>, from: string, to: string, ids?: string[]): Promise<Built[]> {
    const costIncludesVat = await this.settings.get('purchasing.costIncludesVat', m);
    const invs: { id: string; number: string; supplier_invoice_no: string; invoice_date: string; due_date: string | null; total: string; tax_total: string; subtotal: string; supplier_id: string; supplier: string; store_code: string; po: string }[] = await m.query(
      `SELECT si.id, si.number, si.supplier_invoice_no, to_char(si.invoice_date, 'YYYY-MM-DD') AS invoice_date, to_char(si.due_date, 'YYYY-MM-DD') AS due_date, si.total, si.tax_total, si.subtotal,
              si.supplier_id, s.name AS supplier, st.code AS store_code, po.number AS po
         FROM supplier_invoice si JOIN supplier s ON s.id = si.supplier_id JOIN purchase_order po ON po.id = si.purchase_order_id JOIN store st ON st.id = po.store_id
        WHERE si.status IN ('APPROVED', 'PAID') AND si.match_status = 'MATCHED' AND ${ids ? `si.id = ANY($1::uuid[])` : `si.invoice_date BETWEEN $1::date AND $2::date`}`,
      ids ? [ids] : [from, to],
    );
    const out: Built[] = [];
    for (const i of invs) {
      const missing: string[] = [];
      const lines: { quantity: string; unit_price: string; tax_amount: string; line_total: string; item: string; tax_code: string }[] = await m.query(
        `SELECT l.quantity, l.unit_price, l.tax_amount, l.line_total, it.name AS item, tc.code AS tax_code
           FROM supplier_invoice_line l JOIN purchase_order_line pl ON pl.id = l.po_line_id JOIN item it ON it.id = pl.item_id JOIN tax_category tc ON tc.id = it.tax_category_id
          WHERE l.invoice_id = $1`,
        [i.id],
      );
      const grni = mp.get(AccountMappingKind.SYSTEM, 'GRNI', missing);
      const ap = mp.get(AccountMappingKind.SYSTEM, 'AP', missing);
      const tax = Number(i.tax_total);
      const vatIn = tax && !costIncludesVat ? mp.get(AccountMappingKind.SYSTEM, 'VAT_INPUT', missing) : null;
      const cls = mp.optional(AccountMappingKind.STORE_CLASS, i.store_code);
      const qLines = lines.map((l) => {
        const amount = costIncludesVat ? Number(l.line_total) : round2(Number(l.quantity) * Number(l.unit_price));
        return { DetailType: 'AccountBasedExpenseLineDetail', Amount: amount, Description: `${l.item} × ${Number(l.quantity)}`, AccountBasedExpenseLineDetail: { AccountRef: this.ref(grni), ClassRef: this.ref(cls), TaxCodeRef: this.ref(mp.get(AccountMappingKind.TAX_CODE, l.tax_code, missing, `tax category ${l.tax_code}`)) } };
      });
      const lineSum = round2(qLines.reduce((s, l) => s + l.Amount, 0));
      const total = round2(lineSum + (vatIn ? tax : 0));
      out.push({
        docType: PostingDocType.BILL,
        localDocType: 'SUPPLIER_INVOICE',
        localDocId: i.id,
        localDocNo: i.number,
        txnDate: i.invoice_date,
        amount: total,
        entries: [{ account: grni, amount: lineSum, classId: cls }, ...(vatIn ? [{ account: vatIn, amount: tax }] : []), { account: ap, amount: -total }],
        payload: {
          VendorRef: { $ref: { entity: ExternalEntity.VENDOR, localKey: i.supplier_id, name: i.supplier } } satisfies MasterRef,
          TxnDate: i.invoice_date,
          ...(i.due_date ? { DueDate: i.due_date } : {}),
          DocNumber: i.supplier_invoice_no.slice(0, 21),
          PrivateNote: `${i.number} · ${i.po}`,
          GlobalTaxCalculation: vatIn ? 'TaxExcluded' : 'NotApplicable',
          Line: qLines,
          ...(vatIn ? { TxnTaxDetail: { TotalTax: tax } } : {}),
        },
        missing,
      });
    }
    return out;
  }

  private async buildBillPayments(m: EntityManager, mp: Awaited<ReturnType<AccountingService['mapper']>>, from: string, to: string, ids?: string[]): Promise<Built[]> {
    // A voucher pays one or more bills (its lines; older vouchers name one invoice).
    const rows: { id: string; number: string; amount: string; paid_on: string; reference: string; method: string; supplier_id: string; supplier: string; lines: { invoice_id: string; amount: number }[] }[] = await m.query(
      `SELECT pv.id, pv.number, pv.amount, to_char(pv.paid_on, 'YYYY-MM-DD') AS paid_on, pv.payment_reference AS reference, upper(pv.method) AS method, s.id AS supplier_id, s.name AS supplier,
              COALESCE(json_agg(json_build_object('invoice_id', l.invoice_id, 'amount', l.net_amount)) FILTER (WHERE l.id IS NOT NULL),
                       json_build_array(json_build_object('invoice_id', pv.invoice_id, 'amount', pv.amount))) AS lines
         FROM payment_voucher pv LEFT JOIN supplier_invoice si ON si.id = pv.invoice_id LEFT JOIN payment_voucher_line l ON l.voucher_id = pv.id
         JOIN supplier s ON s.id = COALESCE(pv.supplier_id, si.supplier_id)
        WHERE pv.status = 'PAID' AND ${ids ? `pv.id = ANY($1::uuid[])` : `pv.paid_on BETWEEN $1::date AND $2::date`}
        GROUP BY pv.id, s.id, s.name`,
      ids ? [ids] : [from, to],
    );
    return rows.map((p) => {
      const missing: string[] = [];
      const bank = mp.optional(AccountMappingKind.PAYMENT_ACCOUNT, p.method) ?? mp.get(AccountMappingKind.SYSTEM, 'BANK', missing);
      const ap = mp.get(AccountMappingKind.SYSTEM, 'AP', missing);
      const amount = Number(p.amount);
      return {
        docType: PostingDocType.BILL_PAYMENT,
        localDocType: 'PAYMENT_VOUCHER',
        localDocId: p.id,
        localDocNo: p.number,
        txnDate: p.paid_on,
        amount,
        entries: [{ account: ap, amount }, { account: bank, amount: -amount }],
        payload: {
          VendorRef: { $ref: { entity: ExternalEntity.VENDOR, localKey: p.supplier_id, name: p.supplier } },
          PayType: 'Check',
          CheckPayment: { BankAccountRef: this.ref(bank) },
          TotalAmt: amount,
          TxnDate: p.paid_on,
          DocNumber: p.number.slice(0, 21),
          PrivateNote: `${p.method} ${p.reference}`,
          Line: p.lines.map((l) => ({ Amount: Number(l.amount), LinkedTxn: [{ TxnId: { $posting: `BILL|${l.invoice_id}` }, TxnType: 'Bill' }] })),
        },
        missing,
      };
    });
  }

  private async buildVendorCredits(m: EntityManager, mp: Awaited<ReturnType<AccountingService['mapper']>>, from: string, to: string, ids?: string[]): Promise<Built[]> {
    const rows: { id: string; number: string; credit_note_no: string; date: string; amount: string; supplier_id: string; supplier: string; store_code: string }[] = await m.query(
      `SELECT r.id, r.number, r.credit_note_no, to_char(COALESCE(r.credit_note_date, r.return_date), 'YYYY-MM-DD') AS date, COALESCE(r.credit_note_amount, r.total_value) AS amount, r.supplier_id, s.name AS supplier, st.code AS store_code
         FROM return_to_supplier r JOIN supplier s ON s.id = r.supplier_id JOIN store st ON st.id = r.store_id
        WHERE r.status = 'CREDITED' AND ${ids ? `r.id = ANY($1::uuid[])` : `COALESCE(r.credit_note_date, r.return_date) BETWEEN $1::date AND $2::date`}`,
      ids ? [ids] : [from, to],
    );
    return rows.map((r) => {
      const missing: string[] = [];
      const grni = mp.get(AccountMappingKind.SYSTEM, 'GRNI', missing);
      const ap = mp.get(AccountMappingKind.SYSTEM, 'AP', missing);
      const cls = mp.optional(AccountMappingKind.STORE_CLASS, r.store_code);
      const amount = Number(r.amount);
      return {
        docType: PostingDocType.VENDOR_CREDIT,
        localDocType: 'SUPPLIER_RETURN',
        localDocId: r.id,
        localDocNo: r.number,
        txnDate: r.date,
        amount,
        entries: [{ account: ap, amount }, { account: grni, amount: -amount, classId: cls }],
        payload: {
          VendorRef: { $ref: { entity: ExternalEntity.VENDOR, localKey: r.supplier_id, name: r.supplier } },
          TxnDate: r.date,
          DocNumber: (r.credit_note_no ?? r.number).slice(0, 21),
          PrivateNote: `Return ${r.number}`,
          Line: [{ DetailType: 'AccountBasedExpenseLineDetail', Amount: amount, Description: `Return to supplier ${r.number}`, AccountBasedExpenseLineDetail: { AccountRef: this.ref(grni), ClassRef: this.ref(cls) } }],
        },
        missing,
      };
    });
  }

  /** locale.timezone as an SQL literal (days are local days). */
  private async zone(m: EntityManager): Promise<string> {
    const tz = await this.settings.get('locale.timezone', m);
    if (!/^[A-Za-z0-9_+\/-]+$/.test(tz)) throw new BadRequestException(`Invalid locale.timezone ${tz}`);
    return `'${tz}'`;
  }

  /** The QuickBooks customer for a sale: its payer, the till customer, else walk-in. */
  private async customerOf(m: EntityManager, inv: { payer_id: string | null; payer: string | null; pos_customer_id: string | null; pos_customer: string | null }): Promise<MasterRef> {
    if (inv.payer_id) return { $ref: { entity: ExternalEntity.CUSTOMER, localKey: `payer:${inv.payer_id}`, name: inv.payer! } };
    if (inv.pos_customer_id) return { $ref: { entity: ExternalEntity.CUSTOMER, localKey: `customer:${inv.pos_customer_id}`, name: inv.pos_customer! } };
    return { $ref: { entity: ExternalEntity.CUSTOMER, localKey: 'walk-in', name: await this.settings.get('accounting.walkInCustomer', m) } };
  }

  /**
   * Sales documents. An invoice paid in one non-credit mode is a SalesReceipt;
   * otherwise an Invoice to the customer plus a Payment per amount paid now.
   * Credit notes are RefundReceipts (money paid back) or CreditMemos (on account).
   */
  private async buildSales(m: EntityManager, mp: Awaited<ReturnType<AccountingService['mapper']>>, from: string, to: string, ids?: string[]): Promise<Built[]> {
    const syncItems = await this.settings.get('accounting.syncItems', m);
    const tz = await this.zone(m);
    const invs: {
      id: string; number: string; doc_type: string; original_invoice_id: string | null; date: string; total: string; total_tax: string; store_code: string; cu_invoice_no: string | null;
      payer_id: string | null; payer: string | null; pos_customer_id: string | null; pos_customer: string | null;
    }[] = await m.query(
      `SELECT si.id, si.number, si.doc_type, si.original_invoice_id, to_char(si.issued_at AT TIME ZONE ${tz}, 'YYYY-MM-DD') AS date, si.total_amount AS total, si.total_tax,
              st.code AS store_code, si.cu_invoice_no, COALESCE(si.payer_id, o.payer_id) AS payer_id, p.name AS payer, c.id AS pos_customer_id, c.name AS pos_customer
         FROM sales_invoice si JOIN store st ON st.id = si.store_id
         LEFT JOIN sales_invoice o ON o.id = si.original_invoice_id
         LEFT JOIN payer p ON p.id = COALESCE(si.payer_id, o.payer_id)
         LEFT JOIN pos_sale ps ON ps.invoice_id = COALESCE(si.original_invoice_id, si.id)
         LEFT JOIN customer c ON c.id = ps.customer_id
        WHERE si.status = 'ISSUED' AND ${ids ? `si.id = ANY($1::uuid[])` : `(si.issued_at AT TIME ZONE ${tz})::date BETWEEN $1::date AND $2::date`}
        ORDER BY si.issued_at`,
      ids ? [ids] : [from, to],
    );
    if (!invs.length) return [];
    const allLines: { invoice_id: string; item_id: string; code: string; name: string; category_id: string; category_code: string; tax_code: string; quantity: string; gross_amount: string; tax_amount: string; net_amount: string; line_no: number }[] = await m.query(
      `SELECT l.invoice_id, l.item_id, it.code, l.description AS name, it.category_id, cat.code AS category_code, tc.code AS tax_code, l.quantity, l.gross_amount, l.tax_amount, l.net_amount, l.line_no
         FROM sales_invoice_line l JOIN item it ON it.id = l.item_id JOIN item_category cat ON cat.id = it.category_id JOIN tax_category tc ON tc.id = l.tax_category_id
        WHERE l.invoice_id = ANY($1::uuid[]) ORDER BY l.line_no`,
      [invs.map((i) => i.id)],
    );
    const allPays: { id: string; invoice_id: string; mode_code: string; amount: string; is_credit: boolean }[] = await m.query(
      `SELECT sp.id, sp.invoice_id, sp.mode_code, sp.amount, COALESCE(pm.is_credit, false) AS is_credit FROM sales_payment sp LEFT JOIN payment_mode pm ON pm.code = sp.mode_code WHERE sp.invoice_id = ANY($1::uuid[])`,
      [invs.map((i) => i.id)],
    );
    const out: Built[] = [];
    for (const inv of invs) {
      const missing: string[] = [];
      const credit = inv.doc_type === 'CREDIT_NOTE';
      const lines = allLines.filter((l) => l.invoice_id === inv.id);
      const pays = allPays.filter((p) => p.invoice_id === inv.id);
      const cls = mp.optional(AccountMappingKind.STORE_CLASS, inv.store_code);
      const tax = Number(inv.total_tax);
      const total = Number(inv.total);
      const vatOut = tax ? mp.get(AccountMappingKind.SYSTEM, 'VAT_OUTPUT', missing) : null;
      const qLines = lines.map((l) => {
        const income = mp.category(AccountMappingKind.CATEGORY_INCOME, l.category_id, missing);
        const item = syncItems
          ? { entity: ExternalEntity.ITEM, localKey: `item:${l.item_id}`, name: `${l.code} ${l.name}`.slice(0, 100), itemId: l.item_id, categoryId: l.category_id }
          : { entity: ExternalEntity.ITEM, localKey: `category:${l.category_id}`, name: `Sales - ${l.category_code}`, categoryId: l.category_id };
        return {
          line: { DetailType: 'SalesItemLineDetail', Amount: Number(l.gross_amount), Description: l.name, SalesItemLineDetail: { ItemRef: { $ref: item }, Qty: Number(l.quantity), ClassRef: this.ref(cls), TaxCodeRef: this.ref(mp.get(AccountMappingKind.TAX_CODE, l.tax_code, missing, `tax category ${l.tax_code}`)) } },
          income,
          net: Number(l.net_amount),
        };
      });
      const revenue = [...qLines.map((x) => ({ account: x.income, amount: -x.net, classId: cls })), ...(vatOut ? [{ account: vatOut, amount: -tax }] : [])];
      const customer = await this.customerOf(m, inv);
      const body = {
        CustomerRef: customer,
        TxnDate: inv.date,
        DocNumber: inv.number.slice(0, 21),
        PrivateNote: `${inv.number}${inv.cu_invoice_no ? ` · eTIMS ${inv.cu_invoice_no}` : ''}`,
        GlobalTaxCalculation: 'TaxInclusive',
        Line: qLines.map((x) => x.line),
        ...(tax ? { TxnTaxDetail: { TotalTax: tax } } : {}),
      };
      const base = { localDocId: inv.id, localDocNo: inv.number, txnDate: inv.date, amount: total };
      const flip = (es: { account: string; amount: number; classId?: string | null }[]) => es.map((e) => ({ ...e, amount: -e.amount }));
      if (credit) {
        const main = [...pays].sort((a, b) => Number(b.amount) - Number(a.amount))[0];
        if (main && !main.is_credit) {
          const acct = mp.get(AccountMappingKind.PAYMENT_ACCOUNT, main.mode_code, missing, `payment mode ${main.mode_code}`);
          out.push({ ...base, docType: PostingDocType.REFUND_RECEIPT, localDocType: 'CREDIT_NOTE', entries: [...flip(revenue), { account: acct, amount: -total }], payload: { ...body, DepositToAccountRef: this.ref(acct) }, missing });
        } else {
          const ar = mp.get(AccountMappingKind.SYSTEM, 'AR', missing);
          out.push({ ...base, docType: PostingDocType.CREDIT_MEMO, localDocType: 'CREDIT_NOTE', entries: [...flip(revenue), { account: ar, amount: -total }], payload: body, missing });
        }
        continue;
      }
      const single = pays.length === 1 && !pays[0].is_credit && Math.abs(Number(pays[0].amount) - total) < 0.005;
      if (single) {
        const acct = mp.get(AccountMappingKind.PAYMENT_ACCOUNT, pays[0].mode_code, missing, `payment mode ${pays[0].mode_code}`);
        out.push({ ...base, docType: PostingDocType.SALES_RECEIPT, localDocType: 'SALES_INVOICE', entries: [{ account: acct, amount: total }, ...revenue], payload: { ...body, DepositToAccountRef: this.ref(acct) }, missing });
        continue;
      }
      const ar = mp.get(AccountMappingKind.SYSTEM, 'AR', missing);
      out.push({ ...base, docType: PostingDocType.INVOICE, localDocType: 'SALES_INVOICE', entries: [{ account: ar, amount: total }, ...revenue], payload: body, missing });
      for (const p of pays.filter((x) => !x.is_credit)) {
        const pm: string[] = [];
        const acct = mp.get(AccountMappingKind.PAYMENT_ACCOUNT, p.mode_code, pm, `payment mode ${p.mode_code}`);
        const arP = mp.get(AccountMappingKind.SYSTEM, 'AR', pm);
        const amount = Number(p.amount);
        out.push({
          docType: PostingDocType.PAYMENT,
          localDocType: 'SALES_PAYMENT',
          localDocId: p.id,
          localDocNo: `${inv.number} ${p.mode_code}`.slice(0, 60),
          txnDate: inv.date,
          amount,
          entries: [{ account: acct, amount }, { account: arP, amount: -amount }],
          payload: { CustomerRef: customer, TotalAmt: amount, TxnDate: inv.date, DepositToAccountRef: this.ref(acct), PrivateNote: `${p.mode_code} on ${inv.number}`, Line: [{ Amount: amount, LinkedTxn: [{ TxnId: { $posting: `INVOICE|${inv.id}` }, TxnType: 'Invoice' }] }] },
          missing: pm,
        });
      }
    }
    return out;
  }

  /** Insurer / corporate settlements and payments on customer accounts → Payments. */
  private async buildReceipts(m: EntityManager, mp: Awaited<ReturnType<AccountingService['mapper']>>, from: string, to: string, ids?: string[]): Promise<Built[]> {
    const out: Built[] = [];
    const tz = await this.zone(m);
    const sets: { id: string; number: string; payer_id: string; payer: string; received_on: string; amount: string; mode_code: string; reference: string; allocations: { invoiceId: string; amount: number }[] }[] = await m.query(
      `SELECT s.id, s.number, s.payer_id, p.name AS payer, to_char(s.received_on, 'YYYY-MM-DD') AS received_on, s.amount, s.mode_code, s.reference, s.allocations
         FROM payer_settlement s JOIN payer p ON p.id = s.payer_id WHERE ${ids ? `s.id = ANY($1::uuid[])` : `s.received_on BETWEEN $1::date AND $2::date`}`,
      ids ? [ids] : [from, to],
    );
    for (const s of sets) {
      const missing: string[] = [];
      const acct = mp.get(AccountMappingKind.PAYMENT_ACCOUNT, s.mode_code, missing, `payment mode ${s.mode_code}`);
      const ar = mp.get(AccountMappingKind.SYSTEM, 'AR', missing);
      const amount = Number(s.amount);
      out.push({
        docType: PostingDocType.PAYMENT,
        localDocType: 'PAYER_SETTLEMENT',
        localDocId: s.id,
        localDocNo: s.number,
        txnDate: s.received_on,
        amount,
        entries: [{ account: acct, amount }, { account: ar, amount: -amount }],
        payload: {
          CustomerRef: { $ref: { entity: ExternalEntity.CUSTOMER, localKey: `payer:${s.payer_id}`, name: s.payer } },
          TotalAmt: amount,
          TxnDate: s.received_on,
          PaymentRefNum: s.reference.slice(0, 21),
          DepositToAccountRef: this.ref(acct),
          PrivateNote: `Settlement ${s.number}`,
          Line: s.allocations.map((a) => ({ Amount: a.amount, LinkedTxn: [{ TxnId: { $posting: `INVOICE|${a.invoiceId}` }, TxnType: 'Invoice' }] })),
        },
        missing,
      });
    }
    const pays: { id: string; customer_id: string; customer: string; amount: string; mode_code: string | null; reference: string | null; date: string }[] = await m.query(
      `SELECT l.id, l.customer_id, c.name AS customer, -l.amount AS amount, l.mode_code, l.reference, to_char(l.at AT TIME ZONE ${tz}, 'YYYY-MM-DD') AS date
         FROM customer_ledger l JOIN customer c ON c.id = l.customer_id
        WHERE l.type = 'PAYMENT' AND ${ids ? `l.id = ANY($1::uuid[])` : `(l.at AT TIME ZONE ${tz})::date BETWEEN $1::date AND $2::date`}`,
      ids ? [ids] : [from, to],
    );
    for (const p of pays) {
      const missing: string[] = [];
      const mode = p.mode_code ?? 'CASH';
      const acct = mp.get(AccountMappingKind.PAYMENT_ACCOUNT, mode, missing, `payment mode ${mode}`);
      const ar = mp.get(AccountMappingKind.SYSTEM, 'AR', missing);
      const amount = Number(p.amount);
      out.push({
        docType: PostingDocType.PAYMENT,
        localDocType: 'ACCOUNT_PAYMENT',
        localDocId: p.id,
        localDocNo: `${p.customer} ${mode}`.slice(0, 60),
        txnDate: p.date,
        amount,
        entries: [{ account: acct, amount }, { account: ar, amount: -amount }],
        payload: { CustomerRef: { $ref: { entity: ExternalEntity.CUSTOMER, localKey: `customer:${p.customer_id}`, name: p.customer } }, TotalAmt: amount, TxnDate: p.date, DepositToAccountRef: this.ref(acct), PrivateNote: `Payment on account ${p.reference ?? ''}`.trim() },
        missing,
      });
    }
    return out;
  }

  /** Periods (days or months) fully inside [from, to], ended before today, from journalsFrom. */
  private async periods(m: EntityManager, from: string, to: string, journalsFrom: string | null): Promise<{ key: string; start: string; end: string }[]> {
    const freq = await this.settings.get('accounting.journalFrequency', m);
    const today = await this.settings.today(m);
    const start = journalsFrom && journalsFrom > from ? journalsFrom : from;
    const rows: { key: string; start: string; end: string }[] = await m.query(
      freq === 'DAILY'
        ? `SELECT to_char(d, 'YYYY-MM-DD') AS key, to_char(d, 'YYYY-MM-DD') AS start, to_char(d, 'YYYY-MM-DD') AS end FROM generate_series($1::date, $2::date, '1 day') d WHERE d < $3::date`
        : `SELECT to_char(d, 'YYYY-MM') AS key, to_char(d, 'YYYY-MM-DD') AS start, to_char(d + interval '1 month' - interval '1 day', 'YYYY-MM-DD') AS end
             FROM generate_series(date_trunc('month', $1::date), $2::date, '1 month') d WHERE d + interval '1 month' - interval '1 day' < $3::date`,
      [start, to, today],
    );
    // A month only partly after journalsFrom starts at journalsFrom.
    return rows.map((p) => ({ ...p, start: p.start < start ? start : p.start }));
  }

  /**
   * Inventory journal for a period, from the stock ledger: every value change
   * is posted against its counter-account — receipts and supplier returns to
   * GRNI, dispenses / sales to cost of sales, issues to departmental
   * consumption (department class), adjustments to write-off or adjustment,
   * transfers through stock in transit, opening stock to equity — so the
   * QuickBooks inventory accounts follow the local valuation.
   */
  private async buildJournal(m: EntityManager, mp: Awaited<ReturnType<AccountingService['mapper']>>, p: { key: string; start: string; end: string }): Promise<Built | null> {
    const rows: { txn_type: string; reason_code: string | null; store_code: string; dept_code: string | null; category_id: string; value: string }[] = await m.query(
      `SELECT t.txn_type, t.reason_code, s.code AS store_code, d.code AS dept_code, i.category_id, SUM(t.value_delta)::numeric(18,2) AS value
         FROM stock_transaction t JOIN item i ON i.id = t.item_id JOIN store s ON s.id = t.store_id LEFT JOIN department d ON d.id = t.department_id
        WHERE t.effective_date BETWEEN $1::date AND $2::date
        GROUP BY 1, 2, 3, 4, 5 HAVING SUM(t.value_delta) <> 0`,
      [p.start, p.end],
    );
    if (!rows.length) return null;
    const missing: string[] = [];
    const lines = new Map<string, { account: string; classId: string | null; amount: number; label: string }>();
    const add = (account: string, classId: string | null, amount: number, label: string) => {
      const k = `${account}|${classId ?? ''}|${label}`;
      const cur = lines.get(k) ?? { account, classId, amount: 0, label };
      cur.amount = round2(cur.amount + amount);
      lines.set(k, cur);
    };
    for (const r of rows) {
      const v = Number(r.value);
      const storeCls = mp.optional(AccountMappingKind.STORE_CLASS, r.store_code);
      add(mp.category(AccountMappingKind.CATEGORY_INVENTORY, r.category_id, missing), storeCls, v, 'Inventory');
      const t = r.txn_type;
      let contra: string;
      let cls: string | null = storeCls;
      let label: string;
      if (t === 'OPENING') [contra, label] = [mp.get(AccountMappingKind.SYSTEM, 'OPENING_BALANCE', missing), 'Opening stock'];
      else if (t === 'RECEIPT' || t === 'SUPPLIER_RETURN') [contra, label] = [mp.get(AccountMappingKind.SYSTEM, 'GRNI', missing), t === 'RECEIPT' ? 'Goods received' : 'Returned to suppliers'];
      else if (t === 'DISPENSE' || t === 'DISPENSE_RETURN') [contra, label] = [mp.category(AccountMappingKind.CATEGORY_COGS, r.category_id, missing), 'Cost of sales'];
      else if (t === 'ISSUE' || t === 'RETURN_IN') {
        contra = mp.category(AccountMappingKind.CATEGORY_CONSUMPTION, r.category_id, missing);
        cls = mp.optional(AccountMappingKind.DEPARTMENT_CLASS, r.dept_code) ?? storeCls;
        label = 'Departmental consumption';
      } else if (t === 'TRANSFER_DISPATCH' || t === 'TRANSFER_RECEIPT') [contra, label] = [mp.get(AccountMappingKind.SYSTEM, 'STOCK_IN_TRANSIT', missing), 'Transfers between stores'];
      else if (WRITE_OFF_REASONS.has(r.reason_code ?? '')) [contra, label] = [mp.get(AccountMappingKind.SYSTEM, 'STOCK_WRITE_OFF', missing), 'Write-offs'];
      else [contra, label] = [mp.get(AccountMappingKind.SYSTEM, 'STOCK_ADJUSTMENT', missing), 'Adjustments and count variances'];
      add(contra, cls, -v, label);
    }
    const entries = [...lines.values()].filter((l) => Math.abs(l.amount) >= 0.005);
    const debits = round2(entries.filter((e) => e.amount > 0).reduce((s, e) => s + e.amount, 0));
    return {
      docType: PostingDocType.JOURNAL,
      localDocType: 'INVENTORY_PERIOD',
      localDocId: p.key,
      localDocNo: `Inventory ${p.key}`,
      txnDate: p.end,
      amount: debits,
      entries: entries.map((e) => ({ account: e.account, amount: e.amount, classId: e.classId })),
      payload: {
        TxnDate: p.end,
        DocNumber: `INV-${p.key}`.slice(0, 21),
        PrivateNote: `Inventory movements ${p.start} to ${p.end} (stock ledger)`,
        Line: entries.map((e) => ({
          DetailType: 'JournalEntryLineDetail',
          Amount: Math.abs(e.amount),
          Description: e.label,
          JournalEntryLineDetail: { PostingType: e.amount > 0 ? 'Debit' : 'Credit', AccountRef: this.ref(e.account), ClassRef: this.ref(e.classId) },
        })),
      },
      missing,
    };
  }

  /** Everything that would be posted for [from, to] (nothing is written). */
  private async build(m: EntityManager, from: string, to: string, kinds: string[]): Promise<Built[]> {
    const c = await this.conn(m);
    const mp = await this.mapper(m);
    const lo = c?.journalsFrom && c.journalsFrom > from ? c.journalsFrom : from;
    const want = (k: string) => !kinds.length || kinds.includes(k);
    const out: Built[] = [];
    if (want('PURCHASES')) out.push(...(await this.buildBills(m, mp, lo, to)), ...(await this.buildVendorCredits(m, mp, lo, to)), ...(await this.buildBillPayments(m, mp, lo, to)));
    if (want('SALES')) out.push(...(await this.buildSales(m, mp, lo, to)), ...(await this.buildReceipts(m, mp, lo, to)));
    if (want('INVENTORY')) for (const p of await this.periods(m, from, to, c?.journalsFrom ?? null)) {
      const j = await this.buildJournal(m, mp, p);
      if (j) out.push(j);
    }
    return out;
  }

  /** Rebuilds one document from its source (after a mapping was fixed). */
  private async rebuild(m: EntityManager, p: AccountingPosting): Promise<Built | null> {
    const mp = await this.mapper(m);
    const ids = [p.localDocId];
    const far = ['1900-01-01', '2999-12-31'] as const;
    const pick = (bs: Built[]) => bs.find((b) => b.docType === p.docType && b.localDocId === p.localDocId) ?? null;
    switch (p.localDocType) {
      case 'SUPPLIER_INVOICE':
        return pick(await this.buildBills(m, mp, ...far, ids));
      case 'PAYMENT_VOUCHER':
        return pick(await this.buildBillPayments(m, mp, ...far, ids));
      case 'SUPPLIER_RETURN':
        return pick(await this.buildVendorCredits(m, mp, ...far, ids));
      case 'SALES_INVOICE':
      case 'CREDIT_NOTE':
        return pick(await this.buildSales(m, mp, ...far, ids));
      case 'SALES_PAYMENT': {
        const [row] = await m.query(`SELECT invoice_id FROM sales_payment WHERE id = $1`, [p.localDocId]);
        return row ? pick(await this.buildSales(m, mp, ...far, [row.invoice_id])) : null;
      }
      case 'PAYER_SETTLEMENT':
      case 'ACCOUNT_PAYMENT':
        return pick(await this.buildReceipts(m, mp, ...far, ids));
      case 'INVENTORY_PERIOD': {
        const freq = p.localDocId.length === 10 ? 'DAILY' : 'MONTHLY';
        const start = freq === 'DAILY' ? p.localDocId : `${p.localDocId}-01`;
        const c = await this.conn(m);
        return this.buildJournal(m, mp, { key: p.localDocId, start: c?.journalsFrom && c.journalsFrom > start ? c.journalsFrom : start, end: p.txnDate });
      }
    }
    return null;
  }

  private blockedReason(b: Built, closingDate: string | null): string | null {
    if (b.missing.length) return `Map: ${[...new Set(b.missing)].join('; ')}`;
    if (closingDate && b.txnDate <= closingDate) return `Period closed: the books are closed up to ${closingDate}`;
    return null;
  }

  // ------------------------------------------------------------------ batches

  /**
   * Preview: what is not yet in QuickBooks for the period, validated
   * (mappings, closed period). READY documents are posted with the batch;
   * BLOCKED ones say what to fix. Documents already posted are left out.
   */
  async preview(dto: PreviewDto, actor: SessionUser) {
    const c = await this.conn();
    if (!c) throw new ConflictException('Configure QuickBooks first');
    if (dto.to < dto.from) throw new BadRequestException('The period ends before it starts');
    const batchId = await this.ds.transaction(async (m) => {
      const built = await this.build(m, dto.from, dto.to, dto.kinds ?? []);
      const batch = await m.save(m.create(AccountingBatch, { number: await this.numbering.next(DocumentType.ACCOUNTING_BATCH, { manager: m }), fromDate: dto.from, toDate: dto.to, kinds: (dto.kinds ?? ['ALL']).join(','), status: 'PREVIEW', createdBy: actor.id }));
      for (const b of built) {
        const existing = await m.findOneBy(AccountingPosting, { docType: b.docType, localDocId: b.localDocId });
        if (existing && (existing.status === PostingStatus.POSTED || existing.status === PostingStatus.PENDING)) continue;
        const reason = this.blockedReason(b, c.closingDate);
        const row = existing ?? m.create(AccountingPosting, { docType: b.docType, localDocId: b.localDocId });
        Object.assign(row, {
          localDocType: b.localDocType,
          localDocNo: b.localDocNo,
          txnDate: b.txnDate,
          amount: b.amount,
          entries: b.entries,
          payload: b.payload,
          status: reason ? PostingStatus.BLOCKED : PostingStatus.READY,
          error: reason,
          batchId: batch.id,
          nextAttemptAt: new Date(),
        });
        await m.save(row);
      }
      return batch.id;
    });
    return this.batch(batchId);
  }

  async batch(id: string) {
    const b = await this.ds.getRepository(AccountingBatch).findOneBy({ id });
    if (!b) throw new NotFoundException('Batch not found');
    const items = await this.ds.getRepository(AccountingPosting).find({ where: { batchId: id }, order: { txnDate: 'ASC', createdAt: 'ASC' } });
    items.sort((x, y) => ORDER.indexOf(x.docType) - ORDER.indexOf(y.docType) || x.txnDate.localeCompare(y.txnDate));
    const summary = ORDER.map((t) => {
      const rows = items.filter((i) => i.docType === t);
      return { docType: t, count: rows.length, amount: round2(rows.reduce((s, r) => s + r.amount, 0)), ready: rows.filter((r) => r.status === PostingStatus.READY).length, blocked: rows.filter((r) => r.status === PostingStatus.BLOCKED).length, posted: rows.filter((r) => r.status === PostingStatus.POSTED).length };
    }).filter((s) => s.count);
    return { ...b, summary, items };
  }

  batches() {
    return this.ds.getRepository(AccountingBatch).find({ order: { createdAt: 'DESC' }, take: 100 });
  }

  /** Posts the batch's READY documents in dependency order (bills before their payments, invoices before payments). */
  async post(id: string, actor: SessionUser) {
    const b = await this.ds.getRepository(AccountingBatch).findOneBy({ id });
    if (!b) throw new NotFoundException('Batch not found');
    const rows = await this.ds.getRepository(AccountingPosting).find({ where: { batchId: id, status: In([PostingStatus.READY, PostingStatus.PENDING]) } });
    rows.sort((x, y) => ORDER.indexOf(x.docType) - ORDER.indexOf(y.docType) || x.txnDate.localeCompare(y.txnDate));
    await this.ds.getRepository(AccountingBatch).update(id, { status: 'POSTING' });
    const totals = { posted: 0, failed: 0, retry: 0 };
    for (const r of rows) {
      const res = await this.send(r.id, actor.id);
      if (res === 'POSTED') totals.posted++;
      else if (res === 'FAILED') totals.failed++;
      else totals.retry++;
    }
    await this.ds.getRepository(AccountingBatch).update(id, { status: 'POSTED', postedAt: new Date() });
    return { ...(await this.batch(id)), totals };
  }

  /** Resolves {$ref} (creating vendors, customers, products in QuickBooks once) and {$posting} placeholders. */
  private async resolve(value: unknown): Promise<unknown> {
    if (Array.isArray(value)) {
      // One at a time: two lines may need the same vendor / product created.
      const out: unknown[] = [];
      for (const v of value) out.push(await this.resolve(v));
      return out;
    }
    if (!value || typeof value !== 'object') return value;
    const o = value as Record<string, unknown>;
    if (o.$ref) {
      const r = (o as MasterRef).$ref;
      return { value: await this.master(r), name: r.name };
    }
    if (typeof o.$posting === 'string') {
      const [docType, localDocId] = (o.$posting as string).split('|');
      const dep = await this.ds.getRepository(AccountingPosting).findOneBy({ docType: docType as PostingDocType, localDocId });
      if (!dep?.externalId) throw new QboError(`Waiting for ${docType.toLowerCase().replace('_', ' ')} ${dep?.localDocNo ?? localDocId} to be posted first`, true);
      return dep.externalId;
    }
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(o)) out[k] = await this.resolve(v);
    return out;
  }

  /** A vendor / customer / product in QuickBooks for a local record (found by name, else created). */
  private async master(r: MasterRef['$ref']): Promise<string> {
    const repo = this.ds.getRepository(ExternalRef);
    const known = await repo.findOneBy({ entity: r.entity, localKey: r.localKey });
    if (known) return known.externalId;
    const type = r.entity === ExternalEntity.VENDOR ? 'Vendor' : r.entity === ExternalEntity.CUSTOMER ? 'Customer' : 'Item';
    const nameField = type === 'Item' ? 'Name' : 'DisplayName';
    const found = await this.query<{ Id: string }>(type, [nameField, r.name]);
    let id = found[0]?.Id;
    if (!id) {
      let body: Record<string, unknown> = { DisplayName: r.name };
      if (type === 'Vendor') {
        const [s] = await this.ds.query(`SELECT kra_pin, email, phone FROM supplier WHERE id = $1`, [r.localKey]);
        body = { DisplayName: r.name, CompanyName: r.name, ...(s?.email ? { PrimaryEmailAddr: { Address: s.email } } : {}), ...(s?.phone ? { PrimaryPhone: { FreeFormNumber: s.phone } } : {}), ...(s?.kra_pin ? { TaxIdentifier: s.kra_pin } : {}) };
      } else if (type === 'Item') {
        const mp = await this.mapper(this.ds.manager);
        const missing: string[] = [];
        const income = mp.category(AccountMappingKind.CATEGORY_INCOME, r.categoryId!, missing);
        if (missing.length) throw new QboError(`Map: ${missing.join('; ')}`);
        body = { Name: r.name.slice(0, 100), Type: 'NonInventory', IncomeAccountRef: { value: income } };
      }
      const res = await this.api('POST', type.toLowerCase(), body);
      id = String((res[type] as { Id: string }).Id);
    }
    await repo.upsert({ entity: r.entity, localKey: r.localKey, externalId: id, displayName: r.name, syncedAt: new Date() }, ['entity', 'localKey']);
    return id;
  }

  /** Sends one posting (row claimed first). Never sends a posted document again. */
  async send(id: string, actorId: string | null = null): Promise<'POSTED' | 'FAILED' | 'RETRY' | 'SKIPPED'> {
    const [claimed]: [{ id: string }[], number] = await this.ds.query(
      `UPDATE accounting_posting SET attempts = attempts + 1, next_attempt_at = now() + interval '10 minutes'
        WHERE id = $1 AND status IN ('READY', 'PENDING') RETURNING id`,
      [id],
    );
    if (!claimed.length) return 'SKIPPED';
    const repo = this.ds.getRepository(AccountingPosting);
    const p = await repo.findOneByOrFail({ id });
    const c = await this.conn();
    try {
      if (c?.closingDate && p.txnDate <= c.closingDate) throw new QboError(`Period closed: the books are closed up to ${c.closingDate}`);
      const body = (await this.resolve(p.payload)) as Record<string, unknown>;
      // The posting id is QuickBooks' requestid: a retried request is not duplicated there.
      const res = await this.api('POST', ENTITY_PATH[p.docType], body, p.id);
      const entity = Object.values(res).find((v) => v && typeof v === 'object' && 'Id' in (v as object)) as { Id: string } | undefined;
      await repo.update(id, { status: PostingStatus.POSTED, externalId: entity?.Id ?? null, response: res as never, error: null, postedAt: new Date(), postedBy: actorId });
      return 'POSTED';
    } catch (e) {
      const err = e as QboError;
      const max = await this.settings.get('accounting.maxAttempts');
      if (err.retryable && p.attempts < max) {
        const base = await this.settings.get('accounting.retryBaseSeconds');
        await repo.update(id, { status: PostingStatus.PENDING, error: err.message.slice(0, 1000), nextAttemptAt: new Date(Date.now() + Math.min(base * 2 ** Math.max(p.attempts - 1, 0), 3600) * 1000) });
        return 'RETRY';
      }
      await repo.update(id, { status: PostingStatus.FAILED, error: err.message.slice(0, 1000) });
      return 'FAILED';
    }
  }

  /** Job accounting.dispatch: postings waiting to be retried. */
  async dispatch(limit = 100) {
    const due: { id: string; doc_type: PostingDocType }[] = await this.ds.query(
      `SELECT id, doc_type FROM accounting_posting WHERE status = 'PENDING' AND next_attempt_at <= now() ORDER BY created_at LIMIT $1`,
      [limit],
    );
    due.sort((x, y) => ORDER.indexOf(x.doc_type) - ORDER.indexOf(y.doc_type));
    const totals = { posted: 0, failed: 0, retry: 0 };
    for (const d of due) {
      const r = await this.send(d.id);
      if (r === 'POSTED') totals.posted++;
      else if (r === 'FAILED') totals.failed++;
      else if (r === 'RETRY') totals.retry++;
    }
    return totals;
  }

  /** A failed or blocked document is rebuilt from its source (fixed mappings) and sent again. */
  async reprocess(id: string, actor: SessionUser) {
    const p = await this.ds.getRepository(AccountingPosting).findOneBy({ id });
    if (!p) throw new NotFoundException('Posting not found');
    if (p.status === PostingStatus.POSTED) throw new ConflictException('Already posted to QuickBooks');
    const c = await this.conn();
    const b = await this.rebuild(this.ds.manager, p);
    if (!b) throw new ConflictException('The source document no longer qualifies for posting');
    const reason = this.blockedReason(b, c?.closingDate ?? null);
    await this.ds.getRepository(AccountingPosting).update(id, { payload: b.payload as never, entries: b.entries as never, amount: b.amount, txnDate: b.txnDate, status: reason ? PostingStatus.BLOCKED : PostingStatus.READY, error: reason, attempts: 0 });
    if (!reason) await this.send(id, actor.id);
    return this.ds.getRepository(AccountingPosting).findOneByOrFail({ id });
  }

  async postings(q: PostingQueryDto) {
    const qb = this.ds.getRepository(AccountingPosting).createQueryBuilder('p').orderBy('p.txnDate', 'DESC').addOrderBy('p.createdAt', 'DESC');
    if (q.status) qb.andWhere('p.status = :s', { s: q.status });
    if (q.docType) qb.andWhere('p.doc_type = :t', { t: q.docType });
    if (q.from) qb.andWhere('p.txn_date >= :f', { f: q.from });
    if (q.to) qb.andWhere('p.txn_date <= :to', { to: q.to });
    if (q.search) qb.andWhere('(p.local_doc_no ILIKE :q OR p.external_id = :e OR p.error ILIKE :q)', { q: `%${q.search}%`, e: q.search });
    const [items, total] = await qb
      .skip((q.page - 1) * q.pageSize)
      .take(q.pageSize)
      .getManyAndCount();
    return { items, total, page: q.page, pageSize: q.pageSize };
  }

  async posting(id: string) {
    const p = await this.ds.getRepository(AccountingPosting).findOneBy({ id });
    if (!p) throw new NotFoundException('Posting not found');
    return p;
  }

  externalRefs() {
    return this.ds.getRepository(ExternalRef).find({ order: { entity: 'ASC', displayName: 'ASC' } });
  }

  // ------------------------------------------------------------------ reconciliation

  /**
   * Per account, for [from, to]: what the local documents amount to, what was
   * posted, and the movement in QuickBooks (TrialBalance at `to` less at the
   * day before `from`). Posted and QuickBooks agree unless something was
   * changed in QuickBooks; the rest is what is still to post. Also the stock
   * valuation here against the QuickBooks inventory accounts at `to`.
   */
  async reconciliation(from: string, to: string) {
    const c = await this.conn();
    if (!c?.realmId) throw new ConflictException('QuickBooks is not connected');
    const built = await this.build(this.ds.manager, from, to, []);
    const posted = await this.ds.getRepository(AccountingPosting).createQueryBuilder('p').where('p.status = :s AND p.txn_date BETWEEN :f AND :t', { s: PostingStatus.POSTED, f: from, t: to }).getMany();
    const sum = (rows: { entries: { account: string; amount: number }[] }[]) => {
      const m = new Map<string, number>();
      for (const r of rows) for (const e of r.entries) if (e.account) m.set(e.account, round2((m.get(e.account) ?? 0) + e.amount));
      return m;
    };
    const local = sum(built);
    const postedTotals = sum(posted);
    const dayBefore = new Date(new Date(`${from}T00:00:00Z`).getTime() - 86_400_000).toISOString().slice(0, 10);
    const [tbTo, tbFrom] = await Promise.all([
      this.api('GET', `reports/TrialBalance?end_date=${to}&accounting_method=Accrual`).then(readTrialBalance),
      this.api('GET', `reports/TrialBalance?end_date=${dayBefore}&accounting_method=Accrual`).then(readTrialBalance),
    ]);
    const names = new Map((await this.query<{ Id: string; Name: string }>('Account')).map((a) => [String(a.Id), a.Name]));
    const accounts = new Set([...local.keys(), ...postedTotals.keys()]);
    const rows = [...accounts].map((a) => {
      const qbo = round2((tbTo.get(a) ?? 0) - (tbFrom.get(a) ?? 0));
      return { account: a, name: names.get(a) ?? a, local: local.get(a) ?? 0, posted: postedTotals.get(a) ?? 0, quickbooks: qbo, difference: round2((postedTotals.get(a) ?? 0) - qbo), toPost: round2((local.get(a) ?? 0) - (postedTotals.get(a) ?? 0)) };
    });
    rows.sort((x, y) => x.name.localeCompare(y.name));
    const statuses: { doc_type: string; status: string; n: number; amount: number }[] = await this.ds.query(
      `SELECT doc_type, status, count(*)::int AS n, SUM(amount)::float AS amount FROM accounting_posting WHERE txn_date BETWEEN $1 AND $2 GROUP BY 1, 2 ORDER BY 1, 2`,
      [from, to],
    );
    const unposted = built.filter((b) => !posted.some((p) => p.docType === b.docType && p.localDocId === b.localDocId));
    // Stock on hand (value change since journalsFrom) against the mapped inventory accounts; stock in transit is in its own account.
    const invAccounts: { external_id: string }[] = await this.ds.query(`SELECT DISTINCT external_id FROM account_mapping WHERE kind = 'CATEGORY_INVENTORY'`);
    const [{ value }] = await this.ds.query(`SELECT COALESCE(SUM(value_delta), 0)::float AS value FROM stock_transaction WHERE effective_date <= $1 AND ($2::date IS NULL OR effective_date >= $2::date)`, [to, c.journalsFrom]);
    const qboInventory = round2(invAccounts.reduce((s, a) => s + (tbTo.get(a.external_id) ?? 0), 0));
    return {
      from,
      to,
      accounts: rows,
      balanced: rows.every((r) => Math.abs(r.difference) < 0.01),
      postings: statuses,
      unposted: { count: unposted.length, byType: ORDER.map((t) => ({ docType: t, count: unposted.filter((u) => u.docType === t).length })).filter((x) => x.count) },
      inventory: { local: round2(value), quickbooks: qboInventory, difference: round2(value - qboInventory), since: c.journalsFrom },
    };
  }

  // ------------------------------------------------------------------ payer settlements

  /** Insurer / corporate money received against its invoices (each invoice's payer share, at most what is still owed). */
  async settle(dto: SettlementDto, actor: SessionUser) {
    const id = await this.ds.transaction(async (m) => {
      const [payer] = await m.query(`SELECT id, name FROM payer WHERE id = $1`, [dto.payerId]);
      if (!payer) throw new BadRequestException('Payer not found');
      const total = round2(dto.allocations.reduce((s, a) => s + a.amount, 0));
      if (Math.abs(total - dto.amount) > 0.005) throw new BadRequestException(`The allocations add up to ${total}, not ${dto.amount}`);
      for (const a of dto.allocations) {
        const [inv] = await m.query(
          `SELECT si.number, si.payer_id, si.payer_amount::float AS due,
                  COALESCE((SELECT SUM((x->>'amount')::numeric) FROM payer_settlement ps, jsonb_array_elements(ps.allocations) x WHERE x->>'invoiceId' = si.id::text), 0)::float AS settled
             FROM sales_invoice si WHERE si.id = $1 AND si.doc_type = 'INVOICE'`,
          [a.invoiceId],
        );
        if (!inv || inv.payer_id !== dto.payerId) throw new BadRequestException('An invoice is not one of this payer’s');
        if (a.amount > round2(inv.due - inv.settled) + 0.005) throw new BadRequestException(`${inv.number}: only ${round2(inv.due - inv.settled)} is still owed by the payer`);
      }
      const s = await m.save(
        m.create(PayerSettlement, {
          number: await this.numbering.next(DocumentType.PAYER_SETTLEMENT, { manager: m }),
          payerId: dto.payerId,
          receivedOn: dto.receivedOn,
          amount: dto.amount,
          modeCode: dto.modeCode,
          reference: dto.reference,
          allocations: dto.allocations,
          notes: dto.notes ?? null,
          createdBy: actor.id,
        }),
      );
      return s.id;
    });
    return this.ds.getRepository(PayerSettlement).findOneByOrFail({ id });
  }

  /** Invoices with a payer share still owed (for allocating a settlement). */
  outstanding(payerId: string) {
    return this.ds.query(
      `SELECT si.id, si.number, to_char(si.issued_at, 'YYYY-MM-DD') AS date, si.customer_name AS patient, si.payer_amount::float AS "payerAmount",
              (si.payer_amount - COALESCE((SELECT SUM((x->>'amount')::numeric) FROM payer_settlement ps, jsonb_array_elements(ps.allocations) x WHERE x->>'invoiceId' = si.id::text), 0))::float AS owed
         FROM sales_invoice si WHERE si.payer_id = $1 AND si.doc_type = 'INVOICE' AND si.status = 'ISSUED' AND si.payer_amount > 0
        ORDER BY si.issued_at`,
      [payerId],
    ).then((rows: { owed: number }[]) => rows.filter((r) => r.owed > 0.005));
  }

  settlements() {
    return this.ds.query(
      `SELECT s.id, s.number, s.received_on AS "receivedOn", s.amount::float, s.mode_code AS "modeCode", s.reference, p.name AS payer, jsonb_array_length(s.allocations)::int AS invoices
         FROM payer_settlement s JOIN payer p ON p.id = s.payer_id ORDER BY s.received_on DESC, s.created_at DESC LIMIT 200`,
    );
  }
}
