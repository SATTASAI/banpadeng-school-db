// งานส่งของครู (ระบบสนับสนุน) + ติดตามความคืบหน้า (ฝ่ายวิชาการ)
// 1) ป่าเด็งโมเดล: ต่อภาคเรียน · ต่อวิชา×ห้องที่ครูสอน (จากฝ่ายวัดผล) → กรอกแบบรายงานตามแบบฟอร์ม + ภาพไม่เกิน 4 ภาพ
//    (เลิกใช้การอัปโหลด PDF แล้ว — ไฟล์ PDF เดิมถูกซ่อน) ฝ่ายวิชาการดาวน์โหลดเป็นเอกสาร PDF/Word ทั้งรายฉบับและรวมเล่ม
//    Drive: PADENG MODEL / <ปี ภาค> / ภาพ / <ครู - วิชา ห้อง> / ภาพ
// 2) วิจัยในชั้นเรียน: ต่อภาคเรียน · ครู 1 คน 1 ไฟล์ PDF (ส่งใหม่ = แทนไฟล์เดิม)
//    Drive: วิจัยในชั้นเรียน (โฟลเดอร์เดิม) / <ปี> / ภาคเรียนที่ <n> / <ครู - ชื่อเรื่อง>.pdf
// ฝ่ายวิชาการ (บุคลากรในฝ่าย/หัวหน้า) และ superadmin เท่านั้นที่ดูความคืบหน้าและดาวน์โหลดงานของทุกคน
import { getCurrentUser, jsonResponse } from '../lib/auth.js';
import { ensurePersonnelData } from '../lib/personnel-data.js';
import { ensureDepartmentStaff, belongsToDepartment } from './department-staff.js';
import { teachingMaster } from '../lib/teaching-master.js';
import { zipStream, uniqueNames } from '../lib/zip-stream.js';

// โฟลเดอร์หลักใน Drive (แก้ได้ด้วยตัวแปร PADENG_MODEL_PARENT_ID / RESEARCH_FOLDER_ID)
const SCHOOL_FOLDER_ID = '1ZvfJvwRf0sf_k_hcZwNR0lXLdYZlgFI3'; // โฟลเดอร์ที่มี "วิจัยในชั้นเรียน", "กิจกรรมโรงเรียน"
const RESEARCH_FOLDER_ID = '1AprzYr6HU3ht_aGPwH0IFPle8j63YoFg'; // "วิจัยในชั้นเรียน" (มีอยู่แล้ว)
const PADENG_ROOT_NAME = 'PADENG MODEL';

export const PM_MAX_IMAGES = 4;
const IMAGE_MAX = 10 * 1024 * 1024, PDF_MAX = 30 * 1024 * 1024;
const IMAGE_TYPES = { 'image/jpeg': [0xff, 0xd8, 0xff], 'image/png': [0x89, 0x50, 0x4e, 0x47], 'image/webp': null, 'image/heic': null, 'image/heif': null };

const ready = new WeakMap();
export function ensureTeachingWorksSchema(env) {
  if (ready.has(env.DB)) return ready.get(env.DB);
  const p = env.DB.batch([
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS padeng_model_files (
      id INTEGER PRIMARY KEY AUTOINCREMENT, academic_term_id INTEGER NOT NULL, course_id INTEGER NOT NULL, user_id INTEGER NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN ('image','pdf')), subject TEXT, subject_code TEXT, grade_level TEXT, classroom TEXT,
      drive_file_id TEXT NOT NULL, file_name TEXT NOT NULL, mime_type TEXT NOT NULL, file_size INTEGER,
      created_at TEXT NOT NULL DEFAULT (datetime('now')), deleted_at TEXT)`),
    env.DB.prepare('CREATE INDEX IF NOT EXISTS idx_padeng_model_files_term ON padeng_model_files(academic_term_id, user_id, course_id, deleted_at)'),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS classroom_research_files (
      id INTEGER PRIMARY KEY AUTOINCREMENT, academic_term_id INTEGER NOT NULL, user_id INTEGER NOT NULL, title TEXT NOT NULL,
      drive_file_id TEXT NOT NULL, file_name TEXT NOT NULL, file_size INTEGER,
      created_at TEXT NOT NULL DEFAULT (datetime('now')), deleted_at TEXT)`),
    env.DB.prepare('CREATE INDEX IF NOT EXISTS idx_classroom_research_term ON classroom_research_files(academic_term_id, user_id, deleted_at)'),
    env.DB.prepare('CREATE TABLE IF NOT EXISTS teaching_work_folders (key TEXT PRIMARY KEY, folder_id TEXT NOT NULL)'),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS padeng_model_reports (
      id INTEGER PRIMARY KEY AUTOINCREMENT, academic_term_id INTEGER NOT NULL, course_id INTEGER NOT NULL, user_id INTEGER NOT NULL,
      academic_year TEXT, learning_area TEXT, subject TEXT, grade TEXT, term_no TEXT, teacher_name TEXT,
      teach_date TEXT, topic TEXT, result TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE (academic_term_id, course_id, user_id))`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS teacher_signatures (
      user_id INTEGER PRIMARY KEY, data_url TEXT NOT NULL, updated_at TEXT NOT NULL DEFAULT (datetime('now')))`),
  ]).catch((e) => { ready.delete(env.DB); throw e; });
  ready.set(env.DB, p);
  return p;
}

