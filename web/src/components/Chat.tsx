import { useStore } from '../store/store'
import type { ThemePref } from '../types'
import MessageList from './MessageList'
import Composer from './Composer'
import SessionDrawer from './SessionDrawer'
import ClarifySheet from './ClarifySheet'
import ApprovalCard from './ApprovalCard'
import Toasts from './Toasts'

const CONN_LABEL: Record<string, string> = {
  connected: 'Connected',
  connecting: 'Connecting',
  reconnecting: 'Reconnecting',
  offline: 'Offline',
}

const THEME_ORDER: ThemePref[] = ['system', 'light', 'dark']
const THEME_ICON: Record<ThemePref, string> = { system: '◐', light: '☀', dark: '☾' }

export default function Chat() {
  const conn = useStore((s) => s.conn)
  const sessions = useStore((s) => s.sessions)
  const sessionKey = useStore((s) => s.sessionKey)
  const setDrawer = useStore((s) => s.setDrawer)
  const logout = useStore((s) => s.logout)
  const theme = useStore((s) => s.theme)
  const setTheme = useStore((s) => s.setTheme)

  const title = sessions.find((s) => s.id === sessionKey)?.title || 'New chat'

  const cycleTheme = () => {
    const i = THEME_ORDER.indexOf(theme)
    setTheme(THEME_ORDER[(i + 1) % THEME_ORDER.length])
  }

  return (
    <div className="shell">
      <header className="topbar">
        <button className="icon-btn" aria-label="Sessions" onClick={() => setDrawer(true)}>
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <path d="M4 6h16M4 12h16M4 18h16" />
          </svg>
        </button>
        <div className="topbar-title">
          <span className="topbar-title-text">{title}</span>
          <span className={`pill pill-${conn}`}>{CONN_LABEL[conn]}</span>
        </div>
        <button className="icon-btn" aria-label="Theme" title={theme} onClick={cycleTheme}>
          {THEME_ICON[theme]}
        </button>
        <button className="icon-btn" aria-label="Log out" onClick={() => void logout()}>
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9" />
          </svg>
        </button>
      </header>

      <main className="chat-body">
        <MessageList />
        <ApprovalCard />
      </main>

      <Composer />
      <SessionDrawer />
      <ClarifySheet />
      <Toasts />
    </div>
  )
}
