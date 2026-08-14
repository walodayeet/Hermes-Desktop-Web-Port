import { wsOrigin } from './config'
import { fetchWsTicket } from './api'
import type { ConnStatus, GatewayEvent } from '../types'

type Pending = {
  resolve: (v: unknown) => void
  reject: (e: Error) => void
  timer: number
}

const MAX_BACKOFF = 30_000

/**
 * Newline-delimited JSON-RPC 2.0 client over /api/ws.
 *
 * Gated-mode auth is a single-use 30s-TTL ticket minted by the
 * cookie-authenticated `POST /api/auth/ws-ticket`; each (re)connect fetches a
 * fresh ticket. Requests are matched to responses by `id` via a pending map.
 * Events (`method: "event"`) carry no `id` and are dispatched as-is.
 */
export class GatewayClient {
  private ws: WebSocket | null = null
  private nextId = 1
  private pending = new Map<number, Pending>()
  private backoff = 1000
  private closedByUser = false
  private reconnectTimer: number | null = null
  private connecting = false

  onEvent: ((ev: GatewayEvent) => void) | null = null
  onStatus: ((s: ConnStatus) => void) | null = null

  connect(): void {
    this.closedByUser = false
    void this.open()
  }

  private async open(): Promise<void> {
    if (this.connecting || (this.ws && this.ws.readyState === WebSocket.OPEN)) return
    this.connecting = true
    this.onStatus?.('connecting')
    try {
      const { ticket } = await fetchWsTicket()
      const url = `${wsOrigin()}/api/ws?ticket=${encodeURIComponent(ticket)}`
      const ws = new WebSocket(url)
      this.ws = ws
      ws.onopen = () => {
        this.connecting = false
        this.backoff = 1000
        this.onStatus?.('connected')
      }
      ws.onmessage = (ev) => this.handleMessage(String(ev.data))
      ws.onclose = () => {
        this.connecting = false
        this.ws = null
        this.rejectAll(new Error('connection closed'))
        this.onStatus?.('offline')
        this.scheduleReconnect()
      }
      ws.onerror = () => {
        ws.close()
      }
    } catch {
      this.connecting = false
      this.onStatus?.('offline')
      this.scheduleReconnect()
    }
  }

  private handleMessage(data: string): void {
    let msg: Record<string, unknown>
    try {
      msg = JSON.parse(data)
    } catch {
      return
    }
    if (msg && msg.method === 'event') {
      this.onEvent?.(msg as unknown as GatewayEvent)
      return
    }
    const id = msg && typeof msg.id === 'number' ? msg.id : null
    if (id != null && this.pending.has(id)) {
      const p = this.pending.get(id)!
      this.pending.delete(id)
      clearTimeout(p.timer)
      const err = msg.error as { message?: string } | undefined
      if (err) p.reject(new Error(err.message ?? 'rpc error'))
      else p.resolve(msg.result)
    }
  }

  private scheduleReconnect(): void {
    if (this.closedByUser || this.reconnectTimer != null) return
    this.onStatus?.('reconnecting')
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = null
      void this.open()
    }, this.backoff)
    this.backoff = Math.min(this.backoff * 2, MAX_BACKOFF)
  }

  send(method: string, params?: Record<string, unknown>, timeoutMs = 120_000): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const ws = this.ws
      if (!ws || ws.readyState !== WebSocket.OPEN) {
        reject(new Error('not connected'))
        return
      }
      const id = this.nextId++
      const timer = window.setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`timeout: ${method}`))
      }, timeoutMs)
      this.pending.set(id, { resolve, reject, timer })
      ws.send(JSON.stringify({ jsonrpc: '2.0', id, method, params: params ?? {} }))
    })
  }

  private rejectAll(err: Error): void {
    for (const [id, p] of this.pending) {
      clearTimeout(p.timer)
      p.reject(err)
      this.pending.delete(id)
    }
  }

  close(): void {
    this.closedByUser = true
    if (this.reconnectTimer != null) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    const ws = this.ws
    if (ws) {
      ws.onclose = null
      ws.close()
      this.ws = null
    }
  }
}
