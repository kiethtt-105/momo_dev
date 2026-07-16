// pages/thanh-toan.js
//
// Trang KHÁCH HÀNG — không yêu cầu đăng nhập admin, vì link này được gửi
// trực tiếp cho khách (qua Zalo, tin nhắn...) để họ tự thanh toán.
// Truy cập: /thanh-toan?orderId=iPOSxxxxx
//
// Luồng:
//   1. Gọi GET /api/momo/orders?orderId=xxx (route này KHÔNG cần session
//      khi có orderId — trả bản "public" đã lược field nhạy cảm).
//   2. Hiện ảnh QR thật lấy từ GET /api/momo/qr-extract?orderId=xxx (ảnh
//      PNG do MoMo render sẵn trên trang thanh toán — quét bằng app ngân
//      hàng bất kỳ hỗ trợ VietQR, không chỉ riêng app MoMo).
//   3. Nút "Không quét được?" gọi GET /api/momo/transfer-info?orderId=xxx
//      để hiện số tài khoản/ngân hàng/nội dung cho khách tự chuyển khoản.
//   4. Tự động poll trạng thái đơn mỗi 3s — khi PAID/FAILED thì cập nhật
//      giao diện ngay. Ngoài ra có nút "Kiểm tra kết quả" để khách chủ
//      động bấm tra ngay lập tức, không cần chờ vòng poll tiếp theo.
//
// Giao diện đã đồng bộ với pages/index.js: nền #FAF7F5, thẻ trắng bo góc
// lớn với cùng 1 kiểu đổ bóng mềm, bảng màu stone/momo, badge trạng thái
// dạng chấm tròn, và cùng 1 header logo "M".

import { useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/router'
import Head from 'next/head'

const CARD_SHADOW = 'shadow-[0_1px_2px_rgba(33,26,29,0.04),0_6px_16px_-10px_rgba(33,26,29,0.15)]'

function formatVND(n) {
  const num = Number(n)
  if (Number.isNaN(num)) return n
  return num.toLocaleString('vi-VN') + ' đ'
}

function formatTime(iso) {
  if (!iso) return '—'
  const d = new Date(iso)
  return d.toLocaleString('vi-VN', { hour: '2-digit', minute: '2-digit', day: '2-digit', month: '2-digit', year: 'numeric' })
}

const ORDER_EXPIRE_MS = 10 * 60 * 1000 // 10 phút kể từ lúc tạo đơn

function formatCountdown(ms) {
  const totalSec = Math.max(0, Math.ceil(ms / 1000))
  const m = Math.floor(totalSec / 60)
  const s = totalSec % 60
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
}

// Spinner xoay tròn dùng chung cho các trạng thái đang tải
function Spinner({ className = '' }) {
  return (
    <span
      className={`inline-block w-5 h-5 rounded-full border-2 border-stone-200 border-t-momo animate-spin ${className}`}
    />
  )
}

// Cùng bảng màu trạng thái (chấm tròn) với pages/index.js, để 1 đơn hàng
// trông giống nhau dù xem từ dashboard admin hay từ trang khách.
const STATUS_META = {
  PAID: { label: 'Đã thanh toán', dot: 'bg-emerald-500', text: 'text-emerald-700', chip: 'bg-emerald-50' },
  PENDING: { label: 'Chờ thanh toán', dot: 'bg-amber-500', text: 'text-amber-700', chip: 'bg-amber-50' },
  FAILED: { label: 'Thất bại', dot: 'bg-rose-500', text: 'text-rose-700', chip: 'bg-rose-50' },
  EXPIRED: { label: 'Hết hạn', dot: 'bg-stone-400', text: 'text-stone-500', chip: 'bg-stone-100' },
}

function StatusBadge({ status }) {
  const meta = STATUS_META[status] || STATUS_META.EXPIRED
  return (
    <span className={`inline-flex items-center gap-1.5 text-xs font-semibold ${meta.text} ${meta.chip} px-2 py-0.5 rounded-full`}>
      <span className={`w-1.5 h-1.5 rounded-full ${meta.dot}`} />
      {meta.label}
    </span>
  )
}

// Header logo dùng chung với trang chủ admin — giúp khách nhận ra ngay đây
// là trang thanh toán chính chủ, không phải link giả mạo.
function BrandHeader() {
  return (
    <div className="flex items-center gap-3 mb-6">
      <div className="w-11 h-11 shrink-0 rounded-2xl bg-momo flex items-center justify-center text-white font-extrabold text-lg shadow-[0_6px_16px_-6px_rgba(165,0,100,0.55)]">
        M
      </div>
      <div>
        <h1 className="text-lg font-extrabold text-stone-900 leading-tight tracking-tight">Momo Dev</h1>
        <p className="text-stone-400 text-xs">Cổng thanh toán</p>
      </div>
    </div>
  )
}

function CopyField({ label, value }) {
  const [copied, setCopied] = useState(false)

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(String(value))
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      /* clipboard có thể bị chặn trên 1 số trình duyệt — bỏ qua im lặng */
    }
  }

  return (
    <button
      onClick={handleCopy}
      className={`w-full flex items-center justify-between gap-3 rounded-2xl bg-white px-4 py-3 text-left hover:bg-stone-50 transition ${CARD_SHADOW}`}
    >
      <span className="min-w-0">
        <span className="block text-[11px] font-medium uppercase tracking-wide text-stone-400 mb-0.5">{label}</span>
        <span className="block font-mono font-semibold text-stone-900 truncate">{value}</span>
      </span>
      <span className="shrink-0 text-xs font-semibold text-momo">
        {copied ? 'Đã chép ✓' : 'Chép'}
      </span>
    </button>
  )
}

