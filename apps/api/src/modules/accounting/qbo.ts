/**
 * QuickBooks Online behind an AccountingAdapter: OAuth 2.0 (authorise, code
 * exchange, refresh, revoke) and the Accounting API (create with requestid,
 * query, read, preferences, reports). The mock company (MockQbo) answers the
 * same calls in memory with failure injection and keeps a ledger, so the
 * reconciliation can be checked without Intuit. NOT QuickBooks.
 */
import { randomUUID } from 'node:crypto';

export interface QboTokens {
  accessToken: string;
  refreshToken: string;
  /** Seconds. */
  expiresIn: number;
  refreshExpiresIn: number;
}

export interface QboReply {
  status: number;
  body: Record<string, unknown> | null;
  network?: 'offline' | 'timeout';
  error?: string;
}

export interface AccountingAdapter {
  readonly mock: boolean;
  authorizeUrl(p: { clientId: string; redirectUri: string; state: string }): string;
  exchangeCode(p: { code: string; redirectUri: string; clientId: string; clientSecret: string }, timeoutMs: number): Promise<QboTokens>;
  refresh(p: { refreshToken: string; clientId: string; clientSecret: string }, timeoutMs: number): Promise<QboTokens>;
  revoke(p: { token: string; clientId: string; clientSecret: string }, timeoutMs: number): Promise<void>;
  /** path is relative to /v3/company/{realm}/ (e.g. "bill", "query?query=…", "reports/TrialBalance?…"). */
  call(p: { realmId: string; accessToken: string; method: 'GET' | 'POST'; path: string; body?: unknown; requestId?: string }, timeoutMs: number): Promise<QboReply>;
}

export class QboError extends Error {
  constructor(
    message: string,
    readonly retryable = false,
  ) {
    super(message);
  }
}

/** "Fault" → readable text. */
export function faultText(body: Record<string, unknown> | null): string {
  const fault = (body?.Fault as { Error?: { Message?: string; Detail?: string; code?: string }[] } | undefined)?.Error?.[0];
  if (fault) return `${fault.Message ?? 'Error'}${fault.Detail ? `: ${fault.Detail}` : ''}${fault.code ? ` (${fault.code})` : ''}`;
  const e = body?.error_description ?? body?.error;
  return e ? String(e) : 'QuickBooks returned an error';
}

const ENDPOINTS = {
  SANDBOX: 'https://sandbox-quickbooks.api.intuit.com',
  PRODUCTION: 'https://quickbooks.api.intuit.com',
  authorize: 'https://appcenter.intuit.com/connect/oauth2',
  token: 'https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer',
  revoke: 'https://developer.api.intuit.com/v2/oauth2/tokens/revoke',
};
const MINOR_VERSION = 73;

/** Intuit QuickBooks Online (sandbox or production), or a mock container speaking the same API. */
export class QboAdapter implements AccountingAdapter {
  readonly mock = false;
  constructor(private readonly apiBase: string) {}

  static forEnvironment(env: 'SANDBOX' | 'PRODUCTION') {
    return new QboAdapter(ENDPOINTS[env]);
  }

  authorizeUrl(p: { clientId: string; redirectUri: string; state: string }) {
    const q = new URLSearchParams({ client_id: p.clientId, response_type: 'code', scope: 'com.intuit.quickbooks.accounting', redirect_uri: p.redirectUri, state: p.state });
    return `${ENDPOINTS.authorize}?${q}`;
  }

