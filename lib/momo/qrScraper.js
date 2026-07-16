// lib/momo/qrScraper.js
// Logic Puppeteer dùng CHUNG cho cả qr-extract.js (trả ảnh) lẫn
// transfer-info.js (decode ra thông tin ngân hàng) — gọi hàm nội bộ trực
// tiếp (KHÔNG self-fetch qua network), đồng thời share chung 1 cache theo
// payUrl: nếu ảnh đã được 1 trong 2 route lấy trước đó (trong vòng 60s),
// route kia dùng lại luôn, không chạy lại Puppeteer.
//
// ⚠ DÙNG @sparticuz/chromium-min (không phải bản đầy đủ @sparticuz/chromium)
// — bản đầy đủ (~50MB) bị Vercel cắt/hỏng lúc bundle function, gây lỗi
// "libnss3.so: cannot open shared object file". Bản -min tải file pack
// Chromium từ 1 URL tĩnh lúc runtime thay vì bundle kèm code, tránh hẳn
// vấn đề này (đây cũng là cách chính Vercel khuyến nghị trong template
// Puppeteer chính thức của họ).
//
// SETUP BẮT BUỘC trước khi dùng:
//   1. npm uninstall @sparticuz/chromium && npm install @sparticuz/chromium-min puppeteer-core
//   2. Tải đúng bản chromium-v<version>-pack.tar khớp version vừa cài tại
//      https://github.com/Sparticuz/chromium/releases, đặt vào public/chromium-pack.tar
//   3. Set env CHROMIUM_PACK_URL = https://<domain-của-m>/chromium-pack.tar

import chromium from '@sparticuz/chromium-min'
import puppeteer from 'puppeteer-core'

const CHROMIUM_PACK_URL = process.env.CHROMIUM_PACK_URL

let browserPromise = null
export async function getBrowser() {
  if (!CHROMIUM_PACK_URL) {
    throw new Error('[qrScraper] Thiếu env CHROMIUM_PACK_URL — trỏ tới file chromium-pack.tar đã host (vd public/chromium-pack.tar deploy cùng app)')
  }
  if (!browserPromise) {
    browserPromise = puppeteer.launch({
      args: [
        ...chromium.args,
        '--disable-gpu', '--disable-dev-shm-usage', '--disable-extensions',
        '--no-first-run', '--disable-background-networking',
      ],
      defaultViewport: { width: 430, height: 932 },
      executablePath: await chromium.executablePath(CHROMIUM_PACK_URL),
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

// Trả về { buffer, fromCache } — buffer là PNG THẬT của mã QR thanh toán
// (VietQR do MoMo tự render trên trang payUrl), KHÔNG phải QR mã hoá
// payUrl (đó là qrCodeImage lưu sẵn trong order, chỉ để "mở trang MoMo").
//
// debug=true: trả { debugScreenshot, dataUriFound, dataUriPrefix } thay vì
// { buffer } — dùng để soi lỗi khi không tìm thấy QR trên trang.
export async function getPaymentQrPngBuffer(payUrl, { noCache = false, debug = false } = {}) {
  if (!noCache && !debug) {
    const cached = getCached(payUrl)
    if (cached) return { buffer: cached, fromCache: true }
  }

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
      const debugScreenshot = await page.screenshot({ type: 'png', fullPage: true }).catch(() => null)
      await page.close()
      return { debugScreenshot, dataUriFound: !!dataUri, dataUriPrefix: dataUri ? dataUri.slice(0, 60) : null }
    }

    await page.close()
    page = null

    if (!dataUri) {
      throw Object.assign(new Error('Không tìm thấy mã QR trên trang thanh toán'), { status: 404 })
    }

    const match = dataUri.match(/^data:image\/(png|jpeg|jpg|webp);base64,(.+)$/)
    if (!match) {
      throw Object.assign(new Error('Định dạng mã QR không hợp lệ'), { status: 500 })
    }

    const buffer = Buffer.from(match[2], 'base64')
    setCached(payUrl, buffer)
    return { buffer, fromCache: false }
  } catch (err) {
    if (page) { try { await page.close() } catch {} }
    if (!err.status) {
      console.error('[qrScraper] error:', err)
      err.status = 500
      err.publicMessage = 'Không lấy được mã QR, thử lại sau'
    }
    throw err
  }
}