/**
 * Process environment, parsed once. Only infrastructure concerns live here;
 * business configuration (tax rates, prefixes, thresholds, locale) lives in
 * database config tables.
 */
export interface Env {
  nodeEnv: string;
  port: number;
  databaseUrl: string;
  redisUrl: string;
  sessionSecret: string;
  sessionIdleTimeoutMinutes: number;
  sessionAbsoluteTimeoutHours: number;
  cookieSecure: boolean;
  trustProxy: boolean;
  corsOrigins: string[];
  totpEncryptionKey: Buffer;
  migrationsRun: boolean;
  seedOnStart: boolean;
  seedDefaultPassword: string | null;
  importMaxFileMb: number;
  dbLogging: boolean;
  /** AES-256 key for sensitive columns (supplier bank details). */
  dataEncryptionKey: Buffer;
  /** e.g. smtp://mailpit:1025; empty disables the outbox sender. */
  smtpUrl: string | null;
  mailPollSeconds: number;
  /** Chromium for PDF rendering; default: Playwright's bundled browser. */
  chromiumPath: string | null;
  /**
   * Background jobs: `queue` = BullMQ on Redis, processed by the worker process;
   * `inline` = run immediately in the calling process (tests, development); `off`.
   */
  jobsMode: 'queue' | 'inline' | 'off';
  /** Sample data only: URL of the mock-etims container for the sample outlets (empty = in-process mock). */
  sampleEtimsUrl: string | null;
}

function bool(v: string | undefined, def: boolean): boolean {
  if (v === undefined || v === '') return def;
  return ['1', 'true', 'yes', 'on'].includes(v.toLowerCase());
}

function int(v: string | undefined, def: number): number {
  if (v === undefined || v === '') return def;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`Invalid number in environment: ${v}`);
  return n;
}

function jobsMode(v: string | undefined): Env['jobsMode'] {
  const mode = (v || 'inline').toLowerCase();
  if (mode !== 'queue' && mode !== 'inline' && mode !== 'off') throw new Error(`JOBS_MODE must be queue, inline or off (got ${v})`);
  return mode;
}

const DEV_SECRET = 'dev-only-session-secret-change-me-0123456789';
const DEV_TOTP_KEY = '0'.repeat(64);
const DEV_DATA_KEY = 'a'.repeat(64);

let cached: Env | null = null;

export function loadEnv(): Env {
  if (cached) return cached;
  const e = process.env;
  const nodeEnv = e.NODE_ENV ?? 'development';
  const isProd = nodeEnv === 'production';

  const sessionSecret = e.SESSION_SECRET ?? (isProd ? '' : DEV_SECRET);
  if (sessionSecret.length < 32) throw new Error('SESSION_SECRET must be at least 32 characters');

  const totpHex = e.TOTP_ENCRYPTION_KEY ?? (isProd ? '' : DEV_TOTP_KEY);
  if (!/^[0-9a-fA-F]{64}$/.test(totpHex)) {
    throw new Error('TOTP_ENCRYPTION_KEY must be 64 hex characters (32 bytes)');
  }
  const dataHex = e.DATA_ENCRYPTION_KEY ?? (isProd ? '' : DEV_DATA_KEY);
  if (!/^[0-9a-fA-F]{64}$/.test(dataHex)) {
    throw new Error('DATA_ENCRYPTION_KEY must be 64 hex characters (32 bytes)');
  }
  // Placeholder values (dev defaults, docker-compose defaults) are refused in production.
  if (isProd && (sessionSecret.startsWith('dev-only') || /^(.)\1+$/.test(totpHex) || /^(.)\1+$/.test(dataHex))) {
    throw new Error('Development secrets must not be used in production');
  }

  cached = {
    nodeEnv,
    port: int(e.PORT, 3000),
    databaseUrl: e.DATABASE_URL ?? 'postgres://silp:silp_dev_password@localhost:5432/silp',
    redisUrl: e.REDIS_URL ?? 'redis://localhost:6379/0',
    sessionSecret,
    sessionIdleTimeoutMinutes: int(e.SESSION_IDLE_TIMEOUT_MINUTES, 30),
    sessionAbsoluteTimeoutHours: int(e.SESSION_ABSOLUTE_TIMEOUT_HOURS, 12),
    cookieSecure: bool(e.COOKIE_SECURE, isProd),
    trustProxy: bool(e.TRUST_PROXY, false),
    corsOrigins: (e.CORS_ORIGINS ?? 'http://localhost:5173,http://localhost:8080')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    totpEncryptionKey: Buffer.from(totpHex, 'hex'),
    migrationsRun: bool(e.DB_MIGRATIONS_RUN, true),
    seedOnStart: bool(e.SEED_ON_START, false),
    seedDefaultPassword: e.SEED_DEFAULT_PASSWORD || null,
    importMaxFileMb: int(e.IMPORT_MAX_FILE_MB, 10),
    dbLogging: bool(e.DB_LOGGING, false),
    dataEncryptionKey: Buffer.from(dataHex, 'hex'),
    smtpUrl: e.SMTP_URL || null,
    mailPollSeconds: int(e.MAIL_POLL_SECONDS, 10),
    chromiumPath: e.CHROMIUM_PATH || null,
    jobsMode: jobsMode(e.JOBS_MODE),
    sampleEtimsUrl: e.SAMPLE_ETIMS_URL || null,
  };
  return cached;
}

/** Test helper: forget the cached env so a test can change process.env. */
export function resetEnvCache(): void {
  cached = null;
}
