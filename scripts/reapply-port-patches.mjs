#!/usr/bin/env node
/**
 * reapply-port-patches.mjs — idempotently re-applies Hermes-Desktop-Web port
 * patches onto web/src files after `npm run sync:renderer` has copied fresh
 * upstream renderer code over them.
 *
 * WHY: sync:renderer does `rsync --delete ~/.hermes/hermes-agent/apps/desktop/src/ web/src/`.
 * Upstream files (main.tsx, styles.css, titlebar.ts, themes/context.tsx,
 * system-actions.ts) come back pristine, which silently drops:
 *   - the web-bridge import + login-gate boot wrapper (main.tsx)
 *   - the iOS safe-area vars + 16px input floor (styles.css)
 *   - the topbar safe-area height (titlebar.ts)
 *   - the dynamic theme-color meta sync (themes/context.tsx)
 *   - the UI-restart reload fallback (system-actions.ts)
 * Every patch below is a marker-guarded insert: safe to run any number of
 * times on any mix of upstream/patched content.
 */
import fs from 'node:fs'
import path from 'node:path'

const webSrc = path.resolve(process.argv[2] ?? 'web/src')
let touched = 0

function patchFile(rel, marker, find, insert) {
  const file = path.join(webSrc, rel)
  if (!fs.existsSync(file)) {
    console.warn(`  ! ${rel} missing, skipping`)
    return
  }
  let src = fs.readFileSync(file, 'utf8')
  if (src.includes(marker)) {
    console.log(`  = ${rel} already patched`)
    return
  }
  if (!src.includes(find)) {
    console.warn(`  ! ${rel}: anchor not found, skipping (upstream moved?)`)
    return
  }
  src = src.replace(find, insert)
  fs.writeFileSync(file, src)
  touched++
  console.log(`  + ${rel} patched`)
}

console.log('reapplying port patches…')

// --- main.tsx: bridge import + login-gate boot wrapper ----------------------
// CRITICAL: the bridge import must sit BEFORE `import App from './app'` —
// ES modules evaluate in SOURCE ORDER, and the app graph's module-scope
// plugin discovery (app/contrib/controller.tsx → watchRuntimePlugins →
// scanDiskPlugins) checks `window.hermesDesktop` at module scope. If App
// evaluates first, the disk scan bails (`!desktop`) and plugins never load.
patchFile(
  'main.tsx',
  'import \'./web-bridge\'',
  "import App from './app'",
  `// Web port: the bridge self-installs at module scope below — this import MUST
// stay ahead of \`./app\` (module bodies evaluate in import order), so
// window.hermesDesktop exists before the app's module-scope plugin discovery
// (app/contrib/controller.tsx → watchRuntimePlugins) runs.
import './web-bridge'

// Web port: session-cookie auth gate. Boots the app only when authenticated.
import { runLoginGate } from './login-gate'

import App from './app'`,
)

// main.tsx: server-settings import (web-port only; upstream has no such file).
patchFile(
  'main.tsx',
  "import { hydrateServerSettings, initServerSettingsSync } from './lib/server-settings'",
  "import { installClipboardShim } from './lib/clipboard'",
  `import { installClipboardShim } from './lib/clipboard'
import { hydrateServerSettings, initServerSettingsSync } from './lib/server-settings'`,
)

// main.tsx: boot chain — login gate → hydrate server settings → render, and
// start mirroring durable pref writes. This REPLACES the whole `} else {`
// tail (which upstream ships as a bare `createRoot(...).render(...)` and old
// patches wrapped in `void runLoginGate().then(() => { ... })`), so it
// converges from fresh, old-patched, and current trees alike.
{
  const file = path.join(webSrc, 'main.tsx')
  if (!fs.existsSync(file)) {
    console.warn('  ! main.tsx missing, skipping boot chain')
  } else {
    let src = fs.readFileSync(file, 'utf8')
    // Marker is the boot-chain call itself — the import line alone must not
    // short-circuit the patch.
    if (src.includes('.then(() => hydrateServerSettings())')) {
      console.log('  = main.tsx boot chain already patched')
    } else {
      const re = /} else \{\n([\s\S]*?)\n\}/m
      const m = src.match(re)
      if (!m) {
        console.warn('  ! main.tsx: boot tail anchor not found, skipping')
      } else {
        const inner = m[1]
        src = src.replace(
          re,
          `} else {
  void runLoginGate()
    .then(() => hydrateServerSettings())
    .then(() => {
      // Mirror durable pref writes (theme/plugins) to the server store so they
      // follow the user across devices.
      initServerSettingsSync()
${inner}
    })
}`,
        )
        fs.writeFileSync(file, src)
        touched++
        console.log('  + main.tsx boot chain patched')
      }
    }
  }
}

