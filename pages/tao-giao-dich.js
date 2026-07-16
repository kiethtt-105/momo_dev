// pages/tao-giao-dich.js
//
// Trang tạo giao dịch, gồm 2 chế độ (tab):
// - P2P: bố cục 2 cột — cột trái là form nhập số tiền + nội dung
//   (POST /api/momo/create, mode=p2p), cột phải là danh sách "Đơn hàng
//   đang mở" xếp dọc xuống, mỗi đơn 1 dòng gọn (không giới hạn số
//   lượng, form bên trái luôn sẵn sàng tạo tiếp ngay). Mỗi đơn hiện mã
//   QR thanh toán; 2 link (trang thanh toán / link MoMo gốc) KHÔNG hiện
//   dạng plain text nữa — chỉ có biểu tượng liên kết (mở tab mới) và
//   biểu tượng copy riêng. Bấm ✕ để hủy đơn sẽ hiện POPUP XÁC NHẬN của
//   chính trang web (không dùng confirm()/alert() của trình duyệt),
//   phải bấm xác nhận mới ẩn đơn khỏi danh sách. Mỗi đơn có đồng hồ đếm
//   ngược 10 phút (khớp ORDER_EXPIRE_MS ở api/momo/create.js) và tự
//   động kiểm tra trạng thái mỗi 30s trong lúc chờ (hỏi thẳng MoMo qua
//   /api/momo/query — KHÔNG chỉ đọc Redis nữa, vì IPN có lúc không tới
//   nên chỉ đọc Redis sẽ đứng mãi ở PENDING dù khách đã thanh toán
//   xong). 30s để đỡ tốn quota gọi MoMo; nút "Kiểm tra ngay" vẫn cho
//   admin chủ động dò bất cứ lúc nào không cần chờ đủ 30s.
// - Quét mã khách (POS): nhân viên quét mã QR MoMo của khách (18 số)
//   -> nhập số tiền -> POST /api/momo/create (mode=scan) -> trừ tiền
//   trực tiếp từ ví khách, có kết quả ngay.
//   [Lưu ý: chế độ scan hiện chưa hoạt động ổn định — theo yêu cầu,
//   phần này chỉ giữ nguyên logic/giao diện cũ, chưa sửa; sẽ xử lý sau.]
//
// Không xử lý đăng nhập ở đây — pages/_app.js đã chặn ở tầng toàn
// cục. Nếu session hết hạn giữa chừng, route trả 401 -> reload để
// gate toàn cục bắt lại.

import { useEffect, useRef, useState } from 'react'
import Link from 'next/link'

const TABS = [
  { key: 'p2p', label: 'Tạo mã QR (P2P)' },
  { key: 'scan', label: 'Quét mã khách (POS)' },
]

const STATUS_STYLE = {
  PENDING: 'bg-amber-50 text-amber-700',
  PAID: 'bg-emerald-50 text-emerald-700',
  FAILED: 'bg-red-50 text-red-700',
  EXPIRED: 'bg-neutral-100 text-neutral-500',
}

const STATUS_TEXT = {
  PENDING: 'Chờ thanh toán',
  PAID: 'Đã thanh toán',
  FAILED: 'Thất bại',
  EXPIRED: 'Hết hạn',
}

const ORDER_TTL_SECONDS = 10 * 60 // khớp ORDER_EXPIRE_MS ở api/momo/create.js
const POLL_INTERVAL_MS = 30000 // hỏi MoMo qua /api/momo/query — 30s để đỡ tốn quota
const POLL_GRACE_MS = 2 * 60 * 1000 // vẫn dò thêm 2 phút sau khi hết hạn, phòng IPN tới trễ

function formatVND(n) {
  const num = Number(n)
  if (Number.isNaN(num)) return n
  return num.toLocaleString('vi-VN') + ' đ'
}

function formatCountdown(sec) {
  const s = Math.max(0, sec)
  const m = Math.floor(s / 60)
  const r = s % 60
  return `${m}:${String(r).padStart(2, '0')}`
}

