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

import { Redis } from '@upstash/redis'

const redis = new Redis({
  url: process.env.KV_REST_API_URL,
  token: process.env.KV_REST_API_TOKEN,
})

const KEY_PREFIX = 'momo:order:'
const INDEX_KEY = 'momo:orders:index'
const ORDER_TTL_SECONDS = 60 * 60 * 24 * 30 // giữ đơn hàng 30 ngày

/** Lấy 1 đơn hàng theo orderId. Trả về null nếu không tồn tại. */
export async function getOrder(orderId) {
  const data = await redis.get(KEY_PREFIX + orderId)
  return data || null
}

/** Lưu (tạo mới hoặc ghi đè) 1 đơn hàng. */
export async function saveOrder(orderId, data) {
  await redis.set(KEY_PREFIX + orderId, data, { ex: ORDER_TTL_SECONDS })
  // zadd để listOrders() lấy được danh sách theo thời gian, mới nhất trước
  await redis.zadd(INDEX_KEY, { score: Date.now(), member: orderId })
  return data
}

/** Xóa hẳn 1 đơn hàng. */
export async function deleteOrder(orderId) {
  await redis.del(KEY_PREFIX + orderId)
  await redis.zrem(INDEX_KEY, orderId)
}

/** Lấy toàn bộ đơn hàng, mới nhất trước. */
export async function listOrders() {
  const ids = await redis.zrange(INDEX_KEY, 0, -1, { rev: true })
  if (!ids || ids.length === 0) return []

  const orders = await Promise.all(ids.map((id) => redis.get(KEY_PREFIX + id)))
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
