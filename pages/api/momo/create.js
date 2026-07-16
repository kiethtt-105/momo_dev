// pages/api/momo/create.js
// GỘP 3 route cũ: create-p2p.js + scan.js + save-pending.js (bỏ hẳn —
// save-pending chỉ tạo bản nháp PENDING không gọi MoMo, trong khi cả 2
// luồng bên dưới đã tự tạo PENDING trước khi gọi MoMo rồi nên dư thừa).
//
// 2 phương thức thanh toán (param "mode"):
//   - mode=p2p  : tạo QR/payUrl để KHÁCH tự quét bằng app MoMo. Kết quả
//                 CHƯA biết ngay — chờ MoMo gọi /api/momo/ipn khi khách
//                 thanh toán xong (đó là nơi "lưu giao dịch" thật sự).
//   - mode=scan : ADMIN quét QR MoMo của khách rồi charge trực tiếp (POS).
//                 MoMo trả kết quả NGAY trong response — lưu luôn ở đây,
//                 không cần chờ IPN.
//
// Xác thực:
//   - GET  : KHÔNG cần xác thực, chỉ hỗ trợ mode=p2p (tạo link nhanh, vd
//            mở từ Shortcuts/trình duyệt).
//            ⚠ nghĩa là AI CŨNG tạo được đơn thật trên merchant của m —
//            cân nhắc rate-limit theo IP nếu route này lộ ra internet.
//   - POST : bắt buộc có key (header "x-api-key" hoặc field "key" trong
//            body) — dùng chung SHORTCUT_API_KEY với route stores.js.
//            Hỗ trợ cả mode=p2p lẫn mode=scan.
//            (scan CHỈ nhận qua POST — paymentCode tuyệt đối không nên
//            nằm trên URL vì bị log lại nhiều nơi.)

import QRCode from 'qrcode'
import { createMoMoPayment, createMoMoPOSPayment, isMomoConfigured } from '../../../lib/momo'
import { resolveStore } from '../../../lib/stores'
import { saveOrder } from '../../../lib/orders'
import { describeResultCode, formatResultCodeMessage } from '../../../lib/momoResultCodes'
import { verifySession, refreshSession } from '../admin/login'

const SHORTCUT_API_KEY = process.env.SHORTCUT_API_KEY || ''

function hasValidKey(req) {
  if (!SHORTCUT_API_KEY) return false
  const key = req.headers['x-api-key'] || req.body?.key || req.query?.key
  return key === SHORTCUT_API_KEY
}

function sanitize(s) {
  return s.replace(/[^a-zA-Z0-9_-]/g, '')
}

function buildOrderId(rawOrderId, prefix) {
  if (rawOrderId) {
    const clean = sanitize(String(rawOrderId).trim())
    return (clean.startsWith('iPOS') || clean.startsWith('POS')) ? clean : `${prefix}${clean}`
  }
  return `${prefix}${Date.now()}${Math.random().toString(36).slice(2, 6)}`
}

// Thời hạn giao dịch: 10 phút kể từ lúc tạo đơn (dùng cho luồng p2p, nơi
// khách chưa thanh toán ngay mà cần quét QR/mở link — quá hạn thì FE/BE
// có thể coi đơn là hết hiệu lực dù MoMo chưa báo IPN).
const ORDER_EXPIRE_MS = 10 * 60 * 1000

function buildExpiresAt(createdAtIso) {
  return new Date(new Date(createdAtIso).getTime() + ORDER_EXPIRE_MS).toISOString()
}

export default async function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'POST') {
    res.setHeader('Allow', ['GET', 'POST'])
    return res.status(405).json({ error: 'Method not allowed' })
  }

  // POST chấp nhận 1 trong 2 cách xác thực:
  //  - API key (SHORTCUT_API_KEY) — dùng cho Shortcuts/tích hợp ngoài
  //  - Session admin (cookie đã đăng nhập) — dùng cho trang quản lý nội bộ,
  //    KHÔNG cần lộ SHORTCUT_API_KEY ra trình duyệt
  const isAdmin = req.method === 'POST' && verifySession(req)
  if (isAdmin) refreshSession(req, res)

  if (req.method === 'POST' && !isAdmin && !hasValidKey(req)) {
    return res.status(401).json({ error: 'Sai hoặc thiếu API key' })
  }

  const params = req.method === 'GET' ? req.query : req.body
  const mode = (params.mode || 'p2p').toString().trim().toLowerCase()

  if (req.method === 'GET' && mode !== 'p2p') {
    return res.status(400).json({ error: 'GET chỉ hỗ trợ mode=p2p' })
  }

  if (mode === 'scan') return handleScan(params, res)
  if (mode === 'p2p') return handleP2P(params, res)
  return res.status(400).json({ error: 'mode không hợp lệ (p2p | scan)' })
}

