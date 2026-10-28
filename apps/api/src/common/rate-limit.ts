import type { NextFunction, Request, Response } from 'express';
import type { RedisClientType } from 'redis';

/**
 * Fixed-window rate limit per client IP. With a Redis client the counter is
 * shared by every API process (INCR + PEXPIRE on one key per IP and window), so
 * the limit holds behind a load balancer; without one it falls back to memory.
 * If Redis is unreachable the request is let through (fail open) rather than
 * dropping genuine Safaricom callbacks. Used on the public callback endpoints;
 * behind a proxy set TRUST_PROXY so req.ip is the caller.
 */
export function rateLimit(opts: { windowMs: number; max: number; redis?: RedisClientType; prefix?: string }) {
  const prefix = opts.prefix ?? 'silp:rl:';
  const hits = new Map<string, { count: number; resetAt: number }>();

  const memoryHit = (key: string, now: number) => {
    let h = hits.get(key);
    if (!h || h.resetAt <= now) {
      h = { count: 0, resetAt: now + opts.windowMs };
      hits.set(key, h);
      // Forget idle callers now and then.
      if (hits.size > 10_000) for (const [k, v] of hits) if (v.resetAt <= now) hits.delete(k);
    }
    h.count++;
    return { count: h.count, resetAt: h.resetAt };
  };

  const redisHit = async (key: string, now: number) => {
    const window = Math.floor(now / opts.windowMs);
    const k = `${prefix}${key}:${window}`;
    const [count] = (await opts.redis!.multi().incr(k).pExpire(k, opts.windowMs).exec()) as unknown as [number];
    return { count: Number(count), resetAt: (window + 1) * opts.windowMs };
  };

  return (req: Request, res: Response, next: NextFunction) => {
    const now = Date.now();
    const key = req.ip ?? 'unknown';
    const decide = (h: { count: number; resetAt: number }) => {
      if (h.count > opts.max) {
        res.setHeader('Retry-After', String(Math.max(1, Math.ceil((h.resetAt - now) / 1000))));
        res.status(429).json({ statusCode: 429, message: 'Too many requests' });
        return;
      }
      next();
    };
    if (!opts.redis?.isReady) return decide(memoryHit(key, now));
    redisHit(key, now).then(decide, () => decide(memoryHit(key, now)));
  };
}
