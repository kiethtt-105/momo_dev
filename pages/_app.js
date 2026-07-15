// pages/_app.js
//
// Gate đăng nhập TOÀN CỤC: mọi trang (/, /tao-giao-dich,
// /quan-ly-giao-dich...) đều bị chặn bởi component này cho đến khi
// xác nhận có session admin hợp lệ. Không còn kiểu "chỉ trang quản
// lý mới hỏi mật khẩu" — vào domain là hỏi pass ngay.
//
// Cách hoạt động:
// 1. Mount -> gọi GET /api/admin/session để kiểm tra cookie hiện có.
// 2. Nếu chưa có/session hết hạn -> hiện form nhập mật khẩu, không
//    render bất kỳ trang nào phía sau.
// 3. Đăng nhập đúng -> POST /api/admin/login (route có sẵn) set
//    cookie -> chuyển status sang 'authed' -> render trang thật.

import { useEffect, useState } from 'react'
import '../styles/globals.css'

function LoginGate({ children }) {
  const [status, setStatus] = useState('checking') // checking | authed | guest
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  async function checkSession() {
    try {
      const res = await fetch('/api/admin/session', { credentials: 'include' })
      setStatus(res.ok ? 'authed' : 'guest')
    } catch {
      setStatus('guest')
    }
  }

  useEffect(() => {
    checkSession()
  }, [])

  async function handleSubmit(e) {
    e.preventDefault()
    setError('')
    setLoading(true)
    try {
      const res = await fetch('/api/admin/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ password }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) {
        setError(data.error || 'Sai mật khẩu, thử lại')
        return
      }
      setStatus('authed')
    } catch {
      setError('Lỗi kết nối, thử lại sau')
    } finally {
      setLoading(false)
    }
  }

  if (status === 'checking') {
    return (
      <main className="min-h-screen flex items-center justify-center bg-neutral-50">
        <p className="text-neutral-400 text-sm">Đang kiểm tra phiên đăng nhập...</p>
      </main>
    )
  }

  if (status === 'guest') {
    return (
      <main className="min-h-screen flex items-center justify-center px-4 bg-neutral-50">
        <form
          onSubmit={handleSubmit}
          className="w-full max-w-xs bg-white rounded-2xl border border-neutral-200 p-6"
        >
          <div className="w-12 h-12 rounded-xl bg-momo mx-auto mb-4 flex items-center justify-center text-white font-extrabold text-lg">
            M
          </div>
          <h1 className="text-lg font-bold text-neutral-900 text-center mb-1">
            Đăng nhập quản trị
          </h1>
          <p className="text-neutral-500 text-sm text-center mb-5">
            Nhập mật khẩu admin để vào trang
          </p>

          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="Mật khẩu"
            autoFocus
            className="w-full rounded-xl border border-neutral-200 px-4 py-3 mb-3 focus:outline-none focus:ring-2 focus:ring-momo/40 focus:border-momo"
            required
          />

          {error && (
            <p className="text-sm text-red-600 bg-red-50 rounded-lg px-3 py-2 mb-3">{error}</p>
          )}

          <button
            type="submit"
            disabled={loading}
            className="w-full py-3 rounded-xl bg-momo text-white font-semibold hover:bg-momo-dark transition disabled:opacity-50"
          >
            {loading ? 'Đang kiểm tra...' : 'Đăng nhập'}
          </button>
        </form>
      </main>
    )
  }

  return children
}

export default function App({ Component, pageProps }) {
  return (
    <LoginGate>
      <Component {...pageProps} />
    </LoginGate>
  )
}