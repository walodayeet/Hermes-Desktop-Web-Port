// @vitest-environment jsdom
/**
 * Web port regression tests — session pin/unpin MUST reach the backend.
 *
 * Contract under test (brief: "session pin / unpin does not persist"):
 *  (a) pinning a session whose row reports pinned === false during the first
 *      reconcile pass (the boot-replay window, before bootReconcilePassed
 *      latches) issues exactly one PATCH {pinned:true}. The boot guard must
 *      only swallow pins INHERITED from the previous page, never a live user
 *      toggle — otherwise the fresh pin is marked mirrored without a PATCH
 *      and the pull pass below silently reverts it.
 *  (b) unpinning a pin that is in localStorage but was never mirrored this
 *      page (bookkeeping cleared — the connection-rescope / reset path) still
 *      issues PATCH {pinned:false}: every local→server intent transition must
 *      write, or a stale pinned:true page re-adopts the pin on the next pull.
 *  (c) a page that contradicts an in-flight write must not revert the local
 *      state (unconfirmed-write guard for pin, deselected fence for unpin).
 *  (b2) control: the ORDINARY unpin path (pin mirrored by a normal reconcile)
 *      already writes — documents that the pull-adopt bookkeeping gap is not
 *      a silent-loss vector on its own.
 *
 * Driven without a backend: $sessions/$cronSessions/$messagingSessions +
 * a stubbed window.hermesDesktop.api capturing every request, so the whole
 * real path (writePin → setSessionPinnedRemote → hermesApi → api()) runs.
 *
 * Test-harness isolation notes:
 *  - `watchSessionPins` subscribes without returning an unsubscribe, so every
 *    test's listeners leak into the next. The beforeEach therefore resets
 *    ROW stores first, then bookkeeping, then the local pin set — no row is
 *    left loaded when `$pinnedSessionIds` is emptied, so a leaked reconcile
 *    can never re-adopt a pin into the next test's state.
 *  - The capturing stub is armed only after every reset, so nothing a leaked
 *    listener does during teardown shows up in the capture. Assertions slice
 *    from a per-test baseline anyway.
 */
import { beforeEach, describe, expect, it } from 'vitest'

import { $cronSessions, $messagingSessions, $sessions } from '@/store/session'
import type { SessionInfo } from '@/types/hermes'
import { $pinnedSessionIds, pinSession, unpinSession } from '@/store/layout'
import { resetSessionPinMirror, watchSessionPins } from '@/store/session-pin-sync'

interface ApiCapture {
  path?: string
  method?: string
  body?: Record<string, unknown>
}

let apiCalls: ApiCapture[] = []

/** Rows captured by the stub bridge — the real PATCH requests. */
function sessionPatchesFrom(start: number): ApiCapture[] {
  return apiCalls.slice(start).filter(
    call => call.method === 'PATCH' && typeof call.path === 'string' && call.path.includes('/api/sessions/')
  )
}

/** Just { pinned } of every PATCH since `start`, in order. */
function patchPinnedFlagsFrom(start: number): Array<null | boolean> {
  return sessionPatchesFrom(start).map(call => (typeof call.body?.pinned === 'boolean' ? call.body.pinned : null))
}

function row(overrides: Partial<SessionInfo> = {}): SessionInfo {
  return {
    ended_at: null,
    id: 's1',
    input_tokens: 0,
    is_active: true,
    last_active: 1,
    message_count: 0,
    model: null,
    output_tokens: 0,
    pinned: true,
    preview: null,
    profile: 'default',
    source: 'chat',
    started_at: 0,
    title: null,
    tool_call_count: 0,
    ...overrides
  }
}

