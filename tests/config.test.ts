import { describe, expect, it } from 'vitest'
import {
  ConfigError,
  requireBrowserCheckConfig,
  requireGmailConnectConfig,
  requireWorkerConfig,
} from '../src/config.js'
import { parseKeyRing } from '../src/crypto/keys.js'
import {
  DEFAULT_AGENT_MAX_OUTPUT_TOKENS,
  DEFAULT_AGENT_MAX_STEPS,
  DEFAULT_AGENT_REASONING_EFFORT,
  DEFAULT_AGENT_STEP_POLICY,
  DEFAULT_AGENT_STEP_TIMEOUT_MS,
  DEFAULT_BROWSER_APPROVAL_TIMEOUT_MINUTES,
  DEFAULT_BROWSER_CDP_URL,
  DEFAULT_BROWSER_HANDOFF_TIMEOUT_MINUTES,
  DEFAULT_GMAIL_REQUEST_DELAY_MS,
  DEFAULT_HEARTBEAT_CRON,
  DEFAULT_MAIL_MAX_INPUT_CHARS,
  DEFAULT_MAIL_MAX_OUTPUT_TOKENS,
  DEFAULT_MAIL_MODEL,
  DEFAULT_MAIL_REASONING_EFFORT,
  DEFAULT_MAIL_REQUEST_TIMEOUT_MS,
  EnvironmentError,
  parseEnv,
} from '../src/env.js'

const DATABASE_URL = 'postgres://postgres:postgres@localhost:5434/app_test'
const KEY = Buffer.alloc(32, 7).toString('base64')
const OTHER_KEY = Buffer.alloc(32, 9).toString('base64')
const BOT_TOKEN = '123456789:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'

function parse(overrides: Record<string, string | undefined> = {}) {
  return parseEnv({ DATABASE_URL, ...overrides })
}

function workerEnv(overrides: Record<string, string | undefined> = {}) {
  return parse({
    TELEGRAM_BOT_TOKEN: BOT_TOKEN,
    TELEGRAM_CHAT_ID: '42',
    TOKEN_ENCRYPTION_KEYS: `1:${KEY}`,
    TOKEN_ENCRYPTION_ACTIVE_KEY_VERSION: '1',
    ...overrides,
  })
}

function parseError(source: Record<string, string | undefined>): string {
  try {
    parseEnv(source)
  } catch (error) {
    expect(error).toBeInstanceOf(EnvironmentError)
    return error instanceof Error ? error.message : String(error)
  }
  throw new Error('expected parseEnv to reject')
}

function configError(env: ReturnType<typeof parse>): ConfigError {
  try {
    requireWorkerConfig(env)
  } catch (error) {
    expect(error).toBeInstanceOf(ConfigError)
    return error as ConfigError
  }
  throw new Error('expected requireWorkerConfig to reject')
}

