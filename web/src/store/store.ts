import { create } from 'zustand'
import type {
  ApprovalRequest,
  ChatMessage,
  ClarifyRequest,
  ConnStatus,
  GatewayEvent,
  SessionInfo,
  ThemePref,
  Toast,
  ToastKind,
  ToolCall,
  Usage,
} from '../types'
import { GatewayClient } from '../lib/ws'
import * as api from '../lib/api'
import { applyTheme, loadTheme, persistTheme } from '../lib/theme'

let msgSeq = 0
let toastSeq = 0

function nextId(): string {
  msgSeq += 1
  return `m${Date.now().toString(36)}-${msgSeq}`
}

function asText(v: unknown): string {
  if (v == null) return ''
  if (typeof v === 'string') return v
  if (typeof v === 'number' || typeof v === 'boolean') return String(v)
  return ''
}

function hydrateMessages(raw: unknown): ChatMessage[] {
  if (!Array.isArray(raw)) return []
  const out: ChatMessage[] = []
  for (const item of raw) {
    const m = hydrateMessage(item)
    if (m) out.push(m)
  }
  return out
}

function hydrateMessage(item: unknown): ChatMessage | null {
  if (!item || typeof item !== 'object') return null
  const m = item as Record<string, unknown>
  const role = m.role
  if (role !== 'user' && role !== 'assistant' && role !== 'tool' && role !== 'system') return null
  if (role === 'tool') {
    return {
      id: nextId(),
      role: 'tool',
      text: '',
      toolCalls: [
        {
          id: nextId(),
          name: asText(m.name) || 'tool',
          context: asText(m.context),
          args: m.args,
          status: 'done',
        },
      ],
    }
  }
  const reasoning = [m.reasoning, m.reasoning_content, m.reasoning_details].map(asText).find(Boolean)
  return {
    id: nextId(),
    role,
    text: asText(m.text) || asText(m.content),
    reasoning,
    displayKind: asText(m.display_kind) || undefined,
  }
}

const gateway = new GatewayClient()

let initialSessionPending = false

interface Store {
  authed: boolean
  booting: boolean
  me: api.MeInfo | null
  conn: ConnStatus
  sessions: SessionInfo[]
  currentSessionId: string | null
  sessionKey: string | null
  loadingMessages: boolean
  messages: ChatMessage[]
  streaming: boolean
  clarify: ClarifyRequest | null
  approval: ApprovalRequest | null
  drawerOpen: boolean
  toasts: Toast[]
  theme: ThemePref

  boot: () => Promise<void>
  login: (u: string, p: string) => Promise<void>
  logout: () => Promise<void>
  loadSessions: () => Promise<void>
  newSession: () => Promise<void>
  selectInitialSession: () => Promise<void>
  openSession: (id: string) => Promise<void>
  deleteSession: (id: string) => Promise<void>
  sendMessage: (text: string) => Promise<void>
  stop: () => Promise<void>
  respondClarify: (answer: string) => Promise<void>
  respondApproval: (choice: string) => Promise<void>
  toast: (kind: ToastKind, text: string) => void
  dismissToast: (id: number) => void
  setTheme: (t: ThemePref) => void
  setDrawer: (open: boolean) => void
  handleEvent: (ev: GatewayEvent) => void
}

