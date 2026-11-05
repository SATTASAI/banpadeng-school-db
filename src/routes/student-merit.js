// บันทึกความดี (ระบบสนับสนุน) — 2 งานย่อย
// 1) บันทึกความดี: ครูประจำชั้นบันทึกการทำความดีของนักเรียนห้องตน (วันที่ + ประเภท + รายละเอียด) หรืออัปโหลด xlsx จากแม่แบบ
// 2) บันทึกการเจอเงิน: นักเรียน จำนวนเงิน สถานที่ ภาพถ่าย (Google Drive: บันทึกเจอเงิน / <ปี> / ภาคเรียนที่ <n>)
// สิทธิ์: ครูประจำชั้น = ดู/บันทึกเฉพาะห้องตน · ผู้รับผิดชอบงาน (ตั้งค่าผู้อนุมัติ งานละ 1 คน) + superadmin = ทุกห้อง · ผู้บริหาร = ดูทั้งหมด
// ใช้เพิ่มคะแนนพฤติกรรม: 1 รายการ = +1 คะแนน ใน ps_behavior_records (ระบบ publicservice ใช้ D1 เดียวกัน) ใช้ได้ครั้งเดียวต่อรายการ (ป.1–6 เท่านั้น)
import { getCurrentUser, isAdmin, jsonResponse } from "../lib/auth.js";
import { homeroomRooms, roomKey } from "../lib/student-access.js";

export const MERIT_ROLES = { gooddeed_officer: "ผู้รับผิดชอบงานบันทึกความดี", foundmoney_officer: "ผู้รับผิดชอบงานบันทึกการเจอเงิน" };
const ROLE_OF = { good: "gooddeed_officer", money: "foundmoney_officer" };
export const DEED_CATEGORIES = ["ช่วยเหลือผู้อื่น", "จิตอาสา/บำเพ็ญประโยชน์", "เก็บของได้ส่งคืน", "ซื่อสัตย์สุจริต", "กตัญญูกตเวที", "มีน้ำใจ/แบ่งปัน", "รักษาความสะอาด/ดูแลสิ่งแวดล้อม", "มีวินัย/ประพฤติตนดี", "อื่น ๆ"];
const SCHOOL_FOLDER_ID = "1ZvfJvwRf0sf_k_hcZwNR0lXLdYZlgFI3"; // โฟลเดอร์โรงเรียน (มี "วิจัยในชั้นเรียน", "กิจกรรมโรงเรียน")
const MONEY_FOLDER_NAME = "บันทึกเจอเงิน";
const MAX_BATCH = 300, MAX_PHOTOS = 4, IMAGE_MAX = 10 * 1024 * 1024;
const IMAGE_TYPES = { "image/jpeg": [0xff, 0xd8, 0xff], "image/png": [0x89, 0x50, 0x4e, 0x47], "image/webp": null, "image/heic": null, "image/heif": null };

const ready = new WeakSet();
export async function ensureMeritSchema(env) {
  if (ready.has(env.DB)) return;
  for (const sql of [
    `CREATE TABLE IF NOT EXISTS good_deeds (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      student_id INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
      deed_date TEXT NOT NULL, category TEXT NOT NULL, detail TEXT,
      academic_year INTEGER NOT NULL, term INTEGER NOT NULL,
      ps_record_id INTEGER, created_by INTEGER,
      created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')))`,
    "CREATE INDEX IF NOT EXISTS idx_good_deeds_year ON good_deeds(academic_year, term, student_id)",
    `CREATE TABLE IF NOT EXISTS found_money (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      student_id INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
      found_date TEXT NOT NULL, amount REAL NOT NULL CHECK (amount >= 0), place TEXT, detail TEXT,
      academic_year INTEGER NOT NULL, term INTEGER NOT NULL,
      ps_record_id INTEGER, created_by INTEGER,
      created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')))`,
    "CREATE INDEX IF NOT EXISTS idx_found_money_year ON found_money(academic_year, term, student_id)",
    `CREATE TABLE IF NOT EXISTS found_money_photos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      found_id INTEGER NOT NULL REFERENCES found_money(id) ON DELETE CASCADE,
      drive_file_id TEXT NOT NULL, file_name TEXT, mime_type TEXT, file_size INTEGER,
      created_at TEXT NOT NULL DEFAULT (datetime('now')))`,
    "CREATE TABLE IF NOT EXISTS merit_folders (key TEXT PRIMARY KEY, folder_id TEXT NOT NULL)",
    // ตารางของระบบคะแนนพฤติกรรม (publicservice) — โครงสร้างต้องตรงกับ publicservice/src/lib/schema.js
    `CREATE TABLE IF NOT EXISTS ps_behavior_records (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      academic_year_id INTEGER NOT NULL,
      term_number INTEGER NOT NULL CHECK (term_number IN (1, 2)),
      student_id INTEGER NOT NULL,
      points INTEGER NOT NULL CHECK (points <> 0 AND points BETWEEN -100 AND 100),
      reason TEXT NOT NULL,
      incident_date TEXT,
      created_by INTEGER NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      cancelled_at TEXT, cancelled_by INTEGER, cancel_reason TEXT)`,
  ]) await env.DB.prepare(sql).run();
  ready.add(env.DB);
}

