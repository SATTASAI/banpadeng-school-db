// ฝ่ายวิชาการ → แผนการจัดการเรียนการสอน: ดูความคืบหน้าการอัพโหลดแผนฯ ที่ครูส่งผ่าน teachingmedia (ตาราง tm_lesson_plans ใน D1 เดียวกัน)
// ผู้ดู: ผู้บริหาร (role executive) หัวหน้าฝ่ายวิชาการ (department_staff academic is_head=1) และ superadmin
// อ่านอย่างเดียว: ดูไฟล์/ดาวน์โหลดได้ แก้ไขหรือลบไม่ได้ (ครูจัดการแผนฯ ของตนเองใน teachingmedia)
import { getCurrentUser, jsonResponse } from '../lib/auth.js';
import { teachingMaster } from '../lib/teaching-master.js';

const OFFICE = { document: 'application/vnd.google-apps.document', spreadsheet: 'application/vnd.google-apps.spreadsheet', presentation: 'application/vnd.google-apps.presentation' };
const PREVIEW_FOLDER_NAME = '_ตัวอย่างไฟล์ (ระบบ)';
const TEXT_EXT = new Set(['txt', 'csv', 'tsv', 'md']);

async function tableExists(env, name) {
  return !!(await env.DB.prepare("SELECT 1 AS ok FROM sqlite_master WHERE type='table' AND name = ?").bind(name).first());
}

export async function canViewLessonPlans(env, user) {
  if (!user?.role || user.role === 'viewer') return false;
  if (['superadmin', 'executive'].includes(user.role)) return true;
  if (!(await tableExists(env, 'department_staff')) || !(await tableExists(env, 'personnel_accounts'))) return false;
  const row = await env.DB.prepare(`SELECT 1 AS ok FROM department_staff d JOIN personnel_accounts a ON a.personnel_id = d.personnel_id
    WHERE d.department = 'academic' AND d.is_head = 1 AND a.user_id = ? LIMIT 1`).bind(user.id).first().catch(() => null);
  return !!row;
}

async function resolveTerm(env, termId) {
  const { results: terms } = await env.DB.prepare(`SELECT t.id, t.term_number, t.status, y.year_be FROM academic_terms t
    JOIN academic_years y ON y.id = t.academic_year_id ORDER BY y.year_be DESC, t.term_number DESC`).all();
  const term = termId ? terms.find((t) => t.id === Number(termId)) : (terms.find((t) => t.status === 'active') || terms[0]);
  return { term: term || null, terms };
}

const norm = (v) => String(v ?? '').normalize('NFC').replace(/\s+/g, ' ').trim();
const subjectLabel = (s) => `${s.subject_name}${s.subject_code ? ` (${s.subject_code})` : ''}${s.grade_level ? ` ${s.grade_level}` : ''}`;