describe('parseEnv', () => {
  it('applies defaults and leaves every optional integration value unset', () => {
    const env = parse()

    expect(env.APP_PORT).toBe(3000)
    expect(env.NODE_ENV).toBe('development')
    expect(env.LOG_LEVEL).toBe('info')
    expect(env.HEARTBEAT_CRON).toBe(DEFAULT_HEARTBEAT_CRON)
    expect(env.TEST_DATABASE_URL).toBeUndefined()
    expect(env.OPENAI_API_KEY).toBeUndefined()
    expect(env.TELEGRAM_BOT_TOKEN).toBeUndefined()
    expect(env.TELEGRAM_CHAT_ID).toBeUndefined()
    expect(env.TOKEN_ENCRYPTION_KEYS).toBeUndefined()
    expect(env.TOKEN_ENCRYPTION_ACTIVE_KEY_VERSION).toBeUndefined()
    expect(env.HEALTH_DETAILS_TOKEN).toBeUndefined()
    expect(env.MAIL_ENABLED).toBe(false)
    expect(env.MAIL_MODEL).toBe(DEFAULT_MAIL_MODEL)
    expect(env.MAIL_REASONING_EFFORT).toBe(DEFAULT_MAIL_REASONING_EFFORT)
    expect(env.MAIL_MAX_INPUT_CHARS).toBe(DEFAULT_MAIL_MAX_INPUT_CHARS)
    expect(env.MAIL_MAX_OUTPUT_TOKENS).toBe(DEFAULT_MAIL_MAX_OUTPUT_TOKENS)
    expect(env.MAIL_REQUEST_TIMEOUT_MS).toBe(DEFAULT_MAIL_REQUEST_TIMEOUT_MS)
  })

  it('parses explicit overrides, including the worker-only values', () => {
    const env = parse({
      APP_PORT: '4321',
      NODE_ENV: 'production',
      LOG_LEVEL: 'debug',
      TEST_DATABASE_URL: 'postgres://postgres:postgres@localhost:5434/app_test',
      OPENAI_API_KEY: 'sk-test',
      TELEGRAM_BOT_TOKEN: BOT_TOKEN,
      TELEGRAM_CHAT_ID: '42',
      TOKEN_ENCRYPTION_KEYS: `1:${KEY},2:${OTHER_KEY}`,
      TOKEN_ENCRYPTION_ACTIVE_KEY_VERSION: '2',
      HEARTBEAT_CRON: '*/2 * * * *',
      HEALTH_DETAILS_TOKEN: 'test-health-details-token',
      GMAIL_CLIENT_ID: 'client-id',
      GMAIL_CLIENT_SECRET: 'client-secret',
      MAIL_ENABLED: 'true',
      MAIL_MODEL: 'gpt-test-mail',
      MAIL_REASONING_EFFORT: 'high',
      MAIL_MAX_INPUT_CHARS: '8000',
      MAIL_MAX_OUTPUT_TOKENS: '1200',
      MAIL_REQUEST_TIMEOUT_MS: '45000',
    })

    expect(env.APP_PORT).toBe(4321)
    expect(env.NODE_ENV).toBe('production')
    expect(env.LOG_LEVEL).toBe('debug')
    expect(env.TEST_DATABASE_URL).toContain('app_test')
    expect(env.OPENAI_API_KEY).toBe('sk-test')
    expect(env.TELEGRAM_BOT_TOKEN).toBe(BOT_TOKEN)
    expect(env.TELEGRAM_CHAT_ID).toBe(42)
    expect(env.TOKEN_ENCRYPTION_KEYS).toBe(`1:${KEY},2:${OTHER_KEY}`)
    expect(env.TOKEN_ENCRYPTION_ACTIVE_KEY_VERSION).toBe(2)
    expect(env.HEARTBEAT_CRON).toBe('*/2 * * * *')
    expect(env.HEALTH_DETAILS_TOKEN).toBe('test-health-details-token')
    expect(env.MAIL_ENABLED).toBe(true)
    expect(env.MAIL_MODEL).toBe('gpt-test-mail')
    expect(env.MAIL_REASONING_EFFORT).toBe('high')
    expect(env.MAIL_MAX_INPUT_CHARS).toBe(8000)
    expect(env.MAIL_MAX_OUTPUT_TOKENS).toBe(1200)
    expect(env.MAIL_REQUEST_TIMEOUT_MS).toBe(45000)
  })

  it('allows base env to parse with mail enabled and no mail secrets', () => {
    const env = parse({ MAIL_ENABLED: 'true' })

    expect(env.MAIL_ENABLED).toBe(true)
    expect(env.GMAIL_CLIENT_ID).toBeUndefined()
    expect(env.GMAIL_CLIENT_SECRET).toBeUndefined()
    expect(env.OPENAI_API_KEY).toBeUndefined()
  })

  it('treats empty optional values as unset and defaults an empty cron', () => {
    const env = parse({
      TEST_DATABASE_URL: '',
      OPENAI_API_KEY: '',
      TELEGRAM_BOT_TOKEN: '',
      TELEGRAM_CHAT_ID: '',
      TOKEN_ENCRYPTION_KEYS: '',
      TOKEN_ENCRYPTION_ACTIVE_KEY_VERSION: '',
      HEALTH_DETAILS_TOKEN: '',
      HEARTBEAT_CRON: '',
      GMAIL_CLIENT_ID: '',
      GMAIL_CLIENT_SECRET: '',
      MAIL_ENABLED: '',
      MAIL_MODEL: '',
      MAIL_REASONING_EFFORT: '',
      MAIL_MAX_INPUT_CHARS: '',
      MAIL_MAX_OUTPUT_TOKENS: '',
      MAIL_REQUEST_TIMEOUT_MS: '',
    })

    expect(env.TEST_DATABASE_URL).toBeUndefined()
    expect(env.OPENAI_API_KEY).toBeUndefined()
    expect(env.TELEGRAM_BOT_TOKEN).toBeUndefined()
    expect(env.TELEGRAM_CHAT_ID).toBeUndefined()
    expect(env.TOKEN_ENCRYPTION_KEYS).toBeUndefined()
    expect(env.TOKEN_ENCRYPTION_ACTIVE_KEY_VERSION).toBeUndefined()
    expect(env.HEALTH_DETAILS_TOKEN).toBeUndefined()
    expect(env.HEARTBEAT_CRON).toBe(DEFAULT_HEARTBEAT_CRON)
    expect(env.MAIL_ENABLED).toBe(false)
    expect(env.MAIL_MODEL).toBe(DEFAULT_MAIL_MODEL)
    expect(env.MAIL_REASONING_EFFORT).toBe(DEFAULT_MAIL_REASONING_EFFORT)
    expect(env.MAIL_MAX_INPUT_CHARS).toBe(DEFAULT_MAIL_MAX_INPUT_CHARS)
    expect(env.MAIL_MAX_OUTPUT_TOKENS).toBe(DEFAULT_MAIL_MAX_OUTPUT_TOKENS)
    expect(env.MAIL_REQUEST_TIMEOUT_MS).toBe(DEFAULT_MAIL_REQUEST_TIMEOUT_MS)
  })

  it('rejects a missing or malformed DATABASE_URL', () => {
    expect(parseError({})).toContain('DATABASE_URL')
    expect(parseError({ DATABASE_URL: 'mysql://localhost/app' })).toContain('DATABASE_URL')
    expect(parseError({ DATABASE_URL: 'not-a-url' })).toContain('DATABASE_URL')
  })

  it('rejects a malformed bot token, chat id, key version, or health token', () => {
    expect(parseError({ DATABASE_URL, TELEGRAM_BOT_TOKEN: 'not-a-token' })).toContain(
      'TELEGRAM_BOT_TOKEN',
    )
    expect(parseError({ DATABASE_URL, TELEGRAM_CHAT_ID: '1.5' })).toContain('TELEGRAM_CHAT_ID')
    expect(
      parseError({
        DATABASE_URL,
        TOKEN_ENCRYPTION_ACTIVE_KEY_VERSION: '40000',
      }),
    ).toContain('TOKEN_ENCRYPTION_ACTIVE_KEY_VERSION')
    expect(parseError({ DATABASE_URL, HEALTH_DETAILS_TOKEN: 'too-short' })).toContain(
      'HEALTH_DETAILS_TOKEN',
    )
    expect(parseError({ DATABASE_URL, HEARTBEAT_CRON: '   ' })).toContain('HEARTBEAT_CRON')
    expect(parseError({ DATABASE_URL, MAIL_ENABLED: 'yes' })).toContain('MAIL_ENABLED')
    expect(parseError({ DATABASE_URL, MAIL_REASONING_EFFORT: 'low' })).toContain(
      'MAIL_REASONING_EFFORT',
    )
    expect(parseError({ DATABASE_URL, MAIL_MAX_INPUT_CHARS: '0' })).toContain(
      'MAIL_MAX_INPUT_CHARS',
    )
    expect(parseError({ DATABASE_URL, MAIL_MAX_INPUT_CHARS: '100' })).toContain(
      'MAIL_MAX_INPUT_CHARS',
    )
    expect(parseError({ DATABASE_URL, MAIL_MAX_OUTPUT_TOKENS: '20000' })).toContain(
      'MAIL_MAX_OUTPUT_TOKENS',
    )
    expect(parseError({ DATABASE_URL, MAIL_REQUEST_TIMEOUT_MS: '10' })).toContain(
      'MAIL_REQUEST_TIMEOUT_MS',
    )
  })
})

