import { AUTH_COOKIE_NAME, verifyJWT } from "./crypto.js";

export function parseCookies(request) {
  const header = request.headers.get("Cookie") || "";
  const cookies = {};
  header.split(";").forEach((part) => {
    const idx = part.indexOf("=");
    if (idx === -1) return;
    const key = part.slice(0, idx).trim();
    const val = part.slice(idx + 1).trim();
    if (key) cookies[key] = decodeURIComponent(val);
  });
  return cookies;
}

// คืนค่า user ปัจจุบันจากฐานข้อมูลจริง (ไม่ใช้แค่ข้อมูลใน token)
// เพื่อให้แน่ใจว่าถ้าแอดมินเปลี่ยนสิทธิ์/ระงับบัญชี จะมีผลทันทีในคำขอถัดไป
export async function getCurrentUser(request, env) {
  const cookies = parseCookies(request);
  const token = cookies[AUTH_COOKIE_NAME];
  if (!token) return null;

  const payload = await verifyJWT(token, env.JWT_SECRET);
  if (!payload || !payload.sub) return null;

  const user = await env.DB.prepare(
    "SELECT id, email, full_name, role, status, created_at FROM users WHERE id = ?"
  )
    .bind(payload.sub)
    .first();

  if (!user || user.status !== "active") return null;
  return user;
}

export function jsonResponse(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...extraHeaders },
  });
}

export const ADMIN_ROLES = ["superadmin", "executive"];

export function isAdmin(user) {
  return !!user && ADMIN_ROLES.includes(user.role);
}