// --- store/composer.ts: randomUUID fallback for insecure contexts --------------
// crypto.randomUUID() only exists in SECURE contexts (https / localhost).
// The web port is commonly served over plain http://<lan-ip>:4000, where it is
// undefined — createComposerAttachmentOccurrenceId() then throws and EVERY
// image paste/attach silently fails (the pill is never created). Fall back to
// a collision-resistant local id. Marker-guarded; composer.ts is upstream-synced.
patchFile(
  'store/composer.ts',
  'Web port: randomUUID fallback for insecure contexts',
  'export const createComposerAttachmentOccurrenceId = (): string => crypto.randomUUID()',
  `export const createComposerAttachmentOccurrenceId = (): string =>
  // Web port: randomUUID fallback for insecure contexts — crypto.randomUUID()
  // is secure-context-only; over plain http (LAN IP) it is undefined and every
  // paste/attach throws before the pill is created. Fall back to a
  // collision-resistant id.
  typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : \`occ-\${Date.now().toString(36)}-\${Math.random().toString(36).slice(2, 10)}\``,
)

// --- app/settings/billing/api.ts: randomUUID default arg fallback -------------
patchFile(
  'app/settings/billing/api.ts',
  'Web port: randomUUID fallback for insecure contexts',
  'charge: async (amountUsd, idempotencyKey = crypto.randomUUID()) => {',
  `charge: async (amountUsd, idempotencyKey = typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function' ? crypto.randomUUID() : \`chg-\${Date.now().toString(36)}\`) => { // Web port: randomUUID fallback for insecure contexts`,
)

// --- store/pet-generate.ts: randomUUID fallback -------------------------------
patchFile(
  'store/pet-generate.ts',
  'Web port: randomUUID fallback for insecure contexts',
  'const cancelToken = crypto.randomUUID()',
  `const cancelToken =
    // Web port: randomUUID fallback for insecure contexts
    typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID()
      : \`pet-\${Date.now().toString(36)}-\${Math.random().toString(36).slice(2, 10)}\``,
)

// --- styles.css: iOS input floor -------------------------------------------------
patchFile(
  'styles.css',
  'Web port (iOS): Safari auto-zooms',
  '@custom-variant dark (&:is(.dark *));',
  `@custom-variant dark (&:is(.dark *));

/* Web port (mobile): the desktop UI is tuned for a 1200px+ window with a
   mouse. On a phone the default 16px root makes icon buttons ~24px — hard
   to hit. Bump the root size so every rem-based dimension (buttons, icons,
   padding, touch targets) scales up together; the layout is already
   responsive enough that this mostly enlarges chrome, not breaks it. */
@media (max-width: 767px) {
  :root {
    --dt-base-size: 1.125rem;
  }
  html {
    font-size: 18px;
  }
}

/* Web port (iOS): Safari auto-zooms into any form field whose font-size is
   below 16px on focus. The app's compact input styles (12–14px) trigger it
   on iPhone. Floor the size at the form-field level only — conversation
   text, titles, and chrome keep their design sizes. contentEditable is
   included: the composer is a contentEditable div, not a textarea. */
input,
textarea,
select,
[contenteditable='true'],
[contenteditable=''] {
  font-size: 16px;
}

/* Web port (iOS): suppress double-tap / double-click zoom on interactive
   elements. Safari zooms on a fast second tap; \`manipulation\` tells it the
   gesture is a tap action, not a zoom gesture. Combined with the viewport
   \`user-scalable=no\` this kills the accidental zoom entirely. */
button,
a,
[role='button'],
input,
textarea,
select,
[contenteditable='true'],
[contenteditable=''] {
  touch-action: manipulation;
}`,
)

// --- styles.css: statusbar horizontal scroll on mobile --------------------------
// The statusbar's groups are `overflow-x-clip` (desktop: a wide item must
// never paint a scrollbar). On a phone, plugin status items (gateway check,
// tasks, pin, drafts, language) overflow 390px and get silently truncated —
// the screenshot shows "tasks"/"#vw" cut at the right edge. On touch screens
// make the groups scrollable (scrollbars hidden) so every item is reachable.
// NOTE: must run AFTER the iOS input floor patch (anchors the media block
// that patch inserts).
patchFile(
  'styles.css',
  'Web port (mobile): statusbar horizontal scroll',
  `@media (max-width: 767px) {
  :root {
    --dt-base-size: 1.125rem;
  }
  html {
    font-size: 18px;
  }
}`,
  `@media (max-width: 767px) {
  :root {
    --dt-base-size: 1.125rem;
  }
  html {
    font-size: 18px;
  }
  /* Web port (mobile): statusbar horizontal scroll — let statusbar groups
     scroll sideways instead of truncating plugin items at the right edge.
     No visible scrollbar — touch scroll only (desktop keeps overflow-x-clip). */
  [data-slot='statusbar'] > div {
    overflow-x: auto;
    -webkit-overflow-scrolling: touch;
    scrollbar-width: none;
  }
  [data-slot='statusbar'] > div::-webkit-scrollbar {
    display: none;
  }
  /* Web port (mobile): iOS long-press on a session tab must open the close
     menu (Radix ContextMenu). Safari's native touch-callout swallows
     contextmenu, so kill the callout on tab strips. */
  [data-zone-tabstrip] [role='tab'],
  [data-tree-tab] {
    -webkit-touch-callout: none;
  }
}`,
)

