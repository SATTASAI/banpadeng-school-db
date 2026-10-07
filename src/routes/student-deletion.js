// ลบนักเรียนถาวร — ทำได้เฉพาะเมื่อผู้อำนวยการยืนยันแล้วเท่านั้น
// ขั้นตอน: นักเรียนที่ย้ายออก/ออกกลางคันใช้ "soft delete" (เปลี่ยนสถานะ ข้อมูลยังค้นหาได้ รับกลับเข้าเรียนได้ด้วยเลขประจำตัวเดิม)
// ถ้าต้องลบจริง ผู้ดูแล (superadmin/ผู้บริหาร) ยื่นคำขอพร้อมเหตุผล → ผู้อำนวยการอนุมัติ → ระบบจึงลบ
import { getCurrentUser, isAdmin, jsonResponse } from "../lib/auth.js";
import { executives, isDirector } from "../lib/leave-data.js";

const ready = new WeakSet();
export async function ensureStudentDeletionSchema(env) {
  if (ready.has(env.DB)) return;
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS student_delete_requests (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    student_id INTEGER NOT NULL,
    student_code TEXT NOT NULL,
    student_name TEXT NOT NULL,
    student_status TEXT,
    reason TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected','cancelled')),
    requested_by INTEGER NOT NULL,
    requested_at TEXT NOT NULL DEFAULT (datetime('now')),
    decided_by INTEGER,
    decided_at TEXT,
    decision_note TEXT
  )`).run();
  await env.DB.prepare("CREATE INDEX IF NOT EXISTS idx_student_delete_requests_status ON student_delete_requests(status, student_id)").run();
  ready.add(env.DB);
}

export async function isSchoolDirector(env, user) {
  if (!user || user.role !== "executive") return false;
  const people = await executives(env).catch(() => []);
  return people.some((p) => isDirector(p) && p.user_ids.includes(user.id));
}

const STATUS_TH = { enrolled: "กำลังศึกษาอยู่", transferred: "ย้ายโรงเรียน", graduated: "จบการศึกษา", withdrawn: "ออกกลางคัน" };
// ข้อมูลของระบบรายงานผลการเรียน (students-report) ที่อ้างถึงนักเรียน — ไม่มี FOREIGN KEY จึงต้องลบเอง
const GRADE_TABLES = ["gr_scores", "gr_results", "gr_assessments", "gr_absences", "gr_comments", "gr_body", "gr_transfers", "gr_carryover"];

async function audit(env, user, action, id, details, request) {
  await env.DB.prepare(`INSERT INTO audit_logs (user_id, action, resource, resource_id, details, ip_address) VALUES (?, ?, 'student', ?, ?, ?)`)
    .bind(user.id, action, id, JSON.stringify(details), request.headers.get("CF-Connecting-IP") || null).run();
}

async function readBody(request) { return request.json().catch(() => ({})); }

export async function handleStudentDeletionRoute(request, env, pathname, method) {
  const requestMatch = pathname.match(/^\/api\/students\/(\d+)\/delete-request$/);
  const listPath = pathname === "/api/student-delete-requests";
  const decideMatch = pathname.match(/^\/api\/student-delete-requests\/(\d+)\/(approve|reject|cancel)$/);
  const directDelete = method === "DELETE" && /^\/api\/students\/\d+$/.test(pathname);
  if (!requestMatch && !listPath && !decideMatch && !directDelete) return null;

  const user = await getCurrentUser(request, env);
  if (!user || !user.role) return jsonResponse({ error: "กรุณาเข้าสู่ระบบ" }, 401);
  if (directDelete) {
    return jsonResponse({ error: "ลบนักเรียนโดยตรงไม่ได้ — เปลี่ยนสถานะเป็นย้ายโรงเรียน/ออกกลางคันแทน หรือยื่นคำขอลบถาวรให้ผู้อำนวยการอนุมัติ" }, 409);
  }
  if (!isAdmin(user)) return jsonResponse({ error: "เฉพาะผู้ดูแลระบบและผู้บริหาร" }, 403);
  await ensureStudentDeletionSchema(env);
  const director = await isSchoolDirector(env, user);

  if (listPath && method === "GET") {
    const { results } = await env.DB.prepare(
      `SELECT r.*, a.full_name AS requested_by_name, d.full_name AS decided_by_name
         FROM student_delete_requests r LEFT JOIN users a ON a.id = r.requested_by LEFT JOIN users d ON d.id = r.decided_by
        ORDER BY (r.status = 'pending') DESC, r.id DESC LIMIT 100`
    ).all();
    return jsonResponse({ can_decide: director, requests: results }, 200, { "Cache-Control": "no-store" });
  }

  if (requestMatch && method === "POST") {
    const studentId = Number(requestMatch[1]);
    const body = await readBody(request);
    const reason = String(body.reason || "").trim().slice(0, 500);
    if (!reason) return jsonResponse({ error: "กรุณาระบุเหตุผลที่ต้องลบถาวร" }, 400);
    const student = await env.DB.prepare("SELECT id, student_code, full_name, status FROM students WHERE id = ?").bind(studentId).first();
    if (!student) return jsonResponse({ error: "ไม่พบนักเรียน" }, 404);
    if (student.status === "enrolled") {
      return jsonResponse({ error: "นักเรียนยังมีสถานะกำลังศึกษาอยู่ — เปลี่ยนสถานะเป็นย้ายโรงเรียนหรือออกกลางคันก่อน" }, 409);
    }
    const pending = await env.DB.prepare("SELECT id FROM student_delete_requests WHERE student_id = ? AND status = 'pending'").bind(studentId).first();
    if (pending) return jsonResponse({ error: "มีคำขอลบนักเรียนคนนี้รอผู้อำนวยการพิจารณาอยู่แล้ว" }, 409);
    const r = await env.DB.prepare(
      `INSERT INTO student_delete_requests (student_id, student_code, student_name, student_status, reason, requested_by) VALUES (?, ?, ?, ?, ?, ?)`
    ).bind(studentId, student.student_code, student.full_name, student.status, reason, user.id).run();
    await audit(env, user, "delete_request", studentId, { request_id: r.meta.last_row_id, reason }, request);
    return jsonResponse({ id: r.meta.last_row_id }, 201);
  }

  if (decideMatch && method === "POST") {
    const id = Number(decideMatch[1]), action = decideMatch[2];
    const row = await env.DB.prepare("SELECT * FROM student_delete_requests WHERE id = ?").bind(id).first();
    if (!row) return jsonResponse({ error: "ไม่พบคำขอ" }, 404);
    if (row.status !== "pending") return jsonResponse({ error: "คำขอนี้ได้รับการพิจารณาแล้ว" }, 409);
    const note = String((await readBody(request)).note || "").trim().slice(0, 500) || null;

    if (action === "cancel") {
      if (row.requested_by !== user.id && user.role !== "superadmin") return jsonResponse({ error: "ยกเลิกได้เฉพาะผู้ยื่นคำขอ" }, 403);
      await env.DB.prepare("UPDATE student_delete_requests SET status = 'cancelled', decided_by = ?, decided_at = datetime('now'), decision_note = ? WHERE id = ?").bind(user.id, note, id).run();
      await audit(env, user, "delete_request_cancel", row.student_id, { request_id: id }, request);
      return jsonResponse({ ok: true });
    }
    if (!director) return jsonResponse({ error: "อนุมัติหรือไม่อนุมัติการลบถาวรได้เฉพาะผู้อำนวยการโรงเรียน" }, 403);
    if (action === "reject") {
      await env.DB.prepare("UPDATE student_delete_requests SET status = 'rejected', decided_by = ?, decided_at = datetime('now'), decision_note = ? WHERE id = ?").bind(user.id, note, id).run();
      await audit(env, user, "delete_request_reject", row.student_id, { request_id: id, note }, request);
      return jsonResponse({ ok: true });
    }

    // อนุมัติ → ลบจริง
    const student = await env.DB.prepare("SELECT id, status FROM students WHERE id = ?").bind(row.student_id).first();
    if (!student) {
      await env.DB.prepare("UPDATE student_delete_requests SET status = 'approved', decided_by = ?, decided_at = datetime('now'), decision_note = ? WHERE id = ?").bind(user.id, note, id).run();
      return jsonResponse({ ok: true, already_deleted: true });
    }
    if (student.status === "enrolled") return jsonResponse({ error: "นักเรียนกลับมามีสถานะกำลังศึกษาอยู่แล้ว จึงไม่ลบ — ให้ไม่อนุมัติคำขอนี้" }, 409);
    const bank = await env.DB.prepare("SELECT 1 AS x FROM sqlite_master WHERE type = 'table' AND name = 'school_bank_accounts'").first()
      && await env.DB.prepare("SELECT id FROM school_bank_accounts WHERE student_id = ?").bind(row.student_id).first();
    if (bank) return jsonResponse({ error: "นักเรียนมีบัญชีธนาคารโรงเรียน ต้องปิดบัญชีและจัดการยอดเงินก่อนจึงลบได้" }, 409);
    const linked = [...GRADE_TABLES, "guardians", "student_details", "student_enrollments"];
    const { results: tables } = await env.DB.prepare(
      `SELECT name FROM sqlite_master WHERE type = 'table' AND name IN (${linked.map(() => "?").join(",")})`
    ).bind(...linked).all();
    const have = new Set(tables.map((t) => t.name));
    const statements = [
      ...linked.filter((t) => have.has(t)).map((t) => env.DB.prepare(`DELETE FROM ${t} WHERE student_id = ?`).bind(row.student_id)),
      env.DB.prepare("DELETE FROM students WHERE id = ?").bind(row.student_id),
      env.DB.prepare("UPDATE student_delete_requests SET status = 'approved', decided_by = ?, decided_at = datetime('now'), decision_note = ? WHERE id = ?").bind(user.id, note, id),
    ];
    await env.DB.batch(statements);
    await audit(env, user, "delete", row.student_id, { request_id: id, student_code: row.student_code, student_name: row.student_name, status: STATUS_TH[row.student_status] || row.student_status }, request);
    return jsonResponse({ ok: true });
  }
  return jsonResponse({ error: "ไม่รองรับ" }, 405);
}
