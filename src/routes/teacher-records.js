// ผลงานครู และ อบรมครู (เมนูย่อยฝ่ายบุคคล)
// ผลงานครู: ฝ่ายบุคคล + superadmin บันทึกให้ครูทุกคน · ครูดูของตนเอง
// อบรมครู (รายงานการอบรม): ครูที่ไปอบรมบันทึกเอง (เมนูระบบสนับสนุน) · ฝ่ายบุคคลดูผลของทุกคน · superadmin แก้ไขได้ทุกรายการ
// ไฟล์: ภาพ (JPG/PNG/WEBP/HEIC ≤10 MB) และ PDF (≤30 MB) เก็บใน Google Drive: <ผลงานครู|อบรมครู> / <ชื่อครู>
import { getCurrentUser, jsonResponse } from '../lib/auth.js';
import { ensurePersonnelData } from '../lib/personnel-data.js';
import { ensureDepartmentStaff, belongsToDepartment } from './department-staff.js';

const SCHOOL_FOLDER_ID = '1ZvfJvwRf0sf_k_hcZwNR0lXLdYZlgFI3';
export const KINDS = { works: 'ผลงานครู', training: 'อบรมครู' };
export const WORK_CATEGORIES = ['รางวัล', 'เกียรติบัตร', 'ผลงานวิชาการ', 'นวัตกรรม', 'อื่น ๆ'];
export const WORK_LEVELS = ['โรงเรียน', 'เครือข่าย/อำเภอ', 'เขตพื้นที่', 'จังหวัด', 'ภาค', 'ชาติ', 'นานาชาติ'];
export const TRAINING_MODES = ['onsite', 'online', 'hybrid'];
const MAX_FILES = 20, IMAGE_MAX = 10 * 1024 * 1024, PDF_MAX = 30 * 1024 * 1024;
const IMAGE_TYPES = { 'image/jpeg': [0xff, 0xd8, 0xff], 'image/png': [0x89, 0x50, 0x4e, 0x47], 'image/webp': null, 'image/heic': null, 'image/heif': null };

const ready = new WeakSet();
export async function ensureTeacherRecordsSchema(env) {
  if (ready.has(env.DB)) return;
  for (const sql of [
    `CREATE TABLE IF NOT EXISTS teacher_records (
      id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL CHECK (kind IN ('works','training')),
      user_id INTEGER NOT NULL, title TEXT NOT NULL, category TEXT, level TEXT, organizer TEXT,
      start_date TEXT, end_date TEXT, hours REAL, mode TEXT, detail TEXT, location TEXT,
      created_by INTEGER, created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')), deleted_at TEXT)`,
    'CREATE INDEX IF NOT EXISTS idx_teacher_records_kind ON teacher_records(kind, user_id, deleted_at)',
    `CREATE TABLE IF NOT EXISTS teacher_record_files (
      id INTEGER PRIMARY KEY AUTOINCREMENT, record_id INTEGER NOT NULL REFERENCES teacher_records(id) ON DELETE CASCADE,
      drive_file_id TEXT NOT NULL, file_name TEXT NOT NULL, mime_type TEXT NOT NULL, file_size INTEGER,
      created_at TEXT NOT NULL DEFAULT (datetime('now')))`,
    'CREATE INDEX IF NOT EXISTS idx_teacher_record_files ON teacher_record_files(record_id)',
    'CREATE TABLE IF NOT EXISTS teacher_record_folders (key TEXT PRIMARY KEY, folder_id TEXT NOT NULL)',
  ]) await env.DB.prepare(sql).run();
  const { results: cols } = await env.DB.prepare('PRAGMA table_info(teacher_records)').all();
  if (!cols.some((c) => c.name === 'location')) { try { await env.DB.prepare('ALTER TABLE teacher_records ADD COLUMN location TEXT').run(); } catch (e) { if (!/duplicate column/i.test(String(e.message))) throw e; } }
  ready.add(env.DB);
}

export async function teacherRecordPermissions(env, user) {
  if (!user?.role || user.role === 'viewer') return { view: false, manage: false };
  if (user.role === 'superadmin') return { view: true, manage: true };
  await ensurePersonnelData(env); await ensureDepartmentStaff(env);
  const { results } = await env.DB.prepare(`SELECT p.departments,
    EXISTS(SELECT 1 FROM department_staff d WHERE d.personnel_id=p.id AND d.department='personnel') in_dept
    FROM personnel_records p JOIN personnel_accounts a ON a.personnel_id=p.id WHERE a.user_id=? AND p.status='active'`).bind(user.id).all();
  const manage = results.some((p) => Number(p.in_dept) === 1 || belongsToDepartment(p.departments, 'personnel'));
  return { view: true, manage };
}