// --- styles.css: mobile touch targets (44px floor) --------------------------
// Apple HIG: interactive elements need ~44px; the desktop chrome (composer
// controls 1.5rem, statusbar ~11px text + 6px padding) is ~24-28px even after
// the 18px root bump in the statusbar-scroll patch. Enlarge interactive
// controls only — labels/passive text keep design sizes. This is its OWN
// patchFile (separate marker) so it can't be swallowed by the statusbar-scroll
// patch's `already patched` guard.
patchFile(
  'styles.css',
  'Web port (mobile): touch targets 44px floor',
  `  [data-zone-tabstrip] [role='tab'],
  [data-tree-tab] {
    -webkit-touch-callout: none;
  }
}`,
  `  [data-zone-tabstrip] [role='tab'],
  [data-tree-tab] {
    -webkit-touch-callout: none;
  }
  /* Web port (mobile): touch targets — Apple HIG floor is 44px; the desktop
     chrome (composer controls 1.5rem, statusbar actions ~11px text + 6px
     padding) is 24–28px even after the 18px root bump. Enlarge the
     interactive controls only; labels/passive text keep design sizes. */
  :root {
    --composer-control-size: 2.25rem;
    --composer-control-primary-size: 2.5rem;
    --composer-surface-pad-y: 0.5rem;
  }
  [data-slot='composer-root'] button,
  [data-slot='composer-dock'] button,
  [data-slot='statusbar'] button,
  [data-slot='statusbar'] a {
    min-height: 2.75rem;
    min-width: 2.75rem;
  }
}`,
)

// --- styles.css: safe-area vars ----------------------------------------------------
patchFile(
  'styles.css',
  '--safe-area-top: env(safe-area-inset-top, 0px);',
  '--theme-elevated-seed: #ffffff;',
  `--theme-elevated-seed: #ffffff;
    /* Web port (iOS): notch / home indicator / rounded corners. Tailwind's
       pb-safe / pt-safe map to these env() values; the composer and topbar
       use them via the vars below. */
    --safe-area-top: env(safe-area-inset-top, 0px);
    --safe-area-bottom: env(safe-area-inset-bottom, 0px);
    --safe-area-left: env(safe-area-inset-left, 0px);
    --safe-area-right: env(safe-area-inset-right, 0px);`,
)

// --- styles.css: composer bottom inset uses safe area ------------------------------
patchFile(
  'styles.css',
  '--composer-shell-pad-block-end: calc(0.625rem + var(--safe-area-bottom, 0px));',
  '--composer-shell-pad-block-end: 0.625rem;',
  '--composer-shell-pad-block-end: calc(0.625rem + var(--safe-area-bottom, 0px));',
)

// --- titlebar.ts: safe-area top ------------------------------------------------------
// REPLACE the upstream header class with the safe-area variant — an insert
// would leave BOTH lines (adjacent-string concat, wrong classes).
patchFile(
  'app/shell/titlebar.ts',
  'pt-[var(--safe-area-top,0px)]',
  `export const titlebarHeaderBaseClass =
  'pointer-events-none relative z-3 flex h-(--titlebar-height) w-full min-w-0 shrink-0 items-center justify-start gap-3 overflow-hidden border-b border-(--ui-stroke-tertiary) bg-(--ui-chat-surface-background) px-[max(0.75rem,var(--titlebar-content-inset,0rem))] pr-[calc(var(--titlebar-tools-right,0.75rem)+var(--titlebar-tools-width,0px)+0.75rem)]'`,
  `export const titlebarHeaderBaseClass =
  'pointer-events-none relative z-3 flex h-[calc(var(--titlebar-height)+var(--safe-area-top,0px))] w-full min-w-0 shrink-0 items-center justify-start gap-3 overflow-hidden border-b border-(--ui-stroke-tertiary) bg-(--ui-chat-surface-background) px-[max(0.75rem,var(--titlebar-content-inset,0rem))] pr-[calc(var(--titlebar-tools-right,0.75rem)+var(--titlebar-tools-width,0px)+0.75rem)] pt-[var(--safe-area-top,0px)]'`,
)

// --- themes/context.tsx: theme-color meta sync ---------------------------------------
patchFile(
  'themes/context.tsx',
  'meta[name="theme-color"]',
  "  root.classList.toggle('dark', isDark)",
  `  root.classList.toggle('dark', isDark)

  // Web port: keep the browser chrome (mobile status bar / URL bar) tinted to
  // the active Hermes background so iOS doesn't show a stale fixed color.
  const metaTheme = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]')
  if (metaTheme) {
    metaTheme.content = c.background
  }`,
)

