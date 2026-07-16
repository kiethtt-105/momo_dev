// pages/quan-ly-giao-dich.js
//
// Trang ADMIN — gọi GET /api/momo/orders (không truyền orderId => yêu cầu
// session admin, theo đúng logic trong pages/api/momo/orders.js). Nếu
// chưa đăng nhập (401), hiện form gọi POST /api/admin/login. Sau khi có
// session, dùng POST /api/momo/cancel và DELETE /api/momo/delete để thao
// tác — cả 2 đều tự refresh session admin qua requireAdmin().
//
// Mỗi đơn hàng có nút mở rộng (▸) để xem TOÀN BỘ field admin mới thấy
// được (session admin trả full record, không phải bản "public" đã lược
// bớt như route orders.js trả cho khách).
//
// Giao diện đã đồng bộ với pages/index.js và pages/thanh-toan.js: nền
// #FAF7F5, thẻ trắng bo góc lớn dùng chung CARD_SHADOW, bảng màu
// stone/momo, badge trạng thái dạng chấm tròn, header logo "M".

import { useEffect, useState } from 'react'
import Head from 'next/head'

const CARD_SHADOW = 'shadow-[0_1px_2px_rgba(33,26,29,0.04),0_6px_16px_-10px_rgba(33,26,29,0.15)]'

// Cùng bảng màu + nhãn trạng thái (chấm tròn) với index.js / thanh-toan.js.
const STATUS_META = {
  PAID: { label: 'Thành công', dot: 'bg-emerald-500', text: 'text-emerald-700', chip: 'bg-emerald-50' },
  PENDING: { label: 'Đang chờ', dot: 'bg-amber-500', text: 'text-amber-700', chip: 'bg-amber-50' },
  FAILED: { label: 'Thất bại', dot: 'bg-rose-500', text: 'text-rose-700', chip: 'bg-rose-50' },
  EXPIRED: { label: 'Hết hạn', dot: 'bg-stone-400', text: 'text-stone-500', chip: 'bg-stone-100' },
}

function StatusBadge({ status }) {
  const meta = STATUS_META[status] || STATUS_META.EXPIRED
  return (
    <span className={`inline-flex items-center gap-1.5 text-xs font-medium ${meta.text} shrink-0`}>
      <span className={`w-1.5 h-1.5 rounded-full ${meta.dot}`} />
      {meta.label}
    </span>
  )
}

const TYPE_TEXT = {
  p2p: 'Khách tự quét (P2P)',
  scan: 'Quét mã khách (POS)',
}

// Bộ lọc trạng thái — mặc định chỉ hiện "Thành công" để tránh rối mắt
// giữa hàng chục đơn PENDING/FAILED mỗi ngày.
const STATUS_FILTERS = [
  { value: 'ALL', label: 'Tất cả' },
  { value: 'PAID', label: 'Thành công' },
  { value: 'PENDING', label: 'Đang chờ' },
  { value: 'FAILED', label: 'Thất bại' },
]

// Bộ lọc thời gian — mặc định "Hôm nay"
const DATE_FILTERS = [
  { value: 'today', label: 'Hôm nay' },
  { value: '7d', label: '7 ngày qua' },
  { value: '30d', label: '30 ngày qua' },
  { value: 'all', label: 'Tất cả' },
]

function isSameCalendarDay(a, b) {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate()
}

function matchesDateFilter(order, dateFilter) {
  if (dateFilter === 'all') return true
  if (!order.createdAt) return false
  const created = new Date(order.createdAt)
  const now = new Date()
  if (dateFilter === 'today') return isSameCalendarDay(created, now)
  if (dateFilter === '7d') return now.getTime() - created.getTime() <= 7 * 24 * 60 * 60 * 1000
  if (dateFilter === '30d') return now.getTime() - created.getTime() <= 30 * 24 * 60 * 60 * 1000
  return true
}

function formatVND(n) {
  const num = Number(n)
  if (Number.isNaN(num)) return n
  return num.toLocaleString('vi-VN') + ' đ'
}

