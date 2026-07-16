// pages/api/momo/transfer-info.js
// API trả về thông tin chuyển khoản THẬT (ngân hàng, số tài khoản, nội
// dung, số tiền) decode trực tiếp từ mã QR thanh toán thật do MoMo tạo ra
// (KHÔNG phải build lại/đoán từ dữ liệu order) — dùng cho trường hợp khách
// KHÔNG quét được QR mà cần tự nhập tay chuyển khoản qua app ngân hàng.
//
// Kết quả decode được LƯU LẠI vào order.vietqr (Redis) — lần gọi sau cho
// cùng orderId trả thẳng từ cache này, KHÔNG chạy lại Puppeteer (bước tốn
// chi phí/thời gian nhất hệ thống). order.vietqr cũng chính là field
// lib/orders.js -> toPublicOrder() đã định nghĩa sẵn từ trước để show cho
// khách qua /api/momo/orders, giờ mới thực sự được điền dữ liệu.
//
// GET /api/momo/transfer-info?orderId=xxx
//   ?refresh=1   bỏ qua cache order.vietqr, decode lại từ đầu và ghi đè
//
//   npm install jsqr pngjs

import jsQR from 'jsqr'
import { PNG } from 'pngjs'
import { getPaymentQrPngBuffer } from '../../../lib/momo/qrScraper'
import { getOrder, saveOrder } from '../../../lib/orders'
import { parseVietQR } from '../../../lib/momo/vietqr-parser'
import { lookupBankByBin } from '../../../lib/momo/vietqr-bank-directory'

export const config = {
  api: { externalResolver: true },
  maxDuration: 60,
}

function decodeQrStringFromPng(buffer) {
  let png
  try {
    png = PNG.sync.read(buffer)
  } catch {
    throw Object.assign(new Error('Ảnh QR trả về không phải PNG hợp lệ'), { status: 502 })
  }

  const code = jsQR(new Uint8ClampedArray(png.data), png.width, png.height, {
    inversionAttempts: 'attemptBoth',
  })

  if (!code || !code.data) {
    throw Object.assign(new Error('Không đọc được mã QR trong ảnh (jsQR không nhận diện được)'), { status: 502 })
  }

  return code.data
}

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' })

  const orderId = (req.query.orderId || '').toString().trim()
  if (!orderId) return res.status(400).json({ error: 'Thiếu orderId' })

  const order = await getOrder(orderId)
  if (!order) return res.status(404).json({ error: 'Không tìm thấy đơn hàng' })

  const refresh = req.query.refresh === '1'

  // Fast-path: đã decode rồi (lưu ở lần gọi trước) -> trả thẳng, khỏi chạy
  // lại Puppeteer. Chỉ bỏ qua khi có ?refresh=1 (vd đơn bị đổi thông tin,
  // hoặc nghi ngờ dữ liệu cũ sai).
  if (order.vietqr && !refresh) {
    res.setHeader('Cache-Control', 'no-store')
    return res.status(200).json({ orderId, ...order.vietqr, cached: true })
  }

  const payUrl = (order.payUrl || '').toString().trim()
  if (!payUrl || !payUrl.startsWith('https://payment.momo.vn')) {
    return res.status(404).json({ error: 'Đơn hàng chưa có payUrl hợp lệ' })
  }

  try {
    // noCache mặc định false — CỐ TÌNH tận dụng cache chung với qr-extract.js:
    // nếu khách vừa quét ảnh (đã trigger Puppeteer) thì lần gọi info này gần
    // như tức thời, không cần chạy lại Chromium.
    const { buffer } = await getPaymentQrPngBuffer(payUrl, { noCache: req.query.nocache === '1' })

    const qrString = decodeQrStringFromPng(buffer)
    const parsed = parseVietQR(qrString)
    const bank = await lookupBankByBin(parsed.bankBin)

    const vietqr = {
      bank,
      accountNumber: parsed.accountNumber,
      amount: parsed.amount,
      currency: parsed.currency === '704' ? 'VND' : parsed.currency,
      content: parsed.content,
      serviceCode: parsed.serviceCode, // QRIBFTTA (chuyển khoản TK) | QRIBFTTC (chuyển khoản thẻ)
      // MoMo thường KHÔNG nhúng tên merchant vào QR (tag 59 optional) —
      // fallback sang storeName đã lưu sẵn trong order lúc create.js chạy.
      merchantName: parsed.merchantName || order.storeName || null,
    }

    await saveOrder(orderId, { ...order, vietqr })

    res.setHeader('Cache-Control', 'no-store')
    return res.status(200).json({ orderId, ...vietqr, cached: false })
  } catch (err) {
    console.error('[transfer-info] error:', err)
    return res.status(err.status || 500).json({ error: err.publicMessage || err.message || 'Không đọc được thông tin ngân hàng từ mã QR' })
  }
}