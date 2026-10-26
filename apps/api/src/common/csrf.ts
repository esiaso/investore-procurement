import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
/** Third-party callbacks (Safaricom Daraja): no cookie, authenticated by a secret in the path. */
const CALLBACKS = /^\/api\/v\d+\/callbacks\//;
export const CSRF_HEADER = 'x-csrf-token';

/** Synchronizer-token CSRF protection: token lives in the server-side session. */
export function ensureCsrfToken(req: Request): string {
  if (!req.session.csrfToken) req.session.csrfToken = randomBytes(32).toString('base64url');
  return req.session.csrfToken;
}

export function csrfMiddleware(req: Request, res: Response, next: NextFunction): void {
  if (SAFE_METHODS.has(req.method)) return next();
  // API-key (machine) calls carry no cookie, so cross-site forgery does not apply.
  if ((req as Request & { apiClient?: unknown }).apiClient) return next();
  if (CALLBACKS.test(req.path)) return next();
  const expected = req.session?.csrfToken;
  const provided = req.get(CSRF_HEADER);
  if (expected && provided) {
    const a = Buffer.from(expected);
    const b = Buffer.from(provided);
    if (a.length === b.length && timingSafeEqual(a, b)) return next();
  }
  res.status(403).json({ statusCode: 403, message: 'Invalid or missing CSRF token', code: 'CSRF' });
}
