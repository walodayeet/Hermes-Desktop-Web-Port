import { useStore } from '../store/store'

function timeAgo(ts?: number): string {
  if (!ts) return ''
  const d = Date.now() / 1000 - ts
  if (d < 60) return 'now'
  if (d < 3600) return `${Math.floor(d / 60)}m`
  if (d < 86400) return `${Math.floor(d / 3600)}h`
  if (d < 604800) return `${Math.floor(d / 86400)}d`
  return new Date(ts * 1000).toLocaleDateString()
}

export default function SessionDrawer() {
  const open = useStore((s) => s.drawerOpen)
  const setDrawer = useStore((s) => s.setDrawer)
  const sessions = useStore((s) => s.sessions)
  const sessionKey = useStore((s) => s.sessionKey)
  const openSession = useStore((s) => s.openSession)
  const newSession = useStore((s) => s.newSession)
  const deleteSession = useStore((s) => s.deleteSession)

  if (!open) return null

  const remove = (id: string, title: string) => {
    if (window.confirm(`Delete "${title || 'Untitled'}"?`)) void deleteSession(id)
  }

  return (
    <div className="drawer-backdrop" onClick={() => setDrawer(false)}>
      <aside className="drawer" onClick={(e) => e.stopPropagation()}>
        <div className="drawer-head">
          <h2 className="drawer-title">Sessions</h2>
          <button className="btn btn-primary btn-sm" onClick={() => void newSession()}>New</button>
        </div>
        <div className="drawer-list">
          {sessions.length === 0 && <div className="drawer-empty">No sessions yet</div>}
          {sessions.map((s) => (
            <div
              key={s.id}
              className={`session-item ${s.id === sessionKey ? 'is-active' : ''}`}
              onClick={() => void openSession(s.id)}
            >
              <div className="session-main">
                <div className="session-title">{s.title || 'Untitled'}</div>
                <div className="session-preview">{s.preview || s.source || ''}</div>
              </div>
              <div className="session-side">
                <span className="session-time">{timeAgo(s.started_at)}</span>
                <button
                  className="icon-btn icon-btn-danger"
                  aria-label="Delete"
                  onClick={(e) => {
                    e.stopPropagation()
                    remove(s.id, s.title || '')
                  }}
                >
                  ✕
                </button>
              </div>
            </div>
          ))}
        </div>
      </aside>
    </div>
  )
}
