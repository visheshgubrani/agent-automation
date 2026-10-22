import { Writable } from 'node:stream'
import { describe, expect, it } from 'vitest'
import { createLogger } from '../src/logger.js'

interface LogSink {
  chunks: string[]
  destination: Writable
}

function logSink(): LogSink {
  const chunks: string[] = []
  return {
    chunks,
    destination: new Writable({
      write(chunk, _encoding, callback) {
        chunks.push(String(chunk))
        callback()
      },
    }),
  }
}

async function settled(sink: LogSink): Promise<string> {
  // pino may flush the destination stream on the next tick.
  await new Promise((resolve) => setTimeout(resolve, 30))
  return sink.chunks.join('')
}

describe('createLogger', () => {
  it('writes machine-readable JSON outside development', async () => {
    const sink = logSink()
    const log = createLogger({ level: 'info', pretty: false, destination: sink.destination })

    log.info({ requestId: 'req-1', method: 'GET' }, 'http request')
    const output = await settled(sink)

    expect(output).not.toContain('\u001b[') // no pretty ANSI escapes
    const [record] = output.trim().split('\n')
    if (!record) throw new Error('expected a log line')
    expect(JSON.parse(record)).toMatchObject({
      level: 30,
      service: 'agent-automation',
      env: process.env.NODE_ENV,
      msg: 'http request',
      requestId: 'req-1',
      method: 'GET',
    })
  })

  it('redacts token, key, ciphertext, and authorization fields at every configured depth', async () => {
    const sink = logSink()
    const log = createLogger({ level: 'info', pretty: false, destination: sink.destination })

    log.info(
      {
        token: 'secret-token',
        botToken: 'secret-bot-token',
        authorization: 'Bearer secret-authorization',
        password: 'secret-password',
        key: 'secret-key',
        keys: 'secret-keys',
        ciphertext: 'secret-ciphertext',
        nonce: 'secret-nonce',
        authTag: 'secret-auth-tag',
        healthToken: 'secret-health-token',
        openaiApiKey: 'secret-config-openai-key',
        clientSecret: 'secret-config-client-secret',
        TELEGRAM_BOT_TOKEN: 'secret-env-bot-token',
        TOKEN_ENCRYPTION_KEYS: 'secret-env-keys',
        HEALTH_DETAILS_TOKEN: 'secret-env-health-token',
        OPENAI_API_KEY: 'secret-env-openai-key',
        GMAIL_CLIENT_SECRET: 'secret-env-gmail-secret',
        DATABASE_URL: 'postgres://secret-database-url',
        nested: {
          token: 'secret-nested-token',
          deeper: { authorization: 'Bearer secret-deep-authorization' },
        },
        mail: {
          openaiApiKey: 'secret-nested-openai-key',
          gmail: { clientSecret: 'secret-nested-client-secret' },
        },
        envSecrets: { TELEGRAM_BOT_TOKEN: 'secret-nested-bot-token' },
      },
      'redaction check',
    )

    const output = await settled(sink)
    for (const secret of [
      'secret-token',
      'secret-bot-token',
      'secret-authorization',
      'secret-password',
      'secret-key',
      'secret-keys',
      'secret-ciphertext',
      'secret-nonce',
      'secret-auth-tag',
      'secret-health-token',
      'secret-config-openai-key',
      'secret-config-client-secret',
      'secret-env-bot-token',
      'secret-env-keys',
      'secret-env-health-token',
      'secret-env-openai-key',
      'secret-env-gmail-secret',
      'secret-database-url',
      'secret-nested-token',
      'secret-deep-authorization',
      'secret-nested-openai-key',
      'secret-nested-client-secret',
      'secret-nested-bot-token',
    ]) {
      expect(output).not.toContain(secret)
    }

    const parsed = JSON.parse(output.trim()) as Record<string, unknown>
    expect(parsed.token).toBe('[redacted]')
    expect(parsed.nested).toMatchObject({
      token: '[redacted]',
      deeper: { authorization: '[redacted]' },
    })
    expect(parsed.envSecrets).toMatchObject({ TELEGRAM_BOT_TOKEN: '[redacted]' })
    expect(parsed.mail).toMatchObject({
      openaiApiKey: '[redacted]',
      gmail: { clientSecret: '[redacted]' },
    })
  })

  it('never emits the configured health details token', async () => {
    const detailsToken = process.env.HEALTH_DETAILS_TOKEN
    if (!detailsToken) throw new Error('HEALTH_DETAILS_TOKEN is required for logging tests')

    const sink = logSink()
    const log = createLogger({ level: 'info', pretty: false, destination: sink.destination })
    log.info(
      {
        healthToken: detailsToken,
        headers: { authorization: `Bearer ${detailsToken}` },
        env: { HEALTH_DETAILS_TOKEN: detailsToken },
      },
      'health token check',
    )

    const output = await settled(sink)
    expect(output).not.toContain(detailsToken)
    expect(output).toContain('[redacted]')
  })
})
