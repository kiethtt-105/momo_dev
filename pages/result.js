// pages/result.js
//
// Trang MoMo TỰ ĐỘNG chuyển khách về sau khi thanh toán xong — khớp với
// redirectUrl = `${BASE_URL}/result` đã set sẵn trong lib/momo.js
// (createMoMoPayment). Route này KHÔNG cần đăng nhập admin.
//
// LƯU Ý BẢO MẬT: MoMo có gắn kèm resultCode/message/amount... vào query
// string khi redirect, nhưng KHÔNG tin trực tiếp các giá trị đó (khách có
// thể tự sửa URL, vd ?resultCode=0 giả). Trang này CHỈ dùng orderId từ
// query để tra lại trạng thái THẬT từ server (/api/momo/orders) — trạng
// thái thật đã được ipn.js ghi nhận độc lập, có xác minh chữ ký MoMo.

import { useEffect, useState } from 'react'
import { useRouter } from 'next/router'
import Link from 'next/link'

function formatVND(n) {
  const num = Number(n)
  if (Number.isNaN(num)) return n
  return num.toLocaleString('vi-VN') + ' đ'
}

export default function Result() {
  const router = useRouter()
  const { orderId } = router.query

  const [order, setOrder] = useState(null)
  const [notFound, setNotFound] = useState(false)
  const [attempts, setAttempts] = useState(0)

  useEffect(() => {
    if (!orderId) return

    let cancelled = false
    let timer

    async function check() {
      try {
        const res = await fetch(`/api/momo/orders?orderId=${encodeURIComponent(orderId)}`)
        const data = await res.json()
        const found = (data.orders || []).find((o) => o.orderId === orderId)
        if (cancelled) return

        if (!found) {
          setNotFound(true)
          return
        }

        setOrder(found)

        // MoMo redirect khách về gần như ngay lập tức, nhưng IPN (nơi ghi
        // trạng thái PAID thật) có thể tới sau vài giây — nếu vẫn đang
        // PENDING thì thử tra lại tối đa ít lần nữa trước khi bảo khách chờ.
        if (found.status === 'PENDING' && attempts < 5) {
          timer = setTimeout(() => setAttempts((a) => a + 1), 2000)
        }
      } catch {
        if (!cancelled) setNotFound(true)
      }
    }

    check()
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [orderId, attempts])

  if (!orderId) {
    return (
      <main className="min-h-screen flex items-center justify-center text-neutral-400 text-sm px-4">
        Thiếu mã đơn hàng trong đường dẫn.
      </main>
    )
  }

  if (notFound) {
    return (
      <main className="min-h-screen flex items-center justify-center px-4 text-center">
        <p className="text-neutral-500 text-sm">Không tìm thấy đơn hàng.</p>
      </main>
    )
  }

  if (!order) {
    return (
      <main className="min-h-screen flex items-center justify-center text-neutral-400 text-sm">
        Đang kiểm tra kết quả...
      </main>
    )
  }

  if (order.status === 'PAID') {
    return (
      <main className="min-h-screen flex items-center justify-center px-4 bg-neutral-50">
        <div className="w-full max-w-sm bg-white rounded-2xl border border-neutral-200 p-8 text-center">
          <div className="w-14 h-14 rounded-full bg-emerald-50 mx-auto mb-4 flex items-center justify-center text-2xl">✓</div>
          <h1 className="text-xl font-extrabold text-neutral-900 mb-1">Thanh toán thành công</h1>
          <p className="text-2xl font-mono font-bold text-neutral-900 mt-3">{formatVND(order.amount)}</p>
          <p className="text-neutral-400 text-xs mt-4">Mã đơn: {order.orderId}</p>
        </div>
      </main>
    )
  }

  if (order.status === 'FAILED') {
    return (
      <main className="min-h-screen flex items-center justify-center px-4 bg-neutral-50">
        <div className="w-full max-w-sm bg-white rounded-2xl border border-neutral-200 p-8 text-center">
          <div className="w-14 h-14 rounded-full bg-red-50 mx-auto mb-4 flex items-center justify-center text-2xl">✕</div>
          <h1 className="text-xl font-extrabold text-neutral-900 mb-1">Thanh toán không thành công</h1>
          <p className="text-neutral-500 text-sm mt-2">Giao dịch đã bị huỷ hoặc thất bại. Bạn có thể quay lại thử thanh toán lại.</p>
          <Link
            href={`/thanh-toan?orderId=${encodeURIComponent(order.orderId)}`}
            className="inline-block mt-5 w-full py-3 rounded-xl bg-momo text-white text-sm font-semibold hover:bg-momo-dark transition"
          >
            Thử lại
          </Link>
          <p className="text-neutral-400 text-xs mt-4">Mã đơn: {order.orderId}</p>
        </div>
      </main>
    )
  }

  // Vẫn PENDING sau khi đã chờ vài lần — IPN có thể đến trễ, hướng khách
  // quay lại trang thanh toán (trang đó tự poll liên tục) thay vì đứng chờ
  // vô thời hạn ở đây.
  return (
    <main className="min-h-screen flex items-center justify-center px-4 bg-neutral-50">
      <div className="w-full max-w-sm bg-white rounded-2xl border border-neutral-200 p-8 text-center">
        <p className="text-neutral-500 text-sm mb-4">
          {attempts < 5 ? 'Đang xác nhận kết quả thanh toán...' : 'Chưa nhận được xác nhận cuối cùng.'}
        </p>
        {attempts >= 5 && (
          <Link
            href={`/thanh-toan?orderId=${encodeURIComponent(order.orderId)}`}
            className="inline-block w-full py-3 rounded-xl bg-neutral-900 text-white text-sm font-semibold hover:bg-neutral-700 transition"
          >
            Xem trạng thái đơn hàng
          </Link>
        )}
      </div>
    </main>
  )
}
