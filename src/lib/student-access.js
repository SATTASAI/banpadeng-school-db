// สิทธิ์ดูข้อมูลส่วนบุคคลของนักเรียน (เลขบัตรประชาชน สุขภาพ ครอบครัว ผู้ปกครอง กรณีดูแลช่วยเหลือ)
// ผู้บริหาร/ผู้ดูแลระบบ/เจ้าหน้าที่ = ทุกคน · ครูประจำชั้น = เฉพาะนักเรียนในห้องของตน · ครูอื่น = ข้อมูลพื้นฐานเท่านั้น
import { isAdmin } from "./auth.js";

export const canManageAllStudents = (user) => isAdmin(user) || user?.role === "staff";
export const roomKey = (grade, room) => `${String(grade ?? "").trim()}|${String(room ?? "").trim()}`;

// ห้องที่ผู้ใช้เป็นครูประจำชั้น: จากระบบรายงานผลการเรียน (gr_homerooms ปีที่เปิดใช้) และตารางที่ระบบนั้นส่งมา (learner_class_assignments ภาคปัจจุบัน)
export async function homeroomRooms(env, userId) {
  const out = new Set();
  const tables = new Set(((await env.DB.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('gr_homerooms','learner_class_assignments')"
  ).all().catch(() => ({ results: [] }))).results || []).map((r) => r.name));
  if (tables.has("gr_homerooms")) {
    const { results } = await env.DB.prepare(`SELECT h.grade_level, h.classroom FROM gr_homerooms h JOIN academic_years y ON y.id = h.academic_year_id
      WHERE y.status = 'active' AND h.user_id = ?`).bind(userId).all();
    for (const r of results) out.add(roomKey(r.grade_level, r.classroom));
  }
  if (tables.has("learner_class_assignments")) {
    const { results } = await env.DB.prepare(`SELECT a.grade_level, a.classroom FROM learner_class_assignments a JOIN academic_terms t ON t.id = a.academic_term_id
      WHERE t.status = 'active' AND a.teacher_user_id = ?`).bind(userId).all();
    for (const r of results) out.add(roomKey(r.grade_level, r.classroom));
  }
  return out;
}

export async function canSeeStudentPrivate(env, user, student, rooms = null) {
  if (canManageAllStudents(user)) return true;
  if (!student) return false;
  return (rooms || await homeroomRooms(env, user.id)).has(roomKey(student.grade_level, student.classroom));
}

// ข้อมูลพื้นฐานที่ครูทุกคนเห็นได้
export const BASIC_STUDENT_FIELDS = ["id", "student_code", "full_name", "name_prefix", "first_name", "last_name", "grade_level", "classroom", "status", "gender", "photo_url", "created_at"];
export function basicStudent(student) {
  const out = {};
  for (const k of BASIC_STUDENT_FIELDS) if (k in student) out[k] = student[k];
  return { ...out, guardians: [], private_hidden: true };
}
