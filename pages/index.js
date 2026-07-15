// pages/index.js
//
// Trang chủ. Không tự xử lý đăng nhập nữa — pages/_app.js đã chặn
// truy cập ở tầng toàn cục, tới được đây nghĩa là đã có session admin.
import Head from 'next/head'
import Link from 'next/link'

export default function Home() {
  return (
    <>
      <Head>
        <title>Momo Dev</title>
        <meta name="description" content="Cổng thanh toán MoMo" />
      </Head>

      <main className="min-h-screen flex items-center justify-center px-4 bg-neutral-50">
        <div className="w-full max-w-sm text-center">
          <div className="w-14 h-14 rounded-2xl bg-momo mx-auto mb-5 flex items-center justify-center text-white font-extrabold text-xl">
            M
          </div>

          <h1 className="text-2xl font-extrabold text-neutral-900 mb-1">Momo Dev</h1>
          <p className="text-neutral-500 text-sm mb-8">Chọn một chức năng để bắt đầu</p>

          <div className="flex flex-col gap-3">
            <Link
              href="/tao-giao-dich"
              className="w-full py-3.5 rounded-xl bg-momo text-white font-semibold hover:bg-momo-dark transition"
            >
              Tạo giao dịch
            </Link>

            <Link
              href="/quan-ly-giao-dich"
              className="w-full py-3.5 rounded-xl bg-white border border-neutral-200 text-neutral-800 font-semibold hover:bg-neutral-100 transition"
            >
              Quản lý giao dịch
            </Link>
          </div>
        </div>
      </main>
    </>
  )
}