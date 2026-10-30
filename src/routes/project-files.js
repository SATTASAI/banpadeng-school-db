// เอกสารโครงการ (เมนูโครงการของทุกฝ่าย) — ไฟล์โครงการ / ภาคผนวก / รายการวัสดุอุปกรณ์ / ภาพ + โฟลเดอร์ย่อยที่ผู้ใช้สร้างเอง
// Drive: โครงการ / <ปีงบประมาณ> / <ฝ่าย> / <ชื่อโครงการ> / <หมวด> / <โฟลเดอร์ย่อย…>
//   ค้นหาโฟลเดอร์ชื่อเดิมก่อนสร้างใหม่ทุกชั้น → โครงการที่มีโฟลเดอร์อยู่แล้วใช้โฟลเดอร์เดิม
// ย้อนหลัง 4 ปี: โครงการชื่อเดียวกันในฝ่ายเดียวกัน ปีงบประมาณ (ปีที่เลือก-3 … ปีที่เลือก)
// สิทธิ์: ผู้รับผิดชอบโครงการ + หัวหน้าฝ่ายของโครงการ + admin จัดการไฟล์ได้ · ผู้ใช้อื่นที่เข้าสู่ระบบดูได้อย่างเดียว
import { getCurrentUser, jsonResponse, isAdmin } from '../lib/auth.js';
import { ensureDepartmentStaff } from './department-staff.js';

export const PROJECT_FILE_CATEGORIES = [
  { key: 'project', name: 'ไฟล์โครงการ' },
  { key: 'appendix', name: 'ภาคผนวก' },
  { key: 'materials', name: 'รายการวัสดุอุปกรณ์' },
  { key: 'images', name: 'ภาพ' },
];
const DEPT_LABEL = {
  academic: 'ฝ่ายวิชาการ', early_childhood: 'ฝ่ายปฐมวัย (งานอนุบาล)', budget: 'ฝ่ายงบประมาณ',
  personnel: 'ฝ่ายบุคคล', general: 'ฝ่ายบริหารทั่วไป',
};
const ROOT_NAME = 'โครงการ';
const HISTORY_YEARS = 4;

const MIME = {
  pdf: 'application/pdf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif',
};
const LIMIT = { doc: 25 * 1024 * 1024, image: 10 * 1024 * 1024 };

const ready = new WeakMap();
export function ensureProjectFilesSchema(env) {
  if (ready.has(env.DB)) return ready.get(env.DB);
  const p = env.DB.batch([
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS project_file_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT, project_id INTEGER NOT NULL, parent_id INTEGER,
      kind TEXT NOT NULL CHECK (kind IN ('folder','file')), category TEXT, name TEXT NOT NULL,
      drive_id TEXT, mime_type TEXT, file_size INTEGER, created_by INTEGER,
      created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')), deleted_at TEXT)`),
    env.DB.prepare('CREATE INDEX IF NOT EXISTS idx_project_file_items_project ON project_file_items(project_id, parent_id, deleted_at)'),
    env.DB.prepare('CREATE TABLE IF NOT EXISTS project_drive_folders (key TEXT PRIMARY KEY, folder_id TEXT NOT NULL)'),
  ]).catch((e) => { ready.delete(env.DB); throw e; });
  ready.set(env.DB, p);
  return p;
}