// --- system-actions.ts: restart reload fallback ---------------------------------------
patchFile(
  'store/system-actions.ts',
  'Web port: the backend RPC may be unavailable',
  'notifyError(err, translateNow(\'commandCenter.gatewayRestartFailed\'))',
  `// Web port: the backend RPC may be unavailable (e.g. served read-only or
    // the gateway doesn't expose the action). Falling back to a page reload
    // still gives the user a working "restart the UI" affordance — the app
    // re-boots, re-mints a WS ticket, and reconnects to the same backend.
    if (window.location.protocol.startsWith('http')) {
      window.location.reload()
      return
    }
    notifyError(err, translateNow('commandCenter.gatewayRestartFailed'))`,
)

// --- use-prompt-actions/index.ts: web-input paths always upload bytes ----------------
patchFile(
  'app/session/hooks/use-prompt-actions/index.ts',
  'Web port: virtual web-input:<n> paths',
  'function attachmentPathNeedsUpload(path: string, backendCwd?: null | string, terminalBackend?: string): boolean {',
  `function attachmentPathNeedsUpload(path: string, backendCwd?: null | string, terminalBackend?: string): boolean {
  // Web port: virtual web-input:<n> paths are browser File objects, not real
  // disk paths — the backend can never read them, so they ALWAYS upload bytes.
  if (path.startsWith('web-input:')) {
    return true
  }`,
)

// --- statusbar-prefs.ts: context meter visible by default -----------------------------
// ONE atomic edit: replace the `'context-usage',` entry with the explanatory
// comment, so the meter is NOT hidden by default. Upstream ships it hidden;
// without the removal part the next sync would silently revert the visibility.
patchFile(
  'store/statusbar-prefs.ts',
  'removed in the web port: the context meter',
  `'approval-mode',
  'context-usage',`,
  `'approval-mode',
  // 'context-usage' removed in the web port: the context meter is one of the
  // few status readouts the user asked to always see.`,
)

// --- controller.tsx: shell uses dvh (iOS dynamic viewport height) ---------------------
patchFile(
  'app/contrib/controller.tsx',
  'h-dvh min-h-0 flex-col bg-background',
  'className="h-screen min-h-0 flex-col bg-background"',
  'className="h-dvh min-h-0 flex-col bg-background"',
)
patchFile(
  'app/contrib/controller.tsx',
  'flex h-dvh min-h-0 w-screen flex-col',
  'className="flex h-screen min-h-0 w-screen flex-col',
  'className="flex h-dvh min-h-0 w-screen flex-col',
)

// --- markdown-text.tsx: only fetch 18MB shiki when a code fence exists -----------------
patchFile(
  'components/assistant-ui/markdown-text.tsx',
  'Web port: @streamdown/code statically pulls',
  'function useCodePlugin(): CodePlugin | null {',
  `function useCodePlugin(text: string): CodePlugin | null {`,
)
patchFile(
  'components/assistant-ui/markdown-text.tsx',
  'Web port: @streamdown/code statically pulls',
  '  useEffect(() => {\n    if (plugin) {\n      return\n    }\n\n    let cancelled = false',
  `  useEffect(() => {
    if (plugin) {
      return
    }

    // Web port: @streamdown/code statically pulls the entire ~18MB shiki
    // bundle. On the desktop it's a local-disk read (instant); over HTTP it
    // is a real download that stalls every plain-text chat. Only fetch it
    // when this message actually contains a fenced code block — messages
    // without one never pay for syntax highlighting.
    if (!/(^|\\n)\\s*(\\\`\\\`\\\`|~~~)/.test(text)) {
      return
    }

    let cancelled = false`,
)
patchFile(
  'components/assistant-ui/markdown-text.tsx',
  'const code = useCodePlugin(text)',
  'const code = useCodePlugin()',
  'const code = useCodePlugin(text)',
)
patchFile(
  'components/assistant-ui/markdown-text.tsx',
  '}, [plugin, text])',
  '}, [plugin])',
  '}, [plugin, text])',
)

// --- titlebar-controls.tsx: mobile command-palette button --------------------------
patchFile(
  'app/shell/titlebar-controls.tsx',
  "import { openCommandPalette } from '@/store/command-palette'",
  "import { hudTargetSessionId } from '@/app/hud/handoff'",
  `import { hudTargetSessionId } from '@/app/hud/handoff'
import { openCommandPalette } from '@/store/command-palette'`,
)
patchFile(
  'app/shell/titlebar-controls.tsx',
  "// Web port (mobile): the command palette is ⌘K-only on desktop; touch",
  'const leftToolbarTools: TitlebarTool[] = [',
  `const leftToolbarTools: TitlebarTool[] = [
    {
      // Web port (mobile): the command palette is ⌘K-only on desktop; touch
      // devices have no keybind, so expose a visible trigger on small screens.
      actionId: 'nav.commandPalette',
      className: 'md:hidden',
      icon: <TitlebarIcon name="search" />,
      id: 'command-palette',
      label: t.commandCenter.paletteTitle,
      onSelect: () => {
        triggerHaptic('open')
        openCommandPalette()
      }
    },`,
)

