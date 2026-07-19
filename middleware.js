// middleware.js  (đặt ở ROOT project, ngang hàng với pages/ — không phải
// trong pages/ — Next.js chỉ nhận middleware.js nếu để đúng chỗ này)
//
// CÔNG TẮC DỪNG TOÀN HỆ THỐNG (kill switch) — chạy ở tầng Edge Middleware,
// TRƯỚC khi request chạm tới bất kỳ route /api/* nào. Khi cờ "system:paused"
// trên Redis đang bật, MỌI request tới /api/* bị chặn ngay tại đây (trả về
// 503, không route nào bên trong kịp chạy) — TRỪ chính route bật/tắt
// (/api/admin/system-pause), để luôn còn đường TẮT lại dù mọi API khác
// đang bị khoá.
//
// Dùng gói @upstash/redis (chạy được trên Edge runtime, không dùng ioredis
// qua TCP được vì Edge không hỗ trợ kết nối TCP thường). Cần 2 biến môi
// trường chuẩn của Upstash đã có sẵn nếu dự án đang dùng Upstash Redis:
//   UPSTASH_REDIS_REST_URL
//   UPSTASH_REDIS_REST_TOKEN
// Nếu dự án đang có sẵn 1 client Redis riêng (vd lib/redis.js) và nó cũng
// chạy được trên Edge thì dùng lại client đó thay vì Redis.fromEnv() bên
// dưới cũng được, miễn giữ nguyên logic chặn.

import { NextResponse } from 'next/server'
import { Redis } from '@upstash/redis'

const redis = Redis.fromEnv()

// Đường dẫn KHÔNG BAO GIỜ bị chặn, kể cả khi đang paused — phải luôn gọi
// được để còn mở lại hệ thống.
const ALWAYS_ALLOWED = ['/api/admin/system-pause']

export async function middleware(req) {
  const { pathname } = req.nextUrl

  if (ALWAYS_ALLOWED.some((p) => pathname === p || pathname.startsWith(p + '/'))) {
    return NextResponse.next()
  }

  let paused = false
  try {
    paused = (await redis.get('system:paused')) === '1'
  } catch {
    // Redis lỗi/không kết nối được -> KHÔNG khoá nhầm toàn hệ thống chỉ vì
    // Redis trục trặc, coi như đang chạy bình thường.
    paused = false
  }

  if (paused) {
    return NextResponse.json(
      { error: 'Hệ thống đang tạm dừng, vui lòng thử lại sau.', paused: true },
      { status: 503 }
    )
  }

  return NextResponse.next()
}

export const config = {
  // Chỉ chạy middleware này cho /api/*, các trang admin/trang tĩnh khác
  // (index.js, tao-giao-dich.js...) vẫn tải bình thường kể cả lúc paused —
  // để admin còn VÀO ĐƯỢC trang mà bấm nút mở lại.
  matcher: ['/api/:path*'],
}