// pages/index.js

import { useCallback, useEffect, useRef, useState } from 'react'
import Head from 'next/head'
import jsQR from 'jsqr'

// Mã khoá tạm dừng hệ thống 
const SYSTEM_PAUSE_KEY = process.env.NEXT_PUBLIC_SYSTEM_PAUSE_KEY

// ─── Styles ─────────────────────────────────────────────────────────────────
const TICKET = 'bg-white rounded-2xl border border-stone-200/80 shadow-[0_2px_8px_-4px_rgba(33,26,29,0.06),0_20px_48px_-28px_rgba(33,26,29,0.22)]'
const INPUT = 'w-full rounded-xl border border-stone-200 px-4 py-3 bg-white focus:outline-none focus:ring-4 focus:ring-momo/15 focus:border-momo transition-all duration-200'

// ─── Tabs tạo giao dịch ──────────────────────────────────────────────────────
const TABS = [
  { key: 'p2p', label: 'Tạo mã QR' },
  { key: 'scan', label: 'Quét mã khách' },
]

// ─── Trạng thái giao dịch ─────────────────────────────────────────────────────
const STATUS_STYLE = {
  PENDING: 'bg-amber-50 text-amber-700 ring-amber-600/10',
  PAID: 'bg-emerald-50 text-emerald-700 ring-emerald-600/10',
  FAILED: 'bg-red-50 text-red-700 ring-red-600/10',
  EXPIRED: 'bg-stone-100 text-stone-500 ring-stone-500/10',
}

// ─── Trạng thái hiển thị ─────────────────────────────────────────────────────
const STATUS_TEXT = {
  PENDING: 'Chờ thanh toán',
  PAID: 'Đã thanh toán',
  FAILED: 'Thất bại',
  EXPIRED: 'Hết hạn',
}

// ─── TTL đơn (10 phút) ─────────────────────────────────────────────────────
const ORDER_TTL_SECONDS = 10 * 60
// ─── Thời gian grace (2 phút) ───────────────────────────────────────────────
const POLL_GRACE_MS = 2 * 60 * 1000
// ─── Cache keys ─────────────────────────────────────────────────────────────
const CACHE_KEY_P2P = 'momo_tao_gd_p2p_v1'
const CACHE_KEY_SCAN = 'momo_tao_gd_scan_v1'
const CACHE_KEY_TAB = 'momo_tao_gd_tab_v1'
const CACHE_KEY_STORES = 'momo_tao_gd_stores_v1'

// ─── Helpers ─────────────────────────────────────────────────────────────────
function loadCache(key, fallback) {
  if (typeof window === 'undefined') return fallback
  try {
    const raw = window.sessionStorage.getItem(key)
    return raw ? JSON.parse(raw) : fallback
  } catch {
    return fallback
  }
}

// Lưu cache vào sessionStorage, bỏ qua nếu lỗi 
function saveCache(key, value) {
  if (typeof window === 'undefined') return
  try { window.sessionStorage.setItem(key, JSON.stringify(value)) } catch { /* bỏ qua */ }
}

// Lấy danh sách đơn từ cache, đảm bảo luôn trả về mảng
function loadOrderCache(key) {
  const list = loadCache(key, [])
  return Array.isArray(list) ? list : []
}

// Lưu danh sách đơn vào cache, bỏ qua nếu lỗi
const saveOrderCache = saveCache

// Format số tiền 
function formatVND(n) {
  const num = Number(n)
  if (Number.isNaN(num)) return n
  return num.toLocaleString('vi-VN') + ' đ'
}

// Format countdown 
function formatCountdown(sec) {
  const s = Math.max(0, sec)
  const m = Math.floor(s / 60)
  const r = s % 60
  return `${m}:${String(r).padStart(2, '0')}`
}

// Hook countdown, trả về { secondsLeft, isExpired }
function useCountdown(expiresAt) {
  const getRemaining = () => {
    if (!expiresAt) return ORDER_TTL_SECONDS
    return Math.round((new Date(expiresAt).getTime() - Date.now()) / 1000)
  }
  const [secondsLeft, setSecondsLeft] = useState(getRemaining)
  useEffect(() => {
    if (!expiresAt) return
    setSecondsLeft(getRemaining())
    const id = setInterval(() => setSecondsLeft(getRemaining()), 1000)
    return () => clearInterval(id)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [expiresAt])
  return { secondsLeft: Math.max(0, secondsLeft), isExpired: secondsLeft <= 0 }
}

// ─── Icons ───────────────────────────────────────────────────────────────────
function Spinner({ className = '' }) {
  return (
    <span
      className={`inline-block rounded-full border-2 border-white/25 border-t-white animate-spin [animation-duration:0.7s] ${className}`}
      aria-hidden="true"
    />
  )
}

// Icon +, dùng cho nút "Thêm đơn"
function IconPlus(props) {
  return (
    <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2.25" strokeLinecap="round" {...props}>
      <path d="M12 5v14M5 12h14" />
    </svg>
  )
}

// Icon nút nguồn, dùng cho trạng thái hệ thống
function IconPower(props) {
  return (
    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2.25" strokeLinecap="round" strokeLinejoin="round" {...props}>
      <path d="M12 2v8" />
      <path d="M18.36 6.64a9 9 0 11-12.73 0" />
    </svg>
  )
}

// Icon cảnh báo tam giác, dùng cho modal xác nhận và toast
function IconAlertTriangle(props) {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...props}>
      <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
      <line x1="12" y1="9" x2="12" y2="13" />
      <line x1="12" y1="17" x2="12.01" y2="17" />
    </svg>
  )
}

// Icon link ngoài, dùng cho nút mở trang thanh toán
const IconExternalLink = (props) => (
  <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...props}>
    <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
    <polyline points="15 3 21 3 21 9" />
    <line x1="10" y1="14" x2="21" y2="3" />
  </svg>
)

// Icon copy, dùng cho nút chép liên kết
const IconCopy = (props) => (
  <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...props}>
    <rect x="9" y="9" width="13" height="13" rx="2" />
    <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
  </svg>
)

// Icon check, dùng cho nút chép liên kết khi đã chép thành công
const IconCheck = (props) => (
  <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...props}>
    <polyline points="20 6 9 17 4 12" />
  </svg>
)

// Icon QR, dùng cho tab "Tạo mã QR"
function IconQr(props) {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...props}>
      <rect x="3" y="3" width="7" height="7" rx="1" />
      <rect x="14" y="3" width="7" height="7" rx="1" />
      <rect x="3" y="14" width="7" height="7" rx="1" />
      <path d="M14 14h3v3h-3zM20 14v3M14 20h3M20 20v.01" />
    </svg>
  )
}