// ---------- สิทธิ์ ----------
export async function teachingWorkPermissions(env, user) {
  if (!user?.role || user.role === 'viewer') return { submit: false, academic: false };
  if (user.role === 'superadmin') return { submit: true, academic: true };
  await ensurePersonnelData(env); await ensureDepartmentStaff(env);
  const { results } = await env.DB.prepare(`SELECT p.departments,
    EXISTS(SELECT 1 FROM department_staff d WHERE d.personnel_id=p.id AND d.department='academic') in_academic
    FROM personnel_records p JOIN personnel_accounts a ON a.personnel_id=p.id WHERE a.user_id=? AND p.status='active'`).bind(user.id).all();
  const academic = results.some((p) => Number(p.in_academic) === 1 || belongsToDepartment(p.departments, 'academic'));
  return { submit: true, academic };
}

// ---------- ภาคเรียน ----------
async function listTerms(env) {
  const { results } = await env.DB.prepare(`SELECT t.id, t.term_number, t.name, t.status, t.academic_year_id, y.year_be
    FROM academic_terms t JOIN academic_years y ON y.id = t.academic_year_id ORDER BY y.year_be DESC, t.term_number DESC`).all();
  return results;
}
async function resolveTerm(env, termId) {
  const terms = await listTerms(env);
  const term = termId ? terms.find((t) => t.id === Number(termId)) : (terms.find((t) => t.status === 'active') || terms[0]);
  return { term: term || null, terms };
}
const termLabel = (t) => `${t.year_be} ภาคเรียนที่ ${t.term_number}`;

// วิชา×ห้องที่ครูสอนในปีของภาคเรียนนั้น (ข้อมูลกลางจากฝ่ายวัดผล)
async function coursesOf(env, term) {
  const master = await teachingMaster(env, { termId: term.id });
  return master.courses.map((c) => ({
    course_id: c.course_id, subject: c.subject, subject_code: c.subject_code, grade_level: c.grade_level, classroom: c.classroom,
    teachers: c.teachers.map((t) => ({ user_id: t.user_id, full_name: t.full_name })),
  }));
}
const roomLabel = (c) => `${c.grade_level}${c.classroom ? ' ห้อง ' + c.classroom : ''}`; // ชื่อไฟล์ห้ามมี /
const courseLabel = (c) => `${c.subject}${c.subject_code ? ` (${c.subject_code})` : ''} ${roomLabel(c)}`;

