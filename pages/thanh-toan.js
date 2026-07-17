// pages/thanh-toan.js
//
// Trang KHÁCH HÀNG — không yêu cầu đăng nhập admin, vì link này được gửi
// trực tiếp cho khách (qua Zalo, tin nhắn...) để họ tự thanh toán.
// Truy cập: /thanh-toan?orderId=iPOSxxxxx
//
// Luồng dữ liệu:
//   1. GET /api/momo/orders?orderId=xxx        → trạng thái đơn (public, đã lược field nhạy cảm)
//   2. GET /api/momo/qr-extract?orderId=xxx     → ảnh QR thật do MoMo render sẵn (350x350, quét được
//      bằng app ngân hàng bất kỳ hỗ trợ VietQR, không riêng app MoMo)
//   3. GET /api/momo/transfer-info?orderId=xxx  → số tài khoản/ngân hàng/nội dung để khách
//      tự chuyển khoản thủ công khi không quét được QR
//
// Hành vi:
//   - Mọi dữ liệu (đơn hàng, QR, thông tin chuyển khoản) được lưu vào sessionStorage
//     theo orderId. Khi khách F5, dữ liệu cache hiện ra NGAY LẬP TỨC, không phải chờ
//     tải lại từ đầu — rồi trang mới âm thầm gọi API phía sau để cập nhật nếu có gì đổi.
//   - Tự động kiểm tra trạng thái giao dịch mỗi 30s, dừng ngay khi có kết quả cuối
//     (PAID/FAILED) hoặc khi hết hạn 10 phút. Bấm "Kiểm tra kết quả" thủ công sẽ
//     tự dời lại mốc 30s tiếp theo, tránh kiểm tra trùng ngay sau đó.
//   - Có nút "Kiểm tra kết quả" để khách chủ động tra ngay, không cần chờ vòng poll.
//   - QR và thông tin chuyển khoản tải ĐỘC LẬP với nhau và với trạng thái đơn — cái nào
//     xong trước hiện trước. Mỗi khối đều có nút "Tải lại" hiển thị thường trực (không
//     chỉ khi lỗi), để khách chủ động làm mới QR / thông tin bất cứ lúc nào.
//   - Nếu một lần đồng bộ trạng thái đơn bị lỗi (mất mạng, API trả rỗng...) trong khi
//     trang ĐÃ có dữ liệu hiển thị, trang KHÔNG xóa sạch giao diện để báo "không tìm
//     thấy đơn" — chỉ hiện banner nhỏ "đang thử lại" và giữ nguyên nội dung đã có.
//     Màn hình "không tìm thấy đơn" chỉ xuất hiện khi chưa từng tải được dữ liệu nào.
//   - Màn "Quét mã QR" / "Chuyển khoản thủ công" chuyển bằng tab thay vì xếp chồng 2
//     khối, để khách vào trang thấy trọn vẹn nội dung ngay, không phải kéo xuống.
//
// Giao diện: nền gradient sáng, chuyển động nhẹ (thay cho nền trắng phẳng cũ), thẻ trắng
// bo góc lớn cùng kiểu đổ bóng mềm, bảng màu stone/momo, badge trạng thái dạng chấm tròn.

import { useEffect, useRef, useState, useCallback } from 'react'
import { useRouter } from 'next/router'
import Head from 'next/head'

const CARD_SHADOW = 'shadow-[0_1px_2px_rgba(33,26,29,0.04),0_6px_16px_-10px_rgba(33,26,29,0.15)]'
const POLL_INTERVAL_MS = 30 * 1000 // tự động kiểm tra giao dịch mỗi 30s
const ORDER_EXPIRE_MS = 10 * 60 * 1000 // 10 phút kể từ lúc tạo đơn
const CACHE_PREFIX = 'mm_thanhtoan_'
const CACHE_VERSION = 2 // tăng version khi đổi shape cache để tự bỏ qua cache cũ

function formatVND(n) {
  const num = Number(n)
  if (Number.isNaN(num)) return n
  return num.toLocaleString('vi-VN') + ' đ'
}

function formatTime(iso) {
  if (!iso) return '—'
  const d = new Date(iso)
  return d.toLocaleString('vi-VN', { hour: '2-digit', minute: '2-digit', day: '2-digit', month: '2-digit', year: 'numeric' })
}

function formatClock(ts) {
  if (!ts) return '—'
  return new Date(ts).toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit', second: '2-digit' })
}

function formatCountdown(ms) {
  const totalSec = Math.max(0, Math.ceil(ms / 1000))
  const m = Math.floor(totalSec / 60)
  const s = totalSec % 60
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
}

// ---------------------------------------------------------------------------
// Cache theo orderId trong sessionStorage — mục tiêu: F5 không mất thời gian
// tải lại QR/đơn hàng/thông tin chuyển khoản đã có sẵn.
// ---------------------------------------------------------------------------
function readCache(orderId) {
  if (typeof window === 'undefined' || !orderId) return null
  try {
    const raw = window.sessionStorage.getItem(CACHE_PREFIX + orderId)
    if (!raw) return null
    const parsed = JSON.parse(raw)
    if (parsed?.v !== CACHE_VERSION) return null
    return parsed
  } catch {
    return null
  }
}

function writeCache(orderId, patch) {
  if (typeof window === 'undefined' || !orderId) return
  try {
    const prev = readCache(orderId) || { v: CACHE_VERSION }
    window.sessionStorage.setItem(CACHE_PREFIX + orderId, JSON.stringify({ ...prev, ...patch, v: CACHE_VERSION }))
  } catch {
    /* sessionStorage có thể đầy hoặc bị chặn — bỏ qua im lặng, không ảnh hưởng luồng chính */
  }
}

