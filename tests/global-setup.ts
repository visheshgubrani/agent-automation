import { fileURLToPath } from 'node:url'
import { drizzle } from 'drizzle-orm/node-postgres'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import { Pool } from 'pg'

function databaseName(url: string): string {
  return decodeURIComponent(new URL(url).pathname.replace(/^\//, ''))
}

/**
 * Vitest global setup: validate the target is an isolated test database and apply
 * migrations once before workers start. Never touches the dev `app` database.
 */
export default async function setup(): Promise<void> {
  try {
    process.loadEnvFile()
  } catch {
    // No .env file — rely on real env vars.
  }

  const url = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL
  if (!url) {
    throw new Error('TEST_DATABASE_URL or DATABASE_URL is required for database tests')
  }

  const name = databaseName(url)
  if (!name.endsWith('_test')) {
    throw new Error(`Refusing to run schema tests against non-test database "${name}"`)
  }

  const pool = new Pool({ connectionString: url, max: 1 })
  const db = drizzle({ client: pool })

  try {
    await migrate(db, {
      migrationsFolder: fileURLToPath(new URL('../src/db/migrations', import.meta.url)),
    })
  } finally {
    await pool.end()
  }
}
