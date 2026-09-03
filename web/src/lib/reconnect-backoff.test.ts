import { describe, expect, it } from 'vitest'

import { reconnectBackoffDelayMs } from '@/lib/reconnect-backoff'

/**
 * The refresh-kills-the-turn bug: when the WebSocket hits `closed`/`error`,
 * the old code released ALL turn leases for that scope immediately. The
 * gateway sees a running turn whose client vanished → interrupts it as
 * `client_gone` within seconds. This test pins the backoff that governs the
 * reconnect path — full-jitter, bounded — so a misconfigured reconnect
 * never makes the 30-second stuck-connecting symptom worse.
 */
describe('reconnectBackoffDelayMs', () => {
  it('returns within [0, cap) on every attempt count', () => {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const delay = reconnectBackoffDelayMs(attempt, { baseDelayMs: 300, capMs: 15_000 })
      expect(delay).toBeGreaterThanOrEqual(0)
      expect(delay).toBeLessThan(15_000)
    }
  })

  it('bounded by capMs even at high attempt counts', () => {
    const delay = reconnectBackoffDelayMs(50, { baseDelayMs: 300, capMs: 15_000 })
    expect(delay).toBeLessThan(15_000)
    expect(delay).toBeGreaterThanOrEqual(0)
  })
})