// Icon scan, dùng cho tab "Quét mã khách"
function IconScanLine(props) {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...props}>
      <path d="M3 7V5a2 2 0 0 1 2-2h2M17 3h2a2 2 0 0 1 2 2v2M21 17v2a2 2 0 0 1-2 2h-2M7 21H5a2 2 0 0 1-2-2v-2" />
      <line x1="3" y1="12" x2="21" y2="12" />
    </svg>
  )
}

// Icon ticket, dùng cho trạng thái trống (empty state)
function IconTicket(props) {
  return (
    <svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" {...props}>
      <path d="M3 8.5A1.5 1.5 0 0 1 4.5 7h15A1.5 1.5 0 0 1 21 8.5v1.75a1.75 1.75 0 0 0 0 3.5v1.75A1.5 1.5 0 0 1 19.5 17h-15A1.5 1.5 0 0 1 3 15.5v-1.75a1.75 1.75 0 0 0 0-3.5V8.5Z" />
      <path d="M9 7.5v9" strokeDasharray="1.5 3" />
    </svg>
  )
}

// ─── UI dùng chung ────────────────────────────────────────────────────────────
function ConfirmModal({ open, title, message, description, confirmLabel = 'Xác nhận', danger, busy, onConfirm, onCancel }) {
  if (!open) return null
  const body = message || description
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-[#211D24]/60 backdrop-blur-sm px-4"
      onClick={onCancel}
    >
      <div
        className="w-full max-w-sm bg-white rounded-3xl p-6 shadow-2xl shadow-black/30 ring-1 ring-black/5"
        onClick={(e) => e.stopPropagation()}
      >
        <div className={`w-11 h-11 rounded-2xl flex items-center justify-center mb-4 ${danger ? 'bg-rose-50 text-rose-600' : 'bg-momo/10 text-momo'}`}>
          <IconAlertTriangle />
        </div>
        <h2 className="text-base font-bold text-stone-900 mb-1.5">{title}</h2>
        {body && <p className="text-sm text-stone-500 leading-relaxed mb-6">{body}</p>}
        <div className="flex gap-2">
          <button
            onClick={onCancel}
            disabled={busy}
            className="flex-1 py-2.5 rounded-xl bg-stone-100 text-stone-700 text-sm font-semibold hover:bg-stone-200 transition disabled:opacity-50"
          >
            Huỷ
          </button>
          <button
            onClick={onConfirm}
            disabled={busy}
            className={`flex-1 py-2.5 rounded-xl text-white text-sm font-semibold transition disabled:opacity-50 flex items-center justify-center gap-2 ${
              danger ? 'bg-rose-600 hover:bg-rose-700' : 'bg-momo hover:bg-momo-dark'
            }`}
          >
            {busy && <Spinner className="w-3.5 h-3.5 border-[2px]" />}
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  )
}

// ─── Toast thông báo ─────────────────────────────────────────────────────────
function Toast({ message, onClose }) {
  useEffect(() => {
    if (!message) return
    const t = setTimeout(onClose, 4000)
    return () => clearTimeout(t)
  }, [message, onClose])
  if (!message) return null
  return (
    <div className="fixed bottom-5 left-1/2 -translate-x-1/2 z-50 max-w-sm w-[calc(100%-2rem)]">
      <div className="flex items-center gap-2.5 rounded-2xl bg-[#211D24] text-white text-sm px-4 py-3 shadow-2xl shadow-black/30">
        <IconAlertTriangle className="text-rose-400 shrink-0" />
        <span className="min-w-0">{message}</span>
      </div>
    </div>
  )
}

// ─── Row hiển thị liên kết thanh toán + nút mở + nút chép ───────────────
function IconLinkRow({ label, value, href }) {
  const [copied, setCopied] = useState(false)
  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(String(value))
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch { /* im lặng */ }
  }
  return (
    <div className="w-full flex items-center justify-between gap-3 rounded-xl border border-stone-200 px-3 py-2">
      <span className="text-[12px] text-stone-500 truncate">{label}</span>
      <div className="flex items-center gap-1 shrink-0">
        <a href={href} target="_blank" rel="noreferrer" title="Mở liên kết thanh toán"
          className="w-8 h-8 flex items-center justify-center rounded-lg text-momo hover:bg-momo/10 transition">
          <IconExternalLink />
        </a>
        <button type="button" onClick={handleCopy} title="Chép liên kết"
          className={`w-8 h-8 flex items-center justify-center rounded-lg transition ${copied ? 'text-emerald-600 bg-emerald-50' : 'text-stone-500 hover:bg-stone-100'}`}>
          {copied ? <IconCheck /> : <IconCopy />}
        </button>
      </div>
    </div>
  )
}

// ─── Trạng thái hệ thống (header) ─────────────────────────────────────────────
function SystemStatusChip({ busy, onPause }) {
  return (
    <button
      onClick={onPause}
      disabled={busy}
      title="Dừng toàn bộ hệ thống"
      className="group flex items-center gap-2 rounded-full bg-white/10 hover:bg-rose-500/20 pl-3 pr-3.5 py-2 text-xs font-semibold text-white/90 hover:text-rose-200 transition disabled:opacity-50 ring-1 ring-inset ring-white/15"
    >
      <span className="relative flex w-2 h-2">
        <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75" />
        <span className="relative inline-flex rounded-full w-2 h-2 bg-emerald-400" />
      </span>
      Đang hoạt động
      <IconPower className="text-white/40 group-hover:text-rose-300 transition-colors" />
    </button>
  )
}

