// ข้อมูลกลาง "ครูคนไหนสอนวิชาอะไร ห้องไหน" — ฝ่ายวัดผลกำหนดในระบบรายงานผลการเรียน (students-report)
// ใช้ฐานข้อมูล D1 เดียวกัน: gr_subjects (วิชาต่อชั้น/ปี) · gr_courses (วิชา × ห้อง) · gr_course_teachers (ครูผู้สอน)
// ระบบนี้อ่านอย่างเดียว: ตารางสอน จัดตารางอัตโนมัติ สอนแทน ทะเบียนบุคลากร และ API เชื่อมตารางสอน ยึดข้อมูลนี้
// คาบ/สัปดาห์ = ชั่วโมงต่อปี ÷ 40 สัปดาห์ (ปัดเป็นจำนวนเต็ม อย่างน้อย 1)

const REQUIRED = ['gr_subjects', 'gr_courses', 'gr_course_teachers'];
export const periodsFromHours = (hours) => Math.max(1, Math.round((Number(hours) || 0) / 40));
const norm = (v) => String(v ?? '').normalize('NFC').trim().replace(/\s+/g, ' ');

async function tablesReady(env) {
  const { results } = await env.DB.prepare(
    `SELECT name FROM sqlite_master WHERE type='table' AND name IN (${REQUIRED.map(() => '?').join(',')})`
  ).bind(...REQUIRED).all();
  return results.length === REQUIRED.length;
}

// yearId หรือ termId (เลือกอย่างใดอย่างหนึ่ง) → { available, year_id, courses: [...], teachers: Map(user_id → {...}) }
// courses[i] = { course_id, grade_level, classroom, subject_code, subject, hours_per_year, periods_per_week,
//                teachers: [{ user_id, full_name, personnel_id }] }  (ครูเรียงตามชื่อ คนแรก = ครูหลักของตาราง)
export async function teachingMaster(env, { yearId = null, termId = null } = {}) {
  const empty = { available: false, year_id: yearId, courses: [], unlinked: [] };
  if (!(await tablesReady(env))) return empty;
  if (!yearId && termId) {
    const t = await env.DB.prepare('SELECT academic_year_id FROM academic_terms WHERE id = ?').bind(termId).first();
    yearId = t?.academic_year_id || null;
  }
  if (!yearId) return empty;
  const hasAccounts = !!(await env.DB.prepare("SELECT 1 AS ok FROM sqlite_master WHERE type='table' AND name='personnel_accounts'").first());
  const { results } = await env.DB.prepare(
    `SELECT c.id AS course_id, s.grade_level, c.classroom, s.code AS subject_code, s.name AS subject, s.hours_per_year, s.sort_order,
            u.id AS user_id, u.full_name,
            COALESCE(${hasAccounts ? '(SELECT pa.personnel_id FROM personnel_accounts pa JOIN personnel_records pp ON pp.id = pa.personnel_id AND pp.status = \'active\' WHERE pa.user_id = u.id),' : ''}
                     (SELECT pr.id FROM personnel_records pr WHERE pr.user_id = u.id AND pr.status = 'active')) AS personnel_id
       FROM gr_courses c
       JOIN gr_subjects s ON s.id = c.subject_id AND s.academic_year_id = ?
       JOIN gr_course_teachers ct ON ct.course_id = c.id
       JOIN users u ON u.id = ct.user_id AND u.status = 'active' AND u.deleted_at IS NULL
      ORDER BY s.grade_level, c.classroom, s.sort_order, s.code, u.full_name`
  ).bind(yearId).all();
  const byCourse = new Map(), unlinked = new Map();
  for (const r of results) {
    let c = byCourse.get(r.course_id);
    if (!c) {
      c = { course_id: r.course_id, grade_level: r.grade_level, classroom: r.classroom, subject_code: r.subject_code, subject: norm(r.subject),
        hours_per_year: r.hours_per_year, periods_per_week: periodsFromHours(r.hours_per_year), teachers: [] };
      byCourse.set(r.course_id, c);
    }
    c.teachers.push({ user_id: r.user_id, full_name: r.full_name, personnel_id: r.personnel_id || null });
    if (!r.personnel_id) unlinked.set(r.user_id, { user_id: r.user_id, full_name: r.full_name });
  }
  const courses = [...byCourse.values()];
  return { available: courses.length > 0, year_id: yearId, courses, unlinked: [...unlinked.values()] };
}

// ภาระสอนต่อบุคลากร: personnel_id → { subjects: ["ภาษาไทย (ป.4/1)", ...], periods_per_week }
export function loadByPersonnel(master) {
  const out = new Map();
  for (const c of master.courses) for (const t of c.teachers) {
    if (!t.personnel_id) continue;
    const row = out.get(t.personnel_id) || { subjects: [], subject_names: new Set(), periods_per_week: 0, courses: 0 };
    row.subjects.push(`${c.subject} (${c.grade_level}/${c.classroom})`);
    row.subject_names.add(c.subject);
    row.periods_per_week += c.periods_per_week;
    row.courses += 1;
    out.set(t.personnel_id, row);
  }
  return out;
}

// ห้องหนึ่ง: ชื่อวิชา → ครูที่สอนได้ (personnel_id) — ใช้ตรวจการลงคาบในตารางสอน
export function subjectsOfRoom(master, gradeLevel, classroom) {
  const m = new Map();
  for (const c of master.courses) if (c.grade_level === gradeLevel && c.classroom === classroom) m.set(c.subject, c);
  return m;
}
export const sameSubject = (a, b) => norm(a) === norm(b);
export { norm as normalizeSubject };