describe('parseKeyRing', () => {
  it('parses a multi-version ring and exposes the active key', () => {
    const ring = parseKeyRing(`1:${KEY}, 2:${OTHER_KEY}`, 2)

    expect(ring.activeVersion).toBe(2)
    expect([...ring.keys.keys()]).toEqual([1, 2])
    expect(ring.keys.get(1)?.length).toBe(32)
    expect(ring.keys.get(2)?.equals(Buffer.from(OTHER_KEY, 'base64'))).toBe(true)
  })

  it('rejects malformed, duplicate, wrong-size, and missing-active entries', () => {
    expect(() => parseKeyRing('', 1)).toThrow(/comma-separated/)
    expect(() => parseKeyRing(`1:${KEY},`, 1)).toThrow(/comma-separated/)
    expect(() => parseKeyRing('not-a-pair', 1)).toThrow(/version:base64key/)
    expect(() => parseKeyRing(`1:${KEY},1:${OTHER_KEY}`, 1)).toThrow(/duplicate key version 1/)
    expect(() => parseKeyRing('1:not-base64!', 1)).toThrow(/not valid base64/)
    expect(() => parseKeyRing(`1:${Buffer.alloc(16).toString('base64')}`, 1)).toThrow(
      /must decode to 32 bytes/,
    )
    expect(() => parseKeyRing(`2:${KEY}`, 1)).toThrow(/active key version 1 is not present/)
    expect(() => parseKeyRing(`0:${KEY}`, 0)).toThrow(/active key version must be between/)
  })
})

