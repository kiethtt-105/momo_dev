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
// Xác thực — 2 luồng:
//   - Admin (session đã đăng nhập): full quyền, trả về TOÀN BỘ field MoMo
//     gốc như trước giờ.
//   - Khách (trang /thanh-toan, không đăng nhập): PHẢI kèm ?token=xxx do
//     /api/momo/guest-check-token cấp riêng cho ĐÚNG orderId này — token
//     dùng 1 lần, hết hạn rất nhanh, không dùng lại được và không dùng
//     được cho đơn khác. Khách nhận về field cần cho giao diện thanh toán
//     (isPaid/isStillPending/orderStatus/orderInfo/amount/paidAt/transId/
//     storeName/aio_qr) — vẫn KHÔNG lộ payType, promotionInfo,
//     partnerCode, requestId... như phía admin.

import { queryMoMoTransaction } from '../../../lib/momo'
import { getOrder, saveOrder } from '../../../lib/orders'
import { formatResultCodeMessage } from '../../../lib/momoResultCodes'
import { verifySession, refreshSession } from '../admin/login'

// Xác nhận + "đốt" token dùng-1-lần của khách. Trả về null nếu hợp lệ (và
// đã đánh dấu used ngay lập tức), hoặc chuỗi lý do lỗi nếu không hợp lệ.
// Đốt token TRƯỚC khi gọi MoMo — kể cả khi bước gọi MoMo phía dưới lỗi/
// timeout, token này vẫn không dùng lại được nữa (đúng tinh thần "dùng 1 lần").
async function consumeGuestToken(order, orderId, token) {
  const t = order?.guestCheckToken
  if (!token) return 'Thiếu token'
  if (!t || t.token !== token) return 'Token không hợp lệ'
  if (t.used) return 'Token đã được sử dụng'
  if (t.expiresAt <= Date.now()) return 'Token đã hết hạn'
  await saveOrder(orderId, { ...order, guestCheckToken: { ...t, used: true } })
  return null
}

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

  const params = req.method === 'GET' ? req.query : req.body
  const orderId = (params.orderId || '').toString().trim()
  if (!orderId) {
    return res.status(400).json({ error: 'Thiếu orderId' })
  }

  const isAdmin = verifySession(req)
  if (isAdmin) refreshSession(req, res)

  // Khách (không session admin): bắt buộc có token hợp lệ, cấp riêng cho
  // đúng orderId này. Đọc order 1 lần ở đây để vừa xác thực token vừa tái
  // dùng cho bước đồng bộ Redis phía dưới (đỡ getOrder lại lần 2).
  let prevForGuest = null
  if (!isAdmin) {
    const token = (params.token || '').toString().trim()
    prevForGuest = await getOrder(orderId)
    if (!prevForGuest) return res.status(404).json({ error: 'Không tìm thấy đơn hàng' })

    const tokenErr = await consumeGuestToken(prevForGuest, orderId, token)
    if (tokenErr) return res.status(401).json({ error: tokenErr })
  }

  try {
    const data = await queryMoMoTransaction({ orderId })
    const resultCode = parseInt(data.resultCode)
    const isPaid = resultCode === 0
    const isStillPending = PENDING_RESULT_CODES.has(resultCode)

    const prev = prevForGuest || await getOrder(orderId)
    let syncedStatus = prev?.status || null
    let record = null

    // Chỉ ghi đè Redis khi có kết quả DỨT KHOÁT (thành công hoặc thất bại
    // thật sự) — tránh việc query lúc MoMo chưa xử lý xong lại vô tình
    // đánh dấu FAILED oan cho 1 đơn thực ra vẫn đang chạy.
    if (prev && prev.status !== 'PAID' && !isStillPending) {
      const now = new Date().toISOString()
      record = {
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

    if (!isAdmin) {
      // Khách: trả field tối thiểu để cập nhật giao diện + các field mở
      // rộng cho trang /thanh-toan (orderInfo, amount, paidAt, transId,
      // storeName, aio_qr). Vẫn KHÔNG lộ payType, promotionInfo,
      // partnerCode, requestId... — những field nội bộ không cần cho FE.
      const orderData = record || prev
      return res.status(200).json({
        orderId,
        isPaid,
        isStillPending,
        orderStatus: syncedStatus,
        orderInfo: orderData?.orderInfo ?? null,
        amount: orderData?.amount ?? data.amount ?? null,
        paidAt: orderData?.paidAt ?? null,
        transId: data.transId?.toString() || orderData?.transId || null,
        storeName: orderData?.storeName ?? null,
        aio_qr: orderData?.aio_qr ?? null,
      })
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