function formatTime(iso) {
  if (!iso) return '—'
  const d = new Date(iso)
  return d.toLocaleString('vi-VN', { hour: '2-digit', minute: '2-digit', second: '2-digit', day: '2-digit', month: '2-digit', year: 'numeric' })
}

function formatDurationMs(ms) {
  const n = Number(ms)
  if (!n || Number.isNaN(n)) return null
  const minutes = Math.round(n / 60000)
  return `${minutes} phút`
}

// Danh sách field hiển thị trong phần mở rộng — label + cách lấy giá trị.
// Field nào rỗng/undefined sẽ tự ẩn, không hiện dòng "—" rối mắt.
const DETAIL_FIELDS = [
  { label: 'Loại giao dịch', get: (o) => TYPE_TEXT[o.type] || o.type },
  { label: 'Nguồn', get: (o) => o.source },
  { label: 'Mã giao dịch MoMo (transId)', get: (o) => o.transId },
  { label: 'Phương thức (payType)', get: (o) => o.payType },
  { label: 'Loại ví (paymentOption)', get: (o) => o.paymentOption },
  { label: 'Result code', get: (o) => (o.resultCode !== undefined && o.resultCode !== null ? String(o.resultCode) : null) },
  { label: 'Thông báo từ MoMo', get: (o) => o.message },
  { label: 'Cửa hàng', get: (o) => (o.storeName ? `${o.storeName}${o.storeId ? ` (${o.storeId})` : ''}` : o.storeId) },
  { label: 'Đối tác hiển thị', get: (o) => o.partnerName },
  { label: 'Request ID', get: (o) => o.requestId },
  { label: 'Order type (MoMo)', get: (o) => o.orderType },
  { label: 'Mã đã quét (POS)', get: (o) => o.submittedCode },
  { label: 'Thời gian tạo đơn', get: (o) => (o.createdAt ? formatTime(o.createdAt) : null) },
  { label: 'Thời gian thanh toán', get: (o) => (o.paidAt ? formatTime(o.paidAt) : null) },
  { label: 'Hết hạn lúc', get: (o) => (o.expiresAt ? formatTime(o.expiresAt) : null) },
  { label: 'Thời hạn giao dịch', get: (o) => formatDurationMs(o.orderExpireMs) },
  { label: 'Response time (MoMo)', get: (o) => o.responseTime },
  { label: 'Extra data (MoMo)', get: (o) => o.extraData },
  { label: 'Lỗi hệ thống', get: (o) => o.error },
]

// Các đường link mở tab mới hiển thị trong phần chi tiết — field nào có
// giá trị mới hiện, không cứng hiện đủ 4 link như trước (chỉ payUrl).
const DETAIL_LINKS = [
  { label: '🔗 Link thanh toán MoMo (payUrl)', get: (o) => o.payUrl },
  { label: '🔗 Deeplink MoMo', get: (o) => o.deeplink },
  { label: '🔗 Applink MoMo', get: (o) => o.applink },
  { label: '🔗 Deeplink Mini App', get: (o) => o.deeplinkMiniApp },
  { label: '🔗 QR code URL (gốc)', get: (o) => o.qrCodeUrl },
]