describe('requireWorkerConfig', () => {
  it('returns typed worker config for a complete environment', () => {
    const config = requireWorkerConfig(
      workerEnv({
        HEARTBEAT_CRON: '*/2 * * * *',
      }),
    )

    expect(config.telegram).toEqual({ botToken: BOT_TOKEN, chatId: 42 })
    expect(config.encryption.activeVersion).toBe(1)
    expect(config.encryption.keys.get(1)?.length).toBe(32)
    expect(config.heartbeatCron).toBe('*/2 * * * *')
  })

  it('collects every missing worker value into one actionable error', () => {
    const error = configError(parse())

    expect(error.issues).toHaveLength(4)
    expect(error.issues).toEqual(
      expect.arrayContaining([
        'TELEGRAM_BOT_TOKEN is required',
        'TELEGRAM_CHAT_ID is required (safe integer)',
        'TOKEN_ENCRYPTION_KEYS is required',
        'TOKEN_ENCRYPTION_ACTIVE_KEY_VERSION is required',
      ]),
    )
    expect(error.message).toContain('Invalid worker configuration')
  })

  it('reports a key ring whose active version is absent, without leaking key bytes', () => {
    const error = configError(
      workerEnv({
        TOKEN_ENCRYPTION_KEYS: `2:${OTHER_KEY}`,
        TOKEN_ENCRYPTION_ACTIVE_KEY_VERSION: '1',
      }),
    )

    expect(error.issues).toHaveLength(1)
    expect(error.issues[0]).toContain('active key version 1 is not present')
    // Messages name versions, never key material.
    expect(error.message).not.toContain(KEY)
    expect(error.message).not.toContain(OTHER_KEY)
  })

  it('reports an unparseable key ring instead of starting partially configured', () => {
    const error = configError(
      workerEnv({
        TOKEN_ENCRYPTION_KEYS: '1:not-base64!',
      }),
    )

    expect(error.issues).toHaveLength(1)
    expect(error.issues[0]).toContain('TOKEN_ENCRYPTION_KEYS')
    expect(error.issues[0]).toContain('not valid base64')
  })

  it('does not treat a missing health details token as a worker error', () => {
    const config = requireWorkerConfig(workerEnv())

    expect(config.telegram.botToken).toBe(BOT_TOKEN)
    expect(config.mail).toBeUndefined()
    expect(parse().HEALTH_DETAILS_TOKEN).toBeUndefined()
  })

  it('collects Gmail and OpenAI requirements when mail is enabled', () => {
    const error = configError(workerEnv({ MAIL_ENABLED: 'true' }))

    expect(error.issues).toHaveLength(3)
    expect(error.issues).toEqual(
      expect.arrayContaining([
        'GMAIL_CLIENT_ID is required when MAIL_ENABLED=true',
        'GMAIL_CLIENT_SECRET is required when MAIL_ENABLED=true',
        'OPENAI_API_KEY is required when MAIL_ENABLED=true',
      ]),
    )
  })

  it('returns validated mail config with the default model/effort and bounded limits', () => {
    const config = requireWorkerConfig(
      workerEnv({
        MAIL_ENABLED: 'true',
        GMAIL_CLIENT_ID: 'client-id',
        GMAIL_CLIENT_SECRET: 'client-secret',
        OPENAI_API_KEY: 'sk-test',
      }),
    )

    expect(config.mail).toEqual({
      gmail: { clientId: 'client-id', clientSecret: 'client-secret' },
      openaiApiKey: 'sk-test',
      model: DEFAULT_MAIL_MODEL,
      reasoningEffort: DEFAULT_MAIL_REASONING_EFFORT,
      maxInputChars: DEFAULT_MAIL_MAX_INPUT_CHARS,
      maxOutputTokens: DEFAULT_MAIL_MAX_OUTPUT_TOKENS,
      requestTimeoutMs: DEFAULT_MAIL_REQUEST_TIMEOUT_MS,
      gmailRequestDelayMs: DEFAULT_GMAIL_REQUEST_DELAY_MS,
    })
  })

  it('rejects a mail model without a pricing snapshot', () => {
    const error = configError(
      workerEnv({
        MAIL_ENABLED: 'true',
        GMAIL_CLIENT_ID: 'client-id',
        GMAIL_CLIENT_SECRET: 'client-secret',
        OPENAI_API_KEY: 'sk-test',
        MAIL_MODEL: 'gpt-test-mail',
      }),
    )

    expect(error.issues).toContain('MAIL_MODEL "gpt-test-mail" has no configured pricing snapshot')
  })

  it('accepts explicit high effort and request bounds when mail is enabled', () => {
    const config = requireWorkerConfig(
      workerEnv({
        MAIL_ENABLED: 'true',
        GMAIL_CLIENT_ID: 'client-id',
        GMAIL_CLIENT_SECRET: 'client-secret',
        OPENAI_API_KEY: 'sk-test',
        MAIL_MODEL: 'gpt-6-luna',
        MAIL_REASONING_EFFORT: 'high',
        MAIL_MAX_INPUT_CHARS: '9000',
        MAIL_MAX_OUTPUT_TOKENS: '1500',
        MAIL_REQUEST_TIMEOUT_MS: '60000',
        GMAIL_REQUEST_DELAY_MS: '750',
      }),
    )

    expect(config.mail).toMatchObject({
      model: 'gpt-6-luna',
      reasoningEffort: 'high',
      maxInputChars: 9000,
      maxOutputTokens: 1500,
      requestTimeoutMs: 60000,
      gmailRequestDelayMs: 750,
    })
  })
})