// ─── Màn hình tạm dừng hệ thống ─────────────────────────────────────────────
function PausedScreen({ meta, onResume, busy }) {
  return (
    <>
      <Head>
        <title>Hệ thống đang tạm dừng · Momo Dev</title>
      </Head>
      <main className="min-h-screen bg-[#1B181F] flex items-center justify-center px-4 relative overflow-hidden">
        <div className="pointer-events-none absolute -top-24 -left-24 w-96 h-96 rounded-full bg-rose-500/10 blur-3xl" />
        <div className="pointer-events-none absolute bottom-0 -right-24 w-96 h-96 rounded-full bg-momo/10 blur-3xl" />
        <div className="relative w-full max-w-sm text-center">
          <div className="w-16 h-16 rounded-3xl bg-rose-500/10 mx-auto mb-6 flex items-center justify-center">
            <span className="w-3 h-3 rounded-full bg-rose-500 animate-pulse" />
          </div>
          <h1 className="text-xl font-extrabold text-white mb-2">Hệ thống đang tạm dừng</h1>
          <p className="text-stone-400 text-sm leading-relaxed mb-1">
            Toàn bộ API đang bị chặn — không tạo đơn, kiểm tra giao dịch hay xem lịch sử được cho tới khi bật lại.
          </p>
          {meta?.pausedAt ? (
            <p className="text-stone-600 text-xs mb-8">
              Tạm dừng lúc {new Date(meta.pausedAt).toLocaleString('vi-VN')}
              {meta.reason ? ` · ${meta.reason}` : ''}
            </p>
          ) : (
            <div className="mb-8" />
          )}
          <button
            onClick={onResume}
            disabled={busy}
            className="w-full py-3.5 rounded-xl bg-emerald-500 text-white text-sm font-semibold hover:bg-emerald-600 active:scale-[0.98] transition disabled:opacity-50 flex items-center justify-center gap-2 shadow-[0_10px_24px_-10px_rgba(16,185,129,0.5)]"
          >
            {busy && <Spinner className="w-4 h-4 border-[2.5px]" />}
            {busy ? 'Đang bật lại...' : 'Bật lại hệ thống'}
          </button>
        </div>
      </main>
    </>
  )
}

