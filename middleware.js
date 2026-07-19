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
// TỐI ƯU so với bản gốc:
//   1. Cache kết quả "paused" trong bộ nhớ của edge instance (TTL ngắn,
//      mặc định 3s) -> giảm mạnh số lần gọi Redis khi traffic cao, mà vẫn
//      đảm bảo lệnh pause/unpause có hiệu lực gần như ngay lập tức (trễ tối
//      đa = TTL cache). Đây là cache best-effort, KHÔNG dùng để tăng độ trễ
//      lên nhiều giây — nếu cần chặn tức thời tuyệt đối, đặt CACHE_TTL_MS=0.
//   2. Bớt log: chỉ log khi có BLOCK hoặc khi Redis lỗi, không log mọi
//      request đi qua (bản gốc log cả khi không bị chặn -> tốn log/chi phí
//      ở traffic lớn). Bật lại log chi tiết bằng biến env DEBUG_SYSTEM_PAUSE=1
//      khi cần soi lỗi cache/middleware.
//   3. Vẫn giữ nguyên: fail-open khi Redis lỗi (không khoá nhầm toàn hệ
//      thống), route always-allowed, header debug x-mw-checked.

import { NextResponse } from 'next/server'
import { Redis } from '@upstash/redis'

const redis = Redis.fromEnv()

// Đường dẫn KHÔNG BAO GIỜ bị chặn, kể cả khi đang paused — phải luôn gọi
// được để còn mở lại hệ thống.
const ALWAYS_ALLOWED = ['/api/admin/system-pause']

// TTL cache cờ "paused" trong bộ nhớ (ms). Mỗi edge instance tự cache
// riêng, không chia sẻ giữa các instance/region -> đây chỉ giảm tải Redis,
// không phải cache tuyệt đối chính xác 100% giữa các instance.
const CACHE_TTL_MS = Number(process.env.SYSTEM_PAUSE_CACHE_TTL_MS ?? 3000)
const DEBUG = process.env.DEBUG_SYSTEM_PAUSE === '1'

let cachedPaused = null // null = chưa có cache
let cachedAt = 0

async function getPaused() {
  const now = Date.now()
  if (cachedPaused !== null && now - cachedAt < CACHE_TTL_MS) {
    return cachedPaused
  }
  try {
    const val = (await redis.get('system:paused')) === '1'
    cachedPaused = val
    cachedAt = now
    return val
  } catch (err) {
    // Redis lỗi/không kết nối được -> KHÔNG khoá nhầm toàn hệ thống chỉ vì
    // Redis trục trặc, coi như đang chạy bình thường. Không cache lỗi này,
    // để lần request kế tiếp thử lại Redis ngay.
    console.log(`[system-pause] REDIS ERROR khi kiểm tra "system:paused": ${err?.message || err}`)
    return false
  }
}

export async function middleware(req) {
  const { pathname } = req.nextUrl

  if (ALWAYS_ALLOWED.some((p) => pathname === p || pathname.startsWith(p + '/'))) {
    if (DEBUG) console.log(`[system-pause] SKIP (always-allowed) ${req.method} ${pathname}`)
    return NextResponse.next()
  }

  const paused = await getPaused()

  if (DEBUG) {
    console.log(`[system-pause] CHECK ${req.method} ${pathname} paused=${paused} @ ${new Date().toISOString()}`)
  }

  if (paused) {
    console.log(`[system-pause] BLOCKED ${req.method} ${pathname} @ ${new Date().toISOString()}`)
    return NextResponse.json(
      { error: 'Hệ thống đang tạm dừng, vui lòng thử lại sau.', paused: true },
      { status: 503, headers: { 'Cache-Control': 'no-store' } }
    )
  }

  // Gắn header debug vào response đi qua để tự kiểm tra bằng DevTools:
  // nếu KHÔNG thấy header "x-mw-checked: 1" trên response -> request đó
  // không đi qua middleware (rất có thể do bị Edge Cache trả 304 thẳng).
  const res = NextResponse.next()
  res.headers.set('x-mw-checked', '1')
  return res
}

export const config = {
  // Chỉ chạy middleware này cho /api/*, các trang admin/trang tĩnh khác
  // (index.js, tao-giao-dich.js...) vẫn tải bình thường kể cả lúc paused —
  // để admin còn VÀO ĐƯỢC trang mà bấm nút mở lại.
  matcher: ['/api/:path*'],
}