async function progress(env, url) {
  const { term, terms } = await resolveTerm(env, url.searchParams.get('term_id'));
  if (!term) return jsonResponse({ term: null, terms, teachers: [] });
  const master = await teachingMaster(env, { termId: term.id });
  const teachers = new Map();
  const teacher = (id, name) => { if (!teachers.has(id)) teachers.set(id, { user_id: id, full_name: name || '', subjects: new Map(), files: 0 }); return teachers.get(id); };
  const subjectOf = (t, s) => {
    const key = `${norm(s.subject_code) || norm(s.subject_name)}|${norm(s.grade_level)}`;
    if (!t.subjects.has(key)) t.subjects.set(key, { label: subjectLabel(s), units: new Map(), expected: false });
    return t.subjects.get(key);
  };
  for (const c of master.courses) for (const tc of c.teachers) subjectOf(teacher(tc.user_id, tc.full_name), { subject_name: c.subject, subject_code: c.subject_code, grade_level: c.grade_level }).expected = true;
  if (await tableExists(env, 'tm_lesson_plans')) {
    const { results } = await env.DB.prepare(`SELECT p.id, p.owner_id, p.subject_name, p.subject_code, p.grade_level, p.unit_no, p.file_name, p.ext, p.file_size, p.category, p.created_at, u.full_name
      FROM tm_lesson_plans p LEFT JOIN users u ON u.id = p.owner_id WHERE p.academic_term_id = ? ORDER BY p.unit_no, p.file_name`).bind(term.id).all();
    for (const r of results) {
      const t = teacher(r.owner_id, r.full_name), s = subjectOf(t, r);
      if (!s.units.has(r.unit_no)) s.units.set(r.unit_no, []);
      s.units.get(r.unit_no).push({ id: r.id, file_name: r.file_name, ext: r.ext, file_size: r.file_size, category: r.category, created_at: r.created_at });
      t.files++;
      if (!t.last_at || r.created_at > t.last_at) t.last_at = r.created_at;
    }
  }
  const list = [...teachers.values()].map((t) => {
    const subjects = [...t.subjects.values()].map((s) => ({ label: s.label, expected: s.expected,
      units: [...s.units.entries()].sort((a, b) => a[0] - b[0]).map(([unit_no, files]) => ({ unit_no, files })) }))
      .sort((a, b) => a.label.localeCompare(b.label, 'th'));
    return { user_id: t.user_id, full_name: t.full_name, files: t.files, last_at: t.last_at || null, subjects,
      units: subjects.reduce((n, s) => n + s.units.length, 0), subjects_done: subjects.filter((s) => s.units.length).length };
  }).sort((a, b) => a.full_name.localeCompare(b.full_name, 'th'));
  return jsonResponse({ term, terms, teachers: list });
}

const asciiName = (n) => String(n || 'file').replace(/[^\x20-\x7e]/g, '_').replace(/"/g, '');
const disposition = (type, name) => `${type}; filename="${asciiName(name)}"; filename*=UTF-8''${encodeURIComponent(name || 'file')}`;

function inlineType(row) {
  const t = String(row.mime_type || '').toLowerCase();
  if (row.category === 'pdf') return 'application/pdf';
  if (/^(image|video|audio)\//.test(t) && t !== 'image/svg+xml') return t;
  return null;
}

async function planRow(env, id) {
  if (!(await tableExists(env, 'tm_lesson_plans'))) return null;
  return env.DB.prepare('SELECT * FROM tm_lesson_plans WHERE id = ?').bind(id).first();
}

async function serveFile(env, drive, row, url) {
  const res = await drive.request(await drive.token(env), `/files/${encodeURIComponent(row.drive_file_id)}?alt=media&supportsAllDrives=true`);
  const type = url.searchParams.has('download') ? null : inlineType(row);
  const headers = { 'Cache-Control': 'private, max-age=300', 'X-Content-Type-Options': 'nosniff' };
  if (type) Object.assign(headers, { 'Content-Type': type, 'Content-Disposition': disposition('inline', row.file_name) });
  else Object.assign(headers, { 'Content-Type': row.mime_type || 'application/octet-stream', 'Content-Disposition': disposition('attachment', row.file_name) });
  if (type && type !== 'application/pdf') headers['Content-Security-Policy'] = "sandbox; default-src 'none'; img-src 'self' data:; media-src 'self'";
  return new Response(res.body, { headers });
}

// เอกสาร Office → แปลงเป็น PDF ครั้งแรกที่เปิดดู แล้วเก็บไว้ (ใช้โฟลเดอร์ตัวอย่างเดียวกับ teachingmedia)
async function previewFolder(env, drive, token) {
  const saved = await env.DB.prepare("SELECT value FROM tm_state WHERE key = 'preview_folder_id'").first().catch(() => null);
  if (saved?.value) return saved.value;
  const root = await env.DB.prepare("SELECT value FROM tm_state WHERE key = 'root_folder_id'").first().catch(() => null);
  if (!root?.value) throw new Error('ไม่พบโฟลเดอร์ Teaching Media');
  const q = encodeURIComponent(`name = '${PREVIEW_FOLDER_NAME}' and mimeType = 'application/vnd.google-apps.folder' and trashed = false and '${root.value}' in parents`);
  let id = (await (await drive.request(token, `/files?q=${q}&pageSize=1&fields=files(id)&supportsAllDrives=true&includeItemsFromAllDrives=true`)).json()).files?.[0]?.id;
  if (!id) id = (await (await drive.request(token, '/files?fields=id&supportsAllDrives=true', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: PREVIEW_FOLDER_NAME, mimeType: 'application/vnd.google-apps.folder', parents: [root.value] }) })).json()).id;
  await env.DB.prepare("INSERT INTO tm_state (key, value) VALUES ('preview_folder_id', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").bind(id).run();
  return id;
}

