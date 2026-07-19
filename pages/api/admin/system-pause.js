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
//
// TỐI ƯU so với bản gốc:
//   1. So sánh key bằng thời gian không đổi (constant-time) thay vì === để
//      giảm rủi ro timing attack dò key qua độ trễ phản hồi.
//   2. Gộp việc set 2 key Redis (paused + meta) bằng Promise.all thay vì
//      await tuần tự -> giảm độ trễ round-trip khi bật pause.
//   3. Trả lỗi 400 sớm hơn cho action không hợp lệ, tránh gọi Redis thừa.

import { Redis } from '@upstash/redis'
import crypto from 'crypto'

const redis = Redis.fromEnv()
const REDIS_KEY = 'system:paused'
const REDIS_META_KEY = 'system:paused:meta'
const VALID_KEY = process.env.NEXT_PUBLIC_SYSTEM_PAUSE_KEY

// So sánh 2 chuỗi theo thời gian không đổi để hạn chế timing attack.
// Trả về false ngay nếu độ dài khác nhau (không rò rỉ thêm thông tin quan
// trọng vì độ dài key không phải bí mật nhạy cảm bằng nội dung key).
function safeCompare(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false
  const bufA = Buffer.from(a)
  const bufB = Buffer.from(b)
  if (bufA.length !== bufB.length) return false
  return crypto.timingSafeEqual(bufA, bufB)
}

function isAuthorized(req) {
  // Chưa cấu hình biến môi trường -> khoá cứng luôn, không cho ai bật/tắt
  // (an toàn hơn là để trống = ai gọi cũng được).
  if (!VALID_KEY) return false
  const headerKey = req.headers['x-api-key']
  const queryKey = req.query.key
  return safeCompare(headerKey, VALID_KEY) || safeCompare(queryKey, VALID_KEY)
}

export default async function handler(req, res) {
  // Chặn mọi cache (browser/CDN/Vercel Edge Cache) cho route này — đây là
  // route hành động (bật/tắt), không bao giờ được phép trả response cũ từ
  // cache. Thiếu header này từng gây hiểu nhầm "action=on không có tác
  // dụng" trong khi thực ra chỉ là response bị cache lại.
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate')

  if (req.method !== 'GET' && req.method !== 'POST') {
    res.setHeader('Allow', ['GET', 'POST'])
    return res.status(405).json({ error: 'Method not allowed' })
  }

  if (!isAuthorized(req)) {
    const ip = req.headers['x-forwarded-for'] || req.socket?.remoteAddress || 'unknown'
    console.log(`[system-pause] UNAUTHORIZED attempt from ${ip} @ ${new Date().toISOString()}`)
    return res.status(401).json({ error: 'Sai hoặc thiếu api-key.' })
  }

  const action = req.body?.action || req.query.action

  // Log NGAY giá trị action nhận được (kể cả undefined) — nếu 1 request
  // action=on mà không thấy dòng log này với action="on", nghĩa là request
  // đó không tới được đây với query đúng như kỳ vọng (deploy sai bản, path
  // sai, hoặc bị proxy/cache chặn trước khi tới function).
  console.log(`[system-pause] REQUEST method=${req.method} action=${JSON.stringify(action)} query=${JSON.stringify(req.query)}`)

  if (action && action !== 'on' && action !== 'off') {
    return res.status(400).json({ error: 'action phải là "on" hoặc "off".' })
  }

  // IP để log — hữu ích khi cần biết ai/từ đâu bấm bật-tắt. Không dùng để
  // xác thực, chỉ để theo dõi.
  const ip = req.headers['x-forwarded-for'] || req.socket?.remoteAddress || 'unknown'

  if (action === 'on') {
    const reason = req.body?.reason || req.query.reason || null
    await Promise.all([
      redis.set(REDIS_KEY, '1'),
      redis.set(
        REDIS_META_KEY,
        JSON.stringify({
          pausedAt: new Date().toISOString(),
          reason,
        })
      ),
    ])
    console.log(`[system-pause] TURNED ON by ${ip} @ ${new Date().toISOString()}${reason ? ` — lý do: ${reason}` : ''}`)
  } else if (action === 'off') {
    await Promise.all([redis.set(REDIS_KEY, '0'), redis.del(REDIS_META_KEY)])
    console.log(`[system-pause] TURNED OFF by ${ip} @ ${new Date().toISOString()}`)
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