// ─── P2P ──────────────────────────────────────────────────────────────
async function handleP2P(params, res) {
  const amt = parseInt(params.amount)
  if (isNaN(amt) || amt < 1000 || amt > 50_000_000) {
    return res.status(400).json({ error: 'Số tiền không hợp lệ (1.000 – 50.000.000 ₫)' })
  }

  const orderId = buildOrderId(params.orderId, 'iPOS')
  const orderInfo = String(params.orderInfo || '').trim() || `Thanh toan DH ${orderId}`
  const store = resolveStore((params.storeId || '').toString().trim())
  const { id: storeId, name: storeName, partnerName } = store
  const now = new Date().toISOString()
  const expiresAt = buildExpiresAt(now)

  try {
    // Tạo bản ghi PENDING trước — nếu gọi MoMo lỗi/timeout vẫn còn dấu vết
    // đơn hàng thay vì mất trắng. Kết quả CUỐI của p2p chỉ được ghi đè khi
    // MoMo phản hồi thật (ngay bên dưới nếu lỗi ngay lúc tạo, hoặc qua IPN
    // sau này khi khách thanh toán xong).
    await saveOrder(orderId, {
      orderId, amount: amt, orderInfo, status: 'PENDING',
      createdAt: now, expiresAt, paidAt: null, transId: '', payType: '',
      paymentOption: '', source: 'create-p2p',
      storeId, storeName, partnerName, type: 'p2p',
    })

    const result = await createMoMoPayment({ orderId, amount: amt, orderInfo, storeId, storeName, partnerName })

    if (result.resultCode !== 0) {
      const info = describeResultCode(result.resultCode)
      const finalMessage = formatResultCodeMessage(result.resultCode, result.message)
      await saveOrder(orderId, {
        orderId, amount: amt, orderInfo, status: 'FAILED',
        createdAt: now, expiresAt, paidAt: null, transId: '', payType: '',
        paymentOption: '', source: 'create-p2p',
        storeId, storeName, partnerName, error: result.message || '',
        message: finalMessage, resultCode: result.resultCode,
        requestId: result.requestId || '', responseTime: result.responseTime || null,
        orderType: result.orderType || '', extraData: result.extraData || '',
        type: 'p2p',
      })
      return res.status(400).json({ error: finalMessage, resultCode: result.resultCode, category: info.category })
    }

    let qrCodeImage = ''
    const qrSource = result.qrCodeUrl || result.payUrl
    if (qrSource) {
      try {
        qrCodeImage = await QRCode.toDataURL(qrSource, { errorCorrectionLevel: 'H', margin: 1, width: 400 })
      } catch (qrErr) {
        console.error('[create][p2p] QR Generate Error:', qrErr.message)
      }
    }

    await saveOrder(orderId, {
      orderId, amount: amt, orderInfo, status: 'PENDING',
      createdAt: now, expiresAt, paidAt: null, transId: '', payType: '',
      paymentOption: '', source: 'create-p2p',
      storeId, storeName, partnerName,
      payUrl: result.payUrl || '', deeplink: result.deeplink || '',
      qrCodeUrl: result.qrCodeUrl || '', qrCodeImage,
      requestId: result.requestId || '',
      resultCode: result.resultCode ?? 0, message: result.message || '',
      responseTime: result.responseTime || null,
      orderType: result.orderType || '', extraData: result.extraData || '',
      applink: result.applink || '', deeplinkMiniApp: result.deeplinkMiniApp || '',
      type: 'p2p',
    })

    return res.status(200).json({
      payUrl: result.payUrl, deeplink: result.deeplink, qrCodeUrl: result.qrCodeUrl,
      qrCodeImage, orderId: result.orderId, requestId: result.requestId, storeId, storeName,
    })
  } catch (err) {
    console.error('[create][p2p] error:', err)
    try {
      await saveOrder(orderId, {
        orderId, amount: amt, orderInfo, status: 'FAILED',
        createdAt: now, expiresAt, paidAt: null, transId: '', payType: '',
        paymentOption: '', source: 'create-p2p',
        storeId, storeName, partnerName, error: 'server_error',
        message: `⚠ Lỗi hệ thống (server) khi gọi MoMo — ADMIN cần kiểm tra log server: ${err.message || 'không rõ nguyên nhân'}`,
        type: 'p2p',
      })
    } catch (cleanupErr) {
      console.error('[create][p2p] cleanup error:', cleanupErr)
    }
    return res.status(500).json({ error: 'Lỗi server, thử lại sau' })
  }
}