// ---------- แปลงค่า ----------
const text = (v, max) => { const s = String(v ?? '').trim(); return s ? s.slice(0, max) : null; };
export function validDate(v) {
  const s = String(v ?? '').trim();
  if (!s) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s) || Number.isNaN(Date.parse(s + 'T00:00:00Z'))) return undefined;
  return s;
}
export function normalizeRecord(kind, input) {
  const title = text(input?.title, 200);
  if (!title) return { error: kind === 'works' ? 'กรุณากรอกชื่อผลงาน' : 'กรุณากรอกเรื่องที่อบรม' };
  const start = validDate(input.start_date), end = validDate(input.end_date);
  if (start === undefined || end === undefined) return { error: 'รูปแบบวันที่ไม่ถูกต้อง' };
  const r = { title, organizer: text(input.organizer, 200), detail: text(input.detail, 2000), start_date: start, category: null, level: null, end_date: null, hours: null, mode: null, location: null };
  if (kind === 'works') {
    r.category = WORK_CATEGORIES.includes(input.category) ? input.category : null;
    r.level = WORK_LEVELS.includes(input.level) ? input.level : null;
  } else {
    if (end && start && end < start) return { error: 'วันที่สิ้นสุดต้องไม่ก่อนวันที่เริ่ม' };
    r.end_date = end;
    r.location = text(input.location, 200);
    r.detail = text(input.detail, 5000);
  }
  return { record: r };
}
export async function checkFile(file) {
  if (!file || typeof file === 'string' || typeof file.arrayBuffer !== 'function' || !file.size) return { error: 'ไฟล์ว่างหรือไม่สมบูรณ์' };
  const mimeType = String(file.type || '').toLowerCase();
  const head = new Uint8Array(await file.slice(0, 8).arrayBuffer());
  if (mimeType === 'application/pdf') {
    if (String.fromCharCode(...head.slice(0, 5)) !== '%PDF-') return { error: 'ไฟล์ PDF ไม่ถูกต้อง' };
    if (file.size > PDF_MAX) return { error: 'PDF ต้องไม่เกิน 30 MB' };
    return { mimeType };
  }
  if (!(mimeType in IMAGE_TYPES)) return { error: 'รับเฉพาะไฟล์ภาพ (JPG, PNG, WEBP, HEIC) และ PDF' };
  const sig = IMAGE_TYPES[mimeType];
  if (sig && !sig.every((b, i) => head[i] === b)) return { error: 'ชนิดไฟล์ไม่ตรงกับเนื้อหาไฟล์' };
  if (file.size > IMAGE_MAX) return { error: 'ภาพต้องไม่เกิน 10 MB' };
  return { mimeType };
}

async function readJson(request) { try { return await request.json(); } catch { return null; } }
async function audit(env, user, action, details) {
  await env.DB.prepare('INSERT INTO audit_logs (user_id, action, resource, resource_id, details) VALUES (?,?,?,?,?)')
    .bind(user.id, action, 'teacher_records', null, JSON.stringify(details)).run().catch(() => {});
}

