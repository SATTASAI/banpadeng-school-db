// ทุนการศึกษา (ระบบสนับสนุน) — รายชื่อนักเรียนที่ได้รับทุน แยกตามหัวข้อทุน ปีการศึกษา และครั้งที่ได้รับ (สูงสุด 3 ครั้งต่อปี)
// คอลัมน์ term ในตาราง = ครั้งที่ 1–3 · ข้อมูลปีการศึกษาก่อนปีที่เปิดใช้ถูกลบอัตโนมัติเมื่อขึ้นปีใหม่
// หัวข้อทุนคงที่: กสศ. (ทุนปัจจัยพื้นฐานนักเรียนยากจน) และ ทุนอุดหนุน · หัวข้อ "ทุนอื่น ๆ" สร้างเพิ่มได้เอง
// ดู: ผู้รับผิดชอบงานทุน, ผู้บริหาร/ผู้ดูแลระบบ (ทุกห้อง) และครูประจำชั้น (เฉพาะห้องของตน)
// นำเข้า/แก้ไข: ผู้รับผิดชอบงานทุน (budget_role_assignments role_key 'scholarship_officer') และ superadmin
// ข้อมูลนักเรียนอ้างอิงตาราง students ที่ระบบรายงานผลการเรียนเป็นเจ้าของ (ใช้ D1 ร่วมกัน)
import { getCurrentUser, isAdmin, jsonResponse } from "../lib/auth.js";
import { homeroomRooms, roomKey } from "../lib/student-access.js";

export const SCHOLARSHIP_ROLES = { scholarship_officer: "ผู้รับผิดชอบงานทุนการศึกษา" };
export const FIXED_TYPES = [
  { code: "eef", name: "ทุนปัจจัยพื้นฐานนักเรียนยากจน (กสศ.)", sort: 1 },
  { code: "subsidy", name: "ทุนอุดหนุน", sort: 2 },
];
const MAX_BATCH = 500;

const ready = new WeakSet();
export async function ensureScholarshipSchema(env) {
  if (ready.has(env.DB)) return;
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS scholarship_types (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    code TEXT UNIQUE,
    name TEXT NOT NULL,
    sort_order INTEGER NOT NULL DEFAULT 100,
    created_by INTEGER,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`).run();
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS scholarship_awards (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    type_id INTEGER NOT NULL REFERENCES scholarship_types(id) ON DELETE CASCADE,
    student_id INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
    academic_year INTEGER NOT NULL CHECK (academic_year BETWEEN 2500 AND 2700),
    term INTEGER NOT NULL CHECK (term BETWEEN 1 AND 3),
    amount REAL,
    notes TEXT,
    source TEXT,
    updated_by INTEGER,
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE (type_id, student_id, academic_year, term)
  )`).run();
  // ตารางรุ่นแรกจำกัดภาคเรียน 1–2: สร้างใหม่ให้รับครั้งที่ 1–3 (ข้อมูลเดิมย้ายตามเลขเดิม)
  const def = await env.DB.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='scholarship_awards'").first().catch(() => null);
  if (def?.sql && /term IN \(1,\s*2\)/.test(def.sql)) {
    // ทีละคำสั่ง (ตารางใหม่ต้องมีอยู่ก่อนเตรียมคำสั่งคัดลอก) · เริ่มจากล้างตารางชั่วคราวที่ค้างจากรอบที่ล้มเหลว
    await env.DB.prepare("DROP TABLE IF EXISTS scholarship_awards_v2").run();
    for (const sql of [
      `CREATE TABLE scholarship_awards_v2 (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        type_id INTEGER NOT NULL REFERENCES scholarship_types(id) ON DELETE CASCADE,
        student_id INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
        academic_year INTEGER NOT NULL CHECK (academic_year BETWEEN 2500 AND 2700),
        term INTEGER NOT NULL CHECK (term BETWEEN 1 AND 3),
        amount REAL, notes TEXT, source TEXT, updated_by INTEGER,
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE (type_id, student_id, academic_year, term))`,
      "INSERT INTO scholarship_awards_v2 SELECT id, type_id, student_id, academic_year, term, amount, notes, source, updated_by, updated_at FROM scholarship_awards",
      "DROP TABLE scholarship_awards",
      "ALTER TABLE scholarship_awards_v2 RENAME TO scholarship_awards",
    ]) await env.DB.prepare(sql).run();
  }
  await env.DB.prepare("CREATE INDEX IF NOT EXISTS idx_scholarship_awards_period ON scholarship_awards(academic_year, term, type_id)").run();
  for (const t of FIXED_TYPES) {
    await env.DB.prepare("INSERT OR IGNORE INTO scholarship_types (code, name, sort_order) VALUES (?,?,?)").bind(t.code, t.name, t.sort).run();
  }
  ready.add(env.DB);
}

