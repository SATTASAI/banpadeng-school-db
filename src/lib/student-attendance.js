// สถิติการมาเรียนของนักเรียน — อ่านจากระบบรายงานผลการเรียน (grades / students-report) ซึ่งใช้ฐานข้อมูล D1 เดียวกัน
// ระบบนี้อ่านอย่างเดียว ครูประจำชั้นบันทึกที่ grades (/homeroom.html แท็บ "บันทึกการมาเรียน") ตาราง gr_attendance
// กติกาเดียวกับ grades (src/lib/data.js: schoolCalendar, attendanceRates):
//   - วันเรียน = จันทร์–ศุกร์ในช่วงภาคเรียน (academic_terms) ที่ไม่ใช่วันหยุด (gr_holidays)
//   - เก็บเฉพาะวันที่ไม่ได้มาปกติ: ข ขาดเรียน · ล ลากิจ · ป ลาป่วย · ส มาสาย (มาสายถือว่ามาเรียน)
//   - ร้อยละมาเรียน = (วันเรียนถึงวันนี้ − ข/ล/ป) ÷ วันเรียน · นักเรียนย้ายเข้านับตั้งแต่วันที่ย้ายเข้า
//   - รายชื่อ = การลงทะเบียนภาคเรียนล่าสุดของปี สถานะ enrolled
import { bangkokToday } from './personnel-stats.js';

export const ATTENDANCE_CODES = { 'ข': 'absent', 'ล': 'personal', 'ป': 'sick', 'ส': 'late' };
const ABSENT = ['ข', 'ล', 'ป'];
const GRADE_ORDER = ['อ.1', 'อ.2', 'อ.3', 'ป.1', 'ป.2', 'ป.3', 'ป.4', 'ป.5', 'ป.6'];
const gradeRank = (g) => { const i = GRADE_ORDER.indexOf(g); return i < 0 ? 99 : i; };
const pct = (part, whole) => (whole > 0 ? Math.round((part * 1000) / whole) / 10 : null);
const CHUNK = 90;

async function tables(env) {
  const { results } = await env.DB.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('gr_attendance','gr_holidays','gr_transfers','gr_settings')").all();
  return new Set(results.map((r) => r.name));
}

export function schoolDays(terms, holidays) {
  const off = new Set(holidays), days = [];
  for (const t of terms) {
    if (!/^\d{4}-\d{2}-\d{2}/.test(t.start_date || '') || !/^\d{4}-\d{2}-\d{2}/.test(t.end_date || '')) continue;
    const end = t.end_date.slice(0, 10);
    for (let d = new Date(`${t.start_date.slice(0, 10)}T00:00:00Z`); d.toISOString().slice(0, 10) <= end; d.setUTCDate(d.getUTCDate() + 1)) {
      const iso = d.toISOString().slice(0, 10), wd = d.getUTCDay();
      if (wd !== 0 && wd !== 6 && !off.has(iso)) days.push(iso);
    }
  }
  return [...new Set(days)].sort();
}

function emptyCounts() { return { enrolled: 0, absent: 0, personal: 0, sick: 0, late: 0 }; }
function finish(c) {
  const away = c.absent + c.personal + c.sick;
  return { ...c, away, present: c.enrolled - away, present_pct: pct(c.enrolled - away, c.enrolled) };
}

async function chunked(env, ids, build) {
  const rows = [];
  for (let i = 0; i < ids.length; i += CHUNK) {
    const part = ids.slice(i, i + CHUNK), ph = part.map(() => '?').join(',');
    const { results } = await build(ph, part).all();
    rows.push(...results);
  }
  return rows;
}

