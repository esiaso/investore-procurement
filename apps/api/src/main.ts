import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { DataSource } from 'typeorm';
import { AppModule } from './app.module';
import { API_PREFIX, configureApp, createRedisClient } from './bootstrap';
import { loadEnv } from './config/env';
import { seedSamplePurchasing } from './database/seeds/sample-purchasing';
import { seedDatabase } from './database/seeds/seed';
import { seedSampleStores } from './database/seeds/sample-stores';
import { seedSamplePlanning } from './database/seeds/sample-planning';
import { seedSamplePharmacy } from './database/seeds/sample-pharmacy';
import { seedSampleStrategic } from './database/seeds/sample-strategic';
import { seedSampleLogistics } from './database/seeds/sample-logistics';
import { seedSampleHmis } from './database/seeds/sample-hmis';

async function main() {
  const env = loadEnv();
  const redis = await createRedisClient(env);
  const app = await NestFactory.create<NestExpressApplication>(AppModule);
  configureApp(app, env, redis);
  app.enableShutdownHooks();

  // Run onModuleInit hooks (approval handlers, link resolvers) before seeding through services.
  await app.init();
  if (env.seedOnStart) {
    await seedDatabase(app.get(DataSource), { defaultPassword: env.seedDefaultPassword, sample: true });
    await seedSamplePurchasing(app);
    await seedSampleStores(app);
    await seedSamplePlanning(app);
    await seedSamplePharmacy(app);
    await seedSampleStrategic(app);
    await seedSampleLogistics(app);
    await seedSampleHmis(app);
  }

  await app.listen(env.port);
  console.log(`API listening on http://localhost:${env.port}/${API_PREFIX} (docs: /${API_PREFIX}/docs)`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
