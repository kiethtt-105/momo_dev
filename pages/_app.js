// pages/_app.js
//
// Gate đăng nhập TOÀN CỤC: mọi trang (/, /tao-giao-dich,
// /quan-ly-giao-dich...) đều bị chặn bởi component này cho đến khi
// xác nhận có session admin hợp lệ. Không còn kiểu "chỉ trang quản
// lý mới hỏi mật khẩu" — vào domain là hỏi pass ngay.
//
// [MỚI] Gate này giờ còn quản lý luôn trạng thái PAUSED, để sửa 2 lỗi
// logic cũ:
//   1. Session còn hạn nhưng vẫn bị bắt nhập lại mật khẩu khi hệ thống
//      đang paused — do trước đây /api/admin/session và /api/admin/login
//      bị middleware.js chặn 503 chung với các API khác lúc paused. Phải
//      thêm 2 route này vào ALWAYS_ALLOWED trong middleware.js (xem ghi
//      chú ở system-pause.js) thì phần dưới đây mới thật sự hết bug.
//   2. Khi đã có session hợp lệ mà hệ thống đang paused: KHÔNG hiện lại
//      màn login (vô lý vì đang đăng nhập rồi), cũng KHÔNG hiện nguyên
//      trang chính — mà hiện màn tối giản, ẩn hết mọi thông tin/nghiệp
//      vụ, chỉ để lại 1 switch bật/tắt. Bấm bật -> gọi thẳng
//      /api/admin/system-pause bằng session (không cần biết
//      NEXT_PUBLIC_SYSTEM_PAUSE_KEY).
//
// Cách hoạt động:
// 1. Mount -> gọi GET /api/admin/session để kiểm tra cookie hiện có.
// 2. Nếu chưa có/session hết hạn -> hiện form nhập mật khẩu, không
//    render bất kỳ trang nào phía sau.
// 3. Đăng nhập đúng -> POST /api/admin/login (route có sẵn) set
//    cookie -> chuyển status sang 'authed'.
// 4. Có session hợp lệ -> hỏi tiếp /api/admin/system-pause (session tự
//    xác thực, không cần key) để biết có đang paused không:
//    - paused=true  -> hiện màn tối giản (chỉ switch bật lại)
//    - paused=false -> render trang thật (children)
//    Poll lại mỗi 15s để tự cập nhật nếu bị pause từ nơi khác (tab khác,
//    thiết bị khác) mà không cần F5.
// 5. Bật pause thành công -> server (system-pause.js) đã logout session
//    thiết bị này -> gate tự chuyển về màn login luôn, không đợi lần
//    check session định kỳ tiếp theo mới phát hiện ra.

import { useEffect, useState, useCallback } from 'react'
import { useRouter } from 'next/router'
import '../styles/globals.css'
import { Analytics } from '@vercel/analytics/react'

// Các route KHÔNG cần đăng nhập admin — link gửi trực tiếp cho khách
// (vd: /thanh-toan?orderId=xxx qua Zalo, tin nhắn...).
const PUBLIC_ROUTES = ['/thanh-toan']

// Khoảng thời gian tự kiểm tra lại trạng thái paused khi đã đăng nhập —
// để nếu bị dừng từ nơi khác (tab khác, thiết bị khác), gate tự cập nhật.
const PAUSE_POLL_INTERVAL_MS = 15000

function Spinner({ className = '' }) {
  return (
    <span
      className={`inline-block rounded-full border-2 border-current/25 border-t-current animate-spin [animation-duration:0.7s] ${className}`}
      aria-hidden="true"
    />
  )
}

// Switch bật/tắt hệ thống — thay cho nút dạng pill trước đây. checked =
// "đang hoạt động" (ON). Trong màn paused, checked luôn = false, bấm vào
// để chuyển sang true (bật lại).
function PowerToggle({ checked, busy, onChange }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={busy}
      onClick={() => onChange(!checked)}
      className={`relative inline-flex h-9 w-16 shrink-0 items-center rounded-full transition-colors duration-200 disabled:opacity-50 ${
        checked ? 'bg-emerald-500' : 'bg-stone-700'
      }`}
    >
      <span
        className={`inline-flex h-7 w-7 translate-x-1 items-center justify-center rounded-full bg-white shadow-md transition-transform duration-200 ${
          checked ? 'translate-x-8' : 'translate-x-1'
        }`}
      >
        {busy && <Spinner className="w-3.5 h-3.5 text-stone-400" />}
      </span>
    </button>
  )
}

