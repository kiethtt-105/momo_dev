// pages/api/momo/qr-extract.js
// warm.js cũ đã BỊ XOÁ — trùng lặp hoàn toàn với ?warm=1 vốn đã có sẵn ở
// đây, chỉ cần gọi GET /api/momo/qr-extract?warm=1 để warm-up cùng 1
// browser instance dùng chung, không cần route riêng nữa.
//
//   npm install puppeteer-core @sparticuz/chromium

import chromium from '@sparticuz/chromium'
import puppeteer from 'puppeteer-core'
import { getOrder } from '../../../lib/orders'

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

  if (!debug && !noCache) {
    const cached = getCached(payUrl)
    if (cached) {
      res.setHeader('Content-Type', 'image/png')
      res.setHeader('Cache-Control', 'no-store')
      res.setHeader('X-QR-Cache', 'HIT')
      return res.status(200).send(cached)
    }
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

    const buffer = Buffer.from(match[2], 'base64')
    setCached(payUrl, buffer)

    res.setHeader('Content-Type', `image/${match[1] === 'jpg' ? 'jpeg' : match[1]}`)
    res.setHeader('Cache-Control', 'no-store')
    res.setHeader('X-QR-Cache', 'MISS')
    res.setHeader('X-QR-Source', 'dom-datauri')
    return res.status(200).send(buffer)
  } catch (err) {
    console.error('[qr-extract] error:', err)
    if (page) { try { await page.close() } catch {} }
    return res.status(500).json({ error: 'Không lấy được mã QR, thử lại sau' })
  }
}
