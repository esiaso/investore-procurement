import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { DataSource } from 'typeorm';
import { AppModule } from '../../app.module';
import { loadEnv } from '../../config/env';
import { typeOrmOptions } from '../typeorm-options';
import { seedSamplePurchasing } from './sample-purchasing';
import { seedDatabase } from './seed';

/**
 * CLI: run pending migrations, then seed reference (+ sample unless
 * --reference-only). Sample procurement documents need the full application
 * (approvals, budgets, stock posting), so they are created in an app context.
 */
async function run() {
  const env = loadEnv();
  const sample = !process.argv.includes('--reference-only');
  const dataSource = await new DataSource(typeOrmOptions()).initialize();
  try {
    await dataSource.runMigrations();
    await seedDatabase(dataSource, { defaultPassword: env.seedDefaultPassword, sample });
  } finally {
    await dataSource.destroy();
  }
  if (sample) {
    const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error'] });
    try {
      await seedSamplePurchasing(app);
    } finally {
      await app.close();
    }
  }
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
