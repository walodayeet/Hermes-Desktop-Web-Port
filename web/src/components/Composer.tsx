import { useRef, useState, type ChangeEvent, type KeyboardEvent } from 'react'
import { useStore } from '../store/store'

const MAX_HEIGHT = 160

export default function Composer() {
  const streaming = useStore((s) => s.streaming)
  const sendMessage = useStore((s) => s.sendMessage)
  const stop = useStore((s) => s.stop)
  const [value, setValue] = useState('')
  const ref = useRef<HTMLTextAreaElement>(null)

  const resize = () => {
    const el = ref.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, MAX_HEIGHT)}px`
  }

  const onChange = (e: ChangeEvent<HTMLTextAreaElement>) => {
    setValue(e.target.value)
    resize()
  }

  const send = () => {
    const text = value
    if (!text.trim() || streaming) return
    setValue('')
    requestAnimationFrame(() => {
      if (ref.current) ref.current.style.height = 'auto'
    })
    void sendMessage(text)
  }

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      send()
    }
  }

  return (
    <div className="composer">
      <div className="composer-inner">
        <textarea
          ref={ref}
          className="composer-input"
          rows={1}
          value={value}
          placeholder="Message Hermes…"
          onChange={onChange}
          onKeyDown={onKeyDown}
          disabled={streaming}
        />
        {streaming ? (
          <button className="btn btn-stop" onClick={() => void stop()}>
            <span className="stop-dot" />
            Stop
          </button>
        ) : (
          <button className="btn btn-primary btn-send" onClick={send} disabled={!value.trim()}>
            Send
          </button>
        )}
      </div>
    </div>
  )
}