// Đếm ngược tới `expiresAt` (ISO string), cập nhật mỗi giây.
// Trả về { secondsLeft, isExpired } — secondsLeft luôn >= 0.
function useCountdown(expiresAt) {
  const getRemaining = () => {
    if (!expiresAt) return ORDER_TTL_SECONDS
    return Math.round((new Date(expiresAt).getTime() - Date.now()) / 1000)
  }
  const [secondsLeft, setSecondsLeft] = useState(getRemaining)

  useEffect(() => {
    if (!expiresAt) return
    setSecondsLeft(getRemaining())
    const id = setInterval(() => setSecondsLeft(getRemaining()), 1000)
    return () => clearInterval(id)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [expiresAt])

  return { secondsLeft: Math.max(0, secondsLeft), isExpired: secondsLeft <= 0 }
}

// ─── Icon SVG dùng chung (không phụ thuộc thư viện ngoài) ───────────────
const IconExternalLink = (props) => (
  <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...props}>
    <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
    <polyline points="15 3 21 3 21 9" />
    <line x1="10" y1="14" x2="21" y2="3" />
  </svg>
)
const IconCopy = (props) => (
  <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...props}>
    <rect x="9" y="9" width="13" height="13" rx="2" />
    <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
  </svg>
)
const IconCheck = (props) => (
  <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...props}>
    <polyline points="20 6 9 17 4 12" />
  </svg>
)

// Dòng hiển thị 1 link bằng BIỂU TƯỢNG thay vì chuỗi ký tự (không lộ link
// dạng plain text ra giao diện nữa): biểu tượng liên kết để MỞ link (tab
// mới), biểu tượng copy riêng để chép văn bản — không mở link.
function IconLinkRow({ label, value, href }) {
  const [copied, setCopied] = useState(false)

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(String(value))
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      /* im lặng */
    }
  }

  return (
    <div className="w-full flex items-center justify-between gap-3 rounded-xl border border-neutral-200 px-3 py-2">
      <span className="text-[12px] text-neutral-500 truncate">{label}</span>
      <div className="flex items-center gap-1 shrink-0">
        <a
          href={href}
          target="_blank"
          rel="noreferrer"
          title="Mở liên kết thanh toán"
          className="w-8 h-8 flex items-center justify-center rounded-lg text-momo hover:bg-momo/10 transition"
        >
          <IconExternalLink />
        </a>
        <button
          type="button"
          onClick={handleCopy}
          title="Chép liên kết"
          className={`w-8 h-8 flex items-center justify-center rounded-lg transition ${
            copied ? 'text-emerald-600 bg-emerald-50' : 'text-neutral-500 hover:bg-neutral-100'
          }`}
        >
          {copied ? <IconCheck /> : <IconCopy />}
        </button>
      </div>
    </div>
  )
}

// Popup xác nhận CỦA TRANG WEB (không phải confirm()/alert() của trình
// duyệt) — hiện giữa màn hình, có lớp phủ mờ phía sau, bấm ra ngoài hoặc
// "Hủy" để đóng mà không làm gì.
function ConfirmModal({ open, title, description, confirmLabel = 'Xác nhận', onConfirm, onCancel }) {
  if (!open) return null
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4"
      onClick={onCancel}
    >
      <div
        className="bg-white rounded-2xl shadow-xl max-w-sm w-full p-5"
        onClick={(e) => e.stopPropagation()}
      >
        <h3 className="text-base font-bold text-neutral-900 mb-1.5">{title}</h3>
        {description && <p className="text-sm text-neutral-500 mb-5">{description}</p>}
        <div className="flex gap-2">
          <button
            type="button"
            onClick={onCancel}
            className="flex-1 py-2.5 rounded-xl border border-neutral-200 text-sm font-semibold text-neutral-600 hover:bg-neutral-50 transition"
          >
            Hủy
          </button>
          <button
            type="button"
            onClick={onConfirm}
            className="flex-1 py-2.5 rounded-xl bg-red-600 text-white text-sm font-semibold hover:bg-red-700 transition"
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  )
}

