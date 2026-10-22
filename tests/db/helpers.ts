import { db, pool } from '../../src/db/index.js'

const url = process.env.DATABASE_URL
if (!url) throw new Error('DATABASE_URL is required for database tests')

const name = decodeURIComponent(new URL(url).pathname.replace(/^\//, ''))
if (!name.endsWith('_test')) {
  throw new Error(`Refusing to truncate non-test database "${name}"`)
}

/** Truncate app tables between tests. Leaves the drizzle and pgboss schemas alone. */
export async function truncateAllTables(): Promise<void> {
  const { rows } = await pool.query<{ tablename: string }>(
    "select tablename from pg_tables where schemaname = 'public'",
  )
  if (rows.length === 0) return

  const tables = rows
    .map(({ tablename }) => `"public"."${tablename.replaceAll('"', '""')}"`)
    .join(', ')
  await pool.query(`truncate table ${tables} restart identity cascade`)
}

export async function closeTestDb(): Promise<void> {
  await pool.end()
}

export { db, pool }
