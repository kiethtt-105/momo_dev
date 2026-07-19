// pages/api/admin/system-pause.js
//
// Công tắc BẬT/TẮT toàn hệ thống (kill switch). CỐ Ý KHÔNG check session
// admin — chỉ check API key — vì đây chính là "cửa thoát hiểm": phải bật
// hoặc tắt được ngay cả khi phần đăng nhập admin đang gặp sự cố, và dùng
// nhanh được qua 1 đường link tắt (bookmark trên trình duyệt/điện thoại)
// mà không cần mở trang quản trị lên trước.
//
// route này LUÔN được middleware.js cho qua (không bao giờ bị 503 dù đang
// paused) — xem ALWAYS_ALLOWED trong middleware.js.
//
// Xác thực bằng key, chấp nhận 1 trong 2 cách:
//   - Header:       x-api-key: <key>       (gọi bằng fetch, vd nút trên trang admin)
//   - Query string: ?key=<key>             (để bấm được từ 1 LINK TẮT dán thẳng trên trình duyệt)
//
// Cách dùng:
//   GET  /api/admin/system-pause?key=XXX                  -> chỉ đọc trạng thái, không đổi gì
//   GET  /api/admin/system-pause?key=XXX&action=on         -> BẬT tạm dừng (dùng được cho link tắt, chỉ cần bấm)
//   GET  /api/admin/system-pause?key=XXX&action=off        -> TẮT tạm dừng, chạy lại bình thường
//   POST /api/admin/system-pause  body:{action,reason}     -> giống trên, dùng từ code (fetch)
//
// Đặt biến môi trường NEXT_PUBLIC_SYSTEM_PAUSE_KEY trên Vercel (Settings →
// Environment Variables, áp dụng cho cả Production). Dùng tiền tố
// NEXT_PUBLIC_ để nút trên trang admin (chạy trong trình duyệt) cũng gửi
// được key này lên. Đổi giá trị đó bất cứ lúc nào nếu nghi bị lộ — đổi
// xong phải redeploy thì giá trị mới mới có hiệu lực ở phía trình duyệt.

import { Redis } from '@upstash/redis'

const redis = Redis.fromEnv()
const REDIS_KEY = 'system:paused'
const REDIS_META_KEY = 'system:paused:meta'
const VALID_KEY = process.env.NEXT_PUBLIC_SYSTEM_PAUSE_KEY

function isAuthorized(req) {
  // Chưa cấu hình biến môi trường -> khoá cứng luôn, không cho ai bật/tắt
  // (an toàn hơn là để trống = ai gọi cũng được).
  if (!VALID_KEY) return false
  const headerKey = req.headers['x-api-key']
  const queryKey = req.query.key
  return headerKey === VALID_KEY || queryKey === VALID_KEY
}

export default async function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'POST') {
    res.setHeader('Allow', ['GET', 'POST'])
    return res.status(405).json({ error: 'Method not allowed' })
  }

  if (!isAuthorized(req)) {
    return res.status(401).json({ error: 'Sai hoặc thiếu api-key.' })
  }

  const action = req.body?.action || req.query.action

  if (action === 'on' || action === 'off') {
    if (action === 'on') {
      await redis.set(REDIS_KEY, '1')
      await redis.set(
        REDIS_META_KEY,
        JSON.stringify({
          pausedAt: new Date().toISOString(),
          reason: req.body?.reason || req.query.reason || null,
        })
      )
    } else {
      await redis.set(REDIS_KEY, '0')
      await redis.del(REDIS_META_KEY)
    }
  } else if (action) {
    return res.status(400).json({ error: 'action phải là "on" hoặc "off".' })
  }
  // Không có action -> chỉ đọc trạng thái hiện tại, không đổi gì.

  const [pausedRaw, metaRaw] = await Promise.all([redis.get(REDIS_KEY), redis.get(REDIS_META_KEY)])
  let meta = {}
  try {
    meta = metaRaw ? JSON.parse(metaRaw) : {}
  } catch {
    meta = {}
  }

  return res.status(200).json({ paused: pausedRaw === '1', ...meta })
}