// Thanh thông tin đơn hàng hiện phía trên card QR — dùng chung cho cả
// trạng thái PENDING lẫn khi đã có kết quả cuối.
function OrderMeta({ order }) {
  return (
    <div className={`bg-white rounded-2xl p-4 mb-4 flex flex-col gap-2 text-sm ${CARD_SHADOW}`}>
      <div className="flex items-center justify-between">
        <span className="text-stone-400">Mã đơn</span>
        <span className="font-mono text-stone-900">{order.orderId}</span>
      </div>
      {order.storeName && (
        <div className="flex items-center justify-between">
          <span className="text-stone-400">Cửa hàng</span>
          <span className="text-stone-900 font-medium">{order.storeName}</span>
        </div>
      )}
      <div className="flex items-center justify-between">
        <span className="text-stone-400">Thời gian tạo</span>
        <span className="text-stone-900">{formatTime(order.createdAt)}</span>
      </div>
      <div className="flex items-center justify-between">
        <span className="text-stone-400">Trạng thái</span>
        <StatusBadge status={order.status} />
      </div>
    </div>
  )
}

// Trạng thái đầy đủ trang (không đơn hàng / lỗi / đang tải) — dùng cùng
// nền, cùng header thương hiệu như phần còn lại của trang.
function CenterState({ children }) {
  return (
    <main className="min-h-screen bg-[#FAF7F5] px-4 flex items-center justify-center">
      <div className="w-full max-w-sm py-10">
        <BrandHeader />
        {children}
      </div>
    </main>
  )
}

