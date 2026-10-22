// /api/admin/view-as — โหมดมุมมองบุคคลอื่นสำหรับผู้ดูแลระบบ (ดู src/lib/view-as.js)
import { getCurrentUser, jsonResponse, forgetCurrentUser } from "../lib/auth.js";
import { ensureViewAsSchema, endViewAs, VIEW_AS_MINUTES } from "../lib/view-as.js";

const ROLE_LABELS = { superadmin: "ผู้ดูแลระบบ", executive: "ผู้บริหาร", teacher: "ครู", staff: "เจ้าหน้าที่", viewer: "ผู้ชมภายนอก" };
const ip = (request) => request.headers.get("CF-Connecting-IP") || null;
async function audit(env, request, adminId, action, targetId, details = null) {
  await env.DB.prepare(`INSERT INTO audit_logs(user_id,action,resource,resource_id,details,ip_address) VALUES (?,?,?,?,?,?)`)
    .bind(adminId, action, "view_as", targetId, details ? JSON.stringify(details) : null, ip(request)).run().catch(() => {});
}
function summary(user) {
  return { id: user.id, full_name: user.full_name, email: user.email, role: user.role, role_label: ROLE_LABELS[user.role] || "รอกำหนดสิทธิ์" };
}
export function viewAsState(user) {
  if (!user?.impersonator) return null;
  return { admin: { id: user.impersonator.id, full_name: user.impersonator.full_name }, target: summary(user),
    started_at: user.view_as?.started_at || null, expires_at: user.view_as?.expires_at || null, read_only: true };
}

export async function handleViewAsRoute(request, env, pathname, method) {
  if (pathname !== "/api/admin/view-as" && pathname !== "/api/admin/view-as/candidates") return null;
  const user = await getCurrentUser(request, env);
  if (!user) return jsonResponse({ error: "กรุณาเข้าสู่ระบบ" }, 401);
  const admin = user.impersonator || user;
  if (admin.role !== "superadmin") return jsonResponse({ error: "เฉพาะผู้ดูแลระบบเท่านั้นที่ใช้โหมดมุมมองบุคคลอื่นได้" }, 403);
  await ensureViewAsSchema(env);
  const headers = { "Cache-Control": "no-store" };

  if (pathname === "/api/admin/view-as/candidates" && method === "GET") {
    const { results } = await env.DB.prepare(`SELECT u.id, u.full_name, u.email,
        CASE WHEN EXISTS(SELECT 1 FROM viewer_accounts v WHERE v.user_id=u.id) THEN 'viewer' ELSE u.role END AS role,
        (SELECT p.position FROM personnel_accounts pa JOIN personnel_records p ON p.id=pa.personnel_id AND p.status='active' WHERE pa.user_id=u.id LIMIT 1) AS position
      FROM users u WHERE u.status='active' AND u.deleted_at IS NULL AND u.id<>? ORDER BY u.full_name`).bind(admin.id).all()
      .catch(async () => env.DB.prepare(`SELECT id, full_name, email, role, NULL AS position FROM users WHERE status='active' AND deleted_at IS NULL AND id<>? ORDER BY full_name`).bind(admin.id).all());
    return jsonResponse({ users: results.map((u) => ({ ...u, role_label: ROLE_LABELS[u.role] || "รอกำหนดสิทธิ์" })) }, 200, headers);
  }
  if (method === "GET") return jsonResponse({ active: viewAsState(user), minutes: VIEW_AS_MINUTES }, 200, headers);

  const sid = user.session_id;
  if (!sid) return jsonResponse({ error: "session นี้เป็นแบบเก่า กรุณาออกจากระบบแล้วเข้าสู่ระบบใหม่ก่อนใช้โหมดนี้" }, 400);

  if (method === "POST") {
    const body = await request.json().catch(() => ({}));
    const targetId = Number(body?.user_id);
    if (!Number.isInteger(targetId) || targetId <= 0) return jsonResponse({ error: "กรุณาเลือกบัญชีที่ต้องการดู" }, 400);
    if (targetId === Number(admin.id)) return jsonResponse({ error: "เลือกบัญชีอื่นที่ไม่ใช่บัญชีของคุณเอง" }, 400);
    const target = await env.DB.prepare("SELECT id, full_name, status FROM users WHERE id=? AND deleted_at IS NULL").bind(targetId).first();
    if (!target) return jsonResponse({ error: "ไม่พบบัญชีนี้" }, 404);
    if (target.status !== "active") return jsonResponse({ error: "บัญชีนี้ไม่ได้เปิดใช้งาน จึงเข้าระบบไม่ได้อยู่แล้ว" }, 400);
    const previous = user.impersonator ? Number(user.id) : null;
    await env.DB.prepare(`INSERT INTO admin_view_as(session_id, admin_user_id, target_user_id, started_at, expires_at)
      VALUES (?, ?, ?, datetime('now'), datetime('now', ?))
      ON CONFLICT(session_id) DO UPDATE SET admin_user_id=excluded.admin_user_id, target_user_id=excluded.target_user_id,
        started_at=excluded.started_at, expires_at=excluded.expires_at`).bind(sid, admin.id, targetId, `+${VIEW_AS_MINUTES} minutes`).run();
    await audit(env, request, admin.id, "view_as_start", targetId, { target_name: target.full_name, previous_target_id: previous });
    forgetCurrentUser(request);
    return jsonResponse({ ok: true, active: viewAsState(await getCurrentUser(request, env)) }, 200, headers);
  }
  if (method === "DELETE") {
    const ended = await endViewAs(env, sid);
    for (const row of ended) await audit(env, request, admin.id, "view_as_end", row.target_user_id);
    forgetCurrentUser(request);
    return jsonResponse({ ok: true, ended: ended.length > 0 }, 200, headers);
  }
  return jsonResponse({ error: "Method not allowed" }, 405);
}
