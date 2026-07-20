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

import { listOrders, getOrder } from '../../../lib/orders'
import { verifySession, refreshSession } from '../admin/login'

// Field khách (không session admin) được xem — mở rộng thêm so với trước
// (orderInfo, amount, paidAt, transId, storeName, aio_qr, createdAt, message)
// để trang /thanh-toan hiển thị đủ thông tin.
//
// LƯU Ý: createdAt BẮT BUỘC phải có trong danh sách này — pages/thanh-toan.js
// dùng order.createdAt để tính đồng hồ đếm ngược 10 phút (ORDER_EXPIRE_MS).
// Thiếu field này thì khách sẽ không thấy đếm ngược dù đơn vẫn còn hạn.
//
// TUYỆT ĐỐI KHÔNG thêm các field sau vào danh sách này, dù chúng là field
// "liên quan đến đơn hàng":
//   - guestCheckToken, expiresAt, issuedAt: đây CHÍNH LÀ token dùng để xác
//     thực lệnh gọi /api/momo/query. Lộ 3 field này qua route orders.js
//     đồng nghĩa ai cũng đọc được token trực tiếp mà không cần xin qua
//     /api/momo/guest-check-token — vô hiệu hoá hoàn toàn lớp bảo vệ đó.
//   - vietqr, payType: dữ liệu nội bộ do MoMo trả về (vietqr chứa
//     accountNumber/serviceCode gốc). Phần khách cần để chuyển khoản thủ
//     công đã có route riêng /api/momo/transfer-info lược field đúng mức,
//     không nên lộ nguyên object vietqr qua đây.
const GUEST_FIELDS = ['orderId', 'orderInfo', 'amount', 'status', 'createdAt', 'paidAt', 'transId', 'storeName', 'aio_qr', 'message']

function toGuestOrder(o) {
  const out = {}
  for (const f of GUEST_FIELDS) out[f] = o[f] ?? null
  return out
}

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).end()

  // QUAN TRỌNG: route này được FE poll liên tục (dashboard, /thanh-toan) —
  // thiếu no-store thì Vercel Edge Cache có thể trả 304 thẳng từ cache,
  // request KHÔNG chạm tới middleware/function nữa (đã xác nhận qua log
  // thấy /api/momo/orders trả 304 liên tục dù server đang paused).
  res.setHeader('Cache-Control', 'no-store')

  const { orderId } = req.query
  console.log(`[orders] GET orderId=${orderId || '(danh sách)'} @ ${new Date().toISOString()}`)

  try {
    const isAdmin = verifySession(req)
    if (isAdmin) refreshSession(req, res)

    if (!isAdmin && !orderId) {
      return res.status(401).json({ error: 'Chưa đăng nhập hoặc session hết hạn' })
    }

    // Khách luôn truyền orderId CHÍNH XÁC (từ URL trang /thanh-toan) và
    // route này bị FE poll liên tục — trước đây mọi lượt poll đều load
    // TOÀN BỘ danh sách đơn (listOrders) rồi mới filter substring trong
    // JS, dù chỉ cần đúng 1 đơn. Giờ tách riêng: khách dùng getOrder(id)
    // (1 key Redis, không kéo cả danh sách). Admin vẫn giữ listOrders +
    // filter substring như cũ để phục vụ tìm kiếm gần đúng trên dashboard.
    let orders

    if (!isAdmin) {
      const order = await getOrder(String(orderId).trim())
      orders = order ? [toGuestOrder(order)] : []
    } else if (orderId) {
      const needle = String(orderId).trim().toLowerCase()
      const all = await listOrders()
      orders = all.filter(o => (o.orderId || '').toLowerCase().includes(needle))
    } else {
      orders = await listOrders()
    }

    console.log(`[orders] → trả ${orders.length} đơn (isAdmin=${isAdmin})`)
    return res.status(200).json({ orders, total: orders.length })
  } catch (err) {
    console.error('[orders] Lỗi:', err)
    return res.status(500).json({ error: 'Lỗi máy chủ' })
  }
}