export default function ThanhToan() {
  const router = useRouter()
  const { orderId } = router.query

  const [order, setOrder] = useState(null)
  const [notFound, setNotFound] = useState(false)
  const [checking, setChecking] = useState(false)

  const [transferInfo, setTransferInfo] = useState(null)
  const [transferError, setTransferError] = useState('')
  const [transferLoading, setTransferLoading] = useState(false)

  const [qrFailed, setQrFailed] = useState(false)
  const [qrLoaded, setQrLoaded] = useState(false)
  const [remainingMs, setRemainingMs] = useState(null)
  const [expired, setExpired] = useState(false)
  const pollRef = useRef(null)

  async function loadOrder({ manual = false } = {}) {
    if (!orderId) return
    if (manual) setChecking(true)
    try {
      const res = await fetch(`/api/momo/orders?orderId=${encodeURIComponent(orderId)}`)
      const data = await res.json()
      const found = (data.orders || []).find((o) => o.orderId === orderId)
      if (!found) {
        setNotFound(true)
        return
      }
      setOrder(found)
    } catch {
      setNotFound(true)
    } finally {
      if (manual) setChecking(false)
    }
  }

  useEffect(() => {
    if (!orderId) return
    loadOrder()
    loadTransferInfo()
  }, [orderId])

  // Đếm ngược 10 phút kể từ lúc tạo đơn
  useEffect(() => {
    if (!order || !order.createdAt || order.status !== 'PENDING') return

    const deadline = new Date(order.createdAt).getTime() + ORDER_EXPIRE_MS

    function tick() {
      const left = deadline - Date.now()
      setRemainingMs(left)
      if (left <= 0) {
        setExpired(true)
        if (pollRef.current) clearInterval(pollRef.current)
      }
    }

    tick()
    const timer = setInterval(tick, 1000)
    return () => clearInterval(timer)
  }, [order?.createdAt, order?.status])

  // Poll trạng thái mỗi 3s cho tới khi có kết quả cuối (PAID/FAILED)
  useEffect(() => {
    if (!orderId || !order) return
    if (order.status !== 'PENDING') return
    if (expired) return

    pollRef.current = setInterval(loadOrder, 3000)
    return () => clearInterval(pollRef.current)
  }, [orderId, order?.status, expired])

  async function loadTransferInfo() {
    setTransferLoading(true)
    setTransferError('')
    try {
      const res = await fetch(`/api/momo/transfer-info?orderId=${encodeURIComponent(orderId)}`)
      const data = await res.json()
      if (!res.ok) {
        setTransferError(data.error || 'Không lấy được thông tin chuyển khoản')
        return
      }
      setTransferInfo(data)
    } catch {
      setTransferError('Lỗi kết nối, thử lại sau')
    } finally {
      setTransferLoading(false)
    }
  }

  if (!orderId) {
    return (
      <CenterState>
        <div className={`bg-white rounded-2xl p-6 text-center text-stone-400 text-sm ${CARD_SHADOW}`}>
          Thiếu mã đơn hàng trong đường dẫn.
        </div>
      </CenterState>
    )
  }

  if (notFound) {
    return (
      <CenterState>
        <div className={`bg-white rounded-2xl p-8 text-center ${CARD_SHADOW}`}>
          <div className="w-14 h-14 rounded-full bg-stone-100 mx-auto mb-4 flex items-center justify-center text-2xl">?</div>
          <p className="text-stone-900 font-semibold mb-1">Không tìm thấy đơn hàng</p>
          <p className="text-stone-500 text-sm">Kiểm tra lại đường dẫn hoặc liên hệ cửa hàng.</p>
        </div>
      </CenterState>
    )
  }

  if (!order) {
    return (
      <CenterState>
        <div className="flex flex-col items-center justify-center gap-3 text-stone-400 text-sm py-6">
          <Spinner className="w-8 h-8 border-[3px]" />
          Đang tải đơn hàng...
        </div>
      </CenterState>
    )
  }

  // Đơn đã có kết quả cuối — không cần hiện QR nữa
  if (order.status === 'PAID') {
    return (
      <>
        <Head>
          <title>Đã thanh toán · Momo Dev</title>
        </Head>
        <main className="min-h-screen bg-[#FAF7F5] px-4 py-10">
          <div className="w-full max-w-sm mx-auto">
            <BrandHeader />
            <OrderMeta order={order} />
            <div className={`rounded-3xl bg-stone-900 px-6 py-8 text-center relative overflow-hidden ${CARD_SHADOW}`}>
              <div className="absolute -right-8 -top-10 w-40 h-40 rounded-full bg-emerald-500/20 blur-2xl" />
              <div className="relative w-14 h-14 rounded-full bg-emerald-500/15 mx-auto mb-4 flex items-center justify-center text-2xl text-emerald-400">✓</div>
              <h1 className="relative text-xl font-extrabold text-white mb-1">Thanh toán thành công</h1>
              <p className="relative text-3xl font-extrabold text-white tabular-nums mt-3">{formatVND(order.amount)}</p>
            </div>
          </div>
        </main>
      </>
    )
  }

  if (order.status === 'FAILED') {
    return (
      <>
        <Head>
          <title>Giao dịch thất bại · Momo Dev</title>
        </Head>
        <main className="min-h-screen bg-[#FAF7F5] px-4 py-10">
          <div className="w-full max-w-sm mx-auto">
            <BrandHeader />
            <OrderMeta order={order} />
            <div className={`bg-white rounded-2xl p-8 text-center ${CARD_SHADOW}`}>
              <div className="w-14 h-14 rounded-full bg-rose-50 mx-auto mb-4 flex items-center justify-center text-2xl">✕</div>
              <h1 className="text-xl font-extrabold text-stone-900 mb-1">Giao dịch thất bại</h1>
              <p className="text-stone-500 text-sm mt-2">Đơn hàng này chưa được thanh toán thành công. Vui lòng liên hệ cửa hàng để được hỗ trợ tạo lại.</p>
            </div>
          </div>
        </main>
      </>
    )
  }

  // Chờ tải xong CẢ mã QR lẫn thông tin ngân hàng trước khi hiện giao diện
  // thanh toán — tránh khách thấy giao diện "nhảy" từng phần.
  const qrReady = qrLoaded || qrFailed
  const transferReady = !!transferInfo || !!transferError
  const initialReady = qrReady && transferReady

  if (!initialReady && !expired) {
    return (
      <>
        {/* Ảnh QR được tải ẩn ở background để bắt sự kiện load/error */}
        <img
          src={`/api/momo/qr-extract?orderId=${encodeURIComponent(orderId)}`}
          alt=""
          onLoad={() => setQrLoaded(true)}
          onError={() => setQrFailed(true)}
          className="hidden"
        />
        <CenterState>
          <div className="flex flex-col items-center justify-center gap-3 text-stone-400 text-sm py-6 text-center">
            <Spinner className="w-8 h-8 border-[3px]" />
            Đang tải mã QR và thông tin ngân hàng...
          </div>
        </CenterState>
      </>
    )
  }

  // PENDING — hiện QR và thông tin chuyển khoản cùng lúc
  return (
    <>
      <Head>
        <title>Thanh toán đơn hàng · Momo Dev</title>
      </Head>
      <main className="min-h-screen bg-[#FAF7F5] px-4 py-8 sm:py-10">
        <div className="w-full max-w-3xl mx-auto">
          <BrandHeader />

          {/* Số tiền cần thanh toán — thẻ chính, chiếm trọng tâm thị giác,
              cùng phong cách với thẻ "Doanh thu hôm nay" ở trang chủ admin. */}
          <div className={`rounded-3xl bg-stone-900 px-6 py-6 mb-3 relative overflow-hidden ${CARD_SHADOW.replace('0_1px_2px_rgba(33,26,29,0.04),0_6px_16px_-10px_rgba(33,26,29,0.15)', '0_20px_40px_-20px_rgba(33,26,29,0.45)')}`}>
            <div className="absolute -right-8 -top-10 w-40 h-40 rounded-full bg-momo/25 blur-2xl" />
            <div className="absolute -left-10 -bottom-12 w-40 h-40 rounded-full bg-momo/10 blur-2xl" />
            <p className="relative text-[11px] font-medium uppercase tracking-wide text-stone-400 mb-1.5">
              {order.orderInfo || 'Số tiền cần thanh toán'}
            </p>
            <p className="relative text-4xl sm:text-5xl font-extrabold text-white tabular-nums tracking-tight">
              {formatVND(order.amount)}
            </p>
          </div>

          <OrderMeta order={order} />

          {!expired && remainingMs !== null && (
            <div className={`rounded-2xl px-4 py-2.5 mb-4 text-center text-sm font-semibold font-mono tabular-nums ${remainingMs < 60000 ? 'bg-rose-50 text-rose-600' : 'bg-white text-stone-600'} ${CARD_SHADOW}`}>
              Còn lại {formatCountdown(remainingMs)} để hoàn tất thanh toán
            </div>
          )}

          {expired ? (
            <div className={`bg-white rounded-2xl p-8 text-center ${CARD_SHADOW}`}>
              <div className="w-14 h-14 rounded-full bg-stone-100 mx-auto mb-4 flex items-center justify-center text-2xl">⏱</div>
              <h1 className="text-xl font-extrabold text-stone-900 mb-1">Đã hết thời gian thanh toán</h1>
              <p className="text-stone-500 text-sm mt-2 mb-5">Mã QR cho đơn hàng này đã hết hạn sau 10 phút. Vui lòng liên hệ cửa hàng để được tạo lại đơn mới.</p>
              <button
                onClick={() => loadOrder({ manual: true })}
                disabled={checking}
                className="w-full py-3 rounded-xl bg-stone-100 text-stone-700 text-sm font-semibold hover:bg-stone-200 transition disabled:opacity-50"
              >
                {checking ? 'Đang kiểm tra...' : 'Kiểm tra lại trạng thái'}
              </button>
            </div>
          ) : (
            <>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                {/* Cột trái — Mã QR */}
                <div className={`bg-white rounded-2xl p-6 text-center flex flex-col ${CARD_SHADOW}`}>
                  <h2 className="font-bold text-stone-900 mb-4">Quét mã QR</h2>

                  {!qrFailed ? (
                    <img
                      src={`/api/momo/qr-extract?orderId=${encodeURIComponent(orderId)}`}
                      alt="Quét mã để thanh toán"
                      onError={() => setQrFailed(true)}
                      className="w-56 h-56 mx-auto rounded-xl border border-stone-100 mb-4"
                    />
                  ) : (
                    <p className="text-sm text-stone-400 py-16 mb-4">
                      Không tải được mã QR. Vui lòng dùng thông tin chuyển khoản bên cạnh.
                    </p>
                  )}

                  <p className="text-stone-500 text-sm mt-auto">
                    Mở app ngân hàng bất kỳ hoặc app MoMo, quét mã QR để thanh toán
                  </p>
                </div>

                {/* Cột phải — Thông tin chuyển khoản thủ công */}
                <div className={`bg-white rounded-2xl p-6 flex flex-col ${CARD_SHADOW}`}>
                  <h2 className="font-bold text-stone-900 mb-4 text-center">Thông tin chuyển khoản</h2>

                  {transferLoading && <p className="text-stone-400 text-sm text-center py-8">Đang tải thông tin...</p>}

                  {transferError && (
                    <p className="text-sm text-rose-700 bg-rose-50 rounded-xl px-3 py-2 mb-3">{transferError}</p>
                  )}

                  {transferInfo && (
                    <div className="flex flex-col gap-2">
                      <CopyField
                        label={`Ngân hàng${transferInfo.bank?.name ? '' : ' (mã BIN)'}`}
                        value={transferInfo.bank?.name || transferInfo.bank?.bin || '—'}
                      />
                      <CopyField label="Số tài khoản" value={transferInfo.accountNumber} />
                      <CopyField label="Số tiền" value={formatVND(transferInfo.amount)} />
                      <CopyField label="Nội dung chuyển khoản" value={transferInfo.content} />
                      <p className="text-xs text-amber-700 bg-amber-50 rounded-xl px-3 py-2 mt-2">
                        ⚠ Nhập ĐÚNG nội dung chuyển khoản để hệ thống nhận diện đơn hàng.
                      </p>
                    </div>
                  )}
                </div>
              </div>

              <button
                onClick={() => loadOrder({ manual: true })}
                disabled={checking}
                className="w-full py-3.5 rounded-xl bg-momo text-white text-sm font-semibold shadow-[0_10px_20px_-10px_rgba(165,0,100,0.6)] hover:bg-momo-dark transition disabled:opacity-50 mt-5"
              >
                {checking ? 'Đang kiểm tra...' : 'Kiểm tra kết quả'}
              </button>
            </>
          )}

          <p className="text-center text-stone-400 text-xs mt-5">
            Trang sẽ tự cập nhật khi thanh toán thành công
          </p>
        </div>
      </main>
    </>
  )
}