import { PaymentMethod } from '@sil/shared';
import type { Env } from '../../config/env';
import { MPESA_PAYOUT_METHODS } from './payout-rules';
import { DispatchAnswer, GatewayConfigError, PaymentGateway, PayoutRequest, PayoutResult, ReversalRequest, StatusAnswer, StatusRef } from './gateway';

/**
 * M-PESA payouts through Safaricom Daraja: B2C (BusinessPayment to a phone),
 * B2B (BusinessPayBill / BusinessBuyGoods), Transaction Status and Reversal.
 * Results arrive on ResultURL / QueueTimeOutURL. Credentials come from the
 * environment only and the security credential is never stored or logged.
 */

type Callbacks = { result: string; timeout: string; status: (payoutId: string) => string; reversal: (payoutId: string) => string };

/** Daraja dates: "20261027143015" or "27.10.2026 14:30:15" (Nairobi). */
export function parseDarajaDate(v: unknown): Date | null {
  const s = String(v ?? '');
  let m = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})$/.exec(s);
  if (m) return new Date(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}+03:00`);
  m = /^(\d{2})\.(\d{2})\.(\d{4}) (\d{2}):(\d{2}):(\d{2})$/.exec(s);
  if (m) return new Date(`${m[3]}-${m[2]}-${m[1]}T${m[4]}:${m[5]}:${m[6]}+03:00`);
  return null;
}

/** "Business Pay Bill Charge|KES|77.00" → 77. */
const charge = (v: unknown): number | null => {
  if (v === undefined || v === null || v === '') return null;
  const parts = String(v).split('|');
  const n = Number(parts[parts.length - 1]);
  return Number.isFinite(n) ? n : null;
};

/** "254708374149 - John Doe" → "John Doe". */
const party = (v: unknown): string | null => {
  if (!v) return null;
  const s = String(v);
  const i = s.indexOf(' - ');
  return (i >= 0 ? s.slice(i + 3) : s).trim() || null;
};

/** Result callback (B2C, B2B, Transaction Status, Reversal) → result. */
export function parsePayoutResult(body: unknown): PayoutResult | null {
  const r = (body as { Result?: Record<string, unknown> })?.Result;
  if (!r || r.ResultCode === undefined) return null;
  const items = ((r.ResultParameters as { ResultParameter?: { Key: string; Value?: unknown }[] | { Key: string; Value?: unknown } } | undefined)?.ResultParameter ?? []);
  const list = Array.isArray(items) ? items : [items];
  const get = (...keys: string[]) => keys.map((k) => list.find((i) => i.Key === k)?.Value).find((v) => v !== undefined);
  const amount = get('TransactionAmount', 'Amount');
  return {
    originatorConversationId: r.OriginatorConversationID ? String(r.OriginatorConversationID) : null,
    conversationId: r.ConversationID ? String(r.ConversationID) : null,
    resultCode: String(r.ResultCode),
    resultDesc: String(r.ResultDesc ?? ''),
    receiptNo: String(get('TransactionReceipt', 'ReceiptNo') ?? r.TransactionID ?? '') || null,
    amount: amount !== undefined ? Number(amount) : null,
    recipientName: party(get('ReceiverPartyPublicName', 'CreditPartyName')),
    charges: charge(get('DebitPartyCharges')),
    completedAt: parseDarajaDate(get('TransactionCompletedDateTime', 'TransCompletedTime', 'FinalisedTime')),
  };
}

/** Status query result: was the original transaction completed? */
export function statusFromResult(result: PayoutResult, body: unknown): StatusAnswer {
  const r = (body as { Result?: { ResultParameters?: { ResultParameter?: { Key: string; Value?: unknown }[] } } })?.Result;
  const status = (r?.ResultParameters?.ResultParameter ?? []).find((p) => p.Key === 'TransactionStatus')?.Value;
  // 2001 / "transaction not found" style answers: never processed.
  if (result.resultCode !== '0') return /not found|invalid transaction/i.test(result.resultDesc) ? { state: 'NOT_FOUND' } : { state: 'PENDING' };
  if (String(status ?? 'Completed') === 'Completed') return { state: 'FOUND', result: { ...result, resultCode: '0' } };
  return { state: 'FOUND', result: { ...result, resultCode: 'FAILED', resultDesc: `M-PESA reports the transaction as ${status}` } };
}

/** The request as stored for audit: never the security credential. */
const redact = (body: Record<string, unknown>) => ({ ...body, SecurityCredential: body.SecurityCredential ? '[redacted]' : undefined });

export class DarajaPayoutGateway implements PaymentGateway {
  readonly code = 'MPESA';
  private token: { value: string; expires: number } | null = null;

  constructor(
    private readonly c: Env['mpesaPayout'],
    private readonly urls: Callbacks,
  ) {
    for (const k of ['baseUrl', 'consumerKey', 'consumerSecret', 'shortcode', 'initiatorName', 'securityCredential', 'callbackBaseUrl', 'callbackToken'] as const) {
      if (!c[k]) throw new GatewayConfigError(`M-PESA payouts: ${k} is not set (MPESA_PAYOUT_* environment variables)`);
    }
  }

  supports(method: PaymentMethod) {
    return MPESA_PAYOUT_METHODS.includes(method);
  }

  /** OAuth token, cached until a minute before it expires. */
  private async auth(): Promise<string> {
    if (this.token && this.token.expires > Date.now() + 60_000) return this.token.value;
    const basic = Buffer.from(`${this.c.consumerKey}:${this.c.consumerSecret}`).toString('base64');
    const res = await fetch(`${this.c.baseUrl!.replace(/\/+$/, '')}/oauth/v1/generate?grant_type=client_credentials`, { headers: { authorization: `Basic ${basic}` }, signal: AbortSignal.timeout(this.c.timeoutMs) });
    const body = (await res.json().catch(() => ({}))) as { access_token?: string; expires_in?: string };
    if (!res.ok || !body.access_token) throw new GatewayConfigError(`Daraja authentication failed (HTTP ${res.status})`);
    this.token = { value: body.access_token, expires: Date.now() + Number(body.expires_in ?? 3599) * 1000 };
    return this.token.value;
  }

  /** POSTs; a timeout or network failure after the request may have reached Daraja is UNKNOWN, never REJECTED. */
  private async send(path: string, body: Record<string, unknown>): Promise<DispatchAnswer> {
    let token: string;
    try {
      token = await this.auth();
    } catch (e) {
      // Nothing was sent: safe to try again later.
      return { outcome: 'REJECTED', code: 'AUTH', message: (e as Error).message, request: redact(body), response: {} };
    }
    let res: Response;
    try {
      res = await fetch(`${this.c.baseUrl!.replace(/\/+$/, '')}${path}`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.c.timeoutMs),
      });
    } catch (e) {
      return { outcome: 'UNKNOWN', message: `No answer from M-PESA: ${(e as Error).message}`, request: redact(body) };
    }
    const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (res.status >= 500 || res.status === 429) return { outcome: 'UNKNOWN', message: `M-PESA answered HTTP ${res.status}`, request: redact(body) };
    if (res.ok && String(json.ResponseCode) === '0') return { outcome: 'ACCEPTED', conversationId: (json.ConversationID as string) ?? null, message: String(json.ResponseDescription ?? 'Accepted'), request: redact(body), response: json };
    return { outcome: 'REJECTED', code: (json.errorCode as string) ?? (json.ResponseCode !== undefined ? String(json.ResponseCode) : String(res.status)), message: String(json.errorMessage ?? json.ResponseDescription ?? `HTTP ${res.status}`), request: redact(body), response: json };
  }

  private get auth_() {
    return { InitiatorName: this.c.initiatorName, SecurityCredential: this.c.securityCredential };
  }

  dispatch(req: PayoutRequest): Promise<DispatchAnswer> {
    if (req.method === PaymentMethod.MPESA_B2C) {
      return this.send('/mpesa/b2c/v3/paymentrequest', {
        OriginatorConversationID: req.originatorConversationId,
        ...this.auth_,
        CommandID: req.commandId,
        Amount: Math.round(req.amount),
        PartyA: this.c.shortcode,
        PartyB: req.partyB,
        Remarks: req.remarks.slice(0, 100),
        QueueTimeOutURL: this.urls.timeout,
        ResultURL: this.urls.result,
        Occassion: req.originatorConversationId.slice(0, 100),
      });
    }
    return this.send('/mpesa/b2b/v1/paymentrequest', {
      Initiator: this.c.initiatorName,
      SecurityCredential: this.c.securityCredential,
      CommandID: req.commandId,
      SenderIdentifierType: '4',
      RecieverIdentifierType: req.method === PaymentMethod.MPESA_TILL ? '2' : '4',
      Amount: Math.round(req.amount),
      PartyA: this.c.shortcode,
      PartyB: req.partyB,
      AccountReference: (req.accountRef ?? '').slice(0, 13),
      Remarks: req.remarks.slice(0, 100),
      Occasion: req.originatorConversationId.slice(0, 100),
      QueueTimeOutURL: this.urls.timeout,
      ResultURL: this.urls.result,
    });
  }

  /** Daraja answers status queries by callback (status URL carries the attempt id). */
  async queryStatus(ref: StatusRef): Promise<StatusAnswer> {
    await this.send('/mpesa/transactionstatus/v1/query', {
      Initiator: this.c.initiatorName,
      SecurityCredential: this.c.securityCredential,
      CommandID: 'TransactionStatusQuery',
      OriginatorConversationID: ref.originatorConversationId,
      ...(ref.conversationId ? { OriginalConversationID: ref.conversationId } : {}),
      PartyA: this.c.shortcode,
      IdentifierType: '4',
      ResultURL: this.urls.status(ref.payoutId),
      QueueTimeOutURL: this.urls.timeout,
      Remarks: 'Payment status',
      Occasion: ref.payoutId,
    });
    // The answer comes to the status callback; until then it is pending.
    return { state: 'PENDING' };
  }

  reverse(req: ReversalRequest): Promise<DispatchAnswer> {
    return this.send('/mpesa/reversal/v1/request', {
      Initiator: this.c.initiatorName,
      SecurityCredential: this.c.securityCredential,
      CommandID: 'TransactionReversal',
      TransactionID: req.receiptNo,
      Amount: Math.round(req.amount),
      ReceiverParty: this.c.shortcode,
      RecieverIdentifierType: '11',
      ResultURL: this.urls.reversal(req.payoutId),
      QueueTimeOutURL: this.urls.timeout,
      Remarks: req.remarks.slice(0, 100),
      Occasion: req.originatorConversationId,
    });
  }

  async balance(): Promise<number | null> {
    return null; // Account Balance answers by callback; reconciliation relies on the statement.
  }
}

/**
 * In-process Daraja simulator (development, tests). By the last three digits
 * of the phone / PayBill / Till: …333 refused at once; …000 fails (insufficient
 * funds); …222 accepted but no callback (the status query finds it paid);
 * …444 times out but was paid; …555 times out and was never processed;
 * …666 queue timeout; anything else is paid. Callbacks are queued and
 * delivered by `deliverAll()` (or posted to the HTTP endpoint by a test).
 */
export class MockPayoutGateway implements PaymentGateway {
  readonly code = 'MPESA';
  requests: PayoutRequest[] = [];
  reversals: ReversalRequest[] = [];
  /** Results Daraja "processed", by originator id. */
  private processed = new Map<string, Record<string, unknown>>();
  private queue: { kind: 'result' | 'timeout' | 'reversal'; id: string; body: Record<string, unknown> }[] = [];
  deliver: ((kind: 'result' | 'timeout' | 'reversal', id: string, body: Record<string, unknown>) => Promise<void>) | null = null;
  private seq = 0;

  reset() {
    this.requests = [];
    this.reversals = [];
    this.processed.clear();
    this.queue = [];
  }

  supports(method: PaymentMethod) {
    return MPESA_PAYOUT_METHODS.includes(method);
  }

  private resultBody(req: PayoutRequest, conversationId: string, ok: boolean): Record<string, unknown> {
    const n = ++this.seq;
    // Now, in Nairobi time, in the two formats Daraja uses.
    const eat = new Date(Date.now() + 3 * 3_600_000).toISOString();
    const compact = eat.slice(0, 19).replace(/[-T:]/g, '');
    const dotted = `${eat.slice(8, 10)}.${eat.slice(5, 7)}.${eat.slice(0, 4)} ${eat.slice(11, 19)}`;
    const receipt = `MPX${String(Date.now()).slice(-5)}${String(n).padStart(3, '0')}`.slice(0, 10).toUpperCase();
    const b2c = req.method === PaymentMethod.MPESA_B2C;
    const params = ok
      ? b2c
        ? [
            { Key: 'TransactionAmount', Value: Math.round(req.amount) },
            { Key: 'TransactionReceipt', Value: receipt },
            { Key: 'ReceiverPartyPublicName', Value: `${req.partyB} - Mock Recipient` },
            { Key: 'TransactionCompletedDateTime', Value: dotted },
            { Key: 'B2CUtilityAccountAvailableFunds', Value: 1_000_000 },
          ]
        : [
            { Key: 'Amount', Value: Math.round(req.amount) },
            { Key: 'TransCompletedTime', Value: compact },
            { Key: 'ReceiverPartyPublicName', Value: `${req.partyB} - Mock Supplier Ltd` },
            { Key: 'DebitPartyCharges', Value: 'Business Pay Bill Charge|KES|52.00' },
          ]
      : [];
    return {
      Result: {
        ResultType: 0,
        ResultCode: ok ? 0 : 2001,
        ResultDesc: ok ? 'The service request is processed successfully.' : 'The balance is insufficient for the transaction.',
        OriginatorConversationID: req.originatorConversationId,
        ConversationID: conversationId,
        TransactionID: ok ? receipt : 'OAR0000000',
        ResultParameters: { ResultParameter: params },
      },
    };
  }

  async dispatch(req: PayoutRequest): Promise<DispatchAnswer> {
    this.requests.push(req);
    const tail = req.partyB.slice(-3);
    const request = { ...req } as unknown as Record<string, unknown>;
    if (tail === '333') return { outcome: 'REJECTED', code: '400.002.02', message: 'Bad Request - Invalid PartyB', request, response: { errorCode: '400.002.02' } };
    const conversationId = `AG_MOCK_${Date.now()}_${this.seq + 1}`;
    if (tail === '555') return { outcome: 'UNKNOWN', message: 'No answer from M-PESA: timeout', request }; // never processed
    const body = this.resultBody(req, conversationId, tail !== '000');
    this.processed.set(req.originatorConversationId, body);
    if (tail === '444') return { outcome: 'UNKNOWN', message: 'No answer from M-PESA: timeout', request }; // processed all the same
    if (tail === '666') this.queue.push({ kind: 'timeout', id: req.originatorConversationId, body: { Result: { ResultType: 1, ResultCode: 1, ResultDesc: 'The request timed out in the queue', OriginatorConversationID: req.originatorConversationId, ConversationID: conversationId } } });
    else if (tail !== '222') this.queue.push({ kind: 'result', id: req.originatorConversationId, body });
    return { outcome: 'ACCEPTED', conversationId, message: 'Accept the service request successfully.', request, response: { ConversationID: conversationId, OriginatorConversationID: req.originatorConversationId, ResponseCode: '0' } };
  }

  /** The callback a test can post itself. */
  callbackFor(originatorConversationId: string) {
    return this.queue.find((q) => q.id === originatorConversationId) ?? null;
  }

  async deliverAll() {
    const items = this.queue.splice(0);
    for (const q of items) await this.deliver?.(q.kind, q.id, q.body);
  }

  async queryStatus(ref: StatusRef): Promise<StatusAnswer> {
    const body = this.processed.get(ref.originatorConversationId);
    if (!body) return { state: 'NOT_FOUND' };
    const result = parsePayoutResult(body)!;
    return { state: 'FOUND', result };
  }

  async reverse(req: ReversalRequest): Promise<DispatchAnswer> {
    this.reversals.push(req);
    const body = { Result: { ResultType: 0, ResultCode: 0, ResultDesc: 'The service request is processed successfully.', OriginatorConversationID: req.originatorConversationId, ConversationID: `AG_REV_${Date.now()}`, TransactionID: `REV${req.receiptNo.slice(-6)}` } };
    this.queue.push({ kind: 'reversal', id: req.payoutId, body });
    return { outcome: 'ACCEPTED', conversationId: null, message: 'Reversal accepted', request: { ...req }, response: {} };
  }

  async balance(): Promise<number | null> {
    return 1_000_000;
  }
}

/** One simulator per process (tests reach it to drive callbacks). */
export const sharedMockPayouts = new MockPayoutGateway();