// --- tree-group.tsx: mobile tab strip visibility -------------------------------
// Upstream hides the header strip for a lone tab (shown.length <= 1) and for
// full-page views (headerVeto). On desktop that's fine — ⌘W / right-click
// close still work. On a phone the hidden strip strands the tab: there is
// nothing to hold, so a session's tab is unreachable and can block the view.
// Force the strip visible on mobile whenever the zone holds a session tab
// and the user has NOT explicitly hidden it (node.headerHidden === true is
// a deliberate hide — respect it; the auto-hide is the trap).
patchFile(
  'components/pane-shell/tree/renderer/tree-group.tsx',
  '// Web port (mobile): mobile tab strip — useIsMobile import',
  "import { useI18n } from '@/i18n'",
  `import { useI18n } from '@/i18n'
// Web port (mobile): mobile tab strip — useIsMobile import
import { useIsMobile } from '@/hooks/use-mobile'`,
)
patchFile(
  'components/pane-shell/tree/renderer/tree-group.tsx',
  "// Web port (mobile): keep the strip when the zone holds a session tab",
  'const headerVisible = !isEmpty && !verticalCollapse && (Boolean(node.minimized) || !headerHidden)',
  `// Web port (mobile): a lone session tab auto-hides the strip upstream,
  // stranding the tab (no hold/close affordance on touch). Keep the strip
  // whenever this zone holds a session tab and the user didn't explicitly
  // hide it (node.headerHidden === true stays respected).
  const isMobile = useIsMobile()
  const mobileForceStrip = isMobile && !node.headerHidden && shown.some(isSessionStripPane)
  const headerVisible = !isEmpty && !verticalCollapse && (Boolean(node.minimized) || !headerHidden || mobileForceStrip)`,
)
// iOS long-press on a tab must open the close menu. Safari's native
// touch-callout swallows contextmenu — the CSS patch below (styles.css,
// same block as the mobile 16px floor) kills the callout on tab strips so
// the Radix ContextMenu wrapping each zone can receive the long-press.
patchFile(
  'lib/chat-runtime.ts',
  '// Web port: virtual web-input:<n> paths carry the real filename in the',
  'export function pathLabel(path: string): string {',
  `export function pathLabel(path: string): string {
  // Web port: virtual web-input:<n> paths carry the real filename in the
  // bridge's File object. Resolve it so chips/refs show e.g. "voice-memo.m4a"
  // instead of the opaque "web-input:2".
  if (path.startsWith('web-input:')) {
    const real = window.hermesDesktop?.fileNameForPath?.(path)
    if (real) return real
  }`,
)
patchFile(
  'app/session/hooks/use-prompt-actions/utils.ts',
  '// Web port: virtual web-input:<n> paths carry the real filename in the',
  'export function imageFilenameFromPath(filePath: string): string {',
  `export function imageFilenameFromPath(filePath: string): string {
  // Web port: virtual web-input:<n> paths carry the real filename in the
  // bridge's File object — use it so image.attach_bytes uploads keep the
  // original name/extension (e.g. photo.jpg) instead of "web-input:3".
  if (filePath.startsWith('web-input:')) {
    const real = window.hermesDesktop?.fileNameForPath?.(filePath)
    if (real) return real
  }`,
)
// --- plugins/hermes-bots/plugin.js: collapsible panes on mobile -----------------
// Root cause of "web port opens the BOTS tab on every iOS reload" + "a tab
// blocking my view": the Bots pane (placement left, docked under sessions) and
// the Cronjobs pane (placement main, docked right of workspace) are NOT
// `collapsible`, so on a narrow viewport (<768px, i.e. every phone) they stay
// as persistent grid columns — Bots eats ~155px and Cronjobs ~149px, squeezing
// the chat lane to ~86px, and the docked Bots pane fronts on boot. Core panes
// (sessions/files/review/terminal) all declare `collapsible: true`, which makes
// them LEAVE the grid on narrow viewports and become exclusive edge-overlay
// drawers (opened on demand) — the exact mobile behavior we want. Grant Bots +
// Cronjobs the same flag so a phone boots to the chat, and surfacing Bots or
// the routine list is an explicit tap, not an autopen.
patchFile(
  'plugins/hermes-bots/plugin.js',
  '// Web port (mobile): Bots pane collapsible → drawer overlay, not a column',
  "      data: { placement: 'left', width: '260px', dock: { pane: 'sessions', pos: 'bottom' } },",
  `      data: {
        placement: 'left',
        width: '260px',
        dock: { pane: 'sessions', pos: 'bottom' },
        // Web port (mobile): collapsible so a phone boots to the chat — Bots
        // leaves the grid under 768px and becomes an edge-overlay drawer an
        // explicit tap opens, instead of a 155px column that auto-fronts and
        // blocks the chat on every reload.
        collapsible: true
      },`,
)
patchFile(
  'plugins/hermes-bots/plugin.js',
  '// Web port (mobile): Cronjobs pane collapsible → drawer overlay, not a column',
  `      data: {
        placement: 'main',
        dock: { pane: 'workspace', pos: 'right' },
        width: '250px'
      },`,
  `      data: {
        placement: 'main',
        dock: { pane: 'workspace', pos: 'right' },
        width: '250px',
        // Web port (mobile): collapsible so the Cronjobs list doesn't hold a
        // 149px column on a phone; it becomes a right-edge drawer.
        collapsible: true
      },`,
)

