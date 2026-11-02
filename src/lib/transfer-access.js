import { jsonResponse } from "./auth.js";
const ready = new WeakSet();
export const managesTransferAccess = (user) => user?.role === "superadmin";
export async function ensureTransferAccess(env) {
  if (ready.has(env.DB)) return;
  await env.DB.prepare(
    `CREATE TABLE IF NOT EXISTS student_transfer_access (
 user_id INTEGER PRIMARY KEY REFERENCES users(id), granted_by INTEGER NOT NULL REFERENCES users(id),
 granted_at TEXT NOT NULL DEFAULT (datetime('now')))`,
  ).run();
  ready.add(env.DB);
}
export async function mayUseTransfers(env, user) {
  if (!user?.role || user.role === "viewer") return false;
  if (managesTransferAccess(user)) return true;
  await ensureTransferAccess(env);
  return !!(await env.DB.prepare(
    "SELECT user_id FROM student_transfer_access WHERE user_id=?",
  )
    .bind(user.id)
    .first());
}
const reply = (data, status = 200) =>
  jsonResponse(data, status, { "Cache-Control": "no-store" });
export async function handleTransferAccess(request, env, path, method, user) {
  if (path === "/api/student-transfers/access" && method === "GET")
    return reply({
      allowed: await mayUseTransfers(env, user),
      manage_permissions: managesTransferAccess(user),
    });
  const match = path.match(
    /^\/api\/student-transfers\/permissions(?:\/(\d+))?$/,
  );
  if (!match) return null;
  if (!managesTransferAccess(user))
    return reply({ error: "เฉพาะแอดมินที่ตั้งค่าสิทธิ์ได้" }, 403);
  await ensureTransferAccess(env);
  if (!match[1] && method === "GET") {
    const { results } = await env.DB.prepare(
      `SELECT u.id,u.full_name,u.role,
    CASE WHEN u.role='superadmin' OR a.user_id IS NOT NULL THEN 1 ELSE 0 END allowed
    FROM users u LEFT JOIN student_transfer_access a ON a.user_id=u.id
    WHERE u.status='active' AND u.role IN ('superadmin','executive','staff','teacher') ORDER BY u.full_name,u.id`,
    ).all();
    return reply({ users: results });
  }
  if (match[1] && method === "PUT") {
    const origin = request.headers.get("Origin");
    if (origin && origin !== new URL(request.url).origin)
      return reply({ error: "ไม่อนุญาตคำขอจากเว็บไซต์อื่น" }, 403);
    const body = await request.json().catch(() => null),
      id = Number(match[1]);
    if (typeof body?.allowed !== "boolean")
      return reply({ error: "กรุณาระบุสิทธิ์ให้ถูกต้อง" }, 400);
    const target = await env.DB.prepare(
      "SELECT id,role,status FROM users WHERE id=?",
    )
      .bind(id)
      .first();
    if (
      !target ||
      target.status !== "active" ||
      !["teacher", "staff", "executive", "superadmin"].includes(target.role)
    )
      return reply({ error: "ไม่พบบัญชีที่สามารถกำหนดสิทธิ์ได้" }, 404);
    if (target.role === "superadmin")
      return reply({ error: "แอดมินมีสิทธิ์จัดการระบบเสมอ" }, 400);
    await env.DB.batch([
      body.allowed
        ? env.DB.prepare(
            `INSERT INTO student_transfer_access(user_id,granted_by) VALUES(?,?) ON CONFLICT(user_id) DO UPDATE SET granted_by=excluded.granted_by,granted_at=datetime('now')`,
          ).bind(id, user.id)
        : env.DB.prepare(
            "DELETE FROM student_transfer_access WHERE user_id=?",
          ).bind(id),
      env.DB.prepare(
        `INSERT INTO audit_logs(user_id,action,resource,resource_id,details) VALUES(?,?,'student_transfer_access',?,?)`,
      ).bind(
        user.id,
        body.allowed ? "grant" : "revoke",
        id,
        JSON.stringify({ allowed: body.allowed }),
      ),
    ]);
    return reply({ ok: true });
  }
  return reply({ error: "Method not allowed" }, 405);
}
