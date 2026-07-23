// pages/api/admin/system-pause.js
//
// Công tắc BẬT/TẮT toàn hệ thống (kill switch).
//
// XÁC THỰC — 2 cách, ƯU TIÊN key trước, sai/thiếu key mới rơi xuống session:
//   1. API key (header x-api-key hoặc ?key=) — đây là "cửa thoát hiểm":
//      PHẢI hoạt động được ngay cả khi phần đăng nhập admin đang gặp sự
//      cố (session hỏng, cookie mất, verifySession lỗi...), và dùng nhanh
//      được qua 1 đường link tắt (bookmark trên trình duyệt/điện thoại)
//      mà không cần mở trang quản trị lên trước. Vì vậy KHÔNG được thay
//      hẳn bằng session — chỉ bổ sung thêm lựa chọn thứ 2 bên dưới.
//   2. Session admin đã đăng nhập (cookie) — bổ sung MỚI: chỉ được kiểm
//      tra khi key thiếu hoặc sai, để admin đang ở trang quản trị (đã
//      đăng nhập sẵn) bấm nút Tạm dừng/Bật lại KHÔNG cần biết hay gõ
//      NEXT_PUBLIC_SYSTEM_PAUSE_KEY thủ công. Key vẫn là con đường CHÍNH
//      dùng cho link tắt/gọi từ ngoài; session chỉ là lối tắt tiện lợi
//      thêm cho giao diện nội bộ.
//
// route này LUÔN được middleware.js cho qua (không bao giờ bị 503 dù đang
// paused) — xem ALWAYS_ALLOWED trong middleware.js. Route /api/admin/login
// và /api/admin/session CŨNG PHẢI nằm trong ALWAYS_ALLOWED cùng lý do —
// nếu không, đăng nhập / kiểm tra session sẽ bị 503 ngay giữa lúc paused,
// tức là không ai đăng nhập lại được để bật hệ thống lên nữa.
//
// [MỚI] Khi action=on thành công -> LOGOUT LUÔN session admin của thiết bị
// vừa gọi request này (xem clearSessionCookie() trong login.js). Lý do:
// tránh trường hợp session cũ vẫn còn hiệu lực, cho phép bật lại hệ thống
// bằng switch mà không cần đăng nhập lại — phá vỡ đúng tinh thần gốc "tạm
// dừng cho tới khi có ai login lại" (login.js tự resumeSystem() khi đăng
// nhập thành công). Áp dụng bất kể request được cho qua bằng key hay bằng
// session — nếu qua bằng key mà trình duyệt đó tình cờ vẫn có cookie
// session cũ thì cookie đó cũng bị xoá theo cho nhất quán.
//
// Cách dùng:
//   GET  /api/admin/system-pause?key=XXX                  -> chỉ đọc trạng thái, không đổi gì
//   GET  /api/admin/system-pause?key=XXX&action=on         -> BẬT tạm dừng (dùng được cho link tắt, chỉ cần bấm)
//   GET  /api/admin/system-pause?key=XXX&action=off        -> TẮT tạm dừng, chạy lại bình thường
//   POST /api/admin/system-pause  body:{action,reason}     -> giống trên, dùng từ code (fetch)
//   (mọi cách gọi trên đều dùng được session admin THAY key nếu đang đăng nhập sẵn — xem authorize() bên dưới)
//
// Đặt biến môi trường NEXT_PUBLIC_SYSTEM_PAUSE_KEY trên Vercel (Settings →
// Environment Variables, áp dụng cho cả Production). Dùng tiền tố
// NEXT_PUBLIC_ để nút trên trang admin (chạy trong trình duyệt) cũng gửi
// được key này lên. Đổi giá trị đó bất cứ lúc nào nếu nghi bị lộ — đổi
// xong phải redeploy thì giá trị mới mới có hiệu lực ở phía trình duyệt.

import { Redis } from '@upstash/redis'
import crypto from 'crypto'
import { verifySession, refreshSession, clearSessionCookie } from './login'

const redis = Redis.fromEnv()

// Đánh dấu phiên bản code — đổi mỗi lần sửa file này. Dùng để XÁC NHẬN
// chắc chắn qua response xem Vercel đang chạy đúng bản mới nhất hay vẫn
// còn bản cũ (tránh nghi ngờ mơ hồ "không biết đã deploy chưa").
const CODE_VERSION = 'v5-pause-logs-out-session-2026-07-23'

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

