/**
 * web-bridge.ts — Hermes Desktop Web bridge shim.
 *
 * The Electron app's renderer talks to the native shell through
 * `window.hermesDesktop` (see src/global.d.ts for the full contract). In the
 * web port that bridge is provided by this module instead: same-origin REST +
 * WS through the Node proxy (proxy/server.js → hermes serve), with browser
 * equivalents for the small native surface the renderer actually touches.
 *
 * Anything genuinely native (pet overlay, HUD windows, updater, OS file
 * dialogs…) is a safe no-op; the renderer already guards optional members and
 * degrades gracefully (verified: clipboard falls back to navigator.clipboard,
 * plugin sockets stay on polling, etc.).
 */

import { buildHermesWebSocketUrl } from '@hermes/shared'
import type {
  DesktopAgentRoster,
  DesktopConnectionsRegistry,
  DesktopMarketplaceSearchItem,
  DesktopMarketplaceThemeResult,
  DesktopPluginProfileRoute,
  DesktopRegistryConnection,
  DesktopRegistryConnectionInput,
  HermesConnection,
} from '@/global'

// ── config ──────────────────────────────────────────────────────────────────
// Same-origin by default (served through the proxy). Override with
// VITE_HERMES_BASE to point the renderer at a backend directly.
const BASE = (import.meta.env.VITE_HERMES_BASE as string | undefined) ?? ''
const API_BASE = BASE.replace(/\/+$/, '')

async function fetchJson<T>(path: string, init?: RequestInit, timeoutMs = 30_000): Promise<T> {
  const ctrl = new AbortController()
  const timer = window.setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    const res = await fetch(`${API_BASE}${path}`, {
      credentials: 'include',
      ...init,
      signal: ctrl.signal,
    })
    if (!res.ok) {
      throw new Error(`HTTP ${res.status} ${res.statusText}`)
    }
    const text = await res.text()
    return (text ? JSON.parse(text) : undefined) as T
  } finally {
    window.clearTimeout(timer)
  }
}

function wsBase(): string {
  if (API_BASE) {
    const u = new URL(API_BASE)
    const proto = u.protocol === 'https:' ? 'wss:' : 'ws:'
    return `${proto}//${u.host}`
  }
  const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
  return `${proto}//${window.location.host}`
}

// Web port: the browser cannot hand the renderer real filesystem paths, so
// file selection uses a hidden <input type=file> whose File objects are kept
// in this map under virtual `web-input:<n>` paths. readFileDataUrl /
// readFileText resolve those keys (the composer's "add context" flow calls
// selectPaths then reads each path's data URL).
const webInputFiles = new Map<string, File>()
let webInputSeq = 0

// --- zoom / UI scale ----------------------------------------------------------
// Electron owns zoom via webContents.setZoomLevel; the browser equivalent is
// CSS `zoom` on the document root. Persist the percent so reloads keep it.
const ZOOM_STORAGE_KEY = 'hermes-web.zoomPercent'
const zoomListeners = new Set<(payload: { level: number; percent: number }) => void>()

// File System Access API (Chromium desktop) — declared locally because the
// project's TS lib target predates it.
interface WebFilePickerHandle {
  getFile: () => Promise<File>
}
interface WebFilePickerOptions {
  multiple?: boolean
  types?: Array<{ description: string; accept: Record<string, string[]> }>
}
declare global {
  interface Window {
    showOpenFilePicker?: (options?: WebFilePickerOptions) => Promise<WebFilePickerHandle[]>
  }
}

function readZoomPercent(): number {
  try {
    const raw = localStorage.getItem(ZOOM_STORAGE_KEY)
    const parsed = raw ? Number(raw) : NaN
    return Number.isFinite(parsed) && parsed >= 50 && parsed <= 200 ? parsed : 100
  } catch {
    return 100
  }
}

function applyZoomPercent(percent: number): void {
  const clamped = Math.min(200, Math.max(50, Math.round(percent)))
  try {
    localStorage.setItem(ZOOM_STORAGE_KEY, String(clamped))
  } catch {
    // private mode — zoom still applies for this session
  }
  document.documentElement.style.zoom = String(clamped / 100)
  for (const cb of zoomListeners) cb({ level: 0, percent: clamped })
}

// Apply persisted zoom on boot (module scope, right after the bridge installs).
if (typeof document !== 'undefined') {
  applyZoomPercent(readZoomPercent())
}

function pickWebFiles(multiple: boolean, accept?: string): Promise<string[]> {
  // Prefer the File System Access API when available (Chromium desktop):
  // it returns File objects directly, has no gesture-context race, and its
  // AbortError maps cleanly to "cancelled". Falls back to the hidden-input
  // flow (required on iOS Safari, which doesn't ship showOpenFilePicker).
  if (typeof window.showOpenFilePicker === 'function') {
    const pick = window.showOpenFilePicker as (options?: WebFilePickerOptions) => Promise<WebFilePickerHandle[]>
    return (async () => {
      try {
        const acceptTypes = accept ? { '*/*': [`.${accept.split(',').map(s => s.trim()).join(',.')}`] } : undefined
        const handles = await pick({
          multiple,
          ...(acceptTypes ? { types: [{ description: 'Files', accept: { 'application/octet-stream': Object.values(acceptTypes['*/*']) } }] } : {}),
        })
        const files = await Promise.all(handles.map(h => h.getFile()))
        if (!files.length) return []
        return files.map(file => {
          webInputSeq += 1
          const key = `web-input:${webInputSeq}`
          webInputFiles.set(key, file)
          return key
        })
      } catch (err) {
        // AbortError = user closed the picker. Any other error falls through
        // to the input path as a last resort (older Chromium).
        if ((err as Error).name === 'AbortError') return []
        return pickWebFilesViaInput(multiple, accept)
      }
    })()
  }
  return pickWebFilesViaInput(multiple, accept)
}