// ---------- แปลงค่า ----------
export function parseDate(value) {
  const text = String(value ?? "").trim();
  if (!text) return null;
  let y, m, d, match;
  if ((match = text.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/))) [, y, m, d] = match.map(Number);
  else if ((match = text.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/))) [, d, m, y] = match.map(Number);
  else return undefined;
  if (y > 2400) y -= 543;
  const date = new Date(Date.UTC(y, m - 1, d));
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== m - 1 || date.getUTCDate() !== d) return undefined;
  return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}
export function parseYear(value) {
  const n = Number(String(value ?? "").trim());
  if (!Number.isInteger(n)) return null;
  const be = n < 2500 ? n + 543 : n;
  return be >= 2500 && be <= 2700 ? be : null;
}
const text = (v, max = 500) => String(v ?? "").trim().slice(0, max) || null;
const PREFIX = /^(เด็กชาย|เด็กหญิง|ด\.?\s?ช\.?|ด\.?\s?ญ\.?|นางสาว|นาย|นาง)\s*/;
export const normName = (v) => String(v ?? "").normalize("NFC").trim().replace(PREFIX, "").replace(/[\s.\-]/g, "").replace(/ํา/g, "ำ");
export const isPrimary = (g) => /^ป\.?\s*[1-6]$/.test(String(g ?? "").trim());
const thaiToday = () => new Date(Date.now() + 7 * 3600 * 1000).toISOString().slice(0, 10);

// ปีการศึกษา/ภาคเรียนจากวันที่: ภาคที่เริ่มก่อนหรือตรงวันนั้นล่าสุด (ช่วงปิดภาคนับเป็นภาคก่อนหน้า) · ไม่มีปฏิทิน = คิดจากเดือน
export async function periodOf(env, date) {
  const row = await env.DB.prepare(`SELECT y.id AS year_id, y.year_be, t.term_number FROM academic_terms t JOIN academic_years y ON y.id = t.academic_year_id
    WHERE t.start_date <= ? ORDER BY t.start_date DESC LIMIT 1`).bind(date).first().catch(() => null);
  if (row?.year_be && (row.term_number === 1 || row.term_number === 2)) return { year: Number(row.year_be), term: Number(row.term_number), year_id: row.year_id };
  const [y, m] = date.split("-").map(Number);
  const year = y + 543 - (m < 5 ? 1 : 0), term = m >= 5 && m <= 10 ? 1 : 2;
  const yr = await env.DB.prepare("SELECT id FROM academic_years WHERE year_be = ?").bind(year).first().catch(() => null);
  return { year, term, year_id: yr?.id ?? null };
}
async function currentYear(env) {
  const row = await env.DB.prepare("SELECT year_be FROM academic_years WHERE status = 'active' ORDER BY year_be DESC LIMIT 1").first().catch(() => null);
  return Number(row?.year_be) || (await periodOf(env, thaiToday())).year;
}

// ---------- สิทธิ์ ----------
async function officerId(env, roleKey) {
  try {
    const row = await env.DB.prepare(`SELECT a.user_id, u.full_name FROM budget_role_assignments a JOIN users u ON u.id = a.user_id
      WHERE a.role_key = ? AND a.department = '' AND u.status = 'active' AND u.deleted_at IS NULL`).bind(roleKey).first();
    return row ? { id: Number(row.user_id), name: row.full_name } : null;
  } catch { return null; }
}
export async function meritAccess(env, user, kind) {
  const off = await officerId(env, ROLE_OF[kind]);
  const manageAll = user?.role === "superadmin" || Number(off?.id) === Number(user?.id);
  const viewAll = manageAll || isAdmin(user);
  const homerooms = viewAll ? [] : [...await homeroomRooms(env, user.id)];
  return { manage_all: manageAll, view_all: viewAll, homerooms, view: viewAll || homerooms.length > 0, officer: off ? { name: off.name } : null };
}
const canEdit = (access, s) => !!s && (access.manage_all || access.homerooms.includes(roomKey(s.grade_level, s.classroom)));

