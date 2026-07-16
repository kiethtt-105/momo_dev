// pages/index.js
//
// Trang chủ. Không tự xử lý đăng nhập nữa — pages/_app.js đã chặn truy cập
// ở tầng toàn cục, tới được đây nghĩa là đã có session admin.
//
// BẢN VIẾT LẠI HOÀN TOÀN — bố cục chia đôi màn hình:
// - Cột trái (dark rail, cố định trên desktop): nhận diện thương hiệu,
//   2 nút hành động chính, và tổng quan doanh thu/đơn hôm nay luôn hiển thị.
// - Cột phải: 2 tab — "Tổng quan" (số liệu + biểu đồ doanh thu 7 ngày +
//   giao dịch gần nhất) và "Giao dịch" (toàn bộ danh sách, lọc theo trạng
//   thái + tìm kiếm). Dữ liệu vẫn lấy từ /api/momo/orders (không có route mới).
import { useEffect, useMemo, useState } from 'react'
import Head from 'next/head'
import Link from 'next/link'

const currency = new Intl.NumberFormat('vi-VN', { style: 'currency', currency: 'VND', maximumFractionDigits: 0 })
const WEEKDAY_LABELS = ['CN', 'T2', 'T3', 'T4', 'T5', 'T6', 'T7']

function isSameDay(a, b) {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate()
}

function isToday(iso) {
  if (!iso) return false
  return isSameDay(new Date(iso), new Date())
}

function timeAgo(iso) {
  if (!iso) return ''
  const diffSec = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 1000))
  if (diffSec < 60) return 'vừa xong'
  if (diffSec < 3600) return `${Math.floor(diffSec / 60)} phút trước`
  if (diffSec < 86400) return `${Math.floor(diffSec / 3600)} giờ trước`
  return new Date(iso).toLocaleDateString('vi-VN')
}

// Bảng màu theo trạng thái — chấm tròn đặc cho trạng thái "sống" (đang chờ),
// nhạt hơn cho trạng thái đã kết thúc.
const STATUS_META = {
  PAID: { label: 'Thành công', dot: 'bg-emerald-500', text: 'text-emerald-700', chip: 'bg-emerald-50' },
  PENDING: { label: 'Đang chờ', dot: 'bg-amber-500', text: 'text-amber-700', chip: 'bg-amber-50' },
  FAILED: { label: 'Thất bại', dot: 'bg-rose-500', text: 'text-rose-700', chip: 'bg-rose-50' },
  EXPIRED: { label: 'Hết hạn', dot: 'bg-stone-400', text: 'text-stone-500', chip: 'bg-stone-100' },
}

function StatusBadge({ status }) {
  const meta = STATUS_META[status] || STATUS_META.EXPIRED
  return (
    <span className={`inline-flex items-center gap-1.5 text-xs font-medium ${meta.text}`}>
      <span className={`w-1.5 h-1.5 rounded-full ${meta.dot}`} />
      {meta.label}
    </span>
  )
}

// Doanh thu 7 ngày gần nhất (chỉ tính đơn PAID), dùng cho biểu đồ cột nhỏ ở tab Tổng quan.
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

function SidebarStat({ label, value, dot }) {
  return (
    <div className="flex items-center justify-between py-2.5 border-b border-white/[0.06] last:border-0">
      <span className="flex items-center gap-2 text-xs text-stone-400">
        {dot && <span className={`w-1.5 h-1.5 rounded-full ${dot}`} />}
        {label}
      </span>
      <span className="text-sm font-semibold text-white tabular-nums">{value}</span>
    </div>
  )
}

function StatCard({ label, value, accent }) {
  return (
    <div className="rounded-2xl bg-white px-5 py-4 shadow-[0_1px_2px_rgba(33,26,29,0.04),0_6px_16px_-10px_rgba(33,26,29,0.15)]">
      <p className="text-[11px] font-medium uppercase tracking-wide text-stone-400 mb-1.5">{label}</p>
      <p className={`text-2xl font-extrabold tabular-nums ${accent === 'amber' ? 'text-amber-600' : 'text-stone-900'}`}>
        {value}
      </p>
    </div>
  )
}

