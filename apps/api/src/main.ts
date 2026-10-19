import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { DataSource } from 'typeorm';
import { AppModule } from './app.module';
import { API_PREFIX, configureApp, createRedisClient } from './bootstrap';
import { loadEnv } from './config/env';
import { seedSamplePurchasing } from './database/seeds/sample-purchasing';
import { seedDatabase } from './database/seeds/seed';

async function main() {
  const env = loadEnv();
  const redis = await createRedisClient(env);
  const app = await NestFactory.create<NestExpressApplication>(AppModule);
  configureApp(app, env, redis);
  app.enableShutdownHooks();

  if (env.seedOnStart) {
    await seedDatabase(app.get(DataSource), { defaultPassword: env.seedDefaultPassword, sample: true });
    await seedSamplePurchasing(app);
  }

  await app.listen(env.port);
  console.log(`API listening on http://localhost:${env.port}/${API_PREFIX} (docs: /${API_PREFIX}/docs)`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
