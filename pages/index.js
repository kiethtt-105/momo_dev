// pages/index.js
//
// VIẾT LẠI HOÀN TOÀN — bỏ hẳn phần "lịch sử giao dịch gần đây" / tab danh
// sách giao dịch (đã có trang riêng /quan-ly-giao-dich lo việc đó rồi, để
// ở đây bị trùng). Trang này giờ chỉ là 1 dashboard TỔNG QUAN gọn + màn
// hình khoá khi hệ thống đang tạm dừng.
//
// LUỒNG PAUSE: kiểm tra trạng thái hệ thống (/api/admin/system-pause) TRƯỚC
// TIÊN. Nếu đang paused -> KHOÁ TOÀN BỘ trang, không gọi thêm bất kỳ API
// nào khác (kể cả /api/momo/orders — vốn cũng sẽ bị middleware.js chặn
// 503 luôn rồi), không hiện link "Tạo giao dịch"/"Quản lý giao dịch", chỉ
// còn duy nhất 1 nút "Bật lại hệ thống". Chỉ khi hệ thống KHÔNG paused mới
// tải số liệu và hiện dashboard bình thường.
import { useEffect, useMemo, useState } from 'react'
import Head from 'next/head'
import Link from 'next/link'

const currency = new Intl.NumberFormat('vi-VN', { style: 'currency', currency: 'VND', maximumFractionDigits: 0 })
const WEEKDAY_LABELS = ['CN', 'T2', 'T3', 'T4', 'T5', 'T6', 'T7']
const CARD_SHADOW = 'shadow-[0_1px_2px_rgba(33,26,29,0.04),0_6px_16px_-10px_rgba(33,26,29,0.15)]'

// Key dùng để gọi /api/admin/system-pause — route đó CỐ Ý không check session
// admin, chỉ check key này (xem giải thích trong pages/api/admin/system-pause.js).
const SYSTEM_PAUSE_KEY = process.env.NEXT_PUBLIC_SYSTEM_PAUSE_KEY

function isSameDay(a, b) {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate()
}

function isToday(iso) {
  if (!iso) return false
  return isSameDay(new Date(iso), new Date())
}

// Doanh thu 7 ngày gần nhất (chỉ tính đơn PAID), dùng cho biểu đồ cột nhỏ.
function last7Days(orders) {
  const now = new Date()
  const days = []
  for (let i = 6; i >= 0; i--) {
    const d = new Date(now)
    d.setDate(d.getDate() - i)
    days.push(d)
  }
  return days.map((d) => {
    const revenue = orders
      .filter((o) => o.status === 'PAID' && isSameDay(new Date(o.createdAt), d))
      .reduce((sum, o) => sum + (parseInt(o.amount) || 0), 0)
    return { label: WEEKDAY_LABELS[d.getDay()], revenue, isToday: isSameDay(d, now) }
  })
}

function Spinner({ className = '' }) {
  return (
    <span
      className={`inline-block rounded-full border-2 border-white/20 border-t-white animate-spin [animation-duration:0.7s] ${className}`}
      aria-hidden="true"
    />
  )
}

function StatCard({ label, value, accent }) {
  return (
    <div className={`rounded-2xl bg-white px-5 py-4 ${CARD_SHADOW}`}>
      <p className="text-[11px] font-medium uppercase tracking-wide text-stone-400 mb-1.5">{label}</p>
      <p className={`text-2xl font-extrabold tabular-nums ${accent === 'amber' ? 'text-amber-600' : 'text-stone-900'}`}>
        {value}
      </p>
    </div>
  )
}

// Thẻ điều hướng lớn — 2 hành động chính của cả hệ thống, thay cho danh
// sách giao dịch đã bỏ (trang /quan-ly-giao-dich đã lo việc xem lịch sử).
function ActionCard({ href, title, desc, icon }) {
  return (
    <Link
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className={`group flex items-start gap-4 rounded-2xl bg-white px-5 py-5 ${CARD_SHADOW} hover:shadow-[0_1px_2px_rgba(33,26,29,0.04),0_10px_24px_-10px_rgba(165,0,100,0.35)] transition-shadow`}
    >
      <div className="shrink-0 w-11 h-11 rounded-xl bg-momo/10 flex items-center justify-center text-xl group-hover:bg-momo/15 transition-colors">
        {icon}
      </div>
      <div className="min-w-0">
        <p className="font-bold text-stone-900 mb-0.5">{title}</p>
        <p className="text-sm text-stone-400">{desc}</p>
      </div>
    </Link>
  )
}

// Chip trạng thái hệ thống gọn + nút dừng — đặt ngay trên header, luôn dễ
// thấy vì đây là hành động nhạy cảm nhất trang.
function SystemStatusChip({ paused, busy, onPause }) {
  return (
    <button
      onClick={onPause}
      disabled={busy}
      title="Dừng toàn bộ hệ thống"
      className="flex items-center gap-2 rounded-full bg-white pl-3 pr-4 py-2 text-xs font-semibold text-stone-600 hover:bg-rose-50 hover:text-rose-600 transition disabled:opacity-50 shadow-[0_1px_2px_rgba(33,26,29,0.04),0_6px_16px_-10px_rgba(33,26,29,0.15)]"
    >
      <span className="w-1.5 h-1.5 rounded-full bg-emerald-500" />
      Đang hoạt động
    </button>
  )
}