function OrderDetail({ order }) {
  const rows = DETAIL_FIELDS
    .map(({ label, get }) => ({ label, value: get(order) }))
    .filter(({ value }) => value !== null && value !== undefined && value !== '')

  return (
    <div className="px-5 pb-4 pt-1 bg-stone-50 border-t border-stone-100">
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-2 text-xs mt-3">
        {rows.map(({ label, value }) => (
          <div key={label} className="flex justify-between gap-3 border-b border-stone-100 py-1.5">
            <span className="text-stone-400 shrink-0">{label}</span>
            <span className="text-stone-800 font-mono text-right break-all">{value}</span>
          </div>
        ))}
      </div>

      {order.qrCodeImage && (
        <img
          src={order.qrCodeImage}
          alt="QR MoMo"
          className="mt-3 w-28 h-28 rounded-lg border border-stone-200 bg-white p-1"
        />
      )}

      <div className="mt-2 flex flex-col gap-1.5">
        {DETAIL_LINKS
          .map(({ label, get }) => ({ label, url: get(order) }))
          .filter(({ url }) => !!url)
          .map(({ label, url }) => (
            <a
              key={label}
              href={url}
              target="_blank"
              rel="noreferrer"
              className="inline-block text-xs text-momo hover:underline break-all"
            >
              {label}
            </a>
          ))}

        <a
          href={`/thanh-toan?orderId=${encodeURIComponent(order.orderId)}`}
          target="_blank"
          rel="noreferrer"
          className="inline-block text-xs text-stone-500 hover:underline break-all"
        >
          🔗 Link trang thanh toán gửi khách
        </a>
      </div>
    </div>
  )
}

// ─── FORM ĐĂNG NHẬP ─────────────────────────────────────────────────────
function LoginForm({ onSuccess }) {
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

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
      const data = await res.json()
      if (!res.ok) {
        setError(data.error || 'Đăng nhập thất bại')
        return
      }
      onSuccess()
    } catch {
      setError('Lỗi kết nối, thử lại sau')
    } finally {
      setLoading(false)
    }
  }

  return (
    <main className="min-h-screen bg-[#FAF7F5] flex items-center justify-center px-4">
      <form onSubmit={handleSubmit} className={`w-full max-w-xs bg-white rounded-3xl p-6 ${CARD_SHADOW}`}>
        <div className="w-12 h-12 rounded-2xl bg-momo mx-auto mb-4 flex items-center justify-center text-white font-extrabold shadow-[0_6px_16px_-6px_rgba(165,0,100,0.55)]">
          M
        </div>
        <h1 className="text-lg font-bold text-stone-900 text-center mb-1">Đăng nhập quản trị</h1>
        <p className="text-stone-500 text-sm text-center mb-5">Nhập mật khẩu admin để tiếp tục</p>

        <input
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder="Mật khẩu"
          autoFocus
          className="w-full rounded-xl border border-stone-200 px-4 py-3 mb-3 focus:outline-none focus:ring-2 focus:ring-momo/40 focus:border-momo"
          required
        />

        {error && <p className="text-sm text-rose-700 bg-rose-50 rounded-lg px-3 py-2 mb-3">{error}</p>}

        <button
          type="submit"
          disabled={loading}
          className="w-full py-3 rounded-xl bg-momo text-white font-semibold shadow-[0_10px_20px_-10px_rgba(165,0,100,0.6)] hover:bg-momo-dark transition disabled:opacity-50"
        >
          {loading ? 'Đang kiểm tra...' : 'Đăng nhập'}
        </button>
      </form>
    </main>
  )
}