function pickWebFilesViaInput(multiple: boolean, accept?: string): Promise<string[]> {
  return new Promise((resolve) => {
    const input = document.createElement('input')
    input.type = 'file'
    input.multiple = multiple
    if (accept) input.accept = accept
    input.style.display = 'none'
    document.body.appendChild(input)

    let settled = false
    let pending: File[] = []
    const settle = (paths: string[]) => {
      if (settled) return
      settled = true
      input.remove()
      window.removeEventListener('focus', onWindowFocus)
      resolve(paths)
    }

    // iOS/desktop both fire `change` when files are picked. BUT on iOS Safari
    // the window `focus` event (picker closing) can arrive BEFORE `change`,
    // and the picker's closing also fires `focus` when the page re-gains it.
    // Resolving on that focus with an empty file list drops the selection.
    // So: stash the files on `change` first, and only resolve the picker as
    // CANCELLED on focus when NO change ever fired. The cancel check must be
    // DELAYED well past the event: iOS populates input.files and dispatches
    // `change` only AFTER the focus event lands, so a 0ms timer sees an empty
    // list and wrongly cancels a real pick.
    const onWindowFocus = () => {
      window.setTimeout(() => {
        if (settled) return
        const files = [...(input.files ?? [])]
        if (files.length) {
          // `change` may still be queued; settle from what's already there.
          settle(
            files.map(file => {
              webInputSeq += 1
              const key = `web-input:${webInputSeq}`
              webInputFiles.set(key, file)
              return key
            })
          )
          return
        }
        // No files at all — the user cancelled (Escape / backdrop).
        settle([])
      }, 400)
    }

    input.onchange = () => {
      pending = [...(input.files ?? [])]
      if (!pending.length) {
        settle([])
        return
      }
      settle(
        pending.map((file) => {
          webInputSeq += 1
          const key = `web-input:${webInputSeq}`
          webInputFiles.set(key, file)
          return key
        })
      )
    }
    // Cancel (Escape / backdrop click) also resolves empty.
    window.addEventListener('focus', onWindowFocus, { once: true })
    input.click()
  })
}

function webFileForKey(key: string): File | null {
  return key.startsWith('web-input:') ? webInputFiles.get(key) ?? null : null
}

/** Store a Blob/File under a fresh virtual web-input path (paste, buffer
 *  save, drag-drop). Returns the virtual path the renderer can attach. */
function saveWebBlob(blob: Blob, filename: string): string {
  webInputSeq += 1
  const key = `web-input:${webInputSeq}`
  const file = new File([blob], filename, { type: blob.type || 'application/octet-stream' })
  webInputFiles.set(key, file)
  return key
}

function readWebFileDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result ?? ''))
    reader.onerror = () => reject(new Error('file read failed'))
    reader.readAsDataURL(file)
  })
}

function readWebFileText(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result ?? ''))
    reader.onerror = () => reject(new Error('file read failed'))
    reader.readAsText(file)
  })
}

/** Best-effort filename for a downloaded URL (path basename, else timestamp). */
function imageFileNameFromUrl(url: string): string {
  try {
    const name = decodeURIComponent(new URL(url).pathname.split('/').pop() ?? '')
    return name || `download-${Date.now()}`
  } catch {
    return `download-${Date.now()}`
  }
}

/** Mint a single-use WS ticket (v0.20.0 cookie auth), then build the URL. */
async function mintWsUrl(profile?: null | string): Promise<string> {
  const { ticket } = await fetchJson<{ ticket: string }>('/api/auth/ws-ticket', {
    method: 'POST',
  })
  return buildHermesWebSocketUrl({
    path: '/api/ws',
    authParam: ['ticket', ticket],
  })
}

// ── v2 multi-connection registry (remote gateways) ──────────────────────────
// The renderer's registry UI + routing call the proxy's /web-connections door;
// token bytes never reach the browser (the door redacts to tokenSet/
// tokenPreview, and the proxy injects auth on forwarded requests).

const LOCAL_CONNECTION_ID = 'local'
const CONNECTIONS_DOOR = `${API_BASE}/web-connections`

function isNonLocalConnection(connectionId: null | undefined | string): boolean {
  const id = String(connectionId ?? '').trim()
  return Boolean(id) && id !== LOCAL_CONNECTION_ID
}

/** Same-origin base the renderer can address for a remote connection. The
 *  browser NEVER talks to the remote origin directly (CORS + secret safety):
 *  the proxy routes by X-Hermes-Connection-Id / ?connection=<id>. */
function connectionBaseUrl(): string {
  return API_BASE || window.location.origin
}

async function listConnections(): Promise<DesktopConnectionsRegistry> {
  return fetchJson<DesktopConnectionsRegistry>(`${CONNECTIONS_DOOR}`)
}

/** Resolve a registry connection's renderer-facing descriptor (redacted —
 *  token is always ''; the proxy holds the secret). */
async function getConnectionFor(payload?: { connectionId?: null | string; profile?: null | string }): Promise<HermesConnection> {
  const connectionId = String(payload?.connectionId ?? '').trim()
  const profile = payload?.profile ?? null

  if (!isNonLocalConnection(connectionId)) {
    // Local / empty → the legacy same-origin connection.
    return window.hermesDesktop.getConnection(profile)
  }

  const registry = await listConnections()
  const conn = registry.connections.find(c => c.id === connectionId)
  if (!conn) {
    throw new Error(`No connection with id "${connectionId}"`)
  }

  return {
    baseUrl: connectionBaseUrl(),
    isFullscreen: false,
    mode: 'remote',
    authMode: conn.authMode === 'oauth' ? 'oauth' : 'token',
    remoteKind: conn.kind === 'cloud' ? 'cloud' : 'url',
    remoteHermesVersion: undefined,
    nativeOverlayWidth: 0,
    source: 'settings',
    token: '',
    wsUrl: '', // never used for remotes: getGatewayWsUrlFor is always present
    logs: [],
    profile: profile ?? undefined,
    connectionId,
    windowButtonPosition: null,
  }
}