async function servePreview(env, drive, row, url) {
  if (!OFFICE[row.category] || TEXT_EXT.has(row.ext)) return serveFile(env, drive, row, url);
  const token = await drive.token(env);
  let pid = row.preview_drive_id;
  if (!pid) {
    const folder = await previewFolder(env, drive, token);
    const copy = await (await drive.request(token, `/files/${encodeURIComponent(row.drive_file_id)}/copy?supportsAllDrives=true&fields=id`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: `_preview_${row.title}`, mimeType: OFFICE[row.category], parents: [folder] }),
    })).json();
    try {
      const pdf = await (await drive.request(token, `/files/${copy.id}/export?mimeType=application/pdf`)).arrayBuffer();
      const boundary = `lp_${crypto.randomUUID()}`;
      const body = new Blob([`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify({ name: `${row.title}.pdf`, mimeType: 'application/pdf', parents: [folder] })}\r\n`,
        `--${boundary}\r\nContent-Type: application/pdf\r\n\r\n`, pdf, `\r\n--${boundary}--`]);
      pid = (await (await drive.request(token, '/upload/drive/v3/files?uploadType=multipart&supportsAllDrives=true&fields=id', { method: 'POST', headers: { 'Content-Type': `multipart/related; boundary=${boundary}` }, body })).json()).id;
    } finally {
      await drive.request(token, `/files/${copy.id}?supportsAllDrives=true`, { method: 'DELETE' }).catch(() => {});
    }
    await env.DB.prepare('UPDATE tm_lesson_plans SET preview_drive_id = ? WHERE id = ?').bind(pid, row.id).run();
  }
  const res = await drive.request(token, `/files/${encodeURIComponent(pid)}?alt=media&supportsAllDrives=true`);
  return new Response(res.body, { headers: { 'Content-Type': 'application/pdf', 'Content-Disposition': disposition('inline', `${row.title}.pdf`), 'Cache-Control': 'private, max-age=300', 'X-Content-Type-Options': 'nosniff' } });
}

export async function handleLessonPlansRoute(request, env, pathname, method, drive) {
  if (!pathname.startsWith('/api/lesson-plans/')) return null;
  const user = await getCurrentUser(request, env);
  if (!user) return jsonResponse({ error: 'กรุณาเข้าสู่ระบบ' }, 401);
  const allowed = await canViewLessonPlans(env, user);
  const sub = pathname.slice('/api/lesson-plans/'.length);
  if (sub === 'permissions' && method === 'GET') return jsonResponse({ view: allowed });
  if (method !== 'GET') return jsonResponse({ error: 'ดูได้อย่างเดียว แก้ไขหรือลบไม่ได้' }, 405);
  if (!allowed) return jsonResponse({ error: 'เฉพาะผู้บริหาร หัวหน้าฝ่ายวิชาการ และผู้ดูแลระบบ' }, 403);
  const url = new URL(request.url);
  if (sub === 'progress') return progress(env, url);
  const m = /^(files|preview)\/(\d+)$/.exec(sub);
  if (m) {
    const row = await planRow(env, Number(m[2]));
    if (!row) return jsonResponse({ error: 'ไม่พบไฟล์' }, 404);
    const driveError = drive.ready(env);
    if (driveError) return jsonResponse({ error: driveError }, 503);
    try { return m[1] === 'files' ? await serveFile(env, drive, row, url) : await servePreview(env, drive, row, url); }
    catch (e) { return jsonResponse({ error: `เปิดไฟล์จาก Google Drive ไม่สำเร็จ: ${String(e.message).slice(0, 150)}` }, 502); }
  }
  return jsonResponse({ error: 'ไม่พบหน้านี้' }, 404);
}