// Vòng tròn đếm ngược nhỏ, đặt góc thẻ. Màu chuyển momo -> vàng -> đỏ khi
// gần hết hạn, để admin liếc mắt là biết đơn nào sắp hết hạn mà chưa quét.
function CountdownRing({ secondsLeft, isExpired }) {
  const R = 15
  const C = 2 * Math.PI * R
  const pct = isExpired ? 0 : Math.max(0, Math.min(1, secondsLeft / ORDER_TTL_SECONDS))
  const color = isExpired
    ? '#D4D4D4'
    : secondsLeft <= 60
    ? '#DC2626'
    : secondsLeft <= 180
    ? '#D97706'
    : 'var(--momo-ring, #A50064)'

  return (
    <div className="relative w-10 h-10 shrink-0">
      <svg viewBox="0 0 36 36" className="w-10 h-10 -rotate-90">
        <circle cx="18" cy="18" r={R} fill="none" stroke="#F1F1F1" strokeWidth="3" />
        <circle
          cx="18" cy="18" r={R} fill="none"
          stroke={color} strokeWidth="3" strokeLinecap="round"
          strokeDasharray={C}
          strokeDashoffset={C * (1 - pct)}
          style={{ transition: 'stroke-dashoffset 1s linear, stroke 0.3s' }}
        />
      </svg>
      <span className="absolute inset-0 flex items-center justify-center text-[10px] font-mono font-semibold text-neutral-700">
        {isExpired ? '⏱' : formatCountdown(secondsLeft)}
      </span>
    </div>
  )
}

