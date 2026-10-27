import type { NextFunction, Request, Response } from 'express';

/**
 * Fixed-window rate limit per client IP, in memory (per API process). Used on
 * the public callback endpoints (M-PESA, Daraja payouts) so a flood cannot
 * tie the API up; behind a proxy set TRUST_PROXY so req.ip is the caller.
 */
export function rateLimit(opts: { windowMs: number; max: number }) {
  const hits = new Map<string, { count: number; resetAt: number }>();
  return (req: Request, res: Response, next: NextFunction) => {
    const now = Date.now();
    const key = req.ip ?? 'unknown';
    let h = hits.get(key);
    if (!h || h.resetAt <= now) {
      h = { count: 0, resetAt: now + opts.windowMs };
      hits.set(key, h);
      // Forget idle callers now and then.
      if (hits.size > 10_000) for (const [k, v] of hits) if (v.resetAt <= now) hits.delete(k);
    }
    h.count++;
    if (h.count > opts.max) {
      res.setHeader('Retry-After', String(Math.ceil((h.resetAt - now) / 1000)));
      res.status(429).json({ statusCode: 429, message: 'Too many requests' });
      return;
    }
    next();
  };
}
