// pages/index.js
//
// Hợp nhất trang chủ (dashboard thống kê) và trang tạo giao dịch thành
// 1 trang duy nhất. Phần trên là dashboard (StatCard, biểu đồ 7 ngày,
// nút điều khiển hệ thống). Phần dưới là 2 tab tạo giao dịch (P2P / Scan).
//
// Luồng khoá khi paused giữ nguyên: kiểm tra /api/admin/system-pause
// TRƯỚC, paused thì khoá toàn trang, không gọi thêm API nào khác.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import Head from 'next/head'
import jsQR from 'jsqr'

const currency = new Intl.NumberFormat('vi-VN', { style: 'currency', currency: 'VND', maximumFractionDigits: 0 })
const WEEKDAY_LABELS = ['CN', 'T2', 'T3', 'T4', 'T5', 'T6', 'T7']
const CARD_SHADOW = 'shadow-[0_1px_2px_rgba(33,26,29,0.04),0_6px_16px_-10px_rgba(33,26,29,0.15)]'
const SYSTEM_PAUSE_KEY = process.env.NEXT_PUBLIC_SYSTEM_PAUSE_KEY

// ─── Tabs tạo giao dịch ──────────────────────────────────────────────────────
const TABS = [
  { key: 'p2p', label: 'Tạo mã QR (P2P)' },
  { key: 'scan', label: 'Quét mã khách (POS)' },
]

const STATUS_STYLE = {
  PENDING: 'bg-amber-50 text-amber-700',
  PAID: 'bg-emerald-50 text-emerald-700',
  FAILED: 'bg-red-50 text-red-700',
  EXPIRED: 'bg-neutral-100 text-neutral-500',
}
const STATUS_TEXT = {
  PENDING: 'Chờ thanh toán',
  PAID: 'Đã thanh toán',
  FAILED: 'Thất bại',
  EXPIRED: 'Hết hạn',
}

const ORDER_TTL_SECONDS = 10 * 60
const POLL_INTERVAL_MS = 30000
const POLL_GRACE_MS = 2 * 60 * 1000

const CACHE_KEY_P2P = 'momo_tao_gd_p2p_v1'
const CACHE_KEY_SCAN = 'momo_tao_gd_scan_v1'
const CACHE_KEY_TAB = 'momo_tao_gd_tab_v1'
const CACHE_KEY_STORES = 'momo_tao_gd_stores_v1'

// ─── Helpers ─────────────────────────────────────────────────────────────────
function isSameDay(a, b) {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate()
}
function isToday(iso) {
  if (!iso) return false
  return isSameDay(new Date(iso), new Date())
}
function last7Days(orders) {
  const now = new Date()
  const days = []
  for (let i = 6; i >= 0; i--) {
    const d = new Date(now)
    d.setDate(d.getDate() - i)
    days.push(d)
  }
  return days.map((d) => {
    const revenue = orders
      .filter((o) => o.status === 'PAID' && isSameDay(new Date(o.createdAt), d))
      .reduce((sum, o) => sum + (parseInt(o.amount) || 0), 0)
    return { label: WEEKDAY_LABELS[d.getDay()], revenue, isToday: isSameDay(d, now) }
  })
}

function loadCache(key, fallback) {
  if (typeof window === 'undefined') return fallback
  try {
    const raw = window.sessionStorage.getItem(key)
    return raw ? JSON.parse(raw) : fallback
  } catch {
    return fallback
  }
}
function saveCache(key, value) {
  if (typeof window === 'undefined') return
  try { window.sessionStorage.setItem(key, JSON.stringify(value)) } catch { /* bỏ qua */ }
}
function loadOrderCache(key) {
  const list = loadCache(key, [])
  return Array.isArray(list) ? list : []
}
const saveOrderCache = saveCache

