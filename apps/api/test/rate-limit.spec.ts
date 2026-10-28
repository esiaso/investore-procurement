import express from 'express';
import request from 'supertest';
import { createClient, RedisClientType } from 'redis';
import { rateLimit } from '../src/common/rate-limit';

/** Two API "processes" (separate middleware instances) behind one Redis share the limit. */
describe('callback rate limit (Redis)', () => {
  let redis: RedisClientType;
  const prefix = `silp:rl:spec:${Date.now()}:`;

  beforeAll(async () => {
    redis = createClient({ url: process.env.REDIS_URL }) as RedisClientType;
    await redis.connect();
  });
  afterAll(async () => {
    for await (const k of redis.scanIterator({ MATCH: `${prefix}*` })) await redis.del(k);
    await redis.quit();
  });

  const server = (r?: RedisClientType) => {
    const app = express();
    app.use(rateLimit({ windowMs: 60_000, max: 5, redis: r, prefix }));
    app.post('/cb', (_req, res) => res.status(200).json({ ok: true }));
    return app;
  };

  it('counts hits from every process against one budget', async () => {
    const a = server(redis);
    const b = server(redis);
    const codes: number[] = [];
    for (let i = 0; i < 4; i++) codes.push((await request(a).post('/cb')).status);
    for (let i = 0; i < 4; i++) codes.push((await request(b).post('/cb')).status);
    expect(codes.filter((c) => c === 200)).toHaveLength(5);
    expect(codes.filter((c) => c === 429)).toHaveLength(3);
    const res = await request(b).post('/cb');
    expect(res.status).toBe(429);
    expect(Number(res.headers['retry-after'])).toBeGreaterThan(0);
  });

  it('falls back to a per-process limit when Redis is not available', async () => {
    const offline = createClient({ url: process.env.REDIS_URL }) as RedisClientType; // never connected
    const app = server(offline);
    const codes: number[] = [];
    for (let i = 0; i < 7; i++) codes.push((await request(app).post('/cb')).status);
    expect(codes.filter((c) => c === 200)).toHaveLength(5);
  });
});
