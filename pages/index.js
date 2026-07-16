// pages/index.js
//
// Trang chủ. Không tự xử lý đăng nhập nữa — pages/_app.js đã chặn truy cập
// ở tầng toàn cục, tới được đây nghĩa là đã có session admin.
//
// Bản cũ chỉ có 2 nút bấm, không cho biết gì về tình hình giao dịch. Giờ
// thêm 1 dashboard gọn: tổng quan hôm nay (số đơn / doanh thu / đang chờ /
// tỷ lệ thành công) + danh sách giao dịch gần nhất, lấy thẳng từ
// /api/momo/orders (đã có sẵn, không cần route mới).
import { useEffect, useState } from 'react'
import Head from 'next/head'
import Link from 'next/link'

const currency = new Intl.NumberFormat('vi-VN', { style: 'currency', currency: 'VND', maximumFractionDigits: 0 })

function isToday(iso) {
  if (!iso) return false
  const d = new Date(iso)
  const now = new Date()
  return d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate()
}

function timeAgo(iso) {
  if (!iso) return ''
  const diffSec = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 1000))
  if (diffSec < 60) return 'vừa xong'
  if (diffSec < 3600) return `${Math.floor(diffSec / 60)} phút trước`
  if (diffSec < 86400) return `${Math.floor(diffSec / 3600)} giờ trước`
  return new Date(iso).toLocaleDateString('vi-VN')
}

// Bảng màu theo trạng thái — dùng chấm tròn đặc cho trạng thái "sống"
// (đang chờ) và nhạt hơn cho trạng thái đã kết thúc, để mắt tự động dồn
// vào những gì còn cần xử lý.
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

// Thẻ số liệu phụ — dùng cho 3 chỉ số đi kèm bên dưới thẻ doanh thu chính.
function MiniStat({ label, value, accent }) {
  return (
    <div className="flex-1 min-w-[7.5rem] rounded-2xl bg-white px-4 py-3.5 shadow-[0_1px_2px_rgba(33,26,29,0.04),0_6px_16px_-10px_rgba(33,26,29,0.15)]">
      <p className="text-[11px] font-medium uppercase tracking-wide text-stone-400 mb-1">{label}</p>
      <p className={`text-xl font-extrabold tabular-nums ${accent === 'amber' ? 'text-amber-600' : 'text-stone-900'}`}>
        {value}
      </p>
    </div>
  )
}

