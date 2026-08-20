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
  'Web port (mobile): touch targets — MODEST bump',
  `  [data-zone-tabstrip] [role='tab'],
  [data-tree-tab] {
    -webkit-touch-callout: none;
  }
}`,
  `  [data-zone-tabstrip] [role='tab'],
  [data-tree-tab] {
    -webkit-touch-callout: none;
  }
  /* Web port (mobile): touch targets — MODEST bump only. The earlier 44px
     floor (min-height/min-width 2.75rem) broke the layout: the statusbar is a
     fixed 20px footer, so 44px items clipped their text and left dead space;
     and 36–44px composer controls + 44px min-width squeezed the input and the
     model pill off a 390px phone. Bump sizes mildly and leave min-width alone
     (labels/model name need the room). */
  :root {
    --composer-control-size: 1.75rem;
    --composer-control-primary-size: 1.875rem;
    --composer-surface-pad-y: 0.375rem;
  }
  [data-slot='composer-root'] button,
  [data-slot='composer-dock'] button {
    min-height: 2rem;
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
// Web port (iOS): the composer dock's bottom pad adds the home-indicator inset
// (--safe-area-bottom). The statusbar footer below ALREADY carries that inset
// (pb-[var(--safe-area-bottom)]), so adding it here too double-counts → a dead
// band between the composer and the statusbar on phones. The web port pins the
// composer pad to the plain 0.625rem; the statusbar owns the safe area.
// ONE idempotent patch: the marker is the comment the insert writes, and the
// find anchor is the pre-patch upstream line, so it applies exactly once.
patchFile(
  'styles.css',
  'Web port (mobile): composer pad — statusbar owns the safe-area inset',
  '--composer-shell-pad-block-end: calc(0.625rem + var(--safe-area-bottom, 0px));',
  `--composer-shell-pad-block-end: 0.625rem; /* Web port (mobile): composer pad — statusbar owns the safe-area inset */`,
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

// --- titlebar-controls.tsx: hide the right-sidebar toggle on mobile --------
// The `right-sidebar` titlebar button toggles the FILES pane, which is
// `collapsible: true` — it leaves the grid on narrow viewports and becomes an
// edge-overlay drawer. On a phone the button therefore has nothing to open
// (the pane is collapsed by default) and reads as a dead button. Hide it
// under 768px; desktop keeps the toggle.
patchFile(
  'app/shell/titlebar-controls.tsx',
  'Web port (mobile): hide dead right-sidebar toggle',
  `  const rightSidebarTool: TitlebarTool = {
    actionId: 'view.toggleRightSidebar',
    icon: <TitlebarIcon name="layout-sidebar-right" />,
    id: 'right-sidebar',
    label: rightEdge.open ? t.titlebar.hideRightSidebar : t.titlebar.showRightSidebar,
    onSelect: () => {
      triggerHaptic('tap')
      rightEdge.toggle()
    }
  }`,
  `  const rightSidebarTool: TitlebarTool = {
    actionId: 'view.toggleRightSidebar',
    icon: <TitlebarIcon name="layout-sidebar-right" />,
    id: 'right-sidebar',
    // Web port (mobile): the FILES pane is collapsible and leaves the grid
    // under 768px, so this toggle has nothing to open on a phone — hide it
    // there (desktop keeps it).
    className: 'hidden md:inline-flex',
    label: rightEdge.open ? t.titlebar.hideRightSidebar : t.titlebar.showRightSidebar,
    onSelect: () => {
      triggerHaptic('tap')
      rightEdge.toggle()
    }
  }`,
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

// --- use-statusbar-items.tsx: trim statusbar to plugins + context + folder --
// Web-port phone layout: the statusbar is a fixed 20px strip; every extra
// item crowds the few that matter. User asked for ONLY: plugin contributions,
// the context meter, and the current folder. Remove the command-center,
// gateway-health, agents/cron/webhooks route shortcuts, timers, approval
// mode, terminal toggle, and version pills. Plugins arrive via
// extraRightItems (they're not in these core arrays), so they survive.
// ONE whole-array replacement, marker-guarded at the top of each array (the
// marker is the comment the insert writes, so a re-run skips — no double
// application like per-item patches would).
patchFile(
  'app/shell/hooks/use-statusbar-items.tsx',
  'Web port (mobile): statusbar trimmed to plugins/context/folder',
  `  const coreLeftStatusbarItems = useMemo<readonly StatusbarItem[]>(
    () => [
      ...(connectionItem ? [connectionItem] : []),
      {
        className: \`w-7 justify-center px-0\${commandCenterOpen ? ' bg-accent/55 text-foreground' : ''}\`,
        icon: <Command className="size-3.5" />,
        id: 'command-center',
        // The system icon: the way into every other surface, including the
        // settings that would bring a hidden item back. Never hideable.
        lockedVisible: true,
        onSelect: toggleCommandCenter,
        title: commandCenterOpen ? copy.closeCommandCenter : copy.openCommandCenter,
        toggleLabel: copy.toggleCommandCenter,
        variant: 'action'
      },
      {
        className: gatewayRestarting ? undefined : gatewayClassName,
        detail: gatewayRestarting ? copy.gatewayRestarting : gatewayDetail,
        icon: gatewayRestarting ? (
          <GlyphSpinner ariaLabel={copy.gatewayRestarting} className="size-3" />
        ) : inferenceReady ? (
          <Activity className="size-3" />
        ) : (
          <AlertCircle className="size-3" />
        ),
        id: 'gateway-health',
        label: copy.gateway,
        menuClassName: 'w-72',
        menuContent: gatewayMenuContent,
        // Tip only when there's a real status reason — not "gateway status" restating the label.
        title: inferenceStatus?.reason || undefined,
        toggleLabel: copy.gateway,
        variant: 'menu'
      },
      {
        hidden: !currentCwd,
        icon: <FolderOpen className="size-3" />,
        id: 'workspace-cwd',`,
  `  // Web port (mobile): statusbar trimmed to plugins/context/folder.
  // Everything except the current-folder chip is hidden (plugins arrive via
  // extraRightItems and the context meter survives in the right array).
  const coreLeftStatusbarItems = useMemo<readonly StatusbarItem[]>(
    () => [
      {
        hidden: !currentCwd,
        icon: <FolderOpen className="size-3" />,
        id: 'workspace-cwd',`,
)
patchFile(
  'app/shell/hooks/use-statusbar-items.tsx',
  'Web port (mobile): statusbar right — only context survives',
  `  const coreRightStatusbarItems = useMemo<readonly StatusbarItem[]>(
    () => [
      {
        detail: <LiveDuration since={turnStartedAt} />,
        hidden: !busy || !turnStartedAt,
        icon: <Loader2 className="size-3 animate-spin" />,
        id: 'running-timer',
        label: copy.turnRunning,
        toggleLabel: copy.toggleRunningTimer,
        variant: 'text'
      },
      {
        detail: contextBar || undefined,
        hidden: !contextUsage,
        id: 'context-usage',
        label: contextUsage,
        menuAlign: 'end',
        menuClassName: 'w-auto border-(--ui-stroke-secondary) p-0',
        menuContent: (
          <ContextUsagePanel breakdown={contextBreakdown} loading={contextBreakdownLoading} usage={gaugeUsage} />
        ),
        toggleLabel: copy.toggleContextUsage,
        variant: 'menu'
      },`,
  `  // Web port (mobile): statusbar right — only the context meter survives;
  // timers/approval/terminal/version are hidden (plugins come via extraRightItems).
  const coreRightStatusbarItems = useMemo<readonly StatusbarItem[]>(
    () => [
      {
        detail: contextBar || undefined,
        hidden: !contextUsage,
        id: 'context-usage',
        label: contextUsage,
        menuAlign: 'end',
        menuClassName: 'w-auto border-(--ui-stroke-secondary) p-0',
        menuContent: (
          <ContextUsagePanel breakdown={contextBreakdown} loading={contextBreakdownLoading} usage={gaugeUsage} />
        ),
        toggleLabel: copy.toggleContextUsage,
        variant: 'menu'
      },`,
)

// --- app/chat/right-rail/preview-tour.ts: resolve driver.js IIFE via path ---
// driver.js's exports map does NOT expose `./dist/driver.js.iife.js`, so Vite
// can't bundle `driver.js/dist/driver.js.iife.js?raw`. Upstream externalizes
// driver.js/*, which leaves a bare specifier in the emitted bundle — in the
// browser that fails module resolution → white screen. Import the IIFE by
// RELATIVE path (Vite resolves it, `?raw` bundles the string, exports map
// bypassed). The file is hoisted to the repo-root node_modules.
patchFile(
  'app/chat/right-rail/preview-tour.ts',
  'Web port: driver.js IIFE via relative path (exports map bypass)',
  `import driverIifeRaw from 'driver.js/dist/driver.js.iife.js?raw'`,
  `// Web port: driver.js's exports map hides the IIFE path; a bare import
// forces externalization (bare specifier in the browser → white page). Use
// the hoisted repo-root file directly so Vite bundles the raw string.
import driverIifeRaw from '../../../../../node_modules/driver.js/dist/driver.js.iife.js?raw'`,
)

// --- app/chat/right-rail/preview-tour.ts: resolve driver.js CSS via path -----
// Same exports-map story for the CSS? No — `./dist/driver.css` IS exported.
// But keep it bundled: with external off it resolves normally. No patch needed.

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
  'a lone session tab auto-hides the strip upstream',
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
  'collapsible so a phone boots to the chat',
  "      data: { placement: 'left', width: '260px', dock: { pane: 'sessions', pos: 'center', enforce: true } },",
  `      data: {
        placement: 'left',
        width: '260px',
        dock: { pane: 'sessions', pos: 'center', enforce: true },
        // Web port (mobile): collapsible so a phone boots to the chat — Bots
        // leaves the grid under 768px and becomes an edge-overlay drawer an
        // explicit tap opens, instead of a column that auto-fronts and blocks
        // the chat on every reload. (enforce only re-homes the dock position;
        // it does not defeat the narrow-viewport collapse.)
        collapsible: true
      },`,
)
patchFile(
  'plugins/hermes-bots/plugin.js',
  'collapsible so the Cronjobs list',
  `        data: {
          placement: 'main',
          dock: { pane: 'workspace', pos: 'right' },
          width: '250px'
        },`,
  `        data: {
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
  'visible grip so a collapsed pane has a touch',
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

// --- store/session-pin-sync.ts: unpin survives slow/failed PATCH (web port) --
// Root cause: when the user unpins, the local set drops the id instantly and
// writePin(false) PATCHes the server. If that PATCH is slow (>10s WRITE_GUARD)
// or fails, the unconfirmed guard expires/drops, and the next $sessions page
// (which still carries pinned=true) makes pullRemotePins RE-ADOPT the pin —
// "unpin works, then it comes back after a delay / on restart". The 10s
// cooldown was a band-aid; the intent itself must outlive the write.
// Fix: track deselected ids; pullRemotePins skips them until the server row
// actually confirms pinned=false; a failed unpin PATCH retries with backoff
// instead of being swallowed.
patchFile(
  'store/session-pin-sync.ts',
  'Web port (mobile): unpin survives slow/failed PATCH',
  `// pin ids we've successfully PATCHed pinned=true this session.
const mirrored = new Set<string>()`,
  `// pin ids we've successfully PATCHed pinned=true this session.
const mirrored = new Set<string>()
// Web port (mobile): unpin survives slow/failed PATCH — ids the user has
// UNPINNED whose server PATCH has not yet been confirmed by a page carrying
// pinned=false. pullRemotePins must not re-adopt them (the old WRITE_GUARD
// expired after 10s and re-pinned on slow/failed PATCHes). Removed only on
// server confirmation. Persisted in sessionStorage so a reload mid-write
// doesn't lose the fence (the boot pull would re-adopt before the slow PATCH
// lands).
const DESELECTED_STORAGE_KEY = 'hermes-web.deselectedPins'
let deselected = new Set<string>(loadDeselected())

function loadDeselected(): string[] {
  try {
    const raw = window.sessionStorage.getItem(DESELECTED_STORAGE_KEY)
    return raw ? (JSON.parse(raw) as string[]) : []
  } catch {
    return []
  }
}

function saveDeselected(): void {
  try {
    window.sessionStorage.setItem(DESELECTED_STORAGE_KEY, JSON.stringify([...deselected]))
  } catch {
    // Best-effort — the in-memory fence still works for this session.
  }
}`,
)

patchFile(
  'store/session-pin-sync.ts',
  'a user-initiated unpin whose PATCH',
  `    if (pending.has(pinId) || pending.has(row.id)) {
      continue
    }

    if (row.pinned && !heldLocally) {`,
  `    if (pending.has(pinId) || pending.has(row.id)) {
      continue
    }

    // Web port (mobile): a user-initiated unpin whose PATCH hasn't been
    // confirmed yet must not be re-adopted from a stale page. Skip until the
    // server row actually reports pinned=false.
    if (deselected.has(pinId) || deselected.has(row.id)) {
      if (!row.pinned) {
        deselected.delete(pinId)
        deselected.delete(row.id)
        saveDeselected()
      }
      continue
    }

    if (row.pinned && !heldLocally) {`,
)

patchFile(
  'store/session-pin-sync.ts',
  'a failed unpin PATCH must not be swallowed',
  `  // Unpinned: anything we were tracking that's no longer in the set.
  for (const id of [...mirrored, ...pending]) {
    if (!current.has(id)) {
      mirrored.delete(id)
      pending.delete(id)
      void writePin(id, false, profileFor(id)).catch(() => {})
    }
  }`,
  `  // Unpinned: anything we were tracking that's no longer in the set.
  for (const id of [...new Set([...mirrored, ...pending, ...deselected])]) {
    if (!current.has(id)) {
      mirrored.delete(id)
      pending.delete(id)
      deselected.add(id)
      saveDeselected()
      void writePin(id, false, profileFor(id)).catch(() => {
        // Web port (mobile): a failed unpin PATCH must not be swallowed — the
        // server would keep pinned=true and re-adopt on the next page. Retry
        // with backoff instead (the deselected fence holds meanwhile).
        const retry = (attempt: number) => {
          // Stop if the user re-pinned (id is back in the local set) or the
          // server already confirmed the unpin (deselected fence cleared).
          if ($pinnedSessionIds.get().includes(id) || !deselected.has(id)) return
          void writePin(id, false, profileFor(id)).catch(() => {
            window.setTimeout(() => retry(attempt + 1), Math.min(1000 * 2 ** attempt, 15000))
          })
        }
        window.setTimeout(() => retry(1), 2000)
      })
    }
  }`,
)

patchFile(
  'store/session-pin-sync.ts',
  'unconfirmed.clear()',
  `export function resetSessionPinMirror(): void {
  mirrored.clear()
  pending.clear()
  unconfirmed.clear()
}`,
  `export function resetSessionPinMirror(): void {
  mirrored.clear()
  pending.clear()
  unconfirmed.clear()
  deselected.clear()
  saveDeselected()
}`,
)

// --- app/context-menu/app-context-menu.tsx: web-port right-click -----------
// Web port (browser) fixes for the synced upstream handler. The upstream
// handler deliberately never calls preventDefault (Electron's main-process
// context-menu event swallows the native menu for it); a browser tab has no
// main process, so without preventDefault the BROWSER's native menu overlays
// the app menu on EVERY right-click. Separately, the statusbar footer carries
// its own data-slot="statusbar", which a Radix asChild/mergeProps keeps OVER
// the trigger's data-slot="context-menu-trigger", so the closest() check
// missed it and stole the gesture from the statusbar's own ContextMenu.
//
// Idempotency: ONE patch replaces the whole handler. The inserted comment
// `Web port (browser): right-click fixes` IS the marker string, so a second
// run sees `src.includes(marker)` and skips. Do NOT split into per-site
// find/replace: a `stopPropagation()`→`openDomContextMenu` anchor survives a
// bare preventDefault insert and stacks on every re-run.
patchFile(
  'app/context-menu/app-context-menu.tsx',
  'Web port (browser): right-click fixes',
  `    const onContextMenu = (event: MouseEvent) => {
      const element = event.target instanceof Element ? event.target : null

      // Surfaces with their own Radix context menu keep the whole gesture.
      if (element?.closest('[data-slot="context-menu-trigger"]')) {
        return
      }

      // A terminal's canvas has no DOM to resolve; its registered handle
      // carries the xterm selection and paste path instead.
      const terminal = terminalMenuHandleFor(element)

      if (terminal) {
        event.stopPropagation()
        openTerminalContextMenu(event.clientX, event.clientY, terminal)

        return
      }

      const target = resolveDomTarget(element)
      const owned = Boolean(target.linkUrl || target.onImage || target.editable || target.selectionText)

      // The reaction bubble owns bare right-clicks; a link inside it still
      // opens the link menu.
      if (!owned && element?.closest(\`[\${CONTEXT_MENU_SKIP_ATTR}]\`)) {
        return
      }

      event.stopPropagation()
      openDomContextMenu(event.clientX, event.clientY, target)
    }`,
  `    const onContextMenu = (event: MouseEvent) => {
      const element = event.target instanceof Element ? event.target : null

      // Surfaces with their own Radix context menu keep the whole gesture.
      // Web port (browser): right-click fixes — also match the statusbar: its
      // footer carries its own data-slot="statusbar" (Radix asChild keeps the
      // child's data-slot over the trigger's), so the upstream closest() check
      // missed it and this handler stole the gesture, killing the statusbar's
      // Radix ContextMenu.
      if (
        element?.closest('[data-slot="context-menu-trigger"]') ||
        element?.closest('[data-slot="statusbar"]')
      ) {
        return
      }

      // A terminal's canvas has no DOM to resolve; its registered handle
      // carries the xterm selection and paste path instead.
      const terminal = terminalMenuHandleFor(element)

      if (terminal) {
        event.preventDefault()
        event.stopPropagation()
        openTerminalContextMenu(event.clientX, event.clientY, terminal)

        return
      }

      const target = resolveDomTarget(element)
      const owned = Boolean(target.linkUrl || target.onImage || target.editable || target.selectionText)

      // The reaction bubble owns bare right-clicks; a link inside it still
      // opens the link menu.
      if (!owned && element?.closest(\`[\${CONTEXT_MENU_SKIP_ATTR}]\`)) {
        return
      }

      // preventDefault: a browser tab has no Electron main process to swallow
      // the native menu — without it the browser's menu overlays ours.
      event.preventDefault()
      event.stopPropagation()
      openDomContextMenu(event.clientX, event.clientY, target)
    }`,
)

// --- mobile single-surface: no split-screen tiles on narrow viewports ------
// On a phone/tablet there is one workspace surface; session tiles and route
// (page) tiles dock BESIDE main (pos:'right'/'center') via paneMirror and would
// split the screen (and persist, then re-split on boot). The narrow gate has
// three legs:
//   1. pane-mirror.sync()  — the render funnel for BOTH tile types: on narrow
//      it registers nothing and disposes any already-registered tile pane, so
//      even restored-from-storage tiles never render a split.
//   2. openSessionTile     — no-op on narrow (no tile state accumulates, so
//      nothing persists to resurrect a split on rotate or next boot).
//   3. openNewSessionTile  — on narrow a "new tab" becomes a fresh draft in
//      the single workspace (replace, not stack).
patchFile(
  'app/chat/pane-mirror.ts',
  '$narrowViewport, registerPaneCloser',
  "import { registerPaneCloser, removeTreePane, treePanesWithPrefix } from '@/components/pane-shell/tree/store'",
  "import { $narrowViewport, registerPaneCloser, removeTreePane, treePanesWithPrefix } from '@/components/pane-shell/tree/store'",
)
patchFile(
  'app/chat/pane-mirror.ts',
  'Web port (mobile): no split-screen tiles',
  '  const sync = () => {\n    const tiles = cfg.source.get()\n    const wanted = new Set(tiles.map(cfg.key))',
  '  const sync = () => {\n    // Web port (mobile): no split-screen tiles on a narrow viewport — treat\n    // the source as empty so nothing registers, and the dispose + prune loops\n    // below evict any already-registered tile pane.\n    const tiles = $narrowViewport.get() ? [] : cfg.source.get()\n    const wanted = new Set(tiles.map(cfg.key))',
)
patchFile(
  'store/session-states.ts',
  '$narrowViewport,',
  '  $activeTreeGroup,\n  $layoutTree,',
  '  $activeTreeGroup,\n  $layoutTree,\n  $narrowViewport,',
)
patchFile(
  'store/session-states.ts',
  'Web port (mobile): single-surface',
  '  const tiles = $sessionTiles.get()\n\n  // Opening a session in a tab/tile is "reading" it',
  '  // Web port (mobile): single-surface — a narrow viewport has no room for a\n  // split tile; opening a session here instead surfaces in main (the callers\n  // with a navigate handle route it in-place, not as a tile).\n  if ($narrowViewport.get()) {\n    return\n  }\n\n  const tiles = $sessionTiles.get()\n\n  // Opening a session in a tab/tile is "reading" it',
)
patchFile(
  'app/session/hooks/use-session-actions/index.ts',
  '$narrowViewport, revealTreePane',
  "import { revealTreePane } from '@/components/pane-shell/tree/store'",
  "import { $narrowViewport, revealTreePane } from '@/components/pane-shell/tree/store'",
)
patchFile(
  'app/session/hooks/use-session-actions/index.ts',
  'Web port (mobile): no split on narrow',
  '    async (dir: TileDock = \'right\', options?: { cwd?: null | string; listed?: boolean }) => {\n      const listed = options?.listed ?? true',
  '    async (dir: TileDock = \'right\', options?: { cwd?: null | string; listed?: boolean }) => {\n      // Web port (mobile): no split on narrow — a "new tab" request reuses the\n      // single workspace as a fresh draft instead of stacking a tile.\n      if ($narrowViewport.get()) {\n        startFreshSessionDraft()\n\n        return\n      }\n\n      const listed = options?.listed ?? true',
)

if (touched === 0) {
  console.log('no patches applied (all present)')
} else {
  console.log(`${touched} file(s) patched`)
}