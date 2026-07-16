// pages/api/momo/qr-extract.js
//
// GỘP 2 route cũ: qr-extract.js (trích ảnh QR thật bằng Puppeteer) +
// vietqr-pay.js (decode ảnh đó ra thông tin ngân hàng) — trước đây
// vietqr-pay.js phải tự fetch() LẠI route này qua network để lấy PNG rồi
// mới decode, giờ gộp chung 1 request là xong, khỏi tốn 1 vòng self-fetch
// (vốn dễ lỗi nếu domain nội bộ bị chặn/redirect).
//
// Dùng cho: hiển thị mã QR THẬT (không phải QR mã hóa payUrl) ngay trên
// trang tao-giao-dich — quét 1 lần là thanh toán được luôn, không phải
// quét 2 lần (quét QR link -> mở trang -> quét QR thật) như trước.
//
//   npm install puppeteer-core @sparticuz/chromium jsqr pngjs
//
// Params:
//   ?orderId=xxx            (bắt buộc, trừ khi warm=1)
//   ?warm=1                 warm-up browser instance dùng chung, không cần orderId
//   ?decode=1               ngoài trả ảnh PNG, còn decode ra JSON thông tin
//                           ngân hàng (bank, accountNumber, amount, content...)
//                           thay vì trả ảnh — dùng khi cần hiển thị text fallback
//                           (vd: người dùng không quét được, đọc số TK gõ tay)
//   ?debug=1 / ?nocache=1   giữ nguyên như route cũ

import chromium from '@sparticuz/chromium'
import puppeteer from 'puppeteer-core'
import jsQR from 'jsqr'
import { PNG } from 'pngjs'
import { getOrder } from '../../../lib/orders'
import { parseVietQR } from '../../../lib/momo/vietqr-parser'
import { lookupBankByBin } from '../../../lib/momo/vietqr-bank-directory'

export const config = {
  api: { externalResolver: true },
  maxDuration: 60, // chỉ có tác dụng trên Vercel Pro trở lên — Hobby cứng 10s
}

let browserPromise = null
async function getBrowser() {
  if (!browserPromise) {
    browserPromise = puppeteer.launch({
      args: [
        ...chromium.args,
        '--disable-gpu', '--disable-dev-shm-usage', '--disable-extensions',
        '--no-first-run', '--disable-background-networking',
      ],
      defaultViewport: { width: 430, height: 932 },
      executablePath: await chromium.executablePath(),
      headless: chromium.headless,
    })
  }
  return browserPromise
}

const qrCache = new Map()
const CACHE_TTL_MS = 60_000

function getCached(key) {
  const hit = qrCache.get(key)
  if (!hit) return null
  if (Date.now() - hit.ts > CACHE_TTL_MS) { qrCache.delete(key); return null }
  return hit.buffer
}

function setCached(key, buffer) {
  qrCache.set(key, { buffer, ts: Date.now() })
  if (qrCache.size > 50) qrCache.delete(qrCache.keys().next().value)
}

async function extractQrDataUri(page) {
  return page.evaluate(() => {
    const isDataImg = (el) => !!el && typeof el.src === 'string' && el.src.startsWith('data:image')

    const direct = document.querySelector('img.image-qr-code, .qrcode_image img')
    if (isDataImg(direct)) return direct.src

    const containers = [
      document.querySelector('#form-qr-code'),
      document.querySelector('#qr-web-ui'),
    ].filter(Boolean)

    for (const c of containers) {
      const img = c.querySelector('img[src^="data:image"]')
      if (isDataImg(img)) return img.src
    }

    for (const c of containers) {
      const canvas = c.querySelector('canvas')
      if (canvas) {
        try {
          const uri = canvas.toDataURL('image/png')
          if (uri && uri.startsWith('data:image') && uri.length > 100) return uri
        } catch { /* canvas có thể "tainted" nếu vẽ ảnh cross-origin */ }
      }
    }
    return null
  })
}

