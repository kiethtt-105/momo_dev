// pages/tao-giao-dich.js
//
// Trang tạo giao dịch, gồm 2 chế độ (tab): P2P và Quét mã khách (Scan).
// Cả 2 tab dùng CHUNG 1 bố cục 2 cột cố định (form bên trái rộng cố
// định 380px, danh sách đơn bên phải) và cùng nằm trong 1 khung ngoài
// rộng cố định (max-w-5xl) — bấm đổi qua đổi lại giữa P2P/Scan không
// làm khung trái đổi kích thước, không bị "giật" layout.
//
// Cả 2 section (P2PSection, ScanSection) LUÔN được mount sẵn trong DOM
// ngay từ đầu, chỉ ẩn/hiện bằng CSS (className hidden) khi đổi tab —
// KHÔNG conditional-render (unmount/remount) như trước nữa. Nhờ vậy
// state (danh sách đơn đang mở, bộ đếm giờ, các poll interval...) của
// tab không active vẫn được giữ nguyên phía sau, chuyển qua chuyển lại
// không còn mất đơn.
//
// - P2P: form nhập số tiền + nội dung (POST /api/momo/create,
//   mode=p2p), cột phải là danh sách "Đơn hàng đang mở" xếp dọc xuống,
//   mỗi đơn 1 dòng gọn (không giới hạn số lượng, form bên trái luôn
//   sẵn sàng tạo tiếp ngay). Mỗi đơn hiện mã QR thanh toán; 2 link
//   (trang thanh toán / link MoMo gốc) KHÔNG hiện dạng plain text nữa
//   — chỉ có biểu tượng liên kết (mở tab mới) và biểu tượng copy
//   riêng. Bấm ✕ để hủy đơn sẽ hiện POPUP XÁC NHẬN của chính trang web
//   (không dùng confirm()/alert() của trình duyệt), phải bấm xác nhận
//   mới ẩn đơn khỏi danh sách. Mỗi đơn có đồng hồ đếm ngược 10 phút
//   (khớp ORDER_EXPIRE_MS ở api/momo/create.js) và tự động kiểm tra
//   trạng thái mỗi 30s trong lúc chờ (hỏi thẳng MoMo qua
//   /api/momo/query — KHÔNG chỉ đọc Redis nữa, vì IPN có lúc không tới
//   nên chỉ đọc Redis sẽ đứng mãi ở PENDING dù khách đã thanh toán
//   xong). 30s để đỡ tốn quota gọi MoMo; nút "Kiểm tra ngay" vẫn cho
//   admin chủ động dò bất cứ lúc nào không cần chờ đủ 30s.
// - Quét mã khách (Scan/POS): giờ cũng có 2 cột như P2P thay vì 1 form
//   đơn lẻ. Form bên trái chỉ nhập số tiền -> mở 1 "đơn chờ scan" mới
//   ở cột phải (chưa gọi API vội vì chưa có mã). Có thể mở NHIỀU đơn
//   chờ scan cùng lúc (ví dụ nhiều khách xếp hàng). Bấm vào 1 đơn trong
//   danh sách để CHỌN nó làm đơn đang hoạt động — đơn được chọn tô
//   viền màu momo để dễ nhận biết; máy quét mã (đóng vai bàn phím) chỉ
//   gõ vào ô nhập của đúng đơn đang được chọn, các đơn khác bị khoá ô
//   nhập để tránh gõ nhầm. Quét xong (đủ 18 số hoặc bấm Enter) sẽ tự
//   POST /api/momo/create (mode=scan) và có KẾT QUẢ NGAY LẬP TỨC (khác
//   với P2P phải chờ poll 30s hoặc bấm "Kiểm tra ngay" thủ công).
//
// Không xử lý đăng nhập ở đây — pages/_app.js đã chặn ở tầng toàn
// cục. Nếu session hết hạn giữa chừng, route trả 401 -> reload để
// gate toàn cục bắt lại.

import { useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import jsQR from 'jsqr'

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
// Backoff tăng dần cho poll trạng thái đơn: 3 lần đầu 15s, rồi giãn dần
// ra 30s -> 45s -> tối đa 60s. IPN mới là nguồn cập nhật "thật" chính,
// poll ở đây chỉ là lưới dự phòng phòng khi IPN tới trễ/không tới.
const POLL_BACKOFF_STEPS_MS = [15000, 15000, 15000, 30000, 45000]
const POLL_BACKOFF_MAX_MS = 60000
function getPollDelay(attempt) {
  return POLL_BACKOFF_STEPS_MS[attempt] ?? POLL_BACKOFF_MAX_MS
}
const POLL_GRACE_MS = 2 * 60 * 1000 // vẫn dò thêm 2 phút sau khi hết hạn, phòng IPN tới trễ

const CACHE_KEY_P2P = 'momo_tao_gd_p2p_v1'
const CACHE_KEY_SCAN = 'momo_tao_gd_scan_v1'
const CACHE_KEY_TAB = 'momo_tao_gd_tab_v1'
const CACHE_KEY_STORES = 'momo_tao_gd_stores_v1'

// Lưu vào sessionStorage (còn giữ được khi bấm F5 reload tab, tự xóa khi
// đóng tab hẳn) — dùng chung cho danh sách đơn, tab đang chọn, danh sách
// cửa hàng... F5 xong đọc lại ngay từ cache, không phải chờ gọi API lại
// mới có dữ liệu để hiển thị.
function loadCache(key, fallback) {
  if (typeof window === 'undefined') return fallback
  try {
    const raw = window.sessionStorage.getItem(key)
    return raw ? JSON.parse(raw) : fallback
  } catch {
    return fallback
  }
}

function saveCache(key, value) {
  if (typeof window === 'undefined') return
  try {
    window.sessionStorage.setItem(key, JSON.stringify(value))
  } catch {
    /* sessionStorage đầy hoặc bị chặn -> bỏ qua, không chặn thao tác chính */
  }
}

// Giữ tên cũ cho danh sách đơn (đọc rõ nghĩa hơn ở chỗ gọi).
function loadOrderCache(key) {
  const list = loadCache(key, [])
  return Array.isArray(list) ? list : []
}
const saveOrderCache = saveCache

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
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm px-4"
      onClick={onCancel}
    >
      <div
        className="bg-white rounded-2xl shadow-2xl shadow-black/20 ring-1 ring-black/5 max-w-sm w-full p-5"
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

// Popup CHI TIẾT giao dịch — gọi thẳng /api/momo/query (server-to-server)
// mỗi lần mở để lấy dữ liệu MỚI NHẤT, ĐẦY ĐỦ NHẤT từ MoMo (transId,
// phương thức thanh toán, thời gian xử lý...) thay vì chỉ dùng dữ liệu
// rút gọn đã có sẵn trên dòng/thẻ đơn hàng.
function OrderDetailModal({ open, onClose, orderId }) {
  const [loading, setLoading] = useState(false)
  const [data, setData] = useState(null)
  const [error, setError] = useState('')

  useEffect(() => {
    if (!open || !orderId) return
    let cancelled = false
    setLoading(true)
    setError('')
    setData(null)
    fetch(`/api/momo/query?orderId=${encodeURIComponent(orderId)}`, { credentials: 'include' })
      .then(async (res) => {
        if (res.status === 401) {
          window.location.reload()
          return
        }
        const json = await res.json()
        if (cancelled) return
        if (!res.ok) throw new Error(json.error || 'Không tải được chi tiết')
        setData(json)
      })
      .catch((e) => !cancelled && setError(e.message || 'Không tải được chi tiết'))
      .finally(() => !cancelled && setLoading(false))
    return () => {
      cancelled = true
    }
  }, [open, orderId])

  if (!open) return null

  const rows = data
    ? [
        ['Mã đơn', data.orderId],
        ['Mã giao dịch MoMo', data.transId || '—'],
        ['Số tiền', formatVND(data.amount)],
        ['Phương thức', data.payType || '—'],
        [
          'Trạng thái',
          data.isPaid ? 'Đã thanh toán' : data.isStillPending ? 'Đang xử lý' : 'Thất bại',
        ],
        [
          'Thời gian MoMo xử lý',
          data.responseTime ? new Date(Number(data.responseTime)).toLocaleString('vi-VN') : '—',
        ],
        ['Thông báo từ MoMo', data.message || '—'],
      ]
    : []

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm px-4" onClick={onClose}>
      <div
        className="bg-white rounded-2xl shadow-2xl shadow-black/20 ring-1 ring-black/5 max-w-sm w-full p-5"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-base font-bold text-neutral-900">Chi tiết giao dịch</h3>
          <button
            type="button"
            onClick={onClose}
            className="text-neutral-400 hover:text-neutral-600 w-6 h-6 flex items-center justify-center"
          >
            ✕
          </button>
        </div>

        {loading && <p className="text-sm text-neutral-500 text-center py-6">Đang hỏi MoMo...</p>}
        {error && <p className="text-sm text-red-600 bg-red-50 rounded-lg px-3 py-2">{error}</p>}
        {!loading && !error && data && (
          <div className="flex flex-col gap-2.5">
            {rows.map(([label, value]) => (
              <div key={label} className="flex items-start justify-between gap-3 text-sm">
                <span className="text-neutral-500 shrink-0">{label}</span>
                <span className="font-mono text-neutral-900 text-right break-all">{value}</span>
              </div>
            ))}
          </div>
        )}
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
function TransactionRow({ tx, onRemove, onUpdate }) {
  // Khởi tạo từ trạng thái đã lưu trong cache (nếu có) thay vì luôn bắt đầu
  // lại từ PENDING — F5 xong đơn đã PAID/FAILED hiện đúng ngay lập tức,
  // không bị nháy về "Chờ thanh toán" trong lúc chờ dò lại MoMo.
  const [status, setStatus] = useState(tx.status || 'PENDING')
  const [checking, setChecking] = useState(false)
  const [checkedOnce, setCheckedOnce] = useState(!!tx.checkedOnce)
  const [confirmRemove, setConfirmRemove] = useState(false)
  const [showDetail, setShowDetail] = useState(false)
  const { secondsLeft, isExpired } = useCountdown(tx.expiresAt)
  const expiredAtRef = useRef(null)

  const thanhToanUrl =
    typeof window !== 'undefined'
      ? `${window.location.origin}/thanh-toan?orderId=${encodeURIComponent(tx.orderId)}`
      : `/thanh-toan?orderId=${encodeURIComponent(tx.orderId)}`

  // Mỗi khi trạng thái đổi thì ghi ngược lại cache (qua onUpdate của
  // P2PSection) để F5 lần sau đọc được ngay, không cần dò lại MoMo mới
  // biết đơn đã PAID/FAILED hay chưa.
  useEffect(() => {
    onUpdate(tx.orderId, { status, checkedOnce })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status, checkedOnce])

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

  // Đơn đã có kết quả cuối cùng (PAID/FAILED) từ cache rồi thì khỏi cần
  // dò lại MoMo lúc mount nữa — đỡ tốn 1 lượt gọi API vô ích. Chỉ những
  // đơn còn PENDING mới cần xác nhận lại ngay để chắc chắn là mới nhất.
  useEffect(() => {
    if (status === 'PAID' || status === 'FAILED') return
    handleCheck()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Tự động dò trạng thái trong lúc chờ khách quét, dừng ngay khi có kết
  // quả cuối (PAID/FAILED). Hết hạn rồi vẫn dò thêm 2 phút phòng trường
  // hợp khách bấm thanh toán sát giờ / IPN tới trễ, sau đó ngưng hẳn.
  //
  // Dùng setTimeout tự lặp (không phải setInterval cố định) để: (1) mỗi
  // vòng có thể giãn thời gian dần (backoff) thay vì luôn 30s, (2) tạm
  // dừng hẳn khi tab bị ẩn (đỡ tốn quota gọi MoMo lúc admin không xem
  // trang) và tự kiểm tra ngay 1 lần khi quay lại tab thay vì chờ hết
  // chu kỳ mới poll tiếp.
  useEffect(() => {
    if (status !== 'PENDING') return
    if (isExpired) {
      if (!expiredAtRef.current) expiredAtRef.current = Date.now()
      if (Date.now() - expiredAtRef.current > POLL_GRACE_MS) return
    }

    let cancelled = false
    let attempt = 0
    let timeoutId = null

    function schedule() {
      if (cancelled || document.visibilityState === 'hidden') return
      const delay = getPollDelay(attempt)
      attempt += 1
      timeoutId = setTimeout(async () => {
        await handleCheck()
        schedule()
      }, delay)
    }

    function handleVisibility() {
      if (cancelled) return
      if (timeoutId) { clearTimeout(timeoutId); timeoutId = null }
      if (document.visibilityState === 'visible') {
        handleCheck().then(schedule)
      }
    }

    document.addEventListener('visibilitychange', handleVisibility)
    schedule()

    return () => {
      cancelled = true
      if (timeoutId) clearTimeout(timeoutId)
      document.removeEventListener('visibilitychange', handleVisibility)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status, isExpired])

  // Đơn hết hạn (đếm ngược về 0) mà không phải chờ tay bấm ✕ nữa — tự động
  // xóa khỏi danh sách sau khi hết luôn cả khoảng dò thêm phòng IPN trễ
  // (POLL_GRACE_MS), nếu vẫn chưa có kết quả cuối cùng.
  useEffect(() => {
    if (status !== 'PENDING' || !isExpired) return
    const timer = setTimeout(() => onRemove(tx.orderId), POLL_GRACE_MS)
    return () => clearTimeout(timer)
  }, [status, isExpired, tx.orderId, onRemove])

  const displayStatus = status === 'PENDING' && isExpired ? 'EXPIRED' : status
  const showPayInfo = status === 'PENDING' && !isExpired
  // Đơn đã có KẾT QUẢ CUỐI CÙNG (thành công/thất bại) thì không còn gì để
  // "hủy" nữa — chữ đúng phải là "Đóng" (chỉ ẩn khỏi màn hình theo dõi,
  // không tác động dữ liệu giao dịch đã ghi nhận). "Hủy đơn" chỉ dùng cho
  // đơn còn đang chờ thanh toán, vì lúc đó hủy thật sự có ý nghĩa dừng
  // theo dõi 1 đơn chưa xong.
  const isFinal = status === 'PAID' || status === 'FAILED'

  return (
    <div className="bg-white/90 backdrop-blur-sm rounded-2xl border border-neutral-200/70 shadow-[0_2px_10px_-4px_rgba(0,0,0,0.06),0_16px_40px_-20px_rgba(165,0,100,0.18)] hover:shadow-[0_4px_18px_-4px_rgba(0,0,0,0.08),0_24px_56px_-20px_rgba(165,0,100,0.24)] hover:-translate-y-0.5 transition-all duration-300 p-4 relative">
      <button
        onClick={() => setConfirmRemove(true)}
        className="absolute top-3 right-3 text-neutral-300 hover:text-neutral-500 text-sm w-6 h-6 flex items-center justify-center"
        title={isFinal ? 'Đóng giao dịch' : 'Hủy đơn'}
      >
        ✕
      </button>

      <ConfirmModal
        open={confirmRemove}
        title={isFinal ? 'Đóng giao dịch này?' : 'Hủy đơn hàng này?'}
        description={
          isFinal
            ? 'Giao dịch đã có kết quả cuối cùng — đóng chỉ để ẩn khỏi danh sách trên màn hình này, không ảnh hưởng gì tới dữ liệu giao dịch đã ghi nhận.'
            : 'Đơn sẽ được ẩn khỏi danh sách trên màn hình này. Nếu khách đã thanh toán, giao dịch vẫn được ghi nhận bình thường.'
        }
        confirmLabel={isFinal ? 'Đóng' : 'Hủy đơn'}
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
            <span className={`inline-block text-[11px] font-semibold px-2.5 py-1 rounded-full shadow-sm ring-1 ring-inset ring-black/5 ${STATUS_STYLE[displayStatus] || 'bg-neutral-100 text-neutral-600'}`}>
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
        <div className="mt-3">
          <p className="text-sm text-emerald-700 bg-emerald-50 rounded-lg px-3 py-2 text-center font-semibold">
            ✓ Giao dịch thành công
          </p>
          <div className="flex items-center justify-between gap-2 text-[12px] text-neutral-500 mt-2 px-1">
            <span className="font-mono truncate">{tx.orderId}</span>
            <span className="font-mono shrink-0">{formatVND(tx.amount)}</span>
          </div>
          <button
            type="button"
            onClick={() => setShowDetail(true)}
            className="w-full py-2.5 rounded-xl border border-emerald-200 text-emerald-700 text-xs font-semibold hover:bg-emerald-50 transition mt-2"
          >
            Xem chi tiết giao dịch
          </button>
        </div>
      )}
      <OrderDetailModal open={showDetail} onClose={() => setShowDetail(false)} orderId={tx.orderId} />
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

      {/* Không hiện mã QR ở đây nữa — chỉ 2 link (trang thanh toán tự tạo
          và link mở thẳng app MoMo), dùng chung IconLinkRow (biểu tượng mở
          + biểu tượng chép, không lộ link dạng chữ). */}
      {showPayInfo && (
        <div className="w-full flex flex-col gap-2 mt-3">
          <IconLinkRow label="Trang thanh toán (gửi cho khách)" value={thanhToanUrl} href={thanhToanUrl} />
          {tx.payUrl && <IconLinkRow label="Mở thẳng trong ứng dụng MoMo" value={tx.payUrl} href={tx.payUrl} />}
        </div>
      )}

      {status !== 'PAID' && status !== 'FAILED' && (
        <button
          onClick={handleCheck}
          disabled={checking}
          title="Hỏi trực tiếp MoMo, không chờ webhook"
          className="w-full py-2.5 rounded-xl bg-gradient-to-r from-momo to-momo-dark text-white shadow-md shadow-momo/30 hover:shadow-lg hover:shadow-momo/40 hover:brightness-110 active:scale-[0.98] text-xs font-semibold transition disabled:opacity-50 mt-3"
        >
          {checking ? 'Đang hỏi MoMo...' : 'Kiểm tra ngay'}
        </button>
      )}
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
        className="w-full rounded-xl border border-neutral-200 px-4 py-3 mb-4 bg-white focus:outline-none focus:ring-4 focus:ring-momo/15 focus:border-momo transition-all duration-200"
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
  // Đọc cache trước — F5 xong có dropdown cửa hàng ngay lập tức, không phải
  // chờ /api/momo/stores trả về mới hiện. Vẫn fetch ngầm bên dưới để đồng
  // bộ nếu danh sách cửa hàng có thay đổi.
  const cached = loadCache(CACHE_KEY_STORES, { stores: [], storeId: '' })
  const [stores, setStores] = useState(Array.isArray(cached.stores) ? cached.stores : [])
  const [storeId, setStoreId] = useState(cached.storeId || '')

  useEffect(() => {
    fetch('/api/momo/stores', { credentials: 'include' })
      .then((res) => (res.ok ? res.json() : { stores: [] }))
      .then((data) => {
        const list = data.stores || []
        setStores(list)
        setStoreId((cur) => {
          if (cur && list.some((s) => s.id === cur)) return cur // vẫn còn hợp lệ -> giữ nguyên lựa chọn cũ
          const def = list.find((s) => s.default)
          return def ? def.id : cur
        })
      })
      .catch(() => {})
  }, [])

  // Lưu lại cache mỗi khi đổi để F5 lần sau đọc được ngay.
  useEffect(() => {
    saveCache(CACHE_KEY_STORES, { stores, storeId })
  }, [stores, storeId])

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
    <form onSubmit={handleSubmit} className="bg-white/90 backdrop-blur-sm rounded-2xl border border-neutral-200/70 shadow-[0_2px_10px_-4px_rgba(0,0,0,0.06),0_16px_40px_-20px_rgba(165,0,100,0.18)] hover:shadow-[0_4px_18px_-4px_rgba(0,0,0,0.08),0_24px_56px_-20px_rgba(165,0,100,0.24)] transition-shadow duration-300 p-6">
      <StoreSelect stores={stores} storeId={storeId} setStoreId={setStoreId} />

      <label className="block text-sm font-medium text-neutral-700 mb-1">Số tiền (₫)</label>
      <input
        type="number"
        inputMode="numeric"
        min={1000}
        value={amount}
        onChange={(e) => setAmount(e.target.value)}
        placeholder="Ví dụ: 50000"
        className="w-full rounded-xl border border-neutral-200 px-4 py-3 mb-4 font-mono focus:outline-none focus:ring-4 focus:ring-momo/15 focus:border-momo transition-all duration-200"
        required
      />

      <label className="block text-sm font-medium text-neutral-700 mb-1">Nội dung (tuỳ chọn)</label>
      <input
        type="text"
        value={orderInfo}
        onChange={(e) => setOrderInfo(e.target.value)}
        placeholder="Ví dụ: Thanh toán đơn hàng"
        className="w-full rounded-xl border border-neutral-200 px-4 py-3 mb-5 focus:outline-none focus:ring-4 focus:ring-momo/15 focus:border-momo transition-all duration-200"
      />

      {error && <p className="text-sm text-red-600 bg-red-50 rounded-lg px-3 py-2 mb-4">{error}</p>}

      <button
        type="submit"
        disabled={loading}
        className="w-full py-3.5 rounded-xl bg-gradient-to-r from-momo to-momo-dark text-white shadow-md shadow-momo/30 hover:shadow-lg hover:shadow-momo/40 hover:brightness-110 active:scale-[0.98] font-semibold transition disabled:opacity-50"
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
function OrdersPanel({ transactions, onRemove, onUpdate }) {
  return (
    <div className="bg-white/90 backdrop-blur-sm rounded-2xl border border-neutral-200/70 shadow-[0_2px_10px_-4px_rgba(0,0,0,0.06),0_16px_40px_-20px_rgba(165,0,100,0.18)] hover:shadow-[0_4px_18px_-4px_rgba(0,0,0,0.08),0_24px_56px_-20px_rgba(165,0,100,0.24)] transition-shadow duration-300 p-4 lg:sticky lg:top-6 lg:max-h-[calc(100vh-3rem)] lg:overflow-y-auto">
      <div className="flex items-center justify-between mb-3 px-1">
        <h2 className="text-sm font-semibold text-neutral-700">Đơn hàng đang mở</h2>
        <span className="text-xs font-mono text-neutral-400">{transactions.length}</span>
      </div>
      {transactions.length === 0 ? (
        <p className="text-sm text-neutral-400 text-center py-10">Chưa có đơn hàng nào</p>
      ) : (
        <div className="flex flex-col gap-3">
          {transactions.map((tx) => (
            <TransactionRow key={tx.orderId} tx={tx} onRemove={onRemove} onUpdate={onUpdate} />
          ))}
        </div>
      )}
    </div>
  )
}

// Bố cục 2 cột: trái là form tạo đơn, phải là danh sách đơn đang mở.
// State danh sách được giữ ở đây (không phải trong form) để cột phải
// luôn cập nhật ngay khi cột trái tạo đơn thành công.
function P2PSection({ stores, storeId, setStoreId }) {
  // Khôi phục lại danh sách đơn từ sessionStorage lúc mount — tránh mất
  // đơn đang mở khi lỡ tay bấm F5 reload trang.
  const [transactions, setTransactions] = useState(() => loadOrderCache(CACHE_KEY_P2P)) // cộng dồn, không giới hạn

  // Mỗi khi danh sách đổi (thêm/xóa đơn) thì lưu lại cache ngay.
  useEffect(() => {
    saveOrderCache(CACHE_KEY_P2P, transactions)
  }, [transactions])

  function handleCreated(tx) {
    // Thêm đơn MỚI vào đầu danh sách, KHÔNG xóa các đơn trước đó và
    // KHÔNG giới hạn số lượng.
    setTransactions((cur) => [tx, ...cur])
  }

  function handleRemove(orderId) {
    setTransactions((cur) => cur.filter((t) => t.orderId !== orderId))
  }

  // Ghi trạng thái mới nhất (PENDING/PAID/FAILED, đã check hay chưa...) của
  // từng đơn ngược lại vào danh sách -> tự lưu cache -> F5 lần sau đọc
  // được ngay, không phải chờ dò lại MoMo mới biết đơn đã xong hay chưa.
  function handleUpdate(orderId, patch) {
    setTransactions((cur) => cur.map((t) => (t.orderId === orderId ? { ...t, ...patch } : t)))
  }

  return (
    <div className="grid grid-cols-1 lg:grid-cols-[380px_1fr] gap-6 items-start">
      <P2POrderForm stores={stores} storeId={storeId} setStoreId={setStoreId} onCreated={handleCreated} />
      <OrdersPanel transactions={transactions} onRemove={handleRemove} onUpdate={handleUpdate} />
    </div>
  )
}

// Cột trái tab Scan — chỉ nhập số tiền rồi MỞ 1 "đơn chờ scan" mới ở
// cột phải (chưa gọi API vì chưa có mã). Cho phép mở liên tiếp nhiều
// đơn (ví dụ nhiều khách xếp hàng chờ quét).
function ScanOrderForm({ stores, storeId, setStoreId, onCreated }) {
  const [amount, setAmount] = useState('')

  function handleSubmit(e) {
    e.preventDefault()
    if (!amount) return
    onCreated({
      localId: `scan_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      amount: Number(amount),
      storeId,
      code: '',
      status: 'INPUT', // INPUT: chờ quét | PROCESSING | PAID | FAILED
      message: '',
    })
    setAmount('')
  }

  return (
    <form onSubmit={handleSubmit} className="bg-white/90 backdrop-blur-sm rounded-2xl border border-neutral-200/70 shadow-[0_2px_10px_-4px_rgba(0,0,0,0.06),0_16px_40px_-20px_rgba(165,0,100,0.18)] hover:shadow-[0_4px_18px_-4px_rgba(0,0,0,0.08),0_24px_56px_-20px_rgba(165,0,100,0.24)] transition-shadow duration-300 p-6">
      <StoreSelect stores={stores} storeId={storeId} setStoreId={setStoreId} />

      <label className="block text-sm font-medium text-neutral-700 mb-1">Số tiền (₫)</label>
      <input
        type="number"
        inputMode="numeric"
        min={1000}
        value={amount}
        onChange={(e) => setAmount(e.target.value)}
        placeholder="Ví dụ: 50000"
        className="w-full rounded-xl border border-neutral-200 px-4 py-3 mb-5 font-mono focus:outline-none focus:ring-4 focus:ring-momo/15 focus:border-momo transition-all duration-200"
        required
      />

      <button
        type="submit"
        className="w-full py-3.5 rounded-xl bg-gradient-to-r from-momo to-momo-dark text-white shadow-md shadow-momo/30 hover:shadow-lg hover:shadow-momo/40 hover:brightness-110 active:scale-[0.98] font-semibold transition"
      >
        Mở đơn chờ scan
      </button>
      <p className="text-[11px] text-neutral-400 text-center mt-3">
        Đơn sẽ hiện bên phải — chọn đơn (tô viền) rồi quét mã QR của khách vào ô nhập của đơn đó
      </p>
    </form>
  )
}

// 1 đơn chờ scan trong danh sách bên phải. Chỉ đơn ĐANG ĐƯỢC CHỌN mới
// mở khoá ô nhập mã (tránh máy quét gõ nhầm sang đơn khác khi đang mở
// nhiều đơn cùng lúc) — bấm vào thẻ để chọn, thẻ được chọn tô viền màu
// momo. Quét đủ 18 số hoặc bấm Enter sẽ tự gửi và có kết quả NGAY LẬP
// TỨC (không cần chờ poll như P2P).
function ScanOrderCard({ order, selected, onSelect, onRemove, onUpdate }) {
  const [confirmRemove, setConfirmRemove] = useState(false)
  const [showDetail, setShowDetail] = useState(false)
  const [cameraError, setCameraError] = useState('')
  const inputRef = useRef(null)
  // Camera tự động bật ngay khi đơn này đang được CHỌN và còn chờ quét —
  // không cần bấm nút mở nữa; tự tắt khi đổi sang đơn khác hoặc quét xong.
  const cameraActive = selected && order.status === 'INPUT'
  const videoRef = useRef(null)
  const streamRef = useRef(null)
  const rafRef = useRef(null)
  const canvasRef = useRef(null) // canvas ẩn dùng để đọc từng khung hình, không gắn vào DOM

  useEffect(() => {
    if (selected && order.status === 'INPUT' && inputRef.current) {
      inputRef.current.focus()
    }
  }, [selected, order.status])

  function stopCamera() {
    if (rafRef.current) {
      cancelAnimationFrame(rafRef.current)
      rafRef.current = null
    }
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((t) => t.stop())
      streamRef.current = null
    }
  }

  // Bật camera thật (getUserMedia) tự động ngay khi đơn đang được CHỌN và
  // còn ở trạng thái chờ quét — tắt/nhả camera ngay khi 1 trong 2 điều
  // kiện đó không còn đúng (đổi đơn khác, quét xong, hủy đơn...) để tránh
  // giữ camera chạy ngầm không cần thiết.
  //
  // Đọc mã QR bằng jsQR (giải mã trực tiếp trên canvas) thay vì
  // BarcodeDetector của trình duyệt — BarcodeDetector CHỈ có ở Chrome/
  // Edge trên Android & desktop, KHÔNG có ở Safari (iOS/macOS) và
  // Firefox. Trước đây dùng BarcodeDetector nên trên các trình duyệt đó
  // camera mở lên bình thường (xin quyền, có đèn báo) nhưng không bao
  // giờ nhận ra mã QR — đúng như tình trạng "đã cấp quyền camera nhưng
  // không quét được". jsQR chạy bằng JS thuần trên mọi trình duyệt nên
  // không còn phụ thuộc trình duyệt hỗ trợ hay không.
  useEffect(() => {
    if (!cameraActive) {
      stopCamera()
      return
    }

    let cancelled = false
    setCameraError('')

    function readQrFromFrame() {
      const video = videoRef.current
      if (!video || video.readyState < video.HAVE_CURRENT_DATA) return null
      const w = video.videoWidth
      const h = video.videoHeight
      if (!w || !h) return null
      const canvas = canvasRef.current || (canvasRef.current = document.createElement('canvas'))
      canvas.width = w
      canvas.height = h
      const ctx = canvas.getContext('2d', { willReadFrequently: true })
      ctx.drawImage(video, 0, 0, w, h)
      const imageData = ctx.getImageData(0, 0, w, h)
      return jsQR(imageData.data, w, h, { inversionAttempts: 'dontInvert' })
    }

    function scanLoop() {
      if (cancelled || !videoRef.current) return
      try {
        const result = readQrFromFrame()
        if (result && result.data) {
          const value = result.data
          cancelled = true
          onUpdate(order.localId, { code: value })
          submitCode(value)
          return
        }
      } catch {
        /* bỏ qua lỗi ở 1 khung hình, thử lại khung kế tiếp */
      }
      rafRef.current = requestAnimationFrame(scanLoop)
    }

    async function start() {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: 'environment' },
        })
        if (cancelled) {
          stream.getTracks().forEach((t) => t.stop())
          return
        }
        streamRef.current = stream
        if (videoRef.current) {
          videoRef.current.srcObject = stream
          await videoRef.current.play()
        }
        scanLoop()
      } catch {
        if (!cancelled) setCameraError('Không mở được camera — kiểm tra quyền truy cập camera của trình duyệt.')
      }
    }

    start()
    return () => {
      cancelled = true
      stopCamera()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cameraActive])

  async function submitCode(code) {
    const trimmed = String(code || '').trim()
    if (!trimmed || order.status !== 'INPUT') return
    // Chốt orderId NGAY từ đầu (không phát sinh lại mỗi lần) và LƯU vào
    // state của đơn — cần giữ lại để nút "Xem chi tiết" gọi /api/momo/query
    // sau khi có kết quả.
    const orderId = order.orderId || `POS${Date.now()}${Math.random().toString(36).slice(2, 6)}`
    onUpdate(order.localId, { status: 'PROCESSING', code: trimmed, orderId })
    try {
      const res = await fetch('/api/momo/create', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          mode: 'scan',
          amount: order.amount,
          paymentCode: trimmed,
          storeId: order.storeId,
          orderId,
        }),
      })
      if (res.status === 401) {
        window.location.reload()
        return
      }
      const data = await res.json()
      if (!res.ok) {
        onUpdate(order.localId, { status: 'FAILED', message: data.error || 'Không xử lý được giao dịch', orderId })
        return
      }
      onUpdate(order.localId, {
        status: data.resultCode === 0 ? 'PAID' : 'FAILED',
        message: data.resultCode === 0 ? '' : data.message || 'Giao dịch thất bại',
        transId: data.transId ? String(data.transId) : null,
        orderId,
      })
    } catch {
      onUpdate(order.localId, { status: 'FAILED', message: 'Lỗi kết nối, thử lại sau', orderId })
    }
  }

  function handleCodeChange(e) {
    const val = e.target.value
    onUpdate(order.localId, { code: val })
    const trimmed = val.trim()
    // Mã thanh toán thường đủ 18 số; một số máy quét/định dạng có thêm
    // tiền tố "MM" ở đầu thì đủ mã sẽ là 20 ký tự — tự nhận diện để biết
    // khi nào đã gõ/quét đủ mà auto-submit đúng lúc, không phải chờ Enter.
    const requiredLen = /^MM/i.test(trimmed) ? 20 : 18
    if (trimmed.length >= requiredLen) submitCode(val)
  }

  function handleKeyDown(e) {
    if (e.key === 'Enter') {
      e.preventDefault()
      submitCode(order.code)
    }
  }

  const badgeStyle =
    order.status === 'PAID'
      ? 'bg-emerald-50 text-emerald-700'
      : order.status === 'FAILED'
      ? 'bg-red-50 text-red-700'
      : order.status === 'PROCESSING'
      ? 'bg-amber-50 text-amber-700'
      : 'bg-neutral-100 text-neutral-600'
  const badgeText =
    order.status === 'PAID'
      ? 'Đã thu tiền'
      : order.status === 'FAILED'
      ? 'Thất bại'
      : order.status === 'PROCESSING'
      ? 'Đang xử lý...'
      : 'Chờ quét mã'

  // Cũng như bên P2P: đơn đã có KẾT QUẢ CUỐI CÙNG (đã thu tiền/thất bại)
  // thì nút X phải là "Đóng" (chỉ ẩn khỏi màn hình), không còn là "Hủy
  // đơn" nữa vì không còn gì để hủy — giao dịch đã xong rồi.
  const isFinal = order.status === 'PAID' || order.status === 'FAILED'

  return (
    <div
      onClick={() => order.status === 'INPUT' && onSelect(order.localId)}
      className={`bg-white/90 backdrop-blur-sm rounded-2xl border p-4 relative shadow-[0_2px_10px_-4px_rgba(0,0,0,0.06)] hover:shadow-[0_4px_18px_-4px_rgba(0,0,0,0.1)] hover:-translate-y-0.5 transition-all duration-300 ${
        order.status === 'INPUT' ? 'cursor-pointer' : ''
      } ${selected ? 'border-momo ring-2 ring-momo/30 shadow-[0_4px_18px_-4px_rgba(165,0,100,0.3)]' : 'border-neutral-200/70'}`}
    >
      <button
        onClick={(e) => {
          e.stopPropagation()
          setConfirmRemove(true)
        }}
        className="absolute top-3 right-3 text-neutral-300 hover:text-neutral-500 text-sm w-6 h-6 flex items-center justify-center"
        title={isFinal ? 'Đóng giao dịch' : 'Hủy đơn'}
      >
        ✕
      </button>

      <ConfirmModal
        open={confirmRemove}
        title={isFinal ? 'Đóng giao dịch này?' : 'Hủy đơn chờ scan này?'}
        description={
          isFinal
            ? 'Giao dịch đã có kết quả cuối cùng — đóng chỉ để ẩn khỏi danh sách trên màn hình này, không ảnh hưởng gì tới dữ liệu giao dịch đã ghi nhận.'
            : 'Đơn sẽ được ẩn khỏi danh sách trên màn hình này.'
        }
        confirmLabel={isFinal ? 'Đóng' : 'Hủy đơn'}
        onCancel={() => setConfirmRemove(false)}
        onConfirm={() => {
          setConfirmRemove(false)
          onRemove(order.localId)
        }}
      />

      <div className="flex items-center gap-3 pr-6">
        <div className="w-10 h-10 shrink-0 rounded-full bg-neutral-50 flex items-center justify-center text-base">
          {order.status === 'PAID' ? '✓' : order.status === 'FAILED' ? '✕' : order.status === 'PROCESSING' ? '…' : '▢'}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className={`inline-block text-[11px] font-semibold px-2.5 py-1 rounded-full shadow-sm ring-1 ring-inset ring-black/5 ${badgeStyle}`}>
              {badgeText}
            </span>
            {selected && order.status === 'INPUT' && (
              <span className="text-[11px] font-semibold text-momo">● Đang chọn</span>
            )}
          </div>
          <p className="font-mono font-extrabold text-lg text-neutral-900 leading-tight mt-0.5">
            {formatVND(order.amount)}
          </p>
        </div>
      </div>

      {order.status === 'INPUT' && (
        <>
          <input
            ref={inputRef}
            type="text"
            value={order.code}
            onChange={handleCodeChange}
            onKeyDown={handleKeyDown}
            onClick={(e) => e.stopPropagation()}
            disabled={!selected}
            placeholder={selected ? 'Quét/dán mã QR của khách (18-20 số)' : 'Bấm chọn đơn này để quét'}
            className="w-full rounded-xl border border-neutral-200 px-4 py-3 mt-3 font-mono focus:outline-none focus:ring-4 focus:ring-momo/15 focus:border-momo transition-all duration-200 disabled:bg-neutral-50 disabled:text-neutral-400"
          />

          {/* Camera vẫn tự bật/chạy ngầm 100% khi đơn này đang được chọn
              (để vòng lặp đọc từng khung hình bằng jsQR) — nhưng KHÔNG
              hiện khung hình camera lên giao diện nữa, video được ẩn đi
              (không dùng display:none vì 1 số trình duyệt sẽ ngừng decode
              khung hình của video ẩn kiểu đó, ảnh hưởng việc quét). */}
          <video
            ref={videoRef}
            className="absolute w-px h-px opacity-0 overflow-hidden pointer-events-none -z-10"
            muted
            playsInline
          />
          {cameraError && (
            <p className="text-xs text-red-600 bg-red-50 rounded-lg px-3 py-2 mt-2">{cameraError}</p>
          )}
        </>
      )}

      {order.status === 'FAILED' && order.message && (
        <p className="text-sm text-red-600 bg-red-50 rounded-lg px-3 py-2 mt-3">{order.message}</p>
      )}
      {order.status === 'PAID' && (
        <div className="mt-3">
          <p className="text-sm text-emerald-700 bg-emerald-50 rounded-lg px-3 py-2 text-center font-semibold">
            ✓ Thu tiền thành công
          </p>
          <div className="flex flex-col gap-1 text-[12px] text-neutral-500 mt-2 px-1">
            {order.orderId && (
              <div className="flex items-center justify-between gap-2">
                <span>Mã đơn</span>
                <span className="font-mono text-neutral-700 truncate">{order.orderId}</span>
              </div>
            )}
            {order.transId && (
              <div className="flex items-center justify-between gap-2">
                <span>Mã GD MoMo</span>
                <span className="font-mono text-neutral-700 truncate">{order.transId}</span>
              </div>
            )}
          </div>
          <button
            type="button"
            onClick={() => setShowDetail(true)}
            className="w-full py-2.5 rounded-xl border border-emerald-200 text-emerald-700 text-xs font-semibold hover:bg-emerald-50 transition mt-2"
          >
            Xem chi tiết giao dịch
          </button>
        </div>
      )}
      <OrderDetailModal open={showDetail} onClose={() => setShowDetail(false)} orderId={order.orderId} />
    </div>
  )
}

// Cột phải tab Scan — danh sách các đơn chờ scan, có thể mở nhiều đơn
// cùng lúc; đơn đang được chọn tô viền để dễ nhận biết đang quét đơn nào.
function ScanOrdersPanel({ orders, selectedId, onSelect, onRemove, onUpdate }) {
  return (
    <div className="bg-white/90 backdrop-blur-sm rounded-2xl border border-neutral-200/70 shadow-[0_2px_10px_-4px_rgba(0,0,0,0.06),0_16px_40px_-20px_rgba(165,0,100,0.18)] hover:shadow-[0_4px_18px_-4px_rgba(0,0,0,0.08),0_24px_56px_-20px_rgba(165,0,100,0.24)] transition-shadow duration-300 p-4 lg:sticky lg:top-6 lg:max-h-[calc(100vh-3rem)] lg:overflow-y-auto">
      <div className="flex items-center justify-between mb-3 px-1">
        <h2 className="text-sm font-semibold text-neutral-700">Đơn chờ scan</h2>
        <span className="text-xs font-mono text-neutral-400">{orders.length}</span>
      </div>
      {orders.length === 0 ? (
        <p className="text-sm text-neutral-400 text-center py-10">
          Chưa có đơn nào — nhập số tiền bên trái để mở đơn chờ quét
        </p>
      ) : (
        <div className="flex flex-col gap-3">
          {orders.map((o) => (
            <ScanOrderCard
              key={o.localId}
              order={o}
              selected={o.localId === selectedId}
              onSelect={onSelect}
              onRemove={onRemove}
              onUpdate={onUpdate}
            />
          ))}
        </div>
      )}
    </div>
  )
}

// Bố cục 2 cột giống hệt P2PSection: trái là form mở đơn chờ scan,
// phải là danh sách các đơn đang chờ/đang xử lý. State giữ ở đây nên
// vẫn còn nguyên khi tab này bị ẩn đi (xem TaoGiaoDich bên dưới).
function ScanSection({ stores, storeId, setStoreId }) {
  // Khôi phục lại danh sách đơn chờ scan từ sessionStorage lúc mount —
  // tránh mất đơn khi lỡ tay bấm F5. Đơn nào đang dở "Đang xử lý..." lúc
  // bị reload (kết quả submit chưa kịp về) thì đưa lại về trạng thái chờ
  // quét để không bị kẹt mãi.
  const [orders, setOrders] = useState(() =>
    loadOrderCache(CACHE_KEY_SCAN).map((o) => (o.status === 'PROCESSING' ? { ...o, status: 'INPUT' } : o))
  )
  const [selectedId, setSelectedId] = useState(() => {
    const restored = loadOrderCache(CACHE_KEY_SCAN)
    const firstPending = restored.find((o) => o.status === 'INPUT')
    return firstPending ? firstPending.localId : null
  })

  // Mỗi khi danh sách đổi thì lưu lại cache ngay.
  useEffect(() => {
    saveOrderCache(CACHE_KEY_SCAN, orders)
  }, [orders])

  function handleCreated(order) {
    setOrders((cur) => [order, ...cur])
    setSelectedId(order.localId) // đơn mới mở -> tự chọn luôn để quét ngay
  }

  function handleRemove(localId) {
    setOrders((cur) => cur.filter((o) => o.localId !== localId))
    setSelectedId((cur) => (cur === localId ? null : cur))
  }

  function handleUpdate(localId, patch) {
    setOrders((cur) => cur.map((o) => (o.localId === localId ? { ...o, ...patch } : o)))
  }

  return (
    <div className="grid grid-cols-1 lg:grid-cols-[380px_1fr] gap-6 items-start">
      <ScanOrderForm stores={stores} storeId={storeId} setStoreId={setStoreId} onCreated={handleCreated} />
      <ScanOrdersPanel
        orders={orders}
        selectedId={selectedId}
        onSelect={setSelectedId}
        onRemove={handleRemove}
        onUpdate={handleUpdate}
      />
    </div>
  )
}

// Nút "Tạm dừng toàn bộ hệ thống" — gọi POST /api/momo/system-pause.
// Sau khi tạm dừng thành công, CHÍNH trang admin đang đứng đây cũng sẽ bị
// middleware chặn ngay từ request kế tiếp (xem middleware.js) — nên chỉ
// cần reload lại trang, nó tự động bị đá về màn đăng nhập giống mọi trang
// khác, không cần code thêm logic điều hướng riêng ở đây.
function PauseSystemButton() {
  const [confirmOpen, setConfirmOpen] = useState(false)
  const [pausing, setPausing] = useState(false)
  const [error, setError] = useState('')

  async function handlePause() {
    setPausing(true)
    setError('')
    try {
      const res = await fetch('/api/momo/system-pause', { method: 'POST', credentials: 'include' })
      const data = await res.json()
      if (!res.ok) {
        setError(data.error || 'Không tạm dừng được, thử lại sau')
        setPausing(false)
        return
      }
      window.location.reload()
    } catch {
      setError('Lỗi kết nối, thử lại sau')
      setPausing(false)
    }
  }

  return (
    <div className="flex flex-col items-end">
      <button
        type="button"
        onClick={() => setConfirmOpen(true)}
        title="Tạm dừng toàn bộ hệ thống để tiết kiệm tài nguyên"
        className="text-sm text-neutral-500 hover:text-red-600 transition"
      >
        ⏸ Tạm dừng hệ thống
      </button>
      {error && <p className="text-[11px] text-red-600 mt-0.5">{error}</p>}

      <ConfirmModal
        open={confirmOpen}
        title="Tạm dừng toàn bộ hệ thống?"
        description="Trang khách (thanh toán) và mọi thao tác admin — kể cả chính bạn — sẽ bị chặn hết ngay lập tức. Chỉ hoạt động lại khi có ai đăng nhập admin lần nữa."
        confirmLabel={pausing ? 'Đang tạm dừng...' : 'Tạm dừng ngay'}
        onCancel={() => setConfirmOpen(false)}
        onConfirm={() => {
          setConfirmOpen(false)
          handlePause()
        }}
      />
    </div>
  )
}

export default function TaoGiaoDich() {
  // Khôi phục lại tab đang xem từ cache — F5 xong vẫn ở đúng tab vừa
  // đứng, không bị nhảy về P2P mặc định.
  const [tab, setTab] = useState(() => {
    const cached = loadCache(CACHE_KEY_TAB, 'p2p')
    return cached === 'scan' ? 'scan' : 'p2p'
  })
  useEffect(() => {
    saveCache(CACHE_KEY_TAB, tab)
  }, [tab])
  // Gọi 1 lần duy nhất, dùng chung cho cả 2 tab — vừa đỡ fetch trùng
  // /api/momo/stores, vừa giữ cửa hàng đang chọn đồng bộ khi đổi tab.
  const { stores, storeId, setStoreId } = useStores()

  return (
    <>
      {/* Nền gradient loang nhẹ nhàng, nhiều màu pastel sáng (thay cho nền
          1 màu hồng đậm gắt trước đây) — 5 mảng màu (hồng đào, vàng kem,
          xanh biển nhạt, xanh mint, tím lavender) chuyển động chậm rãi,
          hoà vào nhau như mực loang trên nước. Card nội dung vẫn nền sáng
          để dễ đọc, chỉ NỀN NGOÀI CÙNG là gradient động. */}
      <style>{`
        @keyframes momoFlow {
          0%   { background-position: 0% 50%, 100% 0%, 50% 100%, 20% 20%, 80% 80%; }
          50%  { background-position: 100% 50%, 0% 100%, 50% 0%, 80% 80%, 20% 20%; }
          100% { background-position: 0% 50%, 100% 0%, 50% 100%, 20% 20%, 80% 80%; }
        }
        .momo-flow-bg {
          background-color: #fdf7f4;
          background-image:
            radial-gradient(circle at center, rgba(255, 197, 210, 0.75), transparent 60%),
            radial-gradient(circle at center, rgba(255, 232, 178, 0.7), transparent 60%),
            radial-gradient(circle at center, rgba(186, 222, 255, 0.7), transparent 60%),
            radial-gradient(circle at center, rgba(191, 240, 217, 0.7), transparent 60%),
            radial-gradient(circle at center, rgba(222, 205, 255, 0.7), transparent 60%);
          background-size: 130% 130%, 140% 140%, 150% 150%, 120% 120%, 135% 135%;
          background-repeat: no-repeat;
          animation: momoFlow 22s ease-in-out infinite;
        }
      `}</style>
      <main className="momo-flow-bg min-h-screen px-4 py-10 relative overflow-hidden">
        {/* Khung ngoài LUÔN 1 kích thước (max-w-5xl) bất kể đang ở tab nào
            — đổi tab không còn làm layout đổi bề rộng/giật hình nữa. */}
        <div className="max-w-5xl mx-auto relative z-10">
          <div className="flex items-center justify-between mb-6">
            <h1 className="text-xl font-extrabold text-neutral-800">Tạo giao dịch</h1>
            <Link href="/" className="text-sm text-neutral-500 hover:text-neutral-800 transition">
              ← Trang chủ
            </Link>
          </div>

          <div className="flex gap-2 mb-6 bg-white/60 backdrop-blur-md rounded-xl p-1 max-w-sm w-full shadow-lg ring-1 ring-black/5">
            {TABS.map((t) => (
              <button
                key={t.key}
                onClick={() => setTab(t.key)}
                className={`flex-1 py-2 rounded-lg text-sm font-semibold transition ${
                  tab === t.key
                    ? 'bg-white text-momo-dark shadow-md'
                    : 'text-neutral-500 hover:text-neutral-800 hover:bg-white/40'
                }`}
              >
                {t.label}
              </button>
            ))}
          </div>

          {/* Cả 2 tab LUÔN được mount sẵn, chỉ ẩn/hiện bằng class "hidden"
              — không conditional-render nữa nên đơn hàng/đơn chờ scan
              đang mở không bị mất khi bấm qua bấm lại giữa 2 tab. */}
          <div className={tab === 'p2p' ? '' : 'hidden'}>
            <P2PSection stores={stores} storeId={storeId} setStoreId={setStoreId} />
          </div>
          <div className={tab === 'scan' ? '' : 'hidden'}>
            <ScanSection stores={stores} storeId={storeId} setStoreId={setStoreId} />
          </div>
        </div>
      </main>
    </>
  )
}