// --- components/ui/pane-tab.tsx: touch long-press opens the close menu --------
// On desktop a tab's close menu opens on right-click (Radix ContextMenu wraps
// the zone). A phone has no right-click; iOS long-press sometimes delivers
// contextmenu but is unreliable. Synthesize it: a 450ms touch hold on a tab
// dispatches a real contextmenu MouseEvent at the press point, which the
// wrapping ContextMenuTrigger receives and opens. Guarded by pointerType so
// mouse users get nothing new.
patchFile(
  'components/ui/pane-tab.tsx',
  '// Web port (mobile): touch long-press opens the tab close menu',
  '      onPointerDown={event => {\n        middle.onPointerDown(event)',
  `      onPointerDown={event => {
        middle.onPointerDown(event)

        // Web port (mobile): touch long-press opens the tab close menu.
        // A 450ms hold dispatches a synthetic contextmenu the wrapping
        // ContextMenuTrigger picks up — iOS long-press alone is unreliable.
        if (event.pointerType === 'touch') {
          const target = event.currentTarget
          const startX = event.clientX
          const startY = event.clientY
          const timer = window.setTimeout(() => {
            target.dispatchEvent(
              new MouseEvent('contextmenu', {
                bubbles: true,
                cancelable: true,
                clientX: startX,
                clientY: startY,
                view: window
              })
            )
          }, 450)
          const clear = () => window.clearTimeout(timer)
          const onMove = (move: PointerEvent) => {
            // Cancel the hold once the finger travels — a drag, not a press.
            if (Math.hypot(move.clientX - startX, move.clientY - startY) > 10) {
              clear()
            }
          }
          target.addEventListener('pointerup', clear, { once: true })
          target.addEventListener('pointercancel', clear, { once: true })
          target.addEventListener('pointermove', onMove)
        }`,
)
patchFile(
  'components/ui/copy-button.tsx',
  '// Web port: surface writeClipboard failure instead of fake success',
  '  if (window.hermesDesktop?.writeClipboard) {\n    await window.hermesDesktop.writeClipboard(text)\n\n    return\n  }',
  `  if (window.hermesDesktop?.writeClipboard) {\n    // Web port: surface writeClipboard failure instead of fake success —\n    // the bridge returns false when the browser blocked the write.\n    const ok = await window.hermesDesktop.writeClipboard(text)\n\n    if (ok) {\n      return\n    }\n\n    throw new Error('Clipboard write failed')\n  }`,
)
patchFile(
  'global.d.ts',
  '/** Web port: real filename for a virtual web-input:<n> path, else null. */',
  '      selectPaths: (options?: HermesSelectPathsOptions) => Promise<string[]>',
  `      selectPaths: (options?: HermesSelectPathsOptions) => Promise<string[]>
      /** Web port: real filename for a virtual web-input:<n> path, else null. */
      fileNameForPath?: (filePath: string) => string | null`,
)