export const useStore = create<Store>((set, get) => ({
  authed: false,
  booting: true,
  me: null,
  conn: 'offline',
  sessions: [],
  currentSessionId: null,
  sessionKey: null,
  loadingMessages: false,
  messages: [],
  streaming: false,
  clarify: null,
  approval: null,
  drawerOpen: false,
  toasts: [],
  theme: loadTheme(),
  boot: async () => {
    set({ booting: true })
    try {
      const me = await api.fetchMe()
      gateway.onStatus = (s) => {
        const prev = get().conn
        set({ conn: s })
        if (s === 'connected') {
          void get().loadSessions()
          if (initialSessionPending) {
            initialSessionPending = false
            void get().selectInitialSession()
          } else if (prev === 'offline' || prev === 'reconnecting') {
            const key = get().sessionKey ?? get().currentSessionId
            if (key) void get().openSession(key)
          }
        } else if (s === 'offline' || s === 'reconnecting') {
          sealStreaming(set, get)
          if (s === 'offline') get().toast('error', 'Connection lost — reconnecting…')
        }
      }
      gateway.onEvent = (ev) => get().handleEvent(ev)
      initialSessionPending = true
      set({ authed: true, me, booting: false })
      gateway.connect()
    } catch {
      set({ authed: false, me: null, booting: false })
    }
  },

  selectInitialSession: async () => {
    try {
      const r = (await gateway.send('session.most_recent', {})) as { session_id: string | null }
      if (r?.session_id) await get().openSession(r.session_id)
      else await get().newSession()
    } catch {
      initialSessionPending = true
    }
  },

  login: async (u, p) => {
    await api.login(u, p)
    await get().boot()
  },

  logout: async () => {
    try {
      await api.logout()
    } catch {
      /* session already gone */
    }
    initialSessionPending = false
    gateway.close()
    set({
      authed: false,
      me: null,
      sessions: [],
      messages: [],
      currentSessionId: null,
      sessionKey: null,
      streaming: false,
      clarify: null,
      approval: null,
    })
  },
  loadSessions: async () => {
    try {
      const r = (await gateway.send('session.list', { limit: 100 })) as { sessions: SessionInfo[] }
      set({ sessions: r?.sessions ?? [] })
    } catch {
      /* keep stale list on failure */
    }
  },

  newSession: async () => {
    const r = (await gateway.send('session.create', {})) as {
      session_id: string
      stored_session_id?: string
    }
    set({
      currentSessionId: r.session_id,
      sessionKey: r.stored_session_id ?? r.session_id,
      messages: [],
      streaming: false,
      clarify: null,
      approval: null,
    })
    void get().loadSessions()
  },

  openSession: async (id) => {
    set({ loadingMessages: true, drawerOpen: false })
    try {
      const r = (await gateway.send('session.resume', { session_id: id })) as {
        session_id: string
        resumed?: string
        session_key?: string
        messages?: unknown[]
        running?: boolean
      }
      let msgs = hydrateMessages(r.messages)
      const running = r.running === true
      if (running) {
        msgs = [...msgs, { id: nextId(), role: 'assistant', text: '', streaming: true, toolCalls: [] }]
      }
      set({
        currentSessionId: r.session_id,
        sessionKey: r.session_key ?? r.resumed ?? id,
        messages: msgs,
        streaming: running,
        clarify: null,
        approval: null,
        loadingMessages: false,
      })
    } catch (err) {
      set({ loadingMessages: false })
      get().toast('error', err instanceof Error ? err.message : 'Failed to open session')
    }
  },

  deleteSession: async (id) => {
    try {
      await gateway.send('session.delete', { session_id: id })
      await get().loadSessions()
      if (get().sessionKey === id || get().currentSessionId === id) {
        await get().newSession()
      }
    } catch (err) {
      get().toast('error', err instanceof Error ? err.message : 'Failed to delete session')
    }
  },

  sendMessage: async (text) => {
    const trimmed = text.trim()
    if (!trimmed || get().streaming) return
    let sid = get().currentSessionId
    if (!sid) {
      await get().newSession()
      sid = get().currentSessionId
      if (!sid) return
    }
    const userMsg: ChatMessage = { id: nextId(), role: 'user', text: trimmed }
    set((s) => ({ messages: [...s.messages, userMsg], streaming: true }))
    try {
      await gateway.send('prompt.submit', { text: trimmed, session_id: sid }, 600_000)
    } catch (err) {
      set({ streaming: false })
      get().toast('error', err instanceof Error ? err.message : 'Send failed')
    }
  },

  stop: async () => {
    const sid = get().currentSessionId
    if (!sid) return
    try {
      await gateway.send('session.interrupt', { session_id: sid })
    } catch (err) {
      get().toast('error', err instanceof Error ? err.message : 'Interrupt failed')
    }
  },

  respondClarify: async (answer) => {
    const c = get().clarify
    if (!c) return
    set({ clarify: null })
    try {
      await gateway.send('clarify.respond', { request_id: c.request_id, answer })
    } catch (err) {
      get().toast('error', err instanceof Error ? err.message : 'Clarify failed')
    }
  },

  respondApproval: async (choice) => {
    const sid = get().currentSessionId
    set({ approval: null })
    try {
      await gateway.send('approval.respond', { session_id: sid, choice })
    } catch (err) {
      get().toast('error', err instanceof Error ? err.message : 'Approval failed')
    }
  },

  toast: (kind, text) => {
    toastSeq += 1
    const id = toastSeq
    set((s) => ({ toasts: [...s.toasts, { id, kind, text }] }))
    window.setTimeout(() => get().dismissToast(id), kind === 'error' ? 7000 : 4000)
  },

  dismissToast: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),

  setTheme: (t) => {
    set({ theme: t })
    persistTheme(t)
    applyTheme(t)
  },

  setDrawer: (open) => set({ drawerOpen: open }),

  handleEvent: (ev) => {
    const { type, payload, session_id } = ev.params
    const s = get()
    const isCurrent =
      !session_id || session_id === s.currentSessionId || session_id === s.sessionKey

    switch (type) {
      case 'gateway.ready':
        set({ conn: 'connected' })
        break
      case 'message.start':
        if (isCurrent && !get().streaming) {
          const msg: ChatMessage = { id: nextId(), role: 'assistant', text: '', streaming: true, toolCalls: [] }
          set((st) => ({ streaming: true, messages: [...st.messages, msg] }))
        }
        break
      case 'message.delta':
        if (isCurrent) appendDelta(set, asText(payload.text) || asText(payload.content))
        break
      case 'thinking.delta':
        if (isCurrent) appendSideBlock(set, 'thinking', asText(payload.text))
        break
      case 'reasoning.delta':
        if (isCurrent) appendSideBlock(set, 'reasoning', asText(payload.text))
        break
      case 'tool.start':
        if (isCurrent) upsertTool(set, {
          id: asText(payload.tool_id) || asText(payload.id) || `t${nextId()}`,
          name: asText(payload.name) || 'tool',
          context: asText(payload.context),
          args: payload.args,
          status: 'running',
        })
        break
      case 'tool.complete':
        if (isCurrent) upsertTool(set, {
          id: asText(payload.tool_id) || asText(payload.id) || `t${nextId()}`,
          name: asText(payload.name) || 'tool',
          result: payload.result,
          summary: asText(payload.summary),
          duration_s: typeof payload.duration_s === 'number' ? payload.duration_s : undefined,
          inline_diff: asText(payload.inline_diff),
          status: 'done',
        })
        break
      case 'message.complete':
        if (isCurrent) finishTurn(set, get, payload)
        break
      case 'clarify.request':
        if (isCurrent) {
          set({
            clarify: {
              request_id: asText(payload.request_id) || asText(payload.id) || '',
              question: asText(payload.question),
              choices: Array.isArray(payload.choices) ? payload.choices.map(String) : [],
              multi_select: payload.multi_select === true,
            },
          })
        }
        break
      case 'clarify.expire':
        if (isCurrent && get().clarify?.request_id === payload.request_id) set({ clarify: null })
        break
      case 'approval.request':
        if (isCurrent) {
          set({
            approval: {
              command: asText(payload.command),
              description: asText(payload.description),
              choices: Array.isArray(payload.choices) ? payload.choices.map(String) : [],
              pattern_keys: Array.isArray(payload.pattern_keys)
                ? payload.pattern_keys.map(String)
                : undefined,
            },
          })
        }
        break
      case 'error':
        get().toast('error', asText(payload.message) || 'Gateway error')
        break
      case 'notification.show':
        get().toast(asText(payload.level) === 'error' ? 'error' : 'info', asText(payload.text))
        break
      case 'status.update':
        if (payload.kind === 'compacting') get().toast('info', asText(payload.text) || 'Compacting…')
        break
      case 'session.info':
        if (session_id && (session_id === s.currentSessionId || session_id === s.sessionKey)) {
          void get().loadSessions()
        }
        break
      default:
        break
    }
  },
}))

