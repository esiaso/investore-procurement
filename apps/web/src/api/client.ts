/** Thin fetch wrapper: same-origin session cookie + CSRF header on every write. */

export const API_BASE = '/api/v1';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly body: { message?: string | string[]; code?: string; errors?: unknown } | null,
  ) {
    super(Array.isArray(body?.message) ? body!.message.join('; ') : (body?.message ?? `Request failed (${status})`));
  }

  get code(): string | undefined {
    return this.body?.code;
  }
}

let csrfToken: string | null = null;

export function setCsrfToken(token: string | null): void {
  csrfToken = token;
}

async function ensureCsrf(): Promise<string> {
  if (!csrfToken) {
    const res = await fetch(`${API_BASE}/auth/csrf`, { credentials: 'include' });
    csrfToken = ((await res.json()) as { csrfToken: string }).csrfToken;
  }
  return csrfToken;
}

type Query = Record<string, string | number | boolean | null | undefined>;

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  body?: unknown;
  query?: Query;
  form?: FormData;
}

export function buildUrl(path: string, query?: Query): string {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(query ?? {})) {
    if (v !== undefined && v !== null && v !== '') qs.set(k, String(v));
  }
  const s = qs.toString();
  return `${API_BASE}${path}${s ? `?${s}` : ''}`;
}

export async function api<T = unknown>(path: string, options: RequestOptions = {}): Promise<T> {
  const method = options.method ?? 'GET';
  const send = async () => {
    const headers: Record<string, string> = {};
    if (options.body !== undefined) headers['Content-Type'] = 'application/json';
    if (method !== 'GET') headers['x-csrf-token'] = await ensureCsrf();
    return fetch(buildUrl(path, options.query), {
      method,
      headers,
      credentials: 'include',
      body: options.form ?? (options.body !== undefined ? JSON.stringify(options.body) : undefined),
    });
  };

  let res = await send();
  if (res.status === 403 && method !== 'GET') {
    // Session was renewed (login/timeout): fetch a fresh token once and retry.
    const body = await res.clone().json().catch(() => null);
    if (body?.code === 'CSRF') {
      csrfToken = null;
      res = await send();
    }
  }
  if (res.status === 204) return undefined as T;
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new ApiError(res.status, data);
  return data as T;
}
