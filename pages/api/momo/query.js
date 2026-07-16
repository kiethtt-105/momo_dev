// pages/api/momo/query.js
//
// Hỏi thẳng MoMo server-to-server xem đơn đã thanh toán thật chưa —
// dùng khi nghi ngờ IPN không tới (thanh toán xong nhưng FE/đơn vẫn
// đứng ở PENDING). KHÔNG cần chờ webhook, gọi lúc nào cũng được.
//
// Sau khi có kết quả từ MoMo, route TỰ ĐỘNG đồng bộ luôn xuống Redis
// (giống hệt logic ipn.js) — nếu resultCode=0 thì set PAID, nếu khác 0
// và MoMo xác nhận là lỗi thật (không phải "chưa có kết quả") thì set
// FAILED. Nhờ vậy nếu IPN bị mất, chỉ cần gọi route này 1 lần là đơn
// được cập nhật đúng, không cần sửa tay trong Redis.
//
// Xác thực: CHỈ session admin đã đăng nhập — route này lộ dữ liệu giao
// dịch chi tiết nên không dùng chung API key với create.js (Shortcuts).

import { queryMoMoTransaction } from '../../../lib/momo'
import { getOrder, saveOrder } from '../../../lib/orders'
import { formatResultCodeMessage } from '../../../lib/momoResultCodes'
import { verifySession, refreshSession } from '../admin/login'

// resultCode MoMo dùng để báo "giao dịch chưa tồn tại / chưa có kết quả",
// KHÔNG phải là lỗi thật — gặp mã này thì KHÔNG được ghi đè order thành
// FAILED, cứ để nguyên PENDING và thử lại sau.
// Theo tài liệu MoMo (Query Transaction Status): 1000 = giao dịch đang
// được xử lý, 7002 = giao dịch đang chờ người dùng xác nhận thanh toán.
const PENDING_RESULT_CODES = new Set([1000, 7002])

export default async function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'POST') {
    res.setHeader('Allow', ['GET', 'POST'])
    return res.status(405).json({ error: 'Method not allowed' })
  }

  if (!verifySession(req)) {
    return res.status(401).json({ error: 'Chưa đăng nhập admin' })
  }
  refreshSession(req, res)

  const params = req.method === 'GET' ? req.query : req.body
  const orderId = (params.orderId || '').toString().trim()
  if (!orderId) {
    return res.status(400).json({ error: 'Thiếu orderId' })
  }

  try {
    const data = await queryMoMoTransaction({ orderId })
    const resultCode = parseInt(data.resultCode)
    const isPaid = resultCode === 0
    const isStillPending = PENDING_RESULT_CODES.has(resultCode)

    const prev = await getOrder(orderId)
    let syncedStatus = prev?.status || null

    // Chỉ ghi đè Redis khi có kết quả DỨT KHOÁT (thành công hoặc thất bại
    // thật sự) — tránh việc query lúc MoMo chưa xử lý xong lại vô tình
    // đánh dấu FAILED oan cho 1 đơn thực ra vẫn đang chạy.
    if (prev && prev.status !== 'PAID' && !isStillPending) {
      const now = new Date().toISOString()
      const record = {
        ...prev,
        transId: data.transId?.toString() || prev.transId || '',
        resultCode,
        message: isPaid
          ? (data.message || 'Thanh toán thành công')
          : formatResultCodeMessage(resultCode, data.message),
        responseTime: data.responseTime || prev.responseTime || null,
        paidAt: isPaid ? now : prev.paidAt || null,
        status: isPaid ? 'PAID' : 'FAILED',
        source: 'query',
      }
      await saveOrder(orderId, record)
      syncedStatus = record.status
    }

    return res.status(200).json({
      // Toàn bộ field gốc mà MoMo trả về (Query Transaction Status)
      partnerCode: data.partnerCode,
      requestId: data.requestId,
      orderId: data.orderId || orderId,
      extraData: data.extraData,
      amount: data.amount,
      transId: data.transId,
      payType: data.payType,
      resultCode,
      refundTrans: data.refundTrans,
      message: data.message,
      responseTime: data.responseTime,
      paymentOption: data.paymentOption,
      promotionInfo: data.promotionInfo,

      // Field tự thêm để tiện xử lý phía FE
      isPaid,
      isStillPending,
      orderStatus: syncedStatus, // trạng thái order trong Redis SAU khi đồng bộ (nếu có)
    })
  } catch (err) {
    console.error('[query] error:', err)
    return res.status(500).json({ error: 'Lỗi khi query MoMo', detail: err.message })
  }
}