// ─── Order detail modal ───────────────────────────────────────────────────────
function OrderDetailModal({ open, onClose, orderId }) {
  const [loading, setLoading] = useState(false)
  const [data, setData] = useState(null)
  const [error, setError] = useState('')

  useEffect(() => {
    if (!open || !orderId) return
    let cancelled = false
    setLoading(true); setError(''); setData(null)
    fetch(`/api/momo/query?orderId=${encodeURIComponent(orderId)}`, { credentials: 'include' })
      .then(async (res) => {
        if (res.status === 401) { window.location.reload(); return }
        const json = await res.json()
        if (cancelled) return
        if (!res.ok) throw new Error(json.error || 'Không tải được chi tiết')
        setData(json)
      })
      .catch((e) => !cancelled && setError(e.message || 'Không tải được chi tiết'))
      .finally(() => !cancelled && setLoading(false))
    return () => { cancelled = true }
  }, [open, orderId])

  if (!open) return null
  const rows = data ? [
    ['Mã đơn', data.orderId],
    ['Mã giao dịch MoMo', data.transId || '—'],
    ['Số tiền', formatVND(data.amount)],
    ['Phương thức', data.payType || '—'],
    ['Trạng thái', data.isPaid ? 'Đã thanh toán' : data.isStillPending ? 'Đang xử lý' : 'Thất bại'],
    ['Thời gian MoMo xử lý', data.responseTime ? new Date(Number(data.responseTime)).toLocaleString('vi-VN') : '—'],
    ['Thông báo từ MoMo', data.message || '—'],
  ] : []

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-[#211D24]/60 backdrop-blur-sm px-4" onClick={onClose}>
      <div className="bg-white rounded-2xl shadow-2xl shadow-black/30 ring-1 ring-black/5 max-w-sm w-full p-5" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-base font-bold text-stone-900">Chi tiết giao dịch</h3>
          <button type="button" onClick={onClose} className="text-stone-400 hover:text-stone-600 w-6 h-6 flex items-center justify-center">✕</button>
        </div>
        {loading && <p className="text-sm text-stone-500 text-center py-6">Đang hỏi MoMo...</p>}
        {error && <p className="text-sm text-red-600 bg-red-50 rounded-lg px-3 py-2">{error}</p>}
        {!loading && !error && data && (
          <div className="flex flex-col gap-2.5">
            {rows.map(([label, value]) => (
              <div key={label} className="flex items-start justify-between gap-3 text-sm">
                <span className="text-stone-500 shrink-0">{label}</span>
                <span className="font-mono text-stone-900 text-right break-all">{value}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

// ─── Countdown ring ───────────────────────────────────────────────────────────
function CountdownRing({ secondsLeft, isExpired }) {
  const R = 15
  const C = 2 * Math.PI * R
  const pct = isExpired ? 0 : Math.max(0, Math.min(1, secondsLeft / ORDER_TTL_SECONDS))
  const color = isExpired ? '#D4D4D4' : secondsLeft <= 60 ? '#DC2626' : secondsLeft <= 180 ? '#D97706' : 'var(--momo-ring, #A50064)'
  return (
    <div className="relative w-10 h-10 shrink-0">
      <svg viewBox="0 0 36 36" className="w-10 h-10 -rotate-90">
        <circle cx="18" cy="18" r={R} fill="none" stroke="#F1F1F1" strokeWidth="3" />
        <circle cx="18" cy="18" r={R} fill="none" stroke={color} strokeWidth="3" strokeLinecap="round"
          strokeDasharray={C} strokeDashoffset={C * (1 - pct)}
          style={{ transition: 'stroke-dashoffset 1s linear, stroke 0.3s' }} />
      </svg>
      <span className="absolute inset-0 flex items-center justify-center text-[10px] font-mono font-semibold text-stone-700">
        {isExpired ? '⏱' : formatCountdown(secondsLeft)}
      </span>
    </div>
  )
}

// ─── Ticket rỗng (empty state) ─────────────────────────────────────────────────
function EmptyTicketState({ message }) {
  return (
    <div className="flex flex-col items-center justify-center text-center gap-3 rounded-2xl border-2 border-dashed border-stone-200 py-14 px-6 min-h-[220px]">
      <IconTicket className="text-stone-300" />
      <p className="text-sm text-stone-400 max-w-[240px] leading-relaxed">{message}</p>
    </div>
  )
}

// ─── Workspace ───────────────────────────────────────────────────────────────
function TicketWorkspace({ left, right }) {
  return (
    <div className={`${TICKET} overflow-hidden`}>
      <div className="grid grid-cols-1 lg:grid-cols-[380px_0_1fr]">
        <div className="p-5 sm:p-6">{left}</div>
        <div
          className="hidden lg:block my-6"
          style={{ borderLeft: '2px dashed #E7E0D0', width: 0 }}
          aria-hidden="true"
        />
        <div className="p-5 sm:p-6 border-t-2 border-dashed border-stone-200 lg:border-t-0">{right}</div>
      </div>
    </div>
  )
}

// ─── P2P TransactionRow ───────────────────────────────────────────────────────
function TransactionRow({ tx, onRemove, onUpdate }) {
  const [status, setStatus] = useState(tx.status || 'PENDING')
  const [checking, setChecking] = useState(false)
  const [checkedOnce, setCheckedOnce] = useState(!!tx.checkedOnce)
  const [confirmRemove, setConfirmRemove] = useState(false)
  const [showDetail, setShowDetail] = useState(false)
  const { secondsLeft, isExpired } = useCountdown(tx.expiresAt)

  const thanhToanUrl = typeof window !== 'undefined'
    ? `${window.location.origin}/thanh-toan?orderId=${encodeURIComponent(tx.orderId)}`
    : `/thanh-toan?orderId=${encodeURIComponent(tx.orderId)}`

  useEffect(() => {
    onUpdate(tx.orderId, { status, checkedOnce })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status, checkedOnce])

  async function handleCheck() {
    setChecking(true)
    try {
      const res = await fetch(`/api/momo/query?orderId=${encodeURIComponent(tx.orderId)}`, { credentials: 'include' })
      if (res.status === 401) { window.location.reload(); return }
      const data = await res.json()
      if (res.ok) {
        if (data.orderStatus) setStatus(data.orderStatus)
        else if (data.isPaid) setStatus('PAID')
        else if (!data.isStillPending) setStatus('FAILED')
        setCheckedOnce(true)
      }
    } catch { /* giữ nguyên */ } finally { setChecking(false) }
  }

  // ĐÃ BỎ auto-check lúc mount và poll backoff tự động theo dõi trạng
  // thái (trước đây tự gọi MoMo ngay khi vào trang, rồi lặp lại mỗi
  // 15–60s cho tới khi có kết quả cuối). Giờ CHỈ kiểm tra khi admin chủ
  // động bấm nút "Kiểm tra ngay" bên dưới — mỗi lần kiểm tra là 1 lượt
  // gọi thật tới MoMo (queryMoMoTransaction), không nên tự động lặp lại
  // liên tục khi dashboard mở nhiều đơn PENDING cùng lúc. IPN (ipn.js)
  // vẫn là nguồn cập nhật trạng thái "thật" chính khi khách thanh toán —
  // trạng thái đơn trong danh sách sẽ tự đúng khi admin bấm kiểm tra lại
  // hoặc tải lại trang, không cần polling nền tốn tài nguyên.

  useEffect(() => {
    if (status !== 'PENDING' || !isExpired) return
    const timer = setTimeout(() => onRemove(tx.orderId), POLL_GRACE_MS)
    return () => clearTimeout(timer)
  }, [status, isExpired, tx.orderId, onRemove])

  const displayStatus = status === 'PENDING' && isExpired ? 'EXPIRED' : status
  const showPayInfo = status === 'PENDING' && !isExpired
  const isFinal = status === 'PAID' || status === 'FAILED'

  return (
    <div className="bg-white rounded-2xl border border-stone-200/80 shadow-[0_1px_4px_-2px_rgba(33,26,29,0.06)] hover:shadow-[0_4px_16px_-6px_rgba(33,26,29,0.14)] hover:-translate-y-0.5 transition-all duration-300 p-4 relative">
      <button onClick={() => setConfirmRemove(true)}
        className="absolute top-3 right-3 text-stone-300 hover:text-stone-500 text-sm w-6 h-6 flex items-center justify-center"
        title={isFinal ? 'Đóng giao dịch' : 'Hủy đơn'}>✕</button>

      <ConfirmModal
        open={confirmRemove}
        title={isFinal ? 'Đóng giao dịch này?' : 'Hủy đơn hàng này?'}
        message={isFinal
          ? 'Giao dịch đã có kết quả cuối cùng — đóng chỉ để ẩn khỏi danh sách trên màn hình này, không ảnh hưởng gì tới dữ liệu giao dịch đã ghi nhận.'
          : 'Đơn sẽ được ẩn khỏi danh sách trên màn hình này. Nếu khách đã thanh toán, giao dịch vẫn được ghi nhận bình thường.'}
        confirmLabel={isFinal ? 'Đóng' : 'Hủy đơn'}
        danger={!isFinal}
        onCancel={() => setConfirmRemove(false)}
        onConfirm={() => { setConfirmRemove(false); onRemove(tx.orderId) }}
      />

      <div className="flex items-center gap-3 pr-6">
        {status === 'PENDING' ? (
          <CountdownRing secondsLeft={secondsLeft} isExpired={isExpired} />
        ) : (
          <div className="w-10 h-10 shrink-0 rounded-full bg-stone-50 flex items-center justify-center text-base">
            {status === 'PAID' ? '✓' : status === 'FAILED' ? '✕' : '⏱'}
          </div>
        )}
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className={`inline-block text-[11px] font-semibold px-2.5 py-1 rounded-full ring-1 ring-inset ${STATUS_STYLE[displayStatus] || 'bg-stone-100 text-stone-600 ring-stone-500/10'}`}>
              {STATUS_TEXT[displayStatus] || displayStatus}
            </span>
            <span className="font-mono text-[11px] text-stone-400 truncate">{tx.orderId}</span>
          </div>
          <p className="font-mono font-extrabold text-lg text-stone-900 leading-tight mt-0.5">{formatVND(tx.amount)}</p>
        </div>
      </div>

      {checkedOnce && status === 'PAID' && (
        <div className="mt-3">
          <p className="text-sm text-emerald-700 bg-emerald-50 rounded-lg px-3 py-2 text-center font-semibold">✓ Giao dịch thành công</p>
          <div className="flex items-center justify-between gap-2 text-[12px] text-stone-500 mt-2 px-1">
            <span className="font-mono truncate">{tx.orderId}</span>
            <span className="font-mono shrink-0">{formatVND(tx.amount)}</span>
          </div>
          <button type="button" onClick={() => setShowDetail(true)}
            className="w-full py-2.5 rounded-xl border border-emerald-200 text-emerald-700 text-xs font-semibold hover:bg-emerald-50 transition mt-2">
            Xem chi tiết giao dịch
          </button>
        </div>
      )}
      <OrderDetailModal open={showDetail} onClose={() => setShowDetail(false)} orderId={tx.orderId} />
      {checkedOnce && status === 'FAILED' && (
        <p className="text-sm text-red-600 bg-red-50 rounded-lg px-3 py-2 mt-3 text-center font-semibold">✕ Giao dịch thất bại</p>
      )}
      {status === 'PENDING' && isExpired && (
        <p className="text-sm text-stone-500 bg-stone-50 rounded-lg px-3 py-2 mt-3 text-center">
          Đã quá 10 phút — nếu khách vừa thanh toán, bấm kiểm tra lại bên dưới.
        </p>
      )}
      {showPayInfo && (
        <div className="w-full flex flex-col gap-2 mt-3">
          <IconLinkRow label="Trang thanh toán (gửi cho khách)" value={thanhToanUrl} href={thanhToanUrl} />
        </div>
      )}
      {status !== 'PAID' && status !== 'FAILED' && (
        <button onClick={handleCheck} disabled={checking} title="Hỏi trực tiếp MoMo, không chờ webhook"
          className="w-full py-2.5 rounded-xl bg-gradient-to-r from-momo to-momo-dark text-white shadow-md shadow-momo/30 hover:shadow-lg hover:shadow-momo/40 hover:brightness-110 active:scale-[0.98] text-xs font-semibold transition disabled:opacity-50 mt-3">
          {checking ? 'Đang hỏi MoMo...' : 'Kiểm tra ngay'}
        </button>
      )}
    </div>
  )
}

// ─── Store select + hook ──────────────────────────────────────────────────────
function StoreSelect({ stores, storeId, setStoreId }) {
  if (stores.length <= 1) return null
  return (
    <>
      <label className="block text-sm font-medium text-stone-700 mb-1">Cửa hàng</label>
      <select value={storeId} onChange={(e) => setStoreId(e.target.value)}
        className={`${INPUT} mb-4`}>
        {stores.map((s) => (
          <option key={s.id} value={s.id}>{s.name}{s.default ? '' : ''}</option>
        ))}
      </select>
    </>
  )
}

// ─── Hook load store list + cache ─────────────────────────────────────────────
function useStores() {
  const cached = loadCache(CACHE_KEY_STORES, { stores: [], storeId: '' })
  const [stores, setStores] = useState(Array.isArray(cached.stores) ? cached.stores : [])
  const [storeId, setStoreId] = useState(cached.storeId || '')
  useEffect(() => {
    fetch('/api/momo/stores', { credentials: 'include' })
      .then((res) => (res.ok ? res.json() : { stores: [] }))
      .then((data) => {
        const list = data.stores || []
        setStores(list)
        setStoreId((cur) => {
          if (cur && list.some((s) => s.id === cur)) return cur
          const def = list.find((s) => s.default)
          return def ? def.id : cur
        })
      })
      .catch(() => {})
  }, [])
  useEffect(() => { saveCache(CACHE_KEY_STORES, { stores, storeId }) }, [stores, storeId])
  return { stores, storeId, setStoreId }
}

// ─── P2P section ──────────────────────────────────────────────────────────────
function P2POrderForm({ stores, storeId, setStoreId, onCreated }) {
  const [amount, setAmount] = useState('')
  const [orderInfo, setOrderInfo] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => { fetch('/api/momo/qr-extract?warm=1').catch(() => {}) }, [])

  async function handleSubmit(e) {
    e.preventDefault(); setError(''); setLoading(true)
    try {
      const res = await fetch('/api/momo/create', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ mode: 'p2p', amount, orderInfo, storeId }),
      })
      if (res.status === 401) { window.location.reload(); return }
      const data = await res.json()
      if (!res.ok) { setError(data.error || 'Không tạo được giao dịch'); return }
      onCreated({ orderId: data.orderId, amount: Number(amount), payUrl: data.payUrl, expiresAt: data.expiresAt })
      setAmount(''); setOrderInfo('')
    } catch { setError('Lỗi kết nối, thử lại sau') } finally { setLoading(false) }
  }

  return (
    <form onSubmit={handleSubmit}>
      <StoreSelect stores={stores} storeId={storeId} setStoreId={setStoreId} />
      <label className="block text-sm font-medium text-stone-700 mb-1">Số tiền (₫)</label>
      <input type="number" inputMode="numeric" min={1000} value={amount} onChange={(e) => setAmount(e.target.value)}
        placeholder="Ví dụ: 50000"
        className={`${INPUT} mb-4 font-mono text-lg`} required />
      <label className="block text-sm font-medium text-stone-700 mb-1">Nội dung (tuỳ chọn)</label>
      <input type="text" value={orderInfo} onChange={(e) => setOrderInfo(e.target.value)}
        placeholder="Ví dụ: Thanh toán đơn hàng"
        className={`${INPUT} mb-5`} />
      {error && <p className="text-sm text-red-600 bg-red-50 rounded-lg px-3 py-2 mb-4">{error}</p>}
      <button type="submit" disabled={loading}
        className="w-full py-3.5 rounded-xl bg-gradient-to-r from-momo to-momo-dark text-white shadow-md shadow-momo/30 hover:shadow-lg hover:shadow-momo/40 hover:brightness-110 active:scale-[0.98] font-semibold transition disabled:opacity-50 flex items-center justify-center gap-2">
        {loading && <Spinner className="w-4 h-4 border-[2px]" />}
        {loading ? 'Đang tạo...' : 'Tạo mã QR'}
      </button>
      <p className="text-[11px] text-stone-400 text-center mt-3">Mỗi mã QR có hạn 10 phút kể từ lúc tạo</p>
    </form>
  )
}

// ─── P2P orders panel ─────────────────────────────────────────────────────────
function OrdersPanel({ transactions, onRemove, onUpdate }) {
  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-sm font-semibold text-stone-700">Đơn hàng đang mở</h2>
        <span className="text-xs font-mono text-stone-400">{transactions.length} đơn</span>
      </div>
      {transactions.length === 0 ? (
        <EmptyTicketState message="Chưa có đơn nào — tạo mã QR bên trái để mở ticket đầu tiên." />
      ) : (
        <div className="flex flex-col gap-3">
          {transactions.map((tx) => (
            <TransactionRow key={tx.orderId} tx={tx} onRemove={onRemove} onUpdate={onUpdate} />
          ))}
        </div>
      )}
    </div>
  )
}

// ─── P2P section ─────────────────────────────────────────────────────────────
function P2PSection({ stores, storeId, setStoreId }) {
  const [transactions, setTransactions] = useState(() => loadOrderCache(CACHE_KEY_P2P))
  useEffect(() => { saveOrderCache(CACHE_KEY_P2P, transactions) }, [transactions])
  const handleCreated = useCallback((tx) => setTransactions((cur) => [tx, ...cur]), [])
  const handleRemove = useCallback((orderId) => setTransactions((cur) => cur.filter((t) => t.orderId !== orderId)), [])
  const handleUpdate = useCallback((orderId, patch) => setTransactions((cur) => cur.map((t) => t.orderId === orderId ? { ...t, ...patch } : t)), [])
  return (
    <TicketWorkspace
      left={<P2POrderForm stores={stores} storeId={storeId} setStoreId={setStoreId} onCreated={handleCreated} />}
      right={<OrdersPanel transactions={transactions} onRemove={handleRemove} onUpdate={handleUpdate} />}
    />
  )
}

// ─── Scan section ─────────────────────────────────────────────────────────────
function ScanOrderForm({ stores, storeId, setStoreId, onCreated }) {
  const [amount, setAmount] = useState('')
  function handleSubmit(e) {
    e.preventDefault(); if (!amount) return
    onCreated({ localId: `scan_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`, amount: Number(amount), storeId, code: '', status: 'INPUT', message: '' })
    setAmount('')
  }
  return (
    <form onSubmit={handleSubmit}>
      <StoreSelect stores={stores} storeId={storeId} setStoreId={setStoreId} />
      <label className="block text-sm font-medium text-stone-700 mb-1">Số tiền (₫)</label>
      <input type="number" inputMode="numeric" min={1000} value={amount} onChange={(e) => setAmount(e.target.value)}
        placeholder="Ví dụ: 50000"
        className={`${INPUT} mb-5 font-mono text-lg`} required />
      <button type="submit"
        className="w-full py-3.5 rounded-xl bg-gradient-to-r from-momo to-momo-dark text-white shadow-md shadow-momo/30 hover:shadow-lg hover:shadow-momo/40 hover:brightness-110 active:scale-[0.98] font-semibold transition">
        Mở đơn chờ scan
      </button>
      <p className="text-[11px] text-stone-400 text-center mt-3">
        Đơn sẽ hiện bên phải — chọn đơn (tô viền) rồi quét mã QR của khách vào ô nhập của đơn đó
      </p>
    </form>
  )
}

// ─── Scan orders panel ───────────────────────────────────────────────────────
function ScanOrderCard({ order, selected, onSelect, onRemove, onUpdate }) {
  const [confirmRemove, setConfirmRemove] = useState(false)
  const [showDetail, setShowDetail] = useState(false)
  const [cameraError, setCameraError] = useState('')
  const inputRef = useRef(null)
  const cameraActive = selected && order.status === 'INPUT'
  const videoRef = useRef(null)
  const streamRef = useRef(null)
  const rafRef = useRef(null)
  const canvasRef = useRef(null)

  useEffect(() => {
    if (selected && order.status === 'INPUT' && inputRef.current) inputRef.current.focus()
  }, [selected, order.status])

  function stopCamera() {
    if (rafRef.current) { cancelAnimationFrame(rafRef.current); rafRef.current = null }
    if (streamRef.current) { streamRef.current.getTracks().forEach((t) => t.stop()); streamRef.current = null }
  }

  useEffect(() => {
    if (!cameraActive) { stopCamera(); return }
    let cancelled = false
    setCameraError('')

    function readQrFromFrame() {
      const video = videoRef.current
      if (!video || video.readyState < video.HAVE_CURRENT_DATA) return null
      const w = video.videoWidth; const h = video.videoHeight
      if (!w || !h) return null
      const canvas = canvasRef.current || (canvasRef.current = document.createElement('canvas'))
      canvas.width = w; canvas.height = h
      const ctx = canvas.getContext('2d', { willReadFrequently: true })
      ctx.drawImage(video, 0, 0, w, h)
      const imageData = ctx.getImageData(0, 0, w, h)
      return jsQR(imageData.data, w, h, { inversionAttempts: 'dontInvert' })
    }

    function scanLoop() {
      if (cancelled || !videoRef.current) return
      try {
        const result = readQrFromFrame()
        if (result && result.data) { const value = result.data; cancelled = true; onUpdate(order.localId, { code: value }); submitCode(value); return }
      } catch { /* bỏ qua */ }
      rafRef.current = requestAnimationFrame(scanLoop)
    }

    async function start() {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } })
        if (cancelled) { stream.getTracks().forEach((t) => t.stop()); return }
        streamRef.current = stream
        if (videoRef.current) { videoRef.current.srcObject = stream; await videoRef.current.play() }
        scanLoop()
      } catch { if (!cancelled) setCameraError('Không mở được camera — kiểm tra quyền truy cập camera của trình duyệt.') }
    }

    start()
    return () => { cancelled = true; stopCamera() }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cameraActive])

  async function submitCode(code) {
    const trimmed = String(code || '').trim()
    if (!trimmed || order.status !== 'INPUT') return
    const orderId = order.orderId || `POS${Date.now()}${Math.random().toString(36).slice(2, 6)}`
    onUpdate(order.localId, { status: 'PROCESSING', code: trimmed, orderId })
    try {
      const res = await fetch('/api/momo/create', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include',
        body: JSON.stringify({ mode: 'scan', amount: order.amount, paymentCode: trimmed, storeId: order.storeId, orderId }),
      })
      if (res.status === 401) { window.location.reload(); return }
      const data = await res.json()
      if (!res.ok) { onUpdate(order.localId, { status: 'FAILED', message: data.error || 'Không xử lý được giao dịch', orderId }); return }
      onUpdate(order.localId, { status: data.resultCode === 0 ? 'PAID' : 'FAILED', message: data.resultCode === 0 ? '' : data.message || 'Giao dịch thất bại', transId: data.transId ? String(data.transId) : null, orderId })
    } catch { onUpdate(order.localId, { status: 'FAILED', message: 'Lỗi kết nối, thử lại sau', orderId }) }
  }

  function handleCodeChange(e) {
    const val = e.target.value; onUpdate(order.localId, { code: val })
    const trimmed = val.trim()
    const requiredLen = /^MM/i.test(trimmed) ? 20 : 18
    if (trimmed.length >= requiredLen) submitCode(val)
  }
  function handleKeyDown(e) { if (e.key === 'Enter') { e.preventDefault(); submitCode(order.code) } }

  const badgeStyle = order.status === 'PAID' ? 'bg-emerald-50 text-emerald-700' : order.status === 'FAILED' ? 'bg-red-50 text-red-700' : order.status === 'PROCESSING' ? 'bg-amber-50 text-amber-700' : 'bg-stone-100 text-stone-600'
  const badgeText = order.status === 'PAID' ? 'Đã thu tiền' : order.status === 'FAILED' ? 'Thất bại' : order.status === 'PROCESSING' ? 'Đang xử lý...' : 'Chờ quét mã'
  const isFinal = order.status === 'PAID' || order.status === 'FAILED'

  return (
    <div
      onClick={() => order.status === 'INPUT' && onSelect(order.localId)}
      className={`bg-white rounded-2xl border p-4 relative shadow-[0_1px_4px_-2px_rgba(33,26,29,0.06)] hover:shadow-[0_4px_16px_-6px_rgba(33,26,29,0.14)] hover:-translate-y-0.5 transition-all duration-300 ${order.status === 'INPUT' ? 'cursor-pointer' : ''} ${selected ? 'border-momo ring-2 ring-momo/30 shadow-[0_4px_16px_-6px_rgba(165,0,100,0.3)]' : 'border-stone-200/80'}`}
    >
      <button onClick={(e) => { e.stopPropagation(); setConfirmRemove(true) }}
        className="absolute top-3 right-3 text-stone-300 hover:text-stone-500 text-sm w-6 h-6 flex items-center justify-center"
        title={isFinal ? 'Đóng giao dịch' : 'Hủy đơn'}>✕</button>

      <ConfirmModal
        open={confirmRemove}
        title={isFinal ? 'Đóng giao dịch này?' : 'Hủy đơn chờ scan này?'}
        message={isFinal
          ? 'Giao dịch đã có kết quả cuối cùng — đóng chỉ để ẩn khỏi danh sách trên màn hình này, không ảnh hưởng gì tới dữ liệu giao dịch đã ghi nhận.'
          : 'Đơn sẽ được ẩn khỏi danh sách trên màn hình này.'}
        confirmLabel={isFinal ? 'Đóng' : 'Hủy đơn'}
        danger={!isFinal}
        onCancel={() => setConfirmRemove(false)}
        onConfirm={() => { setConfirmRemove(false); onRemove(order.localId) }}
      />

      <div className="flex items-center gap-3 pr-6">
        <div className="w-10 h-10 shrink-0 rounded-full bg-stone-50 flex items-center justify-center text-base">
          {order.status === 'PAID' ? '✓' : order.status === 'FAILED' ? '✕' : order.status === 'PROCESSING' ? '…' : '▢'}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className={`inline-block text-[11px] font-semibold px-2.5 py-1 rounded-full ring-1 ring-inset ring-black/5 ${badgeStyle}`}>{badgeText}</span>
            {selected && order.status === 'INPUT' && <span className="text-[11px] font-semibold text-momo">● Đang chọn</span>}
          </div>
          <p className="font-mono font-extrabold text-lg text-stone-900 leading-tight mt-0.5">{formatVND(order.amount)}</p>
        </div>
      </div>

      {order.status === 'INPUT' && (
        <>
          <input ref={inputRef} type="text" value={order.code} onChange={handleCodeChange} onKeyDown={handleKeyDown}
            onClick={(e) => e.stopPropagation()} disabled={!selected}
            placeholder={selected ? 'Quét/dán mã QR của khách (18-20 số)' : 'Bấm chọn đơn này để quét'}
            className="w-full rounded-xl border border-stone-200 px-4 py-3 mt-3 font-mono focus:outline-none focus:ring-4 focus:ring-momo/15 focus:border-momo transition-all duration-200 disabled:bg-stone-50 disabled:text-stone-400" />
          <video ref={videoRef} className="absolute w-px h-px opacity-0 overflow-hidden pointer-events-none -z-10" muted playsInline />
          {cameraError && <p className="text-xs text-red-600 bg-red-50 rounded-lg px-3 py-2 mt-2">{cameraError}</p>}
        </>
      )}
      {order.status === 'FAILED' && order.message && <p className="text-sm text-red-600 bg-red-50 rounded-lg px-3 py-2 mt-3">{order.message}</p>}
      {order.status === 'PAID' && (
        <div className="mt-3">
          <p className="text-sm text-emerald-700 bg-emerald-50 rounded-lg px-3 py-2 text-center font-semibold">✓ Thu tiền thành công</p>
          <div className="flex flex-col gap-1 text-[12px] text-stone-500 mt-2 px-1">
            {order.orderId && <div className="flex items-center justify-between gap-2"><span>Mã đơn</span><span className="font-mono text-stone-700 truncate">{order.orderId}</span></div>}
            {order.transId && <div className="flex items-center justify-between gap-2"><span>Mã GD MoMo</span><span className="font-mono text-stone-700 truncate">{order.transId}</span></div>}
          </div>
          <button type="button" onClick={() => setShowDetail(true)}
            className="w-full py-2.5 rounded-xl border border-emerald-200 text-emerald-700 text-xs font-semibold hover:bg-emerald-50 transition mt-2">
            Xem chi tiết giao dịch
          </button>
        </div>
      )}
      <OrderDetailModal open={showDetail} onClose={() => setShowDetail(false)} orderId={order.orderId} />
    </div>
  )
}