// ---------- แปลงค่า ----------
export function parseYear(value) {
  const n = Number(String(value ?? "").trim());
  if (!Number.isInteger(n)) return null;
  const be = n < 2500 ? n + 543 : n;
  return be >= 2500 && be <= 2700 ? be : null;
}
// ครั้งที่ได้รับทุน 1–3
export const MAX_ROUNDS = 3;
export function parseRound(value) {
  const n = Number(String(value ?? "").trim());
  return Number.isInteger(n) && n >= 1 && n <= MAX_ROUNDS ? n : null;
}
const parseTerm = (v) => { const n = Number(String(v ?? "").trim()); return n === 1 || n === 2 ? n : null; };
// "1,500.00 บาท" → 1500 · ว่าง → null · ผิด → undefined
export function parseAmount(value) {
  if (value === null || value === undefined) return null;
  const raw = String(value).replace(/[,\s฿]|บาท/g, "");
  if (!raw || raw === "-") return null;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 && n < 1e8 ? Math.round(n * 100) / 100 : undefined;
}
const digits = (v) => String(v ?? "").replace(/\D/g, "");
// เลขบัตรประชาชน 13 หลัก หรือเลขประจำตัว G… ของนักเรียนไม่มีสัญชาติ
const idKey = (v) => String(v ?? "").toUpperCase().replace(/[^0-9A-Z]/g, "");
const PREFIX = /^(เด็กชาย|เด็กหญิง|ด\.?\s?ช\.?|ด\.?\s?ญ\.?|นางสาว|น\.?\s?ส\.?|นาย|นาง|master|miss|mr\.?|mrs\.?|ms\.?)\s*/i;
// ชื่อสำหรับเทียบ: ตัดคำนำหน้า ช่องว่าง จุด และอักขระล่องหน
export function normalizeName(value) {
  let s = String(value ?? "").normalize("NFC").replace(/[​-‍﻿]/g, "").trim();
  s = s.replace(PREFIX, "");
  return s.replace(/[\s.·\-_'"]/g, "").replace(/ํา/g, "ำ").toLowerCase();
}
function similarity(a, b) {
  if (!a || !b) return 0;
  if (a === b) return 1;
  const m = a.length, n = b.length;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return 1 - prev[n] / Math.max(m, n);
}

// จับคู่แถวจากไฟล์กับนักเรียน: เลขบัตรประชาชน → เลขประจำตัว → ชื่อ (ตรงทุกตัว) → ชื่อใกล้เคียง (แนะนำ)
export function matchRows(rows, students) {
  const byNid = new Map(), byCode = new Map(), byName = new Map();
  const enrolledFirst = [...students].sort((a, b) => (a.status === "enrolled" ? 0 : 1) - (b.status === "enrolled" ? 0 : 1));
  for (const s of enrolledFirst) {
    const nid = idKey(s.national_id);
    if (nid.length === 13 && !byNid.has(nid)) byNid.set(nid, s);
    const code = String(s.student_code ?? "").trim();
    if (code && !byCode.has(code)) byCode.set(code, s);
    if (code && !byCode.has(code.replace(/^0+/, ""))) byCode.set(code.replace(/^0+/, ""), s);
    const nm = normalizeName(s.full_name);
    if (nm) { if (!byName.has(nm)) byName.set(nm, []); byName.get(nm).push(s); }
  }
  const names = [...byName.entries()];
  return rows.map((row) => {
    const nid = idKey(row?.national_id);
    if (nid.length === 13 && byNid.has(nid)) return { student_id: byNid.get(nid).id, method: "national_id" };
    const code = String(row?.student_code ?? "").trim();
    if (code && (byCode.has(code) || byCode.has(code.replace(/^0+/, "")))) return { student_id: (byCode.get(code) || byCode.get(code.replace(/^0+/, ""))).id, method: "student_code" };
    const nm = normalizeName(row?.name);
    if (nm) {
      const exact = byName.get(nm);
      if (exact?.length === 1) return { student_id: exact[0].id, method: "name" };
      if (exact?.length > 1) return { student_id: null, method: "ambiguous", candidates: exact.slice(0, 5).map((s) => s.id) };
      if (nm.length >= 4) {
        const scored = names.map(([k, list]) => [similarity(nm, k), list]).filter(([sc]) => sc >= 0.8).sort((a, b) => b[0] - a[0]).slice(0, 3);
        if (scored.length) return { student_id: null, method: "suggest", candidates: scored.flatMap(([, l]) => l).slice(0, 5).map((s) => s.id), score: Math.round(scored[0][0] * 100) };
      }
    }
    return { student_id: null, method: "none" };
  });
}

// ---------- สิทธิ์ ----------
async function officer(env) {
  let row = null;
  try {
    row = await env.DB.prepare(`SELECT a.user_id, u.full_name FROM budget_role_assignments a JOIN users u ON u.id = a.user_id
      WHERE a.role_key = 'scholarship_officer' AND a.department = '' AND u.status = 'active' AND u.deleted_at IS NULL`).first();
  } catch { row = null; }
  return row ? { id: Number(row.user_id), name: row.full_name } : null;
}
export async function scholarshipAccess(env, user) {
  const off = await officer(env);
  const isOfficer = Number(off?.id) === Number(user?.id);
  const manage = user?.role === "superadmin" || isOfficer;
  const viewAll = manage || isAdmin(user);
  const homerooms = viewAll ? [] : [...await homeroomRooms(env, user.id)];
  return { manage, view_all: viewAll, homerooms, view: viewAll || homerooms.length > 0, officer: off ? { name: off.name } : null };
}

async function activePeriod(env) {
  const year = await env.DB.prepare("SELECT id, year_be FROM academic_years WHERE status = 'active' ORDER BY year_be DESC LIMIT 1").first().catch(() => null);
  let term = null;
  if (year?.id) term = await env.DB.prepare("SELECT term_number FROM academic_terms WHERE academic_year_id = ? AND status = 'active' ORDER BY term_number DESC LIMIT 1").bind(year.id).first().catch(() => null);
  const now = new Date(Date.now() + 7 * 3600 * 1000);
  const fallbackYear = now.getUTCFullYear() + 543 - (now.getUTCMonth() < 4 ? 1 : 0);
  const fallbackTerm = now.getUTCMonth() >= 4 && now.getUTCMonth() <= 9 ? 1 : 2;
  return { year: Number(year?.year_be) || fallbackYear, term: parseTerm(term?.term_number) || fallbackTerm };
}

async function readJson(request) { try { return await request.json(); } catch { return null; } }
async function audit(env, user, action, details) {
  await env.DB.prepare("INSERT INTO audit_logs (user_id, action, resource, resource_id, details) VALUES (?,?,?,?,?)")
    .bind(user.id, action, "scholarship", null, JSON.stringify(details)).run().catch(() => {});
}
async function studentRows(env, withNid) {
  try {
    return (await env.DB.prepare(`SELECT id, student_code, full_name, grade_level, classroom, status${withNid ? ", national_id" : ""} FROM students`).all()).results || [];
  } catch {
    return (await env.DB.prepare("SELECT id, student_code, full_name, grade_level, classroom, status FROM students").all()).results || [];
  }
}
async function typeById(env, id) {
  return env.DB.prepare("SELECT * FROM scholarship_types WHERE id = ?").bind(id).first();
}

// ---------- handlers ----------
// ขึ้นปีการศึกษาใหม่ (มีปีที่เปิดใช้ในระบบ) → ลบข้อมูลทุนของปีก่อนหน้าทั้งหมด ทำครั้งเดียวต่อปีต่อ isolate
const purged = new WeakMap();
async function purgeOldYears(env, user) {
  const row = await env.DB.prepare("SELECT year_be FROM academic_years WHERE status = 'active' ORDER BY year_be DESC LIMIT 1").first().catch(() => null);
  const year = Number(row?.year_be);
  if (!year || purged.get(env.DB) === year) return;
  const r = await env.DB.prepare("DELETE FROM scholarship_awards WHERE academic_year < ?").bind(year).run();
  purged.set(env.DB, year);
  if (r?.meta?.changes) await audit(env, user, "purge_old_years", { before_year: year, deleted: r.meta.changes });
}

// GET /api/scholarships?academic_year=2569 — ทุกครั้ง (1–3) ของปีนั้น; client แยกรายครั้ง/รวมทั้งปี
async function handleList(request, env, user, access) {
  if (!access.view) return jsonResponse({ error: "ไม่มีสิทธิ์ดูข้อมูลทุนการศึกษา" }, 403);
  await purgeOldYears(env, user);
  const url = new URL(request.url);
  const current = await activePeriod(env);
  const year = parseYear(url.searchParams.get("academic_year")) || current.year;
  const { results: types } = await env.DB.prepare("SELECT id, code, name, sort_order FROM scholarship_types ORDER BY sort_order, id").all();
  const { results: awards } = await env.DB.prepare(`SELECT id, type_id, student_id, term AS round, amount, notes, updated_at FROM scholarship_awards
    WHERE academic_year = ? ORDER BY type_id, term, student_id`).bind(year).all();
  const all = await studentRows(env, false);
  const rooms = new Set(access.homerooms);
  const visible = access.view_all ? all : all.filter((s) => rooms.has(roomKey(s.grade_level, s.classroom)));
  const ids = new Set(visible.map((s) => s.id));
  const awarded = new Set((awards || []).map((a) => a.student_id));
  // นักเรียนที่กำลังศึกษา + นักเรียนที่ย้าย/จำหน่ายแล้วแต่มีรายการทุนในปีนี้
  const students = visible.filter((s) => !s.status || s.status === "enrolled" || awarded.has(s.id));
  const { results: yearRows } = await env.DB.prepare("SELECT DISTINCT academic_year FROM scholarship_awards ORDER BY academic_year DESC").all();
  const years = [...new Set([current.year, current.year + 1, ...yearRows.map((r) => Number(r.academic_year))])].sort((a, b) => b - a);
  return jsonResponse({
    academic_year: year, max_rounds: MAX_ROUNDS, current, years,
    types: (types || []).map((t) => ({ ...t, fixed: !!t.code })),
    awards: (awards || []).filter((a) => ids.has(a.student_id)),
    students,
    permissions: { manage: access.manage, view_all: access.view_all, homerooms: access.homerooms, is_admin: isAdmin(user) },
    officer: access.officer,
  });
}

async function handleCreateType(request, env, user) {
  const body = await readJson(request);
  const name = String(body?.name ?? "").trim().slice(0, 150);
  if (!name) return jsonResponse({ error: "กรุณาระบุชื่อหัวข้อทุน" }, 400);
  const dup = await env.DB.prepare("SELECT id FROM scholarship_types WHERE name = ?").bind(name).first();
  if (dup) return jsonResponse({ error: "มีหัวข้อทุนชื่อนี้แล้ว" }, 409);
  const r = await env.DB.prepare("INSERT INTO scholarship_types (name, sort_order, created_by) VALUES (?,?,?)").bind(name, 100, user.id).run();
  await audit(env, user, "create_type", { name });
  return jsonResponse({ ok: true, id: Number(r?.meta?.last_row_id) || null });
}

async function handleUpdateType(request, env, user, id) {
  const type = await typeById(env, id);
  if (!type) return jsonResponse({ error: "ไม่พบหัวข้อทุน" }, 404);
  if (type.code) return jsonResponse({ error: "หัวข้อทุนหลักเปลี่ยนชื่อไม่ได้" }, 400);
  const body = await readJson(request);
  const name = String(body?.name ?? "").trim().slice(0, 150);
  if (!name) return jsonResponse({ error: "กรุณาระบุชื่อหัวข้อทุน" }, 400);
  const dup = await env.DB.prepare("SELECT id FROM scholarship_types WHERE name = ? AND id <> ?").bind(name, id).first();
  if (dup) return jsonResponse({ error: "มีหัวข้อทุนชื่อนี้แล้ว" }, 409);
  await env.DB.prepare("UPDATE scholarship_types SET name = ? WHERE id = ?").bind(name, id).run();
  await audit(env, user, "rename_type", { id, name });
  return jsonResponse({ ok: true });
}

async function handleDeleteType(env, user, id) {
  const type = await typeById(env, id);
  if (!type) return jsonResponse({ error: "ไม่พบหัวข้อทุน" }, 404);
  if (type.code) return jsonResponse({ error: "หัวข้อทุนหลักลบไม่ได้" }, 400);
  await env.DB.batch([
    env.DB.prepare("DELETE FROM scholarship_awards WHERE type_id = ?").bind(id),
    env.DB.prepare("DELETE FROM scholarship_types WHERE id = ?").bind(id),
  ]);
  await audit(env, user, "delete_type", { id, name: type.name });
  return jsonResponse({ ok: true });
}

// POST /api/scholarships/match { rows:[{national_id, student_code, name}] }
async function handleMatch(request, env) {
  const body = await readJson(request);
  if (!body || !Array.isArray(body.rows)) return jsonResponse({ error: "รูปแบบข้อมูลไม่ถูกต้อง" }, 400);
  if (body.rows.length > MAX_BATCH * 2) return jsonResponse({ error: `ตรวจได้ครั้งละไม่เกิน ${MAX_BATCH * 2} แถว` }, 400);
  const students = await studentRows(env, true);
  const matches = matchRows(body.rows, students);
  const used = new Set(matches.flatMap((m) => [m.student_id, ...(m.candidates || [])]).filter(Boolean));
  return jsonResponse({
    matches,
    students: students.filter((s) => used.has(s.id)).map(({ national_id, ...s }) => s),
  });
}

// PUT /api/scholarships/awards { type_id, academic_year, round (1–3), mode:'merge'|'replace', source, records:[{student_id, amount, notes}] }
async function handleSaveAwards(request, env, user) {
  const body = await readJson(request);
  if (!body || !Array.isArray(body.records)) return jsonResponse({ error: "รูปแบบข้อมูลไม่ถูกต้อง" }, 400);
  const typeId = Number(body.type_id), year = parseYear(body.academic_year), term = parseRound(body.round ?? body.term);
  if (!year) return jsonResponse({ error: "กรุณาระบุปีการศึกษา (พ.ศ.)" }, 400);
  if (!term) return jsonResponse({ error: `กรุณาเลือกครั้งที่ 1–${MAX_ROUNDS}` }, 400);
  const current = await activePeriod(env);
  if (year < current.year) return jsonResponse({ error: `ข้อมูลปีการศึกษาก่อน ${current.year} ถูกล้างเมื่อขึ้นปีใหม่ บันทึกย้อนหลังไม่ได้` }, 400);
  if (!Number.isInteger(typeId) || !(await typeById(env, typeId))) return jsonResponse({ error: "ไม่พบหัวข้อทุน" }, 404);
  if (body.records.length > MAX_BATCH) return jsonResponse({ error: `บันทึกได้ครั้งละไม่เกิน ${MAX_BATCH} คน` }, 400);
  const replace = body.mode === "replace";
  if (!body.records.length && !replace) return jsonResponse({ error: "ไม่มีรายการที่จะบันทึก" }, 400);
  const ids = [...new Set(body.records.map((r) => Number(r?.student_id)))];
  if (ids.some((id) => !Number.isInteger(id) || id <= 0)) return jsonResponse({ error: "รหัสนักเรียนไม่ถูกต้อง" }, 400);
  if (ids.length !== body.records.length) return jsonResponse({ error: "มีนักเรียนซ้ำในรายการ กรุณาตรวจสอบ" }, 400);
  const found = new Set();
  for (let i = 0; i < ids.length; i += 90) {
    const chunk = ids.slice(i, i + 90);
    const { results } = await env.DB.prepare(`SELECT id FROM students WHERE id IN (${chunk.map(() => "?").join(",")})`).bind(...chunk).all();
    results.forEach((r) => found.add(r.id));
  }
  if (found.size !== ids.length) return jsonResponse({ error: `ไม่พบนักเรียน ${ids.length - found.size} คน` }, 404);
  const source = String(body.source ?? "").trim().slice(0, 200) || null;
  const statements = [];
  if (replace) statements.push(env.DB.prepare("DELETE FROM scholarship_awards WHERE type_id = ? AND academic_year = ? AND term = ?").bind(typeId, year, term));
  for (const [index, r] of body.records.entries()) {
    const amount = parseAmount(r.amount);
    if (amount === undefined) return jsonResponse({ error: `ยอดเงินแถวที่ ${index + 1} ไม่ถูกต้อง` }, 400);
    const notes = String(r.notes ?? "").trim().slice(0, 300) || null;
    statements.push(env.DB.prepare(`INSERT INTO scholarship_awards (type_id, student_id, academic_year, term, amount, notes, source, updated_by, updated_at)
      VALUES (?,?,?,?,?,?,?,?,datetime('now'))
      ON CONFLICT(type_id, student_id, academic_year, term) DO UPDATE SET amount=excluded.amount, notes=COALESCE(excluded.notes, scholarship_awards.notes),
        source=COALESCE(excluded.source, scholarship_awards.source), updated_by=excluded.updated_by, updated_at=datetime('now')`)
      .bind(typeId, Number(r.student_id), year, term, amount, notes, source, user.id));
  }
  await env.DB.batch(statements);
  await audit(env, user, replace ? "import_replace" : "save", { type_id: typeId, academic_year: year, round: term, count: body.records.length, source });
  return jsonResponse({ ok: true, saved: body.records.length });
}

async function handleUpdateAward(request, env, user, id) {
  const row = await env.DB.prepare("SELECT id FROM scholarship_awards WHERE id = ?").bind(id).first();
  if (!row) return jsonResponse({ error: "ไม่พบรายการ" }, 404);
  const body = await readJson(request);
  const amount = parseAmount(body?.amount);
  if (amount === undefined) return jsonResponse({ error: "ยอดเงินไม่ถูกต้อง" }, 400);
  const notes = String(body?.notes ?? "").trim().slice(0, 300) || null;
  await env.DB.prepare("UPDATE scholarship_awards SET amount = ?, notes = ?, updated_by = ?, updated_at = datetime('now') WHERE id = ?").bind(amount, notes, user.id, id).run();
  await audit(env, user, "update", { id, amount });
  return jsonResponse({ ok: true });
}

async function handleDeleteAward(env, user, id) {
  await env.DB.prepare("DELETE FROM scholarship_awards WHERE id = ?").bind(id).run();
  await audit(env, user, "delete", { id });
  return jsonResponse({ ok: true });
}

export async function handleScholarshipRoute(request, env, pathname, method) {
  if (!pathname.startsWith("/api/scholarships")) return null;
  const user = await getCurrentUser(request, env);
  if (!user || !user.role) return jsonResponse({ error: "กรุณาเข้าสู่ระบบ" }, 401);
  if (user.role === "viewer") return jsonResponse({ error: "บัญชีผู้ชมภายนอกดูข้อมูลทุนการศึกษาไม่ได้" }, 403);
  await ensureScholarshipSchema(env);
  const access = await scholarshipAccess(env, user);
  if (pathname === "/api/scholarships/permissions" && method === "GET") return jsonResponse({ view: access.view, manage: access.manage, view_all: access.view_all });
  if (pathname === "/api/scholarships" && method === "GET") return handleList(request, env, user, access);
  if (!access.manage) return jsonResponse({ error: "นำเข้า/แก้ไขข้อมูลทุนได้เฉพาะครูผู้รับผิดชอบงานทุนและผู้ดูแลระบบ" }, 403);
  if (pathname === "/api/scholarships/types" && method === "POST") return handleCreateType(request, env, user);
  const typeMatch = pathname.match(/^\/api\/scholarships\/types\/(\d+)$/);
  if (typeMatch && method === "PATCH") return handleUpdateType(request, env, user, Number(typeMatch[1]));
  if (typeMatch && method === "DELETE") return handleDeleteType(env, user, Number(typeMatch[1]));
  if (pathname === "/api/scholarships/match" && method === "POST") return handleMatch(request, env);
  if (pathname === "/api/scholarships/awards" && method === "PUT") return handleSaveAwards(request, env, user);
  const awardMatch = pathname.match(/^\/api\/scholarships\/awards\/(\d+)$/);
  if (awardMatch && method === "PATCH") return handleUpdateAward(request, env, user, Number(awardMatch[1]));
  if (awardMatch && method === "DELETE") return handleDeleteAward(env, user, Number(awardMatch[1]));
  return jsonResponse({ error: "ไม่พบเส้นทาง" }, 404);
}

// ---------- ไลบรารีอ่าน PDF / OCR (เสิร์ฟผ่านโดเมนโรงเรียน เพื่อไม่ต้องเปิด CSP ให้โดเมนภายนอก) ----------
const VENDOR = {
  "pdf.min.js": "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js",
  "pdf.worker.min.js": "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js",
  "tesseract.min.js": "https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js",
  "worker.min.js": "https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/worker.min.js",
  "core/tesseract-core-simd-lstm.wasm.js": "https://cdn.jsdelivr.net/npm/tesseract.js-core@5.1.1/tesseract-core-simd-lstm.wasm.js",
  "core/tesseract-core-lstm.wasm.js": "https://cdn.jsdelivr.net/npm/tesseract.js-core@5.1.1/tesseract-core-lstm.wasm.js",
  "core/tesseract-core-simd.wasm.js": "https://cdn.jsdelivr.net/npm/tesseract.js-core@5.1.1/tesseract-core-simd.wasm.js",
  "core/tesseract-core.wasm.js": "https://cdn.jsdelivr.net/npm/tesseract.js-core@5.1.1/tesseract-core.wasm.js",
  "lang/tha.traineddata.gz": "https://cdn.jsdelivr.net/npm/@tesseract.js-data/tha/4.0.0_best_int/tha.traineddata.gz",
  "lang/eng.traineddata.gz": "https://cdn.jsdelivr.net/npm/@tesseract.js-data/eng/4.0.0_best_int/eng.traineddata.gz",
};
export const SCHOLARSHIP_VENDOR_FILES = Object.keys(VENDOR);
export async function handleScholarshipVendor(request, pathname, method) {
  if (!pathname.startsWith("/vendor/ocr/")) return null;
  if (method !== "GET" && method !== "HEAD") return new Response("Method not allowed", { status: 405 });
  const upstream = VENDOR[pathname.slice("/vendor/ocr/".length)];
  if (!upstream) return new Response("Not found", { status: 404 });
  const res = await fetch(upstream, { cf: { cacheEverything: true, cacheTtl: 2592000 } });
  if (!res.ok) return new Response("Upstream error", { status: 502 });
  const type = upstream.endsWith(".gz") ? "application/octet-stream" : "application/javascript; charset=utf-8";
  return new Response(method === "HEAD" ? null : res.body, { headers: { "Content-Type": type, "Cache-Control": "public, max-age=2592000, immutable" } });
}