function clearCacheField(orderId, field) {
  if (typeof window === 'undefined' || !orderId) return
  try {
    const prev = readCache(orderId)
    if (!prev) return
    const next = { ...prev }
    delete next[field]
    window.sessionStorage.setItem(CACHE_PREFIX + orderId, JSON.stringify(next))
  } catch {
    /* bỏ qua im lặng */
  }
}

// Chuyển response ảnh QR thành data URL để lưu được vào sessionStorage (chuỗi text)
async function fetchImageAsDataUrl(url, signal) {
  const res = await fetch(url, { signal })
  if (!res.ok) throw new Error('qr fetch failed')
  const blob = await res.blob()
  return await new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result)
    reader.onerror = () => reject(new Error('qr read failed'))
    reader.readAsDataURL(blob)
  })
}

// Spinner xoay tròn dùng chung cho các trạng thái đang tải — có track mờ phía
// sau (giống iOS/Material) để không bị trống trơn 1 nét viền, quay nhanh và
// mượt hơn animate-spin mặc định (0.7s thay vì 1s, easing riêng thay vì linear).
function Spinner({ className = '' }) {
  return (
    <span
      className={`inline-block rounded-full border-2 border-stone-200/60 border-t-momo animate-spin [animation-duration:0.7s] [animation-timing-function:cubic-bezier(0.4,0,0.2,1)] ${className}`}
      aria-hidden="true"
    />
  )
}

function Skeleton({ className = '' }) {
  return <div className={`animate-pulse bg-stone-100 rounded-xl ${className}`} />
}

// Icon nạp lại — dùng cho các nút "Tải lại" thường trực trên mỗi khối
function RefreshIcon({ spinning = false, className = '' }) {
  return (
    <svg
      viewBox="0 0 20 20"
      fill="currentColor"
      className={`w-4 h-4 ${spinning ? 'animate-spin [animation-duration:0.7s]' : ''} ${className}`}
      aria-hidden="true"
    >
      <path d="M10 3.5a6.5 6.5 0 015.542 3.104.75.75 0 11-1.284.775A5 5 0 105 10a.75.75 0 01-1.5 0 6.5 6.5 0 016.5-6.5z" />
      <path d="M14.5 3v3.25a.75.75 0 01-.75.75H10.5a.75.75 0 010-1.5h2.5V3a.75.75 0 011.5 0z" />
    </svg>
  )
}

// Nút "Tải lại" nhỏ, thường trực ở góc mỗi khối — không chỉ hiện khi lỗi, để
// khách chủ động làm mới QR / thông tin chuyển khoản bất cứ lúc nào.
function ReloadButton({ onClick, loading, label }) {
  return (
    <button
      onClick={onClick}
      disabled={loading}
      aria-label={label}
      title={label}
      className="shrink-0 flex items-center gap-1 text-xs font-semibold text-momo bg-momo/5 hover:bg-momo/10 active:scale-95 rounded-lg px-2.5 py-1.5 transition-all duration-200 ease-out disabled:opacity-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-momo/30"
    >
      <RefreshIcon spinning={loading} />
      <span className="hidden xs:inline">Tải lại</span>
    </button>
  )
}

// Cùng bảng màu trạng thái (chấm tròn) với pages/index.js
const STATUS_META = {
  PAID: { label: 'Đã thanh toán', dot: 'bg-emerald-500', text: 'text-emerald-700', chip: 'bg-emerald-50' },
  PENDING: { label: 'Chờ thanh toán', dot: 'bg-amber-500', text: 'text-amber-700', chip: 'bg-amber-50' },
  FAILED: { label: 'Thất bại', dot: 'bg-rose-500', text: 'text-rose-700', chip: 'bg-rose-50' },
  EXPIRED: { label: 'Hết hạn', dot: 'bg-stone-400', text: 'text-stone-500', chip: 'bg-stone-100' },
}

function StatusBadge({ status }) {
  const meta = STATUS_META[status] || STATUS_META.EXPIRED
  return (
    <span className={`inline-flex items-center gap-1.5 text-xs font-semibold ${meta.text} ${meta.chip} px-2 py-0.5 rounded-full`}>
      <span className={`w-1.5 h-1.5 rounded-full ${meta.dot} ${status === 'PENDING' ? 'animate-pulse' : ''}`} />
      {meta.label}
    </span>
  )
}

// Header logo dùng chung với trang chủ admin, kèm badge "kết nối an toàn" để
// khách nhận ra ngay đây là trang thanh toán chính chủ, không phải link giả mạo.
function BrandHeader() {
  return (
    <div className="flex items-center justify-between gap-3 mb-5">
      <div className="flex items-center gap-3">
        <div className="w-11 h-11 shrink-0 rounded-2xl bg-momo flex items-center justify-center text-white font-extrabold text-lg shadow-[0_6px_16px_-6px_rgba(165,0,100,0.55)]">
          M
        </div>
        <div>
          <h1 className="text-lg font-extrabold text-stone-900 leading-tight tracking-tight">Momo Dev</h1>
          <p className="text-stone-400 text-xs">Cổng thanh toán</p>
        </div>
      </div>
      <span className="hidden sm:inline-flex items-center gap-1.5 text-[11px] font-medium text-stone-400 bg-white/80 backdrop-blur rounded-full px-2.5 py-1 border border-stone-100">
        <svg viewBox="0 0 20 20" fill="currentColor" className="w-3.5 h-3.5 text-emerald-500" aria-hidden="true">
          <path fillRule="evenodd" d="M10 1.5a4.5 4.5 0 00-4.5 4.5v2.25H5a1.5 1.5 0 00-1.5 1.5v7A1.5 1.5 0 005 18.25h10a1.5 1.5 0 001.5-1.5v-7A1.5 1.5 0 0015 8.25h-.5V6a4.5 4.5 0 00-4.5-4.5zm3 6.75V6a3 3 0 10-6 0v2.25h6z" clipRule="evenodd" />
        </svg>
        Kết nối bảo mật
      </span>
    </div>
  )
}

