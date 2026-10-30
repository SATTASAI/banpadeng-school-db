// สถิติฝ่ายบุคคล: วันลาของครู และจำนวนครั้งที่ถูกจัดสอนแทน
// ทุกหน้าที่แสดงตัวเลขเหล่านี้ (หน้าสถิติ, หน้าจัดสอนแทน, แดชบอร์ด) อ่านจากฟังก์ชันในไฟล์นี้ชุดเดียวกัน
// จึงไม่มียอดสะสมแยกที่อาจไม่ตรงกัน — ข้อมูลต้นทางคือ leave_requests และ substitute_assignments เท่านั้น
import { isPersonnelHead } from './leave-permissions.js';
import { canManageSubstitutes } from './substitute-permissions.js';

export const LEAVE_TYPES = { sick: 'ลาป่วย', personal: 'ลากิจ', maternity: 'ลาคลอด', lenient: 'ลาอนุโลม', other: 'ลาอื่น ๆ' };
const DATE = /^\d{4}-\d{2}-\d{2}$/;

export function bangkokToday() { return new Date(Date.now() + 7 * 3600e3).toISOString().slice(0, 10); }
const addDays = (date, n) => { const d = new Date(`${date}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
export function currentFiscalYear(date = bangkokToday()) { const [y, m] = date.split('-').map(Number); return y + (m >= 10 ? 544 : 543); }

// สัปดาห์ จันทร์–อาทิตย์ และเดือนตามปฏิทิน ของวันที่ที่กำหนด (เวลาไทย)
export function weekRange(date = bangkokToday()) {
  const day = new Date(`${date}T00:00:00Z`).getUTCDay() || 7;
  const start = addDays(date, 1 - day);
  return { start, end: addDays(start, 6) };
}
export function monthRange(date = bangkokToday()) {
  const [y, m] = date.split('-').map(Number);
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return { start: `${date.slice(0, 7)}-01`, end: `${date.slice(0, 7)}-${String(last).padStart(2, '0')}` };
}

// ปีงบประมาณ (พ.ศ.) แบ่งครึ่งปีแบบราชการ: ครึ่งแรก 1 ต.ค.–31 มี.ค. ครึ่งหลัง 1 เม.ย.–30 ก.ย.
export function leavePeriod(fiscalYear, period = 'year') {
  const fy = Number(fiscalYear) || currentFiscalYear();
  if (!Number.isInteger(fy) || fy < 2500 || fy > 3000) return null;
  const ce = fy - 543;
  if (period === 'h1') return { fiscal_year: fy, period, start: `${ce - 1}-10-01`, end: `${ce}-03-31` };
  if (period === 'h2') return { fiscal_year: fy, period, start: `${ce}-04-01`, end: `${ce}-09-30` };
  if (/^\d{4}-\d{2}$/.test(String(period))) {
    const r = monthRange(`${period}-01`);
    if (r.start < `${ce - 1}-10-01` || r.end > `${ce}-09-30`) return null;
    return { fiscal_year: fy, period, ...r };
  }
  return { fiscal_year: fy, period: 'year', start: `${ce - 1}-10-01`, end: `${ce}-09-30` };
}

// ผู้ดูสถิติของทุกคน: ผู้ดูแลระบบ ผู้บริหาร หัวหน้า/เจ้าหน้าที่ฝ่ายบุคลากร — ครูทั่วไปเห็นเฉพาะของตนเอง
// สถิติวันลารายบุคคลของทุกคน: เฉพาะหัวหน้าฝ่ายบุคคล ผอ./รอง ผอ. (บัญชีผู้บริหาร) และ superadmin — คนอื่นเห็นเฉพาะของตนเอง
export async function canViewAllLeaveStats(env, user) {
  if (!user?.role) return false;
  if (['superadmin', 'executive'].includes(user.role)) return true;
  return isPersonnelHead(env, user).catch(() => false);
}

export async function canViewPersonnelStats(env, user) {
  if (!user?.role) return false;
  if (['superadmin', 'executive'].includes(user.role)) return true;
  if (await isPersonnelHead(env, user).catch(() => false)) return true;
  return canManageSubstitutes(env, user).catch(() => false);
}

async function tableNames(env, names) {
  const { results } = await env.DB.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name IN (${names.map(() => '?').join(',')})`).bind(...names).all();
  return new Set(results.map((r) => r.name));
}

// บุคลากรที่ใช้งานอยู่ พร้อมบัญชีผู้ใช้ที่ผูกไว้ (หนึ่งคนมีได้หลายบัญชี)
async function activePeople(env) {
  const [{ results: people }, { results: links }] = await Promise.all([
    env.DB.prepare(`SELECT id,full_name,position,personnel_type FROM personnel_records WHERE status='active' ORDER BY full_name`).all(),
    env.DB.prepare(`SELECT a.personnel_id,a.user_id FROM personnel_accounts a JOIN personnel_records p ON p.id=a.personnel_id AND p.status='active'`).all(),
  ]);
  const personByUser = new Map(links.map((l) => [Number(l.user_id), Number(l.personnel_id)]));
  return { people, personByUser };
}