// Chỉ xác thực bằng key — KHÔNG đụng gì tới session. Tách riêng thành 1
// hàm để giữ đúng vai trò "cửa thoát hiểm" độc lập: hoạt động được ngay
// cả khi toàn bộ hệ thống session/login đang hỏng, vì nó không phụ thuộc
// verifySession() chút nào.
function isKeyValid(req) {
  // Chưa cấu hình biến môi trường -> khoá cứng luôn, không cho ai bật/tắt
  // qua key (an toàn hơn là để trống = ai gọi cũng được). Session ở dưới
  // vẫn có thể cho qua bình thường nếu admin đã đăng nhập.
  if (!VALID_KEY) return false
  const headerKey = req.headers['x-api-key']
  const queryKey = req.query.key
  return safeCompare(headerKey, VALID_KEY) || safeCompare(queryKey, VALID_KEY)
}

// Xác thực tổng: ƯU TIÊN key trước (đúng tinh thần "cửa thoát hiểm", luôn
// hoạt động bất kể session ra sao) — CHỈ khi key thiếu hoặc sai mới rơi
// xuống kiểm tra session admin. Nhờ vậy:
//   - Link tắt dán key trên trình duyệt/điện thoại vẫn chạy y như cũ,
//     không phụ thuộc có đăng nhập admin hay không.
//   - Nút bấm trong trang quản trị (đã có session) không cần đính kèm key
//     nữa vẫn hoạt động được, không cần lộ NEXT_PUBLIC_SYSTEM_PAUSE_KEY
//     thêm 1 lần nữa qua request này.
// Trả về { ok, via } — via cho biết request được cho qua nhờ "key" hay
// "session", dùng để log và trả kèm trong response.
function authorize(req, res) {
  if (isKeyValid(req)) return { ok: true, via: 'key' }

  const isAdmin = verifySession(req)
  if (isAdmin) {
    refreshSession(req, res) // gia hạn session, giống các route admin khác
    return { ok: true, via: 'session' }
  }

  return { ok: false, via: null }
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

  const { ok: authorized, via } = authorize(req, res)
  const ip = req.headers['x-forwarded-for'] || req.socket?.remoteAddress || 'unknown'

  if (!authorized) {
    console.log(`[system-pause] UNAUTHORIZED attempt from ${ip} @ ${new Date().toISOString()}`)
    return res.status(401).json({ error: 'Sai hoặc thiếu api-key, và cũng chưa đăng nhập admin.' })
  }

  const action = req.body?.action || req.query.action

  // Log NGAY giá trị action nhận được (kể cả undefined) — nếu 1 request
  // action=on mà không thấy dòng log này với action="on", nghĩa là request
  // đó không tới được đây với query đúng như kỳ vọng (deploy sai bản, path
  // sai, hoặc bị proxy/cache chặn trước khi tới function). Log kèm `via`
  // để biết request này qua được nhờ key hay session.
  console.log(`[system-pause] REQUEST method=${req.method} via=${via} action=${JSON.stringify(action)} query=${JSON.stringify(req.query)}`)

  if (action && action !== 'on' && action !== 'off') {
    return res.status(400).json({ error: 'action phải là "on" hoặc "off".' })
  }

  if (action === 'on') {
    const reason = req.body?.reason || req.query.reason || null
    const meta = { pausedAt: new Date().toISOString(), reason }
    await Promise.all([redis.set(REDIS_KEY, '1'), redis.set(REDIS_META_KEY, JSON.stringify(meta))])

    // [MỚI] Logout thiết bị hiện tại — ghi đè lên Set-Cookie mà
    // refreshSession() có thể đã set bên trong authorize() phía trên (via
    // session). clearSessionCookie() gọi setHeader('Set-Cookie', ...) nên
    // sẽ THAY THẾ giá trị cũ, không cộng dồn — kết quả cuối cùng gửi về
    // browser luôn là "xoá cookie", không phải "gia hạn rồi lại xoá" bị
    // lẫn lộn.
    clearSessionCookie(res)

    console.log(`[system-pause] TURNED ON by ${ip} (via=${via}) @ ${new Date().toISOString()}${reason ? ` — lý do: ${reason}` : ''} — đã logout session thiết bị này`)
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
    return res.status(200).json({ paused: true, ...meta, _version: CODE_VERSION, _authVia: via, loggedOut: true })
  }

  if (action === 'off') {
    await Promise.all([redis.set(REDIS_KEY, '0'), redis.del(REDIS_META_KEY)])
    console.log(`[system-pause] TURNED OFF by ${ip} (via=${via}) @ ${new Date().toISOString()}`)
    return res.status(200).json({ paused: false, _version: CODE_VERSION, _authVia: via })
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

  return res.status(200).json({ paused, ...meta, _version: CODE_VERSION, _authVia: via })
}