// ─── 1 DÒNG GIAO DỊCH TRONG DANH SÁCH "ĐƠN HÀNG ĐANG MỞ" ────────────────
// Tự quản lý trạng thái riêng (không phụ thuộc các dòng khác) — cho phép
// admin tạo nhiều giao dịch liên tiếp mà mỗi dòng vẫn hoạt động độc lập.
// Không hiện ảnh QR nữa — 2 link (trang thanh toán / link MoMo gốc) đã
// đủ chức năng: bấm trực tiếp vào dòng link để MỞ, nút "Chép" riêng để
// copy. Tự động dò trạng thái mỗi 5s trong lúc còn hạn (và thêm ít phút
// sau khi hết hạn phòng IPN tới trễ) — nút "Kiểm tra ngay" chỉ để admin
// chủ động dò thêm khi cần.
function TransactionRow({ tx, onRemove }) {
  const [status, setStatus] = useState('PENDING')
  const [checking, setChecking] = useState(false)
  const [checkedOnce, setCheckedOnce] = useState(false)
  const [confirmRemove, setConfirmRemove] = useState(false)
  const { secondsLeft, isExpired } = useCountdown(tx.expiresAt)
  const expiredAtRef = useRef(null)

  const thanhToanUrl =
    typeof window !== 'undefined'
      ? `${window.location.origin}/thanh-toan?orderId=${encodeURIComponent(tx.orderId)}`
      : `/thanh-toan?orderId=${encodeURIComponent(tx.orderId)}`

  // Hỏi THẲNG MoMo (server-to-server, qua /api/momo/query) thay vì chỉ
  // đọc Redis — Redis chỉ được cập nhật khi IPN tới, mà IPN có lúc
  // không tới nên đơn cứ đứng PENDING mãi dù khách đã thanh toán xong.
  // Route query.js tự đồng bộ Redis luôn nên lần kiểm tra sau (nếu có)
  // sẽ thấy trạng thái mới nhất kể cả không gọi lại route này.
  async function handleCheck() {
    setChecking(true)
    try {
      const res = await fetch(`/api/momo/query?orderId=${encodeURIComponent(tx.orderId)}`, {
        credentials: 'include',
      })
      if (res.status === 401) {
        window.location.reload()
        return
      }
      const data = await res.json()
      if (res.ok) {
        if (data.orderStatus) {
          // Route đã đồng bộ Redis xong — dùng thẳng trạng thái cuối này
          setStatus(data.orderStatus)
        } else if (data.isPaid) {
          setStatus('PAID')
        } else if (!data.isStillPending) {
          setStatus('FAILED')
        }
        // isStillPending=true (MoMo báo đang xử lý) -> giữ nguyên PENDING
        setCheckedOnce(true)
      }
    } catch {
      /* giữ nguyên trạng thái cũ nếu lỗi mạng */
    } finally {
      setChecking(false)
    }
  }

  // Tự động dò trạng thái trong lúc chờ khách quét, dừng ngay khi có kết
  // quả cuối (PAID/FAILED). Hết hạn rồi vẫn dò thêm 2 phút phòng trường
  // hợp khách bấm thanh toán sát giờ / IPN tới trễ, sau đó ngưng hẳn.
  useEffect(() => {
    if (status !== 'PENDING') return
    if (isExpired) {
      if (!expiredAtRef.current) expiredAtRef.current = Date.now()
      if (Date.now() - expiredAtRef.current > POLL_GRACE_MS) return
    }
    const id = setInterval(handleCheck, POLL_INTERVAL_MS)
    return () => clearInterval(id)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status, isExpired])

  const displayStatus = status === 'PENDING' && isExpired ? 'EXPIRED' : status
  const showPayInfo = status === 'PENDING' && !isExpired

  return (
    <div className="bg-white rounded-2xl border border-neutral-200 p-4 relative">
      <button
        onClick={() => setConfirmRemove(true)}
        className="absolute top-3 right-3 text-neutral-300 hover:text-neutral-500 text-sm w-6 h-6 flex items-center justify-center"
        title="Hủy đơn"
      >
        ✕
      </button>

      <ConfirmModal
        open={confirmRemove}
        title="Hủy đơn hàng này?"
        description="Đơn sẽ được ẩn khỏi danh sách trên màn hình này. Nếu khách đã thanh toán, giao dịch vẫn được ghi nhận bình thường."
        confirmLabel="Hủy đơn"
        onCancel={() => setConfirmRemove(false)}
        onConfirm={() => {
          setConfirmRemove(false)
          onRemove(tx.orderId)
        }}
      />

      <div className="flex items-center gap-3 pr-6">
        {status === 'PENDING' ? (
          <CountdownRing secondsLeft={secondsLeft} isExpired={isExpired} />
        ) : (
          <div className="w-10 h-10 shrink-0 rounded-full bg-neutral-50 flex items-center justify-center text-base">
            {status === 'PAID' ? '✓' : status === 'FAILED' ? '✕' : '⏱'}
          </div>
        )}
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className={`inline-block text-[11px] font-semibold px-2 py-0.5 rounded-full ${STATUS_STYLE[displayStatus] || 'bg-neutral-100 text-neutral-600'}`}>
              {STATUS_TEXT[displayStatus] || displayStatus}
            </span>
            <span className="font-mono text-[11px] text-neutral-400 truncate">{tx.orderId}</span>
          </div>
          <p className="font-mono font-extrabold text-lg text-neutral-900 leading-tight mt-0.5">
            {formatVND(tx.amount)}
          </p>
        </div>
      </div>

      {checkedOnce && status === 'PAID' && (
        <p className="text-sm text-emerald-700 bg-emerald-50 rounded-lg px-3 py-2 mt-3 text-center font-semibold">
          ✓ Giao dịch thành công
        </p>
      )}
      {checkedOnce && status === 'FAILED' && (
        <p className="text-sm text-red-600 bg-red-50 rounded-lg px-3 py-2 mt-3 text-center font-semibold">
          ✕ Giao dịch thất bại
        </p>
      )}
      {status === 'PENDING' && isExpired && (
        <p className="text-sm text-neutral-500 bg-neutral-50 rounded-lg px-3 py-2 mt-3 text-center">
          Đã quá 10 phút — nếu khách vừa thanh toán, bấm kiểm tra lại bên dưới.
        </p>
      )}

      {showPayInfo && (
        <div className="flex flex-col items-center gap-3 mt-3">
          {tx.qrCodeImage && (
            <img
              src={tx.qrCodeImage}
              alt="Mã QR thanh toán"
              className="w-40 h-40 rounded-xl border border-neutral-200 object-contain bg-white"
            />
          )}
          <div className="w-full flex flex-col gap-2">
            <IconLinkRow label="Link thanh toán gửi khách" value={thanhToanUrl} href={thanhToanUrl} />
            {tx.payUrl && <IconLinkRow label="Link thanh toán MoMo" value={tx.payUrl} href={tx.payUrl} />}
          </div>
        </div>
      )}

      <button
        onClick={handleCheck}
        disabled={checking}
        title="Hỏi trực tiếp MoMo, không chờ webhook"
        className="w-full py-2.5 rounded-xl bg-momo text-white text-xs font-semibold hover:bg-momo-dark transition disabled:opacity-50 mt-3"
      >
        {checking ? 'Đang hỏi MoMo...' : 'Kiểm tra ngay'}
      </button>
    </div>
  )
}

