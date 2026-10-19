import 'reflect-metadata';
import { DataSource } from 'typeorm';
import { loadEnv } from '../../config/env';
import { typeOrmOptions } from '../typeorm-options';
import { seedDatabase } from './seed';

/** CLI: run pending migrations, then seed reference (+ sample unless --reference-only). */
async function run() {
  const env = loadEnv();
  const dataSource = await new DataSource(typeOrmOptions()).initialize();
  try {
    await dataSource.runMigrations();
    await seedDatabase(dataSource, {
      defaultPassword: env.seedDefaultPassword,
      sample: !process.argv.includes('--reference-only'),
    });
  } finally {
    await dataSource.destroy();
  }
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