describe('requireGmailConnectConfig', () => {
  const connectEnv = (overrides: Record<string, string | undefined> = {}) =>
    parse({
      GMAIL_CLIENT_ID: 'client-id',
      GMAIL_CLIENT_SECRET: 'client-secret',
      TOKEN_ENCRYPTION_KEYS: `1:${KEY}`,
      TOKEN_ENCRYPTION_ACTIVE_KEY_VERSION: '1',
      ...overrides,
    })

  it('needs Gmail OAuth and encryption but not Telegram, OpenAI, or MAIL_ENABLED', () => {
    const config = requireGmailConnectConfig(connectEnv())

    expect(config.gmail).toEqual({ clientId: 'client-id', clientSecret: 'client-secret' })
    expect(config.encryption.activeVersion).toBe(1)
    expect('telegram' in config).toBe(false)
    expect('openaiApiKey' in config).toBe(false)
  })

  it('collects missing Gmail and encryption values into one actionable error', () => {
    let error: ConfigError | undefined
    try {
      requireGmailConnectConfig(parse())
    } catch (caught) {
      error = caught as ConfigError
    }

    expect(error).toBeInstanceOf(ConfigError)
    expect(error?.message).toContain('Invalid Gmail connection configuration')
    expect(error?.issues).toEqual(
      expect.arrayContaining([
        'GMAIL_CLIENT_ID is required for Gmail account connection',
        'GMAIL_CLIENT_SECRET is required for Gmail account connection',
        'TOKEN_ENCRYPTION_KEYS is required',
        'TOKEN_ENCRYPTION_ACTIVE_KEY_VERSION is required',
      ]),
    )
  })

  it('rejects an unparseable key ring without exposing key bytes', () => {
    let error: ConfigError | undefined
    try {
      requireGmailConnectConfig(connectEnv({ TOKEN_ENCRYPTION_KEYS: '1:not-base64!' }))
    } catch (caught) {
      error = caught as ConfigError
    }

    expect(error).toBeInstanceOf(ConfigError)
    expect(error?.issues).toHaveLength(1)
    expect(error?.message).toContain('not valid base64')
    expect(error?.message).not.toContain(KEY)
  })
})