function StoreSelect({ stores, storeId, setStoreId }) {
  if (stores.length <= 1) return null
  return (
    <>
      <label className="block text-sm font-medium text-neutral-700 mb-1">Cửa hàng</label>
      <select
        value={storeId}
        onChange={(e) => setStoreId(e.target.value)}
        className="w-full rounded-xl border border-neutral-200 px-4 py-3 mb-4 bg-white focus:outline-none focus:ring-2 focus:ring-momo/40 focus:border-momo"
      >
        {stores.map((s) => (
          <option key={s.id} value={s.id}>
            {s.name}{s.default ? ' (mặc định)' : ''}
          </option>
        ))}
      </select>
    </>
  )
}

function useStores() {
  const [stores, setStores] = useState([])
  const [storeId, setStoreId] = useState('')

  useEffect(() => {
    fetch('/api/momo/stores', { credentials: 'include' })
      .then((res) => (res.ok ? res.json() : { stores: [] }))
      .then((data) => {
        const list = data.stores || []
        setStores(list)
        const def = list.find((s) => s.default)
        if (def) setStoreId(def.id)
      })
      .catch(() => {})
  }, [])

  return { stores, storeId, setStoreId }
}

// Cột trái — chỉ lo việc nhập liệu + gửi tạo giao dịch. Không giữ danh
// sách giao dịch (đã đưa lên P2PSection) nên form luôn gọn và trống sẵn
// để tạo đơn tiếp theo ngay sau khi submit.
function P2POrderForm({ stores, storeId, setStoreId, onCreated }) {
  const [amount, setAmount] = useState('')
  const [orderInfo, setOrderInfo] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    // Warm sẵn browser Puppeteer dùng để trích QR thật — đỡ chờ cold-start
    fetch('/api/momo/qr-extract?warm=1').catch(() => {})
  }, [])

  async function handleSubmit(e) {
    e.preventDefault()
    setError('')
    setLoading(true)
    try {
      const res = await fetch('/api/momo/create', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ mode: 'p2p', amount, orderInfo, storeId }),
      })
      if (res.status === 401) {
        window.location.reload()
        return
      }
      const data = await res.json()
      if (!res.ok) {
        setError(data.error || 'Không tạo được giao dịch')
        return
      }

      // Đẩy đơn mới lên danh sách bên phải (qua P2PSection), form ở đây
      // trống lại ngay để tạo tiếp.
      onCreated({
        orderId: data.orderId,
        amount: Number(amount),
        payUrl: data.payUrl,
        qrCodeImage: data.qrCodeImage,
        expiresAt: data.expiresAt,
      })
      setAmount('')
      setOrderInfo('')
    } catch {
      setError('Lỗi kết nối, thử lại sau')
    } finally {
      setLoading(false)
    }
  }

  return (
    <form onSubmit={handleSubmit} className="bg-white rounded-2xl border border-neutral-200 p-6">
      <StoreSelect stores={stores} storeId={storeId} setStoreId={setStoreId} />

      <label className="block text-sm font-medium text-neutral-700 mb-1">Số tiền (₫)</label>
      <input
        type="number"
        inputMode="numeric"
        min={1000}
        value={amount}
        onChange={(e) => setAmount(e.target.value)}
        placeholder="Ví dụ: 50000"
        className="w-full rounded-xl border border-neutral-200 px-4 py-3 mb-4 font-mono focus:outline-none focus:ring-2 focus:ring-momo/40 focus:border-momo"
        required
      />

      <label className="block text-sm font-medium text-neutral-700 mb-1">Nội dung (tuỳ chọn)</label>
      <input
        type="text"
        value={orderInfo}
        onChange={(e) => setOrderInfo(e.target.value)}
        placeholder="Ví dụ: Thanh toán đơn hàng"
        className="w-full rounded-xl border border-neutral-200 px-4 py-3 mb-5 focus:outline-none focus:ring-2 focus:ring-momo/40 focus:border-momo"
      />

      {error && <p className="text-sm text-red-600 bg-red-50 rounded-lg px-3 py-2 mb-4">{error}</p>}

      <button
        type="submit"
        disabled={loading}
        className="w-full py-3.5 rounded-xl bg-momo text-white font-semibold hover:bg-momo-dark transition disabled:opacity-50"
      >
        {loading ? 'Đang tạo...' : 'Tạo mã QR'}
      </button>
      <p className="text-[11px] text-neutral-400 text-center mt-3">Mỗi mã QR có hạn 10 phút kể từ lúc tạo</p>
    </form>
  )
}

