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

const STATUS_META = {
  PAID: { label: 'Thành công', dot: 'bg-emerald-500', text: 'text-emerald-700', bar: 'border-emerald-500' },
  PENDING: { label: 'Đang chờ', dot: 'bg-amber-500', text: 'text-amber-700', bar: 'border-amber-500' },
  FAILED: { label: 'Thất bại', dot: 'bg-rose-500', text: 'text-rose-700', bar: 'border-rose-500' },
  EXPIRED: { label: 'Hết hạn', dot: 'bg-neutral-400', text: 'text-neutral-500', bar: 'border-neutral-300' },
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

      <main className="min-h-screen bg-neutral-50 px-4 py-8 sm:py-12">
        <div className="w-full max-w-2xl mx-auto">
          {/* Header */}
          <div className="flex items-center gap-3 mb-8">
            <div className="w-11 h-11 shrink-0 rounded-2xl bg-momo flex items-center justify-center text-white font-extrabold text-lg">
              M
            </div>
            <div>
              <h1 className="text-lg font-extrabold text-neutral-900 leading-tight">Momo Dev</h1>
              <p className="text-neutral-500 text-xs">
                {new Date().toLocaleDateString('vi-VN', { weekday: 'long', day: '2-digit', month: '2-digit', year: 'numeric' })}
              </p>
            </div>
          </div>

          {/* Lỗi tải dữ liệu */}
          {error && (
            <div className="mb-6 rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">
              {error} — thử tải lại trang.
            </div>
          )}

          {/* Stat cards */}
          <div className="grid grid-cols-2 gap-3 mb-8">
            <StatCard label="Đơn hôm nay" value={orders === null ? '—' : today.length} />
            <StatCard
              label="Doanh thu hôm nay"
              value={orders === null ? '—' : currency.format(todayRevenue)}
              mono
            />
            <StatCard
              label="Đang chờ"
              value={orders === null ? '—' : todayPending.length}
              accent={todayPending.length > 0 ? 'amber' : undefined}
            />
            <StatCard
              label="Tỷ lệ thành công"
              value={orders === null ? '—' : (successRate === null ? '—' : `${successRate}%`)}
            />
          </div>

          {/* Quick actions */}
          <div className="flex flex-col sm:flex-row gap-3 mb-10">
            <Link
              href="/tao-giao-dich"
              className="flex-1 text-center py-3.5 rounded-xl bg-momo text-white font-semibold hover:bg-momo-dark transition"
            >
              Tạo giao dịch
            </Link>
            <Link
              href="/quan-ly-giao-dich"
              className="flex-1 text-center py-3.5 rounded-xl bg-white border border-neutral-200 text-neutral-800 font-semibold hover:bg-neutral-100 transition"
            >
              Quản lý giao dịch
            </Link>
          </div>

          {/* Giao dịch gần nhất */}
          <div>
            <div className="flex items-center justify-between mb-3">
              <h2 className="text-sm font-semibold text-neutral-900">Giao dịch gần nhất</h2>
              {orders !== null && orders.length > 8 && (
                <Link href="/quan-ly-giao-dich" className="text-xs font-medium text-momo hover:underline">
                  Xem tất cả
                </Link>
              )}
            </div>

            {orders === null && !error && (
              <div className="space-y-2">
                {[0, 1, 2].map((i) => (
                  <div key={i} className="h-14 rounded-xl bg-neutral-100 animate-pulse" />
                ))}
              </div>
            )}

            {orders !== null && recent.length === 0 && (
              <div className="rounded-xl border border-dashed border-neutral-300 px-4 py-8 text-center">
                <p className="text-sm text-neutral-500">Chưa có giao dịch nào.</p>
                <Link href="/tao-giao-dich" className="text-sm font-medium text-momo hover:underline mt-1 inline-block">
                  Tạo giao dịch đầu tiên
                </Link>
              </div>
            )}

            {recent.length > 0 && (
              <div className="rounded-xl border border-neutral-200 bg-white overflow-hidden divide-y divide-neutral-100">
                {recent.map((o) => {
                  const meta = STATUS_META[o.status] || STATUS_META.EXPIRED
                  return (
                    <div key={o.orderId} className={`flex items-center gap-3 px-4 py-3 border-l-4 ${meta.bar}`}>
                      <div className="min-w-0 flex-1">
                        <p className="text-sm font-medium text-neutral-900 truncate">
                          {o.orderInfo || o.orderId}
                        </p>
                        <div className="flex items-center gap-2 mt-0.5">
                          <StatusBadge status={o.status} />
                          <span className="text-xs text-neutral-400">·</span>
                          <span className="text-xs text-neutral-400">{timeAgo(o.createdAt)}</span>
                        </div>
                      </div>
                      <div className="text-sm font-semibold text-neutral-900 tabular-nums whitespace-nowrap">
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

function StatCard({ label, value, mono, accent }) {
  return (
    <div className="rounded-xl border border-neutral-200 bg-white px-4 py-3.5">
      <p className="text-xs text-neutral-500 mb-1">{label}</p>
      <p className={`text-xl font-extrabold text-neutral-900 tabular-nums ${mono ? 'tracking-tight' : ''} ${accent === 'amber' ? 'text-amber-600' : ''}`}>
        {value}
      </p>
    </div>
  )
}