// Màn hình KHOÁ TOÀN TRANG khi hệ thống đang tạm dừng — cố ý không hiện
// bất kỳ số liệu, link điều hướng nào khác ngoài nút bật lại, đúng yêu
// cầu "không thao tác được bất cứ cái gì trừ việc bật server".
function PausedScreen({ meta, onResume, busy }) {
  return (
    <>
      <Head>
        <title>Hệ thống đang tạm dừng · Momo Dev</title>
      </Head>
      <main className="min-h-screen bg-stone-950 flex items-center justify-center px-4">
        <div className="w-full max-w-sm text-center">
          <div className="w-16 h-16 rounded-3xl bg-rose-500/10 mx-auto mb-6 flex items-center justify-center">
            <span className="w-3 h-3 rounded-full bg-rose-500 animate-pulse" />
          </div>
          <h1 className="text-xl font-extrabold text-white mb-2">Hệ thống đang tạm dừng</h1>
          <p className="text-stone-400 text-sm leading-relaxed mb-1">
            Toàn bộ API đang bị chặn — không tạo đơn, kiểm tra giao dịch hay xem lịch sử được cho tới khi bật lại.
          </p>
          {meta?.pausedAt && (
            <p className="text-stone-600 text-xs mb-8">
              Tạm dừng lúc {new Date(meta.pausedAt).toLocaleString('vi-VN')}
              {meta.reason ? ` · ${meta.reason}` : ''}
            </p>
          )}
          {!meta?.pausedAt && <div className="mb-8" />}
          <button
            onClick={onResume}
            disabled={busy}
            className="w-full py-3.5 rounded-xl bg-emerald-500 text-white text-sm font-semibold hover:bg-emerald-600 active:scale-[0.98] transition disabled:opacity-50 flex items-center justify-center gap-2"
          >
            {busy && <Spinner className="w-4 h-4 border-[2.5px]" />}
            {busy ? 'Đang bật lại...' : 'Bật lại hệ thống'}
          </button>
        </div>
      </main>
    </>
  )
}

