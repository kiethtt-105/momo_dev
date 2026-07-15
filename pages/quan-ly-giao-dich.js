// pages/quan-ly-giao-dich.js
//
// Trang ADMIN — CHỈ danh sách đơn hàng + hủy/xóa. Chức năng "Quét mã
// khách (POS)" đã chuyển sang trang /tao-giao-dich (tab riêng) vì
// đó mới đúng là nơi TẠO giao dịch, không phải quản lý.
//
// Không xử lý đăng nhập ở đây — pages/_app.js đã chặn ở tầng toàn
// cục. Nếu session hết hạn giữa chừng, route trả 401 -> reload để
// gate toàn cục bắt lại.

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

function formatVND(n) {
  const num = Number(n)
  if (Number.isNaN(num)) return n
  return num.toLocaleString('vi-VN') + ' đ'
}

function formatTime(iso) {
  if (!iso) return '—'
  const d = new Date(iso)
  return d.toLocaleString('vi-VN', { hour: '2-digit', minute: '2-digit', day: '2-digit', month: '2-digit' })
}

export default function QuanLyGiaoDich() {
  const [orders, setOrders] = useState([])
  const [search, setSearch] = useState('')
  const [loading, setLoading] = useState(true)
  const [actionId, setActionId] = useState('') // orderId đang xử lý cancel/delete

  async function loadOrders(query = '') {
    setLoading(true)
    try {
      const qs = query ? `?orderId=${encodeURIComponent(query)}` : ''
      const res = await fetch(`/api/momo/orders${qs}`, { credentials: 'include' })
      if (res.status === 401) {
        window.location.reload()
        return
      }
      const data = await res.json()
      setOrders(data.orders || [])
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    loadOrders()
  }, [])

  function handleSearch(e) {
    e.preventDefault()
    loadOrders(search.trim())
  }

  async function handleCancel(orderId) {
    setActionId(orderId)
    try {
      const res = await fetch('/api/momo/cancel', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ orderId }),
      })
      if (res.status === 401) {
        window.location.reload()
        return
      }
      await loadOrders(search.trim())
    } finally {
      setActionId('')
    }
  }

  async function handleDelete(orderId) {
    if (!confirm(`Xóa hẳn đơn hàng ${orderId}? Không thể hoàn tác.`)) return
    setActionId(orderId)
    try {
      const res = await fetch('/api/momo/delete', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ orderId }),
      })
      if (res.status === 401) {
        window.location.reload()
        return
      }
      await loadOrders(search.trim())
    } finally {
      setActionId('')
    }
  }

  return (
    <main className="min-h-screen px-4 py-8 bg-neutral-50">
      <div className="max-w-3xl mx-auto">
        <div className="flex items-center justify-between mb-6">
          <div>
            <h1 className="text-xl font-extrabold text-neutral-900">Quản lý giao dịch</h1>
            <p className="text-neutral-500 text-sm">{orders.length} đơn hàng</p>
          </div>
          <form onSubmit={handleSearch} className="flex gap-2">
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Tìm theo mã đơn..."
              className="rounded-xl border border-neutral-200 px-3 py-2 text-sm w-44 focus:outline-none focus:ring-2 focus:ring-momo/40 focus:border-momo"
            />
            <button
              type="submit"
              className="px-4 py-2 rounded-xl bg-neutral-900 text-white text-sm font-semibold hover:bg-neutral-700 transition"
            >
              Tìm
            </button>
          </form>
        </div>

        {loading && <p className="text-neutral-400 text-sm mb-3">Đang tải...</p>}

        <div className="bg-white rounded-2xl border border-neutral-200 overflow-hidden">
          {orders.length === 0 && !loading && (
            <p className="text-center text-neutral-400 text-sm py-10">Chưa có đơn hàng nào</p>
          )}

          {orders.map((o) => (
            <div
              key={o.orderId}
              className="flex items-center justify-between px-5 py-4 border-b border-neutral-100 last:border-0"
            >
              <div className="min-w-0">
                <div className="flex items-center gap-2 mb-0.5">
                  <span className="font-mono text-xs text-neutral-400 truncate">{o.orderId}</span>
                  <span className={`text-xs font-semibold px-2 py-0.5 rounded-full ${STATUS_STYLE[o.status] || 'bg-neutral-100 text-neutral-600'}`}>
                    {STATUS_TEXT[o.status] || o.status}
                  </span>
                </div>
                <p className="font-mono font-bold text-neutral-900">{formatVND(o.amount)}</p>
                <p className="text-xs text-neutral-400">{o.orderInfo} · {formatTime(o.createdAt)}</p>
              </div>

              <div className="flex gap-2 shrink-0 ml-3">
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
          ))}
        </div>
      </div>
    </main>
  )
}