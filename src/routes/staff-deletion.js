// ลบข้อมูลบุคลากร (เฉพาะผู้ดูแลระบบ superadmin)
// เป็น soft delete: เปลี่ยนสถานะเป็น inactive — ไม่แสดงในทะเบียน/ตัวเลือกต่าง ๆ แต่ประวัติที่อ้างถึง (ตารางสอน การลา สอนแทน) ยังอยู่ครบ
// ถอดออกจากฝ่ายงานและบัญชีที่ผูกไว้ แล้วเก็บข้อมูลเดิมไว้ใน audit_logs เพื่อกู้คืนได้
// บัญชีเข้าสู่ระบบ (users) ไม่ถูกลบ — ลบที่หน้าจัดการผู้ใช้แยกต่างหาก
import { getCurrentUser, jsonResponse } from "../lib/auth.js";
import { ensurePersonnelData } from "../lib/personnel-data.js";

const safe = (promise) => promise.catch(() => null);

async function usageOf(env, id) {
  const count = async (sql) => Number((await safe(env.DB.prepare(sql).bind(id).first()))?.n || 0);
  return {
    timetable: await count(`SELECT COUNT(*) n FROM timetable_entries e JOIN timetable_plans p ON p.id = e.plan_id
      WHERE p.status IN ('draft','published') AND e.teacher_id = ?`),
    teaching: await count(`SELECT COUNT(*) n FROM academic_teaching_assignments a JOIN academic_terms t ON t.id = a.academic_term_id
      WHERE t.status = 'active' AND a.personnel_id = ?`),
  };
}

async function audit(env, user, action, id, details, request) {
  await env.DB.prepare(`INSERT INTO audit_logs (user_id, action, resource, resource_id, details, ip_address) VALUES (?, ?, 'staff', ?, ?, ?)`)
    .bind(user.id, action, id, JSON.stringify(details), request.headers.get("CF-Connecting-IP") || null).run();
}

