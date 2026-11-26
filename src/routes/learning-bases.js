// จัดนักเรียนเข้าฐานการเรียนรู้ (ฝ่ายบริหารทั่วไป) — ข้อมูลรายปีการศึกษา ป.1–6
// ดู: ครูและบุคลากรทุกคน (ยกเว้นบัญชีผู้ชมภายนอก) · แก้ไข: สมาชิกฝ่ายบริหารทั่วไป + admin (superadmin/executive)
// ข้อมูลอยู่ในตาราง learning_bases / learning_base_members ของ system เท่านั้น (grades ไม่อ่าน/ไม่แสดง)
import { getCurrentUser, isAdmin, jsonResponse } from "../lib/auth.js";
import { ensureDepartmentStaff, belongsToDepartment } from "./department-staff.js";
import { ASSIGN_METHODS, assignLearningBases } from "../lib/learning-base-assign.js";

// ชื่อฐานตั้งต้น (จากไฟล์รายชื่อฐานการเรียนรู้ ปีการศึกษา 2569) — แก้ไขชื่อได้ที่หน้าเว็บ
export const DEFAULT_BASES = ["ดนตรีไทย", "B.P.D. FC", "บริษัทเนเจอร์พลัส", "เห็ดนางฟ้า", "Flower Design Handmade", "ดนตรีสากล",
  "ปูนปั้น รักษ์โลก", "ขนม นม เนย", "รำไทยใจโมเดิร์น", "สถานีโบว์หวาน", "กระดาษแปลงร่าง", "ครัวน้อยของหนู", "เทียนหอม",
  "สวนสมุนไพร", "Barber", "ปุ๋ยไส้เดือน", "สมาธิ สร้างปัญญา", "Computer art"];
const ALL_GRADES = [1, 2, 3, 4, 5, 6];
const MAX_BASES = 60;

const ready = new WeakSet();
export async function ensureLearningBaseSchema(env) {
  if (ready.has(env.DB)) return;
  for (const sql of [
    `CREATE TABLE IF NOT EXISTS learning_bases (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      academic_year INTEGER NOT NULL CHECK (academic_year BETWEEN 2500 AND 2700),
      name TEXT NOT NULL, capacity INTEGER, grades TEXT NOT NULL DEFAULT '1,2,3,4,5,6',
      sort_order INTEGER NOT NULL DEFAULT 0, active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
      updated_by INTEGER, created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE (academic_year, name))`,
    `CREATE TABLE IF NOT EXISTS learning_base_members (
      student_id INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
      academic_year INTEGER NOT NULL, base_id INTEGER NOT NULL REFERENCES learning_bases(id),
      grade_level TEXT, classroom TEXT, method TEXT, locked INTEGER NOT NULL DEFAULT 0 CHECK (locked IN (0,1)),
      updated_by INTEGER, updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (student_id, academic_year))`,
    "CREATE INDEX IF NOT EXISTS idx_learning_base_members_year ON learning_base_members(academic_year, base_id)",
  ]) await env.DB.prepare(sql).run();
  // lineage_id = ฐานต้นทางปีแรก (คัดลอกข้ามปี) ใช้ตรวจ "ห้ามซ้ำฐานเดิมจนจบ ป.6" แม้เปลี่ยนชื่อฐาน
  const { results: cols } = await env.DB.prepare("PRAGMA table_info(learning_bases)").all();
  if (!(cols || []).some((c) => c.name === "lineage_id")) await env.DB.prepare("ALTER TABLE learning_bases ADD COLUMN lineage_id INTEGER").run();
  ready.add(env.DB);
}

