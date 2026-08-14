import { useState, type FormEvent } from 'react'
import { useStore } from '../store/store'
import { ApiError } from '../lib/api'

export default function Login() {
  const login = useStore((s) => s.login)
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    if (busy) return
    setBusy(true)
    setError('')
    try {
      await login(username.trim(), password)
    } catch (err) {
      setError(err instanceof ApiError && err.status === 401 ? 'Invalid username or password' : 'Sign-in failed')
      setBusy(false)
    }
  }

  return (
    <div className="login">
      <form className="login-card" onSubmit={submit}>
        <div className="login-mark">H</div>
        <h1 className="login-title">Hermes</h1>
        <label className="field">
          <span className="field-label">Username</span>
          <input
            className="field-input"
            type="text"
            value={username}
            autoCapitalize="none"
            autoCorrect="off"
            autoComplete="username"
            onChange={(e) => setUsername(e.target.value)}
            required
          />
        </label>
        <label className="field">
          <span className="field-label">Password</span>
          <input
            className="field-input"
            type="password"
            value={password}
            autoComplete="current-password"
            onChange={(e) => setPassword(e.target.value)}
            required
          />
        </label>
        {error && <div className="form-error" role="alert">{error}</div>}
        <button className="btn btn-primary btn-block" type="submit" disabled={busy}>
          {busy ? 'Signing in…' : 'Sign in'}
        </button>
      </form>
    </div>
  )
}