// ─── SCAN (POS) ───────────────────────────────────────────────────────
async function handleScan(params, res) {
  if (!isMomoConfigured()) {
    console.error('[create][scan] Thiếu env: MOMO_PARTNER_CODE / MOMO_ACCESS_KEY / MOMO_SECRET_KEY')
    return res.status(500).json({ error: 'Server thiếu cấu hình MoMo (kiểm tra biến môi trường)' })
  }

  const { orderId: rawOrderId, amount, orderInfo: rawOrderInfo, paymentCode: rawPaymentCode, storeId: rawStoreId } = params
  if (!rawOrderId || !amount || !rawPaymentCode) {
    return res.status(400).json({ error: 'Thiếu thông tin bắt buộc: orderId, amount, paymentCode' })
  }

  const orderId = buildOrderId(rawOrderId, 'iPOS')
  const orderInfo = String(rawOrderInfo || '').trim() || `Thanh Toán ${orderId}`

  const paymentCode = String(rawPaymentCode).trim()
  if (!/^(MM|mm)?\d{18}$/.test(paymentCode)) {
    return res.status(400).json({ error: 'Mã thanh toán không hợp lệ (18 chữ số, có thể có MM/mm)' })
  }

  const amt = parseInt(amount)
  if (isNaN(amt) || amt < 1000 || amt > 10_000_000) {
    return res.status(400).json({ error: 'Số tiền không hợp lệ (1.000 – 10.000.000 ₫)' })
  }

  const store = resolveStore((rawStoreId || '').toString().trim())
  const now = new Date().toISOString()

  try {
    await saveOrder(orderId, {
      orderId, amount: amt, orderInfo, status: 'PENDING',
      createdAt: now, paidAt: null, transId: '', payType: '', paymentOption: '',
      source: 'pos', storeId: store.id, storeName: store.name, partnerName: store.partnerName || '',
      type: 'scan', submittedCode: paymentCode,
    })

    const data = await createMoMoPOSPayment({ orderId, amount: amt, orderInfo, paymentCode, store })

    // MoMo trả kết quả NGAY — đây chính là bước "lưu giao dịch" cho luồng
    // scan (khác p2p, không cần chờ IPN).
    await saveOrder(orderId, {
      orderId, amount: amt, orderInfo,
      status: data.resultCode === 0 ? 'PAID' : 'FAILED',
      createdAt: now, paidAt: data.resultCode === 0 ? new Date().toISOString() : null,
      transId: data.transId?.toString() || '', payType: data.payType || 'pos',
      paymentOption: data.paymentOption || '', resultCode: data.resultCode,
      message: data.resultCode === 0 ? (data.message || 'Thanh toán thành công') : formatResultCodeMessage(data.resultCode, data.message),
      responseTime: data.responseTime, orderType: data.orderType || '', extraData: data.extraData || '',
      source: 'pos', storeId: store.id, storeName: store.name, partnerName: store.partnerName || '',
      type: 'scan', submittedCode: paymentCode,
    })

    console.log(`[create][scan] MoMo response: ${orderId} resultCode=${data.resultCode} message=${data.message}`)
    return res.status(200).json(data)
  } catch (err) {
    console.error('[create][scan] error:', err)
    const isTimeout = err.name === 'TimeoutError' || err.name === 'AbortError'
    const isBadJson = err.code === 'MOMO_BAD_JSON'
    try {
      await saveOrder(orderId, {
        orderId, amount: amt, orderInfo, status: 'FAILED',
        createdAt: now, paidAt: null, transId: '', payType: 'pos', paymentOption: '',
        resultCode: -1,
        message: isTimeout
          ? '⚠ Lỗi hệ thống MoMo — Timeout khi gọi MoMo (15s), không rõ giao dịch có được xử lý phía MoMo hay không. Kiểm tra lại bằng mã đơn hàng trước khi tạo lại.'
          : isBadJson
          ? '⚠ Lỗi hệ thống MoMo — MoMo trả về dữ liệu không hợp lệ (không phải JSON). Thử lại sau, nếu lặp lại nhiều lần thì liên hệ MoMo.'
          : `⚠ Lỗi hệ thống (server) — ADMIN cần kiểm tra log server: ${err.message || 'Lỗi server'}`,
        source: 'pos', storeId: store.id, storeName: store.name, partnerName: store.partnerName || '',
        type: 'scan', submittedCode: paymentCode,
      })
    } catch (redisErr) {
      console.error('[create][scan] Redis update FAILED error:', redisErr)
    }
    return res.status(isTimeout ? 504 : 500).json({
      error: isTimeout ? 'Timeout khi gọi MoMo, vui lòng thử lại' : 'Lỗi server khi xử lý thanh toán',
    })
  }
}