export function gradeNumber(value) {
  const m = String(value ?? "").match(/^\s*ป(?:ระถมศึกษาปีที่|\.)?\s*([1-6])\s*$/);
  return m ? Number(m[1]) : null;
}
export function genderOf(detail, fullName) {
  const g = String(detail ?? "").trim().toLowerCase();
  if (["ชาย", "m", "male", "เด็กชาย", "ช", "1"].includes(g)) return "M";
  if (["หญิง", "f", "female", "เด็กหญิง", "ญ", "2"].includes(g)) return "F";
  const n = String(fullName ?? "").trim();
  if (/^(เด็กชาย|ด\.\s?ช\.|นาย)/.test(n)) return "M";
  if (/^(เด็กหญิง|ด\.\s?ญ\.|นางสาว|น\.ส\.)/.test(n)) return "F";
  return "";
}
export function parseGrades(value) {
  const list = (Array.isArray(value) ? value : String(value ?? "").split(",")).map(Number).filter((n) => ALL_GRADES.includes(n));
  return [...new Set(list)].sort((a, b) => a - b);
}
function parseYear(value) {
  const n = Number(String(value ?? "").trim());
  if (!Number.isInteger(n)) return null;
  const be = n < 2500 ? n + 543 : n;
  return be >= 2500 && be <= 2700 ? be : null;
}
async function readJson(request) { try { return await request.json(); } catch { return null; } }

async function activeYear(env) {
  const row = await env.DB.prepare("SELECT year_be FROM academic_years WHERE status = 'active' ORDER BY year_be DESC LIMIT 1").first().catch(() => null);
  if (row?.year_be) return Number(row.year_be);
  const now = new Date(Date.now() + 7 * 3600 * 1000);
  return now.getUTCFullYear() + 543 - (now.getUTCMonth() < 4 ? 1 : 0);
}

// สมาชิกฝ่ายบริหารทั่วไป: department_staff หรือช่อง departments ในทะเบียนบุคลากร
async function isGeneralMember(env, user) {
  await ensureDepartmentStaff(env);
  const { results: people } = await env.DB.prepare(`SELECT p.id, p.departments FROM personnel_records p
    WHERE p.status = 'active' AND (p.user_id = ? OR p.id IN (SELECT personnel_id FROM personnel_accounts WHERE user_id = ?))`).bind(user.id, user.id).all()
    .catch(() => env.DB.prepare("SELECT p.id, p.departments FROM personnel_records p WHERE p.status = 'active' AND p.user_id = ?").bind(user.id).all());
  if ((people || []).some((p) => belongsToDepartment(p.departments, "general"))) return true;
  const ids = (people || []).map((p) => p.id);
  if (!ids.length) return false;
  const row = await env.DB.prepare(`SELECT 1 AS x FROM department_staff WHERE department = 'general' AND personnel_id IN (${ids.map(() => "?").join(",")}) LIMIT 1`).bind(...ids).first();
  return !!row;
}
export async function learningBasePermissions(env, user) {
  if (!user?.role || user.role === "viewer") return { view: false, manage: false };
  if (isAdmin(user)) return { view: true, manage: true };
  // ครูและบุคลากรทุกคนดูรายชื่อได้ (หน้า ระบบสนับสนุน → ฐานการเรียนรู้) · แก้ไขเฉพาะฝ่ายบริหารทั่วไป
  return { view: true, manage: await isGeneralMember(env, user) };
}

async function audit(env, user, action, details) {
  await env.DB.prepare("INSERT INTO audit_logs (user_id, action, resource, resource_id, details) VALUES (?,?,?,?,?)")
    .bind(user.id, action, "learning_bases", null, JSON.stringify(details)).run().catch(() => {});
}

