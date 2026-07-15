// pages/tao-giao-dich.js
//
// Trang tạo giao dịch, gồm 2 chế độ (tab):
// - P2P: nhập số tiền + nội dung -> POST /api/momo/create (mode=p2p)
//   -> hiển thị QR để khách tự quét bằng app MoMo.
// - Quét mã khách (POS): nhân viên quét mã QR MoMo của khách (18 số)
//   -> nhập số tiền -> POST /api/momo/create (mode=scan) -> trừ tiền
//   trực tiếp từ ví khách. (Trước đây tính năng này nằm ở trang Quản
//   lý giao dịch, giờ gộp về đây cho đúng luồng "tạo giao dịch".)
//
// Không xử lý đăng nhập ở đây — pages/_app.js đã chặn ở tầng toàn
// cục. Nếu session hết hạn giữa chừng, route trả 401 -> reload để
// gate toàn cục bắt lại.

import { useState } from 'react'
import Link from 'next/link'

const TABS = [
  { key: 'p2p', label: 'Tạo mã QR (P2P)' },
  { key: 'scan', label: 'Quét mã khách (POS)' },
]

function P2PForm() {
  const [amount, setAmount] = useState('')
  const [orderInfo, setOrderInfo] = useState('')
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
        body: JSON.stringify({ mode: 'p2p', amount, orderInfo }),
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
      setResult(data)
    } catch {
      setError('Lỗi kết nối, thử lại sau')
    } finally {
      setLoading(false)
    }
  }

  function reset() {
    setResult(null)
    setAmount('')
    setOrderInfo('')
  }

  if (result) {
    return (
      <div className="bg-white rounded-2xl border border-neutral-200 p-6 text-center">
        <p className="text-sm text-neutral-500 mb-1">Số tiền</p>
        <p className="text-2xl font-extrabold font-mono text-neutral-900 mb-4">
          {Number(amount).toLocaleString('vi-VN')} đ
        </p>

        {result.payUrl && (
          <a
            href={result.payUrl}
            target="_blank"
            rel="noreferrer"
            className="block w-full py-3 rounded-xl bg-momo text-white text-sm font-semibold hover:bg-momo-dark transition mb-4"
          >
            Mở trang thanh toán MoMo
          </a>
        )}

        {result.qrCodeImage && (
          <>
            <img
              src={result.qrCodeImage}
              alt="Mã QR mở trang thanh toán MoMo"
              className="w-48 h-48 mx-auto rounded-xl border border-neutral-100 mb-2"
            />
            <p className="text-xs text-amber-600 bg-amber-50 rounded-lg px-3 py-2 mb-4">
              ⚠ Mã này chỉ để quét mở trang thanh toán trên điện thoại khác — không phải mã quét thanh toán trực tiếp bằng app ngân hàng/MoMo (do tài khoản merchant chưa được MoMo cấp deeplink thật).
            </p>
          </>
        )}

        <p className="text-xs text-neutral-400 mb-5">
          Mã đơn: <span className="font-mono">{result.orderId}</span>
        </p>

        <button
          onClick={reset}
          className="w-full py-3 rounded-xl bg-neutral-900 text-white text-sm font-semibold hover:bg-neutral-700 transition"
        >
          Tạo giao dịch mới
        </button>
      </div>
    )
  }

  return (
    <form onSubmit={handleSubmit} className="bg-white rounded-2xl border border-neutral-200 p-6">
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
    </form>
  )
}

function ScanForm() {
  const [amount, setAmount] = useState('')
  const [code, setCode] = useState('')
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
      <div className="max-w-sm mx-auto">
        <div className="flex items-center justify-between mb-6">
          <h1 className="text-xl font-extrabold text-neutral-900">Tạo giao dịch</h1>
          <Link href="/" className="text-sm text-neutral-500 hover:text-neutral-800">
            ← Trang chủ
          </Link>
        </div>

        <div className="flex gap-2 mb-4 bg-neutral-100 rounded-xl p-1">
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

        {tab === 'p2p' ? <P2PForm /> : <ScanForm />}
      </div>
    </main>
  )
}