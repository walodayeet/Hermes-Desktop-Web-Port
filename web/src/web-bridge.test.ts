// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { installWebBridge } from '@/web-bridge'

type FetchResponse = {
  ok: boolean
  status: number
  statusText: string
  headers: Headers
  blob: () => Promise<Blob>
  json: () => Promise<unknown>
  text: () => Promise<string>
}

function response(overrides: Partial<FetchResponse>): FetchResponse {
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    headers: new Headers(),
    blob: async () => new Blob(['file bytes'], { type: 'text/plain' }),
    json: async () => ({}),
    text: async () => '',
    ...overrides
  }
}

describe('web saveGatewayFile bridge', () => {
  const originalFetch = globalThis.fetch
  const originalCreateObjectURL = URL.createObjectURL
  const originalRevokeObjectURL = URL.revokeObjectURL

  beforeEach(() => {
    installWebBridge()
    URL.createObjectURL = vi.fn(() => 'blob:download')
    URL.revokeObjectURL = vi.fn()
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
    URL.createObjectURL = originalCreateObjectURL
    URL.revokeObjectURL = originalRevokeObjectURL
    vi.restoreAllMocks()
    delete window.hermesDesktop
  })

  it('downloads binary gateway data with encoded scope and connection routing', async () => {
    const fetchMock = vi.fn(async () => response({
      headers: new Headers({ 'Content-Disposition': 'attachment; filename="report.csv"' })
    }))
    globalThis.fetch = fetchMock as typeof fetch
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})

    const result = await window.hermesDesktop.saveGatewayFile!({
      connectionId: 'remote-1',
      path: '/tmp/a file.csv',
      profile: 'work/team',
      sessionId: 'session-1',
      suggestedName: 'fallback.csv'
    })

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0]!
    expect(url).toBe('/api/fs/download?path=%2Ftmp%2Fa%20file.csv&profile=work%2Fteam&session_id=session-1')
    expect(init).toMatchObject({ credentials: 'include' })
    expect(new Headers(init?.headers).get('X-Hermes-Connection-Id')).toBe('remote-1')
    expect(click).toHaveBeenCalledTimes(1)
    expect(result).toEqual({ saved: true })
  })

  it('falls back once from download 404 to read-data-url', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response({ ok: false, status: 404, statusText: 'Not Found' }))
      .mockResolvedValueOnce(response({ json: async () => ({ dataUrl: 'data:text/plain;base64,ZmlsZQ==' }) }))
    globalThis.fetch = fetchMock as typeof fetch
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})

    const result = await window.hermesDesktop.saveGatewayFile!({
      connectionId: 'remote-1',
      path: '/tmp/file.txt',
      profile: 'work',
      sessionId: 'session-1'
    })

    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(fetchMock.mock.calls[1]![0]).toBe('/api/fs/read-data-url?path=%2Ftmp%2Ffile.txt&profile=work&session_id=session-1')
    expect(new Headers(fetchMock.mock.calls[1]![1]?.headers).get('X-Hermes-Connection-Id')).toBe('remote-1')
    expect(click).toHaveBeenCalledTimes(1)
    expect(result).toEqual({ saved: true })
  })

  it('throws non-404 errors without falling back', async () => {
    globalThis.fetch = vi.fn(async () => response({
      ok: false,
      status: 500,
      statusText: 'Server Error',
      text: async () => 'gateway exploded'
    })) as typeof fetch

    await expect(window.hermesDesktop.saveGatewayFile!({ path: '/tmp/file.txt' })).rejects.toThrow(
      'HTTP 500 Server Error: gateway exploded'
    )
    expect(globalThis.fetch).toHaveBeenCalledTimes(1)
  })

  it('does not put tokens in the URL or browser-visible request payload', async () => {
    const fetchMock = vi.fn(async () => response({
      headers: new Headers({ 'Content-Type': 'application/octet-stream' })
    }))
    globalThis.fetch = fetchMock as typeof fetch
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})

    await window.hermesDesktop.saveGatewayFile!({
      connectionId: 'remote-1',
      path: '/tmp/file.bin',
      profile: 'work',
      suggestedName: 'file.bin'
    })

    const [url, init] = fetchMock.mock.calls[0]!
    expect(url).not.toContain('token')
    expect(JSON.stringify(init)).not.toContain('token')
    expect(JSON.stringify(init)).not.toContain('secret')
  })
})
