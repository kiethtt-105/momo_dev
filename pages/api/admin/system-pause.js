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

// Đánh dấu phiên bản code — đổi mỗi lần sửa file này. Dùng để XÁC NHẬN
// chắc chắn qua response xem Vercel đang chạy đúng bản mới nhất hay vẫn
// còn bản cũ (tránh nghi ngờ mơ hồ "không biết đã deploy chưa").
const CODE_VERSION = 'v3-direct-return-2026-07-20'

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
    const meta = { pausedAt: new Date().toISOString(), reason }
    await Promise.all([redis.set(REDIS_KEY, '1'), redis.set(REDIS_META_KEY, JSON.stringify(meta))])
    console.log(`[system-pause] TURNED ON by ${ip} @ ${new Date().toISOString()}${reason ? ` — lý do: ${reason}` : ''}`)
    // Trả thẳng giá trị VỪA GHI, không đọc lại Redis ngay sau khi ghi.
    // Lý do: nếu Redis là Upstash "Global" (multi-region), đọc lại ngay
    // sau khi ghi có thể rơi vào 1 replica chưa kịp đồng bộ và trả về giá
    // trị CŨ (đã từng xảy ra thực tế: log ghi "TURNED ON" nhưng response
    // vẫn trả paused:false). Trả thẳng giá trị vừa set để response luôn
    // khớp với thao tác vừa thực hiện — không phụ thuộc độ trễ đồng bộ.
    // Lưu ý: điều này KHÔNG loại bỏ hoàn toàn rủi ro đó ở middleware.js
    // (middleware đọc Redis độc lập, không đi qua đường này) — nếu domain
    // đang dùng Redis Global, vẫn nên đổi sang Regional để đảm bảo
    // middleware chặn request ngay lập tức, không trễ vài trăm ms~vài giây.
    return res.status(200).json({ paused: true, ...meta, _version: CODE_VERSION })
  }

  if (action === 'off') {
    await Promise.all([redis.set(REDIS_KEY, '0'), redis.del(REDIS_META_KEY)])
    console.log(`[system-pause] TURNED OFF by ${ip} @ ${new Date().toISOString()}`)
    return res.status(200).json({ paused: false, _version: CODE_VERSION })
  }

  // Không có action -> chỉ đọc trạng thái hiện tại, không đổi gì.
  const [pausedRaw, metaRaw] = await Promise.all([redis.get(REDIS_KEY), redis.get(REDIS_META_KEY)])
  // QUAN TRỌNG: @upstash/redis SDK tự động JSON-parse giá trị đọc về, nên
  // pausedRaw có thể là NUMBER 1 (không phải STRING '1'), và metaRaw có
  // thể đã là OBJECT sẵn (không phải chuỗi JSON cần parse thêm). So sánh
  // === '1' hoặc gọi JSON.parse() trên 1 object có sẵn sẽ âm thầm sai/lỗi
  // -> đây từng là lỗi gốc khiến middleware đọc paused=false dù Redis
  // đang thực sự là 1. Xử lý cả 2 khả năng kiểu dữ liệu cho chắc chắn.
  const paused = pausedRaw === '1' || pausedRaw === 1
  let meta = {}
  if (metaRaw && typeof metaRaw === 'object') {
    meta = metaRaw
  } else if (typeof metaRaw === 'string') {
    try {
      meta = JSON.parse(metaRaw)
    } catch {
      meta = {}
    }
  }

  return res.status(200).json({ paused, ...meta, _version: CODE_VERSION })
}