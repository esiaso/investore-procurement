import { BadRequestException, Injectable, Logger, NotFoundException, OnModuleDestroy } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { ConnectionOptions, Queue, Worker } from 'bullmq';
import { DataSource } from 'typeorm';
import { JobRunStatus } from '@sil/shared';
import { RequestContext } from '../../common/request-context';
import { loadEnv } from '../../config/env';
import { SettingsService } from '../settings/settings.service';
import { JobRun } from './jobs.entities';

export type JobHandler = (data: Record<string, unknown>) => Promise<Record<string, unknown> | void>;

interface Registered {
  description: string;
  handler: JobHandler;
}

const QUEUE = 'sil-jobs';

/** bullmq wants ioredis options; derive them from REDIS_URL. */
export function redisConnection(url: string): ConnectionOptions {
  const u = new URL(url);
  return {
    host: u.hostname,
    port: Number(u.port || 6379),
    username: u.username || undefined,
    password: u.password ? decodeURIComponent(u.password) : undefined,
    db: u.pathname.length > 1 ? Number(u.pathname.slice(1)) : 0,
    maxRetriesPerRequest: null,
  };
}

/**
 * Background jobs. Modules register handlers by name. In `queue` mode the API
 * enqueues to BullMQ and the worker process (src/worker.ts) runs them and owns
 * the schedules (setting `jobs.schedules`); in `inline` mode (tests, dev)
 * `enqueue` runs the handler straight away. Every run is recorded in job_run.
 */
@Injectable()
export class JobsService implements OnModuleDestroy {
  private readonly log = new Logger('Jobs');
  private readonly handlers = new Map<string, Registered>();
  private queue: Queue | null = null;
  private worker: Worker | null = null;

  constructor(
    @InjectDataSource() private readonly ds: DataSource,
    private readonly settings: SettingsService,
  ) {}

  register(name: string, description: string, handler: JobHandler): void {
    this.handlers.set(name, { description, handler });
  }

  registered() {
    return [...this.handlers.entries()].map(([name, r]) => ({ name, description: r.description }));
  }

  private getQueue(): Queue {
    this.queue ??= new Queue(QUEUE, { connection: redisConnection(loadEnv().redisUrl) });
    return this.queue;
  }

  /** Runs a job now in this process and records the run. */
  async run(name: string, data: Record<string, unknown> = {}, trigger = 'manual', userId: string | null = null): Promise<JobRun> {
    const job = this.handlers.get(name);
    if (!job) throw new NotFoundException(`Unknown job ${name}`);
    const repo = this.ds.getRepository(JobRun);
    const run = await repo.save(repo.create({ name, status: JobRunStatus.RUNNING, trigger, params: data, userId }));
    try {
      const result = await RequestContext.run({ username: `system:job:${name}`, userId, storeIds: null }, () => job.handler(data));
      run.status = JobRunStatus.SUCCEEDED;
      run.result = (result ?? {}) as Record<string, unknown>;
    } catch (e) {
      run.status = JobRunStatus.FAILED;
      run.error = ((e as Error).stack ?? String(e)).slice(0, 2000);
      this.log.error(`job ${name} failed: ${(e as Error).message}`);
    }
    run.finishedAt = new Date();
    return repo.save(run);
  }

  /**
   * Asks for a job to run: queued for the worker (`queue` mode), run here
   * (`inline`), or dropped (`off`). A `dedupeKey` collapses repeated requests
   * while one is still waiting in the queue.
   */
  async enqueue(name: string, data: Record<string, unknown> = {}, opts: { trigger?: string; userId?: string | null; dedupeKey?: string } = {}) {
    if (!this.handlers.has(name)) throw new NotFoundException(`Unknown job ${name}`);
    const mode = loadEnv().jobsMode;
    if (mode === 'off') return { mode, queued: false };
    if (mode === 'inline') return { mode, queued: false, run: await this.run(name, data, opts.trigger ?? 'manual', opts.userId ?? null) };
    const job = await this.getQueue().add(
      name,
      { data, trigger: opts.trigger ?? 'manual', userId: opts.userId ?? null },
      { jobId: opts.dedupeKey ? `${name}:${opts.dedupeKey}` : undefined, removeOnComplete: 1000, removeOnFail: 1000, attempts: 3, backoff: { type: 'exponential', delay: 30_000 } },
    );
    return { mode, queued: true, jobId: job.id };
  }

  /** Worker process only: consumes the queue and keeps the schedules in step with settings. */
  async startWorker(): Promise<void> {
    const connection = redisConnection(loadEnv().redisUrl);
    this.worker = new Worker(
      QUEUE,
      async (job) => {
        const payload = job.data as { data?: Record<string, unknown>; trigger?: string; userId?: string | null };
        const run = await this.run(job.name, payload.data ?? {}, payload.trigger ?? 'schedule', payload.userId ?? null);
        if (run.status === JobRunStatus.FAILED) throw new Error(run.error ?? 'failed');
        return run.result;
      },
      { connection, concurrency: 1 },
    );
    this.worker.on('error', (e) => this.log.warn(`worker error: ${e.message}`));
    await this.syncSchedules();
    this.log.log(`worker started; jobs: ${[...this.handlers.keys()].join(', ')}`);
  }

  /** Creates/updates a BullMQ job scheduler per entry of `jobs.schedules`; removes the rest. */
  async syncSchedules(): Promise<Record<string, string>> {
    const schedules = await this.settings.get('jobs.schedules');
    const tz = await this.settings.get('locale.timezone');
    const queue = this.getQueue();
    for (const [name, pattern] of Object.entries(schedules)) {
      if (!this.handlers.has(name)) {
        this.log.warn(`schedule for unknown job ${name} ignored`);
        continue;
      }
      await queue.upsertJobScheduler(name, { pattern, tz }, { name, data: { data: {}, trigger: 'schedule' } });
    }
    for (const s of await queue.getJobSchedulers()) {
      const key = s.key ?? s.name;
      if (!(key in schedules)) await queue.removeJobScheduler(key);
    }
    return schedules;
  }

  async status() {
    const schedules = await this.settings.get('jobs.schedules');
    const last: { name: string; status: string; started_at: Date; finished_at: Date | null; result: unknown; error: string | null }[] = await this.ds.query(
      `SELECT DISTINCT ON (name) name, status, started_at, finished_at, result, error FROM job_run ORDER BY name, started_at DESC`,
    );
    return {
      mode: loadEnv().jobsMode,
      jobs: this.registered().map((j) => {
        const l = last.find((x) => x.name === j.name);
        return {
          ...j,
          schedule: schedules[j.name] ?? null,
          lastRun: l ? { status: l.status, startedAt: l.started_at, finishedAt: l.finished_at, result: l.result, error: l.error } : null,
        };
      }),
    };
  }

  runs(name?: string, limit = 50) {
    if (limit > 500) throw new BadRequestException('limit too large');
    return this.ds.getRepository(JobRun).find({ where: name ? { name } : {}, order: { startedAt: 'DESC' }, take: limit });
  }

  async onModuleDestroy() {
    await this.worker?.close();
    await this.queue?.close();
  }
}
