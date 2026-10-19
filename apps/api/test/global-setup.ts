import 'reflect-metadata';
import { Client } from 'pg';
import { createClient } from 'redis';
import { DataSource } from 'typeorm';
import './env';
import { typeOrmOptions } from '../src/database/typeorm-options';
import { seedDatabase } from '../src/database/seeds/seed';

/** Fresh schema → migrations → reference + sample seed, once per test run. */
async function ensureDatabase(url: string): Promise<void> {
  const target = new URL(url);
  const name = target.pathname.slice(1);
  const admin = new URL(url);
  admin.pathname = '/postgres';
  const client = new Client({ connectionString: admin.toString() });
  await client.connect();
  try {
    const { rowCount } = await client.query('SELECT 1 FROM pg_database WHERE datname = $1', [name]);
    if (!rowCount) await client.query(`CREATE DATABASE "${name.replace(/"/g, '')}"`);
  } finally {
    await client.end();
  }
}

export default async function globalSetup(): Promise<void> {
  await ensureDatabase(process.env.DATABASE_URL!);
  const ds = await new DataSource(typeOrmOptions()).initialize();
  try {
    if (!/_test\b/.test(ds.driver.database ?? '')) {
      throw new Error(`Refusing to wipe non-test database "${ds.driver.database}"`);
    }
    await ds.query('DROP SCHEMA public CASCADE');
    await ds.query('CREATE SCHEMA public');
    await ds.runMigrations();
    await seedDatabase(ds, { defaultPassword: process.env.SEED_DEFAULT_PASSWORD!, sample: true, log: () => undefined });
  } finally {
    await ds.destroy();
  }

  const redis = createClient({ url: process.env.REDIS_URL });
  await redis.connect();
  await redis.flushDb();
  await redis.quit();
}
