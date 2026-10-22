import { customType, timestamp } from 'drizzle-orm/pg-core'

/**
 * Postgres bytea. drizzle-orm 0.45 does not ship a built-in bytea column, and the
 * credential envelope needs raw bytes rather than base64 text.
 */
export const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType() {
    return 'bytea'
  },
})

/** created_at/updated_at pair. App code updates updated_at; there are no triggers. */
export function timestamps() {
  return {
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  }
}
