// begin() for a gateway that has no registry row yet.
//
// The renderer starts OAuth from the "add a gateway" editor, BEFORE the row is
// saved, so the relay key is a bare gateway URL with nothing in the registry
// to resolve. begin() must accept that key (probe first, register only when
// the gateway actually supports native PKCE), while keeping the 404 for a
// non-URL key and the no-row guarantee for unsupported gateways.
//
// Run: cd web && npx vitest run --root .. proxy/oauth-relay.test.mjs

import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const { createOauthRelay } = require('./oauth-relay.js')

const PKCE_URL = 'https://new-gateway.example'
const COOKIE_ONLY_URL = 'https://cookie-only.example'

const normalize = (url) => String(url || '').trim().replace(/\/+$/, '').toLowerCase()

/** Connections store double: records save() calls and models the URL dedup. */
function fakeStore(seed = []) {
  const connections = [...seed]
  const saves = []
  return {
    connections,
    saves,
    get: (id) => connections.find((c) => c.id === id) || null,
    findByUrl: (url) => connections.find((c) => c.url && normalize(c.url) === normalize(url)) || null,
    save: (input) => {
      saves.push(input)
      const connection = {
        id: `saved-${saves.length}`,
        kind: 'remote',
        label: input.label,
        url: normalize(input.url),
        authMode: input.authMode,
      }
      connections.push(connection)
      return { registry: { version: 2, primary: 'local', connections }, connection, changed: true }
    },
    setOauth: () => {},
  }
}

/** Fake gateway: /api/status advertises `authFlows`, everything else 404s. */
function fakeGateway(authFlows) {
  const calls = []
  return {
    calls,
    fetchImpl: async (url) => {
      calls.push(url)
      if (url.endsWith('/api/status')) {
        return { ok: true, status: 200, text: async () => JSON.stringify({ auth_flows: authFlows }) }
      }
      return { ok: false, status: 404, text: async () => '{}' }
    },
  }
}

/** Close the relay's loopback listener: a bad-state callback tears it down. */
async function closePending(result) {
  await fetch(`${result.redirectUri}?code=x&state=wrong`).catch(() => {})
}

describe('oauth relay begin()', () => {
  it('registers an unsaved PKCE-capable gateway and returns an authorize URL', async () => {
    const store = fakeStore()
    const gateway = fakeGateway(['cookie', 'native_pkce'])
    const relay = createOauthRelay({ store, fetchImpl: gateway.fetchImpl })

    const result = await relay.begin(PKCE_URL)

    expect(result.authorizeUrl).toContain(`${PKCE_URL}/auth/native/authorize?`)
    expect(result.baseUrl).toBe(PKCE_URL)
    expect(result.registered).toBe(true)
    expect(store.saves).toHaveLength(1)
    expect(store.saves[0]).toMatchObject({ kind: 'remote', url: PKCE_URL, authMode: 'oauth' })
    expect(store.saves[0].label).toBe('new-gateway.example')

    await closePending(result)
  })

  it('leaves no row behind when an unsaved gateway does not offer native PKCE', async () => {
    const store = fakeStore()
    const gateway = fakeGateway(['cookie'])
    const relay = createOauthRelay({ store, fetchImpl: gateway.fetchImpl })

    await expect(relay.begin(COOKIE_ONLY_URL)).rejects.toMatchObject({
      status: 400,
      code: 'native_pkce_unavailable',
    })
    expect(store.saves).toHaveLength(0)
  })

  it('still starts for a saved connection without saving it again', async () => {
    const saved = { id: 'c1', kind: 'remote', label: 'Saved', url: PKCE_URL, authMode: 'oauth' }
    const store = fakeStore([saved])
    const gateway = fakeGateway(['cookie', 'native_pkce'])
    const relay = createOauthRelay({ store, fetchImpl: gateway.fetchImpl })

    const result = await relay.begin(PKCE_URL)

    expect(result.authorizeUrl).toContain(`${PKCE_URL}/auth/native/authorize?`)
    expect(result.registered).toBeFalsy()
    expect(store.saves).toHaveLength(0)

    await closePending(result)
  })

  it('404s for a key that is neither an id nor an http(s) URL', async () => {
    const store = fakeStore()
    const relay = createOauthRelay({ store, fetchImpl: fakeGateway([]).fetchImpl })

    await expect(relay.begin('no-such-connection')).rejects.toMatchObject({ status: 404 })
    expect(store.saves).toHaveLength(0)
  })
})
