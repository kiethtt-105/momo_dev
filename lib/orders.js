// lib/orders.js
//
// Lưu trữ đơn hàng bằng Upstash Redis (REST API — an toàn cho môi trường
// serverless, KHÔNG dùng file JSON vì ổ đĩa trên Vercel không giữ được
// state giữa các lần gọi API / lần deploy).
//
// Dùng chung 2 biến môi trường KV_REST_API_URL / KV_REST_API_TOKEN với
// vietqr-pay.js — đây là biến Vercel tự cấp khi bạn tạo KV/Redis database
// trong tab Storage (nay chạy trên nền Upstash).
//
// Cài package: npm install @upstash/redis
//
// ─── CHIẾN LƯỢC TTL THEO TRẠNG THÁI (thêm mới) ─────────────────────────
// Trước đây MỌI đơn (kể cả PENDING chưa rõ kết quả) đều bị giữ nguyên 30
// ngày trong Redis — tốn tài nguyên vô ích với các đơn khách bỏ dở, quét
// nhầm, hoặc không bao giờ thanh toán.
//
// Giờ TTL được tính lại MỖI LẦN saveOrder() theo status của chính bản ghi
// đang lưu (không cần sửa gì ở create.js/query.js/ipn.js — các route đó
// vẫn gọi saveOrder(orderId, data) y như cũ, data.status là gì thì TTL
// tự suy ra từ đó):
//
//   - status = PAID | FAILED (MoMo đã trả kết quả DỨT KHOÁT, dù thành
//     công hay thất bại) → giữ đủ 30 ngày như cũ, để còn tra cứu/đối
//     soát/thống kê sau này.
//   - status khác (PENDING, hoặc bất kỳ trạng thái tạm nào) → CHỈ giữ
//     tạm tới khi đơn hết hạn (dùng field `expiresAt` nếu route đã set —
//     ví dụ luồng p2p có ORDER_EXPIRE_MS 10 phút) CỘNG THÊM 1 khoảng đệm
//     (PENDING_GRACE_SECONDS) để admin/khách vẫn kịp bấm "Kiểm tra ngay"
//     hoặc /api/momo/query poll thêm vài phút sau khi hết hạn hiển thị,
//     phòng trường hợp MoMo xử lý xong trễ hơn khách nhìn thấy đồng hồ
//     đếm ngược. Hết khoảng đệm này mà vẫn chưa có kết quả dứt khoát thì
//     Redis tự xoá bản ghi PENDING — không cần cron dọn dẹp thủ công.
//   - Nếu route KHÔNG set expiresAt (ví dụ luồng scan/POS — MoMo trả kết
//     quả gần như ngay lập tức nên vốn dĩ không cần hạn riêng) thì dùng
//     PENDING_FALLBACK_TTL_SECONDS làm lưới an toàn, phòng trường hợp
//     server crash/lỗi mạng giữa lúc tạo PENDING và lúc ghi kết quả cuối
//     — tránh bản ghi PENDING kẹt vĩnh viễn trong Redis.
//
// LƯU Ý: mỗi lần gọi saveOrder() cho 1 đơn PENDING, TTL được TÍNH LẠI TỪ
// ĐẦU theo thời điểm hiện tại (không cộng dồn) — đúng ý nghĩa "còn bao
// lâu nữa thì hết hạn", không phải "gia hạn thêm mỗi lần ghi".

import { Redis } from '@upstash/redis'

const redis = new Redis({
  url: process.env.KV_REST_API_URL,
  token: process.env.KV_REST_API_TOKEN,
})

const KEY_PREFIX = 'momo:order:'
const INDEX_KEY = 'momo:orders:index'

// TTL cho đơn đã CÓ kết quả dứt khoát từ MoMo (PAID/FAILED) — giữ như cũ.
const ORDER_TTL_SECONDS = 60 * 60 * 24 * 30 // 30 ngày

// Các status được coi là "kết quả dứt khoát" -> lưu lâu dài. Nếu sau này
// thêm status mới (vd REFUNDED) mà cũng muốn giữ lâu dài thì thêm vào set
// này là đủ, không cần sửa logic saveOrder() bên dưới.
const FINAL_STATUSES = new Set(['PAID', 'FAILED'])