// Màn hiện ra khi ĐÃ đăng nhập nhưng hệ thống đang paused — cố tình tối
// giản, không lộ bất kỳ thông tin nghiệp vụ nào (đơn hàng, cửa hàng...),
// chỉ có lý do/thời điểm paused (nếu có) và switch để bật lại.
function PausedGate({ meta, busy, onResume }) {
  return (
    <main className="min-h-screen bg-stone-950 flex items-center justify-center px-4">
      <div className="w-full max-w-xs text-center">
        <h1 className="text-white text-lg font-bold mb-1">Hệ thống đang tạm dừng</h1>
        {meta?.pausedAt ? (
          <p className="text-stone-500 text-xs mb-10">
            Tạm dừng lúc {new Date(meta.pausedAt).toLocaleString('vi-VN')}
            {meta.reason ? ` · ${meta.reason}` : ''}
          </p>
        ) : (
          <div className="mb-10" />
        )}
        <div className="flex flex-col items-center gap-3">
          <PowerToggle checked={false} busy={busy} onChange={() => onResume()} />
          <span className="text-stone-500 text-xs">
            {busy ? 'Đang bật lại...' : 'Bấm để bật lại hệ thống'}
          </span>
        </div>
      </div>
    </main>
  )
}

function LoginGate({ children }) {
  const router = useRouter()
  const isPublicRoute = PUBLIC_ROUTES.includes(router.pathname)

  const [status, setStatus] = useState('checking') // checking | authed | guest
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  // ── Pause state (chỉ quan tâm SAU KHI đã authed) ──
  const [paused, setPaused] = useState(null) // null = chưa biết
  const [pauseMeta, setPauseMeta] = useState(null)
  const [pauseBusy, setPauseBusy] = useState(false)

  const checkSession = useCallback(async () => {
    try {
      const res = await fetch('/api/admin/session', { credentials: 'include' })
      setStatus(res.ok ? 'authed' : 'guest')
    } catch {
      setStatus('guest')
    }
  }, [])

  // Dùng session hiện có để hỏi trạng thái paused — KHÔNG cần
  // NEXT_PUBLIC_SYSTEM_PAUSE_KEY, vì authorize() trong system-pause.js
  // tự fallback sang session khi thiếu/sai key.
  const checkPause = useCallback(async () => {
    try {
      const res = await fetch('/api/admin/system-pause', { credentials: 'include' })
      const data = await res.json().catch(() => null)
      if (data && typeof data.paused === 'boolean') {
        setPaused(data.paused)
        setPauseMeta(data)
      }
    } catch {
      // lỗi mạng thoáng qua -> giữ nguyên giá trị paused cũ, không đoán mò
    }
  }, [])

  useEffect(() => {
    if (isPublicRoute) return
    checkSession()
  }, [isPublicRoute, checkSession])

  useEffect(() => {
    if (isPublicRoute || status !== 'authed') return
    checkPause()
    const id = setInterval(checkPause, PAUSE_POLL_INTERVAL_MS)
    return () => clearInterval(id)
  }, [isPublicRoute, status, checkPause])

  // Route public: render thẳng, bỏ qua toàn bộ gate.
  if (isPublicRoute) {
    return children
  }

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
        setError(data.error || 'Sai mật khẩu')
        return
      }
      setPassword('')
      setPaused(null) // reset, để useEffect phía trên check lại từ đầu
      setStatus('authed')
    } catch {
      setError('Lỗi kết nối, thử lại sau')
    } finally {
      setLoading(false)
    }
  }

  async function handleResume() {
    setPauseBusy(true)
    try {
      const res = await fetch('/api/admin/system-pause', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ action: 'off' }),
      })
      const data = await res.json().catch(() => ({}))
      if (res.ok) {
        setPaused(!!data.paused)
        setPauseMeta(data)
      }
    } catch {
      // giữ nguyên màn paused, admin có thể bấm lại
    } finally {
      setPauseBusy(false)
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
            IPA
          </div>
          <h1 className="text-lg font-bold text-neutral-900 text-center mb-1">
            Đăng nhập
          </h1>
          <p className="text-neutral-500 text-sm text-center mb-5">
            NHập MẬT KHẨU để tiếp tục
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

  // status === 'authed' từ đây trở xuống.

  // Chưa biết trạng thái paused (đang hỏi lần đầu) -> giữ màn chờ, tránh
  // nháy trang chính rồi lại nháy sang màn paused ngay sau đó.
  if (paused === null) {
    return (
      <main className="min-h-screen flex items-center justify-center bg-neutral-50">
        <p className="text-neutral-400 text-sm">Đang kiểm tra trạng thái hệ thống...</p>
      </main>
    )
  }

  if (paused) {
    return <PausedGate meta={pauseMeta} busy={pauseBusy} onResume={handleResume} />
  }

  return children
}

export default function App({ Component, pageProps }) {
  return (
    <LoginGate>
      <Component {...pageProps} />
      <Analytics />
    </LoginGate>
  )
}