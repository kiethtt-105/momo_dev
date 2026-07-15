// GET /api/admin/session
//
// Endpoint nhẹ, KHÔNG side-effect, chỉ để kiểm tra session admin
// (cookie) còn hiệu lực hay không. Dùng bởi gate đăng nhập toàn cục
// ở pages/_app.js — mọi trang đều gọi cái này trước khi render.
//
import { requireAdmin } from '../../../lib/requireAdmin'

export default function handler(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', ['GET'])
    return res.status(405).json({ error: 'Method not allowed' })
  }

  // requireAdmin tự set status 401 + trả lỗi nếu thất bại, đồng thời
  // tự refresh rolling session (Max-Age 400 ngày) nếu hợp lệ.
  const ok = requireAdmin(req, res)
  if (!ok) return

  return res.status(200).json({ authed: true })
}