// ─── TRANG CHÍNH ─────────────────────────────────────────────────────────
export default function QuanLyGiaoDich() {
  const [authed, setAuthed] = useState(null) // null = đang kiểm tra, true/false sau đó
  const [orders, setOrders] = useState([])
  const [search, setSearch] = useState('')
  const [statusFilter, setStatusFilter] = useState('PAID') // mặc định: đã thanh toán
  const [dateFilter, setDateFilter] = useState('today') // mặc định: hôm nay
  const [loading, setLoading] = useState(false)
  const [refreshingPending, setRefreshingPending] = useState(false)
  const [actionId, setActionId] = useState('') // orderId đang xử lý cancel/delete
  const [expandedId, setExpandedId] = useState('') // orderId đang mở rộng chi tiết

  async function loadOrders() {
    setLoading(true)
    try {
      const res = await fetch('/api/momo/orders', { credentials: 'include' })
      if (res.status === 401) {
        setAuthed(false)
        return
      }
      const data = await res.json()
      setOrders(data.orders || [])
      setAuthed(true)
    } catch {
      setAuthed(false)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    loadOrders()
  }, [])

  function toggleExpand(orderId) {
    setExpandedId((cur) => (cur === orderId ? '' : orderId))
  }

  async function handleCancel(orderId) {
    setActionId(orderId)
    try {
      await fetch('/api/momo/cancel', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ orderId }),
      })
      await loadOrders()
    } finally {
      setActionId('')
    }
  }

  async function handleDelete(orderId) {
    if (!confirm(`Xóa hẳn đơn hàng ${orderId}? Không thể hoàn tác.`)) return
    setActionId(orderId)
    try {
      await fetch('/api/momo/delete', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ orderId }),
      })
      await loadOrders()
    } finally {
      setActionId('')
    }
  }

  // Khi đang gõ tìm theo mã đơn: tìm xuyên suốt tất cả trạng thái/thời gian.
  // Khi ô tìm trống: áp dụng bộ lọc trạng thái + thời gian đang chọn.
  const searchQuery = search.trim().toLowerCase()
  const filteredOrders = orders.filter((o) => {
    if (searchQuery) return o.orderId.toLowerCase().includes(searchQuery)
    if (statusFilter !== 'ALL' && o.status !== statusFilter) return false
    if (!matchesDateFilter(o, dateFilter)) return false
    return true
  })

  const pendingOrders = orders.filter((o) => o.status === 'PENDING')

  // Phạm vi cho khối thống kê: theo tìm kiếm + bộ lọc thời gian, KHÔNG
  // theo bộ lọc trạng thái — để luôn thấy đủ bức tranh (bao nhiêu đơn mỗi
  // trạng thái) dù đang chỉ xem 1 trạng thái trong bảng bên dưới.
  const statsScopeOrders = orders.filter((o) => {
    if (searchQuery) return o.orderId.toLowerCase().includes(searchQuery)
    return matchesDateFilter(o, dateFilter)
  })
  const stats = statsScopeOrders.reduce(
    (acc, o) => {
      acc.total += 1
      if (o.status === 'PAID') {
        acc.paidCount += 1
        acc.revenue += Number(o.amount) || 0
      } else if (o.status === 'PENDING') acc.pendingCount += 1
      else if (o.status === 'FAILED') acc.failedCount += 1
      return acc
    },
    { total: 0, paidCount: 0, pendingCount: 0, failedCount: 0, revenue: 0 }
  )

  // Tra cứu lại TỪNG đơn đang "Đang chờ" — dùng để cập nhật thủ công
  // phòng trường hợp IPN từ MoMo bị rớt, hệ thống không tự trả kết quả.
  async function handleRefreshPending() {
    if (pendingOrders.length === 0 || refreshingPending) return
    setRefreshingPending(true)
    try {
      const results = await Promise.all(
        pendingOrders.map(async ({ orderId }) => {
          try {
            const res = await fetch(`/api/momo/orders?orderId=${encodeURIComponent(orderId)}`, {
              credentials: 'include',
            })
            const data = await res.json()
            return (data.orders || []).find((o) => o.orderId === orderId) || null
          } catch {
            return null
          }
        })
      )
      setOrders((cur) =>
        cur.map((o) => {
          const updated = results.find((r) => r && r.orderId === o.orderId)
          return updated ? { ...o, ...updated } : o
        })
      )
    } finally {
      setRefreshingPending(false)
    }
  }

  if (authed === null) {
    return (
      <main className="min-h-screen bg-[#FAF7F5] flex items-center justify-center text-stone-400 text-sm">
        Đang tải...
      </main>
    )
  }

  if (authed === false) {
    return <LoginForm onSuccess={() => loadOrders()} />
  }

  return (
    <>
      <Head>
        <title>Quản lý giao dịch · Momo Dev</title>
      </Head>
      <main className="min-h-screen bg-[#FAF7F5] px-4 sm:px-6 py-8">
        <div className="w-full max-w-6xl mx-auto">
          {/* Header — cùng logo thương hiệu với các trang khác */}
          <div className="flex items-center justify-between mb-6 flex-wrap gap-4">
            <div className="flex items-center gap-3">
              <div className="w-11 h-11 shrink-0 rounded-2xl bg-momo flex items-center justify-center text-white font-extrabold text-lg shadow-[0_6px_16px_-6px_rgba(165,0,100,0.55)]">
                M
              </div>
              <div>
                <h1 className="text-lg font-extrabold text-stone-900 leading-tight tracking-tight">Quản lý giao dịch</h1>
                <p className="text-stone-400 text-xs">
                  {filteredOrders.length}/{orders.length} đơn hàng
                </p>
              </div>
            </div>
            <div className="flex gap-2 flex-wrap">
              <div className="relative">
                <input
                  type="text"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Tìm theo mã đơn..."
                  className={`rounded-xl bg-white px-3 py-2 text-sm w-52 focus:outline-none focus:ring-2 focus:ring-momo/40 ${CARD_SHADOW}`}
                />
                {search && (
                  <button
                    onClick={() => setSearch('')}
                    className="absolute right-2 top-1/2 -translate-y-1/2 text-stone-400 hover:text-stone-600 text-xs"
                    aria-label="Xóa tìm kiếm"
                  >
                    ✕
                  </button>
                )}
              </div>
              <button
                onClick={handleRefreshPending}
                disabled={pendingOrders.length === 0 || refreshingPending}
                className={`px-4 py-2 rounded-xl bg-white text-stone-700 text-sm font-semibold hover:bg-stone-50 transition disabled:opacity-50 disabled:cursor-not-allowed ${CARD_SHADOW}`}
              >
                {refreshingPending
                  ? '⟳ Đang cập nhật...'
                  : `⟳ Cập nhật trạng thái${pendingOrders.length > 0 ? ` (${pendingOrders.length} đang chờ)` : ''}`}
              </button>
              <a
                href="/tao-giao-dich"
                target="_blank"
                rel="noreferrer"
                className="px-4 py-2 rounded-xl bg-momo text-white text-sm font-semibold shadow-[0_10px_20px_-10px_rgba(165,0,100,0.6)] hover:bg-momo-dark transition"
              >
                Giao Dịch Mới
              </a>
            </div>
          </div>

          {/* Khối thống kê tổng quan — theo phạm vi tìm kiếm + bộ lọc thời gian
              hiện tại (không đổi theo bộ lọc trạng thái, xem ghi chú ở statsScopeOrders) */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-4">
            <div className={`bg-white rounded-2xl px-4 py-3 ${CARD_SHADOW}`}>
              <p className="text-stone-400 text-xs mb-1">Tổng số đơn</p>
              <p className="text-xl font-extrabold text-stone-900 tabular-nums">{stats.total}</p>
            </div>
            <div className={`bg-white rounded-2xl px-4 py-3 ${CARD_SHADOW}`}>
              <p className="text-stone-400 text-xs mb-1">Doanh thu (thành công)</p>
              <p className="text-xl font-extrabold text-emerald-700 tabular-nums">{formatVND(stats.revenue)}</p>
              <p className="text-stone-400 text-[11px] mt-0.5">{stats.paidCount} đơn</p>
            </div>
            <div className={`bg-white rounded-2xl px-4 py-3 ${CARD_SHADOW}`}>
              <p className="text-stone-400 text-xs mb-1">Đang chờ</p>
              <p className="text-xl font-extrabold text-amber-700 tabular-nums">{stats.pendingCount}</p>
            </div>
            <div className={`bg-white rounded-2xl px-4 py-3 ${CARD_SHADOW}`}>
              <p className="text-stone-400 text-xs mb-1">Thất bại</p>
              <p className="text-xl font-extrabold text-rose-700 tabular-nums">{stats.failedCount}</p>
            </div>
          </div>

          {/* Thanh lọc trạng thái + thời gian — vô hiệu khi đang tìm theo mã đơn */}
          <div className={`flex flex-wrap items-center gap-2 mb-4 ${search ? 'opacity-40 pointer-events-none' : ''}`}>
            <div className="flex gap-1.5 flex-wrap">
              {STATUS_FILTERS.map((f) => (
                <button
                  key={f.value}
                  onClick={() => setStatusFilter(f.value)}
                  className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition ${
                    statusFilter === f.value
                      ? 'bg-stone-900 text-white'
                      : `bg-white text-stone-600 hover:bg-stone-50 ${CARD_SHADOW}`
                  }`}
                >
                  {f.label}
                </button>
              ))}
            </div>
            <span className="w-px h-5 bg-stone-200 mx-1 hidden sm:block" />
            <div className="flex gap-1.5 flex-wrap">
              {DATE_FILTERS.map((f) => (
                <button
                  key={f.value}
                  onClick={() => setDateFilter(f.value)}
                  className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition ${
                    dateFilter === f.value
                      ? 'bg-momo text-white'
                      : `bg-white text-stone-600 hover:bg-stone-50 ${CARD_SHADOW}`
                  }`}
                >
                  {f.label}
                </button>
              ))}
            </div>
          </div>

          {loading && <p className="text-stone-400 text-sm mb-3">Đang tải...</p>}

          <div className={`bg-white rounded-2xl overflow-hidden ${CARD_SHADOW}`}>
            {filteredOrders.length === 0 && !loading && (
              <p className="text-center text-stone-400 text-sm py-10">
                {orders.length === 0 ? 'Chưa có đơn hàng nào' : 'Không có đơn hàng nào khớp bộ lọc hiện tại'}
              </p>
            )}

            <div className="max-h-[65vh] overflow-y-auto divide-y divide-stone-100">
              {filteredOrders.map((o) => {
                const isExpanded = expandedId === o.orderId
                return (
                  <div key={o.orderId}>
                    <div className="flex items-center justify-between gap-3 px-5 py-4">
                      <button
                        onClick={() => toggleExpand(o.orderId)}
                        className="grid grid-cols-1 sm:grid-cols-[minmax(0,1fr)_180px_200px] items-center gap-2 sm:gap-6 min-w-0 text-left flex-1"
                      >
                        <span className="flex items-center gap-3 min-w-0">
                          <span className={`shrink-0 text-stone-400 transition-transform ${isExpanded ? 'rotate-90' : ''}`}>
                            ▸
                          </span>
                          <span className="min-w-0">
                            <span className="flex items-center gap-2 mb-0.5 flex-wrap">
                              <span className="font-mono text-xs text-stone-400 truncate">{o.orderId}</span>
                              <StatusBadge status={o.status} />
                              {o.type && (
                                <span className="text-[10px] font-medium text-stone-400 bg-stone-100 rounded px-1.5 py-0.5 shrink-0">
                                  {TYPE_TEXT[o.type] || o.type}
                                </span>
                              )}
                            </span>
                            <span className="block text-xs text-stone-400 truncate">{o.orderInfo}</span>
                          </span>
                        </span>
                        <span className="hidden sm:block text-xs text-stone-400 truncate">{formatTime(o.createdAt)}</span>
                        <span className="font-mono font-bold text-stone-900 tabular-nums sm:text-right">{formatVND(o.amount)}</span>
                      </button>

                      <div className="flex gap-2 shrink-0">
                        {o.status === 'PENDING' && (
                          <button
                            onClick={() => handleCancel(o.orderId)}
                            disabled={actionId === o.orderId}
                            className="px-3 py-1.5 rounded-lg bg-amber-50 text-amber-700 text-xs font-semibold hover:bg-amber-100 transition disabled:opacity-50"
                          >
                            Hủy
                          </button>
                        )}
                        <button
                          onClick={() => handleDelete(o.orderId)}
                          disabled={actionId === o.orderId}
                          className="px-3 py-1.5 rounded-lg bg-rose-50 text-rose-700 text-xs font-semibold hover:bg-rose-100 transition disabled:opacity-50"
                        >
                          Xóa
                        </button>
                      </div>
                    </div>

                    {isExpanded && <OrderDetail order={o} />}
                  </div>
                )
              })}
            </div>
          </div>
        </div>
      </main>
    </>
  )
}