// ─── Scan orders panel ───────────────────────────────────────────────────────
function ScanOrdersPanel({ orders, selectedId, onSelect, onRemove, onUpdate }) {
  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-sm font-semibold text-stone-700">Đơn chờ scan</h2>
        <span className="text-xs font-mono text-stone-400">{orders.length} đơn</span>
      </div>
      {orders.length === 0 ? (
        <EmptyTicketState message="Chưa có đơn nào — nhập số tiền bên trái để mở đơn chờ quét." />
      ) : (
        <div className="flex flex-col gap-3">
          {orders.map((o) => (
            <ScanOrderCard key={o.localId} order={o} selected={o.localId === selectedId}
              onSelect={onSelect} onRemove={onRemove} onUpdate={onUpdate} />
          ))}
        </div>
      )}
    </div>
  )
}

// ─── Scan section ─────────────────────────────────────────────────────────────
function ScanSection({ stores, storeId, setStoreId }) {
  const [orders, setOrders] = useState(() =>
    loadOrderCache(CACHE_KEY_SCAN).map((o) => o.status === 'PROCESSING' ? { ...o, status: 'INPUT' } : o)
  )
  const [selectedId, setSelectedId] = useState(() => {
    const restored = loadOrderCache(CACHE_KEY_SCAN)
    const firstPending = restored.find((o) => o.status === 'INPUT')
    return firstPending ? firstPending.localId : null
  })
  useEffect(() => { saveOrderCache(CACHE_KEY_SCAN, orders) }, [orders])
  const handleCreated = useCallback((order) => { setOrders((cur) => [order, ...cur]); setSelectedId(order.localId) }, [])
  const handleRemove = useCallback((localId) => { setOrders((cur) => cur.filter((o) => o.localId !== localId)); setSelectedId((cur) => cur === localId ? null : cur) }, [])
  const handleUpdate = useCallback((localId, patch) => setOrders((cur) => cur.map((o) => o.localId === localId ? { ...o, ...patch } : o)), [])
  return (
    <TicketWorkspace
      left={<ScanOrderForm stores={stores} storeId={storeId} setStoreId={setStoreId} onCreated={handleCreated} />}
      right={<ScanOrdersPanel orders={orders} selectedId={selectedId} onSelect={setSelectedId} onRemove={handleRemove} onUpdate={handleUpdate} />}
    />
  )
}

