// ตรวจภาระสอนในการจัดตารางอัตโนมัติให้ตรงข้อมูลกลางจากฝ่ายวัดผล
import { normalizeSubject } from './teaching-master.js';

const roomKey = (g, r) => `${g}/${r}`;

// config.assignments[i] = { grade_level, classroom, subject, teacher_id (personnel), periods_per_week, ... }
// คืนรายการปัญหา (ข้อความไทย) — ว่าง = ใช้ได้
export function masterIssues(config, master) {
  if (!master?.available) return [];
  const selected = new Set((config.classes || []).map((c) => roomKey(c.grade_level, c.classroom)));
  const issues = [];
  const byRoom = new Map();
  for (const c of master.courses) {
    if (!selected.has(roomKey(c.grade_level, c.classroom))) continue;
    (byRoom.get(roomKey(c.grade_level, c.classroom)) || byRoom.set(roomKey(c.grade_level, c.classroom), new Map()).get(roomKey(c.grade_level, c.classroom))).set(c.subject, c);
  }
  const seen = new Set();
  for (const a of config.assignments || []) {
    const room = roomKey(a.grade_level, a.classroom), c = byRoom.get(room)?.get(normalizeSubject(a.subject));
    if (!c) continue; // กิจกรรม/วิชาที่ไม่อยู่ในระบบวัดผล
    if (seen.has(c.course_id)) { issues.push(`${room} ${c.subject}: ซ้ำกันหลายแถว`); continue; }
    seen.add(c.course_id);
    if (!c.teachers.some((t) => t.personnel_id && t.personnel_id === Number(a.teacher_id)))
      issues.push(`${room} ${c.subject}: ครูต้องเป็น ${c.teachers.map((t) => t.full_name).join(' หรือ ')} ตามที่ฝ่ายวัดผลกำหนด`);
    if (Number(a.periods_per_week) !== c.periods_per_week)
      issues.push(`${room} ${c.subject}: ต้องมี ${c.periods_per_week} คาบ/สัปดาห์ (${c.hours_per_year} ชม./ปี)`);
  }
  for (const [room, subjects] of byRoom) for (const c of subjects.values())
    if (!seen.has(c.course_id)) issues.push(`${room} ${c.subject}: ยังไม่มีในภาระสอน (กด "ดึงภาระสอนจากฝ่ายวัดผล")`);
  return issues;
}
