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

import { useEffect, useState } from 'react'

const STATUS_STYLE = {
  PENDING: 'bg-amber-50 text-amber-700',
  PAID: 'bg-emerald-50 text-emerald-700',
  FAILED: 'bg-red-50 text-red-700',
}

const STATUS_TEXT = {
  PENDING: 'Chờ thanh toán',
  PAID: 'Đã thanh toán',
  FAILED: 'Thất bại',
}

const TYPE_TEXT = {
  p2p: 'Khách tự quét (P2P)',
  scan: 'Quét mã khách (POS)',
}

// Bộ lọc trạng thái — mặc định chỉ hiện "Đã thanh toán" để tránh rối mắt
// giữa hàng chục đơn PENDING/FAILED mỗi ngày.
const STATUS_FILTERS = [
  { value: 'ALL', label: 'Tất cả' },
  { value: 'PAID', label: 'Đã thanh toán' },
  { value: 'PENDING', label: 'Chờ thanh toán' },
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
  { label: 'Thời gian thanh toán', get: (o) => (o.paidAt ? formatTime(o.paidAt) : null) },
  { label: 'Response time (MoMo)', get: (o) => o.responseTime },
  { label: 'Lỗi hệ thống', get: (o) => o.error },
]

function OrderDetail({ order }) {
  const rows = DETAIL_FIELDS
    .map(({ label, get }) => ({ label, value: get(order) }))
    .filter(({ value }) => value !== null && value !== undefined && value !== '')

  return (
    <div className="px-5 pb-4 pt-1 bg-neutral-50 border-t border-neutral-100">
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-2 text-xs mt-3">
        {rows.map(({ label, value }) => (
          <div key={label} className="flex justify-between gap-3 border-b border-neutral-100 py-1.5">
            <span className="text-neutral-400 shrink-0">{label}</span>
            <span className="text-neutral-800 font-mono text-right break-all">{value}</span>
          </div>
        ))}
      </div>

      {order.payUrl && (
        <a
          href={order.payUrl}
          target="_blank"
          rel="noreferrer"
          className="inline-block mt-3 text-xs text-momo hover:underline break-all"
        >
          🔗 Link thanh toán MoMo
        </a>
      )}

      <div className="mt-2">
        <a
          href={`/thanh-toan?orderId=${encodeURIComponent(order.orderId)}`}
          target="_blank"
          rel="noreferrer"
          className="inline-block text-xs text-neutral-500 hover:underline break-all"
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
    <main className="min-h-screen flex items-center justify-center px-4">
      <form onSubmit={handleSubmit} className="w-full max-w-xs bg-white rounded-2xl border border-neutral-200 p-6">
        <div className="w-12 h-12 rounded-xl bg-momo mx-auto mb-4 flex items-center justify-center text-white font-extrabold">
          M
        </div>
        <h1 className="text-lg font-bold text-neutral-900 text-center mb-1">Đăng nhập quản trị</h1>
        <p className="text-neutral-500 text-sm text-center mb-5">Nhập mật khẩu admin để tiếp tục</p>

        <input
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder="Mật khẩu"
          autoFocus
          className="w-full rounded-xl border border-neutral-200 px-4 py-3 mb-3 focus:outline-none focus:ring-2 focus:ring-momo/40 focus:border-momo"
          required
        />

        {error && <p className="text-sm text-red-600 bg-red-50 rounded-lg px-3 py-2 mb-3">{error}</p>}

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

// ─── TRANG CHÍNH ─────────────────────────────────────────────────────────
export default function QuanLyGiaoDich() {
  const [authed, setAuthed] = useState(null) // null = đang kiểm tra, true/false sau đó
  const [orders, setOrders] = useState([])
  const [search, setSearch] = useState('')
  const [statusFilter, setStatusFilter] = useState('PAID') // mặc định: đã thanh toán
  const [dateFilter, setDateFilter] = useState('today') // mặc định: hôm nay
  const [loading, setLoading] = useState(false)
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

  if (authed === null) {
    return <main className="min-h-screen flex items-center justify-center text-neutral-400 text-sm">Đang tải...</main>
  }

  if (authed === false) {
    return <LoginForm onSuccess={() => loadOrders()} />
  }

  return (
    <main className="min-h-screen px-6 py-8 bg-neutral-50">
      <div className="w-full">
        <div className="flex items-center justify-between mb-6 flex-wrap gap-3">
          <div>
            <h1 className="text-xl font-extrabold text-neutral-900">Quản lý giao dịch</h1>
            <p className="text-neutral-500 text-sm">
              {filteredOrders.length}/{orders.length} đơn hàng
            </p>
          </div>
          <div className="flex gap-2 flex-wrap">
            <div className="relative">
              <input
                type="text"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Tìm theo mã đơn..."
                className="rounded-xl border border-neutral-200 px-3 py-2 text-sm w-52 focus:outline-none focus:ring-2 focus:ring-momo/40 focus:border-momo"
              />
              {search && (
                <button
                  onClick={() => setSearch('')}
                  className="absolute right-2 top-1/2 -translate-y-1/2 text-neutral-400 hover:text-neutral-600 text-xs"
                  aria-label="Xóa tìm kiếm"
                >
                  ✕
                </button>
              )}
            </div>
            <a
              href="/tao-giao-dich"
              target="_blank"
              rel="noreferrer"
              className="px-4 py-2 rounded-xl bg-momo text-white text-sm font-semibold hover:bg-momo-dark transition"
            >
              Giao Dịch Mới
            </a>
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
                    ? 'bg-neutral-900 text-white'
                    : 'bg-white border border-neutral-200 text-neutral-600 hover:bg-neutral-100'
                }`}
              >
                {f.label}
              </button>
            ))}
          </div>
          <span className="w-px h-5 bg-neutral-200 mx-1 hidden sm:block" />
          <div className="flex gap-1.5 flex-wrap">
            {DATE_FILTERS.map((f) => (
              <button
                key={f.value}
                onClick={() => setDateFilter(f.value)}
                className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition ${
                  dateFilter === f.value
                    ? 'bg-momo text-white'
                    : 'bg-white border border-neutral-200 text-neutral-600 hover:bg-neutral-100'
                }`}
              >
                {f.label}
              </button>
            ))}
          </div>
        </div>

        {loading && <p className="text-neutral-400 text-sm mb-3">Đang tải...</p>}

        <div className="bg-white rounded-2xl border border-neutral-200 overflow-hidden">
          {filteredOrders.length === 0 && !loading && (
            <p className="text-center text-neutral-400 text-sm py-10">
              {orders.length === 0 ? 'Chưa có đơn hàng nào' : 'Không có đơn hàng nào khớp bộ lọc hiện tại'}
            </p>
          )}

          <div className="max-h-[65vh] overflow-y-auto">
            {filteredOrders.map((o) => {
              const isExpanded = expandedId === o.orderId
              return (
                <div key={o.orderId} className="border-b border-neutral-100 last:border-0">
                  <div className="flex items-center justify-between gap-3 px-5 py-4">
                    <button
                      onClick={() => toggleExpand(o.orderId)}
                      className="grid grid-cols-1 sm:grid-cols-[minmax(0,1fr)_180px_200px] items-center gap-2 sm:gap-6 min-w-0 text-left flex-1"
                    >
                      <span className="flex items-center gap-3 min-w-0">
                        <span className={`shrink-0 text-neutral-400 transition-transform ${isExpanded ? 'rotate-90' : ''}`}>
                          ▸
                        </span>
                        <span className="min-w-0">
                          <span className="flex items-center gap-2 mb-0.5">
                            <span className="font-mono text-xs text-neutral-400 truncate">{o.orderId}</span>
                            <span className={`text-xs font-semibold px-2 py-0.5 rounded-full shrink-0 ${STATUS_STYLE[o.status] || 'bg-neutral-100 text-neutral-600'}`}>
                              {STATUS_TEXT[o.status] || o.status}
                            </span>
                          </span>
                          <span className="block text-xs text-neutral-400 truncate">{o.orderInfo}</span>
                        </span>
                      </span>
                      <span className="hidden sm:block text-xs text-neutral-400 truncate">{formatTime(o.createdAt)}</span>
                      <span className="font-mono font-bold text-neutral-900 sm:text-right">{formatVND(o.amount)}</span>
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
                        className="px-3 py-1.5 rounded-lg bg-red-50 text-red-700 text-xs font-semibold hover:bg-red-100 transition disabled:opacity-50"
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
  )
}