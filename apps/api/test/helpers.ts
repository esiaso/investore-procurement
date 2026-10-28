import 'reflect-metadata';
import './env';
import { Test } from '@nestjs/testing';
import type { NestExpressApplication } from '@nestjs/platform-express';
import type { RedisClientType } from 'redis';
import request from 'supertest';
import type TestAgent from 'supertest/lib/agent';
import { DataSource } from 'typeorm';
import { AppModule } from '../src/app.module';
import { configureApp, createRedisClient } from '../src/bootstrap';
import { loadEnv } from '../src/config/env';
import { TEST_PASSWORD } from './env';

export const API = '/api/v1';

export interface TestContext {
  app: NestExpressApplication;
  ds: DataSource;
  redis: RedisClientType;
  close(): Promise<void>;
}

export async function createTestApp(): Promise<TestContext> {
  const env = loadEnv();
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  const app = moduleRef.createNestApplication<NestExpressApplication>({ logger: ['error'] });
  const redis = await createRedisClient(env);
  // Rate-limit counters live in Redis and are shared across suites; start each suite clean.
  for await (const k of redis.scanIterator({ MATCH: 'silp:rl:*' })) await redis.del(k);
  configureApp(app, env, redis);
  await app.init();
  return {
    app,
    ds: app.get(DataSource),
    redis,
    async close() {
      await app.close();
      await redis.quit();
    },
  };
}

/** A cookie-keeping client that sends the CSRF header on every request. */
export class Client {
  readonly agent: TestAgent;
  csrf = '';

  constructor(ctx: TestContext) {
    this.agent = request.agent(ctx.app.getHttpServer());
  }

  async refreshCsrf(): Promise<string> {
    const res = await this.agent.get(`${API}/auth/csrf`).expect(200);
    this.csrf = res.body.csrfToken;
    return this.csrf;
  }

  async login(username: string, password = TEST_PASSWORD) {
    if (!this.csrf) await this.refreshCsrf();
    const res = await this.agent
      .post(`${API}/auth/login`)
      .set('x-csrf-token', this.csrf)
      .send({ username, password });
    if (res.body?.csrfToken) this.csrf = res.body.csrfToken;
    return res;
  }

  get(path: string) {
    return this.agent.get(`${API}${path}`);
  }
  post(path: string, body?: object) {
    return this.agent.post(`${API}${path}`).set('x-csrf-token', this.csrf).send(body);
  }
  patch(path: string, body?: object) {
    return this.agent.patch(`${API}${path}`).set('x-csrf-token', this.csrf).send(body);
  }
  put(path: string, body?: object) {
    return this.agent.put(`${API}${path}`).set('x-csrf-token', this.csrf).send(body);
  }
  delete(path: string) {
    return this.agent.delete(`${API}${path}`).set('x-csrf-token', this.csrf);
  }
}

export async function loggedIn(ctx: TestContext, username: string): Promise<Client> {
  const client = new Client(ctx);
  const res = await client.login(username);
  if (res.status !== 200) throw new Error(`login ${username} failed: ${res.status} ${JSON.stringify(res.body)}`);
  return client;
}

export const uniq = (prefix: string) => `${prefix}-${Math.random().toString(36).slice(2, 8)}`.toUpperCase();

export async function idByCode(ds: DataSource, table: string, code: string): Promise<string> {
  const [row] = await ds.query(`SELECT id FROM "${table}" WHERE code = $1`, [code]);
  if (!row) throw new Error(`${table} ${code} not found`);
  return row.id;
}