function CopyField({ label, value }) {
  const [copied, setCopied] = useState(false)

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(String(value))
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      /* clipboard có thể bị chặn trên 1 số trình duyệt — bỏ qua im lặng */
    }
  }

  return (
    <button
      onClick={handleCopy}
      aria-label={`Chép ${label}`}
      className={`w-full flex items-center justify-between gap-3 rounded-2xl bg-white px-4 py-3 text-left hover:bg-stone-50 hover:-translate-y-px active:scale-[0.98] active:translate-y-0 transition-all duration-200 ease-out focus:outline-none focus-visible:ring-2 focus-visible:ring-momo/30 ${CARD_SHADOW}`}
    >
      <span className="min-w-0">
        <span className="block text-[11px] font-medium uppercase tracking-wide text-stone-400 mb-0.5">{label}</span>
        <span className="block font-mono font-semibold text-stone-900 truncate">{value}</span>
      </span>
      <span className={`shrink-0 w-9 h-9 rounded-lg flex items-center justify-center transition-all duration-200 ease-out ${copied ? 'text-emerald-700 bg-emerald-50' : 'text-momo bg-momo/5'}`}>
        {copied ? (
          <svg viewBox="0 0 20 20" fill="currentColor" className="w-4 h-4"><path fillRule="evenodd" d="M16.7 5.3a1 1 0 010 1.4l-8 8a1 1 0 01-1.4 0l-4-4a1 1 0 111.4-1.4L8 12.6l7.3-7.3a1 1 0 011.4 0z" clipRule="evenodd" /></svg>
        ) : (
          <svg viewBox="0 0 20 20" fill="currentColor" className="w-4 h-4"><path d="M7 3.5A1.5 1.5 0 018.5 2h5A1.5 1.5 0 0115 3.5v9a1.5 1.5 0 01-1.5 1.5h-5A1.5 1.5 0 017 12.5v-9z" /><path d="M4 6.5A1.5 1.5 0 015.5 5H6v9.5A2.5 2.5 0 008.5 17H13v.5A1.5 1.5 0 0111.5 19h-6A1.5 1.5 0 014 17.5v-11z" /></svg>
        )}
      </span>
    </button>
  )
}

// Nút chép nhỏ dùng inline cạnh mã đơn, không cần chiếm cả 1 hàng như CopyField
function InlineCopy({ value }) {
  const [copied, setCopied] = useState(false)
  async function handleCopy(e) {
    e.stopPropagation()
    try {
      await navigator.clipboard.writeText(String(value))
      setCopied(true)
      setTimeout(() => setCopied(false), 1200)
    } catch {
      /* bỏ qua im lặng */
    }
  }
  return (
    <button
      onClick={handleCopy}
      aria-label="Chép mã đơn"
      className="shrink-0 text-stone-300 hover:text-momo hover:scale-110 active:scale-95 transition-all duration-200 ease-out focus:outline-none focus-visible:ring-2 focus-visible:ring-momo/30 rounded"
    >
      {copied ? (
        <svg viewBox="0 0 20 20" fill="currentColor" className="w-3.5 h-3.5 text-emerald-500"><path fillRule="evenodd" d="M16.7 5.3a1 1 0 010 1.4l-8 8a1 1 0 01-1.4 0l-4-4a1 1 0 111.4-1.4L8 12.6l7.3-7.3a1 1 0 011.4 0z" clipRule="evenodd" /></svg>
      ) : (
        <svg viewBox="0 0 20 20" fill="currentColor" className="w-3.5 h-3.5"><path d="M7 3.5A1.5 1.5 0 018.5 2h5A1.5 1.5 0 0115 3.5v9a1.5 1.5 0 01-1.5 1.5h-5A1.5 1.5 0 017 12.5v-9z" /><path d="M4 6.5A1.5 1.5 0 015.5 5H6v9.5A2.5 2.5 0 008.5 17H13v.5A1.5 1.5 0 0111.5 19h-6A1.5 1.5 0 014 17.5v-11z" /></svg>
      )}
    </button>
  )
}

// Thanh thông tin đơn hàng — dạng 1 hàng gọn (mã đơn · cửa hàng · trạng thái)
// để tiết kiệm chiều cao màn hình, thay vì xếp từng dòng như trước.
function OrderMeta({ order }) {
  return (
    <div className={`bg-white rounded-2xl px-4 py-3 mb-3 flex items-center justify-between gap-3 text-sm flex-wrap ${CARD_SHADOW}`}>
      <span className="flex items-center gap-1.5 min-w-0">
        <span className="text-stone-400 shrink-0">Mã đơn</span>
        <span className="font-mono text-stone-900 truncate">{order.orderId}</span>
        <InlineCopy value={order.orderId} />
      </span>
      {order.storeName && (
        <span className="text-stone-400 hidden sm:inline truncate">{order.storeName}</span>
      )}
      <StatusBadge status={order.status} />
    </div>
  )
}

// Nền trang: gradient sáng, chuyển động nhẹ và nhanh — thay cho nền trắng
// phẳng cũ (gây chói mắt). Dùng chung cho mọi màn hình (đang tải / lỗi /
// PENDING / PAID / FAILED / EXPIRED).
function GradientMain({ children, className = '', tight = false }) {
  return (
    <main className={`min-h-screen relative overflow-hidden ${className}`}>
      <div className="absolute inset-0 -z-10 page-gradient-bg" />
      <style jsx global>{`
        @keyframes momoGradientMove {
          0% { background-position: 0% 50%; }
          50% { background-position: 100% 50%; }
          100% { background-position: 0% 50%; }
        }
        .page-gradient-bg {
          background: linear-gradient(120deg, #fff1f6, #fff7ed, #fdf4ff, #fef2f2, #fff1f6);
          background-size: 320% 320%;
          animation: momoGradientMove 6s ease infinite;
        }
      `}</style>
      <div className={tight ? 'relative px-4 py-6 sm:py-8' : 'relative px-4 py-8 sm:py-10'}>
        {children}
      </div>
    </main>
  )
}