// ---------- Google Drive ----------
const safeName = (s) => String(s || '').replace(/[\\/:*?"<>|\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 150);
const q = (v) => String(v).replace(/\\/g, '\\\\').replace(/'/g, "\\'");

async function findOrCreateFolder(env, drive, token, parentId, name) {
  const key = `${parentId}/${name}`;
  const saved = await env.DB.prepare('SELECT folder_id FROM teaching_work_folders WHERE key = ?').bind(key).first();
  if (saved) return saved.folder_id;
  const query = encodeURIComponent(`'${q(parentId)}' in parents and name = '${q(name)}' and mimeType = 'application/vnd.google-apps.folder' and trashed = false`);
  const found = await (await drive.request(token, `/files?q=${query}&pageSize=1&fields=files(id)&supportsAllDrives=true&includeItemsFromAllDrives=true`)).json();
  let id = found.files?.[0]?.id;
  if (!id) {
    id = (await (await drive.request(token, '/files?fields=id&supportsAllDrives=true', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, mimeType: 'application/vnd.google-apps.folder', parents: [parentId] }),
    })).json()).id;
  }
  await env.DB.prepare('INSERT OR REPLACE INTO teaching_work_folders (key, folder_id) VALUES (?, ?)').bind(key, id).run();
  return id;
}
async function folderPath(env, drive, token, rootId, names) {
  let id = rootId;
  for (const n of names) id = await findOrCreateFolder(env, drive, token, id, n);
  return id;
}
async function uploadFile(drive, token, folderId, name, mimeType, bytes) {
  const boundary = `tw_${crypto.randomUUID()}`;
  const body = new Blob([
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify({ name, mimeType, parents: [folderId] })}\r\n`,
    `--${boundary}\r\nContent-Type: ${mimeType}\r\n\r\n`, bytes, `\r\n--${boundary}--`,
  ]);
  return (await drive.request(token, '/upload/drive/v3/files?uploadType=multipart&supportsAllDrives=true&fields=id,name,size', {
    method: 'POST', headers: { 'Content-Type': `multipart/related; boundary=${boundary}` }, body,
  })).json();
}
async function trashFile(drive, token, id) {
  await drive.request(token, `/files/${encodeURIComponent(id)}?supportsAllDrives=true`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ trashed: true }),
  });
}
const media = (drive, token, id) => drive.request(token, `/files/${encodeURIComponent(id)}?alt=media&supportsAllDrives=true`);

// ---------- ตรวจไฟล์ ----------
async function checkFile(file, kind) {
  if (!file || typeof file === 'string' || typeof file.arrayBuffer !== 'function') return { error: 'กรุณาเลือกไฟล์' };
  if (!file.size) return { error: 'ไฟล์ว่างหรือไม่สมบูรณ์' };
  const head = new Uint8Array(await file.slice(0, 8).arrayBuffer());
  if (kind === 'pdf') {
    if (String.fromCharCode(...head.slice(0, 5)) !== '%PDF-') return { error: 'รับเฉพาะไฟล์ PDF' };
    if (file.size > PDF_MAX) return { error: 'ไฟล์ PDF ต้องไม่เกิน 30 MB' };
    return { mimeType: 'application/pdf' };
  }
  const mimeType = String(file.type || '').toLowerCase();
  if (!(mimeType in IMAGE_TYPES)) return { error: 'รับเฉพาะไฟล์ภาพ (JPG, PNG, WEBP, HEIC)' };
  const sig = IMAGE_TYPES[mimeType];
  if (sig && !sig.every((b, i) => head[i] === b)) return { error: 'ชนิดไฟล์ไม่ตรงกับเนื้อหาไฟล์' };
  if (file.size > IMAGE_MAX) return { error: 'ภาพต้องไม่เกิน 10 MB ต่อภาพ' };
  return { mimeType };
}
const extOf = (name, mime) => (String(name).match(/\.[a-z0-9]{2,5}$/i)?.[0] || ({ 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp', 'application/pdf': '.pdf' }[mime] || '')).toLowerCase();

// ---------- ป่าเด็งโมเดล ----------
async function padengRows(env, termId, userId = null) {
  const sql = `SELECT id, course_id, user_id, kind, file_name, file_size, created_at FROM padeng_model_files
    WHERE academic_term_id = ? AND kind = 'image' AND deleted_at IS NULL ${userId ? 'AND user_id = ?' : ''} ORDER BY id`;
  return (await env.DB.prepare(sql).bind(...(userId ? [termId, userId] : [termId])).all()).results;
}
// ---------- แบบรายงาน (ค่าเริ่มต้นดึงจากข้อมูลวิชา×ห้อง ครูแก้ได้) ----------
const LEARNING_AREAS = { 'ท': 'ภาษาไทย', 'ค': 'คณิตศาสตร์', 'ว': 'วิทยาศาสตร์และเทคโนโลยี', 'ส': 'สังคมศึกษา ศาสนาและวัฒนธรรม',
  'พ': 'สุขศึกษาและพลศึกษา', 'ศ': 'ศิลปะ', 'ง': 'การงานอาชีพ', 'อ': 'ภาษาต่างประเทศ', 'จ': 'ภาษาต่างประเทศ', 'I': 'การศึกษาค้นคว้าด้วยตนเอง' };
const REPORT_FIELDS = { academic_year: 20, learning_area: 120, subject: 150, grade: 30, term_no: 10, teacher_name: 150, teach_date: 10, topic: 300, result: 6000 };
export function reportDefaults(term, course, teacherName) {
  const level = String(course.grade_level || '').replace(/^(ป\.|ประถมศึกษาปีที่|อ\.|อนุบาล)\s*/, '');
  return {
    academic_year: String(term.year_be), term_no: String(term.term_number), teacher_name: teacherName || '',
    learning_area: LEARNING_AREAS[String(course.subject_code || '').trim().charAt(0)] || '',
    subject: course.subject || '', grade: `${level}${course.classroom ? '/' + course.classroom : ''}`,
    kindergarten: /^(อ\.|อนุบาล)/.test(String(course.grade_level || '')),
  };
}
async function reportRows(env, termId, userId = null) {
  const sql = `SELECT * FROM padeng_model_reports WHERE academic_term_id = ? ${userId ? 'AND user_id = ?' : ''}`;
  return (await env.DB.prepare(sql).bind(...(userId ? [termId, userId] : [termId])).all()).results;
}
const reportDone = (r) => !!(r && String(r.topic || '').trim() && String(r.result || '').trim());
function mergeReport(defaults, saved) {
  const out = { ...defaults, teach_date: '', topic: '', result: '', saved: !!saved, updated_at: saved?.updated_at || null };
  if (saved) for (const k of Object.keys(REPORT_FIELDS)) if (saved[k] != null && saved[k] !== '') out[k] = saved[k];
  return out;
}

// ลายเซ็นครู (PNG พื้นใส ระบบตัดพื้นหลัง/ทำเส้นเข้มในเบราว์เซอร์ก่อนส่ง) — อัปครั้งเดียวใช้ทุกฉบับ
const SIGNATURE_MAX = 400 * 1024;
async function signatureOf(env, userId) {
  return (await env.DB.prepare('SELECT data_url, updated_at FROM teacher_signatures WHERE user_id = ?').bind(userId).first()) || null;
}
async function signedUsers(env) {
  return new Set((await env.DB.prepare('SELECT user_id FROM teacher_signatures').all()).results.map((r) => r.user_id));
}
async function saveSignature(request, env, user) {
  const body = await request.json().catch(() => null);
  const dataUrl = String(body?.data_url || '');
  const m = /^data:image\/png;base64,([A-Za-z0-9+/]+={0,2})$/.exec(dataUrl);
  if (!m) return jsonResponse({ error: 'ไฟล์ลายเซ็นไม่ถูกต้อง' }, 400);
  if (dataUrl.length > SIGNATURE_MAX) return jsonResponse({ error: 'ไฟล์ลายเซ็นใหญ่เกินไป' }, 400);
  const head = atob(m[1].slice(0, 12));
  if (!head.startsWith('\x89PNG')) return jsonResponse({ error: 'ไฟล์ลายเซ็นไม่ใช่ภาพ PNG' }, 400);
  await env.DB.prepare(`INSERT INTO teacher_signatures (user_id, data_url) VALUES (?, ?)
    ON CONFLICT (user_id) DO UPDATE SET data_url = excluded.data_url, updated_at = datetime('now')`).bind(user.id, dataUrl).run();
  return jsonResponse({ ok: true });
}

function attachFiles(courses, rows, userId, reports = [], term = null, teacherName = '', signed = false) {
  return courses.map((c) => {
    const images = rows.filter((r) => r.course_id === c.course_id && r.user_id === userId);
    const saved = reports.find((r) => r.course_id === c.course_id && r.user_id === userId) || null;
    const report = term ? mergeReport(reportDefaults(term, c, teacherName), saved) : null;
    return { course_id: c.course_id, subject: c.subject, subject_code: c.subject_code, grade_level: c.grade_level, classroom: c.classroom,
      images, report, reported: reportDone(saved), complete: images.length > 0 && reportDone(saved) && signed };
  });
}

async function padengMine(env, user, url) {
  const { term, terms } = await resolveTerm(env, url.searchParams.get('term_id'));
  if (!term) return jsonResponse({ term: null, terms, courses: [] });
  const courses = (await coursesOf(env, term)).filter((c) => c.teachers.some((t) => t.user_id === user.id));
  const signature = await signatureOf(env, user.id);
  return jsonResponse({ term, terms, max_images: PM_MAX_IMAGES, signature,
    courses: attachFiles(courses, await padengRows(env, term.id, user.id), user.id, await reportRows(env, term.id, user.id), term, user.full_name, !!signature) });
}

async function padengUpload(request, env, user, drive) {
  const form = await request.formData().catch(() => null);
  const kind = String(form?.get('kind') || '');
  if (kind === 'pdf') return jsonResponse({ error: 'เลิกใช้การอัปโหลด PDF แล้ว กรุณากรอกแบบรายงานในระบบแทน' }, 410);
  if (kind !== 'image') return jsonResponse({ error: 'ชนิดงานไม่ถูกต้อง' }, 400);
  const { term } = await resolveTerm(env, form.get('term_id'));
  if (!term) return jsonResponse({ error: 'ยังไม่มีภาคเรียน' }, 400);
  if (term.status === 'closed') return jsonResponse({ error: 'ภาคเรียนนี้ปิดแล้ว ส่งงานไม่ได้' }, 409);
  const course = (await coursesOf(env, term)).find((c) => c.course_id === Number(form.get('course_id')));
  if (!course || !course.teachers.some((t) => t.user_id === user.id)) return jsonResponse({ error: 'คุณไม่ได้เป็นครูผู้สอนวิชานี้ (ตามข้อมูลฝ่ายวัดผล)' }, 403);
  const file = form.get('file');
  const checked = await checkFile(file, kind);
  if (checked.error) return jsonResponse({ error: checked.error }, 400);
  const existing = (await padengRows(env, term.id, user.id)).filter((r) => r.course_id === course.course_id);
  if (kind === 'image' && existing.filter((r) => r.kind === 'image').length >= PM_MAX_IMAGES) {
    return jsonResponse({ error: `ส่งภาพได้ไม่เกิน ${PM_MAX_IMAGES} ภาพต่อวิชา ลบภาพเดิมก่อนถ้าต้องการเปลี่ยน` }, 409);
  }
  const driveError = drive.ready(env);
  if (driveError) return jsonResponse({ error: driveError }, 503);
  const token = await drive.token(env);
  const root = await findOrCreateFolder(env, drive, token, env.PADENG_MODEL_PARENT_ID || SCHOOL_FOLDER_ID, PADENG_ROOT_NAME);
  const label = safeName(`${user.full_name} - ${courseLabel(course)}`);
  const folderId = await folderPath(env, drive, token, root, [termLabel(term), 'ภาพ', label]);
  const name = `${label} ภาพที่ ${existing.length + 1}${extOf(file.name, checked.mimeType)}`;
  const up = await uploadFile(drive, token, folderId, name, checked.mimeType, new Uint8Array(await file.arrayBuffer()));
  await env.DB.prepare(`INSERT INTO padeng_model_files (academic_term_id, course_id, user_id, kind, subject, subject_code, grade_level, classroom, drive_file_id, file_name, mime_type, file_size)
    VALUES (?, ?, ?, 'image', ?, ?, ?, ?, ?, ?, ?, ?)`).bind(term.id, course.course_id, user.id, course.subject, course.subject_code, course.grade_level, course.classroom, up.id, name, checked.mimeType, file.size).run();
  return jsonResponse({ ok: true }, 201);
}

// ครูบันทึกแบบรายงาน (ส่งซ้ำ = แก้ไขฉบับเดิม)
async function padengSaveReport(request, env, user) {
  const body = await request.json().catch(() => null);
  if (!body) return jsonResponse({ error: 'ข้อมูลไม่ถูกต้อง' }, 400);
  const { term } = await resolveTerm(env, body.term_id);
  if (!term) return jsonResponse({ error: 'ยังไม่มีภาคเรียน' }, 400);
  if (term.status === 'closed') return jsonResponse({ error: 'ภาคเรียนนี้ปิดแล้ว ส่งงานไม่ได้' }, 409);
  const course = (await coursesOf(env, term)).find((c) => c.course_id === Number(body.course_id));
  if (!course || !course.teachers.some((t) => t.user_id === user.id)) return jsonResponse({ error: 'คุณไม่ได้เป็นครูผู้สอนวิชานี้ (ตามข้อมูลฝ่ายวัดผล)' }, 403);
  const v = {};
  for (const [k, max] of Object.entries(REPORT_FIELDS)) {
    const raw = String(body[k] ?? '').replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '');
    v[k] = (k === 'result' ? raw.replace(/[ \t]+$/gm, '').trim() : raw.replace(/\s+/g, ' ').trim());
    if (v[k].length > max) return jsonResponse({ error: `ข้อความยาวเกินกำหนด (${k})` }, 400);
  }
  if (v.teach_date && !/^\d{4}-\d{2}-\d{2}$/.test(v.teach_date)) return jsonResponse({ error: 'วันที่ไม่ถูกต้อง' }, 400);
  if (!v.topic) return jsonResponse({ error: 'กรุณากรอกเรื่องที่สอน' }, 400);
  if (!v.result) return jsonResponse({ error: 'กรุณากรอกผลการจัดกิจกรรมการสอน' }, 400);
  if (!(await signatureOf(env, user.id))) return jsonResponse({ error: 'กรุณาอัปโหลดลายเซ็นก่อนบันทึกแบบรายงาน' }, 400);
  const keys = Object.keys(REPORT_FIELDS);
  await env.DB.prepare(`INSERT INTO padeng_model_reports (academic_term_id, course_id, user_id, ${keys.join(', ')})
    VALUES (?, ?, ?, ${keys.map(() => '?').join(', ')})
    ON CONFLICT (academic_term_id, course_id, user_id) DO UPDATE SET ${keys.map((k) => `${k} = excluded.${k}`).join(', ')}, updated_at = datetime('now')`)
    .bind(term.id, course.course_id, user.id, ...keys.map((k) => v[k] || null)).run();
  return jsonResponse({ ok: true });
}

// ข้อมูลสำหรับสร้างเอกสาร (PDF/Word) — รายฉบับ (user_id+course_id) หรือรวมเล่มทั้งภาคเรียน (เลือกชั้นได้)
async function padengDocuments(env, user, perms, url) {
  const { term } = await resolveTerm(env, url.searchParams.get('term_id'));
  if (!term) return jsonResponse({ error: 'ไม่พบภาคเรียน' }, 404);
  const userId = Number(url.searchParams.get('user_id')) || null, courseId = Number(url.searchParams.get('course_id')) || null;
  const grade = url.searchParams.get('grade_level') || '';
  if (!perms.academic && userId !== user.id) return jsonResponse({ error: 'เฉพาะฝ่ายวิชาการเท่านั้น' }, 403);
  const courses = await coursesOf(env, term);
  const [reports, images] = await Promise.all([reportRows(env, term.id, userId), padengRows(env, term.id, userId)]);
  const names = new Map(); for (const c of courses) for (const t of c.teachers) names.set(t.user_id, t.full_name);
  const items = [];
  for (const r of reports) {
    if (!reportDone(r) || (courseId && r.course_id !== courseId)) continue;
    const c = courses.find((x) => x.course_id === r.course_id);
    if (!c || (grade && c.grade_level !== grade)) continue;
    const doc = mergeReport(reportDefaults(term, c, names.get(r.user_id) || ''), r);
    items.push({ ...doc, user_id: r.user_id, course_id: r.course_id, grade_level: c.grade_level, classroom: c.classroom, subject_code: c.subject_code,
      images: images.filter((i) => i.course_id === r.course_id && i.user_id === r.user_id).slice(0, PM_MAX_IMAGES).map((i) => i.id) });
  }
  const gradeOrder = (g) => [/^(อ\.|อนุบาล)/.test(g) ? 0 : 1, g];
  items.sort((a, b) => { const [x, y] = [gradeOrder(a.grade_level), gradeOrder(b.grade_level)];
    return x[0] - y[0] || x[1].localeCompare(y[1], 'th') || String(a.classroom || '').localeCompare(String(b.classroom || ''), 'th', { numeric: true })
      || String(a.subject_code || '').localeCompare(String(b.subject_code || ''), 'th') || a.teacher_name.localeCompare(b.teacher_name, 'th'); });
  if (!items.length) return jsonResponse({ error: 'ยังไม่มีแบบรายงานที่ส่งแล้ว' }, 404);
  const ids = [...new Set(items.map((i) => i.user_id))], signatures = {};
  for (let i = 0; i < ids.length; i += 50) {
    const part = ids.slice(i, i + 50);
    const { results } = await env.DB.prepare(`SELECT user_id, data_url FROM teacher_signatures WHERE user_id IN (${part.map(() => '?').join(',')})`).bind(...part).all();
    for (const r of results) signatures[r.user_id] = r.data_url;
  }
  return jsonResponse({ term, items, signatures });
}

async function padengProgress(env, url) {
  const { term, terms } = await resolveTerm(env, url.searchParams.get('term_id'));
  if (!term) return jsonResponse({ term: null, terms, teachers: [] });
  const courses = await coursesOf(env, term);
  const [rows, reports, signed] = await Promise.all([padengRows(env, term.id), reportRows(env, term.id), signedUsers(env)]);
  const byTeacher = new Map();
  for (const c of courses) for (const t of c.teachers) {
    if (!byTeacher.has(t.user_id)) byTeacher.set(t.user_id, { user_id: t.user_id, full_name: t.full_name, courses: [] });
    byTeacher.get(t.user_id).courses.push(c);
  }
  const teachers = [...byTeacher.values()].map((t) => {
    const list = attachFiles(t.courses, rows, t.user_id, reports, term, t.full_name, signed.has(t.user_id));
    return { user_id: t.user_id, full_name: t.full_name, signed: signed.has(t.user_id), total: list.length, complete: list.filter((c) => c.complete).length,
      images: list.reduce((s, c) => s + c.images.length, 0), reports: list.filter((c) => c.reported).length, courses: list };
  }).sort((a, b) => a.full_name.localeCompare(b.full_name, 'th'));
  const grades = [...new Set(courses.map((c) => c.grade_level))];
  return jsonResponse({ term, terms, max_images: PM_MAX_IMAGES, teachers, grades });
}

// ---------- วิจัยในชั้นเรียน ----------
async function researchRows(env, termId, userId = null) {
  const sql = `SELECT r.id, r.user_id, r.title, r.file_name, r.file_size, r.created_at, u.full_name FROM classroom_research_files r
    LEFT JOIN users u ON u.id = r.user_id WHERE r.academic_term_id = ? AND r.deleted_at IS NULL ${userId ? 'AND r.user_id = ?' : ''} ORDER BY r.id`;
  return (await env.DB.prepare(sql).bind(...(userId ? [termId, userId] : [termId])).all()).results;
}
async function researchMine(env, user, url) {
  const { term, terms } = await resolveTerm(env, url.searchParams.get('term_id'));
  if (!term) return jsonResponse({ term: null, terms, file: null });
  const [file] = await researchRows(env, term.id, user.id);
  return jsonResponse({ term, terms, file: file || null });
}
async function researchUpload(request, env, user, drive) {
  const form = await request.formData().catch(() => null);
  const { term } = await resolveTerm(env, form?.get('term_id'));
  if (!term) return jsonResponse({ error: 'ยังไม่มีภาคเรียน' }, 400);
  if (term.status === 'closed') return jsonResponse({ error: 'ภาคเรียนนี้ปิดแล้ว ส่งงานไม่ได้' }, 409);
  const title = safeName(form.get('title'));
  if (!title) return jsonResponse({ error: 'กรุณากรอกชื่อเรื่องวิจัย' }, 400);
  const file = form.get('file');
  const checked = await checkFile(file, 'pdf');
  if (checked.error) return jsonResponse({ error: checked.error }, 400);
  const driveError = drive.ready(env);
  if (driveError) return jsonResponse({ error: driveError }, 503);
  const token = await drive.token(env);
  const folderId = await folderPath(env, drive, token, env.RESEARCH_FOLDER_ID || RESEARCH_FOLDER_ID, [String(term.year_be), `ภาคเรียนที่ ${term.term_number}`]);
  const name = `${safeName(user.full_name)} - ${title}.pdf`;
  const up = await uploadFile(drive, token, folderId, name, 'application/pdf', new Uint8Array(await file.arrayBuffer()));
  const old = await env.DB.prepare('SELECT id, drive_file_id FROM classroom_research_files WHERE academic_term_id = ? AND user_id = ? AND deleted_at IS NULL').bind(term.id, user.id).all();
  const stmts = old.results.map((o) => env.DB.prepare("UPDATE classroom_research_files SET deleted_at = datetime('now') WHERE id = ?").bind(o.id));
  stmts.push(env.DB.prepare('INSERT INTO classroom_research_files (academic_term_id, user_id, title, drive_file_id, file_name, file_size) VALUES (?, ?, ?, ?, ?, ?)')
    .bind(term.id, user.id, title, up.id, name, file.size));
  await env.DB.batch(stmts);
  for (const o of old.results) await trashFile(drive, token, o.drive_file_id).catch(() => {});
  return jsonResponse({ ok: true, replaced: old.results.length > 0 }, 201);
}
async function researchProgress(env, url) {
  const { term, terms } = await resolveTerm(env, url.searchParams.get('term_id'));
  if (!term) return jsonResponse({ term: null, terms, teachers: [] });
  const files = await researchRows(env, term.id);
  const people = new Map();
  for (const c of await coursesOf(env, term)) for (const t of c.teachers) people.set(t.user_id, t.full_name);
  for (const f of files) if (!people.has(f.user_id)) people.set(f.user_id, f.full_name);
  const teachers = [...people].map(([user_id, full_name]) => ({ user_id, full_name, file: files.find((f) => f.user_id === user_id) || null }))
    .sort((a, b) => a.full_name.localeCompare(b.full_name, 'th'));
  return jsonResponse({ term, terms, teachers });
}

// ---------- ไฟล์ / zip ----------
async function fileRow(env, kind, id) {
  return kind === 'padeng'
    ? env.DB.prepare("SELECT f.*, u.full_name FROM padeng_model_files f LEFT JOIN users u ON u.id = f.user_id WHERE f.id = ? AND f.kind = 'image' AND f.deleted_at IS NULL").bind(id).first()
    : env.DB.prepare("SELECT f.*, 'application/pdf' AS mime_type, u.full_name FROM classroom_research_files f LEFT JOIN users u ON u.id = f.user_id WHERE f.id = ? AND f.deleted_at IS NULL").bind(id).first();
}
async function serveFile(env, user, perms, kind, id, url, drive) {
  const row = await fileRow(env, kind, id);
  if (!row) return jsonResponse({ error: 'ไม่พบไฟล์' }, 404);
  if (row.user_id !== user.id && !perms.academic) return jsonResponse({ error: 'ไม่มีสิทธิ์เปิดไฟล์นี้' }, 403);
  const res = await media(drive, await drive.token(env), row.drive_file_id);
  const disposition = url.searchParams.has('download') ? 'attachment' : 'inline';
  return new Response(res.body, { headers: {
    'Content-Type': row.mime_type, 'Cache-Control': 'private, max-age=300', 'X-Content-Type-Options': 'nosniff',
    'Content-Disposition': `${disposition}; filename="file-${row.id}${extOf(row.file_name, row.mime_type)}"; filename*=UTF-8''${encodeURIComponent(row.file_name)}`,
  } });
}
async function deleteFile(env, user, perms, kind, id, drive) {
  const row = await fileRow(env, kind, id);
  if (!row) return jsonResponse({ error: 'ไม่พบไฟล์' }, 404);
  if (row.user_id !== user.id && user.role !== 'superadmin') return jsonResponse({ error: 'ลบได้เฉพาะงานของตนเอง' }, 403);
  const term = await env.DB.prepare('SELECT status FROM academic_terms WHERE id = ?').bind(row.academic_term_id).first();
  if (term?.status === 'closed' && user.role !== 'superadmin') return jsonResponse({ error: 'ภาคเรียนนี้ปิดแล้ว แก้ไขงานไม่ได้' }, 409);
  const table = kind === 'padeng' ? 'padeng_model_files' : 'classroom_research_files';
  await env.DB.prepare(`UPDATE ${table} SET deleted_at = datetime('now') WHERE id = ?`).bind(id).run();
  if (!drive.ready(env)) await trashFile(drive, await drive.token(env), row.drive_file_id).catch(() => {});
  return jsonResponse({ ok: true });
}
// ดาวน์โหลดรวม (ฝ่ายวิชาการ): ทั้งภาคเรียน หรือเฉพาะครูคนเดียว (user_id)
async function zipDownload(env, kind, url, drive) {
  const { term } = await resolveTerm(env, url.searchParams.get('term_id'));
  if (!term) return jsonResponse({ error: 'ไม่พบภาคเรียน' }, 404);
  const userId = Number(url.searchParams.get('user_id')) || null;
  let entries;
  if (kind === 'padeng') {
    const rows = (await env.DB.prepare(`SELECT f.*, u.full_name FROM padeng_model_files f LEFT JOIN users u ON u.id = f.user_id
      WHERE f.academic_term_id = ? AND f.kind = 'image' AND f.deleted_at IS NULL ${userId ? 'AND f.user_id = ?' : ''} ORDER BY u.full_name, f.grade_level, f.classroom, f.id`)
      .bind(...(userId ? [term.id, userId] : [term.id])).all()).results;
    const names = uniqueNames(rows.map((r) => `ภาพ/${safeName(`${r.full_name} - ${courseLabel(r)}`)}/${r.file_name}`));
    entries = rows.map((r, i) => ({ name: names[i], id: r.drive_file_id }));
  } else {
    const rows = (await env.DB.prepare(`SELECT f.* FROM classroom_research_files f WHERE f.academic_term_id = ? AND f.deleted_at IS NULL ${userId ? 'AND f.user_id = ?' : ''} ORDER BY f.file_name`)
      .bind(...(userId ? [term.id, userId] : [term.id])).all()).results;
    const names = uniqueNames(rows.map((r) => r.file_name));
    entries = rows.map((r, i) => ({ name: names[i], id: r.drive_file_id }));
  }
  if (!entries.length) return jsonResponse({ error: 'ยังไม่มีไฟล์ให้ดาวน์โหลด' }, 404);
  const token = await drive.token(env);
  const stream = zipStream(entries.map((e) => ({ name: e.name.replace(/[:*?"<>|\\]/g, '_'), open: async () => (await media(drive, token, e.id)).body })),
    (entry, e) => console.error('teaching-works zip', entry?.name, e?.message));
  const fileName = `${kind === 'padeng' ? 'ป่าเด็งโมเดล' : 'วิจัยในชั้นเรียน'} ${termLabel(term)}.zip`;
  return new Response(stream, { headers: {
    'Content-Type': 'application/zip', 'Cache-Control': 'no-store',
    'Content-Disposition': `attachment; filename="${kind}-${term.id}.zip"; filename*=UTF-8''${encodeURIComponent(fileName)}`,
  } });
}

// ---------- router ----------
export async function handleTeachingWorksRoute(request, env, pathname, method, drive) {
  if (!pathname.startsWith('/api/teaching-works/')) return null;
  const user = await getCurrentUser(request, env);
  if (!user) return jsonResponse({ error: 'กรุณาเข้าสู่ระบบ' }, 401);
  await ensureTeachingWorksSchema(env);
  const perms = await teachingWorkPermissions(env, user);
  if (!perms.submit) return jsonResponse({ error: 'บัญชีนี้ยังไม่มีสิทธิ์ใช้งานส่วนนี้' }, 403);
  const url = new URL(request.url);
  const sub = pathname.slice('/api/teaching-works/'.length);
  if (sub === 'permissions' && method === 'GET') return jsonResponse(perms);
  if (sub === 'padeng/mine' && method === 'GET') return padengMine(env, user, url);
  if (sub === 'padeng/upload' && method === 'POST') return padengUpload(request, env, user, drive);
  if (sub === 'padeng/report' && method === 'PUT') return padengSaveReport(request, env, user);
  if (sub === 'padeng/signature' && method === 'PUT') return saveSignature(request, env, user);
  if (sub === 'padeng/documents' && method === 'GET') return padengDocuments(env, user, perms, url);
  if (sub === 'research/mine' && method === 'GET') return researchMine(env, user, url);
  if (sub === 'research/upload' && method === 'POST') return researchUpload(request, env, user, drive);
  const file = sub.match(/^(padeng|research)\/files\/(\d+)$/);
  if (file && method === 'GET') return serveFile(env, user, perms, file[1], Number(file[2]), url, drive);
  if (file && method === 'DELETE') return deleteFile(env, user, perms, file[1], Number(file[2]), drive);
  // ด้านล่างเฉพาะฝ่ายวิชาการ
  const academicOnly = /^(padeng|research)\/(progress|zip)$/.exec(sub);
  if (academicOnly && method === 'GET') {
    if (!perms.academic) return jsonResponse({ error: 'เฉพาะฝ่ายวิชาการเท่านั้น' }, 403);
    if (academicOnly[2] === 'zip') return zipDownload(env, academicOnly[1], url, drive);
    return academicOnly[1] === 'padeng' ? padengProgress(env, url) : researchProgress(env, url);
  }
  return jsonResponse({ error: 'ไม่พบหน้านี้' }, 404);
}
