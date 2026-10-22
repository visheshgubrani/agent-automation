import { drizzle } from 'drizzle-orm/node-postgres'
import { Pool } from 'pg'
import { env } from '../env.js'
import * as schema from './schema/index.js'

/** Create a Drizzle instance bound to any connection string (e.g. the test DB). */
export function createDb(connectionString: string) {
  const pool = new Pool({ connectionString, max: 10 })
  return { pool, db: drizzle({ client: pool, schema }) }
}

const { pool, db } = createDb(env.DATABASE_URL)

export { db, pool }
export type Db = ReturnType<typeof createDb>['db']
/**
 * Query surface shared by the root DB handle and a Drizzle transaction. Helpers that must run
 * inside a caller's transaction accept this instead of `Db`.
 */
export type DbSession = Pick<Db, 'select' | 'insert' | 'update' | 'delete'>

/** Cheap connectivity probe for /health. */
export async function checkDb(): Promise<boolean> {
  try {
    await pool.query('SELECT 1')
    return true
  } catch {
    return false
  }
}
