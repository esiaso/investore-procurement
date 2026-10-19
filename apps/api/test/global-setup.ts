import 'reflect-metadata';
import { createClient } from 'redis';
import { DataSource } from 'typeorm';
import './env';
import { typeOrmOptions } from '../src/database/typeorm-options';
import { seedDatabase } from '../src/database/seeds/seed';

/** Fresh schema → migrations → reference + sample seed, once per test run. */
export default async function globalSetup(): Promise<void> {
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
