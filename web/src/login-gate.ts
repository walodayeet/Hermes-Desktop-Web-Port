/**
 * login-gate.ts — thin auth gate for the web port.
 *
 * The Electron shell authenticates natively (spawns the backend with env
 * credentials, mints cookies out-of-band). A browser can't do that, so the
 * web port gates app boot on a session cookie: GET /api/auth/me with the
 * session cookie → 200 means boot the real app; 401 renders a minimal
 * username/password form (POST /auth/password-login, HttpOnly cookie lands,
 * reload). The app itself is untouched — this is pure pre-boot chrome.
 *
 * Vanilla DOM on purpose: it runs before React mounts and must stay tiny.
 */

const API = ((import.meta.env.VITE_HERMES_BASE as string | undefined) ?? '').replace(/\/+$/, '')

function styles(): string {
  return `
  * { box-sizing: border-box; margin: 0; padding: 0; }
  html, body { height: 100%; }
  body {
    font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
    background: #111111; color: #e8e8e8;
    display: grid; place-items: center; padding: 16px;
  }
  .card {
    width: min(100%, 360px); background: #1b1b1b; border: 1px solid #2c2c2c;
    border-radius: 14px; padding: 28px 24px;
    box-shadow: 0 12px 40px rgba(0,0,0,.5);
  }
  .logo { width: 44px; height: 44px; border-radius: 10px; background: #e06c2a;
          display: grid; place-items: center; font-weight: 800; font-size: 22px;
          color: #111; margin-bottom: 14px; }
  h1 { font-size: 20px; font-weight: 650; margin-bottom: 4px; }
  p.sub { font-size: 13px; color: #9a9a9a; margin-bottom: 22px; }
  label { display: block; font-size: 12px; font-weight: 600; color: #bbb; margin: 14px 0 6px; }
  input {
    width: 100%; background: #141414; color: #eee; border: 1px solid #333;
    border-radius: 8px; padding: 10px 12px; font-size: 15px; outline: none;
  }
  input:focus { border-color: #e06c2a; }
  button {
    width: 100%; margin-top: 20px; background: #e06c2a; color: #111;
    border: 0; border-radius: 8px; padding: 11px; font-size: 15px;
    font-weight: 700; cursor: pointer;
  }
  button:disabled { opacity: .55; cursor: default; }
  .error { margin-top: 14px; font-size: 13px; color: #ff6b6b; min-height: 18px; }
  .status { margin-top: 18px; font-size: 13px; color: #9a9a9a; text-align: center; }
  @media (prefers-color-scheme: light) {
    body { background: #f5f5f5; color: #1a1a1a; }
    .card { background: #fff; border-color: #e2e2e2; }
    input { background: #fafafa; border-color: #ddd; color: #111; }
    label { color: #555; }
    p.sub { color: #777; }
    .status { color: #777; }
  }
  `
}

function renderLogin(): void {
  document.title = 'Hermes — Sign in'
  const style = document.createElement('style')
  style.textContent = styles()
  document.head.appendChild(style)

  const card = document.createElement('div')
  card.className = 'card'
  card.innerHTML = `
    <div class="logo">H</div>
    <h1>Hermes</h1>
    <p class="sub">Sign in to your Hermes gateway</p>
    <form id="login-form">
      <label for="username">Username</label>
      <input id="username" name="username" autocomplete="username" required />
      <label for="password">Password</label>
      <input id="password" name="password" type="password" autocomplete="current-password" required />
      <button type="submit" id="submit">Sign in</button>
    </form>
    <div class="error" id="error"></div>
    <div class="status" id="status"></div>
  `
  document.body.appendChild(card)

  const form = card.querySelector<HTMLFormElement>('#login-form')!
  const error = card.querySelector<HTMLDivElement>('#error')!
  const status = card.querySelector<HTMLDivElement>('#status')!
  const submit = card.querySelector<HTMLButtonElement>('#submit')!
  const username = card.querySelector<HTMLInputElement>('#username')!
  const password = card.querySelector<HTMLInputElement>('#password')!

  form.addEventListener('submit', async (e) => {
    e.preventDefault()
    error.textContent = ''
    status.textContent = 'Signing in…'
    submit.disabled = true
    try {
      const res = await fetch(`${API}/auth/password-login`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider: 'basic', username: username.value, password: password.value }),
      })
      if (!res.ok) {
        const body = await res.json().catch(() => null)
        error.textContent =
          (body && (body.detail ?? body.error)) || `Sign-in failed (HTTP ${res.status})`
        status.textContent = ''
        submit.disabled = false
        return
      }
      status.textContent = 'Connected — loading Hermes…'
      window.location.reload()
    } catch (err) {
      error.textContent = err instanceof Error ? err.message : 'Network error'
      status.textContent = ''
      submit.disabled = false
    }
  })

  username.focus()
}

async function gate(): Promise<void> {
  // Session cookie present? Boot the app.
  try {
    const res = await fetch(`${API}/api/auth/me`, { credentials: 'include' })
    if (res.ok) return
  } catch {
    // Backend unreachable — still boot; the app shows its own connection
    // failure UI with a retry path.
    return
  }
  renderLogin()
  // Never reach main.tsx's createRoot while the gate is up.
  await new Promise(() => {})
}

export async function runLoginGate(): Promise<void> {
  await gate()
}