// ปีที่ยังไม่มีฐาน: คัดลอกจากปีล่าสุดก่อนหน้า ไม่มีเลยใช้ชื่อตั้งต้น
async function seedYear(env, year, userId) {
  const has = await env.DB.prepare("SELECT 1 AS x FROM learning_bases WHERE academic_year = ? LIMIT 1").bind(year).first();
  if (has) return;
  const prev = await env.DB.prepare("SELECT MAX(academic_year) AS y FROM learning_bases WHERE academic_year < ?").bind(year).first();
  let rows;
  if (prev?.y) {
    const { results } = await env.DB.prepare("SELECT name, capacity, grades, sort_order, COALESCE(lineage_id, id) AS lineage FROM learning_bases WHERE academic_year = ? AND active = 1 ORDER BY sort_order, id").bind(prev.y).all();
    rows = results || [];
  }
  if (!rows?.length) rows = DEFAULT_BASES.map((name, i) => ({ name, capacity: null, grades: ALL_GRADES.join(","), sort_order: i + 1 }));
  await env.DB.batch(rows.map((r) => env.DB.prepare(`INSERT OR IGNORE INTO learning_bases (academic_year, name, capacity, grades, sort_order, lineage_id, updated_by) VALUES (?,?,?,?,?,?,?)`)
    .bind(year, r.name, r.capacity ?? null, r.grades || ALL_GRADES.join(","), r.sort_order || 0, r.lineage ?? null, userId)));
}

async function loadBases(env, year) {
  const { results } = await env.DB.prepare("SELECT id, name, capacity, grades, sort_order, COALESCE(lineage_id, id) AS lineage FROM learning_bases WHERE academic_year = ? AND active = 1 ORDER BY sort_order, id").bind(year).all();
  return (results || []).map((b) => ({ id: b.id, name: b.name, capacity: b.capacity == null ? null : Number(b.capacity), grades: parseGrades(b.grades), sort_order: b.sort_order, lineage: Number(b.lineage) }));
}

const nameKey = (v) => String(v ?? "").replace(/\s+/g, "").toLowerCase();
// ห้ามซ้ำฐานเดิมจนจบ ป.6: ฐานปีนี้ที่นักเรียนเคยอยู่ในปีก่อน ๆ (จับคู่ฐานต้นทางหรือชื่อเดียวกัน)
// คืน Map(student_id → { blocked:Set(base_id ปีนี้), past:[{year,name}] })
async function pastBases(env, year, bases) {
  const { results } = await env.DB.prepare(`SELECT m.student_id, m.academic_year, b.name, COALESCE(b.lineage_id, b.id) AS lineage
    FROM learning_base_members m JOIN learning_bases b ON b.id = m.base_id WHERE m.academic_year < ? ORDER BY m.academic_year`).bind(year).all();
  const byLineage = new Map(), byName = new Map();
  for (const b of bases) { byLineage.set(b.lineage, b.id); byName.set(nameKey(b.name), b.id); }
  const map = new Map();
  for (const r of results || []) {
    if (!map.has(r.student_id)) map.set(r.student_id, { blocked: new Set(), past: [] });
    const x = map.get(r.student_id);
    x.past.push({ year: Number(r.academic_year), name: r.name });
    for (const id of [byLineage.get(Number(r.lineage)), byName.get(nameKey(r.name))]) if (id) x.blocked.add(id);
  }
  return map;
}

// นักเรียนปัจจุบัน ป.1–6 ที่กำลังศึกษา (ทะเบียนกลาง)
async function currentStudents(env) {
  let rows;
  try {
    ({ results: rows } = await env.DB.prepare(`SELECT s.id, s.student_code, s.full_name, s.grade_level, s.classroom, d.gender
      FROM students s LEFT JOIN student_details d ON d.student_id = s.id WHERE s.status = 'enrolled'`).all());
  } catch {
    ({ results: rows } = await env.DB.prepare("SELECT id, student_code, full_name, grade_level, classroom, NULL AS gender FROM students WHERE status = 'enrolled'").all());
  }
  return (rows || []).map((s) => ({ ...s, grade: gradeNumber(s.grade_level), sex: genderOf(s.gender, s.full_name) })).filter((s) => s.grade);
}

async function loadMembers(env, year) {
  const { results } = await env.DB.prepare(`SELECT m.student_id, m.base_id, m.locked, m.method, m.grade_level, m.classroom, s.student_code, s.full_name
    FROM learning_base_members m JOIN students s ON s.id = m.student_id WHERE m.academic_year = ?`).bind(year).all();
  return results || [];
}