async function studentsByIds(env, ids) {
  const out = new Map();
  for (let i = 0; i < ids.length; i += 90) {
    const chunk = ids.slice(i, i + 90);
    const { results } = await env.DB.prepare(`SELECT id, student_code, full_name, grade_level, classroom, status FROM students WHERE id IN (${chunk.map(() => "?").join(",")})`).bind(...chunk).all();
    for (const s of results) out.set(s.id, s);
  }
  return out;
}
async function visibleStudents(env, access) {
  const { results } = await env.DB.prepare("SELECT id, student_code, full_name, grade_level, classroom, status FROM students").all();
  const rooms = new Set(access.homerooms);
  return access.view_all ? results : results.filter((s) => rooms.has(roomKey(s.grade_level, s.classroom)));
}
async function readJson(request) { try { return await request.json(); } catch { return null; } }
async function audit(env, user, action, details) {
  await env.DB.prepare("INSERT INTO audit_logs (user_id, action, resource, resource_id, details) VALUES (?,?,?,?,?)")
    .bind(user.id, action, "student_merit", null, JSON.stringify(details)).run().catch(() => {});
}
// รายการที่ใช้เพิ่มคะแนนแล้ว: มี ps_record_id และรายการคะแนนนั้นยังไม่ถูกยกเลิก
const PS_JOIN = "LEFT JOIN ps_behavior_records p ON p.id = r.ps_record_id";
const PS_COLS = "CASE WHEN r.ps_record_id IS NOT NULL AND p.id IS NOT NULL AND p.cancelled_at IS NULL THEN 1 ELSE 0 END AS points_used";

async function listPayload(env, user, access, kind, year) {
  const all = await visibleStudents(env, access);
  const ids = new Set(all.map((s) => s.id));
  const sql = kind === "good"
    ? `SELECT r.id, r.student_id, r.deed_date AS date, r.category, r.detail, r.term, r.created_at, ${PS_COLS} FROM good_deeds r ${PS_JOIN} WHERE r.academic_year = ? ORDER BY r.deed_date DESC, r.id DESC`
    : `SELECT r.id, r.student_id, r.found_date AS date, r.amount, r.place, r.detail, r.term, r.created_at, ${PS_COLS} FROM found_money r ${PS_JOIN} WHERE r.academic_year = ? ORDER BY r.found_date DESC, r.id DESC`;
  const records = ((await env.DB.prepare(sql).bind(year).all()).results || []).filter((r) => ids.has(r.student_id));
  if (kind === "money" && records.length) {
    const photos = new Map();
    const rids = records.map((r) => r.id);
    for (let i = 0; i < rids.length; i += 90) {
      const chunk = rids.slice(i, i + 90);
      const { results } = await env.DB.prepare(`SELECT id, found_id FROM found_money_photos WHERE found_id IN (${chunk.map(() => "?").join(",")}) ORDER BY id`).bind(...chunk).all();
      for (const p of results) { if (!photos.has(p.found_id)) photos.set(p.found_id, []); photos.get(p.found_id).push(p.id); }
    }
    records.forEach((r) => { r.photos = photos.get(r.id) || []; });
  }
  const used = new Set(records.map((r) => r.student_id));
  const current = await currentYear(env);
  const table = kind === "good" ? "good_deeds" : "found_money";
  const { results: yr } = await env.DB.prepare(`SELECT DISTINCT academic_year FROM ${table} ORDER BY academic_year DESC`).all();
  return {
    kind, academic_year: year, current_year: current,
    years: [...new Set([current, ...yr.map((r) => Number(r.academic_year))])].sort((a, b) => b - a),
    categories: DEED_CATEGORIES, records,
    students: all.filter((s) => !s.status || s.status === "enrolled" || used.has(s.id)),
    permissions: { manage_all: access.manage_all, view_all: access.view_all, homerooms: access.homerooms, is_admin: isAdmin(user), can_write: access.manage_all || access.homerooms.length > 0 },
    officer: access.officer, today: thaiToday(), max_photos: MAX_PHOTOS,
  };
}

