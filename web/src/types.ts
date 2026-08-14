export type Role = 'user' | 'assistant' | 'system' | 'tool'

export interface Usage {
  prompt_tokens?: number
  completion_tokens?: number
  total_tokens?: number
}

export type ToolStatus = 'running' | 'done' | 'error'

export interface ToolCall {
  id: string
  name: string
  context?: string
  args?: unknown
  result?: unknown
  summary?: string
  status?: ToolStatus
  duration_s?: number
  inline_diff?: string
}

export interface ChatMessage {
  id: string
  role: Role
  text: string
  thinking?: string
  reasoning?: string
  toolCalls?: ToolCall[]
  streaming?: boolean
  usage?: Usage
  error?: boolean
  displayKind?: string
}

export interface SessionInfo {
  id: string
  title?: string
  preview?: string
  started_at?: number
  message_count?: number
  source?: string
}

export interface ClarifyRequest {
  request_id: string
  question: string
  choices: string[]
  multi_select?: boolean
}

export interface ApprovalRequest {
  command: string
  description?: string
  choices?: string[]
  pattern_keys?: string[]
}

export type ConnStatus = 'connected' | 'connecting' | 'reconnecting' | 'offline'

export type ToastKind = 'error' | 'info' | 'success'

export interface Toast {
  id: number
  kind: ToastKind
  text: string
}

export type ThemePref = 'light' | 'dark' | 'system'

export interface GatewayEvent {
  jsonrpc: '2.0'
  method: 'event'
  params: {
    type: string
    payload: Record<string, unknown>
    session_id?: string
  }
}
