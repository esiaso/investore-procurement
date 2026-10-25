/**
 * Points the API at the test database/redis. Runs before every test file and
 * in global setup. Override with TEST_DATABASE_URL / TEST_REDIS_URL.
 */
process.env.NODE_ENV = 'test';
process.env.DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? 'postgres://silp:silp_dev_password@localhost:5432/silp_test';
process.env.REDIS_URL = process.env.TEST_REDIS_URL ?? 'redis://localhost:6379/1';
process.env.DB_MIGRATIONS_RUN = 'false';
process.env.COOKIE_SECURE = 'false';
process.env.SEED_ON_START = 'false';
process.env.SEED_DEFAULT_PASSWORD = process.env.TEST_SEED_PASSWORD ?? 'Test#Passw0rd!2026';

export const TEST_PASSWORD = process.env.SEED_DEFAULT_PASSWORD;
process.env.JOBS_MODE = 'inline';
// Attachments: MinIO in the compose test profile, a temporary directory otherwise.
process.env.STORAGE_DRIVER = process.env.TEST_STORAGE_DRIVER ?? 'local';
process.env.STORAGE_LOCAL_DIR = process.env.TEST_STORAGE_LOCAL_DIR ?? '/tmp/silp-test-attachments';
process.env.S3_BUCKET = process.env.TEST_S3_BUCKET ?? 'silp-test-attachments';
if (process.env.TEST_S3_ENDPOINT) process.env.S3_ENDPOINT = process.env.TEST_S3_ENDPOINT;
if (process.env.TEST_S3_ACCESS_KEY) process.env.S3_ACCESS_KEY = process.env.TEST_S3_ACCESS_KEY;
if (process.env.TEST_S3_SECRET_KEY) process.env.S3_SECRET_KEY = process.env.TEST_S3_SECRET_KEY;
