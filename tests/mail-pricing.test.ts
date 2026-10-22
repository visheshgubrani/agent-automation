import { describe, expect, it } from 'vitest'
import { localDayRange } from '../src/mail/budget.js'
import {
  computeUsageCostUsd,
  estimateClassifierReservationUsd,
  getModelRates,
  UnknownMailModelError,
} from '../src/mail/pricing.js'

describe('mail model pricing', () => {
  it('prices uncached, cached, cache-write, and output tokens without double-counting reasoning', () => {
    const rates = getModelRates('gpt-6-luna')
    const cost = computeUsageCostUsd(rates, {
      inputTokens: 1_000,
      cachedInputTokens: 400,
      cacheWriteTokens: 100,
      outputTokens: 200,
      reasoningTokens: 50,
    })

    // 500 uncached * $0.10/M + 400 cached * $0.01/M + 100 writes * $0.125/M + 200 output * $0.50/M
    expect(cost).toBe(0.000167)
  })

  it('bounds cached and cache-write tokens to the input total', () => {
    const rates = getModelRates('gpt-6-luna')
    const cost = computeUsageCostUsd(rates, {
      inputTokens: 100,
      cachedInputTokens: 500,
      cacheWriteTokens: 500,
      outputTokens: 0,
    })
    expect(cost).toBeCloseTo((100 * rates.cachedInputPerMillionUsd) / 1_000_000, 9)
  })

  it('computes a positive worst-case reservation from the configured limits', () => {
    const reservation = estimateClassifierReservationUsd(getModelRates('gpt-6-luna'), {
      maxInputChars: 12_000,
      maxOutputTokens: 2_000,
    })
    expect(reservation).toBeGreaterThan(0)
    expect(reservation).toBeLessThan(0.01)
  })

  it('fails closed for an unpriced model', () => {
    expect(() => getModelRates('gpt-unpriced')).toThrow(UnknownMailModelError)
  })
})

describe('local mail day', () => {
  it('uses the Asia/Kolkata midnight, not UTC', () => {
    const range = localDayRange(new Date('2026-10-22T20:00:00Z'), 'Asia/Kolkata')

    expect(range.dayKey).toBe('2026-10-23')
    expect(range.start.toISOString()).toBe('2026-10-22T18:30:00.000Z')
    expect(range.end.toISOString()).toBe('2026-10-23T18:30:00.000Z')
  })

  it('treats the exact local start as the new day', () => {
    const range = localDayRange(new Date('2026-10-23T18:30:00Z'), 'Asia/Kolkata')
    expect(range.dayKey).toBe('2026-10-24')
    expect(range.start.toISOString()).toBe('2026-10-23T18:30:00.000Z')
  })
})
