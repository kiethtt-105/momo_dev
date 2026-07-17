// pages/result.js
//
// Trang MoMo TỰ ĐỘNG chuyển khách về sau khi thanh toán xong — khớp với
// redirectUrl = `${BASE_URL}/result` đã set sẵn trong lib/momo.js
// (createMoMoPayment). Route này KHÔNG cần đăng nhập admin.
//
// Trang này KHÔNG tự hiển thị kết quả nữa — chỉ lấy orderId từ query MoMo
// gắn vào rồi CHUYỂN THẲNG sang /thanh-toan?orderId=... (dùng router.replace
// để khách bấm back không bị kẹt lại ở /result). Lý do: /thanh-toan đã có
// sẵn đầy đủ logic tra trạng thái thật từ server + tự poll + cache — làm
// lại y hệt ở đây là trùng lặp, tách 2 nơi dễ lệch nhau khi sửa sau này.
//
// LƯU Ý BẢO MẬT: MoMo có gắn kèm resultCode/message/amount... vào query
// string khi redirect, nhưng KHÔNG tin trực tiếp các giá trị đó (khách có
// thể tự sửa URL, vd ?resultCode=0 giả) — nên KHÔNG chuyển tiếp các query
// này sang /thanh-toan, chỉ chuyển orderId. Trạng thái thật do /thanh-toan
// tự tra lại từ server (đã xác minh chữ ký MoMo ở ipn.js).

import { useEffect } from 'react'
import { useRouter } from 'next/router'
import Head from 'next/head'

function Spinner({ className = '' }) {
  return (
    <span
      className={`inline-block rounded-full border-2 border-stone-200/60 border-t-momo animate-spin [animation-duration:0.7s] [animation-timing-function:cubic-bezier(0.4,0,0.2,1)] ${className}`}
      aria-hidden="true"
    />
  )
}

export default function Result() {
  const router = useRouter()
  // router.query chỉ có dữ liệu THẬT sau khi router.isReady — chưa ready
  // thì orderId luôn undefined, phải chờ chứ không được kết luận "thiếu".
  const { orderId } = router.query

  useEffect(() => {
    if (!router.isReady) return
    if (!orderId) return
    router.replace(`/thanh-toan?orderId=${encodeURIComponent(orderId)}`)
  }, [router.isReady, orderId, router])

  const missingOrderId = router.isReady && !orderId

  return (
    <>
      <Head>
        <title>Đang chuyển hướng · Momo Dev</title>
      </Head>
      <main className="min-h-screen bg-[#FAF7F5] flex items-center justify-center px-4">
        <div className="flex flex-col items-center gap-3 text-center">
          {missingOrderId ? (
            <p className="text-stone-400 text-sm">Thiếu mã đơn hàng trong đường dẫn.</p>
          ) : (
            <>
              <Spinner className="w-7 h-7 border-[3px]" />
              <p className="text-stone-400 text-sm">Đang chuyển đến trang thanh toán...</p>
            </>
          )}
        </div>
      </main>
    </>
  )
}