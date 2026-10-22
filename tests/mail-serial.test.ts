import { describe, expect, it } from 'vitest'
import { withSerializedModelCall } from '../src/mail/serial.js'

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

describe('serialized model calls', () => {
  it('allows only one admitted model call at a time', async () => {
    let active = 0
    let maxActive = 0
    const order: string[] = []

    const task = (id: string, delay: number) =>
      withSerializedModelCall(async () => {
        active += 1
        maxActive = Math.max(maxActive, active)
        order.push(`start-${id}`)
        await wait(delay)
        order.push(`end-${id}`)
        active -= 1
        return id
      })

    const results = await Promise.all([task('a', 20), task('b', 1), task('c', 1)])

    expect(results).toEqual(['a', 'b', 'c'])
    expect(maxActive).toBe(1)
    expect(order).toEqual(['start-a', 'end-a', 'start-b', 'end-b', 'start-c', 'end-c'])
  })

  it('keeps the chain usable after a failed call', async () => {
    await expect(
      withSerializedModelCall(async () => {
        throw new Error('provider failure')
      }),
    ).rejects.toThrow('provider failure')

    await expect(withSerializedModelCall(async () => 'next')).resolves.toBe('next')
  })
})