// Cột phải — danh sách "Đơn hàng đang mở", xếp dọc xuống (không cuộn
// ngang như trước). Dính theo khi cuộn trang trên màn hình rộng để luôn
// thấy được trong lúc vẫn thao tác ở form bên trái.
function OrdersPanel({ transactions, onRemove }) {
  return (
    <div className="bg-white rounded-2xl border border-neutral-200 p-4 lg:sticky lg:top-6 lg:max-h-[calc(100vh-3rem)] lg:overflow-y-auto">
      <div className="flex items-center justify-between mb-3 px-1">
        <h2 className="text-sm font-semibold text-neutral-700">Đơn hàng đang mở</h2>
        <span className="text-xs font-mono text-neutral-400">{transactions.length}</span>
      </div>
      {transactions.length === 0 ? (
        <p className="text-sm text-neutral-400 text-center py-10">Chưa có đơn hàng nào</p>
      ) : (
        <div className="flex flex-col gap-3">
          {transactions.map((tx) => (
            <TransactionRow key={tx.orderId} tx={tx} onRemove={onRemove} />
          ))}
        </div>
      )}
    </div>
  )
}

// Bố cục 2 cột: trái là form tạo đơn, phải là danh sách đơn đang mở.
// State danh sách được giữ ở đây (không phải trong form) để cột phải
// luôn cập nhật ngay khi cột trái tạo đơn thành công.
function P2PSection() {
  const { stores, storeId, setStoreId } = useStores()
  const [transactions, setTransactions] = useState([]) // cộng dồn, không giới hạn

  function handleCreated(tx) {
    // Thêm đơn MỚI vào đầu danh sách, KHÔNG xóa các đơn trước đó và
    // KHÔNG giới hạn số lượng.
    setTransactions((cur) => [tx, ...cur])
  }

  function handleRemove(orderId) {
    setTransactions((cur) => cur.filter((t) => t.orderId !== orderId))
  }

  return (
    <div className="grid grid-cols-1 lg:grid-cols-[380px_1fr] gap-6 items-start">
      <P2POrderForm stores={stores} storeId={storeId} setStoreId={setStoreId} onCreated={handleCreated} />
      <OrdersPanel transactions={transactions} onRemove={handleRemove} />
    </div>
  )
}