// ---------- Google Drive ----------
const q = (s) => String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
async function findOrCreateFolder(env, drive, token, parentId, name) {
  const key = `${parentId}/${name}`;
  const saved = await env.DB.prepare('SELECT folder_id FROM teacher_record_folders WHERE key = ?').bind(key).first();
  if (saved) return saved.folder_id;
  const query = encodeURIComponent(`'${q(parentId)}' in parents and name = '${q(name)}' and mimeType = 'application/vnd.google-apps.folder' and trashed = false`);
  const found = await (await drive.request(token, `/files?q=${query}&pageSize=1&fields=files(id)&supportsAllDrives=true&includeItemsFromAllDrives=true`)).json();
  let id = found?.files?.[0]?.id;
  if (!id) id = (await (await drive.request(token, '/files?fields=id&supportsAllDrives=true', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, mimeType: 'application/vnd.google-apps.folder', parents: [parentId] }),
  })).json())?.id;
  if (!id) throw new Error('สร้างโฟลเดอร์ใน Google Drive ไม่สำเร็จ');
  await env.DB.prepare('INSERT OR REPLACE INTO teacher_record_folders (key, folder_id) VALUES (?, ?)').bind(key, id).run();
  return id;
}
async function uploadToDrive(drive, token, folderId, name, mimeType, bytes) {
  const boundary = `tr_${crypto.randomUUID()}`;
  const body = new Blob([
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify({ name, mimeType, parents: [folderId] })}\r\n`,
    `--${boundary}\r\nContent-Type: ${mimeType}\r\n\r\n`, bytes, `\r\n--${boundary}--`,
  ]);
  const res = await (await drive.request(token, '/upload/drive/v3/files?uploadType=multipart&supportsAllDrives=true&fields=id,name,size', {
    method: 'POST', headers: { 'Content-Type': `multipart/related; boundary=${boundary}` }, body,
  })).json();
  if (!res?.id) throw new Error('อัปโหลดไฟล์ไป Google Drive ไม่สำเร็จ');
  return res;
}
async function trashFile(drive, token, id) {
  await drive.request(token, `/files/${encodeURIComponent(id)}?supportsAllDrives=true`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ trashed: true }) });
}
const safeName = (s) => String(s || '').replace(/[\\/:*?"<>|\r\n]+/g, ' ').trim().slice(0, 120) || 'ไฟล์';

// ---------- รายการ ----------
async function teachers(env) {
  const { results } = await env.DB.prepare("SELECT id, full_name FROM users WHERE status='active' AND role IS NOT NULL AND role <> 'viewer' AND deleted_at IS NULL ORDER BY full_name").all();
  return results;
}
// สิทธิ์ต่อชนิด: ผลงาน = ฝ่ายบุคคลจัดการ · อบรม = เจ้าของจัดการของตน, ฝ่ายบุคคลดูทั้งหมด, superadmin จัดการทั้งหมด
function kindAccess(user, perms, kind) {
  if (kind === 'works') return { view_all: perms.manage, manage_all: perms.manage, own: false };
  return { view_all: perms.manage, manage_all: user.role === 'superadmin', own: true };
}
const canEdit = (user, acc, row) => acc.manage_all || (acc.own && row.user_id === user.id);
async function listPayload(env, user, perms, kind, filterUser, mine) {
  const acc = kindAccess(user, perms, kind);
  const all = acc.view_all && !mine;
  const uid = all ? filterUser : user.id;
  const { results: records } = await env.DB.prepare(`SELECT r.*, u.full_name FROM teacher_records r LEFT JOIN users u ON u.id = r.user_id
    WHERE r.kind = ? AND r.deleted_at IS NULL ${uid ? 'AND r.user_id = ?' : ''} ORDER BY COALESCE(r.start_date, r.created_at) DESC, r.id DESC`).bind(...(uid ? [kind, uid] : [kind])).all();
  const files = new Map();
  const ids = records.map((r) => r.id);
  for (let i = 0; i < ids.length; i += 90) {
    const chunk = ids.slice(i, i + 90);
    const { results } = await env.DB.prepare(`SELECT id, record_id, file_name, mime_type, file_size FROM teacher_record_files WHERE record_id IN (${chunk.map(() => '?').join(',')}) ORDER BY id`).bind(...chunk).all();
    for (const f of results) { if (!files.has(f.record_id)) files.set(f.record_id, []); files.get(f.record_id).push(f); }
  }
  records.forEach((r) => { r.files = files.get(r.id) || []; });
  records.forEach((r) => { r.can_edit = canEdit(user, acc, r); });
  return { kind, manage: acc.manage_all && all, view_all: all, can_create: kind === 'works' ? acc.manage_all : true, records, teachers: all || (kind === 'works' && acc.manage_all) ? await teachers(env) : [],
    options: { categories: WORK_CATEGORIES, levels: WORK_LEVELS, modes: TRAINING_MODES }, max_files: MAX_FILES };
}
async function recordRow(env, kind, id) {
  return env.DB.prepare('SELECT r.*, u.full_name FROM teacher_records r LEFT JOIN users u ON u.id = r.user_id WHERE r.id = ? AND r.kind = ? AND r.deleted_at IS NULL').bind(id, kind).first();
}
const COLS = ['title', 'category', 'level', 'organizer', 'start_date', 'end_date', 'hours', 'mode', 'detail', 'location'];

async function handleCreate(request, env, user, kind) {
  const body = await readJson(request);
  const n = normalizeRecord(kind, body);
  if (n.error) return jsonResponse({ error: n.error }, 400);
  const uid = kind === 'training' ? user.id : Number(body.user_id);
  if (!uid || !(await env.DB.prepare("SELECT 1 FROM users WHERE id = ? AND status='active' AND deleted_at IS NULL").bind(uid).first())) return jsonResponse({ error: 'กรุณาเลือกครู' }, 400);
  const row = await env.DB.prepare(`INSERT INTO teacher_records (kind, user_id, ${COLS.join(', ')}, created_by) VALUES (?, ?, ${COLS.map(() => '?').join(', ')}, ?) RETURNING id`)
    .bind(kind, uid, ...COLS.map((c) => n.record[c]), user.id).first();
  await audit(env, user, `${kind}_create`, { id: row.id, user_id: uid });
  return jsonResponse({ ok: true, id: row.id });
}
async function handleUpdate(request, env, user, kind, id) {
  const row = await recordRow(env, kind, id);
  if (!row) return jsonResponse({ error: 'ไม่พบรายการ' }, 404);
  const body = await readJson(request);
  const n = normalizeRecord(kind, body);
  if (n.error) return jsonResponse({ error: n.error }, 400);
  let uid = row.user_id;
  if (kind === 'works' && body.user_id && Number(body.user_id) !== row.user_id) {
    if (!(await env.DB.prepare("SELECT 1 FROM users WHERE id = ? AND status='active' AND deleted_at IS NULL").bind(Number(body.user_id)).first())) return jsonResponse({ error: 'ไม่พบครูที่เลือก' }, 400);
    uid = Number(body.user_id);
  }
  await env.DB.prepare(`UPDATE teacher_records SET user_id = ?, ${COLS.map((c) => `${c} = ?`).join(', ')}, updated_at = datetime('now') WHERE id = ?`)
    .bind(uid, ...COLS.map((c) => n.record[c]), id).run();
  await audit(env, user, `${kind}_update`, { id });
  return jsonResponse({ ok: true });
}
async function handleDelete(env, user, kind, id, drive) {
  const row = await recordRow(env, kind, id);
  if (!row) return jsonResponse({ error: 'ไม่พบรายการ' }, 404);
  const { results } = await env.DB.prepare('SELECT drive_file_id FROM teacher_record_files WHERE record_id = ?').bind(id).all();
  await env.DB.batch([
    env.DB.prepare('DELETE FROM teacher_record_files WHERE record_id = ?').bind(id),
    env.DB.prepare("UPDATE teacher_records SET deleted_at = datetime('now') WHERE id = ?").bind(id),
  ]);
  if (results.length && !drive.ready(env)) { const token = await drive.token(env); for (const f of results) await trashFile(drive, token, f.drive_file_id).catch(() => {}); }
  await audit(env, user, `${kind}_delete`, { id });
  return jsonResponse({ ok: true });
}
async function handleUpload(request, env, user, kind, id, drive) {
  const row = await recordRow(env, kind, id);
  if (!row) return jsonResponse({ error: 'ไม่พบรายการ' }, 404);
  const driveError = drive.ready(env);
  if (driveError) return jsonResponse({ error: driveError }, 503);
  const form = await request.formData().catch(() => null);
  const file = form?.get('file');
  const check = await checkFile(file);
  if (check.error) return jsonResponse({ error: check.error }, 400);
  const have = (await env.DB.prepare('SELECT COUNT(*) AS n FROM teacher_record_files WHERE record_id = ?').bind(id).first()).n;
  if (have >= MAX_FILES) return jsonResponse({ error: `แนบไฟล์ได้ไม่เกิน ${MAX_FILES} ไฟล์ต่อรายการ` }, 400);
  try {
    const token = await drive.token(env);
    let folder = await findOrCreateFolder(env, drive, token, env.TEACHER_RECORDS_PARENT_ID || SCHOOL_FOLDER_ID, KINDS[kind]);
    folder = await findOrCreateFolder(env, drive, token, folder, safeName(row.full_name || `ครู ${row.user_id}`));
    const name = safeName(file.name);
    const up = await uploadToDrive(drive, token, folder, name, check.mimeType, new Uint8Array(await file.arrayBuffer()));
    await env.DB.prepare('INSERT INTO teacher_record_files (record_id, drive_file_id, file_name, mime_type, file_size) VALUES (?,?,?,?,?)').bind(id, up.id, name, check.mimeType, file.size).run();
  } catch (e) { return jsonResponse({ error: e.message || 'อัปโหลดไม่สำเร็จ' }, 502); }
  await audit(env, user, `${kind}_file_upload`, { id });
  return jsonResponse({ ok: true });
}
async function fileRow(env, fid) {
  return env.DB.prepare('SELECT f.*, r.user_id, r.kind FROM teacher_record_files f JOIN teacher_records r ON r.id = f.record_id WHERE f.id = ? AND r.deleted_at IS NULL').bind(fid).first();
}
async function serveFile(env, user, perms, fid, url, drive) {
  const row = await fileRow(env, fid);
  if (!row) return jsonResponse({ error: 'ไม่พบไฟล์' }, 404);
  if (!perms.manage && row.user_id !== user.id) return jsonResponse({ error: 'ไม่มีสิทธิ์เปิดไฟล์นี้' }, 403);
  const res = await drive.request(await drive.token(env), `/files/${encodeURIComponent(row.drive_file_id)}?alt=media&supportsAllDrives=true`);
  if (!res.ok) return new Response('ไม่พบไฟล์ใน Google Drive', { status: 502 });
  const disposition = url.searchParams.has('download') ? 'attachment' : 'inline';
  return new Response(res.body, { headers: {
    'Content-Type': row.mime_type, 'Cache-Control': 'private, max-age=300', 'X-Content-Type-Options': 'nosniff',
    'Content-Disposition': `${disposition}; filename="file-${row.id}"; filename*=UTF-8''${encodeURIComponent(row.file_name)}`,
  } });
}
async function deleteFile(env, user, perms, fid, drive) {
  const row = await fileRow(env, fid);
  if (!row) return jsonResponse({ error: 'ไม่พบไฟล์' }, 404);
  if (!canEdit(user, kindAccess(user, perms, row.kind), row)) return jsonResponse({ error: 'ไม่มีสิทธิ์ลบไฟล์นี้' }, 403);
  await env.DB.prepare('DELETE FROM teacher_record_files WHERE id = ?').bind(fid).run();
  if (!drive.ready(env)) await trashFile(drive, await drive.token(env), row.drive_file_id).catch(() => {});
  await audit(env, user, `${row.kind}_file_delete`, { id: fid });
  return jsonResponse({ ok: true });
}

export async function handleTeacherRecordsRoute(request, env, pathname, method, drive) {
  if (!pathname.startsWith('/api/teacher-records')) return null;
  const user = await getCurrentUser(request, env);
  if (!user || !user.role) return jsonResponse({ error: 'กรุณาเข้าสู่ระบบ' }, 401);
  const perms = await teacherRecordPermissions(env, user);
  if (pathname === '/api/teacher-records/permissions' && method === 'GET') return jsonResponse(perms);
  if (!perms.view) return jsonResponse({ error: 'บัญชีนี้ดูข้อมูลส่วนนี้ไม่ได้' }, 403);
  await ensureTeacherRecordsSchema(env);
  const url = new URL(request.url);
  const file = pathname.match(/^\/api\/teacher-records\/files\/(\d+)$/);
  if (file && method === 'GET') return serveFile(env, user, perms, Number(file[1]), url, drive);
  const m = pathname.match(/^\/api\/teacher-records\/(works|training)(?:\/(\d+)(\/files)?)?$/);
  if (!m && !file) return jsonResponse({ error: 'ไม่พบเส้นทาง' }, 404);
  if (m && !m[2] && method === 'GET') return jsonResponse(await listPayload(env, user, perms, m[1], Number(url.searchParams.get('user_id')) || null, url.searchParams.get('view') === 'mine'));
  if (file && method === 'DELETE') return deleteFile(env, user, perms, Number(file[1]), drive);
  const [, kind, id, files] = m;
  const acc = kindAccess(user, perms, kind);
  if (!id && method === 'POST') {
    if (kind === 'works' && !acc.manage_all) return jsonResponse({ error: 'บันทึกได้เฉพาะบุคลากรฝ่ายบุคคลและผู้ดูแลระบบ' }, 403);
    return handleCreate(request, env, user, kind);
  }
  if (id) {
    const row = await recordRow(env, kind, Number(id));
    if (!row) return jsonResponse({ error: 'ไม่พบรายการ' }, 404);
    if (!canEdit(user, acc, row)) return jsonResponse({ error: kind === 'works' ? 'แก้ไขได้เฉพาะบุคลากรฝ่ายบุคคลและผู้ดูแลระบบ' : 'แก้ไขได้เฉพาะรายงานของตนเอง' }, 403);
  }
  if (id && files && method === 'POST') return handleUpload(request, env, user, kind, Number(id), drive);
  if (id && !files && method === 'PATCH') return handleUpdate(request, env, user, kind, Number(id));
  if (id && !files && method === 'DELETE') return handleDelete(env, user, kind, Number(id), drive);
  return jsonResponse({ error: 'ไม่พบเส้นทาง' }, 404);
}