beforeEach(() => {
  window.localStorage.clear()
  window.sessionStorage.clear()
  // Row stores FIRST: a leaked reconcile must never see a row while the local
  // pin set below is still holding a leftover pin (it would re-adopt it).
  $sessions.set([])
  $cronSessions.set([])
  $messagingSessions.set([])
  // Then the bookkeeping, then the local set, then arm the capturing bridge
  // only once everything is quiescent (reconciles early-return without it).
  resetSessionPinMirror()
  $pinnedSessionIds.set([])
  apiCalls = []
  window.hermesDesktop = {
    api: async (request: ApiCapture) => {
      apiCalls.push(request)

      return { ok: true }
    }
  } as unknown as typeof window.hermesDesktop
})

describe('session-pin-sync: every local→server intent transition issues a PATCH', () => {
  it('(a) pins a session whose row reports pinned=false during the first reconcile pass — live pin must not be swallowed by the boot guard, and the pull must not revert it', () => {
    const start = apiCalls.length

    watchSessionPins()
    expect($pinnedSessionIds.get()).toEqual([])

    // User clicks pin while the first server list is still in flight: the
    // row is not loaded yet, so the local toggle sits in `pending`.
    pinSession('s1')
    expect($pinnedSessionIds.get()).toEqual(['s1'])

    // First server-backed page arrives — and still reports the PRE-PATCH
    // value (pinned=false) because the PATCH never landed before this page
    // was produced. The reconcile must issue the write, not swallow it.
    $sessions.set([row({ pinned: false })])

    expect(patchPinnedFlagsFrom(start)).toEqual([true])
    expect($pinnedSessionIds.get()).toEqual(['s1'])

    // (c) A SECOND page still contradicting the write (a list request issued
    // before the PATCH round-tripped) must be fenced out by the unconfirmed
    // write guard — not revert the pin.
    $sessions.set([row({ pinned: false })])
    expect(patchPinnedFlagsFrom(start)).toEqual([true])
    expect($pinnedSessionIds.get()).toEqual(['s1'])
  })

  it('(b) unpins a pin that exists in localStorage but was never mirrored this page — bookkeeping cleared by the connection-rescope reset must not swallow the unpin PATCH', () => {
    // Pin inherited from the previous page load (localStorage), row loaded,
    // server agrees (pinned=true).
    $pinnedSessionIds.set(['s1'])
    $sessions.set([row({ pinned: true })])
    watchSessionPins()

    // A connection rescope wipes the bookkeeping (mirrored/pending/unconfirmed)
    // while the pin stays in the local set — from the sync module's point of
    // view this pin was NEVER mirrored this page.
    resetSessionPinMirror()
    expect($pinnedSessionIds.get()).toEqual(['s1'])
    const start = apiCalls.length

    // User unpins. The PATCH must be issued even though no bookkeeping entry
    // survives.
    unpinSession('s1')

    expect($pinnedSessionIds.get()).toEqual([])
    expect(patchPinnedFlagsFrom(start).filter(pinned => pinned === false).length).toBeGreaterThanOrEqual(1)

    // (c) A stale page still carrying pinned=true must not re-adopt the pin
    // (the deselected fence holds until the server confirms pinned=false).
    $sessions.set([row({ pinned: true })])
    expect($pinnedSessionIds.get()).toEqual([])
  })

  it('(b2) ordinary unpin still writes when the pin WAS mirrored by a normal reconcile (rule-out: pull-adopt bookkeeping gap)', () => {
    // No reset involved: after the boot re-assert the pin is mirrored, and a
    // plain unpin must PATCH. This is the control for (b) — it documents that
    // the ordinary path already worked and pins the mirror invariant.
    const start = apiCalls.length

    $pinnedSessionIds.set(['s1'])
    $sessions.set([row({ pinned: true })])
    watchSessionPins()
    expect(patchPinnedFlagsFrom(start)).toEqual([true])

    unpinSession('s1')

    expect($pinnedSessionIds.get()).toEqual([])
    expect(patchPinnedFlagsFrom(start).filter(pinned => pinned === false).length).toBeGreaterThanOrEqual(1)
  })
})