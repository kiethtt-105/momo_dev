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

  const ok = requireAdmin(req, res)
  if (!ok) return

  const stores = getStores().map(({ id, name, default: isDefault }) => ({ id, name, default: isDefault }))
  return res.status(200).json({ stores })
}