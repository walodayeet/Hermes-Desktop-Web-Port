/**
 * Server-side settings sync (web port).
 *
 * The desktop app persists appearance + plugin prefs in localStorage, which is
 * per-browser/per-device. The web port additionally mirrors the durable keys
 * to the proxy's `/web-settings` store so the same theme, mode, plugin
 * decisions, and installed themes follow the user across devices (phone,
 * laptop, another browser).
 *
 * Flow:
 *   - on boot (`hydrateServerSettings`), fetch the server store and write the
 *     durable keys into localStorage IF the server has a value (server wins —
 *     a fresh device picks up the saved setup);
 *   - every write to a durable key is captured through the persistence choke
 *     point (`onPersistenceEvent`) and pushed to the server (debounced).
 *
 * Keys NOT synced: per-session navigation, drafts, window positions, pet
 * placement, tool disclosures — those are legitimately per-device.
 */

import { onPersistenceEvent, readKey, writeKey } from './storage'
import { refreshPluginDecisions } from '@/contrib/plugins-store'
import { discoverRuntimePlugins } from '@/contrib/runtime-loader'
import { refreshUserThemes } from '@/themes/user-themes'

/**
 * localStorage keys that are durable user preferences and may be mirrored
 * server-side. Everything else stays local.
 */
const SYNCED_KEYS: ReadonlySet<string> = new Set([
  // Appearance — theme + mode (global + per-profile).
  'hermes-desktop-theme-v2',
  'hermes-desktop-mode-v1',
  'hermes-desktop-profile-themes-v1',
  'hermes-desktop-profile-modes-v1',
  'hermes-desktop-active-profile-v1',
  // NOTE: plugin enable/disable decisions are deliberately NOT synced. Plugin
  // on/off is a per-device/per-cookie preference — one browser may run the
  // Vietnamese UI, another may not — and the plugin LIST (inventory from
  // bundled + backend disk scan) is identical on every device regardless.
  // Syncing the decisions made a toggle on device A hide the plugin on device
  // B (and vice versa): "I don't see some plugins on some devices".
  // https://github.com/walodayeet/hermes-desktop-web — decisions stay in each
  // browser's localStorage (`hermes.desktop.pluginDecisions.v2` etc.).
  // User-installed themes (incl. marketplace installs).
  'hermes-desktop-user-themes-v1',
])

const ENDPOINT = '/web-settings'

function serverUrl(): string {
  return ENDPOINT
}

async function fetchServer(): Promise<Record<string, string>> {
  try {
    const res = await fetch(serverUrl(), { credentials: 'include', cache: 'no-store' })
    if (!res.ok) return {}
    const data = (await res.json()) as Record<string, unknown>
    const out: Record<string, string> = {}
    for (const [k, v] of Object.entries(data)) {
      if (SYNCED_KEYS.has(k) && typeof v === 'string') out[k] = v
    }
    return out
  } catch {
    return {}
  }
}

/**
 * Boot-time hydration: apply the server store's durable keys into localStorage
 * (server wins). Call once before the app paints so theme/plugins are correct
 * on first render. Never throws — a failed fetch keeps local state.
 */
export async function hydrateServerSettings(): Promise<void> {
  const server = await fetchServer()
  let touchedThemes = false
  let touchedPlugins = false
  for (const key of SYNCED_KEYS) {
    const value = server[key]
    if (value !== undefined) {
      writeKey(key, value)
      if (key === 'hermes-desktop-user-themes-v1') touchedThemes = true
      if (key === 'hermes.desktop.pluginDecisions.v2' || key === 'hermes.desktop.disabledPlugins.v1') touchedPlugins = true
    }
  }
  // The atoms init at module scope from localStorage (pre-hydration); refresh
  // them so server values apply on first paint without a reload.
  if (touchedThemes) refreshUserThemes()
  if (touchedPlugins) {
    refreshPluginDecisions()
    // Web port: disk plugins (e.g. Vietnamese UI) read their decisions at
    // MODULE scope during the pre-hydration scan, so a server-synced toggle
    // from another device was invisible until the next reload. Re-scan the
    // disk door now that the atom holds the hydrated truth — the loader
    // re-evaluates each plugin against the new decisions.
    void discoverRuntimePlugins().catch(() => undefined)
  }
  // Self-heal: mirror the merged local state (server wins for conflicts, but
  // keys that only exist locally — e.g. a theme installed before the sync
  // shipped — get pushed so a fresh device sees them too).
  const merged: Record<string, string> = {}
  for (const key of SYNCED_KEYS) {
    const local = readKey(key)
    if (local !== null) merged[key] = local
  }
  if (Object.keys(merged).length > 0) {
    try {
      await fetch(serverUrl(), {
        method: 'PUT',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(merged),
      })
    } catch {
      // Best-effort.
    }
  }
}

let pushTimer: number | null = null
const pending = new Set<string>()

function schedulePush() {
  if (pushTimer !== null) return
  pushTimer = window.setTimeout(() => {
    pushTimer = null
    void pushPending()
  }, 800)
}

async function pushPending() {
  const payload: Record<string, string> = {}
  for (const key of pending) {
    const value = readKey(key)
    if (value !== null) payload[key] = value
  }
  pending.clear()
  if (Object.keys(payload).length === 0) return
  try {
    await fetch(serverUrl(), {
      method: 'PUT',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })
  } catch {
    // Best-effort — next write retries.
  }
}

/** Start mirroring durable-key writes to the server. Idempotent. */
export function initServerSettingsSync(): () => void {
  return onPersistenceEvent((event) => {
    if (event.op === 'write' && SYNCED_KEYS.has(event.key)) {
      pending.add(event.key)
      schedulePush()
    }
  })
}