// ---------- บันทึกความดี ----------
function normalizeDeed(input) {
  const date = parseDate(input?.deed_date ?? input?.date);
  if (!date) return { error: "วันที่ไม่ถูกต้อง (ใช้ วว/ดด/ปปปป)" };
  if (date > thaiToday()) return { error: "วันที่ต้องไม่เกินวันนี้" };
  let category = text(input?.category, 80);
  if (!category) return { error: "กรุณาเลือกประเภทความดี" };
  const match = DEED_CATEGORIES.find((c) => c.replace(/\s/g, "") === category.replace(/\s/g, ""));
  const detail = text(input?.detail, 500);
  if (!match) return { record: { date, category: "อื่น ๆ", detail: [category, detail].filter(Boolean).join(" — ").slice(0, 500) } };
  return { record: { date, category: match, detail } };
}
async function saveDeeds(env, user, access, entries) {
  const ids = [...new Set(entries.map((e) => Number(e.student_id)))];
  if (ids.some((id) => !Number.isInteger(id) || id <= 0)) return { status: 400, error: "รหัสนักเรียนไม่ถูกต้อง" };
  const students = await studentsByIds(env, ids);
  const errors = [], stmts = [];
  for (const [index, e] of entries.entries()) {
    const s = students.get(Number(e.student_id));
    if (!s) { errors.push({ index, error: "ไม่พบนักเรียน" }); continue; }
    if (!canEdit(access, s)) { errors.push({ index, error: `${s.full_name}: บันทึกได้เฉพาะนักเรียนในห้องที่ท่านเป็นครูประจำชั้น` }); continue; }
    const { record, error } = normalizeDeed(e);
    if (error) { errors.push({ index, error }); continue; }
    const p = await periodOf(env, record.date);
    stmts.push(env.DB.prepare("INSERT INTO good_deeds (student_id, deed_date, category, detail, academic_year, term, created_by) VALUES (?,?,?,?,?,?,?)")
      .bind(s.id, record.date, record.category, record.detail, p.year, p.term, user.id));
  }
  return { stmts, errors };
}
async function handleCreateDeeds(request, env, user, access) {
  const body = await readJson(request);
  const list = Array.isArray(body?.records) ? body.records : null;
  if (!list?.length) return jsonResponse({ error: "ไม่มีรายการที่จะบันทึก" }, 400);
  if (list.length > MAX_BATCH) return jsonResponse({ error: `บันทึกได้ครั้งละไม่เกิน ${MAX_BATCH} รายการ` }, 400);
  const r = await saveDeeds(env, user, access, list);
  if (r.error) return jsonResponse({ error: r.error }, r.status);
  if (r.errors.length) return jsonResponse({ error: `ข้อมูลไม่ถูกต้อง ${r.errors.length} รายการ: ${r.errors[0].error}`, errors: r.errors }, 400);
  await env.DB.batch(r.stmts);
  await audit(env, user, "good_create", { count: r.stmts.length });
  return jsonResponse({ ok: true, saved: r.stmts.length });
}
// POST /api/merit/good/import { rows:[{student_code, full_name, deed_date, category, detail}] } — ข้ามแถวที่ผิดและรายงานกลับ
async function handleImportDeeds(request, env, user, access) {
  const body = await readJson(request);
  if (!Array.isArray(body?.rows)) return jsonResponse({ error: "รูปแบบข้อมูลไม่ถูกต้อง" }, 400);
  if (body.rows.length > MAX_BATCH) return jsonResponse({ error: `นำเข้าได้ครั้งละไม่เกิน ${MAX_BATCH} แถว` }, 400);
  const all = await visibleStudents(env, access);
  const byCode = new Map(), byName = new Map();
  for (const s of all) {
    if (s.status && s.status !== "enrolled") continue;
    byCode.set(String(s.student_code ?? "").trim(), s);
    const n = normName(s.full_name);
    byName.set(n, byName.has(n) ? null : s);
  }
  const entries = [], rowOf = [], skipped = [];
  body.rows.forEach((row, i) => {
    const code = String(row?.student_code ?? "").trim();
    const s = (code && byCode.get(code)) || byName.get(normName(row?.full_name));
    if (!s) return skipped.push({ row: i + 1, reason: code ? `ไม่พบนักเรียนรหัส ${code} ในห้องที่ท่านบันทึกได้` : `ไม่พบนักเรียน ${row?.full_name || ""}` });
    const { error } = normalizeDeed(row);
    if (error) return skipped.push({ row: i + 1, reason: `${s.full_name}: ${error}` });
    entries.push({ ...row, student_id: s.id }); rowOf.push(i + 1);
  });
  const r = await saveDeeds(env, user, access, entries);
  if (r.error) return jsonResponse({ error: r.error }, r.status);
  r.errors.forEach((e) => skipped.push({ row: rowOf[e.index], reason: e.error }));
  if (r.stmts.length) await env.DB.batch(r.stmts);
  await audit(env, user, "good_import", { saved: r.stmts.length, skipped: skipped.length });
  return jsonResponse({ ok: true, saved: r.stmts.length, skipped: skipped.sort((a, b) => a.row - b.row) });
}
async function recordFor(env, kind, id) {
  const table = kind === "good" ? "good_deeds" : "found_money";
  return env.DB.prepare(`SELECT r.*, s.grade_level, s.classroom, s.full_name, ${PS_COLS} FROM ${table} r JOIN students s ON s.id = r.student_id ${PS_JOIN} WHERE r.id = ?`).bind(id).first();
}
const USED_MSG = "รายการนี้ใช้เพิ่มคะแนนพฤติกรรมแล้ว — ยกเลิกคะแนนในระบบคะแนนพฤติกรรมก่อนจึงแก้ไข/ลบได้";
async function handleUpdateDeed(request, env, user, access, id) {
  const row = await recordFor(env, "good", id);
  if (!row) return jsonResponse({ error: "ไม่พบรายการ" }, 404);
  if (!canEdit(access, row)) return jsonResponse({ error: "แก้ไขได้เฉพาะนักเรียนในห้องที่ท่านเป็นครูประจำชั้น" }, 403);
  if (row.points_used) return jsonResponse({ error: USED_MSG }, 409);
  const { record, error } = normalizeDeed(await readJson(request));
  if (error) return jsonResponse({ error }, 400);
  const p = await periodOf(env, record.date);
  await env.DB.prepare("UPDATE good_deeds SET deed_date=?, category=?, detail=?, academic_year=?, term=?, updated_at=datetime('now') WHERE id=?")
    .bind(record.date, record.category, record.detail, p.year, p.term, id).run();
  await audit(env, user, "good_update", { id });
  return jsonResponse({ ok: true });
}

