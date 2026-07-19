// GET /api/momo/stores
//
// Trả về danh sách cửa hàng đã cấu hình trong MOMO_STORES (lib/stores.js),
// dùng để đổ vào dropdown chọn cửa hàng ở trang Tạo giao dịch. Yêu cầu
// session admin — cùng chuẩn xác thực với /api/momo/orders.
import { requireAdmin } from '../../../lib/requireAdmin'
import { getStores } from '../../../lib/stores'

export default function handler(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', ['GET'])
    return res.status(405).json({ error: 'Method not allowed' })
  }

  res.setHeader('Cache-Control', 'no-store')
  console.log(`[stores] GET @ ${new Date().toISOString()}`)

  const ok = requireAdmin(req, res)
  if (!ok) {
    console.log('[stores] Chặn: chưa đăng nhập admin')
    return
  }

  const stores = getStores().map(({ id, name, default: isDefault }) => ({ id, name, default: isDefault }))
  console.log(`[stores] → trả ${stores.length} cửa hàng`)
  return res.status(200).json({ stores })
}