// --- themes/user-themes.ts + contrib/plugins-store.ts: server-settings sync choke point ------
// The server-settings sync observes writes that flow through lib/storage.ts's
// writeKey. Upstream persists themes + plugin decisions with raw
// window.localStorage.setItem, which the sync never sees → installed themes
// and plugin toggles stay per-browser. Patch them to write via writeKey, and
// export refresh fns so hydrated values reach the atoms on first paint.
patchFile(
  'themes/user-themes.ts',
  "import { writeKey } from '@/lib/storage'",
  "import { atom, computed } from 'nanostores'",
  `import { atom, computed } from 'nanostores'

import { writeKey } from '@/lib/storage'`,
)
patchFile(
  'themes/user-themes.ts',
  '// Route through the persistence choke point (writeKey) so the server-settings',
  'function persist(record: Record<string, DesktopTheme>) {',
  `function persist(record: Record<string, DesktopTheme>) {
  // Route through the persistence choke point (writeKey) so the server-settings
  // sync sees the write and mirrors installed themes across devices.
  writeKey(USER_THEMES_KEY, JSON.stringify(record))`,
)
patchFile(
  'themes/user-themes.ts',
  'export function refreshUserThemes(): void {',
  'export const $userThemes = atom<Record<string, DesktopTheme>>(typeof window === \'undefined\' ? {} : readStored())',
  `export const $userThemes = atom<Record<string, DesktopTheme>>(typeof window === 'undefined' ? {} : readStored())

/**
 * Re-read user themes from localStorage into the atom. Needed after
 * server-settings hydration writes themes on a fresh browser (the atom
 * initializes at module scope, before hydration runs).
 */
export function refreshUserThemes(): void {
  if (typeof window === 'undefined') return
  $userThemes.set(readStored())
}`,
)
patchFile(
  'contrib/plugins-store.ts',
  "import { writeKey } from '@/lib/storage'",
  "import { atom } from 'nanostores'",
  `import { atom } from 'nanostores'

import { writeKey } from '@/lib/storage'`,
)
patchFile(
  'contrib/plugins-store.ts',
  '// Route through the persistence choke point (writeKey) so the server-settings',
  'function saveDecisions(next: Record<string, boolean>) {',
  `function saveDecisions(next: Record<string, boolean>) {
  // Route through the persistence choke point (writeKey) so the server-settings
  // sync sees the change and mirrors plugin enable/disable across devices.
  writeKey(DECISIONS_KEY, JSON.stringify(next))`,
)
patchFile(
  'contrib/plugins-store.ts',
  'export function refreshPluginDecisions(): void {',
  'export const $pluginDecisions = atom<Record<string, boolean>>(loadDecisions())',
  `export const $pluginDecisions = atom<Record<string, boolean>>(loadDecisions())

/**
 * Re-read plugin decisions from localStorage into the atom. Needed after
 * server-settings hydration writes decisions on a fresh browser (the atom
 * initializes at module scope, before hydration runs).
 */
export function refreshPluginDecisions(): void {
  $pluginDecisions.set(loadDecisions())
}`,
)

patchFile(
  'styles.css',
  'Web port (iOS): intro wordmark fit-text fails on Safari',
  '.fit-text {\n  --fit-captured-length: initial;',
  `/* Web port (iOS): intro wordmark fit-text fails on Safari — .fit-text's
   tan(atan2()) + @property ratio math fails on iOS Safari (font stays at
   --fit-min, the wordmark overflows the screen and clips — "HERMES AGEN").
   Override with a deterministic container-query clamp: scales with the
   container width and caps at the same 2.75rem desktop size, so desktop is
   unchanged. */
[data-slot='aui_intro'] .fit-text > :not([aria-hidden]) > * {
  font-size: clamp(1.5rem, 9.5cqi, 2.75rem);
  white-space: nowrap;
}

.fit-text {
  --fit-captured-length: initial;`,
)

// --- controller.tsx: shell titlebar strip safe-area-top -----------------------
// The contrib shell's own 34px titlebar strip is hard-coded to y=0. In a
// standalone iOS PWA (viewport-fit=cover + black-translucent) the webview
// extends UNDER the iOS status bar, so the strip + fixed control clusters
// (top:5px) sit behind it and are invisible. Fold the safe-area inset into
// the strip's height so its background (and the clusters' anchor) start
// below the status bar. Safe-area vars come from styles.css (0 on desktop).
patchFile(
  'app/contrib/controller.tsx',
  'Web port (iOS): shell titlebar strip safe-area-top',
  '<div className="relative flex h-[34px] shrink-0 items-center bg-(--ui-sidebar-surface-background) text-xs">',
  `{/* Web port (iOS): shell titlebar strip safe-area-top — see reapply-port-patches.mjs */}
<div className="relative flex h-[calc(34px+var(--safe-area-top,0px))] shrink-0 items-center bg-(--ui-sidebar-surface-background) pt-[var(--safe-area-top,0px)] text-xs">`,
)

