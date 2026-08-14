import { restUrl } from './config'

export interface MeInfo {
  user_id?: string
  provider?: string
  email?: string
}

export class ApiError extends Error {
  status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(restUrl(path), {
    credentials: 'include',
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
  })
  let data: unknown = null
  try {
    data = await res.json()
  } catch {
    /* non-JSON body */
  }
  if (!res.ok) {
    const detail =
      (data as { detail?: string } | null)?.detail ??
      (data as { error?: string } | null)?.error ??
      `HTTP ${res.status}`
    throw new ApiError(res.status, detail)
  }
  return data as T
}

export function login(username: string, password: string): Promise<{ ok: boolean; next?: string }> {
  return request('/auth/password-login', {
    method: 'POST',
    body: JSON.stringify({ provider: 'basic', username, password }),
  })
}

export function logout(): Promise<{ ok?: boolean }> {
  return request('/auth/logout', { method: 'POST' })
}

export function fetchMe(): Promise<MeInfo> {
  return request('/api/auth/me')
}

export function fetchWsTicket(): Promise<{ ticket: string; ttl_seconds: number }> {
  return request('/api/auth/ws-ticket', { method: 'POST' })
}
