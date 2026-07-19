// pages/api/momo/cancel.js
import { requireAdmin } from '../../../lib/requireAdmin'
import { getOrder, saveOrder } from '../../../lib/orders'

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', ['POST'])
    return res.status(405).json({ error: 'Method not allowed' })
  }

  // orderId dạng iPOS<timestamp> khá dễ đoán — không auth thì ai cũng huỷ
  // được giao dịch PENDING của người khác. Chỉ admin đã đăng nhập mới hủy.
  if (!requireAdmin(req, res)) return

  const orderId = (req.body?.orderId || '').toString().trim()
  console.log(`[cancel] POST orderId=${orderId || '(thiếu)'} @ ${new Date().toISOString()}`)
  if (!orderId) return res.status(400).json({ error: 'Thiếu orderId' })

  try {
    let order = await getOrder(orderId)
    if (!order) return res.status(404).json({ error: 'Không tìm thấy đơn hàng' })

    if (order.status !== 'PENDING') {
      return res.status(200).json({ ...order, alreadyFinal: true })
    }

    order = {
      ...order,
      status: 'FAILED',
      message: 'Đã hủy bởi admin',
      resultCode: order.resultCode ?? -2,
      lastCheckedAt: new Date().toISOString(),
      source: 'admin-cancelled',
    }

    await saveOrder(orderId, order)
    console.log(`[cancel] ${orderId} → đã hủy`)
    return res.status(200).json(order)
  } catch (err) {
    console.error('[cancel] Lỗi:', err.message)
    return res.status(500).json({ error: 'Lỗi server, thử lại sau' })
  }
}