/** Same-origin WS URL for a connection: ?connection=<id> for remotes (the
 *  proxy injects ?token= server-side), local keeps the ?ticket= path. */
async function getGatewayWsUrlFor(payload?: { connectionId?: null | string; profile?: null | string }): Promise<{ ok: true; wsUrl: string } | { ok: false; error: string }> {
  const connectionId = String(payload?.connectionId ?? '').trim()

  if (!isNonLocalConnection(connectionId)) {
    try {
      const wsUrl = await mintWsUrl(payload?.profile ?? null)
      return { ok: true, wsUrl }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  }

  // Ensure the connection still exists (the renderer dials a stale id after a
  // removal → permanent missing-connection error, same as Electron).
  try {
    const registry = await listConnections()
    if (!registry.connections.some(c => c.id === connectionId)) {
      return { ok: false, error: `No connection with id "${connectionId}"` }
    }
  } catch {
    // Registry door unreachable → still return a URL; the socket error will
    // surface and the renderer's reconnect loop retries.
  }

  return {
    ok: true,
    wsUrl: buildHermesWebSocketUrl({
      path: '/api/ws',
      params: { connection: connectionId },
    }),
  }
}

async function testConnection(id: string): Promise<{ ok?: boolean; reachable?: boolean; error?: string | null; version?: string | null; installId?: string }> {
  return fetchJson<{ ok?: boolean; reachable?: boolean; error?: string | null; version?: string | null; installId?: string }>(
    `${CONNECTIONS_DOOR}/${encodeURIComponent(id)}/test`,
    { method: 'POST' },
  )
}

/** Kebab-slug of a label for @handles — mirrors electron/connection-registry.ts
 *  `labelSlug` exactly so the web port produces identical duplicate-agent names. */
function labelSlug(label: string): string {
  const slug = String(label || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)

  return slug || 'connection'
}

/** Fetch a connection's profile names via `/api/profiles` (local = same-origin
 *  cookie auth; remote = routed through the proxy with the connection header). */
async function fetchConnectionProfiles(connectionId: null | string): Promise<string[]> {
  try {
    const body = await window.hermesDesktop.api<{ profiles?: { name?: string }[] }>({
      path: '/api/profiles',
      method: 'GET',
      connectionId,
    })
    const names = Array.isArray(body?.profiles)
      ? body.profiles.map(p => String(p?.name || '').trim()).filter(Boolean)
      : []
    if (!names.includes('default')) names.unshift('default')
    return names
  } catch {
    return ['default']
  }
}

/** Enumerate each connection's profiles + reachability, then build the union
 *  agent roster with the desktop's @name-device disambiguation. Unreachable
 *  remotes land in `sources` with an error; duplicate install_ids collapse
 *  into one source (same physical backend under two addresses). */
async function getAgentRoster(): Promise<DesktopAgentRoster> {
  const registry = await listConnections()
  const local = registry.connections.find(c => c.id === LOCAL_CONNECTION_ID)

  const sources: DesktopAgentRoster['sources'] = []

  // (connectionId, profile) → { label, kind } — one row per routable identity.
  const identities: { connectionId: string; kind: DesktopRegistryConnection['kind']; label: string; profile: string }[] = []

  if (local) {
    sources.push({ connectionId: local.id, label: local.label, kind: local.kind, reachable: true })
    for (const profile of await fetchConnectionProfiles(local.id)) {
      identities.push({ connectionId: local.id, kind: local.kind, label: local.label, profile })
    }
  }

  for (const conn of registry.connections) {
    if (conn.kind === 'local' || conn.kind === 'ssh') continue

    let reachable = false
    let error: string | undefined
    let installId: string | undefined

    try {
      const result = await testConnection(conn.id)
      reachable = result.ok === true || result.reachable === true
      if (!reachable) error = result.error ?? 'unreachable'
      if (result.installId) installId = result.installId
    } catch (err) {
      error = err instanceof Error ? err.message : String(err)
    }

    sources.push({ connectionId: conn.id, label: conn.label, kind: conn.kind, reachable, error, installId })

    // Only enumerate profiles for a reachable remote (an unreachable one has
    // none to route to; it stays listed in sources with its error).
    if (reachable) {
      for (const profile of await fetchConnectionProfiles(conn.id)) {
        identities.push({ connectionId: conn.id, kind: conn.kind, label: conn.label, profile })
      }
    }
  }

  // Duplicate-profile disambiguation (desktop buildAgentRoster): a profile name
  // appearing on >1 connection gets the @name-device handle; unique keeps bare.
  const counts = new Map<string, number>()
  for (const { profile } of identities) counts.set(profile, (counts.get(profile) || 0) + 1)

  const agents: DesktopAgentRoster['agents'] = identities.map(({ connectionId, kind, label, profile }) => ({
    connectionId,
    connectionKind: kind,
    connectionLabel: label,
    profile,
    handle: (counts.get(profile) || 0) > 1 ? `${profile}-${labelSlug(label)}` : profile,
  }))

  return { agents, sources }
}

/** Credential-free routes across every registry source. The optional profile
 *  list is only used by the single-local v1 fallback. */
async function getProfileRoutes(profiles: string[]): Promise<DesktopPluginProfileRoute[]> {
  const registry = await listConnections()
  const hasRemote = registry.connections.some(c => c.kind !== 'local' && c.kind !== 'ssh')

  if (!hasRemote) {
    // Sole-local registry: v1 profile-name routes (byte-identical legacy).
    return (profiles ?? []).map(profile => ({
      connectionId: LOCAL_CONNECTION_ID,
      mode: 'local' as const,
      profile,
      targetProfile: profile,
    }))
  }

  const routes: DesktopPluginProfileRoute[] = []
  for (const conn of registry.connections) {
    if (conn.kind === 'ssh') continue
    if (conn.kind === 'local') {
      for (const profile of profiles ?? []) {
        routes.push({ connectionId: conn.id, mode: 'local', profile, targetProfile: profile })
      }
      continue
    }
    // Remote/cloud: the connection's own profiles (probed by the caller via
    // requestProfile when dialed). 'default' is the guaranteed profile.
    routes.push({ connectionId: conn.id, mode: 'remote', profile: conn.remoteProfile || 'default', targetProfile: conn.remoteProfile || 'default' })
  }
  return routes
}

async function saveConnection(payload: DesktopRegistryConnectionInput): Promise<{ ok: boolean; connection: DesktopRegistryConnection; registry: DesktopConnectionsRegistry }> {
  return fetchJson<{ ok: boolean; connection: DesktopRegistryConnection; registry: DesktopConnectionsRegistry }>(
    CONNECTIONS_DOOR,
    { method: 'PUT', body: JSON.stringify(payload) },
  )
}

async function removeConnection(id: string): Promise<{ ok: boolean; registry: DesktopConnectionsRegistry }> {
  return fetchJson<{ ok: boolean; registry: DesktopConnectionsRegistry }>(
    `${CONNECTIONS_DOOR}/${encodeURIComponent(id)}`,
    { method: 'DELETE' },
  )
}

async function setPrimaryConnection(id: string): Promise<{ ok: boolean; registry: DesktopConnectionsRegistry }> {
  return fetchJson<{ ok: boolean; registry: DesktopConnectionsRegistry }>(
    `${CONNECTIONS_DOOR}/${encodeURIComponent(id)}/primary`,
    { method: 'POST' },
  )
}

// --- terminal: real PTY over /web-term WS -------------------------------------

interface TermSession {
  id: string
  ws: WebSocket
  cwd: string
  dataListener: ((data: string) => void) | null
  exitListener: ((p: { code: number | null; signal: string | null }) => void) | null
  dataBuf: string[]
  exit: { code: number | null; signal: string | null } | null
}

function makeTerminal() {
  const sessions = new Map<string, TermSession>()
  let seq = 0

  const openSession = (opts?: { cols?: number; cwd?: string; rows?: number }) =>
    new Promise<TermSession>((resolve, reject) => {
      const id = `term-${Date.now().toString(36)}-${++seq}`
      const q = new URLSearchParams()
      if (opts?.cwd) q.set('cwd', opts.cwd)
      q.set('cols', String(opts?.cols ?? 80))
      q.set('rows', String(opts?.rows ?? 24))

      const session: TermSession = {
        id,
        ws: null as unknown as WebSocket,
        cwd: opts?.cwd ?? '',
        dataListener: null,
        exitListener: null,
        dataBuf: [],
        exit: null,
      }
      sessions.set(id, session)

      const ws = new WebSocket(`${wsBase()}/web-term?${q.toString()}`)
      session.ws = ws

      ws.addEventListener('open', () => resolve(session), { once: true })
      ws.addEventListener(
        'error',
        () => {
          sessions.delete(id)
          reject(new Error('terminal ws connect failed'))
        },
        { once: true },
      )

      ws.addEventListener('message', (ev) => {
        let msg: { type?: string; data?: string; code?: number | null; signal?: string | null }
        try {
          msg = JSON.parse(String(ev.data))
        } catch {
          return
        }
        if (msg.type === 'output' && typeof msg.data === 'string') {
          if (session.dataListener) session.dataListener(msg.data)
          else session.dataBuf.push(msg.data)
        } else if (msg.type === 'exit') {
          const payload = { code: msg.code ?? null, signal: msg.signal ?? null }
          session.exit = payload
          if (session.exitListener) session.exitListener(payload)
        }
      })

      ws.addEventListener('close', () => {
        sessions.delete(id)
        if (!session.exit) {
          const payload = { code: null, signal: null }
          session.exit = payload
          if (session.exitListener) session.exitListener(payload)
        }
      })
    })

  return {
    cwd: async () => null,
    dispose: async (id: string) => {
      const s = sessions.get(id)
      if (!s) return false
      sessions.delete(id)
      try {
        s.ws.close()
      } catch {
        /* ignore */
      }
      return true
    },
    onData: (id: string, callback: (data: string) => void) => {
      const s = sessions.get(id)
      if (!s) return () => {}
      s.dataListener = callback
      if (s.dataBuf.length) {
        const buf = s.dataBuf
        s.dataBuf = []
        for (const d of buf) callback(d)
      }
      return () => {
        if (s.dataListener === callback) s.dataListener = null
      }
    },
    onExit: (id: string, callback: (p: { code: number | null; signal: string | null }) => void) => {
      const s = sessions.get(id)
      if (!s) return () => {}
      s.exitListener = callback
      if (s.exit) callback(s.exit)
      return () => {
        if (s.exitListener === callback) s.exitListener = null
      }
    },
    resize: async (id: string, size: { cols: number; rows: number }) => {
      const s = sessions.get(id)
      if (!s || s.ws.readyState !== WebSocket.OPEN) return false
      s.ws.send(JSON.stringify({ type: 'resize', cols: size.cols, rows: size.rows }))
      return true
    },
    start: async (opts?: { cols?: number; cwd?: string; rows?: number }) => {
      const session = await openSession(opts)
      // The server shells with process.env.SHELL || /bin/bash; report a sane
      // fallback so the renderer's drop-path quoting stays correct.
      return { id: session.id, cwd: session.cwd, shell: 'bash' }
    },
    write: async (id: string, data: string) => {
      const s = sessions.get(id)
      if (!s || s.ws.readyState !== WebSocket.OPEN) return false
      s.ws.send(JSON.stringify({ type: 'input', data }))
      return true
    },
  }
}


// ── bridge ──────────────────────────────────────────────────────────────────

export function installWebBridge(): void {
  const bridge: Window['hermesDesktop'] = {
    // --- connection ---------------------------------------------------------
    getConnection: async (profile) => ({
      baseUrl: API_BASE || window.location.origin,
      isFullscreen: false,
      mode: 'local',
      authMode: 'token',
      nativeOverlayWidth: 0,
      source: 'env',
      token: '',
      wsUrl: await mintWsUrl(profile),
      logs: [],
      profile: profile ?? undefined,
      windowButtonPosition: null,
    }),

    // Registry-scoped backend resolution (token never returned; the proxy
    // injects it server-side).
    getConnectionFor: async (payload) => getConnectionFor(payload),

    // Union agent roster across every registered source.
    getAgentRoster,

    revalidateConnection: async () => ({ ok: true, rebuilt: false }),
    touchBackend: async () => ({ ok: true }),
    // Credential-free routes across the union connection registry (local +
    // registered remotes). The web port resolves the profile list from the
    // local backend's /api/profiles; remotes advertise 'default' (+ their
    // stored remoteProfile) and are probed by the caller on dial.
    getProfileRoutes,

    // Registry-scoped WS URL (same contract as getGatewayWsUrl): remotes get
    // ?connection=<id>, local keeps the ?ticket= path.
    getGatewayWsUrlFor: async (payload) => getGatewayWsUrlFor(payload),

    getGatewayWsUrl: async (profile) => mintWsUrl(profile).then(
      (wsUrl) => ({ ok: true as const, wsUrl }),
      (error: unknown) => ({
        error: error instanceof Error ? error.message : String(error),
        ok: false as const,
      }),
    ),

    // --- REST -----------------------------------------------------------------
    api: async <T>(request: {
      path: string
      method?: string
      body?: unknown
      timeoutMs?: number
      connectionId?: null | string
      profile?: null | string
    }): Promise<T> => {
      const { path, method = 'GET', body, timeoutMs, connectionId } = request
      const init: RequestInit = { method }
      const headers: Record<string, string> = {}
      if (body !== undefined) {
        headers['Content-Type'] = 'application/json'
        init.body = typeof body === 'string' ? body : JSON.stringify(body)
      }
      // Registry-scoped routing: the proxy resolves the connection id and
      // injects auth server-side. No (non-local) id → no header → the legacy
      // local path, byte-identical.
      if (isNonLocalConnection(connectionId)) {
        headers['X-Hermes-Connection-Id'] = String(connectionId).trim()
      }
      if (Object.keys(headers).length) init.headers = headers
      return fetchJson<T>(path, init, timeoutMs ?? 30_000)
    },

    // --- windows / overlays: browser tabs stand in for OS windows --------------
    // Electron opens a real BrowserWindow at `?win=secondary[&watch=1]#/<id>`
    // (see apps/desktop/electron/session-windows.ts buildSessionWindowUrl) — the
    // renderer already reads those flags from location.search (store/windows.ts)
    // to render the compact secondary-window chrome and lazy-resume watch mode.
    // A browser has no window-management API, but a new tab at the exact same
    // URL shape drives the identical renderer code path, so open it there.
    openSessionWindow: async (sessionId: string, opts?: { watch?: boolean }) => {
      if (!sessionId) {
        return { ok: false, error: 'invalid-session-id' }
      }
      const query = `?win=secondary${opts?.watch ? '&watch=1' : ''}`
      const url = `${window.location.origin}${window.location.pathname}${query}#/${encodeURIComponent(sessionId)}`
      const opened = window.open(url, '_blank', 'noopener')
      return opened ? { ok: true } : { ok: false, error: 'popup-blocked' }
    },
    // No local terminal to hand a session to from a browser tab: Electron
    // spawns `hermes --tui --resume <id>` in the user's own terminal emulator
    // on the machine it's running on — a browser tab can't launch OS
    // processes. Bridge contract requires this member (global.d.ts is
    // upstream-synced), so report failure rather than pretending to open one;
    // the button click surfaces this as a toast via runWindowOpen().
    openSessionInTerminal: async () => ({
      ok: false,
      error: 'unsupported-in-web: open a terminal on the machine running the backend and run `hermes --tui --resume <sessionId>`',
    }),
    openWindow: async () => {
      const url = `${window.location.origin}${window.location.pathname}`
      const opened = window.open(url, '_blank', 'noopener')
      return opened ? { ok: true } : { ok: false, error: 'popup-blocked' }
    },
    claimAmbientCue: async () => true,

    petOverlay: {
      open: async () => ({ ok: false }),
      close: async () => ({ ok: false }),
      setBounds: () => {},
      setIgnoreMouse: () => {},
      setFocusable: () => {},
      pushState: () => {},
      control: () => {},
      onState: () => () => {},
      onControl: () => () => {},
    },

    hud: {
      open: async () => ({ ok: false }),
      close: async () => ({ ok: false }),
      setIgnoreMouse: () => {},
      moveBy: () => {},
      setBounds: () => {},
      setVibrancy: async () => ({ ok: false }),
      setSession: () => {},
      onGoto: () => () => {},
      onChanged: () => () => {},
      onCursor: () => () => {},
    },

    quickEntry: {
      getSettings: async () => ({ enabled: false, error: null, registered: false, shortcut: '' }),
      setSettings: async () => ({ enabled: false, error: null, registered: false, shortcut: '' }),
      submit: () => {},
      dismiss: () => {},
      pushState: () => {},
      onState: () => () => {},
      onSubmit: () => () => {},
      onShown: () => () => {},
    },

    wakeIndicator: {
      getState: async () => 'hidden',
      setState: () => {},
      onState: () => () => {},
    },

    // --- boot / system ----------------------------------------------------------
    getBootProgress: async () => ({
      error: null,
      fakeMode: false,
      phase: 'renderer.ready',
      progress: 100,
      message: 'Web bridge ready',
      running: false,
      timestamp: Date.now(),
    }),
    onBootProgress: () => () => {},

    getBootstrapState: async () => ({
      active: false,
      manifest: null,
      stages: {},
      error: null,
      log: [],
      startedAt: null,
      completedAt: Date.now(),
      setupChoice: null,
      unsupportedPlatform: null,
    }),
    continueBootstrapLocal: async () => ({ ok: true }),
    resetBootstrap: async () => ({ ok: true }),
    repairBootstrap: async () => ({ ok: true }),
    cancelBootstrap: async () => ({ ok: true, cancelled: true }),
    onBootstrapEvent: () => () => {},

    getVersion: async () => ({
      appVersion: 'web',
      electronVersion: 'web',
      nodeVersion: 'web',
      platform: 'web',
      hermesRoot: '',
    }),

    // --- connection settings: local-only, read-only -----------------------------
    getConnectionConfig: async () => ({
      envOverride: true,
      mode: 'local',
      profile: null,
      remoteAuthMode: 'token',
      remoteOauthConnected: false,
      remoteTokenPreview: null,
      remoteTokenSet: false,
      secureTokenStorage: false,
      remoteTokenPlainText: false,
      remoteUrl: '',
      cloudOrg: '',
      sshHost: '',
      sshUser: '',
      sshPort: null,
      sshKeyPath: '',
      sshRemoteHermesPath: '',
      sshRemoteProfile: '',
    }),
    saveConnectionConfig: async () => ({
      envOverride: true,
      mode: 'local',
      profile: null,
      remoteAuthMode: 'token',
      remoteOauthConnected: false,
      remoteTokenPreview: null,
      remoteTokenSet: false,
      secureTokenStorage: false,
      remoteTokenPlainText: false,
      remoteUrl: '',
      cloudOrg: '',
      sshHost: '',
      sshUser: '',
      sshPort: null,
      sshKeyPath: '',
      sshRemoteHermesPath: '',
      sshRemoteProfile: '',
    }),
    applyConnectionConfig: async () => ({
      envOverride: true,
      mode: 'local',
      profile: null,
      remoteAuthMode: 'token',
      remoteOauthConnected: false,
      remoteTokenPreview: null,
      remoteTokenSet: false,
      secureTokenStorage: false,
      remoteTokenPlainText: false,
      remoteUrl: '',
      cloudOrg: '',
      sshHost: '',
      sshUser: '',
      sshPort: null,
      sshKeyPath: '',
      sshRemoteHermesPath: '',
      sshRemoteProfile: '',
    }),
    testConnectionConfig: async () => ({
      ok: false,
      reachable: false,
      error: 'readonly-in-web',
      version: null,
    }),
    sshConfigHosts: async () => ({ hosts: [] }),
    sshResolveHost: async () => ({ hostname: null, identityFile: null, port: null, user: null }),
    probeConnectionConfig: async () => ({
      baseUrl: '',
      reachable: false,
      authMode: 'unknown',
      providers: [],
      version: null,
      error: 'unsupported-in-web',
    }),
    oauthLoginConnectionConfig: async () => ({ ok: false, baseUrl: '', connected: false }),
    oauthLogoutConnectionConfig: async () => ({ ok: false, connected: false }),

    // --- v2 multi-connection registry: proxied CRUD over the local door.
    // The renderer never receives token bytes (the door redacts); the proxy
    // injects auth on routed requests. --------------------------------
    connections: {
      list: async () => listConnections(),
      save: async (payload) => saveConnection(payload),
      remove: async (id) => removeConnection(id),
      setPrimary: async (id) => setPrimaryConnection(id),
      test: async (id) => testConnection(id),
    },

    cloud: {
      status: async () => ({ portalBaseUrl: '', signedIn: false }),
      login: async () => ({ portalBaseUrl: '', signedIn: false, ok: false }),
      logout: async () => ({ portalBaseUrl: '', signedIn: false, ok: false }),
      discover: async () => ({ agents: [], needsOrgSelection: false }),
      agentSignIn: async () => ({ baseUrl: '', connected: false }),
    },

    profile: {
      get: async () => ({ profile: null }),
      set: async () => ({ profile: null }),
    },

    // --- zoom / UI scale: CSS zoom on the root, persisted to localStorage ------
    zoom: {
      get: async () => ({ level: 0, percent: readZoomPercent() }),
      setPercent: (percent: number) => {
        applyZoomPercent(percent)
      },
      onChanged: (callback: (payload: { level: number; percent: number }) => void) => {
        zoomListeners.add(callback)
        return () => zoomListeners.delete(callback)
      },
    },

    // --- notifications / media ----------------------------------------------------
    notify: async () => true,
    // The browser handles mic permission natively via getUserMedia; report
    // capability instead of denying unconditionally. False only when the
    // browser has no getUserMedia/MediaRecorder (insecure context, old UA) —
    // the voice recorder surfaces that as "runtime does not support mic".
    requestMicrophoneAccess: async () => {
      try {
        const hasApi = typeof navigator !== 'undefined' && Boolean(navigator.mediaDevices?.getUserMedia) && typeof MediaRecorder !== 'undefined'
        if (!hasApi) return false
        // Probe for at least one audio input without consuming the device:
        // enumerateDevices tells us whether the platform exposes a mic at all.
        const devices = await navigator.mediaDevices.enumerateDevices().catch(() => null)
        if (devices === null) return true
        return devices.some(d => d.kind === 'audioinput')
      } catch {
        return true
      }
    },

    // --- files / clipboard: browser-native -----------------------------------------
    readFileDataUrl: async (filePath) => {
      const picked = webFileForKey(filePath)
      if (picked) return readWebFileDataUrl(picked)
      const res = await fetch(`/web-fs/read-data-url?path=${encodeURIComponent(filePath)}`)
      if (!res.ok) throw new Error(`web-fs: HTTP ${res.status}`)
      const json = await res.json()
      return json.dataUrl as string
    },
    // Desktop-plugins door: the runtime loader reads `<hermes home>/desktop-plugins/<name>/plugin.js`
    // off local disk in Electron. In the web port that disk is the proxy host's folder,
    // exposed as a virtual `/plugins` root via /api/plugins-door/*. Everything else
    // resolves against the proxy's /web-fs door (WEB_FS_ROOT).
    desktopPluginsRoot: async () => '/plugins',
    readFileText: async (filePath) => {
      const picked = webFileForKey(filePath)
      if (picked) {
        const text = await readWebFileText(picked)
        return { path: filePath, text }
      }
      if (filePath?.startsWith('/plugins/')) {
        const res = await fetch(`/api/plugins-door/file?path=${encodeURIComponent(filePath)}`)
        if (!res.ok) throw new Error(`plugin door: HTTP ${res.status}`)
        return res.json()
      }
      const res = await fetch(`/web-fs/read-text?path=${encodeURIComponent(filePath)}`)
      if (!res.ok) throw new Error(`web-fs: HTTP ${res.status}`)
      return res.json()
    },
    // Browsers cannot expose a real filesystem path from <input type="file">;
    // the renderer's pickers therefore get virtual web-input:<n> paths backed
    // by File objects, which readFileText/readFileDataUrl resolve above.
    selectPaths: async (options) => pickWebFiles(options?.multiple !== false, options?.filters?.[0]?.extensions?.join(',')),
    // Real filename for a virtual web-input:<n> path (the File object keeps
    // its original name — e.g. "voice-memo.m4a" — while the path is just the
    // sequence key). Lets pathLabel/imageFilenameFromPath show and upload
    // with the true name instead of the opaque web-input:N. Non-virtual
    // paths return null so callers fall back to path parsing.
    fileNameForPath: (filePath) => webFileForKey(filePath)?.name ?? null,
    writeClipboard: async (text) => {
      // navigator.clipboard.writeText only exists in secure contexts
      // (HTTPS / localhost). On LAN-IP http (phone testing) it's undefined,
      // so fall back to the legacy execCommand('copy') textarea trick, which
      // works on any page the browser allows.
      try {
        if (navigator.clipboard?.writeText) {
          await navigator.clipboard.writeText(text)
          return true
        }
      } catch {
        // Fall through to the execCommand path.
      }
      try {
        const textarea = document.createElement('textarea')
        textarea.value = text
        textarea.setAttribute('readonly', '')
        textarea.style.position = 'fixed'
        textarea.style.opacity = '0'
        document.body.appendChild(textarea)
        textarea.select()
        textarea.setSelectionRange(0, text.length)
        const ok = document.execCommand('copy')
        textarea.remove()
        return ok
      } catch {
        return false
      }
    },
    readClipboard: async () => {
      try {
        return await navigator.clipboard.readText()
      } catch {
        return ''
      }
    },
    saveImageFromUrl: async (url) => {
      try {
        // Web port: fetch the image and trigger a browser download. Returns
        // true so the app's "saved" toast path fires like the native save.
        const res = await fetch(url, { credentials: 'include' })
        if (!res.ok) return false
        const blob = await res.blob()
        const objectUrl = URL.createObjectURL(blob)
        const a = document.createElement('a')
        a.href = objectUrl
        a.download = imageFileNameFromUrl(url)
        document.body.appendChild(a)
        a.click()
        a.remove()
        window.setTimeout(() => URL.revokeObjectURL(objectUrl), 10_000)
        return true
      } catch {
        return false
      }
    },
    saveImageBuffer: async (data, ext) => {
      // Web port: stash the raw bytes as a virtual web-input:<n> file so the
      // app's normal attach path (readFileDataUrl → image.attach_bytes) works.
      try {
        const bytes = data instanceof Uint8Array ? data : new Uint8Array(data ?? [])
        const mime = ext ? `image/${ext.replace(/^\./, '')}` : 'application/octet-stream'
        const blob = new Blob([bytes.buffer as ArrayBuffer], { type: mime })
        return saveWebBlob(blob, ext ? `clipboard.${ext.replace(/^\./, '')}` : 'clipboard.bin')
      } catch {
        throw new Error('unsupported-in-web')
      }
    },
    saveClipboardImage: async () => {
      // Web port: read an image off the clipboard (Async Clipboard API), then
      // stash it as a virtual web-input file. The renderer's paste-image flow
      // calls saveClipboardImage() and attaches the returned path.
      try {
        const items = await navigator.clipboard.read()
        const item = items.find(i => i.types.some(t => t.startsWith('image/')))
        if (!item) return ''
        const type = item.types.find(t => t.startsWith('image/'))!
        const blob = await item.getType(type)
        const ext = type.split('/')[1] ?? 'png'
        return saveWebBlob(blob, `clipboard.${ext}`)
      } catch {
        return ''
      }
    },
    getPathForFile: () => '',
    normalizePreviewTarget: async () => null,
    watchPreviewFile: async () => ({ id: '', path: '' }),
    stopPreviewFileWatch: async () => true,

    openExternal: async (url) => {
      window.open(url, '_blank', 'noopener')
    },
    openPreviewInBrowser: async (url) => {
      window.open(url, '_blank', 'noopener')
    },
    fetchLinkTitle: async (url) => {
      try {
        const res = await fetch(url, { method: 'HEAD' })
        return res.headers.get('x-title') ?? ''
      } catch {
        return ''
      }
    },
    sanitizeWorkspaceCwd: async (cwd) => ({ cwd: cwd ?? '', sanitized: false }),

    settings: {
      getDefaultProjectDir: async () => ({ defaultLabel: 'Home', dir: null, resolvedCwd: '' }),
      pickDefaultProjectDir: async () => ({ canceled: true, dir: null }),
      setDefaultProjectDir: async () => ({ dir: null }),
    },

    revealLogs: async () => ({ ok: false, path: '', error: 'unsupported-in-web' }),
    getRecentLogs: async () => ({ path: '', lines: [] }),

    readDir: async (dir) => {
      if (dir === '/plugins') {
        const res = await fetch('/api/plugins-door/list')
        if (!res.ok) return { entries: [] }
        return res.json()
      }
      const res = await fetch(`/web-fs/list?path=${encodeURIComponent(dir)}`)
      if (!res.ok) return { entries: [] }
      return res.json()
    },
    writeTextFile: async (filePath, content) => {
      const res = await fetch('/web-fs/write-text', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: filePath, content }),
      })
      if (!res.ok) throw new Error(`web-fs: HTTP ${res.status}`)
      return res.json()
    },
    gitRoot: async (filePath) => {
      const res = await fetch(`/web-fs/git-root?path=${encodeURIComponent(filePath)}`)
      if (!res.ok) return null
      const json = await res.json()
      return (json.root as string) ?? null
    },
    revealPath: async () => false,
    openDir: async () => ({ ok: false, error: 'unsupported-in-web' }),

    // --- events: no-op subscriptions -----------------------------------------------
    onPreviewFileChanged: () => () => {},
    onBackendExit: () => () => {},
    onConnectionApplied: () => () => {},
    onPowerResume: () => () => {},
    onClosePreviewRequested: () => () => {},
    onOpenFolderRequested: () => () => {},
    onOpenUpdatesRequested: () => () => {},
    onNotificationAction: () => () => {},
    onFocusSession: () => () => {},
    onWindowStateChanged: () => () => {},
    onDeepLink: () => () => {},
    signalDeepLinkReady: async () => ({ ok: true }),
    onFoundInPage: () => () => {},
    findInPage: async () => ({ count: 0 }),
    stopFindInPage: async () => {},
    // Ctrl/Cmd+F OS-compositor grab workaround: Electron-only (main forwards a
    // pre-empted accelerator). The browser never pre-empts the chord.
    onOpenFindBarRequested: () => () => {},
    getOnBattery: async () => false,
    onBatteryChanged: () => () => {},

    // --- updates / uninstall / themes: unsupported, no-op ----------------------------
    updates: {
      check: async () => ({ supported: false }),
      apply: async () => ({ ok: false, error: 'unsupported-in-web' }),
      getBranch: async () => ({ branch: '' }),
      setBranch: async () => ({ branch: '' }),
      onProgress: () => () => {},
    },
    uninstall: {
      summary: async () => {
        throw new Error('unsupported-in-web')
      },
      run: async () => {
        throw new Error('unsupported-in-web')
      },
    },
    themes: {
      fetchMarketplace: async (id: string) => {
        const res = await fetch(`/api/marketplace/fetch?id=${encodeURIComponent(id)}`, {
          credentials: 'include',
        })
        if (!res.ok) {
          const body = await res.json().catch(() => ({}))
          throw new Error(body?.detail || `marketplace fetch failed (HTTP ${res.status})`)
        }
        return (await res.json()) as DesktopMarketplaceThemeResult
      },
      searchMarketplace: async (query: string) => {
        const res = await fetch(`/api/marketplace/search?q=${encodeURIComponent(query || '')}&limit=20`, {
          credentials: 'include',
        })
        if (!res.ok) {
          const body = await res.json().catch(() => ({}))
          throw new Error(body?.detail || `marketplace search failed (HTTP ${res.status})`)
        }
        const data = (await res.json()) as { items: DesktopMarketplaceSearchItem[] }
        return data.items ?? []
      },
    },

    // --- terminal: real PTY over /web-term WS --------------------------------------
    terminal: makeTerminal(),
  }
  window.hermesDesktop = bridge
}

// Self-install at module scope. Import hoisting means a bare `installWebBridge()`
// call in main.tsx runs AFTER the app's module graph evaluates — and
// `app/contrib/controller.tsx` discovers runtime plugins at MODULE scope
// (watchRuntimePlugins → scanDiskPlugins), so the bridge must already exist
// when that runs. web-bridge.ts is imported before `./app` in main.tsx, so
// module-scope evaluation order guarantees the install happens first.
if (!window.hermesDesktop) {
  installWebBridge()
}
