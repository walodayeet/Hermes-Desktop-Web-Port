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
patchFile(
  'main.tsx',
  'import \'./web-bridge\'',
  "import { installClipboardShim } from './lib/clipboard'",
  `// Web port: the bridge self-installs at module scope below — this import MUST
// stay ahead of \`./app\` (module bodies evaluate in import order), so
// window.hermesDesktop exists before the app's module-scope plugin discovery
// (app/contrib/controller.tsx → watchRuntimePlugins) runs.
import './web-bridge'

// Web port: session-cookie auth gate. Boots the app only when authenticated.
import { runLoginGate } from './login-gate'

import { installClipboardShim } from './lib/clipboard'`,
)
patchFile(
  'main.tsx',
  'void runLoginGate().then(() => {',
  'createRoot(document.getElementById(\'root\')!).render(',
  `void runLoginGate().then(() => {
    createRoot(document.getElementById('root')!).render(`,
)
patchFile(
  'main.tsx',
  '    )\n  })',
  '    </StrictMode>\n  )',
  `    </StrictMode>
    )
  })`,
)

// --- styles.css: iOS input floor -------------------------------------------------
patchFile(
  'styles.css',
  'Web port (iOS): Safari auto-zooms',
  '@custom-variant dark (&:is(.dark *));',
  `@custom-variant dark (&:is(.dark *));

/* Web port (iOS): Safari auto-zooms into any form field whose font-size is
   below 16px on focus. The app's compact input styles (12–14px) trigger it
   on iPhone. Floor the size at the form-field level only — conversation
   text, titles, and chrome keep their design sizes. */
input,
textarea,
select {
  font-size: 16px;
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
patchFile(
  'app/shell/titlebar.ts',
  'pt-[var(--safe-area-top,0px)]',
  'export const titlebarHeaderBaseClass =',
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

if (touched === 0) {
  console.log('no patches applied (all present)')
} else {
  console.log(`${touched} file(s) patched`)
}
