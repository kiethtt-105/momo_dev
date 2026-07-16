// pages/tao-giao-dich.js
//
// Trang tạo giao dịch, gồm 2 chế độ (tab):
// - P2P: bố cục 2 cột — cột trái là form nhập số tiền + nội dung
//   (POST /api/momo/create, mode=p2p), cột phải là danh sách "Đơn hàng
//   đang mở" xếp dọc xuống, mỗi đơn 1 dòng gọn (không giới hạn số
//   lượng, form bên trái luôn sẵn sàng tạo tiếp ngay). Không hiển thị
//   ảnh QR nữa — link thanh toán đã đủ chức năng: bấm trực tiếp vào
//   dòng link sẽ MỞ link đó (tab mới), nút "Chép" riêng bên cạnh mới
//   copy văn bản. Mỗi đơn có đồng hồ đếm ngược 10 phút (khớp
//   ORDER_EXPIRE_MS ở api/momo/create.js) và tự động kiểm tra trạng
//   thái mỗi 5s trong lúc chờ.
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
const POLL_INTERVAL_MS = 5000
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

// Dòng hiển thị 1 link: bấm trực tiếp vào dòng sẽ MỞ link (tab mới) —
// nút "Chép" riêng bên phải mới copy văn bản, không mở link.
function LinkField({ label, value, href }) {
  const [copied, setCopied] = useState(false)

  async function handleCopy(e) {
    e.preventDefault()
    e.stopPropagation()
    try {
      await navigator.clipboard.writeText(String(value))
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      /* im lặng */
    }
  }

  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className="w-full flex items-center justify-between gap-3 rounded-xl border border-neutral-200 px-3 py-2.5 hover:bg-neutral-50 hover:border-momo/30 transition"
      title="Bấm để mở link thanh toán"
    >
      <span className="min-w-0">
        <span className="block text-[11px] text-neutral-400">{label}</span>
        <span className="block font-mono text-sm font-semibold text-neutral-900 truncate">{value}</span>
      </span>
      <button
        onClick={handleCopy}
        className="shrink-0 text-[11px] font-semibold text-momo px-2.5 py-1.5 rounded-lg hover:bg-momo/10 transition"
      >
        {copied ? 'Đã chép ✓' : 'Chép'}
      </button>
    </a>
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
  const { secondsLeft, isExpired } = useCountdown(tx.expiresAt)
  const expiredAtRef = useRef(null)

  const thanhToanUrl =
    typeof window !== 'undefined'
      ? `${window.location.origin}/thanh-toan?orderId=${encodeURIComponent(tx.orderId)}`
      : `/thanh-toan?orderId=${encodeURIComponent(tx.orderId)}`

  async function handleCheck() {
    setChecking(true)
    try {
      const res = await fetch(`/api/momo/orders?orderId=${encodeURIComponent(tx.orderId)}`, {
        credentials: 'include',
      })
      const data = await res.json()
      const found = (data.orders || []).find((o) => o.orderId === tx.orderId)
      if (found) setStatus(found.status)
      setCheckedOnce(true)
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
        onClick={() => onRemove(tx.orderId)}
        className="absolute top-3 right-3 text-neutral-300 hover:text-neutral-500 text-sm w-6 h-6 flex items-center justify-center"
        title="Ẩn khỏi danh sách"
      >
        ✕
      </button>

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
        <div className="flex flex-col gap-2 mt-3">
          <LinkField label="Link thanh toán gửi khách" value={thanhToanUrl} href={thanhToanUrl} />
          {tx.payUrl && <LinkField label="Link thanh toán MoMo" value={tx.payUrl} href={tx.payUrl} />}
        </div>
      )}

      <button
        onClick={handleCheck}
        disabled={checking}
        className="w-full py-2.5 rounded-xl bg-momo text-white text-xs font-semibold hover:bg-momo-dark transition disabled:opacity-50 mt-3"
      >
        {checking ? 'Đang kiểm tra...' : 'Kiểm tra ngay'}
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