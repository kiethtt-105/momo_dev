// pages/api/momo/ipn.js
// "Lưu giao dịch" cho luồng p2p (webhook MoMo gọi khi khách thanh toán
// xong). CHỈ ghi khi có resultCode thật từ MoMo — không có khái niệm tự
// đánh dấu "hết hạn" ở đây, IPN vốn chỉ được gọi khi có kết quả thật.

import { verifyIpnSignature } from '../../../lib/momo'
import { getOrder, saveOrder } from '../../../lib/orders'

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    console.error(`[MoMo IPN] Sai method: ${req.method} ${req.url} — có thể do redirect (kiểm tra ipnUrl domain/protocol)`)
    return res.status(405).end()

  }

  console.log(`[ipn] Nhận request @ ${new Date().toISOString()}`)
  const body = req.body
  console.log('[MoMo IPN] Body nhận được:', JSON.stringify(body))   // ← thêm dòng này

  if (!verifyIpnSignature(body)) {
    console.error('[MoMo IPN] Invalid signature!')
    return res.status(400).json({ message: 'Invalid signature' })
  }

  const {
    orderId, transId, resultCode, amount, payType, orderInfo,
    requestId, message, responseTime, orderType, extraData,
  } = body

  const isPaid = parseInt(resultCode) === 0
  const now = new Date().toISOString()

  const prev = await getOrder(orderId)
  // Đã PAID rồi thì bỏ qua IPN duplicate (MoMo có thể gọi lại nhiều lần)
  if (prev?.status === 'PAID') return res.status(204).end()

  // Giữ lại toàn bộ field đã có sẵn từ lúc tạo đơn (payUrl, qrCodeImage,
  // storeId, storeName...) — spread `prev` TRƯỚC rồi mới ghi đè bằng dữ
  // liệu thật từ IPN. Bug từng có ở save.js bản cũ là build record mới
  // hoàn toàn không spread prev, khiến các field này bị xoá mất mỗi lần
  // IPN chạy.
  const record = {
    ...prev,
    orderId,
    transId:      transId || prev?.transId || '',
    amount:       parseInt(amount || prev?.amount || 0),
    payType:      payType || prev?.payType || '',
    orderInfo:    orderInfo || prev?.orderInfo || '',
    resultCode:   parseInt(resultCode),
    message:      message || '',
    responseTime: responseTime || null,
    orderType:    orderType || prev?.orderType || '',
    extraData:    extraData || prev?.extraData || '',
    requestId:    requestId || prev?.requestId || '',
    paidAt:       isPaid ? now : (prev?.paidAt || null),
    createdAt:    prev?.createdAt || now,
    status:       isPaid ? 'PAID' : 'FAILED',
    source:       'ipn',
  }

  await saveOrder(orderId, record)
  console.log(`[IPN] ${orderId} → ${isPaid ? '✅ PAID' : '❌ FAILED'} | resultCode: ${resultCode} | ${message}`)
  return res.status(204).end()
}