function sealStreaming(
  set: (partial: Partial<Store> | ((s: Store) => Partial<Store>)) => void,
  get: () => Store,
): void {
  if (!get().streaming) return
  set((s) => {
    if (!s.messages.length) return { streaming: false }
    const last = s.messages[s.messages.length - 1]
    const updated = { ...last, streaming: false }
    return { streaming: false, messages: [...s.messages.slice(0, -1), updated] }
  })
}

function appendDelta(
  set: (partial: Partial<Store> | ((s: Store) => Partial<Store>)) => void,
  delta: string,
): void {
  if (!delta) return
  set((s) => {
    const msgs = s.messages
    const last = msgs[msgs.length - 1]
    if (!last || last.role !== 'assistant' || !last.streaming) {
      const msg: ChatMessage = { id: nextId(), role: 'assistant', text: delta, streaming: true, toolCalls: [] }
      return { streaming: true, messages: [...msgs, msg] }
    }
    return { messages: [...msgs.slice(0, -1), { ...last, text: last.text + delta }] }
  })
}

function appendSideBlock(
  set: (partial: Partial<Store> | ((s: Store) => Partial<Store>)) => void,
  field: 'thinking' | 'reasoning',
  text: string,
): void {
  if (!text) return
  set((s) => {
    let msgs = s.messages
    let last = msgs[msgs.length - 1]
    if (!last || last.role !== 'assistant' || !last.streaming) {
      last = { id: nextId(), role: 'assistant', text: '', streaming: true, toolCalls: [] }
      msgs = [...msgs, last]
    }
    const updated = { ...last, [field]: (last[field] ?? '') + text } as ChatMessage
    return { streaming: true, messages: [...msgs.slice(0, -1), updated] }
  })
}