function TrustFooter() {
  return (
    <div className="flex items-center justify-center gap-4 text-[11px] text-stone-400 mt-5">
      <span className="flex items-center gap-1">
        <svg viewBox="0 0 20 20" fill="currentColor" className="w-3.5 h-3.5" aria-hidden="true">
          <path fillRule="evenodd" d="M10 1.5a4.5 4.5 0 00-4.5 4.5v2.25H5a1.5 1.5 0 00-1.5 1.5v7A1.5 1.5 0 005 18.25h10a1.5 1.5 0 001.5-1.5v-7A1.5 1.5 0 0015 8.25h-.5V6a4.5 4.5 0 00-4.5-4.5zm3 6.75V6a3 3 0 10-6 0v2.25h6z" clipRule="evenodd" />
        </svg>
        Mã hóa SSL
      </span>
      <span className="w-1 h-1 rounded-full bg-stone-300" />
      <span>Đối soát tự động</span>
      <span className="w-1 h-1 rounded-full bg-stone-300" />
      <span>Hỗ trợ 24/7</span>
    </div>
  )
}

// Banner nhỏ, không phá layout — chỉ hiện khi một lần đồng bộ nền bị lỗi
// trong lúc trang đã có dữ liệu sẵn để hiển thị.
function SyncBanner({ message }) {
  if (!message) return null
  return (
    <div
      role="status"
      aria-live="polite"
      className="flex items-center gap-2 text-xs text-amber-800 bg-amber-50 border border-amber-100 rounded-xl px-3 py-2 mb-3"
    >
      <Spinner className="w-3.5 h-3.5 border-amber-200 border-t-amber-600" />
      {message}
    </div>
  )
}

// Segmented control chuyển giữa "Quét mã QR" và "Chuyển khoản thủ công" — dùng
// tab thay vì xếp 2 khối chồng nhau để khách vào trang thấy trọn nội dung
// ngay, không phải kéo xuống mới thấy đủ mã QR.
function TabSwitcher({ active, onChange }) {
  const tabs = [
    { key: 'qr', label: 'Quét mã QR' },
    { key: 'transfer', label: 'Chuyển khoản thủ công' },
  ]
  return (
    <div className="flex bg-white/70 backdrop-blur rounded-2xl p-1 mb-3 gap-1 border border-white">
      {tabs.map((t) => (
        <button
          key={t.key}
          onClick={() => onChange(t.key)}
          className={`flex-1 text-sm font-semibold rounded-xl py-2.5 transition-all duration-200 ease-out focus:outline-none focus-visible:ring-2 focus-visible:ring-momo/30 ${
            active === t.key ? 'bg-white text-momo shadow-sm' : 'text-stone-500 hover:text-stone-700'
          }`}
        >
          {t.label}
        </button>
      ))}
    </div>
  )
}

