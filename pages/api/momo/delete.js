// pages/api/momo/delete.js
import { requireAdmin } from '../../../lib/requireAdmin'
import { deleteOrder } from '../../../lib/orders'

export default async function handler(req, res) {
  if (req.method !== 'DELETE') return res.status(405).json({ error: 'Method not allowed' })
  if (!requireAdmin(req, res)) return

  // Hỗ trợ cả 2 kiểu gọi:
  //   - { orderId: 'xxx' }              -> xóa 1 đơn (tương thích ngược, cách gọi cũ)
  //   - { orderIds: ['a', 'b', 'c'] }   -> xóa nhiều đơn cùng lúc
  const { orderId, orderIds } = req.body || {}

  let ids = []
  if (Array.isArray(orderIds)) {
    ids = orderIds.map((id) => String(id).trim()).filter(Boolean)
  } else if (orderId) {
    ids = [String(orderId).trim()]
  }

  // Loại trùng — tránh xóa/log lặp nếu FE lỡ gửi trùng id trong mảng.
  ids = [...new Set(ids)]

  if (ids.length === 0) {
    return res.status(400).json({ error: 'Thiếu orderId hoặc orderIds' })
  }

  console.log(`[delete] DELETE ${ids.length} đơn: ${ids.join(', ')} @ ${new Date().toISOString()}`)

  // Promise.allSettled thay vì Promise.all — 1 đơn lỗi (vd Redis timeout)
  // không được làm mất kết quả của các đơn khác đã xóa thành công.
  const results = await Promise.allSettled(ids.map((id) => deleteOrder(id)))

  const deleted = []
  const failed = []
  results.forEach((r, i) => {
    if (r.status === 'fulfilled') {
      deleted.push(ids[i])
    } else {
      failed.push({ orderId: ids[i], error: r.reason?.message || 'Lỗi không xác định' })
      console.error(`[delete] Lỗi khi xóa đơn ${ids[i]}:`, r.reason)
    }
  })

  console.log(`[Admin Delete] Đã xóa ${deleted.length}/${ids.length} đơn${failed.length ? `, ${failed.length} lỗi` : ''}`)

  // Giữ nguyên format response cũ khi chỉ xóa 1 đơn duy nhất và thành công
  // -> không phá code FE đang parse theo kiểu cũ ({ success, message }).
  if (ids.length === 1) {
    if (deleted.length === 1) {
      return res.status(200).json({ success: true, message: `Đã xóa đơn ${deleted[0]}` })
    }
    return res.status(500).json({ success: false, error: 'Lỗi server khi xóa' })
  }

  // Xóa nhiều đơn: trả chi tiết đơn nào xóa được, đơn nào lỗi.
  if (failed.length > 0 && deleted.length === 0) {
    return res.status(500).json({ success: false, message: 'Xóa thất bại toàn bộ', deleted, failed })
  }

  return res.status(200).json({
    success: true,
    message: `Đã xóa ${deleted.length}/${ids.length} đơn${failed.length ? ` (${failed.length} lỗi)` : ''}`,
    deleted,
    failed,
  })
}