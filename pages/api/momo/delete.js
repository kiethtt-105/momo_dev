// pages/api/momo/delete.js
import { requireAdmin } from '../../../lib/requireAdmin'
import { deleteOrder } from '../../../lib/orders'

export default async function handler(req, res) {
  if (req.method !== 'DELETE') return res.status(405).json({ error: 'Method not allowed' })
  if (!requireAdmin(req, res)) return

  const { orderId } = req.body
  console.log(`[delete] DELETE orderId=${orderId || '(thiếu)'} @ ${new Date().toISOString()}`)
  if (!orderId) return res.status(400).json({ error: 'Thiếu orderId' })

  try {
    await deleteOrder(orderId)
    console.log(`[Admin Delete] Đã xóa đơn: ${orderId}`)
    return res.status(200).json({ success: true, message: `Đã xóa đơn ${orderId}` })
  } catch (err) {
    console.error('Delete error:', err)
    return res.status(500).json({ error: 'Lỗi server khi xóa' })
  }
}