export async function attendanceDashboard(env, { today = bangkokToday(), trendDays = 10 } = {}) {
  const year = await env.DB.prepare("SELECT id, year_be, label FROM academic_years WHERE status='active' ORDER BY year_be DESC LIMIT 1").first();
  if (!year) return { available: false, reason: 'no_year' };
  const have = await tables(env);
  if (!have.has('gr_attendance')) return { available: false, reason: 'no_grades', academic_year: { id: year.id, label: year.label } };
  const yearId = Number(year.id);

  const [{ results: terms }, holidayRows, settings] = await Promise.all([
    env.DB.prepare('SELECT term_number, name, start_date, end_date FROM academic_terms WHERE academic_year_id=? ORDER BY term_number').bind(yearId).all(),
    have.has('gr_holidays') ? env.DB.prepare('SELECT holiday_date FROM gr_holidays WHERE academic_year_id=?').bind(yearId).all().then((r) => r.results) : [],
    have.has('gr_settings') ? env.DB.prepare('SELECT attendance_pass_pct FROM gr_settings WHERE academic_year_id=?').bind(yearId).first() : null,
  ]);
  const passPct = Number(settings?.attendance_pass_pct ?? 80);
  const days = schoolDays(terms, holidayRows.map((h) => String(h.holiday_date).slice(0, 10)));
  const elapsed = days.filter((d) => d <= today);
  const inSession = days.includes(today);
  const reportDate = inSession ? today : (elapsed.at(-1) || null);
  const term = terms.find((t) => today >= t.start_date && today <= t.end_date) || null;
  const nextTerm = terms.find((t) => t.start_date > today) || null;
  const trend = elapsed.slice(-trendDays);

  const { results: roster } = await env.DB.prepare(`WITH ranked AS (
      SELECT se.student_id, se.grade_level, se.classroom, se.status,
             ROW_NUMBER() OVER (PARTITION BY se.student_id ORDER BY t.term_number DESC, se.id DESC) AS rn
        FROM student_enrollments se JOIN academic_terms t ON t.id = se.academic_term_id
       WHERE t.academic_year_id = ?)
    SELECT student_id, grade_level, classroom FROM ranked
     WHERE rn = 1 AND status = 'enrolled' AND grade_level IS NOT NULL AND classroom IS NOT NULL`).bind(yearId).all();
  const room = new Map(roster.map((r) => [Number(r.student_id), r]));
  const ids = [...room.keys()];

  const [dayRows, absentRows, lastRows, moves] = ids.length ? await Promise.all([
    trend.length ? chunked(env, ids, (ph, part) => env.DB.prepare(`SELECT student_id, att_date, code FROM gr_attendance
      WHERE academic_year_id=? AND att_date>=? AND att_date<=? AND student_id IN (${ph})`).bind(yearId, trend[0], trend.at(-1), ...part)) : [],
    chunked(env, ids, (ph, part) => env.DB.prepare(`SELECT student_id, att_date FROM gr_attendance
      WHERE academic_year_id=? AND code IN ('ข','ล','ป') AND att_date<=? AND student_id IN (${ph})`).bind(yearId, today, ...part)),
    chunked(env, ids, (ph, part) => env.DB.prepare(`SELECT student_id, MAX(att_date) AS d, MAX(updated_at) AS u FROM gr_attendance
      WHERE academic_year_id=? AND student_id IN (${ph}) GROUP BY student_id`).bind(yearId, ...part)),
    have.has('gr_transfers') ? chunked(env, ids, (ph, part) => env.DB.prepare(`SELECT student_id, MAX(move_date) AS d FROM gr_transfers
      WHERE academic_year_id=? AND direction='in' AND undone_at IS NULL AND move_date IS NOT NULL AND student_id IN (${ph}) GROUP BY student_id`).bind(yearId, ...part)) : [],
  ]) : [[], [], [], []];

  // ระดับชั้น / ห้อง
  const grades = new Map(), rooms = new Map();
  const gradeOf = (g) => { if (!grades.has(g)) grades.set(g, { grade: g, rooms: new Set(), ...emptyCounts(), below_threshold: 0 }); return grades.get(g); };
  for (const r of roster) {
    const g = gradeOf(r.grade_level); g.enrolled++; g.rooms.add(r.classroom);
    const key = `${r.grade_level}/${r.classroom}`;
    if (!rooms.has(key)) rooms.set(key, { grade: r.grade_level, classroom: r.classroom, enrolled: 0, last_date: null });
    rooms.get(key).enrolled++;
  }

  // วันที่รายงาน + แนวโน้ม
  const byDate = new Map(trend.map((d) => [d, emptyCounts()]));
  const dayTotal = emptyCounts(); dayTotal.enrolled = ids.length;
  for (const r of dayRows) {
    const s = room.get(Number(r.student_id)), key = ATTENDANCE_CODES[r.code], bucket = byDate.get(String(r.att_date).slice(0, 10));
    if (!s || !key || !bucket) continue;
    bucket[key]++;
    if (r.att_date === reportDate) { dayTotal[key]++; gradeOf(s.grade_level)[key]++; }
  }

  // ร้อยละทั้งปี (ถึงวันนี้) แบบเดียวกับ grades
  const since = new Map(moves.map((m) => [Number(m.student_id), String(m.d).slice(0, 10)]));
  const elapsedSet = new Set(elapsed), absentBy = new Map();
  for (const r of absentRows) {
    const d = String(r.att_date).slice(0, 10), sid = Number(r.student_id);
    if (!elapsedSet.has(d) || d < (since.get(sid) || '')) continue;
    absentBy.set(sid, (absentBy.get(sid) || 0) + 1);
  }
  let studentDays = 0, absentDays = 0, below = 0;
  for (const sid of ids) {
    const from = since.get(sid) || '';
    const n = from ? elapsed.filter((d) => d >= from).length : elapsed.length;
    const a = absentBy.get(sid) || 0;
    studentDays += n; absentDays += a;
    if (n > 0 && ((n - a) * 100) / n < passPct) { below++; gradeOf(room.get(sid).grade_level).below_threshold++; }
  }

  let lastRecordedAt = null, lastDate = null;
  for (const r of lastRows) {
    const s = room.get(Number(r.student_id)); if (!s) continue;
    const rm = rooms.get(`${s.grade_level}/${s.classroom}`);
    if (!rm.last_date || r.d > rm.last_date) rm.last_date = r.d;
    if (!lastRecordedAt || r.u > lastRecordedAt) lastRecordedAt = r.u;
    if (!lastDate || r.d > lastDate) lastDate = r.d;
  }
  const recentFrom = trend[0] || null;
  const roomList = [...rooms.values()].sort((a, b) => gradeRank(a.grade) - gradeRank(b.grade) || String(a.classroom).localeCompare(String(b.classroom), 'th', { numeric: true }));

  return {
    available: true,
    source: 'grades',
    academic_year: { id: yearId, label: year.label || `ปีการศึกษา ${year.year_be}` },
    today, in_session: inSession, report_date: reportDate,
    term: term ? { number: term.term_number, name: term.name } : null,
    next_term: !term && nextTerm ? { number: nextTerm.term_number, name: nextTerm.name, start_date: nextTerm.start_date } : null,
    pass_pct: passPct,
    has_records: lastRows.length > 0,
    last_recorded_at: lastRecordedAt, last_recorded_date: lastDate,
    day: reportDate ? finish(dayTotal) : null,
    grades: [...grades.values()].sort((a, b) => gradeRank(a.grade) - gradeRank(b.grade))
      .map(({ rooms: set, ...g }) => ({ ...finish(g), rooms: set.size })),
    rooms: {
      total: roomList.length,
      recorded_recent: recentFrom ? roomList.filter((r) => r.last_date && r.last_date >= recentFrom).length : 0,
      list: roomList,
    },
    trend: trend.map((d) => { const c = byDate.get(d); c.enrolled = ids.length; return { date: d, ...finish(c) }; }),
    year: {
      school_days_total: days.length, school_days_elapsed: elapsed.length,
      student_days: studentDays, absent_days: absentDays,
      rate_pct: pct(studentDays - absentDays, studentDays), below_threshold: below,
    },
  };
}
