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
