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

    revalidateConnection: async () => ({ ok: true, rebuilt: false }),
    touchBackend: async () => ({ ok: true }),

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
    }): Promise<T> => {
      const { path, method = 'GET', body, timeoutMs } = request
      const init: RequestInit = { method }
      if (body !== undefined) {
        init.headers = { 'Content-Type': 'application/json' }
        init.body = typeof body === 'string' ? body : JSON.stringify(body)
      }
      return fetchJson<T>(path, init, timeoutMs ?? 30_000)
    },

    // --- windows / overlays: no-ops in a browser -------------------------------
    openSessionWindow: async () => ({ ok: false, error: 'unsupported-in-web' }),
    openWindow: async () => ({ ok: false, error: 'unsupported-in-web' }),
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

    // --- notifications / media ----------------------------------------------------
    notify: async () => true,
    requestMicrophoneAccess: async () => false,

    // --- files / clipboard: browser-native -----------------------------------------
    readFileDataUrl: async () => {
      throw new Error('unsupported-in-web')
    },
    // Desktop-plugins door: the runtime loader reads `<hermes home>/desktop-plugins/<name>/plugin.js`
    // off local disk in Electron. In the web port that disk is the proxy host's folder,
    // exposed as a virtual `/plugins` root via /api/plugins-door/*. Only that root is
    // served — everything else keeps the old empty result.
    desktopPluginsRoot: async () => '/plugins',
    readFileText: async (path) => {
      if (!path?.startsWith('/plugins/')) return { path: '', text: '' }
      const res = await fetch(`/api/plugins-door/file?path=${encodeURIComponent(path)}`)
      if (!res.ok) throw new Error(`plugin door: HTTP ${res.status}`)
      return res.json()
    },
    selectPaths: async () => [],
    writeClipboard: async (text) => {
      try {
        await navigator.clipboard.writeText(text)
        return true
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
    saveImageFromUrl: async () => false,
    saveImageBuffer: async () => {
      throw new Error('unsupported-in-web')
    },
    saveClipboardImage: async () => {
      throw new Error('unsupported-in-web')
    },
    getPathForFile: () => '',
    normalizePreviewTarget: async () => null,
    watchPreviewFile: async () => ({ id: '', path: '' }),
    stopPreviewFileWatch: async () => true,

    openExternal: async (url) => {
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
      if (dir !== '/plugins') return { entries: [] }
      const res = await fetch('/api/plugins-door/list')
      if (!res.ok) return { entries: [] }
      return res.json()
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
      fetchMarketplace: async () => {
        throw new Error('unsupported-in-web')
      },
      searchMarketplace: async () => [],
    },

    // --- terminal: unsupported in web -------------------------------------------------
    terminal: {
      cwd: async () => null,
      dispose: async () => true,
      onData: () => () => {},
      onExit: () => () => {},
      resize: async () => true,
      start: async () => {
        throw new Error('unsupported-in-web')
      },
      write: async () => false,
    },
  }
  window.hermesDesktop = bridge
}