function TransactionList({ orders, list, emptyLabel = 'Chưa có giao dịch nào.' }) {
  if (orders === null) {
    return (
      <div className="space-y-2">
        {[0, 1, 2].map((i) => (
          <div key={i} className="h-14 rounded-2xl bg-stone-100 animate-pulse" />
        ))}
      </div>
    )
  }

  if (list.length === 0) {
    return (
      <div className="rounded-2xl border border-dashed border-stone-300 px-4 py-8 text-center">
        <p className="text-sm text-stone-500">{emptyLabel}</p>
      </div>
    )
  }

  return (
    <div className="rounded-2xl bg-white overflow-hidden divide-y divide-stone-100 shadow-[0_1px_2px_rgba(33,26,29,0.04),0_6px_16px_-10px_rgba(33,26,29,0.15)]">
      {list.map((o) => {
        const meta = STATUS_META[o.status] || STATUS_META.EXPIRED
        return (
          <div key={o.orderId} className="flex items-center gap-3 px-4 py-3">
            <span className={`shrink-0 w-8 h-8 rounded-full flex items-center justify-center ${meta.chip}`}>
              <span className={`w-2 h-2 rounded-full ${meta.dot}`} />
            </span>
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium text-stone-900 truncate">{o.orderInfo || o.orderId}</p>
              <div className="flex items-center gap-2 mt-0.5">
                <StatusBadge status={o.status} />
                <span className="text-xs text-stone-300">·</span>
                <span className="text-xs text-stone-400">{timeAgo(o.createdAt)}</span>
              </div>
            </div>
            <div className="text-sm font-semibold text-stone-900 tabular-nums whitespace-nowrap">
              {currency.format(parseInt(o.amount) || 0)}
            </div>
          </div>
        )
      })}
    </div>
  )
}

