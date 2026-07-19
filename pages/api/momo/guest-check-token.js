// pages/api/momo/guest-check-token.js
//
// Cấp 1 token DÙNG-1-LẦN, hết hạn rất nhanh, cho khách trên trang /thanh-toan
// dùng để gọi /api/momo/query?orderId=xxx&token=yyy (route đó tự "đốt" token
// ngay khi dùng — xem consumeGuestToken() trong query.js). Đây là bước bắt
// buộc trước khi khách được phép ép server hỏi thẳng MoMo, để tránh việc
// bất kỳ ai cũng gọi thẳng /api/momo/query cho orderId bất kỳ mà không qua
// kiểm soát nào (spam request tới MoMo, tốn quota/rate limit thật).
//
// KHÔNG cần session admin — route công khai, nhưng chỉ cấp token cho ĐÚNG
// orderId truyền vào (không lộ token của đơn khác), và bản thân token chỉ
// cho phép query đúng 1 lần cho đúng đơn đó.
//
// GET ?orderId=xxx → { token, expiresAt }

import crypto from 'crypto'
import { getOrder, saveOrder } from '../../../lib/orders'

// Token sống rất ngắn — chỉ đủ thời gian cho trình duyệt gọi tiếp
// /api/momo/query ngay sau khi nhận token, không phải để lưu dùng lại sau.
const TOKEN_TTL_MS = 20 * 1000 // 20 giây

// Nếu vừa cấp 1 token còn hiệu lực (chưa dùng, chưa hết hạn) cách đây chưa
// tới khoảng này, trả lại CHÍNH token đó thay vì phát hành token mới — tránh
// việc double-click/gọi trùng (StrictMode, khách bấm liên tục...) liên tục
// sinh token mới vô ích, đồng thời hạn chế spam ép server tạo token dồn dập.
const REISSUE_COOLDOWN_MS = 5 * 1000 // 5 giây

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', ['GET'])
    return res.status(405).json({ error: 'Method not allowed' })
  }

  const orderId = (req.query.orderId || '').toString().trim()
  res.setHeader('Cache-Control', 'no-store') // token phải luôn mới, không cho cache
  console.log(`[guest-check-token] GET orderId=${orderId || '(thiếu)'} @ ${new Date().toISOString()}`)
  if (!orderId) {
    return res.status(400).json({ error: 'Thiếu orderId' })
  }

  try {
    const order = await getOrder(orderId)
    if (!order) {
      return res.status(404).json({ error: 'Không tìm thấy đơn hàng' })
    }

    const now = Date.now()
    const existing = order.guestCheckToken

    // Còn token cũ chưa dùng, chưa hết hạn, và vừa cấp gần đây → tái dùng
    // luôn, không ghi Redis thêm lần nữa.
    if (
      existing &&
      !existing.used &&
      existing.expiresAt > now &&
      existing.issuedAt &&
      now - existing.issuedAt < REISSUE_COOLDOWN_MS
    ) {
      console.log(`[guest-check-token] ${orderId} → tái dùng token cũ (cooldown)`)
      return res.status(200).json({ token: existing.token, expiresAt: existing.expiresAt })
    }

    const token = crypto.randomBytes(24).toString('hex')
    const expiresAt = now + TOKEN_TTL_MS

    await saveOrder(orderId, {
      ...order,
      guestCheckToken: { token, issuedAt: now, expiresAt, used: false },
    })

    console.log(`[guest-check-token] ${orderId} → cấp token mới, hết hạn sau ${TOKEN_TTL_MS / 1000}s`)
    return res.status(200).json({ token, expiresAt })
  } catch (err) {
    console.error('[guest-check-token] Lỗi:', err)
    return res.status(500).json({ error: 'Lỗi máy chủ' })
  }
}