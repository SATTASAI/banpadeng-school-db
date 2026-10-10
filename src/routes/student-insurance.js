// ประกันอุบัติเหตุนักเรียน — บันทึกรายปีการศึกษา (1 คน 1 รายการต่อปี)
// ผู้บันทึก: ผู้ดูแลระบบ/เจ้าหน้าที่ (ทุกห้อง) และครูประจำชั้น (เฉพาะห้องของตนในปีที่เปิดใช้)
// นำเข้าจาก Excel: ผู้ดูแลระบบ/เจ้าหน้าที่เท่านั้น
import { getCurrentUser, isAdmin, jsonResponse } from "../lib/auth.js";

export const INSURANCE_TEXT_FIELDS = ["company", "policy_no", "plan_name", "start_date", "end_date", "notes"];
export const INSURANCE_NUMBER_FIELDS = ["premium", "coverage_amount"];
const MAX_BATCH = 300;

const ready = new WeakSet();
export async function ensureStudentInsuranceSchema(env) {
  if (ready.has(env.DB)) return;
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS student_insurance (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    student_id INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
    academic_year INTEGER NOT NULL CHECK (academic_year BETWEEN 2500 AND 2700),
    insured INTEGER NOT NULL DEFAULT 1 CHECK (insured IN (0,1)),
    company TEXT, policy_no TEXT, plan_name TEXT,
    premium REAL, coverage_amount REAL,
    start_date TEXT, end_date TEXT, notes TEXT,
    updated_by INTEGER,
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE (student_id, academic_year)
  )`).run();
  await env.DB.prepare("CREATE INDEX IF NOT EXISTS idx_student_insurance_year ON student_insurance(academic_year, student_id)").run();
  ready.add(env.DB);
}

// "มี/ทำ/yes/1/✓" → 1, "ไม่/no/0" → 0, อื่น ๆ → null (ไม่ถูกต้อง)
export function parseInsured(value) {
  if (value === true || value === 1) return 1;
  if (value === false || value === 0) return 0;
  const v = String(value ?? "").trim().toLowerCase();
  if (["1", "y", "yes", "true", "มี", "ทำ", "ทำประกัน", "ทำแล้ว", "ซื้อ", "✓", "/", "x", "ใช่"].includes(v)) return 1;
  if (["0", "n", "no", "false", "ไม่มี", "ไม่ทำ", "ไม่ทำประกัน", "ไม่ซื้อ", "ไม่", "-"].includes(v)) return 0;
  return null;
}

// ปีการศึกษา พ.ศ. รับได้ทั้ง 2569 และ ค.ศ. 2026
export function parseYear(value) {
  const n = Number(String(value ?? "").trim());
  if (!Number.isInteger(n)) return null;
  const be = n < 2500 ? n + 543 : n;
  return be >= 2500 && be <= 2700 ? be : null;
}

// วันที่: YYYY-MM-DD (ค.ศ. หรือ พ.ศ.) หรือ DD/MM/YYYY → YYYY-MM-DD แบบ ค.ศ.
export function parseDate(value) {
  const text = String(value ?? "").trim();
  if (!text) return null;
  let y, m, d;
  let match = text.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (match) [, y, m, d] = match.map(Number);
  else if ((match = text.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/))) [, d, m, y] = match.map(Number);
  else return undefined;
  if (y > 2400) y -= 543;
  const date = new Date(Date.UTC(y, m - 1, d));
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== m - 1 || date.getUTCDate() !== d) return undefined;
  return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

// ตรวจและแปลงข้อมูล 1 รายการ คืน { record } หรือ { error }
export function normalizeInsuranceInput(input) {
  const insured = parseInsured(input?.insured);
  if (insured === null) return { error: "สถานะประกันต้องเป็น ทำ/ไม่ทำ" };
  const record = { insured };
  for (const f of INSURANCE_TEXT_FIELDS) {
    if (f === "start_date" || f === "end_date") {
      const date = parseDate(input?.[f]);
      if (date === undefined) return { error: `${f === "start_date" ? "วันเริ่มคุ้มครอง" : "วันสิ้นสุดคุ้มครอง"}ไม่ถูกต้อง (ใช้ YYYY-MM-DD หรือ วว/ดด/ปปปป)` };
      record[f] = date;
    } else {
      const text = String(input?.[f] ?? "").trim().slice(0, 300);
      record[f] = text || null;
    }
  }
  for (const f of INSURANCE_NUMBER_FIELDS) {
    const raw = String(input?.[f] ?? "").replace(/[,\s฿บาท]/g, "");
    if (!raw) { record[f] = null; continue; }
    const n = Number(raw);
    if (!Number.isFinite(n) || n < 0) return { error: `${f === "premium" ? "เบี้ยประกัน" : "วงเงินคุ้มครอง"}ต้องเป็นตัวเลขตั้งแต่ 0` };
    record[f] = n;
  }
  if (record.start_date && record.end_date && record.end_date < record.start_date) return { error: "วันสิ้นสุดต้องไม่ก่อนวันเริ่มคุ้มครอง" };
  return { record };
}

function canManageAll(user) { return isAdmin(user) || user.role === "staff"; }

async function activeYear(env) {
  const row = await env.DB.prepare("SELECT id, year_be FROM academic_years WHERE status = 'active' ORDER BY year_be DESC LIMIT 1").first().catch(() => null);
  if (row?.year_be) return { id: row.id, year_be: Number(row.year_be) };
  const now = new Date();
  return { id: null, year_be: now.getFullYear() + 543 - (now.getMonth() < 4 ? 1 : 0) };
}

// ห้องที่ครูคนนี้เป็นครูประจำชั้น (ปีที่เปิดใช้) เป็นชุด "ชั้น|ห้อง"
async function homeroomKeys(env, user) {
  const hasTable = await env.DB.prepare("SELECT 1 AS x FROM sqlite_master WHERE type='table' AND name='gr_homerooms'").first().catch(() => null);
  if (!hasTable) return new Set();
  const { results } = await env.DB.prepare(`SELECT h.grade_level, h.classroom FROM gr_homerooms h JOIN academic_years y ON y.id = h.academic_year_id
    WHERE y.status = 'active' AND h.user_id = ?`).bind(user.id).all();
  return new Set((results || []).map((r) => `${String(r.grade_level).trim()}|${String(r.classroom).trim()}`));
}

async function readJson(request) {
  try { return await request.json(); } catch { return null; }
}

function cleanRecord(row) {
  return {
    id: row.id, student_id: row.student_id, academic_year: row.academic_year, insured: Number(row.insured),
    company: row.company, policy_no: row.policy_no, plan_name: row.plan_name,
    premium: row.premium, coverage_amount: row.coverage_amount,
    start_date: row.start_date, end_date: row.end_date, notes: row.notes, updated_at: row.updated_at,
  };
}

function upsertStatement(env, studentId, year, record, userId) {
  return env.DB.prepare(`INSERT INTO student_insurance (student_id, academic_year, insured, company, policy_no, plan_name, premium, coverage_amount, start_date, end_date, notes, updated_by, updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,datetime('now'))
    ON CONFLICT(student_id, academic_year) DO UPDATE SET insured=excluded.insured, company=excluded.company, policy_no=excluded.policy_no,
      plan_name=excluded.plan_name, premium=excluded.premium, coverage_amount=excluded.coverage_amount, start_date=excluded.start_date,
      end_date=excluded.end_date, notes=excluded.notes, updated_by=excluded.updated_by, updated_at=datetime('now')`)
    .bind(studentId, year, record.insured, record.company, record.policy_no, record.plan_name, record.premium, record.coverage_amount,
      record.start_date, record.end_date, record.notes, userId);
}

async function audit(env, user, action, details) {
  await env.DB.prepare("INSERT INTO audit_logs (user_id, action, resource, resource_id, details) VALUES (?,?,?,?,?)")
    .bind(user.id, action, "student_insurance", null, JSON.stringify(details)).run().catch(() => {});
}

// GET /api/student-insurance?academic_year=2569 (ไม่ใส่ = ปีที่เปิดใช้) หรือ ?all_years=1
async function handleList(request, env, user) {
  const url = new URL(request.url);
  const current = await activeYear(env);
  const all = url.searchParams.get("all_years") === "1";
  const year = parseYear(url.searchParams.get("academic_year")) || current.year_be;
  const { results } = all
    ? await env.DB.prepare("SELECT * FROM student_insurance ORDER BY academic_year DESC, student_id").all()
    : await env.DB.prepare("SELECT * FROM student_insurance WHERE academic_year = ? ORDER BY student_id").bind(year).all();
  const { results: yearRows } = await env.DB.prepare("SELECT DISTINCT academic_year FROM student_insurance ORDER BY academic_year DESC").all();
  const years = [...new Set([current.year_be, ...yearRows.map((r) => Number(r.academic_year))])].sort((a, b) => b - a);
  const homerooms = canManageAll(user) ? [] : [...await homeroomKeys(env, user)];
  return jsonResponse({
    academic_year: all ? null : year, current_year: current.year_be, years,
    records: (results || []).map(cleanRecord),
    permissions: { manage_all: canManageAll(user), homerooms, can_import: canManageAll(user) },
  });
}

// GET /api/student-insurance/student/:id — ทุกปีของนักเรียนคนเดียว
async function handleStudent(env, user, studentId) {
  const current = await activeYear(env);
  const student = await env.DB.prepare("SELECT id, grade_level, classroom FROM students WHERE id = ?").bind(studentId).first();
  if (!student) return jsonResponse({ error: "ไม่พบนักเรียน" }, 404);
  const { results } = await env.DB.prepare("SELECT * FROM student_insurance WHERE student_id = ? ORDER BY academic_year DESC").bind(studentId).all();
  let canEdit = canManageAll(user);
  if (!canEdit) canEdit = (await homeroomKeys(env, user)).has(`${String(student.grade_level ?? "").trim()}|${String(student.classroom ?? "").trim()}`);
  return jsonResponse({ current_year: current.year_be, records: (results || []).map(cleanRecord), can_edit: canEdit });
}

// PUT /api/student-insurance — บันทึกรายคนหรือทั้งห้อง { academic_year, records:[{student_id, insured, ...}] }
async function handleSave(request, env, user) {
  const body = await readJson(request);
  if (!body || !Array.isArray(body.records)) return jsonResponse({ error: "รูปแบบข้อมูลไม่ถูกต้อง" }, 400);
  const year = parseYear(body.academic_year);
  if (!year) return jsonResponse({ error: "กรุณาระบุปีการศึกษา (พ.ศ.)" }, 400);
  if (!body.records.length) return jsonResponse({ error: "ไม่มีรายการที่จะบันทึก" }, 400);
  if (body.records.length > MAX_BATCH) return jsonResponse({ error: `บันทึกได้ครั้งละไม่เกิน ${MAX_BATCH} คน` }, 400);

  const ids = [...new Set(body.records.map((r) => Number(r?.student_id)))];
  if (ids.some((id) => !Number.isInteger(id) || id <= 0)) return jsonResponse({ error: "รหัสนักเรียนไม่ถูกต้อง" }, 400);
  const { results: students } = await env.DB.prepare(`SELECT id, grade_level, classroom FROM students WHERE id IN (${ids.map(() => "?").join(",")})`).bind(...ids).all();
  const byId = new Map(students.map((s) => [s.id, s]));
  const missing = ids.filter((id) => !byId.has(id));
  if (missing.length) return jsonResponse({ error: `ไม่พบนักเรียน ${missing.length} คน` }, 404);
  if (!canManageAll(user)) {
    const rooms = await homeroomKeys(env, user);
    const denied = students.filter((s) => !rooms.has(`${String(s.grade_level ?? "").trim()}|${String(s.classroom ?? "").trim()}`));
    if (denied.length) return jsonResponse({ error: "บันทึกได้เฉพาะนักเรียนในห้องที่ท่านเป็นครูประจำชั้น" }, 403);
  }

  const statements = [];
  const errors = [];
  body.records.forEach((input, index) => {
    const { record, error } = normalizeInsuranceInput(input);
    if (error) errors.push({ index, student_id: Number(input.student_id), error });
    else statements.push(upsertStatement(env, Number(input.student_id), year, record, user.id));
  });
  if (errors.length) return jsonResponse({ error: `ข้อมูลไม่ถูกต้อง ${errors.length} รายการ: ${errors[0].error}`, errors }, 400);
  await env.DB.batch(statements);
  await audit(env, user, "save", { academic_year: year, count: statements.length });
  return jsonResponse({ ok: true, saved: statements.length, academic_year: year });
}

// DELETE /api/student-insurance/student/:id?academic_year=2569 — ล้างข้อมูลปีนั้น
async function handleClear(request, env, user, studentId) {
  const year = parseYear(new URL(request.url).searchParams.get("academic_year"));
  if (!year) return jsonResponse({ error: "กรุณาระบุปีการศึกษา" }, 400);
  const student = await env.DB.prepare("SELECT id, grade_level, classroom FROM students WHERE id = ?").bind(studentId).first();
  if (!student) return jsonResponse({ error: "ไม่พบนักเรียน" }, 404);
  if (!canManageAll(user) && !(await homeroomKeys(env, user)).has(`${String(student.grade_level ?? "").trim()}|${String(student.classroom ?? "").trim()}`)) {
    return jsonResponse({ error: "ไม่มีสิทธิ์แก้ไขข้อมูลประกันของนักเรียนคนนี้" }, 403);
  }
  await env.DB.prepare("DELETE FROM student_insurance WHERE student_id = ? AND academic_year = ?").bind(studentId, year).run();
  await audit(env, user, "clear", { student_id: studentId, academic_year: year });
  return jsonResponse({ ok: true });
}

// POST /api/student-insurance/import — { rows:[{student_code, academic_year, insured, ...}] } อ้างอิงเลขประจำตัวนักเรียน
async function handleImport(request, env, user) {
  if (!canManageAll(user)) return jsonResponse({ error: "นำเข้าข้อมูลประกันได้เฉพาะผู้ดูแลระบบและเจ้าหน้าที่" }, 403);
  const body = await readJson(request);
  if (!body || !Array.isArray(body.rows)) return jsonResponse({ error: "รูปแบบข้อมูลไม่ถูกต้อง" }, 400);
  if (body.rows.length > MAX_BATCH) return jsonResponse({ error: `นำเข้าได้ครั้งละไม่เกิน ${MAX_BATCH} แถว` }, 400);
  const current = await activeYear(env);
  const codes = [...new Set(body.rows.map((r) => String(r?.student_code ?? "").trim()).filter(Boolean))];
  const byCode = new Map();
  for (let i = 0; i < codes.length; i += 90) {
    const chunk = codes.slice(i, i + 90);
    const { results } = await env.DB.prepare(`SELECT id, student_code FROM students WHERE student_code IN (${chunk.map(() => "?").join(",")})`).bind(...chunk).all();
    for (const s of results) byCode.set(String(s.student_code), s.id);
  }
  const statements = [], skipped = [], seen = new Set();
  body.rows.forEach((row, index) => {
    const code = String(row?.student_code ?? "").trim();
    const studentId = byCode.get(code);
    if (!code) return skipped.push({ row: index + 1, reason: "ไม่มีเลขประจำตัวนักเรียน" });
    if (!studentId) return skipped.push({ row: index + 1, reason: `ไม่พบนักเรียนรหัส ${code}` });
    const year = String(row.academic_year ?? "").trim() ? parseYear(row.academic_year) : current.year_be;
    if (!year) return skipped.push({ row: index + 1, reason: "ปีการศึกษาไม่ถูกต้อง" });
    const key = `${studentId}|${year}`;
    if (seen.has(key)) return skipped.push({ row: index + 1, reason: `รหัส ${code} ปี ${year} ซ้ำในไฟล์` });
    seen.add(key);
    const { record, error } = normalizeInsuranceInput(row);
    if (error) return skipped.push({ row: index + 1, reason: error });
    statements.push(upsertStatement(env, studentId, year, record, user.id));
  });
  if (statements.length) await env.DB.batch(statements);
  await audit(env, user, "import", { saved: statements.length, skipped: skipped.length });
  return jsonResponse({ ok: true, created: statements.length, updated: 0, saved: statements.length, skipped });
}

export async function handleStudentInsuranceRoute(request, env, pathname, method) {
  if (!pathname.startsWith("/api/student-insurance")) return null;
  const user = await getCurrentUser(request, env);
  if (!user || !user.role) return jsonResponse({ error: "กรุณาเข้าสู่ระบบ" }, 401);
  await ensureStudentInsuranceSchema(env);
  if (pathname === "/api/student-insurance" && method === "GET") return handleList(request, env, user);
  if (pathname === "/api/student-insurance" && method === "PUT") return handleSave(request, env, user);
  if (pathname === "/api/student-insurance/import" && method === "POST") return handleImport(request, env, user);
  const match = pathname.match(/^\/api\/student-insurance\/student\/(\d+)$/);
  if (match && method === "GET") return handleStudent(env, user, Number(match[1]));
  if (match && method === "DELETE") return handleClear(request, env, user, Number(match[1]));
  return jsonResponse({ error: "ไม่พบเส้นทาง" }, 404);
}