export default function Home() {
  const [orders, setOrders] = useState(null)
  const [error, setError] = useState(null)
  const [tab, setTab] = useState('overview')
  const [statusFilter, setStatusFilter] = useState('ALL')
  const [query, setQuery] = useState('')

  useEffect(() => {
    let cancelled = false
    fetch('/api/momo/orders')
      .then((res) => {
        if (!res.ok) throw new Error('Không tải được danh sách giao dịch')
        return res.json()
      })
      .then((data) => { if (!cancelled) setOrders(data.orders || []) })
      .catch((err) => { if (!cancelled) setError(err.message) })
    return () => { cancelled = true }
  }, [])

  const today = (orders || []).filter((o) => isToday(o.createdAt))
  const todayPaid = today.filter((o) => o.status === 'PAID')
  const todayPending = today.filter((o) => o.status === 'PENDING')
  const todayRevenue = todayPaid.reduce((sum, o) => sum + (parseInt(o.amount) || 0), 0)
  const todayDecided = today.filter((o) => o.status === 'PAID' || o.status === 'FAILED')
  const successRate = todayDecided.length ? Math.round((todayPaid.length / todayDecided.length) * 100) : null
  const recent = (orders || []).slice(0, 6)

  const chartDays = useMemo(() => last7Days(orders || []), [orders])
  const chartMax = Math.max(...chartDays.map((d) => d.revenue), 1)

  const statusCounts = useMemo(() => {
    const counts = { ALL: (orders || []).length, PAID: 0, PENDING: 0, FAILED: 0, EXPIRED: 0 }
    ;(orders || []).forEach((o) => {
      if (counts[o.status] !== undefined) counts[o.status] += 1
    })
    return counts
  }, [orders])

  const filtered = (orders || []).filter((o) => {
    if (statusFilter !== 'ALL' && o.status !== statusFilter) return false
    if (query.trim()) {
      const q = query.trim().toLowerCase()
      return (o.orderId || '').toLowerCase().includes(q) || (o.orderInfo || '').toLowerCase().includes(q)
    }
    return true
  })

  return (
    <>
      <Head>
        <title>Momo Dev</title>
        <meta name="description" content="Cổng thanh toán MoMo" />
      </Head>

      <div className="min-h-screen bg-[#FAF7F5] lg:flex">
        {/* CỘT TRÁI — nhận diện + hành động chính + tổng quan luôn hiển thị */}
        <aside className="lg:w-80 lg:shrink-0 bg-stone-900 text-white px-6 py-8 lg:min-h-screen lg:sticky lg:top-0 lg:h-screen lg:overflow-y-auto relative overflow-hidden">
          <div className="absolute -right-16 -top-20 w-56 h-56 rounded-full bg-momo/20 blur-3xl pointer-events-none" />
          <div className="absolute -left-20 bottom-0 w-56 h-56 rounded-full bg-momo/10 blur-3xl pointer-events-none" />

          <div className="relative flex items-center gap-3 mb-8">
            <div className="w-11 h-11 shrink-0 rounded-2xl bg-momo flex items-center justify-center text-white font-extrabold text-lg shadow-[0_6px_16px_-6px_rgba(165,0,100,0.55)]">
              M
            </div>
            <div>
              <h1 className="text-lg font-extrabold leading-tight tracking-tight">Momo Dev</h1>
              <p className="text-stone-400 text-xs">
                {new Date().toLocaleDateString('vi-VN', { weekday: 'long', day: '2-digit', month: '2-digit', year: 'numeric' })}
              </p>
            </div>
          </div>

          <div className="relative flex flex-col sm:flex-row lg:flex-col gap-3 mb-8">
            <Link
              href="/tao-giao-dich"
              target="_blank" rel="noopener noreferrer"
              className="flex-1 text-center py-3 rounded-xl bg-momo text-white text-sm font-semibold shadow-[0_10px_20px_-10px_rgba(165,0,100,0.6)] hover:bg-momo-dark transition"
            >
              Tạo giao dịch
            </Link>
            <Link
              href="/quan-ly-giao-dich"
              target="_blank" rel="noopener noreferrer"
              className="flex-1 text-center py-3 rounded-xl bg-white/10 text-white text-sm font-semibold hover:bg-white/[0.15] transition"
            >
              Quản lý giao dịch
            </Link>
          </div>

          <div className="relative">
            <p className="text-[11px] font-medium uppercase tracking-wide text-stone-500 mb-1">Doanh thu hôm nay</p>
            <p className="text-3xl font-extrabold tabular-nums mb-4">
              {orders === null ? '—' : currency.format(todayRevenue)}
            </p>
            <SidebarStat label="Đơn hôm nay" value={orders === null ? '—' : today.length} />
            <SidebarStat label="Đang chờ" value={orders === null ? '—' : todayPending.length} dot="bg-amber-500" />
            <SidebarStat label="Tỷ lệ thành công" value={orders === null ? '—' : successRate === null ? '—' : `${successRate}%`} dot="bg-emerald-500" />
          </div>
        </aside>

        {/* CỘT PHẢI — nội dung theo tab */}
        <main className="flex-1 px-4 py-8 sm:px-8 sm:py-10 lg:px-12 lg:py-12">
          <div className="max-w-4xl mx-auto lg:mx-0">
            {error && (
              <div className="mb-6 rounded-xl bg-rose-50 px-4 py-3 text-sm text-rose-700">
                {error} — thử tải lại trang.
              </div>
            )}

            <div className="flex items-center gap-2 mb-8 border-b border-stone-200">
              {[
                { key: 'overview', label: 'Tổng quan' },
                { key: 'transactions', label: 'Giao dịch' },
              ].map((t) => (
                <button
                  key={t.key}
                  onClick={() => setTab(t.key)}
                  className={`px-4 py-2.5 text-sm font-semibold border-b-2 -mb-px transition ${
                    tab === t.key ? 'border-momo text-momo' : 'border-transparent text-stone-400 hover:text-stone-600'
                  }`}
                >
                  {t.label}
                </button>
              ))}
            </div>

            {tab === 'overview' && (
              <div>
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mb-8">
                  <StatCard label="Đơn hôm nay" value={orders === null ? '—' : today.length} />
                  <StatCard
                    label="Đang chờ"
                    value={orders === null ? '—' : todayPending.length}
                    accent={todayPending.length > 0 ? 'amber' : undefined}
                  />
                  <StatCard label="Tỷ lệ thành công" value={orders === null ? '—' : successRate === null ? '—' : `${successRate}%`} />
                </div>

                <div className="rounded-2xl bg-white px-6 py-6 mb-8 shadow-[0_1px_2px_rgba(33,26,29,0.04),0_6px_16px_-10px_rgba(33,26,29,0.15)]">
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
                              className={`w-full rounded-t-md transition-all ${d.isToday ? 'bg-momo' : 'bg-stone-300'}`}
                              style={{ height: `${Math.max(4, Math.round((d.revenue / chartMax) * 100))}%` }}
                            />
                          </div>
                          <span className={`text-[10px] font-medium ${d.isToday ? 'text-momo' : 'text-stone-400'}`}>{d.label}</span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>

                <div>
                  <div className="flex items-center justify-between mb-3">
                    <h2 className="text-sm font-semibold text-stone-900">Giao dịch gần nhất</h2>
                    {orders !== null && orders.length > 0 && (
                      <button onClick={() => setTab('transactions')} className="text-xs font-medium text-momo hover:underline">
                        Xem tất cả
                      </button>
                    )}
                  </div>
                  <TransactionList orders={orders} list={recent} />
                </div>
              </div>
            )}

            {tab === 'transactions' && (
              <div>
                <input
                  type="text"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Tìm theo mã đơn hoặc nội dung..."
                  className="w-full rounded-xl border border-stone-200 bg-white px-4 py-2.5 text-sm text-stone-700 placeholder:text-stone-400 focus:outline-none focus:ring-2 focus:ring-momo/30 mb-5"
                />
                <div className="flex flex-wrap gap-2 mb-5">
                  {[
                    { key: 'ALL', label: 'Tất cả' },
                    { key: 'PAID', label: 'Thành công' },
                    { key: 'PENDING', label: 'Đang chờ' },
                    { key: 'FAILED', label: 'Thất bại' },
                    { key: 'EXPIRED', label: 'Hết hạn' },
                  ].map((s) => (
                    <button
                      key={s.key}
                      onClick={() => setStatusFilter(s.key)}
                      className={`px-3.5 py-1.5 rounded-full text-xs font-semibold transition ${
                        statusFilter === s.key ? 'bg-momo text-white' : 'bg-white text-stone-500 hover:bg-stone-100'
                      }`}
                    >
                      {s.label} · {statusCounts[s.key] ?? 0}
                    </button>
                  ))}
                </div>
                <TransactionList orders={orders} list={filtered} emptyLabel="Không tìm thấy giao dịch phù hợp." />
              </div>
            )}
          </div>
        </main>
      </div>
    </>
  )
}