export async function handleStaffDeletionRoute(request, env, pathname, method) {
  const one = pathname.match(/^\/api\/staff\/(\d+)$/);
  const restore = pathname.match(/^\/api\/staff\/(\d+)\/restore$/);
  const list = pathname === "/api/staff/deleted" && method === "GET";
  if (!(one && method === "DELETE") && !(restore && method === "POST") && !list) return null;

  const user = await getCurrentUser(request, env);
  if (!user || !user.role) return jsonResponse({ error: "กรุณาเข้าสู่ระบบ" }, 401);
  if (user.role !== "superadmin") return jsonResponse({ error: "ลบหรือกู้คืนข้อมูลบุคลากรได้เฉพาะผู้ดูแลระบบ" }, 403);
  await ensurePersonnelData(env);

  if (list) {
    // เฉพาะที่ลบด้วยเมนูนี้ (ไม่รวมรายการซ้ำที่ถูกรวมเข้าคนอื่นแล้ว)
    const { results } = await env.DB.prepare(
      `SELECT p.id, p.full_name, p.position, p.updated_at AS deleted_at, u.full_name AS deleted_by_name
         FROM personnel_records p
         JOIN audit_logs a ON a.id = (SELECT MAX(id) FROM audit_logs WHERE resource = 'staff' AND action = 'delete' AND resource_id = p.id)
         LEFT JOIN users u ON u.id = a.user_id
        WHERE p.status = 'inactive'
        ORDER BY p.updated_at DESC`
    ).all();
    return jsonResponse({ staff: results });
  }

  if (restore) {
    const id = Number(restore[1]);
    const person = await env.DB.prepare("SELECT id, full_name, status FROM personnel_records WHERE id = ?").bind(id).first();
    if (!person) return jsonResponse({ error: "ไม่พบบุคลากรนี้" }, 404);
    if (person.status === "active") return jsonResponse({ error: "บุคลากรนี้อยู่ในทะเบียนแล้ว" }, 409);
    const log = await env.DB.prepare("SELECT details FROM audit_logs WHERE resource = 'staff' AND action = 'delete' AND resource_id = ? ORDER BY id DESC LIMIT 1").bind(id).first();
    if (!log) return jsonResponse({ error: "รายการนี้ไม่ได้ลบด้วยเมนูลบบุคลากร (อาจเป็นรายการซ้ำที่รวมแล้ว) จึงกู้คืนที่นี่ไม่ได้" }, 409);
    let saved = {};
    try { saved = JSON.parse(log.details || "{}"); } catch { /* ข้อมูลเดิมเสีย: กู้เฉพาะสถานะ */ }
    const statements = [env.DB.prepare("UPDATE personnel_records SET status = 'active', updated_at = datetime('now') WHERE id = ?").bind(id)];
    for (const d of saved.departments || []) {
      // หัวหน้าฝ่าย: คืนตำแหน่งหัวหน้าเฉพาะเมื่อฝ่ายนั้นยังไม่มีหัวหน้าคนใหม่
      statements.push(env.DB.prepare(
        `INSERT OR IGNORE INTO department_staff (department, personnel_id, is_head, updated_by)
         VALUES (?, ?, CASE WHEN ? = 1 AND NOT EXISTS (SELECT 1 FROM department_staff WHERE department = ? AND is_head = 1) THEN 1 ELSE 0 END, ?)`
      ).bind(d.department, id, Number(d.is_head || 0), d.department, user.id));
    }
    for (const uid of saved.accounts || []) {
      statements.push(env.DB.prepare("INSERT OR IGNORE INTO personnel_accounts (user_id, personnel_id) VALUES (?, ?)").bind(uid, id));
    }
    await env.DB.batch(statements);
    await audit(env, user, "restore", id, { full_name: person.full_name }, request);
    return jsonResponse({ ok: true });
  }

  const id = Number(one[1]);
  const person = await env.DB.prepare(
    `SELECT p.id, p.full_name, p.user_id, u.email AS account_email, u.status AS account_status, u.deleted_at AS account_deleted_at
       FROM personnel_records p LEFT JOIN users u ON u.id = p.user_id WHERE p.id = ? AND p.status = 'active'`
  ).bind(id).first();
  if (!person) return jsonResponse({ error: "ไม่พบบุคลากรนี้ หรือถูกลบไปแล้ว" }, 404);
  const body = await request.json().catch(() => ({}));
  const usage = await usageOf(env, id);
  if ((usage.timetable || usage.teaching) && !body?.confirm) {
    const parts = [];
    if (usage.timetable) parts.push(`มีคาบสอนในตารางสอนปัจจุบัน ${usage.timetable} คาบ`);
    if (usage.teaching) parts.push(`มีภาระงานสอนในภาคเรียนนี้ ${usage.teaching} รายการ`);
    return jsonResponse({ error: `${person.full_name} ${parts.join(" และ ")} — ตารางสอนเดิมจะยังแสดงชื่อนี้อยู่ แต่จะเลือกคนนี้ใหม่ไม่ได้`, needs_confirm: true, usage }, 409);
  }
  const departments = (await safe(env.DB.prepare("SELECT department, is_head FROM department_staff WHERE personnel_id = ?").bind(id).all()))?.results || [];
  const accounts = ((await safe(env.DB.prepare("SELECT user_id FROM personnel_accounts WHERE personnel_id = ?").bind(id).all()))?.results || []).map((r) => r.user_id);
  const tables = new Set(((await env.DB.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all()).results || []).map((r) => r.name));
  await env.DB.batch([
    env.DB.prepare("UPDATE personnel_records SET status = 'inactive', updated_at = datetime('now') WHERE id = ?").bind(id),
    ...["department_staff", "personnel_accounts"].filter((t) => tables.has(t))
      .map((t) => env.DB.prepare(`DELETE FROM ${t} WHERE personnel_id = ?`).bind(id)),
  ]);
  await audit(env, user, "delete", id, { full_name: person.full_name, departments, accounts, usage }, request);
  const hasAccount = person.user_id && person.account_status === "active" && !person.account_deleted_at;
  return jsonResponse({ ok: true, account_email: hasAccount ? person.account_email : null });
}