function ScanForm() {
  const [amount, setAmount] = useState('')
  const [code, setCode] = useState('')
  const { stores, storeId, setStoreId } = useStores()
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [result, setResult] = useState(null)

  async function handleSubmit(e) {
    e.preventDefault()
    setError('')
    setResult(null)
    setLoading(true)
    try {
      const res = await fetch('/api/momo/create', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          mode: 'scan',
          amount,
          paymentCode: code,
          storeId,
          orderId: `POS${Date.now()}${Math.random().toString(36).slice(2, 6)}`,
        }),
      })
      if (res.status === 401) {
        window.location.reload()
        return
      }
      const data = await res.json()
      if (!res.ok) {
        setError(data.error || 'Không xử lý được giao dịch')
        return
      }
      setResult(data)
      setCode('')
      setAmount('')
    } catch {
      setError('Lỗi kết nối, thử lại sau')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="bg-white rounded-2xl border border-neutral-200 p-6">
      <form onSubmit={handleSubmit}>
        <StoreSelect stores={stores} storeId={storeId} setStoreId={setStoreId} />

        <label className="block text-sm font-medium text-neutral-700 mb-1">Số tiền (₫)</label>
        <input
          type="number"
          inputMode="numeric"
          min={1000}
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          placeholder="Ví dụ: 50000"
          className="w-full rounded-xl border border-neutral-200 px-4 py-3 mb-4 font-mono focus:outline-none focus:ring-2 focus:ring-momo/40 focus:border-momo"
          required
        />

        <label className="block text-sm font-medium text-neutral-700 mb-1">Mã thanh toán (18 số)</label>
        <input
          type="text"
          value={code}
          onChange={(e) => setCode(e.target.value)}
          placeholder="Quét/dán mã QR của khách"
          className="w-full rounded-xl border border-neutral-200 px-4 py-3 mb-5 font-mono focus:outline-none focus:ring-2 focus:ring-momo/40 focus:border-momo"
          required
        />

        {error && <p className="text-sm text-red-600 bg-red-50 rounded-lg px-3 py-2 mb-4">{error}</p>}
        {result && (
          <p
            className={`text-sm rounded-lg px-3 py-2 mb-4 ${
              result.resultCode === 0 ? 'bg-emerald-50 text-emerald-700' : 'bg-red-50 text-red-700'
            }`}
          >
            {result.resultCode === 0 ? '✓ Thu tiền thành công' : result.message || 'Giao dịch thất bại'}
          </p>
        )}

        <button
          type="submit"
          disabled={loading}
          className="w-full py-3.5 rounded-xl bg-momo text-white font-semibold hover:bg-momo-dark transition disabled:opacity-50"
        >
          {loading ? 'Đang xử lý...' : 'Thu tiền'}
        </button>
      </form>
    </div>
  )
}

export default function TaoGiaoDich() {
  const [tab, setTab] = useState('p2p')

  return (
    <main className="min-h-screen px-4 py-10 bg-neutral-50">
      <div className={tab === 'p2p' ? 'max-w-5xl mx-auto' : 'max-w-4xl mx-auto'}>
        <div className="flex items-center justify-between mb-6">
          <h1 className="text-xl font-extrabold text-neutral-900">Tạo giao dịch</h1>
          <Link href="/" className="text-sm text-neutral-500 hover:text-neutral-800">
            ← Trang chủ
          </Link>
        </div>

        <div className="flex gap-2 mb-6 bg-neutral-100 rounded-xl p-1 max-w-sm w-full">
          {TABS.map((t) => (
            <button
              key={t.key}
              onClick={() => setTab(t.key)}
              className={`flex-1 py-2 rounded-lg text-sm font-semibold transition ${
                tab === t.key
                  ? 'bg-white text-neutral-900 shadow-sm'
                  : 'text-neutral-500 hover:text-neutral-800'
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>

        {tab === 'p2p' ? (
          <P2PSection />
        ) : (
          <div className="max-w-sm w-full mx-auto">
            <ScanForm />
          </div>
        )}
      </div>
    </main>
  )
}