// ---------- helpers ----------
const safeName = (s) => String(s || '').replace(/[\\/:*?"<>|\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 150);
const normName = (s) => String(s || '').replace(/\s+/g, ' ').trim().toLowerCase();
const dq = (v) => String(v).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
const extOf = (name) => (String(name || '').toLowerCase().match(/\.([a-z0-9]+)$/) || [])[1] || '';
const effDept = (p) => p.management_area || p.department;

async function loadProject(env, id) {
  return env.DB.prepare('SELECT id,department,management_area,name,fiscal_year FROM projects WHERE id=?').bind(id).first();
}

async function canManage(env, user, project) {
  if (!user?.role || user.role === 'viewer') return false;
  if (isAdmin(user)) return true;
  const owner = await env.DB.prepare('SELECT 1 FROM project_owners WHERE project_id=? AND user_id=?').bind(project.id, user.id).first();
  if (owner) return true;
  await ensureDepartmentStaff(env);
  const head = await env.DB.prepare(`SELECT 1 FROM department_staff d JOIN personnel_accounts a ON a.personnel_id=d.personnel_id
    WHERE a.user_id=? AND d.department=? AND d.is_head=1`).bind(user.id, effDept(project)).first().catch(() => null);
  return !!head;
}

async function checkFile(file) {
  if (!file || typeof file === 'string' || typeof file.arrayBuffer !== 'function') return { error: 'กรุณาเลือกไฟล์' };
  if (!file.size) return { error: 'ไฟล์ว่างหรือไม่สมบูรณ์' };
  const ext = extOf(file.name);
  const mimeType = MIME[ext];
  if (!mimeType) return { error: 'รองรับเฉพาะไฟล์ PDF, DOCX, XLSX และรูปภาพ JPG/PNG/WEBP/GIF' };
  const image = mimeType.startsWith('image/');
  if (file.size > (image ? LIMIT.image : LIMIT.doc)) return { error: image ? 'รูปภาพต้องไม่เกิน 10 MB' : 'ไฟล์เอกสารต้องไม่เกิน 25 MB' };
  const b = new Uint8Array(await file.slice(0, 12).arrayBuffer());
  const a = String.fromCharCode(...b);
  const ok = ext === 'pdf' ? a.startsWith('%PDF-')
    : ext === 'docx' || ext === 'xlsx' ? b[0] === 0x50 && b[1] === 0x4b
    : mimeType === 'image/jpeg' ? b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff
    : mimeType === 'image/png' ? b[0] === 0x89 && a.slice(1, 4) === 'PNG'
    : mimeType === 'image/webp' ? a.startsWith('RIFF') && a.slice(8, 12) === 'WEBP'
    : a.startsWith('GIF8');
  if (!ok) return { error: 'ชนิดไฟล์ไม่ตรงกับเนื้อหาไฟล์ กรุณาเลือกไฟล์ต้นฉบับ' };
  return { mimeType, image };
}

// ---------- Google Drive ----------
async function findOrCreateFolder(env, drive, token, parentId, name) {
  const key = `${parentId}/${name}`;
  const saved = await env.DB.prepare('SELECT folder_id FROM project_drive_folders WHERE key=?').bind(key).first();
  if (saved) return saved.folder_id;
  const query = encodeURIComponent(`'${dq(parentId)}' in parents and name = '${dq(name)}' and mimeType = 'application/vnd.google-apps.folder' and trashed = false`);
  const found = await (await drive.request(token, `/files?q=${query}&pageSize=1&fields=files(id)&supportsAllDrives=true&includeItemsFromAllDrives=true`)).json();
  let id = found.files?.[0]?.id;
  if (!id) {
    id = (await (await drive.request(token, '/files?fields=id&supportsAllDrives=true', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, mimeType: 'application/vnd.google-apps.folder', parents: [parentId] }),
    })).json()).id;
  }
  await env.DB.prepare('INSERT OR REPLACE INTO project_drive_folders (key, folder_id) VALUES (?, ?)').bind(key, id).run();
  return id;
}

async function projectFolder(env, drive, token, project) {
  let id = String(env.PROJECT_FILES_FOLDER_ID || env.GOOGLE_DRIVE_FOLDER_ID);
  const names = [ROOT_NAME, String(project.fiscal_year || 'ไม่ระบุปีงบประมาณ'), DEPT_LABEL[effDept(project)] || 'ไม่ระบุฝ่าย', safeName(project.name) || `โครงการ ${project.id}`];
  for (const n of names) id = await findOrCreateFolder(env, drive, token, id, n);
  return id;
}

// โฟลเดอร์ Drive ของ item (โฟลเดอร์) — สร้างตามลำดับชั้นเมื่อยังไม่มี drive_id
async function folderDriveId(env, drive, token, project, folderId) {
  if (!folderId) return projectFolder(env, drive, token, project);
  const row = await env.DB.prepare("SELECT * FROM project_file_items WHERE id=? AND project_id=? AND kind='folder' AND deleted_at IS NULL").bind(folderId, project.id).first();
  if (!row) throw Object.assign(new Error('ไม่พบโฟลเดอร์'), { status: 404 });
  if (row.drive_id) return row.drive_id;
  const parent = await folderDriveId(env, drive, token, project, row.parent_id);
  const id = await findOrCreateFolder(env, drive, token, parent, safeName(row.name));
  await env.DB.prepare('UPDATE project_file_items SET drive_id=? WHERE id=?').bind(id, row.id).run();
  return id;
}

