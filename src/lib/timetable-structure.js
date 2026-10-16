// โครงเวลาเรียน (ต่อภาคเรียน): เวลาแต่ละคาบ + ตารางแม่แบบ 2 ช่วงชั้น (ป.ต้น ป.1–3 / ป.ปลาย ป.4–6)
// ฝ่ายวัดผลใส่ "คาบกิจกรรมพัฒนาผู้เรียน" ที่ล็อกไว้ในแม่แบบ ช่องที่เว้นว่าง = คาบรายวิชาที่ระบบจัดครูลงให้
import { canManageTimetable } from './timetable-permissions.js';

export const BANDS = { lower: 'ป.ต้น (ป.1–3)', upper: 'ป.ปลาย (ป.4–6)' };
const ACT = (weekday, period, name) => ({ weekday, period, name });
const DEFAULT_ACTIVITIES = [ACT(2, 6, 'โครงงานคุณธรรม'), ACT(3, 6, 'ลดเวลาเรียน เพิ่มเวลารู้'), ACT(4, 6, 'ลูกเสือ/เนตรนารี'), ACT(5, 6, 'แนะแนว')];
export const DEFAULT_STRUCTURE = {
  times: [['08:30', '09:30'], ['09:30', '10:30'], ['10:30', '11:30'], ['12:30', '13:30'], ['13:30', '14:30'], ['14:30', '15:30']].map(([start, end]) => ({ start, end })),
  lunch: { start: '11:30', end: '12:30' },
  bands: { lower: DEFAULT_ACTIVITIES, upper: DEFAULT_ACTIVITIES },
};

// ป.1–3 = lower, ป.4–6 = upper, อื่น ๆ (อนุบาล) = ไม่มีแม่แบบ
export function bandOf(grade) {
  const m = String(grade || '').normalize('NFC').replace(/\s+/g, '').match(/^(?:ป\.?|ประถมศึกษาปีที่)([1-6])$/);
  return m ? (Number(m[1]) <= 3 ? 'lower' : 'upper') : null;
}

const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
// คืน { structure } หรือ { error }
export function validateStructure(raw) {
  if (!raw || typeof raw !== 'object') return { error: 'ข้อมูลโครงเวลาเรียนไม่ถูกต้อง' };
  const times = raw.times;
  if (!Array.isArray(times) || times.length !== 6) return { error: 'ต้องกำหนดเวลาให้ครบ 6 คาบ' };
  for (const [i, t] of times.entries()) {
    if (!TIME.test(t?.start || '') || !TIME.test(t?.end || '') || t.end <= t.start) return { error: `เวลาคาบ ${i + 1} ไม่ถูกต้อง` };
    if (i && t.start < times[i - 1].end) return { error: `คาบ ${i + 1} เริ่มก่อนคาบ ${i} จบ` };
  }
  const lunch = raw.lunch;
  if (!TIME.test(lunch?.start || '') || !TIME.test(lunch?.end || '') || lunch.end <= lunch.start || lunch.start < times[2].end || lunch.end > times[3].start)
    return { error: 'เวลาพักกลางวันต้องอยู่ระหว่างคาบ 3 กับคาบ 4' };
  const bands = {};
  for (const band of Object.keys(BANDS)) {
    const list = raw.bands?.[band] ?? [];
    if (!Array.isArray(list) || list.length > 30) return { error: `คาบกิจกรรมของ ${BANDS[band]} ไม่ถูกต้อง` };
    const seen = new Set(), out = [];
    for (const a of list) {
      const name = String(a?.name ?? '').normalize('NFC').replace(/\s+/g, ' ').trim();
      if (!Number.isInteger(a?.weekday) || a.weekday < 1 || a.weekday > 5 || !Number.isInteger(a?.period) || a.period < 1 || a.period > 6 || !name || name.length > 60)
        return { error: `คาบกิจกรรมของ ${BANDS[band]} ไม่ถูกต้อง` };
      const k = `${a.weekday}-${a.period}`; if (seen.has(k)) continue; seen.add(k);
      out.push({ weekday: a.weekday, period: a.period, name });
    }
    out.sort((x, y) => x.weekday - y.weekday || x.period - y.period);
    bands[band] = out;
  }
  return { structure: { times: times.map((t) => ({ start: t.start, end: t.end })), lunch: { start: lunch.start, end: lunch.end }, bands } };
}

export async function ensureStructureSchema(env) {
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS timetable_structure(academic_term_id INTEGER PRIMARY KEY REFERENCES academic_terms(id),
    config_json TEXT NOT NULL, updated_by INTEGER REFERENCES users(id), updated_at TEXT NOT NULL DEFAULT(datetime('now')))`).run();
}

export async function loadStructure(env, termId) {
  await ensureStructureSchema(env);
  const row = await env.DB.prepare('SELECT config_json, updated_at, updated_by FROM timetable_structure WHERE academic_term_id = ?').bind(termId).first();
  if (!row) return { structure: DEFAULT_STRUCTURE, saved: false };
  const by = row.updated_by ? await env.DB.prepare('SELECT full_name FROM users WHERE id = ?').bind(row.updated_by).first().catch(() => null) : null;
  try { return { structure: JSON.parse(row.config_json), saved: true, updated_at: row.updated_at, updated_by_name: by?.full_name || null }; }
  catch { return { structure: DEFAULT_STRUCTURE, saved: false }; }
}

// ช่องกิจกรรมของห้องที่เลือก (ใช้ปิดช่องไม่ให้ลงรายวิชา)
export function classActivityCells(structure, classes) {
  const out = [];
  for (const c of classes || []) {
    const band = bandOf(c.grade_level); if (!band) continue;
    for (const a of structure?.bands?.[band] || []) out.push({ grade_level: c.grade_level, classroom: c.classroom, weekday: a.weekday, period: a.period, name: a.name });
  }
  return out;
}

// แก้โครงเวลาเรียน: ฝ่ายวัดผล (ทีมวัดผลในระบบรายงานผลการเรียน) ผู้จัดตารางฝ่ายวิชาการ และผู้ดูแลระบบ — ผู้บริหารดูได้อย่างเดียว
export async function canEditStructure(env, user) {
  if (!user) return false;
  if (user.role === 'superadmin') return true;
  if (user.role === 'executive') return false;
  const t = await env.DB.prepare("SELECT 1 AS ok FROM sqlite_master WHERE type='table' AND name='gr_staff_roles'").first();
  if (t && await env.DB.prepare("SELECT 1 AS ok FROM gr_staff_roles WHERE user_id = ? AND role = 'grade_admin'").bind(user.id).first()) return true;
  return canManageTimetable(env, user);
}