// Khoảng đệm cộng thêm SAU expiresAt của đơn — vẫn còn tra được bằng
// /api/momo/query trong lúc này dù trên FE đồng hồ đếm ngược đã về 0.
const PENDING_GRACE_SECONDS = 5 * 60 // 5 phút

// TTL mặc định cho đơn PENDING KHÔNG có field expiresAt (vd luồng scan/
// POS) — chỉ là lưới an toàn phòng crash giữa chừng, bình thường đơn loại
// này chuyển sang PAID/FAILED gần như ngay lập tức nên hiếm khi chạm tới
// TTL này.
const PENDING_FALLBACK_TTL_SECONDS = 15 * 60 // 15 phút

// TTL tối thiểu để tránh set giá trị 0/âm cho Redis (vd trường hợp
// expiresAt đã ở quá khứ ngay lúc save — vẫn cho tồn tại thêm ít phút để
// không "biến mất" đột ngột ngay giữa lúc đang xử lý).
const MIN_TTL_SECONDS = 60

function resolveTtlSeconds(data) {
  if (FINAL_STATUSES.has(data?.status)) return ORDER_TTL_SECONDS

  if (data?.expiresAt) {
    const remainingMs = new Date(data.expiresAt).getTime() - Date.now()
    const remainingSec = Math.round(remainingMs / 1000)
    return Math.max(remainingSec + PENDING_GRACE_SECONDS, MIN_TTL_SECONDS)
  }

  return PENDING_FALLBACK_TTL_SECONDS
}

/** Lấy 1 đơn hàng theo orderId. Trả về null nếu không tồn tại. */
export async function getOrder(orderId) {
  const data = await redis.get(KEY_PREFIX + orderId)
  return data || null
}

/**
 * Lưu (tạo mới hoặc ghi đè) 1 đơn hàng.
 *
 * TTL tự động suy ra từ `data.status` (xem resolveTtlSeconds ở trên) —
 * PAID/FAILED giữ 30 ngày, còn lại (PENDING...) chỉ giữ tạm tới lúc hết
 * hạn + buffer để tiết kiệm tài nguyên Redis.
 */
export async function saveOrder(orderId, data) {
  const ttl = resolveTtlSeconds(data)
  await redis.set(KEY_PREFIX + orderId, data, { ex: ttl })
  // zadd để listOrders() lấy được danh sách theo thời gian, mới nhất trước
  await redis.zadd(INDEX_KEY, { score: Date.now(), member: orderId })
  return data
}

/** Xóa hẳn 1 đơn hàng. */
export async function deleteOrder(orderId) {
  await redis.del(KEY_PREFIX + orderId)
  await redis.zrem(INDEX_KEY, orderId)
}

/**
 * Lấy toàn bộ đơn hàng, mới nhất trước.
 *
 * Vì các đơn PENDING giờ có TTL ngắn, key gốc (momo:order:xxx) có thể đã
 * bị Redis tự xoá trong khi orderId vẫn còn nằm trong INDEX_KEY (zset
 * KHÔNG tự đồng bộ theo TTL của key khác) — nếu không dọn, index sẽ phình
 * to dần theo thời gian dù dữ liệu thật đã mất. Mỗi lần listOrders() chạy,
 * tiện thể dọn rác luôn: id nào redis.get() trả về null thì gỡ khỏi
 * index (chạy nền, không chặn response trả về danh sách đơn còn sống).
 */
export async function listOrders() {
  const ids = await redis.zrange(INDEX_KEY, 0, -1, { rev: true })
  if (!ids || ids.length === 0) return []

  const orders = await Promise.all(ids.map((id) => redis.get(KEY_PREFIX + id)))

  const staleIds = ids.filter((id, i) => !orders[i])
  if (staleIds.length > 0) {
    // Không await — dọn rác không phải việc bắt buộc phải xong trước khi
    // trả kết quả cho FE, lỗi ở đây (nếu có) cũng không ảnh hưởng tới
    // danh sách đơn trả về.
    redis.zrem(INDEX_KEY, ...staleIds).catch((err) => {
      console.error('[orders] Lỗi dọn rác index:', err)
    })
  }

  return orders.filter(Boolean)
}

/**
 * Ẩn field nhạy cảm khi trả dữ liệu cho khách (không phải admin) — ví dụ
 * mã thanh toán khách đã submit, requestId nội bộ, extraData base64...
 */
export function toPublicOrder(order) {
  const { submittedCode, requestId, extraData, ...rest } = order
  return rest
}