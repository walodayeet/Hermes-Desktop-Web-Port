// Same-origin by default: Vite (dev) and the Node proxy (prod) both forward
// /api + /auth to the hermes serve backend, so the cookie session stays
// same-origin. Set VITE_API_BASE to talk to a backend directly instead.
const raw = (import.meta.env.VITE_API_BASE as string | undefined) || ''

export const API_BASE = raw.replace(/\/+$/, '')

export function restUrl(path: string): string {
  return `${API_BASE}${path}`
}

export function wsOrigin(): string {
  if (API_BASE) {
    const u = new URL(API_BASE)
    const proto = u.protocol === 'https:' ? 'wss:' : 'ws:'
    return `${proto}//${u.host}`
  }
  const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
  return `${proto}//${window.location.host}`
}
