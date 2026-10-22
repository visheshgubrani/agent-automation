import { defineConfig } from 'drizzle-kit'

try {
  process.loadEnvFile()
} catch {
  // no .env file — rely on real env vars
}

export default defineConfig({
  schema: './src/db/schema/index.ts',
  out: './src/db/migrations',
  dialect: 'postgresql',
  dbCredentials: {
    url: process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5434/app',
  },
})
