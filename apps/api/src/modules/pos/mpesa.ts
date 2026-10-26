/**
 * Safaricom Daraja (M-Pesa) behind an adapter: Lipa na M-Pesa Online (STK
 * Push) and its status query. The Daraja adapter talks to the sandbox or
 * production API; the mock (tests, development) answers like Daraja and
 * delivers the result callback itself. Phone numbers are normalised to 2547XXXXXXXX.
 */

export interface StkRequest {
  phone: string;
  amount: number;
  accountRef: string;
  description: string;
  callbackUrl: string;
}

export interface StkStarted {
  ok: boolean;
  merchantRequestId: string | null;
  checkoutRequestId: string | null;
  responseCode: string | null;
  message: string;
}

/** Body of the STK callback (stkCallback) — also returned by the query. */
export interface StkResult {
  checkoutRequestId: string;
  merchantRequestId: string | null;
  resultCode: string;
  resultDesc: string;
  receiptNo: string | null;
  amount: number | null;
  phone: string | null;
  transactionDate: Date | null;
}

export interface MpesaAdapter {
  stkPush(req: StkRequest, timeoutMs: number): Promise<StkStarted>;
  /** null while the customer has not answered yet. */
  stkQuery(checkoutRequestId: string, timeoutMs: number): Promise<StkResult | null>;
}

export class MpesaError extends Error {}

/** 07XXXXXXXX / +2547… / 2541… → 2547XXXXXXXX (or 2541…). */
export function normalisePhone(raw: string): string {
  const d = raw.replace(/[^\d]/g, '');
  const n = d.startsWith('254') ? d : d.startsWith('0') ? `254${d.slice(1)}` : d.length === 9 ? `254${d}` : d;
  if (!/^254(7|1)\d{8}$/.test(n)) throw new MpesaError(`${raw} is not a Kenyan mobile number`);
  return n;
}

/** Daraja timestamp (YYYYMMDDHHmmss, Nairobi time). */
export function darajaTimestamp(d = new Date()): string {
  const eat = new Date(d.getTime() + 3 * 3_600_000).toISOString();
  return eat.slice(0, 19).replace(/[-T:]/g, '');
}

/** "20261026143015" (Nairobi) → Date. */
export function fromDarajaDate(v: unknown): Date | null {
  const s = String(v ?? '');
  const m = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})$/.exec(s);
  return m ? new Date(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}+03:00`) : null;
}

/** stkCallback (or query response) → result. */
export function parseStkCallback(body: unknown): StkResult | null {
  const cb = (body as { Body?: { stkCallback?: Record<string, unknown> } })?.Body?.stkCallback;
  if (!cb?.CheckoutRequestID) return null;
  const items = ((cb.CallbackMetadata as { Item?: { Name: string; Value?: unknown }[] } | undefined)?.Item ?? []);
  const get = (n: string) => items.find((i) => i.Name === n)?.Value;
  return {
    checkoutRequestId: String(cb.CheckoutRequestID),
    merchantRequestId: cb.MerchantRequestID ? String(cb.MerchantRequestID) : null,
    resultCode: String(cb.ResultCode ?? ''),
    resultDesc: String(cb.ResultDesc ?? ''),
    receiptNo: get('MpesaReceiptNumber') ? String(get('MpesaReceiptNumber')) : null,
    amount: get('Amount') !== undefined ? Number(get('Amount')) : null,
    phone: get('PhoneNumber') ? String(get('PhoneNumber')) : null,
    transactionDate: fromDarajaDate(get('TransactionDate')),
  };
}

export interface DarajaCredentials {
  baseUrl: string;
  consumerKey: string;
  consumerSecret: string;
  shortcode: string;
  passkey: string;
  transactionType: string;
  partyB: string | null;
}

/** Daraja REST API (sandbox: https://sandbox.safaricom.co.ke, production: https://api.safaricom.co.ke). */
export class DarajaMpesaAdapter implements MpesaAdapter {
  private token: { value: string; expires: number } | null = null;
  constructor(private readonly c: DarajaCredentials) {}

  private async auth(timeoutMs: number): Promise<string> {
    if (this.token && this.token.expires > Date.now() + 30_000) return this.token.value;
    const basic = Buffer.from(`${this.c.consumerKey}:${this.c.consumerSecret}`).toString('base64');
    const res = await fetch(`${this.c.baseUrl.replace(/\/+$/, '')}/oauth/v1/generate?grant_type=client_credentials`, { headers: { authorization: `Basic ${basic}` }, signal: AbortSignal.timeout(timeoutMs) });
    const body = (await res.json().catch(() => ({}))) as { access_token?: string; expires_in?: string };
    if (!res.ok || !body.access_token) throw new MpesaError(`Daraja authentication failed (HTTP ${res.status})`);
    this.token = { value: body.access_token, expires: Date.now() + Number(body.expires_in ?? 3599) * 1000 };
    return this.token.value;
  }

  private password(ts: string) {
    return Buffer.from(`${this.c.shortcode}${this.c.passkey}${ts}`).toString('base64');
  }

  private async post(path: string, body: Record<string, unknown>, timeoutMs: number) {
    const token = await this.auth(timeoutMs);
    const res = await fetch(`${this.c.baseUrl.replace(/\/+$/, '')}${path}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    return { status: res.status, body: (await res.json().catch(() => ({}))) as Record<string, unknown> };
  }

  async stkPush(req: StkRequest, timeoutMs: number): Promise<StkStarted> {
    const ts = darajaTimestamp();
    const r = await this.post(
      '/mpesa/stkpush/v1/processrequest',
      {
        BusinessShortCode: this.c.shortcode,
        Password: this.password(ts),
        Timestamp: ts,
        TransactionType: this.c.transactionType,
        Amount: Math.ceil(req.amount),
        PartyA: req.phone,
        PartyB: this.c.partyB ?? this.c.shortcode,
        PhoneNumber: req.phone,
        CallBackURL: req.callbackUrl,
        AccountReference: req.accountRef.slice(0, 12),
        TransactionDesc: req.description.slice(0, 13),
      },
      timeoutMs,
    );
    const ok = r.status === 200 && String(r.body.ResponseCode) === '0';
    return {
      ok,
      merchantRequestId: (r.body.MerchantRequestID as string) ?? null,
      checkoutRequestId: (r.body.CheckoutRequestID as string) ?? null,
      responseCode: r.body.ResponseCode !== undefined ? String(r.body.ResponseCode) : (r.body.errorCode as string) ?? null,
      message: String(r.body.CustomerMessage ?? r.body.ResponseDescription ?? r.body.errorMessage ?? `HTTP ${r.status}`),
    };
  }

  async stkQuery(checkoutRequestId: string, timeoutMs: number): Promise<StkResult | null> {
    const ts = darajaTimestamp();
    const r = await this.post('/mpesa/stkpushquery/v1/query', { BusinessShortCode: this.c.shortcode, Password: this.password(ts), Timestamp: ts, CheckoutRequestID: checkoutRequestId }, timeoutMs);
    // "The transaction is being processed" comes back as an error code while pending.
    if (r.body.errorCode === '500.001.1001' || r.body.ResultCode === undefined) return null;
    return { checkoutRequestId, merchantRequestId: (r.body.MerchantRequestID as string) ?? null, resultCode: String(r.body.ResultCode), resultDesc: String(r.body.ResultDesc ?? ''), receiptNo: null, amount: null, phone: null, transactionDate: null };
  }
}