async function uploadDrive(drive, token, folderId, name, mimeType, bytes) {
  const boundary = `pf_${crypto.randomUUID()}`;
  const body = new Blob([
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify({ name, mimeType, parents: [folderId] })}\r\n`,
    `--${boundary}\r\nContent-Type: ${mimeType}\r\n\r\n`, bytes, `\r\n--${boundary}--`,
  ]);
  return (await drive.request(token, '/upload/drive/v3/files?uploadType=multipart&supportsAllDrives=true&fields=id,name,size', {
    method: 'POST', headers: { 'Content-Type': `multipart/related; boundary=${boundary}` }, body,
  })).json();
}
const patchDrive = (drive, token, id, query, meta) => drive.request(token, `/files/${encodeURIComponent(id)}?supportsAllDrives=true${query || ''}`, {
  method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(meta || {}),
});

// ---------- โครงสร้างหมวด (สร้างอัตโนมัติ) ----------
async function ensureCategories(env, projectId) {
  const { results } = await env.DB.prepare("SELECT category FROM project_file_items WHERE project_id=? AND parent_id IS NULL AND category IS NOT NULL AND kind='folder' AND deleted_at IS NULL").bind(projectId).all();
  const have = new Set(results.map((r) => r.category));
  const missing = PROJECT_FILE_CATEGORIES.filter((c) => !have.has(c.key));
  if (missing.length) await env.DB.batch(missing.map((c) => env.DB.prepare("INSERT INTO project_file_items (project_id,parent_id,kind,category,name) VALUES (?,NULL,'folder',?,?)").bind(projectId, c.key, c.name)));
}

async function yearsOf(env, project) {
  const fy = Number(project.fiscal_year) || 0;
  const { results } = await env.DB.prepare(`SELECT id,name,fiscal_year FROM projects WHERE COALESCE(management_area,department)=? AND fiscal_year BETWEEN ? AND ?
    ORDER BY fiscal_year DESC, id DESC`).bind(effDept(project), fy - (HISTORY_YEARS - 1), fy).all();
  const target = normName(project.name);
  const byYear = new Map();
  for (const r of results) if (normName(r.name) === target && !byYear.has(r.fiscal_year)) byYear.set(r.fiscal_year, r.id);
  if (!byYear.has(project.fiscal_year)) byYear.set(project.fiscal_year, project.id);
  byYear.set(project.fiscal_year, project.id);
  return [...byYear].map(([fiscal_year, project_id]) => ({ fiscal_year, project_id })).sort((a, b) => (b.fiscal_year || 0) - (a.fiscal_year || 0));
}

const itemOut = (r) => ({ id: r.id, parent_id: r.parent_id, kind: r.kind, category: r.category, name: r.name, mime_type: r.mime_type,
  file_size: r.file_size, created_at: r.created_at, updated_at: r.updated_at, created_by_name: r.created_by_name || null, system: !!r.category });

async function listItems(env, projectId) {
  const { results } = await env.DB.prepare(`SELECT i.*, u.full_name AS created_by_name FROM project_file_items i LEFT JOIN users u ON u.id=i.created_by
    WHERE i.project_id=? AND i.deleted_at IS NULL ORDER BY i.kind DESC, CASE i.category WHEN 'project' THEN 1 WHEN 'appendix' THEN 2 WHEN 'materials' THEN 3 WHEN 'images' THEN 4 ELSE 9 END, i.name`).bind(projectId).all();
  return results.map(itemOut);
}

async function getItem(env, id) {
  return env.DB.prepare('SELECT * FROM project_file_items WHERE id=? AND deleted_at IS NULL').bind(id).first();
}

// โฟลเดอร์ปลายทางต้องอยู่ในโครงการเดียวกัน และห้ามย้ายโฟลเดอร์เข้าไปในตัวเอง/ลูกของตัวเอง
async function validParent(env, projectId, parentId, movingId) {
  if (parentId == null) return true;
  let cur = parentId;
  for (let i = 0; i < 50 && cur != null; i++) {
    if (movingId && cur === movingId) return false;
    const row = await env.DB.prepare("SELECT parent_id,project_id,kind FROM project_file_items WHERE id=? AND deleted_at IS NULL").bind(cur).first();
    if (!row || row.project_id !== projectId || row.kind !== 'folder') return false;
    cur = row.parent_id;
  }
  return true;
}

const err = (message, status = 400) => jsonResponse({ error: message }, status);
const intOrNull = (v) => (v === null || v === undefined || v === '' || v === 'null') ? null : Number(v);

// ---------- routes ----------
export async function handleProjectFilesRoute(request, env, pathname, method, drive) {
  const list = pathname.match(/^\/api\/projects\/(\d+)\/files$/);
  const folders = pathname.match(/^\/api\/projects\/(\d+)\/folders$/);
  const item = pathname.match(/^\/api\/project-files\/(\d+)$/);
  const content = pathname.match(/^\/api\/project-files\/(\d+)\/content$/);
  const replace = pathname.match(/^\/api\/project-files\/(\d+)\/replace$/);
  if (!list && !folders && !item && !content && !replace) return null;

  const user = await getCurrentUser(request, env);
  if (!user || !user.role) return err('กรุณาเข้าสู่ระบบ', 401);
  await ensureProjectFilesSchema(env);

  try {
    if (list && method === 'GET') {
      const project = await loadProject(env, Number(list[1]));
      if (!project) return err('ไม่พบโครงการ', 404);
      await ensureCategories(env, project.id);
      return jsonResponse({
        project: { id: project.id, name: project.name, fiscal_year: project.fiscal_year, department: effDept(project) },
        can_manage: await canManage(env, user, project),
        years: await yearsOf(env, project),
        categories: PROJECT_FILE_CATEGORIES,
        items: await listItems(env, project.id),
        drive_ready: !drive.ready(env),
      });
    }

    if (list && method === 'POST') {
      const project = await loadProject(env, Number(list[1]));
      if (!project) return err('ไม่พบโครงการ', 404);
      if (!(await canManage(env, user, project))) return err('เฉพาะผู้รับผิดชอบโครงการ หัวหน้าฝ่าย หรือผู้ดูแลระบบเท่านั้นที่อัปโหลดได้', 403);
      const driveError = drive.ready(env);
      if (driveError) return err(driveError, 503);
      const form = await request.formData().catch(() => null);
      const file = form?.get('file');
      const parentId = intOrNull(form?.get('parent_id'));
      const checked = await checkFile(file);
      if (checked.error) return err(checked.error);
      if (!(await validParent(env, project.id, parentId))) return err('โฟลเดอร์ปลายทางไม่ถูกต้อง');
      const token = await drive.token(env);
      const folder = await folderDriveId(env, drive, token, project, parentId);
      const name = safeName(file.name) || `ไฟล์.${extOf(file.name)}`;
      const up = await uploadDrive(drive, token, folder, name, checked.mimeType, new Uint8Array(await file.arrayBuffer()));
      const r = await env.DB.prepare("INSERT INTO project_file_items (project_id,parent_id,kind,name,drive_id,mime_type,file_size,created_by) VALUES (?,?,'file',?,?,?,?,?)")
        .bind(project.id, parentId, name, up.id, checked.mimeType, file.size, user.id).run();
      return jsonResponse({ ok: true, id: r.meta.last_row_id }, 201);
    }

    if (folders && method === 'POST') {
      const project = await loadProject(env, Number(folders[1]));
      if (!project) return err('ไม่พบโครงการ', 404);
      if (!(await canManage(env, user, project))) return err('ไม่มีสิทธิ์สร้างโฟลเดอร์ในโครงการนี้', 403);
      const body = await request.json().catch(() => ({}));
      const name = safeName(body.name);
      const parentId = intOrNull(body.parent_id);
      if (!name) return err('กรุณาตั้งชื่อโฟลเดอร์');
      if (!(await validParent(env, project.id, parentId))) return err('โฟลเดอร์ปลายทางไม่ถูกต้อง');
      const dup = await env.DB.prepare(`SELECT 1 FROM project_file_items WHERE project_id=? AND kind='folder' AND deleted_at IS NULL AND name=? AND ${parentId == null ? 'parent_id IS NULL' : 'parent_id=?'}`)
        .bind(...[project.id, name, ...(parentId == null ? [] : [parentId])]).first();
      if (dup) return err('มีโฟลเดอร์ชื่อนี้อยู่แล้ว', 409);
      // สร้างโฟลเดอร์ใน Drive ภายหลัง เมื่อมีไฟล์แรก (ไม่ต้องรอ Drive ตอนสร้าง)
      const r = await env.DB.prepare("INSERT INTO project_file_items (project_id,parent_id,kind,name,created_by) VALUES (?,?,'folder',?,?)").bind(project.id, parentId, name, user.id).run();
      return jsonResponse({ ok: true, id: r.meta.last_row_id }, 201);
    }

    const id = Number((item || content || replace)[1]);
    const row = await getItem(env, id);
    if (!row) return err('ไม่พบไฟล์', 404);
    const project = await loadProject(env, row.project_id);
    if (!project) return err('ไม่พบโครงการ', 404);

    if (content && method === 'GET') {
      if (row.kind !== 'file' || !row.drive_id) return err('ไม่พบไฟล์', 404);
      const driveError = drive.ready(env);
      if (driveError) return err(driveError, 503);
      const token = await drive.token(env);
      const res = await drive.request(token, `/files/${encodeURIComponent(row.drive_id)}?alt=media&supportsAllDrives=true`);
      const download = new URL(request.url).searchParams.get('download') === '1';
      return new Response(res.body, { headers: {
        'Content-Type': row.mime_type || 'application/octet-stream',
        'Content-Disposition': `${download ? 'attachment' : 'inline'}; filename*=UTF-8''${encodeURIComponent(row.name)}`,
        'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff',
      } });
    }

    if (!(await canManage(env, user, project))) return err('ไม่มีสิทธิ์แก้ไขไฟล์ในโครงการนี้', 403);

    if (item && method === 'PATCH') {
      if (row.category) return err('โฟลเดอร์หลักของระบบเปลี่ยนชื่อหรือย้ายไม่ได้');
      const body = await request.json().catch(() => ({}));
      let name = row.name;
      if (body.name !== undefined) {
        name = safeName(body.name);
        if (!name) return err('กรุณาตั้งชื่อ');
        if (row.kind === 'file') { const ext = extOf(row.name); if (ext && extOf(name) !== ext) name = `${name}.${ext}`; }
      }
      const moving = body.parent_id !== undefined;
      const parentId = moving ? intOrNull(body.parent_id) : row.parent_id;
      if (moving && !(await validParent(env, project.id, parentId, row.kind === 'folder' ? row.id : null))) return err('ย้ายไปโฟลเดอร์นี้ไม่ได้');
      if (row.drive_id && !drive.ready(env)) {
        const token = await drive.token(env);
        if (moving && parentId !== row.parent_id) {
          const from = await folderDriveId(env, drive, token, project, row.parent_id);
          const to = await folderDriveId(env, drive, token, project, parentId);
          await patchDrive(drive, token, row.drive_id, `&addParents=${encodeURIComponent(to)}&removeParents=${encodeURIComponent(from)}`, name !== row.name ? { name } : {});
        } else if (name !== row.name) await patchDrive(drive, token, row.drive_id, '', { name });
        if (row.kind === 'folder' && name !== row.name) await env.DB.prepare('DELETE FROM project_drive_folders WHERE folder_id=?').bind(row.drive_id).run();
      }
      await env.DB.prepare("UPDATE project_file_items SET name=?, parent_id=?, updated_at=datetime('now') WHERE id=?").bind(name, parentId, row.id).run();
      return jsonResponse({ ok: true });
    }

    if (replace && method === 'POST') {
      if (row.kind !== 'file') return err('แทนที่ได้เฉพาะไฟล์');
      const driveError = drive.ready(env);
      if (driveError) return err(driveError, 503);
      const form = await request.formData().catch(() => null);
      const file = form?.get('file');
      const checked = await checkFile(file);
      if (checked.error) return err(checked.error);
      const token = await drive.token(env);
      const folder = await folderDriveId(env, drive, token, project, row.parent_id);
      const name = safeName(file.name) || row.name;
      const up = await uploadDrive(drive, token, folder, name, checked.mimeType, new Uint8Array(await file.arrayBuffer()));
      if (row.drive_id) await patchDrive(drive, token, row.drive_id, '', { trashed: true }).catch(() => {});
      await env.DB.prepare("UPDATE project_file_items SET name=?, drive_id=?, mime_type=?, file_size=?, created_by=?, updated_at=datetime('now') WHERE id=?")
        .bind(name, up.id, checked.mimeType, file.size, user.id, row.id).run();
      return jsonResponse({ ok: true });
    }

    if (item && method === 'DELETE') {
      if (row.category) return err('โฟลเดอร์หลักของระบบลบไม่ได้');
      if (row.kind === 'folder') {
        const child = await env.DB.prepare('SELECT 1 FROM project_file_items WHERE parent_id=? AND deleted_at IS NULL').bind(row.id).first();
        if (child) return err('ลบได้เฉพาะโฟลเดอร์ว่าง กรุณาย้ายหรือลบไฟล์ข้างในก่อน', 409);
      }
      if (row.drive_id && !drive.ready(env)) {
        const token = await drive.token(env);
        await patchDrive(drive, token, row.drive_id, '', { trashed: true }).catch(() => {});
        if (row.kind === 'folder') await env.DB.prepare('DELETE FROM project_drive_folders WHERE folder_id=?').bind(row.drive_id).run();
      }
      await env.DB.prepare("UPDATE project_file_items SET deleted_at=datetime('now') WHERE id=?").bind(row.id).run();
      return jsonResponse({ ok: true });
    }
    return err('ไม่รองรับคำขอนี้', 405);
  } catch (e) {
    return err(e.message || 'เกิดข้อผิดพลาด', e.status || 500);
  }
}