export async function leaveStatistics(env, { fiscalYear, period, onlyUserId = null } = {}) {
  const range = leavePeriod(fiscalYear, period);
  if (!range) return { error: 'ช่วงเวลาไม่ถูกต้อง' };
  const { people, personByUser } = await activePeople(env);
  // ครูทั่วไปดูของตนเอง: รวมทุกบัญชีที่ผูกกับบุคลากรคนเดียวกัน
  const ownPerson = onlyUserId ? personByUser.get(Number(onlyUserId)) : null;
  const userFilter = onlyUserId ? JSON.stringify(ownPerson ? [...personByUser].filter(([, pid]) => pid === ownPerson).map(([uid]) => uid) : [Number(onlyUserId)]) : null;
  // วันลาที่อนุมัติ นับเฉพาะส่วนที่อยู่ในช่วงเวลา ตามสัดส่วนจำนวนวันลาที่ยื่น (สูตรเดียวกับแดชบอร์ด)
  const { results } = await env.DB.prepare(`SELECT r.user_id,u.full_name,COALESCE(r.leave_subtype,r.leave_type) leave_type,r.status,
      COUNT(*) request_count,
      COALESCE(SUM(CASE WHEN r.status='approved' THEN MAX(0,julianday(MIN(r.end_date,?))-julianday(MAX(r.start_date,?))+1)
        *COALESCE(r.leave_days,julianday(r.end_date)-julianday(r.start_date)+1)/(julianday(r.end_date)-julianday(r.start_date)+1) ELSE 0 END),0) days
    FROM leave_requests r JOIN users u ON u.id=r.user_id
    WHERE r.end_date>=? AND r.start_date<=? AND (? IS NULL OR r.user_id IN (SELECT value FROM json_each(?)))
    GROUP BY r.user_id,COALESCE(r.leave_subtype,r.leave_type),r.status`)
    .bind(range.end, range.start, range.start, range.end, userFilter, userFilter).all();
  const blank = (key, name, position) => ({ key, name, position: position || '', pending: 0, rejected: 0, approved_times: 0, approved_days: 0,
    sick_personal_times: 0, sick_personal_days: 0,
    by_type: Object.fromEntries(Object.keys(LEAVE_TYPES).map((t) => [t, { times: 0, days: 0 }])) });
  const rows = new Map();
  if (!onlyUserId) for (const p of people) rows.set(`p${p.id}`, blank(`p${p.id}`, p.full_name, p.position));
  if (onlyUserId) {
    const p = people.find((x) => x.id === ownPerson);
    const key = p ? `p${p.id}` : `u${onlyUserId}`;
    rows.set(key, blank(key, p?.full_name || results[0]?.full_name || '', p?.position));
  }
  for (const r of results) {
    const pid = personByUser.get(Number(r.user_id)), key = pid ? `p${pid}` : `u${r.user_id}`;
    if (!rows.has(key)) rows.set(key, blank(key, r.full_name, ''));
    const row = rows.get(key), type = LEAVE_TYPES[r.leave_type] ? r.leave_type : 'other', n = Number(r.request_count), days = Math.round(Number(r.days) * 100) / 100;
    if (r.status === 'pending') row.pending += n;
    else if (r.status === 'rejected') row.rejected += n;
    else if (r.status === 'approved') {
      row.approved_times += n; row.approved_days += days;
      row.by_type[type].times += n; row.by_type[type].days += days;
      if (type === 'sick' || type === 'personal') { row.sick_personal_times += n; row.sick_personal_days += days; }
    }
  }
  const list = [...rows.values()].map((r) => ({ ...r, approved_days: Math.round(r.approved_days * 100) / 100, sick_personal_days: Math.round(r.sick_personal_days * 100) / 100 }))
    .sort((a, b) => b.approved_days - a.approved_days || b.approved_times - a.approved_times || a.name.localeCompare(b.name, 'th'));
  const total = (k) => list.reduce((s, r) => s + r[k], 0);
  const byType = Object.entries(LEAVE_TYPES).map(([key, label]) => ({ key, label,
    times: list.reduce((s, r) => s + r.by_type[key].times, 0), days: Math.round(list.reduce((s, r) => s + r.by_type[key].days, 0) * 100) / 100 }));
  // รายเดือนในช่วงเวลา (นับตามวันที่เริ่มลา) สำหรับกราฟแนวโน้ม
  const { results: monthly } = await env.DB.prepare(`SELECT substr(start_date,1,7) month,COUNT(*) times
    FROM leave_requests WHERE status='approved' AND start_date BETWEEN ? AND ? AND (? IS NULL OR user_id IN (SELECT value FROM json_each(?))) GROUP BY substr(start_date,1,7) ORDER BY month`)
    .bind(range.start, range.end, userFilter, userFilter).all();
  return { ...range, types: LEAVE_TYPES, people: list, by_type: byType, monthly,
    summary: { people: list.length, people_with_leave: list.filter((r) => r.approved_times).length, approved_times: total('approved_times'),
      approved_days: Math.round(total('approved_days') * 100) / 100, pending: total('pending'), rejected: total('rejected') } };
}