const publicStudent = (s) => ({ id: s.id, student_code: s.student_code, full_name: s.full_name, grade_level: s.grade_level, classroom: s.classroom, gender: s.sex || "" });

// GET /api/learning-bases?academic_year=2569
async function handleList(request, env, user, perm) {
  const current = await activeYear(env);
  const year = parseYear(new URL(request.url).searchParams.get("academic_year")) || current;
  if (year === current) await seedYear(env, year, user.id);
  const [bases, members] = await Promise.all([loadBases(env, year), loadMembers(env, year)]);
  let students;
  if (year === current) students = (await currentStudents(env)).map(publicStudent);
  else students = members.map((m) => ({ id: m.student_id, student_code: m.student_code, full_name: m.full_name, grade_level: m.grade_level, classroom: m.classroom, gender: genderOf(null, m.full_name) }));
  const { results: yearRows } = await env.DB.prepare("SELECT DISTINCT academic_year FROM learning_bases ORDER BY academic_year DESC").all();
  // ผู้จัดฐาน: ฐานที่นักเรียนแต่ละคนเคยอยู่ (ซ่อนจากตัวเลือก เพราะห้ามซ้ำจนจบ ป.6)
  let history;
  if (perm.manage && year === current) {
    history = {};
    for (const [sid, x] of await pastBases(env, year, bases)) history[sid] = { blocked: [...x.blocked], past: x.past };
  }
  return jsonResponse({
    academic_year: year, current_year: current,
    years: [...new Set([current, ...(yearRows || []).map((r) => Number(r.academic_year))])].sort((a, b) => b - a),
    bases, students,
    members: members.map((m) => ({ student_id: m.student_id, base_id: m.base_id, locked: Number(m.locked), method: m.method })),
    methods: ASSIGN_METHODS,
    ...(history ? { history } : {}),
    permissions: { manage: perm.manage && year === current },
  });
}

function requireCurrent(year, current) {
  return year === current ? null : jsonResponse({ error: "แก้ไขได้เฉพาะปีการศึกษาปัจจุบัน" }, 400);
}