function formatVND(n) {
  const num = Number(n)
  if (Number.isNaN(num)) return n
  return num.toLocaleString('vi-VN') + ' đ'
}
function formatCountdown(sec) {
  const s = Math.max(0, sec)
  const m = Math.floor(s / 60)
  const r = s % 60
  return `${m}:${String(r).padStart(2, '0')}`
}
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
function IconPlus(props) {
  return (
    <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2.25" strokeLinecap="round" {...props}>
      <path d="M12 5v14M5 12h14" />
    </svg>
  )
}
function IconPower(props) {
  return (
    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2.25" strokeLinecap="round" strokeLinejoin="round" {...props}>
      <path d="M12 2v8" />
      <path d="M18.36 6.64a9 9 0 11-12.73 0" />
    </svg>
  )
}
function IconAlertTriangle(props) {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...props}>
      <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
      <line x1="12" y1="9" x2="12" y2="13" />
      <line x1="12" y1="17" x2="12.01" y2="17" />
    </svg>
  )
}
const IconExternalLink = (props) => (
  <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...props}>
    <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
    <polyline points="15 3 21 3 21 9" />
    <line x1="10" y1="14" x2="21" y2="3" />
  </svg>
)
const IconCopy = (props) => (
  <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...props}>
    <rect x="9" y="9" width="13" height="13" rx="2" />
    <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
  </svg>
)
const IconCheck = (props) => (
  <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...props}>
    <polyline points="20 6 9 17 4 12" />
  </svg>
)

// ─── UI dùng chung ────────────────────────────────────────────────────────────
function ConfirmModal({ open, title, message, description, confirmLabel = 'Xác nhận', danger, busy, onConfirm, onCancel }) {
  if (!open) return null
  const body = message || description
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-stone-900/50 backdrop-blur-sm px-4"
      onClick={onCancel}
    >
      <div
        className="w-full max-w-sm bg-white rounded-3xl p-6 shadow-2xl shadow-black/20 ring-1 ring-black/5"
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

function Toast({ message, onClose }) {
  useEffect(() => {
    if (!message) return
    const t = setTimeout(onClose, 4000)
    return () => clearTimeout(t)
  }, [message, onClose])
  if (!message) return null
  return (
    <div className="fixed bottom-5 left-1/2 -translate-x-1/2 z-50 max-w-sm w-[calc(100%-2rem)]">
      <div className="flex items-center gap-2.5 rounded-2xl bg-stone-900 text-white text-sm px-4 py-3 shadow-2xl shadow-black/30">
        <IconAlertTriangle className="text-rose-400 shrink-0" />
        <span className="min-w-0">{message}</span>
      </div>
    </div>
  )
}

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
    <div className="w-full flex items-center justify-between gap-3 rounded-xl border border-neutral-200 px-3 py-2">
      <span className="text-[12px] text-neutral-500 truncate">{label}</span>
      <div className="flex items-center gap-1 shrink-0">
        <a href={href} target="_blank" rel="noreferrer" title="Mở liên kết thanh toán"
          className="w-8 h-8 flex items-center justify-center rounded-lg text-momo hover:bg-momo/10 transition">
          <IconExternalLink />
        </a>
        <button type="button" onClick={handleCopy} title="Chép liên kết"
          className={`w-8 h-8 flex items-center justify-center rounded-lg transition ${copied ? 'text-emerald-600 bg-emerald-50' : 'text-neutral-500 hover:bg-neutral-100'}`}>
          {copied ? <IconCheck /> : <IconCopy />}
        </button>
      </div>
    </div>
  )
}

// ─── Dashboard components ─────────────────────────────────────────────────────
function StatCard({ label, value, accent, dot }) {
  return (
    <div className={`rounded-2xl bg-white px-5 py-4 ${CARD_SHADOW}`}>
      <p className="flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wide text-stone-400 mb-1.5">
        {dot && <span className={`w-1.5 h-1.5 rounded-full ${dot}`} />}
        {label}
      </p>
      <p className={`text-2xl font-extrabold tabular-nums ${accent === 'amber' ? 'text-amber-600' : 'text-stone-900'}`}>
        {value}
      </p>
    </div>
  )
}

function SystemStatusChip({ busy, onPause }) {
  return (
    <button
      onClick={onPause}
      disabled={busy}
      title="Dừng toàn bộ hệ thống"
      className="group flex items-center gap-2 rounded-full bg-white pl-3 pr-4 py-2 text-xs font-semibold text-stone-600 hover:bg-rose-50 hover:text-rose-600 transition disabled:opacity-50 shadow-[0_1px_2px_rgba(33,26,29,0.04),0_6px_16px_-10px_rgba(33,26,29,0.15)]"
    >
      <span className="relative flex w-2 h-2">
        <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75" />
        <span className="relative inline-flex rounded-full w-2 h-2 bg-emerald-500" />
      </span>
      Đang hoạt động
      <IconPower className="text-stone-300 group-hover:text-rose-500 transition-colors" />
    </button>
  )
}

