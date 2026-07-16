// pages/api/momo/orders.js
// Thay thế HOÀN TOÀN 3 route cũ: query.js + status.js + save.js — không
// còn gọi lại MoMo real-time để "tra cứu" hay "verify" nữa, vì create.js
// (scan) và ipn.js (p2p) đã lưu đủ kết quả thật ngay khi có. Route này chỉ
// ĐỌC dữ liệu đã lưu trong Redis — đơn giản, không còn logic throttle/
// reconcile/expire phức tạp như trước.
//
// GET  ?orderId=xxx        → tra 1 đơn cụ thể (khách không có session admin
//                             BẮT BUỘC phải truyền orderId, không xem được
//                             danh sách người khác)
// GET  (không có orderId)  → CHỈ admin mới xem được toàn bộ danh sách

import { listOrders } from '../../../lib/orders'
import { verifySession, refreshSession } from '../admin/login'

// Field khách (không session admin) được xem — mở rộng thêm so với trước
// (orderInfo, amount, paidAt, transId, storeName, aio_qr) để trang
// /thanh-toan hiển thị đủ thông tin. Vẫn KHÔNG lộ các field nội bộ khác
// (payType, promotionInfo, partnerCode, requestId, guestCheckToken...).
const GUEST_FIELDS = ['orderId', 'orderInfo', 'amount', 'status', 'paidAt', 'transId', 'storeName', 'aio_qr']

function toGuestOrder(o) {
  const out = {}
  for (const f of GUEST_FIELDS) out[f] = o[f] ?? null
  return out
}

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).end()

  try {
    const isAdmin = verifySession(req)
    if (isAdmin) refreshSession(req, res)

    const { orderId } = req.query

    if (!isAdmin && !orderId) {
      return res.status(401).json({ error: 'Chưa đăng nhập hoặc session hết hạn' })
    }

    let orders = await listOrders()

    if (orderId) {
      const needle = String(orderId).trim().toLowerCase()
      orders = orders.filter(o => (o.orderId || '').toLowerCase().includes(needle))
    }

    if (!isAdmin) {
      orders = orders.map(toGuestOrder)
    }

    return res.status(200).json({ orders, total: orders.length })
  } catch (err) {
    console.error('[orders] Lỗi:', err)
    return res.status(500).json({ error: 'Lỗi máy chủ' })
  }
} 