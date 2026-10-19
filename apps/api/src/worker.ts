import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { JobsService } from './modules/jobs/jobs.service';

/**
 * Background worker: no HTTP. Consumes the BullMQ queue and keeps the job
 * schedules (setting `jobs.schedules`) registered in Redis. Run one instance.
 */
async function main() {
  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['log', 'warn', 'error'] });
  app.enableShutdownHooks();
  await app.get(JobsService).startWorker();
  new Logger('Worker').log('ready');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