export default function ThanhToan() {
  const router = useRouter()
  const { orderId } = router.query

  const [order, setOrder] = useState(null)
  const [notFound, setNotFound] = useState(false)
  const [checking, setChecking] = useState(false)
  const [syncMessage, setSyncMessage] = useState('')
  const [lastCheckedAt, setLastCheckedAt] = useState(null)

  const [transferInfo, setTransferInfo] = useState(null)
  const [transferError, setTransferError] = useState('')
  const [transferLoading, setTransferLoading] = useState(false)

  const [qrSrc, setQrSrc] = useState(null)
  const [qrFailed, setQrFailed] = useState(false)
  const [qrLoading, setQrLoading] = useState(false)

  const [remainingMs, setRemainingMs] = useState(null)
  const [expired, setExpired] = useState(false)
  const [nextPollInMs, setNextPollInMs] = useState(null)

  // Tab đang xem — mặc định mở khung QR trước vì đa số khách quét QR
  const [activeTab, setActiveTab] = useState('qr')

  const pollTimeoutRef = useRef(null)
  const nextPollAtRef = useRef(null)
  const orderAbortRef = useRef(null)
  const transferAbortRef = useRef(null)
  const qrAbortRef = useRef(null)
  const autoCheckDoneRef = useRef(false)

  // -------------------------------------------------------------------
  // Tải đơn hàng — silent = true khi chạy nền (poll/hydrate), không bật
  // các cờ loading để tránh làm giao diện "giật" khi đã có dữ liệu cache.
  //
  // Quan trọng: nếu lần đồng bộ này thất bại (mất mạng, hoặc API tạm thời
  // trả rỗng) NHƯNG trang đã có đơn hàng đang hiển thị, KHÔNG được xóa giao
  // diện để báo "không tìm thấy" — chỉ hiện banner nhỏ và giữ nguyên dữ liệu
  // cũ. Màn "không tìm thấy đơn" chỉ dành cho lần tải đầu tiên chưa có gì.
  // -------------------------------------------------------------------
  const loadOrder = useCallback(async ({ manual = false } = {}) => {
    if (!orderId) return
    if (orderAbortRef.current) orderAbortRef.current.abort()
    const controller = new AbortController()
    orderAbortRef.current = controller

    if (manual) setChecking(true)
    try {
      const res = await fetch(`/api/momo/orders?orderId=${encodeURIComponent(orderId)}`, { signal: controller.signal })
      const data = await res.json()
      const found = (data.orders || []).find((o) => o.orderId === orderId)
      setLastCheckedAt(Date.now())

      if (!found) {
        setOrder((cur) => {
          if (!cur) {
            setNotFound(true)
          } else {
            setSyncMessage('Không đồng bộ được trạng thái mới nhất, đang thử lại...')
          }
          return cur
        })
        return
      }

      setOrder(found)
      setNotFound(false)
      setSyncMessage('')
      writeCache(orderId, { order: found })
    } catch (err) {
      if (err?.name === 'AbortError') return
      setLastCheckedAt(Date.now())
      setOrder((cur) => {
        if (!cur) {
          setNotFound(true)
        } else {
          setSyncMessage('Mất kết nối, đang thử kiểm tra lại...')
        }
        return cur
      })
    } finally {
      if (manual) setChecking(false)
    }
  }, [orderId])

  // -------------------------------------------------------------------
  // Kiểm tra THẬT với MoMo (server-to-server qua /api/momo/query) — trước
  // đây route này chỉ admin gọi được. Trang khách xin 1 token dùng-1-lần
  // riêng cho orderId này (/api/momo/guest-check-token) rồi mới gọi query
  // kèm token đó. Không đọc/parse response ở đây vì query.js đã tự đồng
  // bộ Redis — loadOrder() gọi ngay sau sẽ thấy trạng thái mới nhất.
  // Lỗi ở bước này (đơn không PENDING, mất mạng, token vừa hết hạn...) chỉ
  // bỏ qua im lặng: loadOrder() vẫn chạy bình thường như trước giờ.
  // -------------------------------------------------------------------
  const checkRealStatus = useCallback(async () => {
    if (!orderId) return
    try {
      const tokenRes = await fetch(`/api/momo/guest-check-token?orderId=${encodeURIComponent(orderId)}`)
      if (!tokenRes.ok) return
      const { token } = await tokenRes.json()
      if (!token) return
      await fetch(`/api/momo/query?orderId=${encodeURIComponent(orderId)}&token=${encodeURIComponent(token)}`)
    } catch {
      /* bỏ qua im lặng — loadOrder() phía sau vẫn chạy để đọc trạng thái hiện có */
    }
  }, [orderId])

  const loadTransferInfo = useCallback(async ({ silent = false } = {}) => {
    if (!orderId) return
    if (transferAbortRef.current) transferAbortRef.current.abort()
    const controller = new AbortController()
    transferAbortRef.current = controller

    if (!silent) setTransferLoading(true)
    try {
      const res = await fetch(`/api/momo/transfer-info?orderId=${encodeURIComponent(orderId)}`, { signal: controller.signal })
      const data = await res.json()
      if (!res.ok) {
        setTransferInfo((cur) => {
          if (!cur) setTransferError(data.error || 'Không lấy được thông tin chuyển khoản')
          return cur
        })
        return
      }
      setTransferInfo(data)
      setTransferError('')
      writeCache(orderId, { transferInfo: data })
    } catch (err) {
      if (err?.name === 'AbortError') return
      setTransferInfo((cur) => {
        if (!cur) setTransferError('Lỗi kết nối, thử lại sau')
        return cur
      })
    } finally {
      if (!silent) setTransferLoading(false)
    }
  }, [orderId])

  const loadQr = useCallback(async ({ silent = false } = {}) => {
    if (!orderId) return
    if (qrAbortRef.current) qrAbortRef.current.abort()
    const controller = new AbortController()
    qrAbortRef.current = controller

    if (!silent) setQrLoading(true)
    setQrFailed(false)
    try {
      const dataUrl = await fetchImageAsDataUrl(`/api/momo/qr-extract?orderId=${encodeURIComponent(orderId)}`, controller.signal)
      setQrSrc(dataUrl)
      writeCache(orderId, { qrSrc: dataUrl })
    } catch (err) {
      if (err?.name === 'AbortError') return
      setQrSrc((cur) => {
        if (!cur) setQrFailed(true)
        return cur
      })
    } finally {
      if (!silent) setQrLoading(false)
    }
  }, [orderId])

  // Khi ảnh QR lấy từ cache/API bị hỏng (data URL không render được), coi như
  // tải lỗi và cho khách bấm "Tải lại" thay vì để khoảng trắng vô nghĩa.
  const handleQrImgError = useCallback(() => {
    setQrSrc(null)
    setQrFailed(true)
    clearCacheField(orderId, 'qrSrc')
  }, [orderId])

  // Hydrate từ cache ngay khi có orderId, rồi mới âm thầm gọi API để làm mới dữ liệu.
  useEffect(() => {
    if (!orderId) return
    const cached = readCache(orderId)
    if (cached?.order) setOrder(cached.order)
    if (cached?.transferInfo) setTransferInfo(cached.transferInfo)
    if (cached?.qrSrc) setQrSrc(cached.qrSrc)

    loadOrder()
    loadTransferInfo({ silent: !!cached?.transferInfo })
    loadQr({ silent: !!cached?.qrSrc })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orderId])

  // Đếm ngược 10 phút kể từ lúc tạo đơn
  useEffect(() => {
    if (!order || !order.createdAt || order.status !== 'PENDING') return

    const deadline = new Date(order.createdAt).getTime() + ORDER_EXPIRE_MS

    function tick() {
      const left = deadline - Date.now()
      setRemainingMs(left)
      if (left <= 0) {
        setExpired(true)
      }
    }

    tick()
    const timer = setInterval(tick, 1000)
    return () => clearInterval(timer)
  }, [order?.createdAt, order?.status])

  // Đếm ngược tới lần tự động kiểm tra tiếp theo — chỉ để khách yên tâm trang
  // vẫn đang "sống", không phải logic nghiệp vụ.
  useEffect(() => {
    if (!nextPollAtRef.current) {
      setNextPollInMs(null)
      return
    }
    function tick() {
      setNextPollInMs(Math.max(0, nextPollAtRef.current - Date.now()))
    }
    tick()
    const timer = setInterval(tick, 1000)
    return () => clearInterval(timer)
  }, [order?.status, expired])

  // Tự động kiểm tra giao dịch mỗi 30s cho tới khi có kết quả cuối (PAID/FAILED)
  // hoặc hết hạn. Dùng setTimeout tự lặp (thay vì setInterval cố định) để mỗi
  // lần bấm "Kiểm tra kết quả" thủ công có thể dời lại mốc 30s tiếp theo,
  // tránh kiểm tra trùng ngay sau khi khách vừa tự tra.
  const scheduleNextPoll = useCallback(() => {
    if (pollTimeoutRef.current) clearTimeout(pollTimeoutRef.current)
    nextPollAtRef.current = Date.now() + POLL_INTERVAL_MS
    setNextPollInMs(POLL_INTERVAL_MS)
    pollTimeoutRef.current = setTimeout(async () => {
      await checkRealStatus()
      await loadOrder()
      scheduleNextPoll()
    }, POLL_INTERVAL_MS)
  }, [loadOrder, checkRealStatus])

  useEffect(() => {
    if (!orderId || !order) return
    if (order.status !== 'PENDING' || expired) {
      if (pollTimeoutRef.current) clearTimeout(pollTimeoutRef.current)
      nextPollAtRef.current = null
      return
    }
    scheduleNextPoll()
    return () => {
      if (pollTimeoutRef.current) clearTimeout(pollTimeoutRef.current)
    }
  }, [orderId, order?.status, expired, scheduleNextPoll])

  const handleManualCheck = useCallback(async () => {
    setChecking(true)
    await checkRealStatus()
    await loadOrder({ manual: true })
    // Đơn vẫn đang chờ thì dời lại mốc tự động kiểm tra tiếp theo, tránh tra trùng
    if (order?.status === 'PENDING' && !expired) scheduleNextPoll()
  }, [checkRealStatus, loadOrder, order?.status, expired, scheduleNextPoll])

  // -------------------------------------------------------------------
  // Tự động bấm "Kiểm tra kết quả" khi khách vừa được /result chuyển sang
  // (?autoCheck=1) — lúc này MoMo vừa redirect về nên giao dịch gần như
  // chắc chắn đã có kết quả, không cần bắt khách tự bấm nút. Chỉ chạy
  // đúng 1 lần (autoCheckDoneRef), sau đó dọn "autoCheck" khỏi URL để
  // F5 lại trang không tự kiểm tra lặp lại vô ích.
  // -------------------------------------------------------------------
  useEffect(() => {
    if (!router.isReady || !orderId) return
    if (autoCheckDoneRef.current) return
    if (!router.query.autoCheck) return

    autoCheckDoneRef.current = true
    handleManualCheck()

    const { autoCheck, ...rest } = router.query
    router.replace({ pathname: router.pathname, query: rest }, undefined, { shallow: true })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [router.isReady, orderId])

  // ---------------------------------------------------------------------
  // Màn hình theo trạng thái
  // ---------------------------------------------------------------------

  if (!orderId) {
    // router.query rỗng cả khi Next.js chưa hydrate xong lẫn khi thật sự thiếu
    // orderId — chỉ báo lỗi sau khi router đã sẵn sàng (router.isReady).
    if (!router.isReady) {
      return (
        <GradientMain>
          <div className="w-full max-w-sm mx-auto py-10">
            <BrandHeader />
            <div className="flex flex-col items-center justify-center gap-3 text-stone-400 text-sm py-6">
              <Spinner className="w-8 h-8 border-[3px]" />
              Đang tải...
            </div>
          </div>
        </GradientMain>
      )
    }
    return (
      <GradientMain>
        <div className="w-full max-w-sm mx-auto py-10">
          <BrandHeader />
          <div className={`bg-white rounded-2xl p-6 text-center text-stone-400 text-sm ${CARD_SHADOW}`}>
            Thiếu mã đơn hàng trong đường dẫn.
          </div>
        </div>
      </GradientMain>
    )
  }

  if (notFound && !order) {
    return (
      <GradientMain>
        <div className="w-full max-w-sm mx-auto py-10">
          <BrandHeader />
          <div className={`bg-white rounded-2xl p-8 text-center ${CARD_SHADOW}`}>
            <div className="w-14 h-14 rounded-full bg-stone-100 mx-auto mb-4 flex items-center justify-center text-2xl">?</div>
            <p className="text-stone-900 font-semibold mb-1">Không tìm thấy đơn hàng</p>
            <p className="text-stone-500 text-sm">Kiểm tra lại đường dẫn hoặc liên hệ cửa hàng.</p>
          </div>
        </div>
      </GradientMain>
    )
  }

  // Chưa có dữ liệu nào (cache lẫn API đều chưa xong) — lần đầu ghé trang,
  // không có gì để hiện ngay nên mới cho xem spinner toàn trang.
  if (!order) {
    return (
      <GradientMain>
        <div className="w-full max-w-sm mx-auto py-10">
          <BrandHeader />
          <div className="flex flex-col items-center justify-center gap-3 text-stone-400 text-sm py-6">
            <Spinner className="w-8 h-8 border-[3px]" />
            Đang tải đơn hàng...
          </div>
        </div>
      </GradientMain>
    )
  }

  const isExpired = expired || order.status === 'EXPIRED'

  // Đơn đã có kết quả cuối — không cần hiện QR nữa
  if (order.status === 'PAID') {
    return (
      <>
        <Head>
          <title>Đã thanh toán · Momo Dev</title>
        </Head>
        <GradientMain>
          <div className="w-full max-w-sm mx-auto animate-[fadeIn_0.3s_ease]">
            <BrandHeader />
            <OrderMeta order={order} />
            <div className={`rounded-3xl bg-stone-900 px-6 py-8 text-center relative overflow-hidden ${CARD_SHADOW}`}>
              <div className="absolute -right-8 -top-10 w-40 h-40 rounded-full bg-emerald-500/20 blur-2xl" />
              <div className="relative w-14 h-14 rounded-full bg-emerald-500/15 mx-auto mb-4 flex items-center justify-center text-2xl text-emerald-400">✓</div>
              <h1 className="relative text-xl font-extrabold text-white mb-1">Thanh toán thành công</h1>
              <p className="relative text-3xl font-extrabold text-white tabular-nums mt-3">{formatVND(order.amount)}</p>
              {order.paidAt && (
                <p className="relative text-stone-400 text-xs mt-2">Lúc {formatTime(order.paidAt)}</p>
              )}
              <p className="relative text-stone-400 text-xs mt-3">Cảm ơn bạn đã thanh toán. Cửa hàng đã nhận được thông báo.</p>
            </div>
            {order.transId && (
              <div className="mt-3">
                <CopyField label="Mã giao dịch MoMo" value={order.transId} />
              </div>
            )}
            <TrustFooter />
          </div>
        </GradientMain>
      </>
    )
  }

  if (order.status === 'FAILED') {
    return (
      <>
        <Head>
          <title>Giao dịch thất bại · Momo Dev</title>
        </Head>
        <GradientMain>
          <div className="w-full max-w-sm mx-auto">
            <BrandHeader />
            <OrderMeta order={order} />
            <div className={`bg-white rounded-2xl p-8 text-center ${CARD_SHADOW}`}>
              <div className="w-14 h-14 rounded-full bg-rose-50 mx-auto mb-4 flex items-center justify-center text-2xl">✕</div>
              <h1 className="text-xl font-extrabold text-stone-900 mb-1">Giao dịch thất bại</h1>
              <p className="text-stone-500 text-sm mt-2">Đơn hàng này chưa được thanh toán thành công. Vui lòng liên hệ cửa hàng để được hỗ trợ tạo lại.</p>
            </div>
            <TrustFooter />
          </div>
        </GradientMain>
      </>
    )
  }

  if (isExpired) {
    return (
      <>
        <Head>
          <title>Hết hạn thanh toán · Momo Dev</title>
        </Head>
        <GradientMain>
          <div className="w-full max-w-sm mx-auto">
            <BrandHeader />
            <OrderMeta order={order} />
            <div className={`bg-white rounded-2xl p-8 text-center ${CARD_SHADOW}`}>
              <div className="w-14 h-14 rounded-full bg-stone-100 mx-auto mb-4 flex items-center justify-center text-2xl">⏱</div>
              <h1 className="text-xl font-extrabold text-stone-900 mb-1">Đã hết thời gian thanh toán</h1>
              <p className="text-stone-500 text-sm mt-2 mb-5">Mã QR cho đơn hàng này đã hết hạn sau 10 phút. Vui lòng liên hệ cửa hàng để được tạo lại đơn mới.</p>
              <button
                onClick={handleManualCheck}
                disabled={checking}
                className="w-full py-3 rounded-xl bg-stone-100 text-stone-700 text-sm font-semibold hover:bg-stone-200 active:scale-[0.98] transition-all duration-200 ease-out disabled:opacity-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-stone-300"
              >
                {checking ? 'Đang kiểm tra...' : 'Kiểm tra lại trạng thái'}
              </button>
            </div>
            <TrustFooter />
          </div>
        </GradientMain>
      </>
    )
  }

  // PENDING — hiện QR và thông tin chuyển khoản qua 2 tab (thay vì xếp chồng),
  // để toàn bộ nội dung vừa gọn trong 1 màn hình, không cần kéo xuống.
  const progressPct = remainingMs === null ? 100 : Math.max(0, Math.min(100, (remainingMs / ORDER_EXPIRE_MS) * 100))

  return (
    <>
      <Head>
        <title>Thanh toán đơn hàng · Momo Dev</title>
      </Head>
      <GradientMain tight>
        <div className="w-full max-w-md mx-auto">
          <BrandHeader />

          <SyncBanner message={syncMessage} />

          {/* Số tiền cần thanh toán — thẻ chính, chiếm trọng tâm thị giác */}
          <div className="rounded-3xl bg-stone-900 px-5 py-5 mb-3 relative overflow-hidden shadow-[0_20px_40px_-20px_rgba(33,26,29,0.45)]">
            <div className="absolute -right-8 -top-10 w-40 h-40 rounded-full bg-momo/25 blur-2xl" />
            <div className="absolute -left-10 -bottom-12 w-40 h-40 rounded-full bg-momo/10 blur-2xl" />
            <div className="relative flex items-end justify-between gap-3 flex-wrap">
              <div>
                <p className="text-[11px] font-medium uppercase tracking-wide text-stone-400 mb-1">
                  {order.orderInfo || 'Số tiền cần thanh toán'}
                </p>
                <p className="text-3xl sm:text-4xl font-extrabold text-white tabular-nums tracking-tight">
                  {formatVND(order.amount)}
                </p>
              </div>
              {remainingMs !== null && (
                <span className={`font-mono text-sm font-semibold tabular-nums shrink-0 ${remainingMs < 60000 ? 'text-rose-400' : 'text-stone-300'}`}>
                  ⏱ {formatCountdown(remainingMs)}
                </span>
              )}
            </div>
            {remainingMs !== null && (
              <div className="relative h-1 w-full rounded-full bg-white/10 overflow-hidden mt-3">
                <div
                  className={`h-full rounded-full transition-all duration-1000 ease-linear ${remainingMs < 60000 ? 'bg-rose-400' : 'bg-momo'}`}
                  style={{ width: `${progressPct}%` }}
                />
              </div>
            )}
          </div>

          <OrderMeta order={order} />

          <TabSwitcher active={activeTab} onChange={setActiveTab} />

          {/* Khung QR */}
          {activeTab === 'qr' && (
            <div className={`bg-white rounded-2xl p-5 text-center flex flex-col ${CARD_SHADOW}`}>
              <div className="flex items-center justify-between mb-4">
                <h2 className="font-bold text-stone-900">Quét mã QR</h2>
                <ReloadButton onClick={() => loadQr()} loading={qrLoading} label="Tải lại mã QR" />
              </div>

              {qrSrc ? (
                <img
                  src={qrSrc}
                  alt="Quét mã để thanh toán"
                  onError={handleQrImgError}
                  className="w-full max-w-[320px] aspect-square object-contain mx-auto rounded-xl border border-stone-100 mb-4 bg-white"
                />
              ) : qrFailed ? (
                <div className="flex flex-col items-center justify-center gap-3 py-14 mb-4">
                  <p className="text-sm text-stone-400">
                    Không tải được mã QR.
                  </p>
                  <button
                    onClick={() => loadQr()}
                    disabled={qrLoading}
                    className="text-xs font-semibold text-momo bg-momo/5 hover:bg-momo/10 active:scale-95 rounded-lg px-3 py-1.5 transition-all duration-200 ease-out disabled:opacity-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-momo/30"
                  >
                    {qrLoading ? 'Đang tải lại...' : 'Tải lại mã QR'}
                  </button>
                  <p className="text-[11px] text-stone-300">hoặc dùng thông tin chuyển khoản ở tab bên cạnh</p>
                </div>
              ) : (
                <div className="flex flex-col items-center justify-center gap-3 mb-4">
                  <div className="relative w-full max-w-[320px] aspect-square mx-auto">
                    <Skeleton className="w-full h-full" />
                    <div className="absolute inset-0 flex flex-col items-center justify-center gap-2">
                      <Spinner className="w-8 h-8 border-[3px]" />
                      <span className="text-xs text-stone-400">Đang tải mã QR...</span>
                    </div>
                  </div>
                </div>
              )}

              <p className="text-stone-500 text-sm mt-auto">
                Mở app ngân hàng bất kỳ hoặc app MoMo, quét mã QR để thanh toán
              </p>
            </div>
          )}

          {/* Khung thông tin chuyển khoản thủ công */}
          {activeTab === 'transfer' && (
            <div className={`bg-white rounded-2xl p-5 flex flex-col ${CARD_SHADOW}`}>
              <div className="flex items-center justify-between mb-4">
                <h2 className="font-bold text-stone-900">Thông tin chuyển khoản</h2>
                <ReloadButton onClick={() => loadTransferInfo()} loading={transferLoading} label="Tải lại thông tin chuyển khoản" />
              </div>

              {transferInfo ? (
                <div className="flex flex-col gap-2">
                  <CopyField
                    label={`Ngân hàng${transferInfo.bank?.name ? '' : ' (mã BIN)'}`}
                    value={transferInfo.bank?.name || transferInfo.bank?.bin || '—'}
                  />
                  <CopyField label="Số tài khoản" value={transferInfo.accountNumber} />
                  <CopyField label="Số tiền" value={formatVND(transferInfo.amount)} />
                  <CopyField label="Nội dung chuyển khoản" value={transferInfo.content} />
                  <p className="text-xs text-amber-700 bg-amber-50 rounded-xl px-3 py-2 mt-2">
                    ⚠ Nhập ĐÚNG nội dung chuyển khoản để hệ thống nhận diện đơn hàng.
                  </p>
                </div>
              ) : transferError ? (
                <div className="flex flex-col items-center justify-center gap-3 py-8">
                  <p className="text-sm text-rose-700 bg-rose-50 rounded-xl px-3 py-2 text-center">{transferError}</p>
                  <button
                    onClick={() => loadTransferInfo()}
                    disabled={transferLoading}
                    className="text-xs font-semibold text-momo bg-momo/5 hover:bg-momo/10 active:scale-95 rounded-lg px-3 py-1.5 transition-all duration-200 ease-out disabled:opacity-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-momo/30"
                  >
                    {transferLoading ? 'Đang tải lại...' : 'Tải lại thông tin'}
                  </button>
                </div>
              ) : (
                <div className="flex flex-col items-center justify-center gap-3 py-4">
                  <div className="w-full flex flex-col gap-2">
                    <Skeleton className="h-14" />
                    <Skeleton className="h-14" />
                    <Skeleton className="h-14" />
                    <Skeleton className="h-14" />
                  </div>
                  <div className="flex items-center gap-2 text-xs text-stone-400">
                    <Spinner className="w-3.5 h-3.5" />
                    Đang tải thông tin chuyển khoản...
                  </div>
                </div>
              )}
            </div>
          )}

          <button
            onClick={handleManualCheck}
            disabled={checking}
            className="w-full py-3.5 rounded-xl bg-momo text-white text-sm font-semibold shadow-[0_10px_20px_-10px_rgba(165,0,100,0.6)] hover:bg-momo-dark hover:shadow-[0_14px_24px_-10px_rgba(165,0,100,0.7)] active:scale-[0.98] transition-all duration-200 ease-out disabled:opacity-50 mt-4 flex items-center justify-center gap-2 focus:outline-none focus-visible:ring-2 focus-visible:ring-momo/40"
          >
            {checking && <Spinner className="w-4 h-4 border-white/40 border-t-white" />}
            {checking ? 'Đang kiểm tra...' : 'Kiểm tra kết quả'}
          </button>

          <div className="flex items-center justify-center gap-1.5 text-center text-stone-400 text-xs mt-3">
            {nextPollInMs !== null && (
              <span>Tự động kiểm tra lại sau {formatCountdown(nextPollInMs)}</span>
            )}
            {lastCheckedAt && (
              <>
                <span className="w-1 h-1 rounded-full bg-stone-300" />
                <span>Cập nhật lúc {formatClock(lastCheckedAt)}</span>
              </>
            )}
          </div>

          <TrustFooter />
        </div>
      </GradientMain>
    </>
  )
}