// lib/systemPause.js
//
// Cờ "TẠM DỪNG TOÀN HỆ THỐNG" — dùng khi muốn ngưng hẳn mọi hoạt động của
// web (cả trang khách /thanh-toan lẫn trang admin, cả các API tạo/kiểm
// tra giao dịch) để tránh tốn tài nguyên (gọi MoMo, đọc/ghi Redis...) lúc
// không cần dùng tới (vd nghỉ bán qua đêm, đang bảo trì).
//
// Lưu 1 record duy nhất trong Redis (dùng chung Upstash với lib/orders.js
// qua KV_REST_API_URL / KV_REST_API_TOKEN) — không cần bảng/khoá riêng.
//
// QUAN TRỌNG: cờ này chỉ đọc/ghi Redis, KHÔNG tự chặn gì cả — nơi THỰC SỰ
// chặn request là middleware.js ở gốc project (chạy trước mọi page/API).
// Route này (systemPause.js) chỉ để các API khác (system-pause.js,
// login.js) đọc/bật/tắt cờ.
//
// Vòng đời cờ:
//   - pauseSystem()  : admin bấm nút "Tạm dừng" -> paused = true. Từ giờ
//     middleware chặn hết, kể cả chính admin đó (session cookie tuy còn
//     hợp lệ về mặt chữ ký nhưng middleware vẫn chặn không cho làm gì).
//   - resumeSystem() : GỌI TỰ ĐỘNG bên trong pages/api/admin/login.js mỗi
//     khi có ai đăng nhập admin thành công — đúng tinh thần "tạm dừng đến
//     khi login lại". KHÔNG có API "mở lại" riêng nào khác — muốn mở lại
//     bắt buộc phải qua màn đăng nhập.

import { Redis } from '@upstash/redis'

const redis = new Redis({
  url: process.env.KV_REST_API_URL,
  token: process.env.KV_REST_API_TOKEN,
})

const PAUSE_KEY = 'momo:system:pause'

/** Đọc trạng thái hiện tại. Mặc định (chưa từng bật) coi như KHÔNG tạm dừng. */
export async function getPauseState() {
  const data = await redis.get(PAUSE_KEY)
  return data || { paused: false, pausedAt: null }
}

/** Bật tạm dừng — chặn toàn bộ web ngay từ request kế tiếp. */
export async function pauseSystem() {
  const state = { paused: true, pausedAt: Date.now() }
  await redis.set(PAUSE_KEY, state)
  return state
}

/**
 * Mở lại hệ thống — CHỈ nơi duy nhất nên gọi hàm này là login.js sau khi
 * xác thực mật khẩu admin thành công. Không export theo hướng cho phép
 * gọi tùy tiện từ route khác để giữ đúng nguyên tắc "chỉ mở lại khi login".
 */
export async function resumeSystem() {
  const state = { paused: false, pausedAt: null }
  await redis.set(PAUSE_KEY, state)
  return state
}
