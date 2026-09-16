import { jsonResponse } from "../lib/auth.js";

// ---------- GET /api/users ----------
// รายชื่อผู้ใช้งานที่ใช้งานอยู่และมีสิทธิ์แล้ว (สำหรับเลือกผู้รับผิดชอบงาน)
export async function handleListActiveUsers(request, env) {
  const { results } = await env.DB.prepare(
    `SELECT id, full_name, role FROM users
     WHERE status = 'active' AND role IS NOT NULL
     ORDER BY full_name COLLATE NOCASE`
  ).all();
  return jsonResponse({ users: results });
}
