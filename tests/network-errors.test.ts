import { GrammyError, HttpError } from 'grammy'
import { describe, expect, it } from 'vitest'
import { classifyTelegramSendError, errorMessage } from '../src/errors.js'

function apiError(errorCode: number, retryAfter?: number): GrammyError {
  return new GrammyError(
    `Call to 'sendMessage' failed!`,
    {
      ok: false,
      error_code: errorCode,
      description: 'chat not found',
      ...(retryAfter !== undefined ? { parameters: { retry_after: retryAfter } } : {}),
    },
    'sendMessage',
    // Payload contents (chat ids, text) must never leak into safe error text.
    { chat_id: 123, text: 'SECRET-MESSAGE-BODY' },
  )
}

describe('classifyTelegramSendError', () => {
  it('treats 429 as retryable and surfaces retry_after', () => {
    const failure = classifyTelegramSendError(apiError(429, 5))
    expect(failure.kind).toBe('retryable')
    expect(failure.retryAfterSeconds).toBe(5)
  })

  it('treats other 4xx as permanent', () => {
    expect(classifyTelegramSendError(apiError(400)).kind).toBe('permanent')
    expect(classifyTelegramSendError(apiError(403)).kind).toBe('permanent')
  })

  it('treats 5xx as uncertain (the API answer does not prove delivery)', () => {
    expect(classifyTelegramSendError(apiError(500)).kind).toBe('uncertain')
    expect(classifyTelegramSendError(apiError(502)).kind).toBe('uncertain')
  })

  it('reads Node codes through nested cause chains', () => {
    const error = new Error('fetch failed', {
      cause: new Error('connect', { cause: { code: 'ECONNREFUSED' } }),
    })
    const failure = classifyTelegramSendError(error)
    expect(failure.kind).toBe('retryable')
    expect(failure.code).toBe('ECONNREFUSED')
  })

  it('classifies transport failures that provably never reached Telegram as retryable', () => {
    for (const code of ['ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED', 'ENETUNREACH', 'EHOSTUNREACH']) {
      const failure = classifyTelegramSendError(Object.assign(new Error('x'), { code }))
      expect(failure.kind).toBe('retryable')
    }
  })

  it('classifies mid-flight resets and pipes as uncertain', () => {
    for (const code of ['ECONNRESET', 'EPIPE']) {
      expect(classifyTelegramSendError(Object.assign(new Error('x'), { code })).kind).toBe(
        'uncertain',
      )
    }
  })

  it('treats TLS configuration errors as permanent, not ambiguous', () => {
    const failure = classifyTelegramSendError(
      Object.assign(new Error('tls'), { code: 'ERR_TLS_CERT_ALTNAME_INVALID' }),
    )
    expect(failure.kind).toBe('permanent')
  })

  it('classifies direct and HttpError-wrapped aborts as uncertain timeouts', () => {
    const timeout = new Error('telegram send timed out')
    timeout.name = 'TimeoutError'
    const direct = classifyTelegramSendError(timeout)
    expect(direct.kind).toBe('uncertain')
    expect(direct.reason).toBe('timeout')

    // The sender's abort surfaces through grammy as HttpError wrapping the abort reason.
    const wrapped = classifyTelegramSendError(new HttpError('Network request failed', timeout))
    expect(wrapped.kind).toBe('uncertain')
    expect(wrapped.reason).toBe('timeout')
  })

  it('classifies a bare AbortError name as uncertain abort', () => {
    const abort = new Error('This operation was aborted')
    abort.name = 'AbortError'
    expect(classifyTelegramSendError(abort).reason).toBe('aborted')
  })

  it('treats unknown errors as uncertain', () => {
    expect(classifyTelegramSendError(new Error('mysterious')).kind).toBe('uncertain')
    expect(classifyTelegramSendError('a string').reason).toBe('unknown send error')
  })
})

describe('errorMessage', () => {
  it('is bounded, includes the code, and never leaks grammy payloads', () => {
    const text = errorMessage(apiError(400), 80)
    expect(text.startsWith('GrammyError:')).toBe(true)
    expect(text).toContain('[400]')
    expect(text).toContain('chat not found')
    expect(text).not.toContain('SECRET-MESSAGE-BODY')
    expect(text.length).toBeLessThanOrEqual(80)
  })

  it('returns a bounded placeholder for non-error values', () => {
    expect(errorMessage(undefined)).toBe('UnknownError: Non-Error value thrown')
  })
})
