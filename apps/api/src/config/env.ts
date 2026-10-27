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
  /** Public URL of the web app, for links in emails (approve / reject links). Default: the first CORS origin. */
  appPublicUrl: string | null;
  /**
   * M-PESA payouts (Daraja B2C / B2B, transaction status, reversal). Secrets
   * live here only, never in the database or the code. `mock` = in-process
   * simulator; `sandbox` / `production` = Daraja.
   */
  /** Requests per minute per IP on the public callback endpoints. */
  callbackRateLimitPerMinute: number;
  mpesaPayout: {
    mode: 'mock' | 'sandbox' | 'production';
    baseUrl: string | null;
    consumerKey: string | null;
    consumerSecret: string | null;
    /** Paying shortcode (B2C / B2B org shortcode). */
    shortcode: string | null;
    initiatorName: string | null;
    /** Initiator password encrypted with Safaricom's public certificate (as issued for the API). */
    securityCredential: string | null;
    /** Public base URL Safaricom calls back (…/api/v1/callbacks/mpesa-payouts/…). */
    callbackBaseUrl: string | null;
    /** Secret in the callback path (Daraja callbacks carry no credentials). */
    callbackToken: string | null;
    /** Comma-separated source IPs accepted on the callbacks (empty = any; behind a proxy set TRUST_PROXY). */
    callbackAllowedIps: string[];
    timeoutMs: number;
  };
  /**
   * Background jobs: `queue` = BullMQ on Redis, processed by the worker process;
   * `inline` = run immediately in the calling process (tests, development); `off`.
   */
  jobsMode: 'queue' | 'inline' | 'off';
  /** Sample data only: URL of the mock-etims container for the sample outlets (empty = in-process mock). */
  sampleEtimsUrl: string | null;
  /** Sample data only: FHIR base of the mock-hmis container (empty = in-process mock). */
  sampleHmisUrl: string | null;
  /**
   * Attachment storage: s3 (MinIO or any S3-compatible store) or local
   * (a directory; development and tests without MinIO).
   */
  storage: {
    driver: 's3' | 'local';
    endpoint: string | null;
    region: string;
    bucket: string;
    accessKey: string | null;
    secretKey: string | null;
    localDir: string;
  };
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

function storageDriver(v: string | undefined): Env['storage']['driver'] {
  const d = (v || 'local').toLowerCase();
  if (d !== 's3' && d !== 'local') throw new Error(`STORAGE_DRIVER must be s3 or local (got ${v})`);
  return d;
}

const DEV_SECRET = 'dev-only-session-secret-change-me-0123456789';
const DEV_TOTP_KEY = '0'.repeat(64);
const DEV_DATA_KEY = 'a'.repeat(64);

function payoutMode(v: string | undefined): 'mock' | 'sandbox' | 'production' {
  const m = (v || 'mock').toLowerCase();
  if (m !== 'mock' && m !== 'sandbox' && m !== 'production') throw new Error('MPESA_PAYOUT_MODE must be mock, sandbox or production');
  return m;
}

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
    appPublicUrl: e.APP_PUBLIC_URL || null,
    callbackRateLimitPerMinute: int(e.CALLBACK_RATE_LIMIT_PER_MINUTE, 120),
    mpesaPayout: {
      mode: payoutMode(e.MPESA_PAYOUT_MODE),
      baseUrl: e.MPESA_PAYOUT_BASE_URL || null,
      consumerKey: e.MPESA_PAYOUT_CONSUMER_KEY || null,
      consumerSecret: e.MPESA_PAYOUT_CONSUMER_SECRET || null,
      shortcode: e.MPESA_PAYOUT_SHORTCODE || null,
      initiatorName: e.MPESA_PAYOUT_INITIATOR_NAME || null,
      securityCredential: e.MPESA_PAYOUT_SECURITY_CREDENTIAL || null,
      callbackBaseUrl: e.MPESA_PAYOUT_CALLBACK_BASE_URL || null,
      callbackToken: e.MPESA_PAYOUT_CALLBACK_TOKEN || null,
      callbackAllowedIps: (e.MPESA_PAYOUT_CALLBACK_ALLOWED_IPS ?? '').split(',').map((x) => x.trim()).filter(Boolean),
      timeoutMs: int(e.MPESA_PAYOUT_TIMEOUT_MS, 20_000),
    },
    jobsMode: jobsMode(e.JOBS_MODE),
    sampleEtimsUrl: e.SAMPLE_ETIMS_URL || null,
    sampleHmisUrl: e.SAMPLE_HMIS_URL || null,
    storage: {
      driver: storageDriver(e.STORAGE_DRIVER),
      endpoint: e.S3_ENDPOINT || null,
      region: e.S3_REGION || 'us-east-1',
      bucket: e.S3_BUCKET || 'silp-attachments',
      accessKey: e.S3_ACCESS_KEY || null,
      secretKey: e.S3_SECRET_KEY || null,
      localDir: e.STORAGE_LOCAL_DIR || './var/attachments',
    },
  };
  return cached;
}

/** Test helper: forget the cached env so a test can change process.env. */
export function resetEnvCache(): void {
  cached = null;
}