// Decode buffer PNG -> chuỗi raw đọc được trong QR (EMV string), dùng
// chung cho nhánh ?decode=1 (logic bê nguyên từ vietqr-pay.js cũ)
function decodeQrStringFromPng(buffer) {
  let png
  try {
    png = PNG.sync.read(buffer)
  } catch (err) {
    throw Object.assign(new Error('Ảnh QR trả về không phải PNG hợp lệ'), { status: 502, cause: err })
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

  const orderId = (req.query.orderid || req.query.orderId || '').toString().trim()
  if (!orderId) return res.status(400).json({ error: 'Thiếu orderId' })

  const order = await getOrder(orderId)
  if (!order) return res.status(404).json({ error: 'Không tìm thấy đơn hàng' })

  const payUrl = (order.payUrl || '').toString().trim()
  if (!payUrl || !payUrl.startsWith('https://payment.momo.vn')) {
    return res.status(404).json({ error: 'Đơn hàng chưa có payUrl hợp lệ' })
  }

  const debug = req.query.debug === '1'
  const noCache = req.query.nocache === '1'
  const wantDecode = req.query.decode === '1'

  // Cache HIT: trả ngay, kể cả cho nhánh decode (vẫn phải decode lại vì
  // ta không cache kết quả decode, chỉ cache ảnh PNG gốc)
  let buffer = !debug && !noCache ? getCached(payUrl) : null
  let fromCache = !!buffer

  if (!buffer) {
    let page
    try {
      const browser = await getBrowser()
      page = await browser.newPage()

      await page.setRequestInterception(true)
      const BLOCKED_TYPES = ['image', 'font', 'media', 'stylesheet']
      const BLOCKED_HOSTS = ['googletagmanager.com', 'google-analytics.com', 'facebook.net', 'connect.facebook.net', 'doubleclick.net']
      page.on('request', (r) => {
        const type = r.resourceType()
        const url = r.url()
        if (BLOCKED_TYPES.includes(type)) return r.abort()
        if (BLOCKED_HOSTS.some((h) => url.includes(h))) return r.abort()
        r.continue()
      })

      await page.goto(payUrl, { waitUntil: 'domcontentloaded', timeout: 10000 })

      try {
        await page.waitForFunction(
          () => {
            const el = document.querySelector('img.image-qr-code, .qrcode_image img')
            if (el && el.src && el.src.startsWith('data:image')) return true
            return !!document.querySelector('#form-qr-code canvas, #qr-web-ui canvas')
          },
          { timeout: 6000 }
        )
      } catch { /* không thấy tín hiệu rõ ràng trong 6s — vẫn thử đọc DOM bên dưới */ }

      const dataUri = await extractQrDataUri(page)

      if (debug) {
        const fullBuffer = await page.screenshot({ type: 'png', fullPage: true }).catch(() => null)
        await page.close()
        if (fullBuffer) {
          res.setHeader('Content-Type', 'image/png')
          res.setHeader('Cache-Control', 'no-store')
          res.setHeader('X-QR-DataUri-Found', dataUri ? '1' : '0')
          return res.status(200).send(fullBuffer)
        }
        return res.status(200).json({ dataUriFound: !!dataUri, dataUriPrefix: dataUri ? dataUri.slice(0, 60) : null })
      }

      await page.close()

      if (!dataUri) return res.status(404).json({ error: 'Không tìm thấy mã QR trên trang thanh toán' })

      const match = dataUri.match(/^data:image\/(png|jpeg|jpg|webp);base64,(.+)$/)
      if (!match) return res.status(500).json({ error: 'Định dạng mã QR không hợp lệ' })

      buffer = Buffer.from(match[2], 'base64')
      setCached(payUrl, buffer)
    } catch (err) {
      console.error('[qr-extract] error:', err)
      if (page) { try { await page.close() } catch {} }
      return res.status(500).json({ error: 'Không lấy được mã QR, thử lại sau' })
    }
  }

  // Nhánh decode: đọc luôn nội dung QR ra thông tin ngân hàng thay vì trả ảnh
  if (wantDecode) {
    try {
      const qrString = decodeQrStringFromPng(buffer)
      const parsed = parseVietQR(qrString)
      const bank = await lookupBankByBin(parsed.bankBin)

      res.setHeader('Cache-Control', 'no-store')
      return res.status(200).json({
        orderId,
        bank,
        accountNumber: parsed.accountNumber,
        amount: parsed.amount,
        currency: parsed.currency === '704' ? 'VND' : parsed.currency,
        content: parsed.content,
        serviceCode: parsed.serviceCode, // QRIBFTTA (TK) | QRIBFTTC (thẻ)
        merchantName: parsed.merchantName,
        raw: parsed.raw,
      })
    } catch (err) {
      console.error('[qr-extract][decode] error:', err)
      const status = err.status || 500
      return res.status(status).json({ error: err.message || 'Không đọc được thông tin ngân hàng từ mã QR' })
    }
  }

  // Nhánh mặc định: trả thẳng ảnh PNG để dùng làm src cho <img>
  res.setHeader('Content-Type', 'image/png')
  res.setHeader('Cache-Control', 'no-store')
  res.setHeader('X-QR-Cache', fromCache ? 'HIT' : 'MISS')
  res.setHeader('X-QR-Source', 'dom-datauri')
  return res.status(200).send(buffer)
}