// ---------- บันทึกการเจอเงิน ----------
const safeName = (s) => String(s || "").replace(/[\\/:*?"<>|\u0000-\u001f]/g, " ").replace(/\s+/g, " ").trim().slice(0, 120);
const q = (v) => String(v).replace(/\\/g, "\\\\").replace(/'/g, "\\'");
async function findOrCreateFolder(env, drive, token, parentId, name) {
  const key = `${parentId}/${name}`;
  const saved = await env.DB.prepare("SELECT folder_id FROM merit_folders WHERE key = ?").bind(key).first();
  if (saved) return saved.folder_id;
  const query = encodeURIComponent(`'${q(parentId)}' in parents and name = '${q(name)}' and mimeType = 'application/vnd.google-apps.folder' and trashed = false`);
  const found = await (await drive.request(token, `/files?q=${query}&pageSize=1&fields=files(id)&supportsAllDrives=true&includeItemsFromAllDrives=true`)).json();
  let id = found.files?.[0]?.id;
  if (!id) id = (await (await drive.request(token, "/files?fields=id&supportsAllDrives=true", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name, mimeType: "application/vnd.google-apps.folder", parents: [parentId] }),
  })).json()).id;
  if (!id) throw new Error("สร้างโฟลเดอร์ใน Google Drive ไม่สำเร็จ");
  await env.DB.prepare("INSERT OR REPLACE INTO merit_folders (key, folder_id) VALUES (?, ?)").bind(key, id).run();
  return id;
}
async function uploadImage(drive, token, folderId, name, mimeType, bytes) {
  const boundary = `fm_${crypto.randomUUID()}`;
  const body = new Blob([
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify({ name, mimeType, parents: [folderId] })}\r\n`,
    `--${boundary}\r\nContent-Type: ${mimeType}\r\n\r\n`, bytes, `\r\n--${boundary}--`,
  ]);
  const res = await (await drive.request(token, "/upload/drive/v3/files?uploadType=multipart&supportsAllDrives=true&fields=id,name,size", {
    method: "POST", headers: { "Content-Type": `multipart/related; boundary=${boundary}` }, body,
  })).json();
  if (!res?.id) throw new Error("อัปโหลดภาพไป Google Drive ไม่สำเร็จ");
  return res;
}
async function trashFile(drive, token, id) {
  await drive.request(token, `/files/${encodeURIComponent(id)}?supportsAllDrives=true`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ trashed: true }) });
}
async function checkImage(file) {
  if (!file || typeof file === "string" || typeof file.arrayBuffer !== "function" || !file.size) return { error: "ไฟล์ภาพว่างหรือไม่สมบูรณ์" };
  const mimeType = String(file.type || "").toLowerCase();
  if (!(mimeType in IMAGE_TYPES)) return { error: "รับเฉพาะไฟล์ภาพ (JPG, PNG, WEBP, HEIC)" };
  const head = new Uint8Array(await file.slice(0, 8).arrayBuffer()), sig = IMAGE_TYPES[mimeType];
  if (sig && !sig.every((b, i) => head[i] === b)) return { error: "ชนิดไฟล์ไม่ตรงกับเนื้อหาไฟล์" };
  if (file.size > IMAGE_MAX) return { error: "ภาพต้องไม่เกิน 10 MB ต่อภาพ" };
  return { mimeType };
}
function normalizeMoney(input) {
  const date = parseDate(input?.found_date ?? input?.date);
  if (!date) return { error: "วันที่ไม่ถูกต้อง" };
  if (date > thaiToday()) return { error: "วันที่ต้องไม่เกินวันนี้" };
  const amount = Number(String(input?.amount ?? "").replace(/[,\s฿]|บาท/g, ""));
  if (!Number.isFinite(amount) || amount <= 0 || amount > 1e6) return { error: "จำนวนเงินต้องมากกว่า 0" };
  return { record: { date, amount: Math.round(amount * 100) / 100, place: text(input?.place, 200), detail: text(input?.detail, 500) } };
}
async function savePhotos(env, drive, foundRow, files) {
  if (!files.length) return [];
  const checked = [];
  for (const f of files) { const c = await checkImage(f); if (c.error) throw Object.assign(new Error(c.error), { status: 400 }); checked.push([f, c.mimeType]); }
  const driveError = drive.ready(env);
  if (driveError) throw Object.assign(new Error(driveError), { status: 503 });
  const token = await drive.token(env);
  let folder = await findOrCreateFolder(env, drive, token, env.FOUND_MONEY_PARENT_ID || SCHOOL_FOLDER_ID, MONEY_FOLDER_NAME);
  folder = await findOrCreateFolder(env, drive, token, folder, String(foundRow.academic_year));
  folder = await findOrCreateFolder(env, drive, token, folder, `ภาคเรียนที่ ${foundRow.term}`);
  const out = [];
  for (const [i, [f, mime]] of checked.entries()) {
    const ext = (String(f.name).match(/\.[a-z0-9]{2,5}$/i)?.[0] || { "image/png": ".png", "image/webp": ".webp" }[mime] || ".jpg").toLowerCase();
    const name = safeName(`${foundRow.found_date} ${foundRow.full_name || ""} ${foundRow.amount} บาท (${foundRow.id}-${Date.now() % 100000}-${i + 1})`) + ext;
    const up = await uploadImage(drive, token, folder, name, mime, new Uint8Array(await f.arrayBuffer()));
    await env.DB.prepare("INSERT INTO found_money_photos (found_id, drive_file_id, file_name, mime_type, file_size) VALUES (?,?,?,?,?)").bind(foundRow.id, up.id, name, mime, f.size).run();
    out.push(up.id);
  }
  return out;
}
async function handleCreateMoney(request, env, user, access, drive) {
  const form = await request.formData().catch(() => null);
  if (!form) return jsonResponse({ error: "รูปแบบข้อมูลไม่ถูกต้อง" }, 400);
  const sid = Number(form.get("student_id"));
  const s = (await studentsByIds(env, Number.isInteger(sid) && sid > 0 ? [sid] : [])).get(sid);
  if (!s) return jsonResponse({ error: "กรุณาเลือกนักเรียน" }, 400);
  if (!canEdit(access, s)) return jsonResponse({ error: "บันทึกได้เฉพาะนักเรียนในห้องที่ท่านเป็นครูประจำชั้น" }, 403);
  const { record, error } = normalizeMoney(Object.fromEntries(form));
  if (error) return jsonResponse({ error }, 400);
  const files = form.getAll("photos").filter((f) => f && typeof f !== "string" && f.size);
  if (files.length > MAX_PHOTOS) return jsonResponse({ error: `แนบภาพได้ไม่เกิน ${MAX_PHOTOS} ภาพ` }, 400);
  for (const f of files) { const c = await checkImage(f); if (c.error) return jsonResponse({ error: c.error }, 400); }
  if (files.length) { const e = drive.ready(env); if (e) return jsonResponse({ error: e }, 503); }
  const p = await periodOf(env, record.date);
  const r = await env.DB.prepare("INSERT INTO found_money (student_id, found_date, amount, place, detail, academic_year, term, created_by) VALUES (?,?,?,?,?,?,?,?)")
    .bind(s.id, record.date, record.amount, record.place, record.detail, p.year, p.term, user.id).run();
  const id = Number(r?.meta?.last_row_id);
  try { await savePhotos(env, drive, { id, found_date: record.date, amount: record.amount, full_name: s.full_name, academic_year: p.year, term: p.term }, files); }
  catch (e) { await audit(env, user, "money_photo_error", { id, error: e.message }); return jsonResponse({ ok: true, id, warning: `บันทึกข้อมูลแล้ว แต่อัปโหลดภาพไม่สำเร็จ: ${e.message}` }); }
  await audit(env, user, "money_create", { id, amount: record.amount });
  return jsonResponse({ ok: true, id });
}
async function handleUpdateMoney(request, env, user, access, id) {
  const row = await recordFor(env, "money", id);
  if (!row) return jsonResponse({ error: "ไม่พบรายการ" }, 404);
  if (!canEdit(access, row)) return jsonResponse({ error: "แก้ไขได้เฉพาะนักเรียนในห้องที่ท่านเป็นครูประจำชั้น" }, 403);
  const { record, error } = normalizeMoney(await readJson(request));
  if (error) return jsonResponse({ error }, 400);
  if (row.points_used && record.date !== row.found_date) return jsonResponse({ error: USED_MSG }, 409);
  const p = await periodOf(env, record.date);
  await env.DB.prepare("UPDATE found_money SET found_date=?, amount=?, place=?, detail=?, academic_year=?, term=?, updated_at=datetime('now') WHERE id=?")
    .bind(record.date, record.amount, record.place, record.detail, p.year, p.term, id).run();
  await audit(env, user, "money_update", { id });
  return jsonResponse({ ok: true });
}
async function handleAddPhotos(request, env, user, access, drive, id) {
  const row = await recordFor(env, "money", id);
  if (!row) return jsonResponse({ error: "ไม่พบรายการ" }, 404);
  if (!canEdit(access, row)) return jsonResponse({ error: "แก้ไขได้เฉพาะนักเรียนในห้องที่ท่านเป็นครูประจำชั้น" }, 403);
  const form = await request.formData().catch(() => null);
  const files = (form?.getAll("photos") || []).filter((f) => f && typeof f !== "string" && f.size);
  const have = (await env.DB.prepare("SELECT COUNT(*) AS n FROM found_money_photos WHERE found_id = ?").bind(id).first()).n;
  if (!files.length) return jsonResponse({ error: "กรุณาเลือกภาพ" }, 400);
  if (have + files.length > MAX_PHOTOS) return jsonResponse({ error: `แนบภาพได้รวมไม่เกิน ${MAX_PHOTOS} ภาพ (มีแล้ว ${have})` }, 400);
  try { await savePhotos(env, drive, row, files); } catch (e) { return jsonResponse({ error: e.message }, e.status || 500); }
  return jsonResponse({ ok: true });
}
async function photoRow(env, pid) {
  return env.DB.prepare(`SELECT p.*, s.grade_level, s.classroom FROM found_money_photos p JOIN found_money f ON f.id = p.found_id JOIN students s ON s.id = f.student_id WHERE p.id = ?`).bind(pid).first();
}
async function handlePhoto(env, access, drive, pid) {
  const row = await photoRow(env, pid);
  if (!row) return new Response("Not found", { status: 404 });
  if (!access.view_all && !access.homerooms.includes(roomKey(row.grade_level, row.classroom))) return new Response("Forbidden", { status: 403 });
  const res = await drive.request(await drive.token(env), `/files/${encodeURIComponent(row.drive_file_id)}?alt=media&supportsAllDrives=true`);
  if (!res.ok) return new Response("ไม่พบไฟล์ใน Google Drive", { status: 502 });
  return new Response(res.body, { headers: { "Content-Type": row.mime_type || "image/jpeg", "Cache-Control": "private, max-age=86400" } });
}
async function handleDeletePhoto(env, user, access, drive, pid) {
  const row = await photoRow(env, pid);
  if (!row) return jsonResponse({ error: "ไม่พบภาพ" }, 404);
  if (!canEdit(access, row)) return jsonResponse({ error: "ลบได้เฉพาะนักเรียนในห้องที่ท่านเป็นครูประจำชั้น" }, 403);
  await env.DB.prepare("DELETE FROM found_money_photos WHERE id = ?").bind(pid).run();
  if (!drive.ready(env)) await trashFile(drive, await drive.token(env), row.drive_file_id).catch(() => {});
  await audit(env, user, "money_photo_delete", { id: pid });
  return jsonResponse({ ok: true });
}
async function handleDelete(env, user, access, drive, kind, id) {
  const row = await recordFor(env, kind, id);
  if (!row) return jsonResponse({ error: "ไม่พบรายการ" }, 404);
  if (!canEdit(access, row)) return jsonResponse({ error: "ลบได้เฉพาะนักเรียนในห้องที่ท่านเป็นครูประจำชั้น" }, 403);
  if (row.points_used) return jsonResponse({ error: USED_MSG }, 409);
  if (kind === "money") {
    const { results } = await env.DB.prepare("SELECT drive_file_id FROM found_money_photos WHERE found_id = ?").bind(id).all();
    await env.DB.prepare("DELETE FROM found_money_photos WHERE found_id = ?").bind(id).run();
    if (results.length && !drive.ready(env)) { const token = await drive.token(env); for (const p of results) await trashFile(drive, token, p.drive_file_id).catch(() => {}); }
  }
  await env.DB.prepare(`DELETE FROM ${kind === "good" ? "good_deeds" : "found_money"} WHERE id = ?`).bind(id).run();
  await audit(env, user, `${kind}_delete`, { id });
  return jsonResponse({ ok: true });
}

// ---------- ใช้เพิ่มคะแนนพฤติกรรม ----------
// POST /api/merit/points { kind:'good'|'money', ids:[...] } — +1 คะแนน/รายการ ใช้ได้ครั้งเดียว · ป.1–6 · ภาคเรียนตามวันที่ของรายการ
async function handlePoints(request, env, user, access, kind) {
  const body = await readJson(request);
  const ids = [...new Set((body?.ids || []).map(Number))].filter((n) => Number.isInteger(n) && n > 0);
  if (!ids.length) return jsonResponse({ error: "กรุณาเลือกรายการ" }, 400);
  if (ids.length > MAX_BATCH) return jsonResponse({ error: `ทำได้ครั้งละไม่เกิน ${MAX_BATCH} รายการ` }, 400);
  const added = [], skipped = [];
  for (const id of ids) {
    const row = await recordFor(env, kind, id);
    if (!row) { skipped.push({ id, reason: "ไม่พบรายการ" }); continue; }
    if (!canEdit(access, row)) { skipped.push({ id, reason: `${row.full_name}: ไม่ใช่นักเรียนในห้องที่ท่านรับผิดชอบ` }); continue; }
    if (row.points_used) { skipped.push({ id, reason: `${row.full_name}: ใช้เพิ่มคะแนนไปแล้ว` }); continue; }
    if (!isPrimary(row.grade_level)) { skipped.push({ id, reason: `${row.full_name}: ระบบคะแนนพฤติกรรมใช้กับ ป.1–6 เท่านั้น` }); continue; }
    const date = kind === "good" ? row.deed_date : row.found_date;
    const p = await periodOf(env, date);
    if (!p.year_id) { skipped.push({ id, reason: `ยังไม่มีปีการศึกษา ${p.year} ในระบบ` }); continue; }
    const reason = (kind === "good" ? `ทำความดี: ${row.category}${row.detail ? ` — ${row.detail}` : ""}` : `เจอเงินส่งคืน ${Number(row.amount).toLocaleString("th-TH")} บาท${row.place ? ` (${row.place})` : ""}`).slice(0, 300);
    const r = await env.DB.prepare("INSERT INTO ps_behavior_records (academic_year_id, term_number, student_id, points, reason, incident_date, created_by) VALUES (?,?,?,?,?,?,?)")
      .bind(p.year_id, p.term, row.student_id, 1, reason, date, user.id).run();
    await env.DB.prepare(`UPDATE ${kind === "good" ? "good_deeds" : "found_money"} SET ps_record_id = ? WHERE id = ?`).bind(Number(r?.meta?.last_row_id), id).run();
    added.push(id);
  }
  if (added.length) await audit(env, user, `${kind}_points`, { count: added.length });
  return jsonResponse({ ok: true, added: added.length, skipped });
}

export async function handleMeritRoute(request, env, pathname, method, drive) {
  if (!pathname.startsWith("/api/merit")) return null;
  const user = await getCurrentUser(request, env);
  if (!user || !user.role) return jsonResponse({ error: "กรุณาเข้าสู่ระบบ" }, 401);
  if (user.role === "viewer") return jsonResponse({ error: "บัญชีผู้ชมภายนอกดูข้อมูลส่วนนี้ไม่ได้" }, 403);
  await ensureMeritSchema(env);
  if (pathname === "/api/merit/permissions" && method === "GET") {
    const [good, money] = await Promise.all([meritAccess(env, user, "good"), meritAccess(env, user, "money")]);
    return jsonResponse({ view: good.view || money.view, good: { view: good.view, manage_all: good.manage_all }, money: { view: money.view, manage_all: money.manage_all } });
  }
  const m = pathname.match(/^\/api\/merit\/(good|money)(?:\/(.*))?$/);
  if (!m) return jsonResponse({ error: "ไม่พบเส้นทาง" }, 404);
  const kind = m[1], sub = m[2] || "";
  const access = await meritAccess(env, user, kind);
  if (!access.view) return jsonResponse({ error: "ไม่มีสิทธิ์ดูข้อมูลส่วนนี้ (เฉพาะครูประจำชั้น ผู้รับผิดชอบงาน และผู้บริหาร)" }, 403);
  const photo = sub.match(/^photos\/(\d+)$/);
  if (kind === "money" && photo && method === "GET") return handlePhoto(env, access, drive, Number(photo[1]));
  if (!sub && method === "GET") {
    const year = parseYear(new URL(request.url).searchParams.get("academic_year")) || await currentYear(env);
    return jsonResponse(await listPayload(env, user, access, kind, year));
  }
  if (!(access.manage_all || access.homerooms.length)) return jsonResponse({ error: "บันทึกได้เฉพาะครูประจำชั้น ผู้รับผิดชอบงาน และผู้ดูแลระบบ" }, 403);
  if (sub === "points" && method === "POST") return handlePoints(request, env, user, access, kind);
  if (kind === "good") {
    if (!sub && method === "POST") return handleCreateDeeds(request, env, user, access);
    if (sub === "import" && method === "POST") return handleImportDeeds(request, env, user, access);
  } else {
    if (!sub && method === "POST") return handleCreateMoney(request, env, user, access, drive);
    if (photo && method === "DELETE") return handleDeletePhoto(env, user, access, drive, Number(photo[1]));
    const add = sub.match(/^(\d+)\/photos$/);
    if (add && method === "POST") return handleAddPhotos(request, env, user, access, drive, Number(add[1]));
  }
  const one = sub.match(/^(\d+)$/);
  if (one && method === "PATCH") return kind === "good" ? handleUpdateDeed(request, env, user, access, Number(one[1])) : handleUpdateMoney(request, env, user, access, Number(one[1]));
  if (one && method === "DELETE") return handleDelete(env, user, access, drive, kind, Number(one[1]));
  return jsonResponse({ error: "ไม่พบเส้นทาง" }, 404);
}
