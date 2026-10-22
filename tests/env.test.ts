import { describe, expect, it } from 'vitest'

describe('env', () => {
  it('parses required vars with defaults and points tests at the test DB', async () => {
    const { env } = await import('../src/env.js')
    expect(env.APP_PORT).toBe(3000)
    expect(env.NODE_ENV).toBe('test')
    expect(env.DATABASE_URL).toContain('app_test')
    expect(env.LOG_LEVEL).toBe('info') // default when unset
  })
})
