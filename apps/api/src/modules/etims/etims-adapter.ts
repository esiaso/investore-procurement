import { EtimsAdapterKind } from '@sil/shared';
import { ETIMS_PATHS, EtimsOperation, NON_RETRYABLE, RESULT } from './etims-spec';
import { MockEtims, sharedMockEtims } from './mock/mock-etims';

export interface EtimsCredentials {
  tin: string;
  bhfId: string;
  cmcKey?: string | null;
}

export interface EtimsCallResult {
  ok: boolean;
  resultCd: string | null;
  resultMsg: string | null;
  data: Record<string, unknown> | null;
  httpStatus: number | null;
  /** Worth retrying later (network, timeout, 5xx); false for KRA business errors. */
  retryable: boolean;
  error: string | null;
  url: string;
  durationMs: number;
  /** Full response body (for the transmission log). */
  raw: Record<string, unknown> | null;
}

/** One control unit. Implementations differ only in transport and paths. */
export interface EtimsAdapter {
  readonly kind: EtimsAdapterKind;
  call(op: EtimsOperation, body: Record<string, unknown>, creds: EtimsCredentials, timeoutMs: number): Promise<EtimsCallResult>;
}

function classify(resultCd: string | null, httpStatus: number | null): { ok: boolean; retryable: boolean } {
  if (httpStatus !== null && httpStatus >= 500) return { ok: false, retryable: true };
  if (resultCd === RESULT.OK || resultCd === RESULT.NO_DATA) return { ok: true, retryable: false };
  if (resultCd === null) return { ok: false, retryable: true };
  return { ok: false, retryable: !NON_RETRYABLE.has(resultCd) && resultCd !== RESULT.DUPLICATE };
}

/** OSCU (KRA's API) and VSCU (the hospital's VSCU server): JSON over HTTPS POST. */
export class HttpEtimsAdapter implements EtimsAdapter {
  constructor(
    readonly kind: EtimsAdapterKind.OSCU | EtimsAdapterKind.VSCU,
    private readonly baseUrl: string,
  ) {}

  async call(op: EtimsOperation, body: Record<string, unknown>, creds: EtimsCredentials, timeoutMs: number): Promise<EtimsCallResult> {
    const url = `${this.baseUrl.replace(/\/+$/, '')}${ETIMS_PATHS[this.kind][op]}`;
    const started = Date.now();
    const headers: Record<string, string> = { 'content-type': 'application/json', tin: creds.tin, bhfId: creds.bhfId };
    if (creds.cmcKey) headers.cmcKey = creds.cmcKey;
    try {
      const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify({ tin: creds.tin, bhfId: creds.bhfId, ...body }), signal: AbortSignal.timeout(timeoutMs) });
      const text = await res.text();
      let raw: Record<string, unknown> | null = null;
      try {
        raw = text ? JSON.parse(text) : null;
      } catch {
        raw = { text: text.slice(0, 2000) };
      }
      const resultCd = raw && typeof raw.resultCd === 'string' ? raw.resultCd : null;
      const c = classify(resultCd, res.status);
      return {
        ...c,
        ok: c.ok && res.ok,
        resultCd,
        resultMsg: raw && typeof raw.resultMsg === 'string' ? raw.resultMsg : res.ok ? null : `HTTP ${res.status}`,
        data: (raw?.data as Record<string, unknown>) ?? null,
        httpStatus: res.status,
        error: res.ok ? null : `HTTP ${res.status}`,
        url,
        durationMs: Date.now() - started,
        raw,
      };
    } catch (e) {
      const err = e as Error;
      const timedOut = err.name === 'TimeoutError' || err.name === 'AbortError';
      return { ok: false, retryable: true, resultCd: null, resultMsg: null, data: null, httpStatus: null, error: timedOut ? `Timed out after ${timeoutMs} ms` : `Network error: ${err.message}`, url, durationMs: Date.now() - started, raw: null };
    }
  }
}

/** In-process mock control unit (tests and development without the mock container). */
export class MockEtimsAdapter implements EtimsAdapter {
  readonly kind = EtimsAdapterKind.MOCK;
  constructor(private readonly mock: MockEtims = sharedMockEtims) {}

  async call(op: EtimsOperation, body: Record<string, unknown>, creds: EtimsCredentials, timeoutMs: number): Promise<EtimsCallResult> {
    const started = Date.now();
    const url = `mock:${ETIMS_PATHS.OSCU[op]}`;
    const reply = this.mock.handle(op, { tin: creds.tin, bhfid: creds.bhfId, cmckey: creds.cmcKey ?? undefined }, { tin: creds.tin, bhfId: creds.bhfId, ...structuredClone(body) });
    if (reply.network) {
      return { ok: false, retryable: true, resultCd: null, resultMsg: null, data: null, httpStatus: null, error: reply.network === 'timeout' ? `Timed out after ${timeoutMs} ms` : 'Network error: connection refused', url, durationMs: Date.now() - started, raw: null };
    }
    const raw = reply.body ?? null;
    const resultCd = raw && typeof raw.resultCd === 'string' ? raw.resultCd : null;
    const c = classify(resultCd, reply.status);
    return {
      ...c,
      ok: c.ok && reply.status < 400,
      resultCd,
      resultMsg: (raw?.resultMsg as string) ?? (reply.status >= 400 ? `HTTP ${reply.status}` : null),
      data: (raw?.data as Record<string, unknown>) ?? null,
      httpStatus: reply.status,
      error: reply.status >= 400 ? `HTTP ${reply.status}` : null,
      url,
      durationMs: Date.now() - started,
      raw,
    };
  }
}

export function createAdapter(kind: EtimsAdapterKind, baseUrl: string | null): EtimsAdapter {
  if (kind === EtimsAdapterKind.MOCK && !baseUrl) return new MockEtimsAdapter();
  if (kind === EtimsAdapterKind.MOCK) return new HttpEtimsAdapter(EtimsAdapterKind.OSCU, baseUrl!); // the mock container speaks OSCU
  if (!baseUrl) throw new Error(`${kind} needs a base URL`);
  return new HttpEtimsAdapter(kind, baseUrl);
}