// จำนวนครั้ง (คาบ) ที่ครูแต่ละคนถูกจัดสอนแทน — ใช้ร่วมกันโดยหน้าสถิติ หน้าจัดสอนแทน และแดชบอร์ด
export async function substituteLoad(env, { date = bangkokToday(), start = null, end = null, onlyPersonnelId = null } = {}) {
  if (!DATE.test(date) || (start && !DATE.test(start)) || (end && !DATE.test(end))) return { error: 'วันที่ไม่ถูกต้อง' };
  const week = weekRange(date), month = monthRange(date);
  const range = { start: start || month.start, end: end || month.end };
  if (range.start > range.end) return { error: 'ช่วงวันที่ไม่ถูกต้อง' };
  const tables = await tableNames(env, ['substitute_assignments', 'substitute_absences', 'personnel_records']);
  const empty = { date, week, month, range, people: [], summary: { week_total: 0, month_total: 0, range_total: 0, teachers_week: 0, teachers_month: 0 }, daily: [] };
  if (!tables.has('personnel_records')) return empty;
  const { results: people } = await env.DB.prepare(`SELECT id,full_name,position FROM personnel_records WHERE status='active' ORDER BY full_name`).all();
  if (!tables.has('substitute_assignments')) return { ...empty, people: people.map((p) => ({ personnel_id: p.id, name: p.full_name, position: p.position || '', week: 0, month: 0, range: 0, covered_teachers: 0, absences: 0 })) };
  const lo = [week.start, month.start, range.start].sort()[0], hi = [week.end, month.end, range.end].sort().at(-1);
  const { results: rows } = await env.DB.prepare(`SELECT substitute_teacher_id id,absence_date d,COUNT(*) n,COUNT(DISTINCT absence_id) a
    FROM substitute_assignments WHERE absence_date BETWEEN ? AND ? GROUP BY substitute_teacher_id,absence_date`).bind(lo, hi).all();
  const { results: absent } = tables.has('substitute_absences') ? await env.DB.prepare(`SELECT ab.teacher_id id,COUNT(DISTINCT a.id) n
    FROM substitute_absences ab JOIN substitute_assignments a ON a.absence_id=ab.id WHERE ab.absence_date BETWEEN ? AND ? GROUP BY ab.teacher_id`).bind(range.start, range.end).all() : { results: [] };
  const { results: covered } = tables.has('substitute_absences') ? await env.DB.prepare(`SELECT a.substitute_teacher_id id,COUNT(DISTINCT ab.teacher_id) n
    FROM substitute_assignments a JOIN substitute_absences ab ON ab.id=a.absence_id WHERE a.absence_date BETWEEN ? AND ? GROUP BY a.substitute_teacher_id`).bind(range.start, range.end).all() : { results: [] };
  const within = (d, r) => d >= r.start && d <= r.end;
  const map = new Map(people.map((p) => [p.id, { personnel_id: p.id, name: p.full_name, position: p.position || '', week: 0, month: 0, range: 0, covered_teachers: 0, absences: 0 }]));
  const daily = new Map();
  for (const r of rows) {
    const row = map.get(Number(r.id)); if (!row) continue;
    const n = Number(r.n);
    if (within(r.d, week)) row.week += n;
    if (within(r.d, month)) row.month += n;
    if (within(r.d, range)) { row.range += n; daily.set(r.d, (daily.get(r.d) || 0) + n); }
  }
  for (const r of covered) { const row = map.get(Number(r.id)); if (row) row.covered_teachers = Number(r.n); }
  for (const r of absent) { const row = map.get(Number(r.id)); if (row) row.absences = Number(r.n); }
  let list = [...map.values()].sort((a, b) => b.range - a.range || b.month - a.month || a.name.localeCompare(b.name, 'th'));
  if (onlyPersonnelId) list = list.filter((r) => r.personnel_id === Number(onlyPersonnelId));
  const sum = (k) => list.reduce((s, r) => s + r[k], 0);
  return { date, week, month, range, people: list, daily: [...daily.entries()].sort().map(([d, n]) => ({ date: d, count: n })),
    summary: { week_total: sum('week'), month_total: sum('month'), range_total: sum('range'),
      teachers_week: list.filter((r) => r.week).length, teachers_month: list.filter((r) => r.month).length } };
}

// การ์ดสรุปบนแดชบอร์ด: ตัวเลขรวมทุกคน ส่วนรายชื่อครูที่ถูกจัดมากที่สุดเฉพาะผู้มีสิทธิ์ดูสถิติ
export async function substituteDashboardSummary(env, user) {
  const data = await substituteLoad(env);
  if (data.error) return null;
  const allowed = await canViewPersonnelStats(env, user);
  return { week: data.week, month: data.month, ...data.summary, can_view_people: allowed,
    top: allowed ? data.people.filter((r) => r.month).slice(0, 5).map((r) => ({ name: r.name, week: r.week, month: r.month })) : [] };
}