export default function Home() {
  // null = chưa biết (đang hỏi /api/admin/system-pause) — KHÔNG được coi
  // mặc định là "đang chạy" trong lúc chờ, vì nếu thật sự đang paused mà
  // lỡ hiện dashboard ra 1 nhịp rồi mới khoá lại thì phản tác dụng.
  const [pauseState, setPauseState] = useState(null)
  const [resuming, setResuming] = useState(false)
  const [pausing, setPausing] = useState(false)

  const [orders, setOrders] = useState(null)
  const [error, setError] = useState(null)

  // 1) LUÔN kiểm tra trạng thái hệ thống trước tiên.
  useEffect(() => {
    let cancelled = false
    fetch(`/api/admin/system-pause?key=${encodeURIComponent(SYSTEM_PAUSE_KEY || '')}`)
      .then((res) => res.json())
      .then((data) => { if (!cancelled) setPauseState(data) })
      .catch(() => { if (!cancelled) setPauseState({ paused: false }) })
    return () => { cancelled = true }
  }, [])

  // 2) CHỈ tải danh sách giao dịch khi đã xác định chắc chắn KHÔNG paused —
  //    paused thì không gọi thêm bất kỳ API nào khác nữa.
  useEffect(() => {
    if (!pauseState || pauseState.paused) return
    let cancelled = false
    fetch('/api/momo/orders')
      .then((res) => {
        if (!res.ok) throw new Error('Không tải được dữ liệu')
        return res.json()
      })
      .then((data) => { if (!cancelled) setOrders(data.orders || []) })
      .catch((err) => { if (!cancelled) setError(err.message) })
    return () => { cancelled = true }
  }, [pauseState])

  async function callSystemPause(action) {
    const res = await fetch('/api/admin/system-pause', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': SYSTEM_PAUSE_KEY || '' },
      body: JSON.stringify({ action }),
    })
    const data = await res.json()
    if (res.ok) setPauseState(data)
    else window.alert(data.error || 'Không đổi được trạng thái hệ thống.')
  }

  async function handleResume() {
    setResuming(true)
    try {
      await callSystemPause('off')
    } finally {
      setResuming(false)
    }
  }

  async function handlePause() {
    const ok = window.confirm(
      'Dừng TOÀN BỘ hệ thống? Mọi API sẽ ngừng phục vụ ngay lập tức (không ai tạo/kiểm tra được giao dịch nào, kể cả bạn) cho tới khi vào lại đây bật lên.'
    )
    if (!ok) return
    setPausing(true)
    try {
      await callSystemPause('on')
    } finally {
      setPausing(false)
    }
  }

  const chartDays = useMemo(() => last7Days(orders || []), [orders])

  // Đang hỏi trạng thái hệ thống — chưa biết paused hay không thì chưa hiện
  // gì cả (tránh nháy dashboard rồi khoá lại ngay sau đó).
  if (pauseState === null) {
    return (
      <main className="min-h-screen bg-stone-950 flex items-center justify-center">
        <Spinner className="w-8 h-8 border-[3px]" />
      </main>
    )
  }

  if (pauseState.paused) {
    return <PausedScreen meta={pauseState} onResume={handleResume} busy={resuming} />
  }

  const today = (orders || []).filter((o) => isToday(o.createdAt))
  const todayPaid = today.filter((o) => o.status === 'PAID')
  const todayPending = today.filter((o) => o.status === 'PENDING')
  const todayRevenue = todayPaid.reduce((sum, o) => sum + (parseInt(o.amount) || 0), 0)
  const todayDecided = today.filter((o) => o.status === 'PAID' || o.status === 'FAILED')
  const successRate = todayDecided.length ? Math.round((todayPaid.length / todayDecided.length) * 100) : null
  const chartMax = Math.max(...chartDays.map((d) => d.revenue), 1)

  return (
    <>
      <Head>
        <title>Momo Dev</title>
        <meta name="description" content="Cổng thanh toán MoMo" />
        {/* Logo ứng dụng — file đặt sẵn tại public/main.jpg */}
        <link rel="icon" href="/main.jpg" />
      </Head>

      <main className="min-h-screen bg-[#FAF7F5] px-4 py-8 sm:px-8 sm:py-10">
        <div className="max-w-3xl mx-auto">
          {/* Header */}
          <div className="flex items-center justify-between gap-3 mb-8">
            <div className="flex items-center gap-3">
              <img
                src="/main.jpg"
                alt="Momo Dev"
                className="w-11 h-11 shrink-0 rounded-2xl object-cover shadow-[0_6px_16px_-6px_rgba(165,0,100,0.55)]"
              />
              <div>
                <h1 className="text-lg font-extrabold leading-tight tracking-tight text-stone-900">Momo Dev</h1>
                <p className="text-stone-400 text-xs">
                  {new Date().toLocaleDateString('vi-VN', { weekday: 'long', day: '2-digit', month: '2-digit', year: 'numeric' })}
                </p>
              </div>
            </div>
            <SystemStatusChip paused={false} busy={pausing} onPause={handlePause} />
          </div>

          {error && (
            <div className="mb-6 rounded-xl bg-rose-50 px-4 py-3 text-sm text-rose-700">
              {error} — thử tải lại trang.
            </div>
          )}

          {/* Số liệu hôm nay */}
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mb-3">
            <StatCard label="Doanh thu hôm nay" value={orders === null ? '—' : currency.format(todayRevenue)} />
            <StatCard
              label="Đang chờ"
              value={orders === null ? '—' : todayPending.length}
              accent={todayPending.length > 0 ? 'amber' : undefined}
            />
            <StatCard label="Tỷ lệ thành công" value={orders === null ? '—' : successRate === null ? '—' : `${successRate}%`} />
          </div>

          {/* Biểu đồ doanh thu 7 ngày */}
          <div className={`rounded-2xl bg-white px-6 py-6 mb-8 ${CARD_SHADOW}`}>
            <p className="text-sm font-semibold text-stone-900 mb-5">Doanh thu 7 ngày qua</p>
            {orders === null ? (
              <div className="flex items-end gap-2 h-28">
                {[...Array(7)].map((_, i) => (
                  <div key={i} className="flex-1 h-full rounded-t-md bg-stone-100 animate-pulse" />
                ))}
              </div>
            ) : (
              <div className="flex items-end gap-2 h-28">
                {chartDays.map((d, i) => (
                  <div key={i} className="flex-1 flex flex-col items-center gap-1.5 h-full">
                    <div className="w-full flex-1 rounded-t-md bg-stone-100 flex flex-col-reverse overflow-hidden">
                      <div
                        className={`w-full rounded-t-md transition-all ${d.isToday ? 'bg-momo' : 'bg-stone-300'}`}
                        style={{ height: `${Math.max(4, Math.round((d.revenue / chartMax) * 100))}%` }}
                      />
                    </div>
                    <span className={`text-[10px] font-medium ${d.isToday ? 'text-momo' : 'text-stone-400'}`}>{d.label}</span>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* 2 hành động chính */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <ActionCard href="/tao-giao-dich" title="Tạo giao dịch" desc="Tạo mã QR P2P hoặc quét mã khách (POS)" icon="+" />
            <ActionCard href="/quan-ly-giao-dich" title="Quản lý giao dịch" desc="Xem, lọc và tìm toàn bộ lịch sử giao dịch" icon="≡" />
          </div>
        </div>
      </main>
    </>
  )
}