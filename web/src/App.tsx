import { useEffect } from 'react'
import { useStore } from './store/store'
import { applyTheme } from './lib/theme'
import Login from './components/Login'
import Chat from './components/Chat'

export default function App() {
  const booting = useStore((s) => s.booting)
  const authed = useStore((s) => s.authed)
  const theme = useStore((s) => s.theme)
  const boot = useStore((s) => s.boot)

  useEffect(() => {
    void boot()
  }, [boot])

  useEffect(() => {
    applyTheme(theme)
    if (theme !== 'system') return
    const mq = window.matchMedia('(prefers-color-scheme: dark)')
    const onChange = () => applyTheme('system')
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  }, [theme])

  if (booting) {
    return (
      <div className="splash">
        <div className="splash-mark">H</div>
        <div className="splash-spinner" />
      </div>
    )
  }
  if (!authed) return <Login />
  return <Chat />
}