  private async token(form: Record<string, string>, clientId: string, clientSecret: string, timeoutMs: number): Promise<QboTokens> {
    const res = await fetch(ENDPOINTS.token, {
      method: 'POST',
      headers: { authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`, accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(form).toString(),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) throw new QboError(`Intuit token request failed: ${faultText(body)}`, res.status >= 500);
    return { accessToken: String(body.access_token), refreshToken: String(body.refresh_token), expiresIn: Number(body.expires_in ?? 3600), refreshExpiresIn: Number(body.x_refresh_token_expires_in ?? 8_726_400) };
  }

  exchangeCode(p: { code: string; redirectUri: string; clientId: string; clientSecret: string }, timeoutMs: number) {
    return this.token({ grant_type: 'authorization_code', code: p.code, redirect_uri: p.redirectUri }, p.clientId, p.clientSecret, timeoutMs);
  }

  refresh(p: { refreshToken: string; clientId: string; clientSecret: string }, timeoutMs: number) {
    return this.token({ grant_type: 'refresh_token', refresh_token: p.refreshToken }, p.clientId, p.clientSecret, timeoutMs);
  }

  async revoke(p: { token: string; clientId: string; clientSecret: string }, timeoutMs: number) {
    await fetch(ENDPOINTS.revoke, {
      method: 'POST',
      headers: { authorization: `Basic ${Buffer.from(`${p.clientId}:${p.clientSecret}`).toString('base64')}`, accept: 'application/json', 'content-type': 'application/json' },
      body: JSON.stringify({ token: p.token }),
      signal: AbortSignal.timeout(timeoutMs),
    }).catch(() => undefined);
  }

  async call(p: { realmId: string; accessToken: string; method: 'GET' | 'POST'; path: string; body?: unknown; requestId?: string }, timeoutMs: number): Promise<QboReply> {
    const sep = p.path.includes('?') ? '&' : '?';
    const url = `${this.apiBase.replace(/\/+$/, '')}/v3/company/${encodeURIComponent(p.realmId)}/${p.path}${sep}minorversion=${MINOR_VERSION}${p.requestId ? `&requestid=${encodeURIComponent(p.requestId)}` : ''}`;
    try {
      const res = await fetch(url, {
        method: p.method,
        headers: { authorization: `Bearer ${p.accessToken}`, accept: 'application/json', ...(p.body ? { 'content-type': 'application/json' } : {}) },
        body: p.body ? JSON.stringify(p.body) : undefined,
        signal: AbortSignal.timeout(timeoutMs),
      });
      return { status: res.status, body: (await res.json().catch(() => null)) as Record<string, unknown> | null };
    } catch (e) {
      const err = e as Error;
      const timedOut = err.name === 'TimeoutError' || err.name === 'AbortError';
      return { status: 0, body: null, network: timedOut ? 'timeout' : 'offline', error: timedOut ? `Timed out after ${timeoutMs} ms` : `Network error: ${err.message}` };
    }
  }
}

// ------------------------------------------------------------------ mock company

type Entity = Record<string, unknown> & { Id: string; SyncToken: string };
export type MockQboFailure = { mode: 'offline' | 'timeout' | 'http500' | 'http400' | 'http401'; count: number };

const ACCOUNTS: [id: string, name: string, type: string][] = [
  ['1', 'Cash on hand', 'Bank'],
  ['2', 'M-Pesa till', 'Bank'],
  ['3', 'KCB current account', 'Bank'],
  ['4', 'Card settlements clearing', 'Bank'],
  ['10', 'Accounts Receivable (A/R)', 'Accounts Receivable'],
  ['20', 'Accounts Payable (A/P)', 'Accounts Payable'],
  ['21', 'VAT payable (output)', 'Other Current Liability'],
  ['22', 'VAT recoverable (input)', 'Other Current Asset'],
  ['30', 'Inventory - medicines', 'Other Current Asset'],
  ['31', 'Inventory - medical supplies', 'Other Current Asset'],
  ['32', 'Stock in transit', 'Other Current Asset'],
  ['33', 'Goods received not invoiced', 'Other Current Liability'],
  ['40', 'Sales - pharmacy', 'Income'],
  ['41', 'Sales - supplies and consumables', 'Income'],
  ['50', 'Cost of sales - medicines', 'Cost of Goods Sold'],
  ['51', 'Cost of sales - supplies', 'Cost of Goods Sold'],
  ['60', 'Departmental consumption', 'Expense'],
  ['61', 'Stock write-offs (expiry, damage)', 'Expense'],
  ['62', 'Stock adjustments and count variances', 'Expense'],
  ['63', 'Loyalty redemptions', 'Expense'],
  ['70', 'Opening balance equity', 'Equity'],
];
const CLASSES: [string, string][] = [
  ['100', 'Main store'],
  ['101', 'Main pharmacy'],
  ['102', 'OPD pharmacy'],
  ['103', 'IPD pharmacy'],
  ['110', 'Medical ward'],
  ['111', 'Surgical ward'],
  ['112', 'Maternity'],
  ['113', 'Theatre'],
];
const TAX_CODES: [string, string, number][] = [
  ['1', 'VAT 16%', 16],
  ['2', 'Exempt', 0],
  ['3', 'Zero-rated', 0],
];
const AR = '10';
const AP = '20';
const VAT_OUT = '21';
const VAT_IN = '22';

/**
 * In-memory QuickBooks company. Every transaction also lands in a ledger
 * (debit +, credit −) the way QuickBooks would post it, which the
 * TrialBalance report reads.
 */
export class MockQbo implements AccountingAdapter {
  readonly mock = true;
  store = new Map<string, Map<string, Entity>>();
  ledger: { txnType: string; txnId: string; date: string; account: string; amount: number; classId: string | null }[] = [];
  requests: { method: string; path: string; status: number }[] = [];
  private byRequestId = new Map<string, QboReply>();
  failure: MockQboFailure | null = null;
  bookCloseDate: string | null = null;
  private seq = 1000;
  private tokenSeq = 0;
  validTokens = new Set<string>();

  constructor() {
    this.reset();
  }

  reset() {
    this.store = new Map();
    this.ledger = [];
    this.requests = [];
    this.byRequestId.clear();
    this.failure = null;
    this.bookCloseDate = null;
    for (const [Id, Name, AccountType] of ACCOUNTS) this.put('Account', { Id, Name, AccountType, Active: true });
    for (const [Id, Name] of CLASSES) this.put('Class', { Id, Name, Active: true });
    for (const [Id, Name, rate] of TAX_CODES) this.put('TaxCode', { Id, Name, Active: true, RateValue: rate });
  }

  private put(type: string, e: Record<string, unknown>): Entity {
    if (!this.store.has(type)) this.store.set(type, new Map());
    const id = String(e.Id ?? ++this.seq);
    const prev = this.store.get(type)!.get(id);
    const saved = { ...e, Id: id, SyncToken: prev ? String(Number(prev.SyncToken) + 1) : '0', MetaData: { CreateTime: new Date().toISOString() } } as Entity;
    this.store.get(type)!.set(id, saved);
    return saved;
  }

  all(type: string): Entity[] {
    return [...(this.store.get(type)?.values() ?? [])];
  }

  // OAuth
  authorizeUrl(p: { redirectUri: string; state: string }) {
    return `${p.redirectUri}?${new URLSearchParams({ code: `mock-code-${Date.now()}`, state: p.state, realmId: '9130357000000001' })}`;
  }
  private tokens(): QboTokens {
    const accessToken = `mock-access-${++this.tokenSeq}`;
    this.validTokens.add(accessToken);
    return { accessToken, refreshToken: `mock-refresh-${this.tokenSeq}`, expiresIn: 3600, refreshExpiresIn: 8_726_400 };
  }
  async exchangeCode(p: { code: string }) {
    if (!p.code.startsWith('mock-code')) throw new QboError('invalid_grant');
    return this.tokens();
  }
  async refresh(p: { refreshToken: string }) {
    if (!p.refreshToken.startsWith('mock-refresh')) throw new QboError('invalid_grant');
    return this.tokens();
  }
  async revoke(p: { token: string }) {
    this.validTokens.delete(p.token);
  }

  async call(p: { realmId: string; accessToken: string; method: 'GET' | 'POST'; path: string; body?: unknown; requestId?: string }): Promise<QboReply> {
    const r = this.route(p);
    this.requests.push({ method: p.method, path: p.path, status: r.status });
    return r;
  }

  private route(p: { accessToken: string; method: 'GET' | 'POST'; path: string; body?: unknown; requestId?: string }): QboReply {
    if (this.failure && this.failure.count > 0) {
      this.failure.count--;
      const f = this.failure;
      if (f.count <= 0) this.failure = null;
      if (f.mode === 'offline' || f.mode === 'timeout') return { status: 0, body: null, network: f.mode, error: f.mode === 'offline' ? 'Network error: connection refused (mock)' : 'Timed out (mock)' };
      if (f.mode === 'http500') return { status: 500, body: { Fault: { Error: [{ Message: 'Service unavailable', code: '3100' }], type: 'SERVICE' } } };
      if (f.mode === 'http401') return { status: 401, body: { Fault: { Error: [{ Message: 'AuthenticationFailed', code: '3200' }], type: 'AUTHENTICATION' } } };
      return { status: 400, body: { Fault: { Error: [{ Message: 'Business Validation Error', Detail: 'Mock rejected the request', code: '6000' }], type: 'ValidationFault' } } };
    }
    if (!this.validTokens.has(p.accessToken)) return { status: 401, body: { Fault: { Error: [{ Message: 'AuthenticationFailed', code: '3200' }], type: 'AUTHENTICATION' } } };
    if (p.requestId && this.byRequestId.has(p.requestId)) return this.byRequestId.get(p.requestId)!;
    const url = new URL(p.path, 'http://mock/');
    const parts = url.pathname.split('/').filter(Boolean);
    let reply: QboReply;
    if (p.method === 'GET' && parts[0] === 'query') reply = { status: 200, body: { QueryResponse: this.query(url.searchParams.get('query') ?? '') } };
    else if (p.method === 'GET' && parts[0] === 'preferences') reply = { status: 200, body: { Preferences: { AccountingInfoPrefs: { BookCloseDate: this.bookCloseDate ?? undefined } } } };
    else if (p.method === 'GET' && parts[0] === 'companyinfo') reply = { status: 200, body: { CompanyInfo: { Id: parts[1], CompanyName: 'SIL Hospital (mock QuickBooks)' } } };
    else if (p.method === 'GET' && parts[0] === 'reports' && parts[1] === 'TrialBalance') reply = { status: 200, body: this.trialBalance(url.searchParams.get('end_date') ?? '9999-12-31') };
    else if (p.method === 'POST' && parts.length === 1) reply = this.create(parts[0], (p.body ?? {}) as Record<string, unknown>);
    else reply = { status: 400, body: { Fault: { Error: [{ Message: `Unsupported ${p.method} ${p.path}` }] } } };
    if (p.requestId && reply.status < 500) this.byRequestId.set(p.requestId, reply);
    return reply;
  }

  private query(sql: string): Record<string, unknown> {
    const m = /select \* from (\w+)(?: where (\w+) = '((?:[^']|\\')*)')?/i.exec(sql);
    if (!m) return {};
    const rows = this.all(m[1]).filter((e) => !m[2] || String(e[m[2]] ?? '') === m[3].replace(/\\'/g, "'"));
    return { [m[1]]: rows, maxResults: rows.length };
  }

  private fault(message: string, detail?: string): QboReply {
    return { status: 400, body: { Fault: { Error: [{ Message: message, Detail: detail, code: '6000' }], type: 'ValidationFault' } } };
  }

  private ref(v: unknown): string | null {
    return (v as { value?: string } | undefined)?.value ?? null;
  }

  private create(path: string, b: Record<string, unknown>): QboReply {
    const types: Record<string, string> = { vendor: 'Vendor', customer: 'Customer', item: 'Item', bill: 'Bill', billpayment: 'BillPayment', vendorcredit: 'VendorCredit', salesreceipt: 'SalesReceipt', invoice: 'Invoice', payment: 'Payment', refundreceipt: 'RefundReceipt', creditmemo: 'CreditMemo', journalentry: 'JournalEntry' };
    const type = types[path.toLowerCase()];
    if (!type) return this.fault(`Unsupported entity ${path}`);
    const date = String(b.TxnDate ?? new Date().toISOString().slice(0, 10));
    if (!['Vendor', 'Customer', 'Item'].includes(type) && this.bookCloseDate && date <= this.bookCloseDate) return this.fault('Account Period Closed', `The books are closed up to ${this.bookCloseDate}`);
    if (['Vendor', 'Customer'].includes(type)) {
      const name = String(b.DisplayName ?? '');
      if (!name) return this.fault('Required param missing', 'DisplayName');
      if (this.all(type).some((e) => e.DisplayName === name)) return this.fault('Duplicate Name Exists Error', `The name supplied already exists: ${name}`);
    }
    const lines = (b.Line as Record<string, unknown>[] | undefined) ?? [];
    const amt = (l: Record<string, unknown>) => Number(l.Amount ?? 0);
    const cls = (l: Record<string, unknown>, detail: string) => this.ref((l[detail] as Record<string, unknown> | undefined)?.ClassRef) ?? this.ref(b.ClassRef);
    const tax = Number((b.TxnTaxDetail as { TotalTax?: number } | undefined)?.TotalTax ?? 0);
    const entries: { account: string; amount: number; classId: string | null }[] = [];
    const itemIncome = (l: Record<string, unknown>) => {
      const item = this.store.get('Item')?.get(this.ref((l.SalesItemLineDetail as Record<string, unknown> | undefined)?.ItemRef) ?? '');
      return this.ref(item?.IncomeAccountRef) ?? '';
    };
    // The ledger effect QuickBooks would post (amounts on sales lines are VAT inclusive).
    // VAT is spread over the taxable lines (tax code with a rate).
    const taxable = (l: Record<string, unknown>) => Number(this.store.get('TaxCode')?.get(this.ref((l.SalesItemLineDetail as Record<string, unknown> | undefined)?.TaxCodeRef) ?? '')?.RateValue ?? 0) > 0;
    const salesLines = (sign: number) => {
      const gross = lines.reduce((s, l) => s + amt(l), 0);
      const taxedGross = lines.filter(taxable).reduce((s, l) => s + amt(l), 0);
      for (const l of lines) entries.push({ account: itemIncome(l), amount: sign * -(amt(l) - (taxedGross && taxable(l) ? (tax * amt(l)) / taxedGross : 0)), classId: cls(l, 'SalesItemLineDetail') });
      if (tax) entries.push({ account: VAT_OUT, amount: sign * -tax, classId: null });
      return gross;
    };
    let total = 0;
    switch (type) {
      case 'Bill':
      case 'VendorCredit': {
        const sign = type === 'Bill' ? 1 : -1;
        for (const l of lines) {
          const d = l.AccountBasedExpenseLineDetail as Record<string, unknown>;
          entries.push({ account: this.ref(d?.AccountRef) ?? '', amount: sign * amt(l), classId: cls(l, 'AccountBasedExpenseLineDetail') });
          total += amt(l);
        }
        if (tax) entries.push({ account: VAT_IN, amount: sign * tax, classId: null });
        total += tax;
        entries.push({ account: AP, amount: -sign * total, classId: null });
        break;
      }
      case 'BillPayment': {
        total = Number(b.TotalAmt ?? 0);
        for (const l of lines) for (const lt of (l.LinkedTxn as { TxnId: string; TxnType: string }[]) ?? []) if (!this.store.get('Bill')?.has(lt.TxnId)) return this.fault('Invalid Reference Id', `Bill ${lt.TxnId}`);
        entries.push({ account: AP, amount: total, classId: null }, { account: this.ref((b.CheckPayment as Record<string, unknown> | undefined)?.BankAccountRef) ?? '', amount: -total, classId: null });
        break;
      }
      case 'SalesReceipt':
      case 'RefundReceipt': {
        const sign = type === 'SalesReceipt' ? 1 : -1;
        total = salesLines(sign);
        entries.push({ account: this.ref(b.DepositToAccountRef) ?? '', amount: sign * total, classId: null });
        break;
      }
      case 'Invoice':
      case 'CreditMemo': {
        const sign = type === 'Invoice' ? 1 : -1;
        total = salesLines(sign);
        entries.push({ account: AR, amount: sign * total, classId: null });
        break;
      }
      case 'Payment': {
        total = Number(b.TotalAmt ?? 0);
        for (const l of lines) for (const lt of (l.LinkedTxn as { TxnId: string }[]) ?? []) if (!this.store.get('Invoice')?.has(lt.TxnId)) return this.fault('Invalid Reference Id', `Invoice ${lt.TxnId}`);
        entries.push({ account: this.ref(b.DepositToAccountRef) ?? '', amount: total, classId: null }, { account: AR, amount: -total, classId: null });
        break;
      }
      case 'JournalEntry': {
        let dr = 0;
        let cr = 0;
        for (const l of lines) {
          const d = l.JournalEntryLineDetail as Record<string, unknown>;
          const a = amt(l);
          if (d.PostingType === 'Debit') dr += a;
          else cr += a;
          entries.push({ account: this.ref(d.AccountRef) ?? '', amount: d.PostingType === 'Debit' ? a : -a, classId: this.ref(d.ClassRef) });
        }
        if (Math.abs(dr - cr) > 0.005) return this.fault('Transaction Not Balanced', `Debits ${dr} and credits ${cr}`);
        total = dr;
        break;
      }
    }
    for (const e of entries) {
      if (!e.account) return this.fault('Invalid Reference Id', 'An account reference is missing or unknown');
      if (!this.store.get('Account')?.has(e.account)) return this.fault('Invalid Reference Id', `Account ${e.account}`);
    }
    const saved = this.put(type, { ...b, ...(['Vendor', 'Customer', 'Item'].includes(type) ? {} : { TotalAmt: Math.round(total * 100) / 100 }) });
    for (const e of entries) this.ledger.push({ txnType: type, txnId: saved.Id, date, account: e.account, amount: Math.round(e.amount * 100) / 100, classId: e.classId });
    return { status: 200, body: { [type]: saved, time: new Date().toISOString() } };
  }

  /** TrialBalance as at end_date, in the QuickBooks report shape (Rows.Row[].ColData: account, debit, credit). */
  trialBalance(endDate: string) {
    const totals = new Map<string, number>();
    for (const e of this.ledger) if (e.date <= endDate) totals.set(e.account, (totals.get(e.account) ?? 0) + e.amount);
    const accounts = this.store.get('Account')!;
    return {
      Header: { ReportName: 'TrialBalance', EndPeriod: endDate },
      Rows: {
        Row: [...totals.entries()].map(([id, v]) => ({
          ColData: [{ value: String(accounts.get(id)?.Name ?? id), id }, { value: v > 0 ? (Math.round(v * 100) / 100).toFixed(2) : '' }, { value: v < 0 ? (Math.round(-v * 100) / 100).toFixed(2) : '' }],
        })),
      },
    };
  }

  newRealmRequestId() {
    return randomUUID();
  }
}

/** Account id → net (debit − credit) from a TrialBalance report. */
export function readTrialBalance(body: Record<string, unknown> | null): Map<string, number> {
  const out = new Map<string, number>();
  const walk = (rows: unknown) => {
    for (const r of ((rows as { Row?: unknown[] } | undefined)?.Row ?? []) as Record<string, unknown>[]) {
      if (r.Rows) walk(r.Rows);
      const cols = r.ColData as { value?: string; id?: string }[] | undefined;
      if (!cols?.[0]?.id) continue;
      const dr = Number(cols[1]?.value || 0);
      const cr = Number(cols[2]?.value || 0);
      out.set(cols[0].id, Math.round((dr - cr) * 100) / 100);
    }
  };
  walk(body?.Rows);
  return out;
}

export const sharedMockQbo = new MockQbo();