describe('agent configuration', () => {
  const agentEnv = (overrides: Record<string, string | undefined> = {}) =>
    workerEnv({
      AGENT_ENABLED: 'true',
      OPENAI_API_KEY: 'sk-test',
      AGENT_MODEL: DEFAULT_MAIL_MODEL,
      AGENT_TASK_MAX_USD: '0.10',
      BROWSER_VIEW_URL: 'https://browser.tailnet-abc.ts.net/',
      ARTIFACT_DIR: '/var/lib/agent-automation/artifacts',
      ...overrides,
    })

  it('leaves the heartbeat-only and mail-only worker paths unchanged when disabled', () => {
    const env = parse()
    expect(env.AGENT_ENABLED).toBe(false)
    expect(env.AGENT_MODEL).toBeUndefined()
    expect(env.BROWSER_CDP_URL).toBe(DEFAULT_BROWSER_CDP_URL)

    expect(requireWorkerConfig(workerEnv()).agent).toBeUndefined()
    // Invalid agent-only values are ignored while the agent is disabled.
    const mailOnly = requireWorkerConfig(
      workerEnv({
        MAIL_ENABLED: 'true',
        GMAIL_CLIENT_ID: 'client-id',
        GMAIL_CLIENT_SECRET: 'client-secret',
        OPENAI_API_KEY: 'sk-test',
        BROWSER_CDP_URL: 'http://10.0.0.5:9222',
        BROWSER_VIEW_URL: 'http://example.com',
      }),
    )
    expect(mailOnly.mail).toBeDefined()
    expect(mailOnly.agent).toBeUndefined()
  })

  it('returns validated agent config with defaults', () => {
    const config = requireWorkerConfig(agentEnv())
    expect(config.agent).toEqual({
      openaiApiKey: 'sk-test',
      model: DEFAULT_MAIL_MODEL,
      reasoningEffort: DEFAULT_AGENT_REASONING_EFFORT,
      maxSteps: DEFAULT_AGENT_MAX_STEPS,
      maxOutputTokens: DEFAULT_AGENT_MAX_OUTPUT_TOKENS,
      stepTimeoutMs: DEFAULT_AGENT_STEP_TIMEOUT_MS,
      stepPolicy: DEFAULT_AGENT_STEP_POLICY,
      taskMaxUsd: 0.1,
      browser: {
        cdpUrl: DEFAULT_BROWSER_CDP_URL,
        viewUrl: 'https://browser.tailnet-abc.ts.net/',
        artifactDir: '/var/lib/agent-automation/artifacts',
        handoffTimeoutMinutes: DEFAULT_BROWSER_HANDOFF_TIMEOUT_MINUTES,
        approvalTimeoutMinutes: DEFAULT_BROWSER_APPROVAL_TIMEOUT_MINUTES,
      },
    })
    expect(config.mail).toBeUndefined()
  })

  it('collects every missing agent value into one ConfigError, even with mail off', () => {
    const error = configError(workerEnv({ AGENT_ENABLED: 'true' }))
    expect(error.issues).toEqual([
      'OPENAI_API_KEY is required when AGENT_ENABLED=true',
      'AGENT_MODEL is required when AGENT_ENABLED=true',
      'AGENT_TASK_MAX_USD is required when AGENT_ENABLED=true',
      'BROWSER_VIEW_URL is required when AGENT_ENABLED=true',
      'ARTIFACT_DIR is required when AGENT_ENABLED=true',
    ])
  })

  it('collects agent and mail problems together', () => {
    const error = configError(workerEnv({ AGENT_ENABLED: 'true', MAIL_ENABLED: 'true' }))
    expect(error.issues).toEqual(
      expect.arrayContaining([
        'GMAIL_CLIENT_ID is required when MAIL_ENABLED=true',
        'OPENAI_API_KEY is required when MAIL_ENABLED=true',
        'OPENAI_API_KEY is required when AGENT_ENABLED=true',
        'AGENT_MODEL is required when AGENT_ENABLED=true',
      ]),
    )
  })

  it('rejects an unpriced agent model and a relative artifact directory', () => {
    const error = configError(agentEnv({ AGENT_MODEL: 'gpt-unpriced', ARTIFACT_DIR: 'artifacts' }))
    expect(error.issues).toEqual([
      'AGENT_MODEL "gpt-unpriced" has no configured pricing snapshot',
      'ARTIFACT_DIR must be an absolute path',
    ])
  })

  it('keeps CDP on loopback', () => {
    for (const cdp of ['http://127.0.0.1:9222', 'ws://localhost:9222', 'http://[::1]:9222']) {
      expect(requireWorkerConfig(agentEnv({ BROWSER_CDP_URL: cdp })).agent?.browser.cdpUrl).toBe(
        cdp,
      )
    }
    for (const cdp of [
      'http://0.0.0.0:9222',
      'http://192.168.1.10:9222',
      'http://browser.tailnet-abc.ts.net:9222',
      'ftp://127.0.0.1:9222',
      'http://user:pass@127.0.0.1:9222',
      'not a url',
    ]) {
      const error = configError(agentEnv({ BROWSER_CDP_URL: cdp }))
      expect(error.issues).toHaveLength(1)
      expect(error.issues[0]).toMatch(/^BROWSER_CDP_URL /)
    }
  })

  it('requires an https *.ts.net view URL without credentials', () => {
    for (const view of [
      'http://browser.tailnet-abc.ts.net/',
      'https://example.com/',
      'https://user:pw@browser.tailnet-abc.ts.net/',
      'https://browser.tailnet-abc.ts.net/?password=hunter2',
      'https://browser.tailnet-abc.ts.net/#token=abc',
    ]) {
      const error = configError(agentEnv({ BROWSER_VIEW_URL: view }))
      expect(error.issues).toHaveLength(1)
      expect(error.issues[0]).toMatch(/^BROWSER_VIEW_URL must /)
      expect(error.message).not.toContain('hunter2')
    }
    const ok = requireWorkerConfig(
      agentEnv({ BROWSER_VIEW_URL: 'https://browser.tailnet-abc.ts.net/?autoconnect=1' }),
    )
    expect(ok.agent?.browser.viewUrl).toBe('https://browser.tailnet-abc.ts.net/?autoconnect=1')
  })

  it('validates agent bounds in the base env', () => {
    expect(parseError({ DATABASE_URL, AGENT_TASK_MAX_USD: '0' })).toContain('AGENT_TASK_MAX_USD')
    expect(parseError({ DATABASE_URL, AGENT_MAX_STEPS: '0' })).toContain('AGENT_MAX_STEPS')
    expect(parseError({ DATABASE_URL, AGENT_REASONING_EFFORT: 'low' })).toContain(
      'AGENT_REASONING_EFFORT',
    )
    expect(parseError({ DATABASE_URL, AGENT_STEP_POLICY: 'jev' })).toContain('AGENT_STEP_POLICY')
  })

  it('defaults to the rules step policy, selects llm when asked, and rejects decisions', () => {
    expect(requireWorkerConfig(agentEnv()).agent?.stepPolicy).toBe('rules')
    expect(requireWorkerConfig(agentEnv({ AGENT_STEP_POLICY: 'llm' })).agent?.stepPolicy).toBe(
      'llm',
    )
    // The Decisions controller was removed (D059); a stale setting fails closed.
    expect(parseError({ DATABASE_URL, AGENT_STEP_POLICY: 'decisions' })).toContain(
      'AGENT_STEP_POLICY',
    )
  })
})

describe('requireBrowserCheckConfig', () => {
  it('needs only a loopback CDP URL and an optional absolute artifact directory', () => {
    expect(requireBrowserCheckConfig(parse())).toEqual({ cdpUrl: DEFAULT_BROWSER_CDP_URL })
    expect(requireBrowserCheckConfig(parse({ ARTIFACT_DIR: '/tmp/artifacts' }))).toEqual({
      cdpUrl: DEFAULT_BROWSER_CDP_URL,
      artifactDir: '/tmp/artifacts',
    })
    expect(() =>
      requireBrowserCheckConfig(parse({ BROWSER_CDP_URL: 'http://10.1.1.1:9222' })),
    ).toThrow(ConfigError)
    expect(() => requireBrowserCheckConfig(parse({ ARTIFACT_DIR: 'relative' }))).toThrow(
      'ARTIFACT_DIR must be an absolute path',
    )
  })
})