// PUT /api/learning-bases/bases { academic_year, bases:[{id?, name, capacity, grades}] } — รายการฐานทั้งหมดของปี (ไม่อยู่ในรายการ = ปิดฐาน)
async function handleSaveBases(request, env, user) {
  const body = await readJson(request);
  const current = await activeYear(env);
  const year = parseYear(body?.academic_year);
  if (!year || !Array.isArray(body?.bases)) return jsonResponse({ error: "รูปแบบข้อมูลไม่ถูกต้อง" }, 400);
  const bad = requireCurrent(year, current); if (bad) return bad;
  if (!body.bases.length) return jsonResponse({ error: "ต้องมีอย่างน้อย 1 ฐาน" }, 400);
  if (body.bases.length > MAX_BASES) return jsonResponse({ error: `มีได้ไม่เกิน ${MAX_BASES} ฐาน` }, 400);
  const clean = [];
  const names = new Set();
  for (const [i, b] of body.bases.entries()) {
    const name = String(b?.name ?? "").replace(/\s+/g, " ").trim().slice(0, 80);
    if (!name) return jsonResponse({ error: `ฐานลำดับที่ ${i + 1} ยังไม่มีชื่อ` }, 400);
    if (names.has(name)) return jsonResponse({ error: `ชื่อฐาน "${name}" ซ้ำ` }, 400);
    names.add(name);
    const capRaw = String(b?.capacity ?? "").trim();
    const capacity = capRaw ? Number(capRaw) : null;
    if (capacity !== null && (!Number.isInteger(capacity) || capacity < 1 || capacity > 999)) return jsonResponse({ error: `จำนวนรับของ "${name}" ต้องเป็นจำนวนเต็ม 1–999 หรือเว้นว่าง` }, 400);
    const grades = parseGrades(b?.grades);
    if (!grades.length) return jsonResponse({ error: `"${name}" ต้องรับอย่างน้อย 1 ชั้น` }, 400);
    clean.push({ id: Number(b?.id) || null, name, capacity, grades: grades.join(","), sort_order: i + 1 });
  }
  const { results: existing } = await env.DB.prepare("SELECT id, name, active FROM learning_bases WHERE academic_year = ?").bind(year).all();
  const byId = new Map((existing || []).map((b) => [b.id, b]));
  const byName = new Map((existing || []).map((b) => [b.name, b]));
  const keep = new Set();
  const statements = [];
  // ย้ายชื่อเดิมออกชั่วคราวกันชน UNIQUE ตอนสลับชื่อกัน
  for (const b of clean) if (b.id && byId.has(b.id)) statements.push(env.DB.prepare("UPDATE learning_bases SET name = ? WHERE id = ?").bind(`__tmp_${b.id}`, b.id));
  for (const b of clean) {
    let id = b.id && byId.has(b.id) ? b.id : null;
    const sameName = byName.get(b.name);
    if (!id && sameName && !clean.some((x) => x.id === sameName.id)) id = sameName.id; // เปิดฐานชื่อเดิมที่เคยปิดกลับมา
    if (id) {
      keep.add(id);
      statements.push(env.DB.prepare("UPDATE learning_bases SET name = ?, capacity = ?, grades = ?, sort_order = ?, active = 1, updated_by = ?, updated_at = datetime('now') WHERE id = ?")
        .bind(b.name, b.capacity, b.grades, b.sort_order, user.id, id));
    } else {
      statements.push(env.DB.prepare("INSERT INTO learning_bases (academic_year, name, capacity, grades, sort_order, updated_by) VALUES (?,?,?,?,?,?)")
        .bind(year, b.name, b.capacity, b.grades, b.sort_order, user.id));
    }
  }
  const closed = (existing || []).filter((b) => b.active && !keep.has(b.id)).map((b) => b.id);
  for (const id of closed) {
    statements.push(env.DB.prepare("UPDATE learning_bases SET active = 0, updated_by = ?, updated_at = datetime('now') WHERE id = ?").bind(user.id, id));
    statements.push(env.DB.prepare("DELETE FROM learning_base_members WHERE academic_year = ? AND base_id = ?").bind(year, id));
  }
  try { await env.DB.batch(statements); }
  catch (e) { return jsonResponse({ error: /UNIQUE/i.test(String(e?.message)) ? "ชื่อฐานซ้ำกับฐานที่ปิดไว้ — เปลี่ยนชื่อแล้วลองใหม่" : "บันทึกไม่สำเร็จ" }, 400); }
  // ชั้นที่ฐานไม่รับแล้ว: นักเรียนชั้นนั้นกลับเป็น "ยังไม่มีฐาน"
  const bases = await loadBases(env, year);
  const members = await loadMembers(env, year);
  const allowed = new Map(bases.map((b) => [b.id, b.grades]));
  const invalid = members.filter((m) => !allowed.get(m.base_id)?.includes(gradeNumber(m.grade_level)));
  if (invalid.length) await env.DB.batch(invalid.map((m) => env.DB.prepare("DELETE FROM learning_base_members WHERE academic_year = ? AND student_id = ?").bind(year, m.student_id)));
  await audit(env, user, "save_bases", { academic_year: year, count: clean.length, closed: closed.length, released: invalid.length });
  return jsonResponse({ ok: true, bases, closed: closed.length, released: invalid.length });
}