export default function Home() {
  const [orders, setOrders] = useState(null)
  const [error, setError] = useState(null)

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
  const recent = (orders || []).slice(0, 8)

  return (
    <>
      <Head>
        <title>Momo Dev</title>
        <meta name="description" content="Cổng thanh toán MoMo" />
      </Head>

      <main className="min-h-screen bg-[#FAF7F5] px-4 py-8 sm:py-12">
        <div className="w-full max-w-2xl mx-auto">
          {/* Header */}
          <div className="flex items-center gap-3 mb-7">
            <div className="w-11 h-11 shrink-0 rounded-2xl bg-momo flex items-center justify-center text-white font-extrabold text-lg shadow-[0_6px_16px_-6px_rgba(165,0,100,0.55)]">
              M
            </div>
            <div>
              <h1 className="text-lg font-extrabold text-stone-900 leading-tight tracking-tight">Momo Dev</h1>
              <p className="text-stone-400 text-xs">
                {new Date().toLocaleDateString('vi-VN', { weekday: 'long', day: '2-digit', month: '2-digit', year: 'numeric' })}
              </p>
            </div>
          </div>

          {/* Lỗi tải dữ liệu */}
          {error && (
            <div className="mb-6 rounded-xl bg-rose-50 px-4 py-3 text-sm text-rose-700">
              {error} — thử tải lại trang.
            </div>
          )}

          {/* Doanh thu hôm nay — thẻ chính, chiếm trọng tâm thị giác */}
          <div className="rounded-3xl bg-stone-900 px-6 py-6 mb-3 relative overflow-hidden shadow-[0_20px_40px_-20px_rgba(33,26,29,0.45)]">
            <div className="absolute -right-8 -top-10 w-40 h-40 rounded-full bg-momo/25 blur-2xl" />
            <div className="absolute -left-10 -bottom-12 w-40 h-40 rounded-full bg-momo/10 blur-2xl" />
            <p className="relative text-[11px] font-medium uppercase tracking-wide text-stone-400 mb-1.5">
              Doanh thu hôm nay
            </p>
            <p className="relative text-4xl sm:text-5xl font-extrabold text-white tabular-nums tracking-tight">
              {orders === null ? '—' : currency.format(todayRevenue)}
            </p>
            <p className="relative text-xs text-stone-400 mt-2">
              {orders === null ? 'Đang tải…' : `${todayPaid.length} đơn đã thanh toán trong hôm nay`}
            </p>
          </div>

          {/* 3 chỉ số phụ */}
          <div className="flex flex-wrap gap-3 mb-8">
            <MiniStat label="Đơn hôm nay" value={orders === null ? '—' : today.length} />
            <MiniStat
              label="Đang chờ"
              value={orders === null ? '—' : todayPending.length}
              accent={todayPending.length > 0 ? 'amber' : undefined}
            />
            <MiniStat
              label="Tỷ lệ thành công"
              value={orders === null ? '—' : (successRate === null ? '—' : `${successRate}%`)}
            />
          </div>

          {/* Quick actions */}
          <div className="flex flex-col sm:flex-row gap-3 mb-10">
            <Link
              href="/tao-giao-dich"
              className="flex-1 text-center py-3.5 rounded-xl bg-momo text-white font-semibold shadow-[0_10px_20px_-10px_rgba(165,0,100,0.6)] hover:bg-momo-dark transition"
              target="_blank" rel="noopener noreferrer"
            >
              Tạo giao dịch
            </Link>
            <Link
              href="/quan-ly-giao-dich"
              className="flex-1 text-center py-3.5 rounded-xl bg-white text-stone-800 font-semibold shadow-[0_1px_2px_rgba(33,26,29,0.04),0_6px_16px_-10px_rgba(33,26,29,0.15)] hover:bg-stone-50 transition"
              target="_blank" rel="noopener noreferrer"
            >
              Quản lý giao dịch
            </Link>
          </div>

          {/* Giao dịch gần nhất */}
          <div>
            <div className="flex items-center justify-between mb-3">
              <h2 className="text-sm font-semibold text-stone-900">Giao dịch gần nhất</h2>
              {orders !== null && orders.length > 8 && (
                <Link href="/quan-ly-giao-dich" className="text-xs font-medium text-momo hover:underline">
                  Xem tất cả
                </Link>
              )}
            </div>

            {orders === null && !error && (
              <div className="space-y-2">
                {[0, 1, 2].map((i) => (
                  <div key={i} className="h-14 rounded-2xl bg-stone-100 animate-pulse" />
                ))}
              </div>
            )}

            {orders !== null && recent.length === 0 && (
              <div className="rounded-2xl border border-dashed border-stone-300 px-4 py-8 text-center">
                <p className="text-sm text-stone-500">Chưa có giao dịch nào.</p>
                <Link href="/tao-giao-dich" className="text-sm font-medium text-momo hover:underline mt-1 inline-block">
                  Tạo giao dịch đầu tiên
                </Link>
              </div>
            )}

            {recent.length > 0 && (
              <div className="rounded-2xl bg-white overflow-hidden divide-y divide-stone-100 shadow-[0_1px_2px_rgba(33,26,29,0.04),0_6px_16px_-10px_rgba(33,26,29,0.15)]">
                {recent.map((o) => {
                  const meta = STATUS_META[o.status] || STATUS_META.EXPIRED
                  return (
                    <div key={o.orderId} className="flex items-center gap-3 px-4 py-3">
                      <span className={`shrink-0 w-8 h-8 rounded-full flex items-center justify-center ${meta.chip}`}>
                        <span className={`w-2 h-2 rounded-full ${meta.dot}`} />
                      </span>
                      <div className="min-w-0 flex-1">
                        <p className="text-sm font-medium text-stone-900 truncate">
                          {o.orderInfo || o.orderId}
                        </p>
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
            )}
          </div>
        </div>
      </main>
    </>
  )
}