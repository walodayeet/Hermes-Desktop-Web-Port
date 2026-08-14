import { useEffect, useRef, useState, type ReactNode } from 'react'
import { useStore } from '../store/store'
import type { ChatMessage, ToolCall } from '../types'

function renderBody(text: string): ReactNode[] {
  const nodes: ReactNode[] = []
  const fence = /```([\w-]*)\n?([\s\S]*?)```/g
  let last = 0
  let key = 0
  let m: RegExpExecArray | null
  while ((m = fence.exec(text))) {
    if (m.index > last) nodes.push(<span key={key++} className="msg-text">{text.slice(last, m.index)}</span>)
    const lang = m[1]?.trim()
    const code = m[2].replace(/\n$/, '')
    nodes.push(
      <pre key={key++} className="code-block">
        {lang ? <div className="code-lang">{lang}</div> : null}
        <code>{code}</code>
      </pre>,
    )
    last = m.index + m[0].length
  }
  if (last < text.length) nodes.push(<span key={key++} className="msg-text">{text.slice(last)}</span>)
  return nodes.length ? nodes : [<span key="0" className="msg-text">{text}</span>]
}

function ThinkingBlock({ thinking, reasoning }: { thinking?: string; reasoning?: string }) {
  const [open, setOpen] = useState(false)
  const label = reasoning ? 'Reasoning' : 'Thinking'
  const content = reasoning ?? thinking ?? ''
  if (!content) return null
  return (
    <div className="thinking">
      <button className="thinking-toggle" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        <span className={`chevron ${open ? 'is-open' : ''}`}>▸</span>
        {label}
        {!open && <span className="thinking-preview">{content.slice(0, 80).replace(/\n/g, ' ')}…</span>}
      </button>
      {open && <pre className="thinking-body">{content}</pre>}
    </div>
  )
}

function ToolCard({ tc }: { tc: ToolCall }) {
  const [open, setOpen] = useState(false)
  const summary = tc.summary || tc.context || ''
  const statusCls = tc.status === 'running' ? 'is-running' : tc.status === 'done' ? 'is-done' : ''
  return (
    <div className={`tool-card ${statusCls}`}>
      <button className="tool-card-head" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        <span className={`tool-status-dot ${statusCls}`} />
        <span className="tool-name">{tc.name}</span>
        {tc.duration_s != null && <span className="tool-duration">{tc.duration_s.toFixed(1)}s</span>}
        <span className="tool-summary">{summary}</span>
        <span className={`chevron ${open ? 'is-open' : ''}`}>▸</span>
      </button>
      {open && (
        <div className="tool-card-detail">
          {tc.inline_diff ? (
            <pre className="tool-diff">{tc.inline_diff}</pre>
          ) : tc.result != null ? (
            <pre className="tool-result">{typeof tc.result === 'string' ? tc.result : JSON.stringify(tc.result, null, 2)}</pre>
          ) : tc.args != null ? (
            <pre className="tool-result">{JSON.stringify(tc.args, null, 2)}</pre>
          ) : (
            <div className="tool-empty">No detail</div>
          )}
        </div>
      )}
    </div>
  )
}

function Message({ msg }: { msg: ChatMessage }) {
  if (msg.role === 'tool') {
    return <div className="tool-row">{msg.toolCalls?.map((t) => <ToolCard key={t.id} tc={t} />)}</div>
  }
  if (msg.role === 'system') {
    return <div className="system-note">{msg.text}</div>
  }
  const isUser = msg.role === 'user'
  const hasThought = !!msg.thinking || !!msg.reasoning
  return (
    <div className={`msg msg-${isUser ? 'user' : 'assistant'}`}>
      {!isUser && hasThought && <ThinkingBlock thinking={msg.thinking} reasoning={msg.reasoning} />}
      {msg.toolCalls && msg.toolCalls.length > 0 && (
        <div className="tool-row">{msg.toolCalls.map((t) => <ToolCard key={t.id} tc={t} />)}</div>
      )}
      {msg.text && (
        <div className={`bubble ${isUser ? 'bubble-user' : 'bubble-assistant'}`}>
          {renderBody(msg.text)}
          {msg.streaming && <span className="cursor">▍</span>}
        </div>
      )}
    </div>
  )
}

export default function MessageList() {
  const messages = useStore((s) => s.messages)
  const loading = useStore((s) => s.loadingMessages)
  const bottomRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: 'end' })
  }, [messages])

  if (loading) return <div className="msg-loading">Loading…</div>
  if (messages.length === 0) {
    return (
      <div className="empty-state">
        <div className="empty-mark">H</div>
        <p>Start a conversation</p>
      </div>
    )
  }
  return (
    <div className="message-list">
      {messages.map((m) => (
        <Message key={m.id} msg={m} />
      ))}
      <div ref={bottomRef} />
    </div>
  )
}
