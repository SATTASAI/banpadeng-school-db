// โหมดมุมมองบุคคลอื่น (view as) สำหรับผู้ดูแลระบบ: ใช้ทดสอบการมองเห็นเมนู/ข้อมูลของแต่ละบัญชี
// - ผูกกับ session การเข้าสู่ระบบ (auth_sessions.id) ของผู้ดูแลเท่านั้น อุปกรณ์อื่นของผู้ดูแลไม่ได้รับผลกระทบ
// - ดูได้อย่างเดียว: ระหว่างนี้บันทึก/แก้ไข/ส่งแจ้งเตือนในนามบัญชีนั้นไม่ได้ (บล็อกที่ index.js)
// - หมดอายุอัตโนมัติ VIEW_AS_MINUTES นาที และบันทึกการเริ่ม/จบไว้ใน audit_logs
export const VIEW_AS_MINUTES = 60;
export const VIEW_AS_BLOCKED = {
  error: "กำลังอยู่ในโหมดมุมมองบุคคลอื่น (ดูได้อย่างเดียว) — กด \"กลับเป็นบัญชีของฉัน\" ก่อนบันทึกหรือแก้ไขข้อมูล",
  code: "VIEW_AS_READ_ONLY",
};

const ready = new WeakSet();
export async function ensureViewAsSchema(env) {
  if (ready.has(env.DB)) return;
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS admin_view_as (
    session_id TEXT PRIMARY KEY, admin_user_id INTEGER NOT NULL REFERENCES users(id),
    target_user_id INTEGER NOT NULL REFERENCES users(id),
    started_at TEXT NOT NULL DEFAULT (datetime('now')), expires_at TEXT NOT NULL)`).run();
  ready.add(env.DB);
}

export async function activeViewAs(env, sessionId, adminId) {
  if (!sessionId) return null;
  try {
    return await env.DB.prepare(`SELECT target_user_id, started_at, expires_at FROM admin_view_as
      WHERE session_id=? AND admin_user_id=? AND expires_at>datetime('now')`).bind(String(sessionId), adminId).first();
  } catch (error) {
    if (/no such table/i.test(String(error?.message))) return null;
    throw error;
  }
}

export async function endViewAs(env, sessionId) {
  if (!sessionId) return 0;
  await ensureViewAsSchema(env);
  const r = await env.DB.prepare("DELETE FROM admin_view_as WHERE session_id=? RETURNING admin_user_id, target_user_id").bind(String(sessionId)).all();
  return r.results || [];
}

// เขียนได้ระหว่างโหมดนี้เฉพาะ: จัดการโหมดเอง และออกจากระบบ
export function viewAsMayWrite(pathname) {
  return pathname === "/api/admin/view-as" || pathname === "/api/auth/logout";
}
