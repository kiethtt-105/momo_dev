// pages/api/momo/guest-check-token.js
// Cấp "vé" dùng 1 lần cho KHÁCH (không đăng nhập admin) để được phép gọi
// /api/momo/query — vốn hỏi thẳng MoMo server-to-server và lộ dữ liệu giao
// dịch chi tiết nên trước giờ chỉ admin mới gọi được. Route này KHÔNG mở
// query.js ra public, mà cấp một token phạm vi rất hẹp: đúng 1 orderId,
// đúng 1 lần gọi, hết hạn trong vài giây.
//
// Luồng:
//   1. Trang /thanh-toan gọi GET /api/momo/guest-check-token?orderId=xxx
//      trước MỖI LẦN muốn kiểm tra thật (bấm nút "Kiểm tra kết quả" hoặc
//      tới vòng tự động 30s) → nhận về { token, expiresAt }.
//   2. Trang gọi tiếp GET /api/momo/query?orderId=xxx&token=yyy.
//   3. query.js xác nhận token khớp orderId, CHƯA dùng, còn hạn — dùng
//      xong "đốt" ngay (đánh dấu used), nên không dùng lại được, cũng
//      không dùng được cho đơn khác hay endpoint khác.
//
// Token lưu ngay trong record của order (field guestCheckToken) — tận
// dụng getOrder/saveOrder sẵn có, không cần thêm kết nối/khoá Redis riêng.
//
// Điều kiện cấp token:
//   - Đơn phải tồn tại và đang PENDING (đơn đã PAID/FAILED/EXPIRED thì
//     không có lý do gì để khách cần hỏi lại MoMo qua đường này nữa).
//   - Nếu token cũ vẫn còn hạn và CHƯA dùng (vd khách bấm liên tiếp, hoặc
//     effect chạy 2 lần do React StrictMode), trả lại chính token đó thay
//     vì cấp mới đè lên — tránh vô hiệu hoá token vừa cấp trước đó.

import { getOrder, saveOrder } from '../../../lib/orders'
import crypto from 'crypto'

// Token sống rất ngắn — chỉ đủ thời gian trang gọi /api/momo/query ngay
// sau khi nhận token, không phải một phiên làm việc dài.
const GUEST_TOKEN_TTL_MS = 20 * 1000

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' })

  const orderId = (req.query.orderId || '').toString().trim()
  if (!orderId) return res.status(400).json({ error: 'Thiếu orderId' })

  const order = await getOrder(orderId)
  if (!order) return res.status(404).json({ error: 'Không tìm thấy đơn hàng' })

  res.setHeader('Cache-Control', 'no-store')

  // Đơn đã có kết quả cuối cùng — không cấp token nữa.
  if (order.status !== 'PENDING') {
    return res.status(409).json({ error: 'Đơn hàng không ở trạng thái chờ thanh toán' })
  }

  const now = Date.now()
  const existing = order.guestCheckToken

  if (existing && !existing.used && existing.expiresAt > now) {
    return res.status(200).json({ token: existing.token, expiresAt: existing.expiresAt })
  }

  const token = crypto.randomBytes(24).toString('hex')
  const expiresAt = now + GUEST_TOKEN_TTL_MS

  await saveOrder(orderId, {
    ...order,
    guestCheckToken: { token, used: false, expiresAt, issuedAt: now },
  })

  return res.status(200).json({ token, expiresAt })
}