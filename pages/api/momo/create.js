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
import { createMoMoPayment, createMoMoPOSPayment, isMomoConfigured, queryMoMoTransaction } from '../../../lib/momo'
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

// Giống hệt logic trong query.js: resultCode MoMo dùng để báo "giao dịch
// chưa có kết quả dứt khoát" — KHÔNG được coi là FAILED thật, cũng không
// đủ căn cứ để coi là kết quả cuối cùng khi requery sau lỗi mạng.
const PENDING_RESULT_CODES = new Set([1000, 7002])

export default async function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'POST') {
    res.setHeader('Allow', ['GET', 'POST'])
    return res.status(405).json({ error: 'Method not allowed' })
  }

  // GET dùng cho Shortcuts/mở link nhanh — mỗi lần gọi phải tạo đơn MỚI,
  // tuyệt đối không để CDN cache trả lại kết quả của lần gọi trước.
  if (req.method === 'GET') res.setHeader('Cache-Control', 'no-store')

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
  console.log(`[create] ${req.method} mode=${mode} amount=${params.amount || '(thiếu)'} isAdmin=${isAdmin} @ ${new Date().toISOString()}`)

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
      createdAt: now, expiresAt, orderExpireMs: ORDER_EXPIRE_MS, paidAt: null, transId: '', payType: '',
      paymentOption: '', source: 'create-p2p',
      storeId, storeName, partnerName, type: 'p2p',
    })

    const result = await createMoMoPayment({ orderId, amount: amt, orderInfo, storeId, storeName, partnerName })

    if (result.resultCode !== 0) {
      const info = describeResultCode(result.resultCode)
      const finalMessage = formatResultCodeMessage(result.resultCode, result.message)
      await saveOrder(orderId, {
        orderId, amount: amt, orderInfo, status: 'FAILED',
        createdAt: now, expiresAt, orderExpireMs: ORDER_EXPIRE_MS, paidAt: null, transId: '', payType: '',
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
        // errorCorrectionLevel 'H' (30% phục hồi) + width 400 tạo file base64
        // lớn hơn nhiều so với mức cần thiết cho 1 QR link đơn giản (payUrl
        // ngắn, không phải QR ngân hàng chứa nhiều dữ liệu). 'M' (~15%) vẫn
        // thừa dư địa quét trong điều kiện bình thường, width 260 vẫn đủ nét
        // trên màn hình di động — giảm đáng kể dung lượng lưu trong Redis vì
        // field này được lưu lại nguyên văn cho MỌI đơn p2p.
        qrCodeImage = await QRCode.toDataURL(qrSource, { errorCorrectionLevel: 'M', margin: 1, width: 260 })
      } catch (qrErr) {
        console.error('[create][p2p] QR Generate Error:', qrErr.message)
      }
    }

    await saveOrder(orderId, {
      orderId, amount: amt, orderInfo, status: 'PENDING',
      createdAt: now, expiresAt, orderExpireMs: ORDER_EXPIRE_MS, paidAt: null, transId: '', payType: '',
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

    console.log(`[create][p2p] OK orderId=${orderId} amount=${amt} store=${storeId}`)
    return res.status(200).json({
      payUrl: result.payUrl, deeplink: result.deeplink, qrCodeUrl: result.qrCodeUrl,
      qrCodeImage, orderId: result.orderId, requestId: result.requestId, storeId, storeName,
      expiresAt,
    })
  } catch (err) {
    console.error(`[create][p2p] Lỗi khi gọi MoMo (orderId=${orderId}):`, err)

    // MoMo có thể đã xử lý xong giao dịch phía họ dù response bị rớt giữa
    // đường (lỗi network chỉ đứt lúc NHẬN kết quả, không có nghĩa giao dịch
    // thất bại) — thử hỏi lại NGAY bằng Query Transaction Status trước khi
    // chấp nhận để đơn ở trạng thái không rõ ràng. Chỉ ghi Redis nếu MoMo
    // trả resultCode DỨT KHOÁT thật (không phải "đang xử lý") — không tự
    // chế bất kỳ resultCode nào ở đây.
    try {
      const queried = await queryMoMoTransaction({ orderId })
      const qCode = parseInt(queried.resultCode)
      if (!Number.isNaN(qCode) && !PENDING_RESULT_CODES.has(qCode)) {
        const isPaid = qCode === 0
        const finalMessage = isPaid
          ? (queried.message || 'Thanh toán thành công')
          : formatResultCodeMessage(qCode, queried.message)
        await saveOrder(orderId, {
          orderId, amount: amt, orderInfo, status: isPaid ? 'PAID' : 'FAILED',
          createdAt: now, expiresAt, orderExpireMs: ORDER_EXPIRE_MS,
          paidAt: isPaid ? new Date().toISOString() : null,
          transId: queried.transId?.toString() || '', payType: queried.payType || '',
          paymentOption: queried.paymentOption || '', source: 'create-p2p-requery',
          storeId, storeName, partnerName,
          resultCode: qCode, message: finalMessage,
          responseTime: queried.responseTime || null,
          type: 'p2p',
        })
        console.log(`[create][p2p] Requery sau lỗi mạng THÀNH CÔNG orderId=${orderId} resultCode=${qCode}`)
        return res.status(isPaid ? 200 : 400).json({
          orderId, resultCode: qCode,
          ...(isPaid ? { message: finalMessage } : { error: finalMessage }),
        })
      }
      // qCode NaN hoặc vẫn "đang xử lý" (1000/7002) -> chưa đủ căn cứ,
      // rơi xuống nhánh giữ nguyên PENDING bên dưới.
    } catch (queryErr) {
      console.error(`[create][p2p] Requery sau lỗi mạng cũng thất bại (orderId=${orderId}):`, queryErr)
    }

    // Không lấy được resultCode dứt khoát (kể cả sau khi thử hỏi lại MoMo)
    // -> KHÔNG xoá, KHÔNG tự chế FAILED. Bản ghi PENDING đã lưu ở trên vẫn
    // còn nguyên trong Redis (TTL 30 ngày) — xem được trong dashboard hoặc
    // đối soát tay bằng /api/momo/query?orderId=... bất cứ lúc nào.
    return res.status(500).json({
      error: 'Không nhận được kết quả dứt khoát từ MoMo. Đơn hàng vẫn được giữ ở trạng thái PENDING — vui lòng kiểm tra lại bằng mã đơn hàng trước khi tạo giao dịch mới',
      orderId,
    })
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
  // MoMo spec cho POS (Thanh Toán Bằng QR Cá Nhân): giới hạn 1.000 – 5.000.000 ₫
  if (isNaN(amt) || amt < 1000 || amt > 5_000_000) {
    return res.status(400).json({ error: 'Số tiền không hợp lệ (1.000 – 5.000.000 ₫)' })
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
    const isTimeout = err.name === 'TimeoutError' || err.name === 'AbortError'
    const isBadJson = err.code === 'MOMO_BAD_JSON'
    console.error(`[create][scan] Lỗi khi gọi MoMo (orderId=${orderId}):`, err)

    // Đặc biệt quan trọng với POS: timeout/lỗi JSON không có nghĩa MoMo
    // chưa charge — có thể họ đã trừ tiền khách thành công nhưng response
    // bị rớt. Thử hỏi lại NGAY bằng Query Transaction Status trước khi kết
    // luận. `resultCode: -1` tự chế ở bản cũ đã bị bỏ hẳn — chỉ ghi Redis
    // khi có resultCode DỨT KHOÁT thật từ MoMo.
    try {
      const queried = await queryMoMoTransaction({ orderId })
      const qCode = parseInt(queried.resultCode)
      if (!Number.isNaN(qCode) && !PENDING_RESULT_CODES.has(qCode)) {
        const isPaid = qCode === 0
        const finalMessage = isPaid
          ? (queried.message || 'Thanh toán thành công')
          : formatResultCodeMessage(qCode, queried.message)
        await saveOrder(orderId, {
          orderId, amount: amt, orderInfo,
          status: isPaid ? 'PAID' : 'FAILED',
          createdAt: now, paidAt: isPaid ? new Date().toISOString() : null,
          transId: queried.transId?.toString() || '', payType: queried.payType || 'pos',
          paymentOption: queried.paymentOption || '', resultCode: qCode,
          message: finalMessage, responseTime: queried.responseTime || null,
          source: 'pos-requery', storeId: store.id, storeName: store.name, partnerName: store.partnerName || '',
          type: 'scan', submittedCode: paymentCode,
        })
        console.log(`[create][scan] Requery sau lỗi mạng THÀNH CÔNG orderId=${orderId} resultCode=${qCode}`)
        return res.status(isPaid ? 200 : 400).json({
          orderId, resultCode: qCode,
          ...(isPaid ? { message: finalMessage } : { error: finalMessage }),
        })
      }
    } catch (queryErr) {
      console.error(`[create][scan] Requery sau lỗi mạng cũng thất bại (orderId=${orderId}):`, queryErr)
    }

    // Không lấy được resultCode dứt khoát -> KHÔNG xoá, KHÔNG tự chế FAILED.
    // Bản ghi PENDING đã lưu ở trên vẫn còn nguyên — bắt buộc kiểm tra lại
    // bằng /api/momo/query trước khi thu tiền lại của khách.
    return res.status(isTimeout ? 504 : 500).json({
      error: isTimeout
        ? 'Timeout khi gọi MoMo — CHƯA RÕ giao dịch có thành công phía MoMo hay không. Vui lòng kiểm tra lại bằng mã đơn hàng (query) trước khi thu tiền lại của khách.'
        : isBadJson
        ? 'MoMo trả về dữ liệu không hợp lệ, vui lòng kiểm tra lại đơn hàng trước khi thử lại'
        : 'Lỗi server khi xử lý thanh toán, vui lòng kiểm tra lại đơn hàng trước khi thử lại',
      orderId,
    })
  }
}