// ─── Polling interval for system pause state ───────────────────────────────
const PAUSE_POLL_INTERVAL_MS = 15000

// ─── Export default: trang chủ hợp nhất ──────────────────────────────────────
export default function Home() {
  // ── Pause state ──
  const [pauseState, setPauseState] = useState(null)
  const [resuming, setResuming] = useState(false)
  const [pausing, setPausing] = useState(false)
  const [showPauseConfirm, setShowPauseConfirm] = useState(false)
  const [toast, setToast] = useState('')

  // ── Tab tạo giao dịch ──
  const [tab, setTab] = useState(() => {
    const cached = loadCache(CACHE_KEY_TAB, 'p2p')
    return cached === 'scan' ? 'scan' : 'p2p'
  })
  useEffect(() => { saveCache(CACHE_KEY_TAB, tab) }, [tab])
  const { stores, storeId, setStoreId } = useStores()
  
  useEffect(() => {
    const originalFetch = window.fetch.bind(window)
    window.fetch = async (...args) => {
      const res = await originalFetch(...args)
      if (res.status === 503) {
        try {
          const clone = res.clone()
          const data = await clone.json()
          if (data?.paused) setPauseState((cur) => (cur?.paused ? cur : data))
        } catch { /* response không phải JSON paused, bỏ qua */ }
      }
      return res
    }
    return () => { window.fetch = originalFetch }
  }, [])

  // ── Fetch pause state ──
  useEffect(() => {
    let cancelled = false
    function checkPauseState() {
      fetch(`/api/admin/system-pause?key=${encodeURIComponent(SYSTEM_PAUSE_KEY || '')}`)
        .then((res) => res.json())
        .then((data) => { if (!cancelled) setPauseState(data) })
        .catch(() => { if (!cancelled) setPauseState((cur) => cur || { paused: false }) })
    }
    checkPauseState()
    const id = setInterval(checkPauseState, PAUSE_POLL_INTERVAL_MS)
    return () => { cancelled = true; clearInterval(id) }
  }, [])

  async function callSystemPause(action) {
    const res = await fetch('/api/admin/system-pause', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': SYSTEM_PAUSE_KEY || '' },
      body: JSON.stringify({ action }),
    })
    const data = await res.json()
    if (res.ok) setPauseState(data)
    else setToast(data.error || 'Không đổi được trạng thái hệ thống.')
  }
  async function handleResume() { setResuming(true); try { await callSystemPause('off') } finally { setResuming(false) } }
  async function handlePauseConfirmed() { setPausing(true); try { await callSystemPause('on'); setShowPauseConfirm(false) } finally { setPausing(false) } }

  // ── Loading / Paused gates ──
  if (pauseState === null) {
    return (
      <main className="min-h-screen bg-[#1B181F] flex items-center justify-center">
        <Spinner className="w-8 h-8 border-[3px]" />
      </main>
    )
  }
  if (pauseState.paused) {
    return <PausedScreen meta={pauseState} onResume={handleResume} busy={resuming} />
  }

  return (
    <>
      <Head>
        <title>MOMO PAYMENT</title>
        <meta name="description" content="Cổng thanh toán MoMo" />
        <link rel="icon" href="/main.jpg" />
      </Head>

      <div
        className="min-h-screen"
        style={{
          backgroundColor: '#F3ECDA',
          backgroundImage: 'radial-gradient(#E4D9BE 1px, transparent 1px)',
          backgroundSize: '20px 20px',
        }}
      >
        {/* ── Header: dải tối như thân máy POS ── */}
        <header className="bg-[#211D24] text-white">
          <div className="max-w-5xl mx-auto px-4 sm:px-8 py-4 flex items-center justify-between gap-3">
            <div className="flex items-center gap-3">
              <div className="relative shrink-0">
                <div className="absolute -inset-0.5 rounded-2xl bg-gradient-to-br from-momo to-fuchsia-400 opacity-50 blur-[3px]" />
                <img src="/main.jpg" alt="Momo Dev"
                  className="relative w-10 h-10 rounded-2xl object-cover ring-2 ring-white/20" />
              </div>
              <div>
                <h1 className="text-base font-extrabold leading-tight tracking-tight">Momo Dev</h1>
                <p className="text-white/40 text-xs font-mono">
                  {new Date().toLocaleDateString('vi-VN', { weekday: 'long', day: '2-digit', month: '2-digit', year: 'numeric' })}
                </p>
              </div>
            </div>
            <SystemStatusChip busy={pausing} onPause={() => setShowPauseConfirm(true)} />
          </div>
        </header>

        <main className="px-4 py-8 sm:px-8 sm:py-10">
          <div className="max-w-5xl mx-auto">

            {/* ── Tab switcher dạng bảng chọn chế độ ── */}
            <div className="flex items-center justify-between gap-4 mb-6 flex-wrap">
              <span className="text-[11px] font-semibold tracking-wider text-stone-400 uppercase">Ticket mới</span>
              <div className="inline-flex p-1 rounded-2xl bg-stone-900/[0.05] gap-1">
                {TABS.map((t) => (
                  <button key={t.key} onClick={() => setTab(t.key)}
                    className={`flex items-center gap-1.5 px-4 py-2 rounded-xl text-sm font-semibold transition ${
                      tab === t.key ? 'bg-[#211D24] text-white shadow-md' : 'text-stone-500 hover:text-stone-800'
                    }`}>
                    {t.key === 'p2p' ? <IconQr className="w-4 h-4" /> : <IconScanLine className="w-4 h-4" />}
                    {t.label}
                  </button>
                ))}
              </div>
            </div>

            {/* ── Ticket content (luôn mount, chỉ ẩn hiện bằng CSS) ── */}
            <div className={tab === 'p2p' ? '' : 'hidden'}>
              <P2PSection stores={stores} storeId={storeId} setStoreId={setStoreId} />
            </div>
            <div className={tab === 'scan' ? '' : 'hidden'}>
              <ScanSection stores={stores} storeId={storeId} setStoreId={setStoreId} />
            </div>

          </div>
        </main>
      </div>

      <ConfirmModal
        open={showPauseConfirm}
        title="Dừng toàn bộ hệ thống?"
        message="Dung hệ thống sẽ tạm thời chặn mọi giao dịch mới, nhưng các giao dịch đang xử lý vẫn được ghi nhận bình thường"
        confirmLabel="Dừng hệ thống"
        danger busy={pausing}
        onConfirm={handlePauseConfirmed}
        onCancel={() => setShowPauseConfirm(false)}
      />
      <Toast message={toast} onClose={() => setToast('')} />
    </>
  )
}