/**
 * Mock Daraja. Outcome by the phone's last three digits: …000 insufficient
 * funds (1), …111 cancelled by the user (1032), …222 no answer (stays pending,
 * the query reports 1037 timeout), …333 the push itself is refused; anything
 * else pays. The callback is delivered through `deliver` (in process) after
 * `delayMs`.
 */
export class MockMpesa implements MpesaAdapter {
  pushes: (StkRequest & { checkoutRequestId: string })[] = [];
  private results = new Map<string, StkResult>();
  deliver: ((body: Record<string, unknown>) => Promise<void>) | null = null;
  delayMs = 0;
  private seq = 0;

  reset() {
    this.pushes = [];
    this.results.clear();
    this.delayMs = 0;
  }

  async stkPush(req: StkRequest): Promise<StkStarted> {
    if (req.phone.endsWith('333')) return { ok: false, merchantRequestId: null, checkoutRequestId: null, responseCode: '400.002.02', message: 'Bad Request - Invalid PhoneNumber' };
    const n = ++this.seq;
    const checkoutRequestId = `ws_CO_MOCK_${Date.now()}_${n}`;
    const merchantRequestId = `MOCK-${n}`;
    this.pushes.push({ ...req, checkoutRequestId });
    const tail = req.phone.slice(-3);
    if (tail !== '222') {
      const ok = tail !== '000' && tail !== '111';
      const result: StkResult = {
        checkoutRequestId,
        merchantRequestId,
        resultCode: ok ? '0' : tail === '000' ? '1' : '1032',
        resultDesc: ok ? 'The service request is processed successfully.' : tail === '000' ? 'The balance is insufficient for the transaction.' : 'Request cancelled by user',
        receiptNo: ok ? `MCK${String(Date.now()).slice(-6)}${String(n).padStart(4, '0')}` : null,
        amount: ok ? Math.ceil(req.amount) : null,
        phone: ok ? req.phone : null,
        transactionDate: ok ? new Date() : null,
      };
      this.results.set(checkoutRequestId, result);
      // With a delay the result arrives by callback; without, the service reads it at once (stkQuery).
      if (this.delayMs > 0) setTimeout(() => void this.deliver?.(MockMpesa.callbackBody(result)).catch(() => undefined), this.delayMs);
    }
    return { ok: true, merchantRequestId, checkoutRequestId, responseCode: '0', message: 'Success. Request accepted for processing' };
  }

  async stkQuery(checkoutRequestId: string): Promise<StkResult | null> {
    const r = this.results.get(checkoutRequestId);
    if (r) return r;
    const push = this.pushes.find((p) => p.checkoutRequestId === checkoutRequestId);
    if (push?.phone.endsWith('222')) return { checkoutRequestId, merchantRequestId: null, resultCode: '1037', resultDesc: 'DS timeout user cannot be reached', receiptNo: null, amount: null, phone: null, transactionDate: null };
    return null;
  }

  /** The callback Daraja would POST for a result. */
  static callbackBody(r: StkResult): Record<string, unknown> {
    return {
      Body: {
        stkCallback: {
          MerchantRequestID: r.merchantRequestId,
          CheckoutRequestID: r.checkoutRequestId,
          ResultCode: Number(r.resultCode),
          ResultDesc: r.resultDesc,
          ...(r.resultCode === '0'
            ? {
                CallbackMetadata: {
                  Item: [
                    { Name: 'Amount', Value: r.amount },
                    { Name: 'MpesaReceiptNumber', Value: r.receiptNo },
                    { Name: 'TransactionDate', Value: Number(darajaTimestamp(r.transactionDate ?? new Date())) },
                    { Name: 'PhoneNumber', Value: Number(r.phone) },
                  ],
                },
              }
            : {}),
        },
      },
    };
  }
}

export const sharedMockMpesa = new MockMpesa();