function insertMembers(env, year, rows, method, locked, userId) {
  const statements = [];
  for (let i = 0; i < rows.length; i += 12) {
    const chunk = rows.slice(i, i + 12);
    statements.push(env.DB.prepare(`INSERT INTO learning_base_members (student_id, academic_year, base_id, grade_level, classroom, method, locked, updated_by)
      VALUES ${chunk.map(() => "(?,?,?,?,?,?,?,?)").join(",")}
      ON CONFLICT(student_id, academic_year) DO UPDATE SET base_id = excluded.base_id, grade_level = excluded.grade_level, classroom = excluded.classroom,
        method = excluded.method, locked = excluded.locked, updated_by = excluded.updated_by, updated_at = datetime('now')`)
      .bind(...chunk.flatMap((r) => [r.student_id, year, r.base_id, r.grade_level, r.classroom, method, locked, userId])));
  }
  return statements;
}

// POST /api/learning-bases/auto { academic_year, method, scope:'all'|'unassigned', keep_locked, seed, apply }
// apply=false → ดูตัวอย่าง (ไม่บันทึก) · apply=true → บันทึก (seed เดิมได้ผลเดิม)
async function handleAuto(request, env, user) {
  const body = await readJson(request);
  const current = await activeYear(env);
  const year = parseYear(body?.academic_year);
  if (!year) return jsonResponse({ error: "กรุณาระบุปีการศึกษา" }, 400);
  const bad = requireCurrent(year, current); if (bad) return bad;
  const method = String(body?.method || "");
  if (!ASSIGN_METHODS[method]) return jsonResponse({ error: "กรุณาเลือกวิธีจัด" }, 400);
  const scope = body?.scope === "unassigned" ? "unassigned" : "all";
  const keepLocked = body?.keep_locked !== false;
  const seed = Number.isInteger(Number(body?.seed)) && Number(body.seed) > 0 ? Number(body.seed) : Math.floor(Math.random() * 1e9) + 1;
  const [bases, students, members] = await Promise.all([loadBases(env, year), currentStudents(env), loadMembers(env, year)]);
  if (!bases.length) return jsonResponse({ error: "ยังไม่มีฐานการเรียนรู้" }, 400);
  const studentIds = new Set(students.map((s) => s.id));
  const baseIds = new Set(bases.map((b) => b.id));
  const fixed = new Map();
  for (const m of members) {
    if (!studentIds.has(m.student_id) || !baseIds.has(m.base_id)) continue;
    if (scope === "unassigned" || (keepLocked && Number(m.locked))) fixed.set(m.student_id, m.base_id);
  }
  const history = await pastBases(env, year, bases);
  const input = students.map((s) => ({ id: s.id, grade: s.grade, room: String(s.classroom ?? "").trim(), gender: s.sex, blocked: history.get(s.id)?.blocked }));
  const { assignments, unplaced } = assignLearningBases({ students: input, bases, fixed, method, seed });
  const result = { ok: true, seed, method, scope, placed: assignments.size, kept: fixed.size, unplaced: unplaced.length,
    assignments: [...assignments].map(([student_id, base_id]) => ({ student_id, base_id })), unplaced_ids: unplaced };
  if (!body?.apply) return jsonResponse({ ...result, preview: true });
  const byId = new Map(students.map((s) => [s.id, s]));
  const rows = [...assignments].map(([sid, bid]) => ({ student_id: sid, base_id: bid, grade_level: byId.get(sid).grade_level, classroom: byId.get(sid).classroom }));
  const statements = [];
  if (scope === "all") {
    statements.push(keepLocked
      ? env.DB.prepare("DELETE FROM learning_base_members WHERE academic_year = ? AND locked = 0").bind(year)
      : env.DB.prepare("DELETE FROM learning_base_members WHERE academic_year = ?").bind(year));
  }
  statements.push(...insertMembers(env, year, rows, method, 0, user.id));
  await env.DB.batch(statements);
  await audit(env, user, "auto_assign", { academic_year: year, method, scope, keep_locked: keepLocked, seed, placed: rows.length, unplaced: unplaced.length });
  return jsonResponse({ ...result, preview: false });
}

