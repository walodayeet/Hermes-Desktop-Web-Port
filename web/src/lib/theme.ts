import type { ThemePref } from '../types'

const KEY = 'hermes-web-theme'

export function loadTheme(): ThemePref {
  const v = localStorage.getItem(KEY)
  if (v === 'light' || v === 'dark' || v === 'system') return v
  return 'system'
}

export function persistTheme(t: ThemePref): void {
  localStorage.setItem(KEY, t)
}

export function applyTheme(t: ThemePref): void {
  const resolved: 'light' | 'dark' =
    t === 'system'
      ? window.matchMedia('(prefers-color-scheme: dark)').matches
        ? 'dark'
        : 'light'
      : t
  document.documentElement.setAttribute('data-theme', resolved)
  const meta = document.querySelector('meta[name="theme-color"]')
  if (meta) meta.setAttribute('content', resolved === 'dark' ? '#0f1115' : '#f4f4f2')
}
