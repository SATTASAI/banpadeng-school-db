import { isAdmin } from './auth.js';

// Project catalog access is separate from the right to process an assigned request.
export function projectVisibility(user, alias = 'p') {
  if (isAdmin(user)) return { sql: '1', values: [] };
  return { sql: `EXISTS(SELECT 1 FROM project_owners visibility_owner WHERE visibility_owner.project_id=${alias}.id AND visibility_owner.user_id=?)`, values: [Number(user?.id) || 0] };
}
export async function canViewProject(env, user, id) {
  if (isAdmin(user)) return true;
  return Boolean(await env.DB.prepare('SELECT 1 FROM project_owners WHERE project_id=? AND user_id=?').bind(id, user.id).first());
}
export async function visibleFinancialRows(env, user, rows) {
  if (isAdmin(user)) return rows;
  const { results } = await env.DB.prepare('SELECT project_id FROM project_owners WHERE user_id=?').bind(user.id).all();
  const owned = new Set(results.map(r => Number(r.project_id)));
  return rows.filter(r => owned.has(Number(r.id)));
}
export async function validateProjectOwners(env, input) {
  if (!Array.isArray(input) || input.length > 100) throw new Error('รายชื่อผู้รับผิดชอบไม่ถูกต้อง');
  const ids = [...new Set(input.map(Number))];
  if (ids.some(id => !Number.isSafeInteger(id) || id <= 0)) throw new Error('บัญชีผู้รับผิดชอบไม่ถูกต้อง');
  if (ids.length) {
    const { results } = await env.DB.prepare(`SELECT id FROM users WHERE id IN (${ids.map(() => '?').join(',')}) AND status='active' AND deleted_at IS NULL AND role IN ('teacher','staff','superadmin','executive')`).bind(...ids).all();
    if (results.length !== ids.length) throw new Error('ผู้รับผิดชอบต้องเป็นบัญชีบุคลากรที่เปิดใช้งานในระบบ');
  }
  return ids;
}

// D1 limits bound parameters; a school-wide, multi-year register can exceed it.
export async function rowsByIds(env, ids, query, leading = []) {
  const rows = [];
  for (let offset = 0; offset < ids.length; offset += 80) {
    const group = ids.slice(offset, offset + 80);
    const result = await env.DB.prepare(query(group.map(() => '?').join(','))).bind(...leading, ...group).all();
    rows.push(...result.results);
  }
  return rows;
}