function upsertTool(
  set: (partial: Partial<Store> | ((s: Store) => Partial<Store>)) => void,
  tc: ToolCall,
): void {
  set((s) => {
    let msgs = s.messages
    let last = msgs[msgs.length - 1]
    if (!last || last.role !== 'assistant' || !last.streaming) {
      last = { id: nextId(), role: 'assistant', text: '', streaming: true, toolCalls: [] }
      msgs = [...msgs, last]
    }
    const tools = last.toolCalls ?? []
    const idx = tools.findIndex((x) => x.id === tc.id)
    const nextTools = idx >= 0 ? tools.map((x, i) => (i === idx ? { ...x, ...tc } : x)) : [...tools, tc]
    return { streaming: true, messages: [...msgs.slice(0, -1), { ...last, toolCalls: nextTools }] }
  })
}

function finishTurn(
  set: (partial: Partial<Store> | ((s: Store) => Partial<Store>)) => void,
  get: () => Store,
  payload: Record<string, unknown>,
): void {
  const text = asText(payload.text)
  const status = asText(payload.status)
  const usage = payload.usage as Usage | undefined
  const reasoning = asText(payload.reasoning)
  set((s) => {
    const msgs = s.messages
    let next: ChatMessage[]
    if (msgs.length) {
      const last = msgs[msgs.length - 1]
      const updated: ChatMessage = {
        ...last,
        text: text || last.text,
        reasoning: reasoning || last.reasoning,
        streaming: false,
        usage: usage ?? last.usage,
        error: status === 'error' || !!last.error,
      }
      next = [...msgs.slice(0, -1), updated]
    } else if (text) {
      next = [{ id: nextId(), role: 'assistant', text, usage, error: status === 'error' }]
    } else {
      next = msgs
    }
    return { messages: next, streaming: false }
  })
  void get().loadSessions()
}