function PausedScreen({ meta, onResume, busy }) {
  return (
    <>
      <Head>
        <title>Hệ thống đang tạm dừng · Momo Dev</title>
      </Head>
      <main className="min-h-screen bg-stone-950 flex items-center justify-center px-4 relative overflow-hidden">
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
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm px-4" onClick={onClose}>
      <div className="bg-white rounded-2xl shadow-2xl shadow-black/20 ring-1 ring-black/5 max-w-sm w-full p-5" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-base font-bold text-neutral-900">Chi tiết giao dịch</h3>
          <button type="button" onClick={onClose} className="text-neutral-400 hover:text-neutral-600 w-6 h-6 flex items-center justify-center">✕</button>
        </div>
        {loading && <p className="text-sm text-neutral-500 text-center py-6">Đang hỏi MoMo...</p>}
        {error && <p className="text-sm text-red-600 bg-red-50 rounded-lg px-3 py-2">{error}</p>}
        {!loading && !error && data && (
          <div className="flex flex-col gap-2.5">
            {rows.map(([label, value]) => (
              <div key={label} className="flex items-start justify-between gap-3 text-sm">
                <span className="text-neutral-500 shrink-0">{label}</span>
                <span className="font-mono text-neutral-900 text-right break-all">{value}</span>
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
      <span className="absolute inset-0 flex items-center justify-center text-[10px] font-mono font-semibold text-neutral-700">
        {isExpired ? '⏱' : formatCountdown(secondsLeft)}
      </span>
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
  const expiredAtRef = useRef(null)

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

  useEffect(() => {
    if (status === 'PAID' || status === 'FAILED') return
    handleCheck()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    if (status !== 'PENDING') return
    if (isExpired) {
      if (!expiredAtRef.current) expiredAtRef.current = Date.now()
      if (Date.now() - expiredAtRef.current > POLL_GRACE_MS) return
    }
    const id = setInterval(handleCheck, POLL_INTERVAL_MS)
    return () => clearInterval(id)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status, isExpired])

  useEffect(() => {
    if (status !== 'PENDING' || !isExpired) return
    const timer = setTimeout(() => onRemove(tx.orderId), POLL_GRACE_MS)
    return () => clearTimeout(timer)
  }, [status, isExpired, tx.orderId, onRemove])

  const displayStatus = status === 'PENDING' && isExpired ? 'EXPIRED' : status
  const showPayInfo = status === 'PENDING' && !isExpired
  const isFinal = status === 'PAID' || status === 'FAILED'

  return (
    <div className="bg-white/90 backdrop-blur-sm rounded-2xl border border-neutral-200/70 shadow-[0_2px_10px_-4px_rgba(0,0,0,0.06),0_16px_40px_-20px_rgba(165,0,100,0.18)] hover:shadow-[0_4px_18px_-4px_rgba(0,0,0,0.08),0_24px_56px_-20px_rgba(165,0,100,0.24)] hover:-translate-y-0.5 transition-all duration-300 p-4 relative">
      <button onClick={() => setConfirmRemove(true)}
        className="absolute top-3 right-3 text-neutral-300 hover:text-neutral-500 text-sm w-6 h-6 flex items-center justify-center"
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
          <div className="w-10 h-10 shrink-0 rounded-full bg-neutral-50 flex items-center justify-center text-base">
            {status === 'PAID' ? '✓' : status === 'FAILED' ? '✕' : '⏱'}
          </div>
        )}
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className={`inline-block text-[11px] font-semibold px-2.5 py-1 rounded-full shadow-sm ring-1 ring-inset ring-black/5 ${STATUS_STYLE[displayStatus] || 'bg-neutral-100 text-neutral-600'}`}>
              {STATUS_TEXT[displayStatus] || displayStatus}
            </span>
            <span className="font-mono text-[11px] text-neutral-400 truncate">{tx.orderId}</span>
          </div>
          <p className="font-mono font-extrabold text-lg text-neutral-900 leading-tight mt-0.5">{formatVND(tx.amount)}</p>
        </div>
      </div>

      {checkedOnce && status === 'PAID' && (
        <div className="mt-3">
          <p className="text-sm text-emerald-700 bg-emerald-50 rounded-lg px-3 py-2 text-center font-semibold">✓ Giao dịch thành công</p>
          <div className="flex items-center justify-between gap-2 text-[12px] text-neutral-500 mt-2 px-1">
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
        <p className="text-sm text-neutral-500 bg-neutral-50 rounded-lg px-3 py-2 mt-3 text-center">
          Đã quá 10 phút — nếu khách vừa thanh toán, bấm kiểm tra lại bên dưới.
        </p>
      )}
      {showPayInfo && (
        <div className="w-full flex flex-col gap-2 mt-3">
          <IconLinkRow label="Trang thanh toán (gửi cho khách)" value={thanhToanUrl} href={thanhToanUrl} />
          {tx.payUrl && <IconLinkRow label="Mở thẳng trong ứng dụng MoMo" value={tx.payUrl} href={tx.payUrl} />}
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
      <label className="block text-sm font-medium text-neutral-700 mb-1">Cửa hàng</label>
      <select value={storeId} onChange={(e) => setStoreId(e.target.value)}
        className="w-full rounded-xl border border-neutral-200 px-4 py-3 mb-4 bg-white focus:outline-none focus:ring-4 focus:ring-momo/15 focus:border-momo transition-all duration-200">
        {stores.map((s) => (
          <option key={s.id} value={s.id}>{s.name}{s.default ? ' (mặc định)' : ''}</option>
        ))}
      </select>
    </>
  )
}

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
    <form onSubmit={handleSubmit} className="bg-white/90 backdrop-blur-sm rounded-2xl border border-neutral-200/70 shadow-[0_2px_10px_-4px_rgba(0,0,0,0.06),0_16px_40px_-20px_rgba(165,0,100,0.18)] hover:shadow-[0_4px_18px_-4px_rgba(0,0,0,0.08),0_24px_56px_-20px_rgba(165,0,100,0.24)] transition-shadow duration-300 p-6">
      <StoreSelect stores={stores} storeId={storeId} setStoreId={setStoreId} />
      <label className="block text-sm font-medium text-neutral-700 mb-1">Số tiền (₫)</label>
      <input type="number" inputMode="numeric" min={1000} value={amount} onChange={(e) => setAmount(e.target.value)}
        placeholder="Ví dụ: 50000"
        className="w-full rounded-xl border border-neutral-200 px-4 py-3 mb-4 font-mono focus:outline-none focus:ring-4 focus:ring-momo/15 focus:border-momo transition-all duration-200" required />
      <label className="block text-sm font-medium text-neutral-700 mb-1">Nội dung (tuỳ chọn)</label>
      <input type="text" value={orderInfo} onChange={(e) => setOrderInfo(e.target.value)}
        placeholder="Ví dụ: Thanh toán đơn hàng"
        className="w-full rounded-xl border border-neutral-200 px-4 py-3 mb-5 focus:outline-none focus:ring-4 focus:ring-momo/15 focus:border-momo transition-all duration-200" />
      {error && <p className="text-sm text-red-600 bg-red-50 rounded-lg px-3 py-2 mb-4">{error}</p>}
      <button type="submit" disabled={loading}
        className="w-full py-3.5 rounded-xl bg-gradient-to-r from-momo to-momo-dark text-white shadow-md shadow-momo/30 hover:shadow-lg hover:shadow-momo/40 hover:brightness-110 active:scale-[0.98] font-semibold transition disabled:opacity-50">
        {loading ? 'Đang tạo...' : 'Tạo mã QR'}
      </button>
      <p className="text-[11px] text-neutral-400 text-center mt-3">Mỗi mã QR có hạn 10 phút kể từ lúc tạo</p>
    </form>
  )
}

function OrdersPanel({ transactions, onRemove, onUpdate }) {
  return (
    <div className="bg-white/90 backdrop-blur-sm rounded-2xl border border-neutral-200/70 shadow-[0_2px_10px_-4px_rgba(0,0,0,0.06),0_16px_40px_-20px_rgba(165,0,100,0.18)] hover:shadow-[0_4px_18px_-4px_rgba(0,0,0,0.08),0_24px_56px_-20px_rgba(165,0,100,0.24)] transition-shadow duration-300 p-4 lg:sticky lg:top-6 lg:max-h-[calc(100vh-3rem)] lg:overflow-y-auto">
      <div className="flex items-center justify-between mb-3 px-1">
        <h2 className="text-sm font-semibold text-neutral-700">Đơn hàng đang mở</h2>
        <span className="text-xs font-mono text-neutral-400">{transactions.length}</span>
      </div>
      {transactions.length === 0 ? (
        <p className="text-sm text-neutral-400 text-center py-10">Chưa có đơn hàng nào</p>
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

function P2PSection({ stores, storeId, setStoreId }) {
  const [transactions, setTransactions] = useState(() => loadOrderCache(CACHE_KEY_P2P))
  useEffect(() => { saveOrderCache(CACHE_KEY_P2P, transactions) }, [transactions])
  const handleCreated = useCallback((tx) => setTransactions((cur) => [tx, ...cur]), [])
  const handleRemove = useCallback((orderId) => setTransactions((cur) => cur.filter((t) => t.orderId !== orderId)), [])
  const handleUpdate = useCallback((orderId, patch) => setTransactions((cur) => cur.map((t) => t.orderId === orderId ? { ...t, ...patch } : t)), [])
  return (
    <div className="grid grid-cols-1 lg:grid-cols-[380px_1fr] gap-6 items-start">
      <P2POrderForm stores={stores} storeId={storeId} setStoreId={setStoreId} onCreated={handleCreated} />
      <OrdersPanel transactions={transactions} onRemove={handleRemove} onUpdate={handleUpdate} />
    </div>
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
    <form onSubmit={handleSubmit} className="bg-white/90 backdrop-blur-sm rounded-2xl border border-neutral-200/70 shadow-[0_2px_10px_-4px_rgba(0,0,0,0.06),0_16px_40px_-20px_rgba(165,0,100,0.18)] hover:shadow-[0_4px_18px_-4px_rgba(0,0,0,0.08),0_24px_56px_-20px_rgba(165,0,100,0.24)] transition-shadow duration-300 p-6">
      <StoreSelect stores={stores} storeId={storeId} setStoreId={setStoreId} />
      <label className="block text-sm font-medium text-neutral-700 mb-1">Số tiền (₫)</label>
      <input type="number" inputMode="numeric" min={1000} value={amount} onChange={(e) => setAmount(e.target.value)}
        placeholder="Ví dụ: 50000"
        className="w-full rounded-xl border border-neutral-200 px-4 py-3 mb-5 font-mono focus:outline-none focus:ring-4 focus:ring-momo/15 focus:border-momo transition-all duration-200" required />
      <button type="submit"
        className="w-full py-3.5 rounded-xl bg-gradient-to-r from-momo to-momo-dark text-white shadow-md shadow-momo/30 hover:shadow-lg hover:shadow-momo/40 hover:brightness-110 active:scale-[0.98] font-semibold transition">
        Mở đơn chờ scan
      </button>
      <p className="text-[11px] text-neutral-400 text-center mt-3">
        Đơn sẽ hiện bên phải — chọn đơn (tô viền) rồi quét mã QR của khách vào ô nhập của đơn đó
      </p>
    </form>
  )
}

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

  const badgeStyle = order.status === 'PAID' ? 'bg-emerald-50 text-emerald-700' : order.status === 'FAILED' ? 'bg-red-50 text-red-700' : order.status === 'PROCESSING' ? 'bg-amber-50 text-amber-700' : 'bg-neutral-100 text-neutral-600'
  const badgeText = order.status === 'PAID' ? 'Đã thu tiền' : order.status === 'FAILED' ? 'Thất bại' : order.status === 'PROCESSING' ? 'Đang xử lý...' : 'Chờ quét mã'
  const isFinal = order.status === 'PAID' || order.status === 'FAILED'

  return (
    <div
      onClick={() => order.status === 'INPUT' && onSelect(order.localId)}
      className={`bg-white/90 backdrop-blur-sm rounded-2xl border p-4 relative shadow-[0_2px_10px_-4px_rgba(0,0,0,0.06)] hover:shadow-[0_4px_18px_-4px_rgba(0,0,0,0.1)] hover:-translate-y-0.5 transition-all duration-300 ${order.status === 'INPUT' ? 'cursor-pointer' : ''} ${selected ? 'border-momo ring-2 ring-momo/30 shadow-[0_4px_18px_-4px_rgba(165,0,100,0.3)]' : 'border-neutral-200/70'}`}
    >
      <button onClick={(e) => { e.stopPropagation(); setConfirmRemove(true) }}
        className="absolute top-3 right-3 text-neutral-300 hover:text-neutral-500 text-sm w-6 h-6 flex items-center justify-center"
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
        <div className="w-10 h-10 shrink-0 rounded-full bg-neutral-50 flex items-center justify-center text-base">
          {order.status === 'PAID' ? '✓' : order.status === 'FAILED' ? '✕' : order.status === 'PROCESSING' ? '…' : '▢'}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className={`inline-block text-[11px] font-semibold px-2.5 py-1 rounded-full shadow-sm ring-1 ring-inset ring-black/5 ${badgeStyle}`}>{badgeText}</span>
            {selected && order.status === 'INPUT' && <span className="text-[11px] font-semibold text-momo">● Đang chọn</span>}
          </div>
          <p className="font-mono font-extrabold text-lg text-neutral-900 leading-tight mt-0.5">{formatVND(order.amount)}</p>
        </div>
      </div>

      {order.status === 'INPUT' && (
        <>
          <input ref={inputRef} type="text" value={order.code} onChange={handleCodeChange} onKeyDown={handleKeyDown}
            onClick={(e) => e.stopPropagation()} disabled={!selected}
            placeholder={selected ? 'Quét/dán mã QR của khách (18-20 số)' : 'Bấm chọn đơn này để quét'}
            className="w-full rounded-xl border border-neutral-200 px-4 py-3 mt-3 font-mono focus:outline-none focus:ring-4 focus:ring-momo/15 focus:border-momo transition-all duration-200 disabled:bg-neutral-50 disabled:text-neutral-400" />
          <video ref={videoRef} className="absolute w-px h-px opacity-0 overflow-hidden pointer-events-none -z-10" muted playsInline />
          {cameraError && <p className="text-xs text-red-600 bg-red-50 rounded-lg px-3 py-2 mt-2">{cameraError}</p>}
        </>
      )}
      {order.status === 'FAILED' && order.message && <p className="text-sm text-red-600 bg-red-50 rounded-lg px-3 py-2 mt-3">{order.message}</p>}
      {order.status === 'PAID' && (
        <div className="mt-3">
          <p className="text-sm text-emerald-700 bg-emerald-50 rounded-lg px-3 py-2 text-center font-semibold">✓ Thu tiền thành công</p>
          <div className="flex flex-col gap-1 text-[12px] text-neutral-500 mt-2 px-1">
            {order.orderId && <div className="flex items-center justify-between gap-2"><span>Mã đơn</span><span className="font-mono text-neutral-700 truncate">{order.orderId}</span></div>}
            {order.transId && <div className="flex items-center justify-between gap-2"><span>Mã GD MoMo</span><span className="font-mono text-neutral-700 truncate">{order.transId}</span></div>}
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

function ScanOrdersPanel({ orders, selectedId, onSelect, onRemove, onUpdate }) {
  return (
    <div className="bg-white/90 backdrop-blur-sm rounded-2xl border border-neutral-200/70 shadow-[0_2px_10px_-4px_rgba(0,0,0,0.06),0_16px_40px_-20px_rgba(165,0,100,0.18)] hover:shadow-[0_4px_18px_-4px_rgba(0,0,0,0.08),0_24px_56px_-20px_rgba(165,0,100,0.24)] transition-shadow duration-300 p-4 lg:sticky lg:top-6 lg:max-h-[calc(100vh-3rem)] lg:overflow-y-auto">
      <div className="flex items-center justify-between mb-3 px-1">
        <h2 className="text-sm font-semibold text-neutral-700">Đơn chờ scan</h2>
        <span className="text-xs font-mono text-neutral-400">{orders.length}</span>
      </div>
      {orders.length === 0 ? (
        <p className="text-sm text-neutral-400 text-center py-10">Chưa có đơn nào — nhập số tiền bên trái để mở đơn chờ quét</p>
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
    <div className="grid grid-cols-1 lg:grid-cols-[380px_1fr] gap-6 items-start">
      <ScanOrderForm stores={stores} storeId={storeId} setStoreId={setStoreId} onCreated={handleCreated} />
      <ScanOrdersPanel orders={orders} selectedId={selectedId} onSelect={setSelectedId} onRemove={handleRemove} onUpdate={handleUpdate} />
    </div>
  )
}

// ─── Export default: trang chủ hợp nhất ──────────────────────────────────────
export default function Home() {
  // ── Pause state ──
  const [pauseState, setPauseState] = useState(null)
  const [resuming, setResuming] = useState(false)
  const [pausing, setPausing] = useState(false)
  const [showPauseConfirm, setShowPauseConfirm] = useState(false)
  const [toast, setToast] = useState('')

  // ── Orders cho dashboard ──
  const [orders, setOrders] = useState(null)
  const [dashError, setDashError] = useState(null)

  // ── Tab tạo giao dịch ──
  const [tab, setTab] = useState(() => {
    const cached = loadCache(CACHE_KEY_TAB, 'p2p')
    return cached === 'scan' ? 'scan' : 'p2p'
  })
  useEffect(() => { saveCache(CACHE_KEY_TAB, tab) }, [tab])
  const { stores, storeId, setStoreId } = useStores()

  // ── Fetch pause state ──
  useEffect(() => {
    let cancelled = false
    fetch(`/api/admin/system-pause?key=${encodeURIComponent(SYSTEM_PAUSE_KEY || '')}`)
      .then((res) => res.json())
      .then((data) => { if (!cancelled) setPauseState(data) })
      .catch(() => { if (!cancelled) setPauseState({ paused: false }) })
    return () => { cancelled = true }
  }, [])

  // ── Fetch orders (chỉ khi không paused) ──
  useEffect(() => {
    if (!pauseState || pauseState.paused) return
    let cancelled = false
    fetch('/api/momo/orders')
      .then((res) => { if (!res.ok) throw new Error('Không tải được dữ liệu'); return res.json() })
      .then((data) => { if (!cancelled) setOrders(data.orders || []) })
      .catch((err) => { if (!cancelled) setDashError(err.message) })
    return () => { cancelled = true }
  }, [pauseState])

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

  const chartDays = useMemo(() => last7Days(orders || []), [orders])

  // ── Loading / Paused gates ──
  if (pauseState === null) {
    return (
      <main className="min-h-screen bg-stone-950 flex items-center justify-center">
        <Spinner className="w-8 h-8 border-[3px]" />
      </main>
    )
  }
  if (pauseState.paused) {
    return <PausedScreen meta={pauseState} onResume={handleResume} busy={resuming} />
  }

  // ── Dashboard stats ──
  const today = (orders || []).filter((o) => isToday(o.createdAt))
  const todayPaid = today.filter((o) => o.status === 'PAID')
  const todayPending = today.filter((o) => o.status === 'PENDING')
  const todayRevenue = todayPaid.reduce((sum, o) => sum + (parseInt(o.amount) || 0), 0)
  const todayDecided = today.filter((o) => o.status === 'PAID' || o.status === 'FAILED')
  const successRate = todayDecided.length ? Math.round((todayPaid.length / todayDecided.length) * 100) : null
  const chartMax = Math.max(...chartDays.map((d) => d.revenue), 1)

  return (
    <>
      <Head>
        <title>Momo Dev</title>
        <meta name="description" content="Cổng thanh toán MoMo" />
        <link rel="icon" href="/main.jpg" />
      </Head>

      <style>{`
        @keyframes momoFlow {
          0%   { background-position: 0% 50%, 100% 0%, 50% 100%, 20% 20%, 80% 80%; }
          50%  { background-position: 100% 50%, 0% 100%, 50% 0%, 80% 80%, 20% 20%; }
          100% { background-position: 0% 50%, 100% 0%, 50% 100%, 20% 20%, 80% 80%; }
        }
        .momo-flow-bg {
          background-color: #fdf7f4;
          background-image:
            radial-gradient(circle at center, rgba(255, 197, 210, 0.75), transparent 60%),
            radial-gradient(circle at center, rgba(255, 232, 178, 0.7), transparent 60%),
            radial-gradient(circle at center, rgba(186, 222, 255, 0.7), transparent 60%),
            radial-gradient(circle at center, rgba(191, 240, 217, 0.7), transparent 60%),
            radial-gradient(circle at center, rgba(222, 205, 255, 0.7), transparent 60%);
          background-size: 130% 130%, 140% 140%, 150% 150%, 120% 120%, 135% 135%;
          background-repeat: no-repeat;
          animation: momoFlow 22s ease-in-out infinite;
        }
      `}</style>

      <main className="momo-flow-bg min-h-screen px-4 py-8 sm:px-8 sm:py-10">
        <div className="max-w-5xl mx-auto">

          {/* ── Header ── */}
          <div className="flex items-center justify-between gap-3 mb-8">
            <div className="flex items-center gap-3">
              <div className="relative shrink-0">
                <div className="absolute -inset-0.5 rounded-2xl bg-gradient-to-br from-momo to-fuchsia-400 opacity-40 blur-[3px]" />
                <img src="/main.jpg" alt="Momo Dev"
                  className="relative w-11 h-11 rounded-2xl object-cover shadow-[0_6px_16px_-6px_rgba(165,0,100,0.55)] ring-2 ring-white" />
              </div>
              <div>
                <h1 className="text-lg font-extrabold leading-tight tracking-tight text-stone-900">Momo Dev</h1>
                <p className="text-stone-400 text-xs">
                  {new Date().toLocaleDateString('vi-VN', { weekday: 'long', day: '2-digit', month: '2-digit', year: 'numeric' })}
                </p>
              </div>
            </div>
            <SystemStatusChip busy={pausing} onPause={() => setShowPauseConfirm(true)} />
          </div>

          {/* ── Dashboard error ── */}
          {dashError && (
            <div className="mb-6 flex items-center gap-2.5 rounded-xl bg-rose-50 px-4 py-3 text-sm text-rose-700">
              <IconAlertTriangle className="shrink-0" />
              {dashError} — thử tải lại trang.
            </div>
          )}

          {/* ── Stat cards ── */}
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mb-3">
            <StatCard label="Doanh thu hôm nay" value={orders === null ? '—' : currency.format(todayRevenue)} />
            <StatCard label="Đang chờ" value={orders === null ? '—' : todayPending.length}
              accent={todayPending.length > 0 ? 'amber' : undefined}
              dot={todayPending.length > 0 ? 'bg-amber-500' : undefined} />
            <StatCard label="Tỷ lệ thành công" value={orders === null ? '—' : successRate === null ? '—' : `${successRate}%`} />
          </div>

          {/* ── Chart 7 ngày ── */}
          <div className={`rounded-2xl bg-white px-6 py-6 mb-8 ${CARD_SHADOW}`}>
            <p className="text-sm font-semibold text-stone-900 mb-5">Doanh thu 7 ngày qua</p>
            {orders === null ? (
              <div className="flex items-end gap-2 h-28">
                {[...Array(7)].map((_, i) => (
                  <div key={i} className="flex-1 h-full rounded-t-md bg-stone-100 animate-pulse" />
                ))}
              </div>
            ) : (
              <div className="flex items-end gap-2 h-28">
                {chartDays.map((d, i) => (
                  <div key={i} className="flex-1 flex flex-col items-center gap-1.5 h-full">
                    <div className="w-full flex-1 rounded-t-md bg-stone-100 flex flex-col-reverse overflow-hidden">
                      <div
                        className={`w-full rounded-t-md transition-all duration-500 ${d.isToday ? 'bg-gradient-to-t from-momo-dark to-momo' : 'bg-stone-300'}`}
                        style={{ height: `${Math.max(4, Math.round((d.revenue / chartMax) * 100))}%` }}
                      />
                    </div>
                    <span className={`text-[10px] font-medium ${d.isToday ? 'text-momo' : 'text-stone-400'}`}>{d.label}</span>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* ── Divider + tiêu đề tạo giao dịch ── */}
          <div className="flex items-center gap-3 mb-6">
            <div className="flex-1 h-px bg-stone-200" />
            <span className="text-sm font-semibold text-stone-400 flex items-center gap-1.5">
              <IconPlus className="w-4 h-4" /> Tạo giao dịch
            </span>
            <div className="flex-1 h-px bg-stone-200" />
          </div>

          {/* ── Tab switcher ── */}
          <div className="flex gap-2 mb-6 bg-white/60 backdrop-blur-md rounded-xl p-1 max-w-sm w-full shadow-lg ring-1 ring-black/5">
            {TABS.map((t) => (
              <button key={t.key} onClick={() => setTab(t.key)}
                className={`flex-1 py-2 rounded-lg text-sm font-semibold transition ${tab === t.key ? 'bg-white text-momo-dark shadow-md' : 'text-neutral-500 hover:text-neutral-800 hover:bg-white/40'}`}>
                {t.label}
              </button>
            ))}
          </div>

          {/* ── Tab content (luôn mount, chỉ ẩn hiện bằng CSS) ── */}
          <div className={tab === 'p2p' ? '' : 'hidden'}>
            <P2PSection stores={stores} storeId={storeId} setStoreId={setStoreId} />
          </div>
          <div className={tab === 'scan' ? '' : 'hidden'}>
            <ScanSection stores={stores} storeId={storeId} setStoreId={setStoreId} />
          </div>

        </div>
      </main>

      <ConfirmModal
        open={showPauseConfirm}
        title="Dừng toàn bộ hệ thống?"
        message="Mọi API sẽ ngừng phục vụ ngay lập tức — không ai tạo hay kiểm tra được giao dịch nào, kể cả bạn, cho tới khi quay lại đây bật lên."
        confirmLabel="Dừng hệ thống"
        danger busy={pausing}
        onConfirm={handlePauseConfirmed}
        onCancel={() => setShowPauseConfirm(false)}
      />
      <Toast message={toast} onClose={() => setToast('')} />
    </>
  )
}