// PUT /api/learning-bases/members { academic_year, student_id, base_id|null, force } — จัดเองรายคน (ล็อกไว้ไม่ให้จัดอัตโนมัติทับ)
async function handleSetMember(request, env, user) {
  const body = await readJson(request);
  const current = await activeYear(env);
  const year = parseYear(body?.academic_year);
  if (!year) return jsonResponse({ error: "กรุณาระบุปีการศึกษา" }, 400);
  const bad = requireCurrent(year, current); if (bad) return bad;
  const studentId = Number(body?.student_id);
  const student = (await currentStudents(env)).find((s) => s.id === studentId);
  if (!student) return jsonResponse({ error: "ไม่พบนักเรียน ป.1–6 ที่กำลังศึกษา" }, 404);
  if (body?.base_id == null || body.base_id === "") {
    await env.DB.prepare("DELETE FROM learning_base_members WHERE academic_year = ? AND student_id = ?").bind(year, studentId).run();
    await audit(env, user, "clear_member", { academic_year: year, student_id: studentId });
    return jsonResponse({ ok: true });
  }
  const base = (await loadBases(env, year)).find((b) => b.id === Number(body.base_id));
  if (!base) return jsonResponse({ error: "ไม่พบฐานการเรียนรู้" }, 404);
  if (!base.grades.includes(student.grade)) return jsonResponse({ error: `ฐาน "${base.name}" ไม่รับชั้น ป.${student.grade}` }, 400);
  const past = (await pastBases(env, year, [base])).get(studentId);
  if (past?.blocked.has(base.id)) {
    const when = past.past.filter((p) => nameKey(p.name) === nameKey(base.name)).map((p) => p.year).join(", ");
    return jsonResponse({ error: `นักเรียนเคยอยู่ฐาน "${base.name}" แล้ว${when ? ` (ปี ${when})` : ""} — ห้ามซ้ำฐานเดิมจนจบ ป.6`, repeat: true }, 400);
  }
  if (base.capacity && !body.force) {
    const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM learning_base_members WHERE academic_year = ? AND base_id = ? AND student_id <> ?").bind(year, base.id, studentId).first();
    if (Number(row?.n) >= base.capacity) return jsonResponse({ error: `ฐาน "${base.name}" เต็มแล้ว (${base.capacity} คน)`, full: true }, 409);
  }
  await env.DB.batch(insertMembers(env, year, [{ student_id: studentId, base_id: base.id, grade_level: student.grade_level, classroom: student.classroom }], "manual", 1, user.id));
  await audit(env, user, "set_member", { academic_year: year, student_id: studentId, base_id: base.id });
  return jsonResponse({ ok: true });
}

export async function handleLearningBasesRoute(request, env, pathname, method) {
  if (!pathname.startsWith("/api/learning-bases")) return null;
  const user = await getCurrentUser(request, env);
  if (!user || !user.role) return jsonResponse({ error: "กรุณาเข้าสู่ระบบ" }, 401);
  const perm = await learningBasePermissions(env, user);
  if (!perm.view) return jsonResponse({ error: "ไม่มีสิทธิ์ดูข้อมูลนี้" }, 403);
  await ensureLearningBaseSchema(env);
  if (pathname === "/api/learning-bases" && method === "GET") return handleList(request, env, user, perm);
  if (!perm.manage) return jsonResponse({ error: "แก้ไขได้เฉพาะฝ่ายบริหารทั่วไปและผู้ดูแลระบบ" }, 403);
  if (pathname === "/api/learning-bases/bases" && method === "PUT") return handleSaveBases(request, env, user);
  if (pathname === "/api/learning-bases/auto" && method === "POST") return handleAuto(request, env, user);
  if (pathname === "/api/learning-bases/members" && method === "PUT") return handleSetMember(request, env, user);
  return jsonResponse({ error: "ไม่พบเส้นทาง" }, 404);
}
