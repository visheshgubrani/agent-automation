import { defineConfig } from 'vitest/config'

const testDatabaseUrl = 'postgres://postgres:postgres@localhost:5434/app_test'

// Deterministic, non-secret test fixtures. Real env values are never used by tests.
const testEncryptionKey = Buffer.alloc(32, 7).toString('base64')

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    // Migrations are applied once to app_test before any worker starts.
    globalSetup: ['./tests/global-setup.ts'],
    // DB invariant tests share one database and truncate between tests, so run files serially.
    fileParallelism: false,
    testTimeout: 30_000,
    // Real env vars win over .env (process.loadEnvFile doesn't override), so everything
    // importing src/env.ts inside tests points at the test DB and uses fake integration config.
    env: {
      NODE_ENV: 'test',
      LOG_LEVEL: 'info',
      DATABASE_URL: testDatabaseUrl,
      TEST_DATABASE_URL: testDatabaseUrl,
      TELEGRAM_BOT_TOKEN: '123456789:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
      TELEGRAM_CHAT_ID: '1',
      TOKEN_ENCRYPTION_KEYS: `1:${testEncryptionKey}`,
      TOKEN_ENCRYPTION_ACTIVE_KEY_VERSION: '1',
      HEALTH_DETAILS_TOKEN: 'test-health-details-token',
      HEARTBEAT_CRON: '0 9 * * *',
    },
  },
})