// --- titlebar-controls.tsx: fixed clusters follow safe-area-top ---------------
patchFile(
  'app/shell/titlebar-controls.tsx',
  'Web port (iOS): titlebar cluster top safe-area-top (left)',
  "'left-(--titlebar-controls-left) top-(--titlebar-controls-top) translate-y-(--titlebar-controls-y-nudge)'",
  `/* Web port (iOS): titlebar cluster top safe-area-top (left) — see reapply-port-patches.mjs */
'left-(--titlebar-controls-left) top-[calc(var(--titlebar-controls-top)+var(--safe-area-top,0px))] translate-y-(--titlebar-controls-y-nudge)'`,
)
patchFile(
  'app/shell/titlebar-controls.tsx',
  'Web port (iOS): titlebar cluster top safe-area-top (pane)',
  "'top-[calc(var(--titlebar-controls-top)+var(--right-rail-top-inset,0px))] right-[calc(var(--titlebar-tools-right)+var(--shell-preview-toolbar-gap,0))]'",
  `/* Web port (iOS): titlebar cluster top safe-area-top (pane) — see reapply-port-patches.mjs */
'top-[calc(var(--titlebar-controls-top)+var(--right-rail-top-inset,0px)+var(--safe-area-top,0px))] right-[calc(var(--titlebar-tools-right)+var(--shell-preview-toolbar-gap,0))]'`,
)
patchFile(
  'app/shell/titlebar-controls.tsx',
  'Web port (iOS): titlebar cluster top safe-area-top (right)',
  "'right-(--titlebar-tools-right) top-(--titlebar-controls-top)'",
  `/* Web port (iOS): titlebar cluster top safe-area-top (right) — see reapply-port-patches.mjs */
'right-(--titlebar-tools-right) top-[calc(var(--titlebar-controls-top)+var(--safe-area-top,0px))]'`,
)

// --- statusbar-controls.tsx: footer extends into home-indicator safe area -----
// The footer's h-5 (20px) box ends above the home indicator; the bar's
// background stops there, leaving a visible gap below the toolbar in
// standalone iOS. Grow the box by safe-area-bottom and pad content up, so
// the bar's background runs all the way under the home indicator.
patchFile(
  'app/shell/statusbar-controls.tsx',
  'Web port (iOS): statusbar footer safe-area-bottom',
  "'flex h-5 shrink-0 items-stretch justify-between gap-2 bg-(--ui-sidebar-surface-background) px-1 py-0 text-(--ui-text-tertiary) [-webkit-app-region:no-drag]'",
  `/* Web port (iOS): statusbar footer safe-area-bottom — see reapply-port-patches.mjs */
'flex h-[calc(1.25rem+var(--safe-area-bottom,0px))] shrink-0 items-stretch justify-between gap-2 bg-(--ui-sidebar-surface-background) px-1 pb-[var(--safe-area-bottom,0px)] text-(--ui-text-tertiary) [-webkit-app-region:no-drag]'`,
)

// --- renderer/narrow-overlays.tsx: tappable edge strips for collapsed panes --
// Root cause: NarrowOverlays reveals collapsed panes via MOUSE-hover edge
// strips + PANE_TOGGLE_REVEAL_EVENT (⌘B/⌘G/titlebar toggles). On a touch
// screen there's no mouse, so a collapsible pane with NO titlebar toggle
// (hermes-bots' Bots/Cronjobs, which the Bots-autopen fix made collapsible)
// slides into an edge overlay that can't be reopened — unreachable. Sessions
// and files are saved by their titlebar toggles; Bots/Cronjobs have none.
// Fix: make each edge strip a wider, tappable affordance with a visible grip
// chip, so a tap opens (and a pinned re-tap closes) the collapsed pane.
patchFile(
  'components/pane-shell/tree/renderer/narrow-overlays.tsx',
  'Web port (mobile): tappable narrow-overlay edge strips',
  `      {sides.map(side => (
        <div
          className={cn('absolute inset-y-0 z-30 w-1.5', side === 'left' ? 'left-0' : 'right-0')}
          key={side}
          onMouseEnter={() => {
            const first = collapsibles.find(p => sideOf(p) === side)

            if (first) {
              setReveal(current => (current?.pinned ? current : { id: first.id, pinned: false }))
            }
          }}
        />
      ))}`,
  `      {sides.map(side => (
        <div
          className={cn(
            'absolute inset-y-0 z-30 flex w-6 items-center',
            side === 'left' ? 'left-0 justify-start' : 'right-0 justify-end'
          )}
          key={side}
          onClick={() => {
            const first = collapsibles.find(p => sideOf(p) === side)
            if (first) {
              setReveal(current => (current?.id === first.id && current.pinned ? null : { id: first.id, pinned: true }))
            }
          }}
          onMouseEnter={() => {
            const first = collapsibles.find(p => sideOf(p) === side)

            if (first) {
              setReveal(current => (current?.pinned ? current : { id: first.id, pinned: false }))
            }
          }}
        >
          {/* Web port (mobile): visible grip so a collapsed pane has a touch
              affordance — a chevron pointing toward the overlay edge. */}
          <div
            className="pointer-events-none flex h-16 w-5 items-center justify-center rounded-sm bg-(--ui-sidebar-surface-background) text-(--ui-text-tertiary) shadow-sm ring-1 ring-(--ui-stroke-secondary)"
            style={{ writingMode: 'vertical-rl' }}
          >
            {side === 'left' ? (
              <span className="text-[0.6rem]">‹</span>
            ) : (
              <span className="text-[0.6rem]">›</span>
            )}
          </div>
        </div>
      ))}`,
)

if (touched === 0) {
  console.log('no patches applied (all present)')
} else {
  console.log(`${touched} file(s) patched`)
}