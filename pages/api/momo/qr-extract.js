// pages/api/momo/qr-extract.js
// CHỈ trả về ẢNH mã QR THANH TOÁN THẬT (VietQR do MoMo render sẵn trên
// trang payUrl) — KHÔNG phải QR mã hoá link payUrl (cái đó là qrCodeImage
// đã lưu sẵn trong order lúc create.js gọi QRCode.toDataURL(payUrl), quét
// vào chỉ MỞ TRANG MoMo chứ không mang thông tin chuyển khoản thật).
//
// Phần decode ra thông tin ngân hàng (account/amount/content) đã tách
// riêng sang /api/momo/transfer-info.js — 2 route dùng CHUNG
// lib/qrScraper.js, gọi hàm trực tiếp (không self-fetch qua network) và
// share cache theo payUrl, nên nếu 1 trong 2 đã lấy ảnh trước thì route
// kia dùng lại luôn, không chạy lại Puppeteer.
//
//   npm install puppeteer-core @sparticuz/chromium

import { getBrowser, getPaymentQrPngBuffer } from '../../../lib/momo/qrScraper'
import { getOrder } from '../../../lib/orders'

export const config = {
  api: { externalResolver: true },
  maxDuration: 60, // chỉ có tác dụng trên Vercel Pro trở lên — Hobby cứng 10s
}

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' })

  if (req.query.warm === '1') {
    try {
      await getBrowser()
      res.setHeader('Cache-Control', 'no-store')
      return res.status(200).json({ ok: true, warmed: true })
    } catch (err) {
      console.error('[qr-extract][warm] error:', err)
      return res.status(500).json({ ok: false })
    }
  }

  const orderId = (req.query.orderId || '').toString().trim()
  if (!orderId) return res.status(400).json({ error: 'Thiếu orderId' })

  const order = await getOrder(orderId)
  if (!order) return res.status(404).json({ error: 'Không tìm thấy đơn hàng' })

  const payUrl = (order.payUrl || '').toString().trim()
  if (!payUrl || !payUrl.startsWith('https://payment.momo.vn')) {
    return res.status(404).json({ error: 'Đơn hàng chưa có payUrl hợp lệ' })
  }

  const debug = req.query.debug === '1'
  const noCache = req.query.nocache === '1'

  try {
    const result = await getPaymentQrPngBuffer(payUrl, { noCache, debug })

    if (debug) {
      if (result.debugScreenshot) {
        res.setHeader('Content-Type', 'image/png')
        res.setHeader('Cache-Control', 'no-store')
        res.setHeader('X-QR-DataUri-Found', result.dataUriFound ? '1' : '0')
        return res.status(200).send(result.debugScreenshot)
      }
      return res.status(200).json({ dataUriFound: result.dataUriFound, dataUriPrefix: result.dataUriPrefix })
    }

    res.setHeader('Content-Type', 'image/png')
    res.setHeader('Cache-Control', 'no-store')
    res.setHeader('X-QR-Cache', result.fromCache ? 'HIT' : 'MISS')
    res.setHeader('X-QR-Source', 'dom-datauri')
    return res.status(200).send(result.buffer)
  } catch (err) {
    return res.status(err.status || 500).json({ error: err.publicMessage || err.message || 'Lỗi không xác định' })
  }
}