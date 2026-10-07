// ข้อมูลที่ "ระบบรายงานผลการเรียน" (students-report) เป็นเจ้าของ — ระบบทะเบียนนี้แสดงได้แต่แก้ไม่ได้
// เพื่อไม่ให้มีสองที่แก้ข้อมูลเดียวกันจนไม่ตรงกัน: ข้อมูลประจำตัว/ห้อง/สถานะนักเรียน, ครูประจำชั้น, น้ำหนักส่วนสูง
// ผู้ดูแลระบบ (superadmin) ดึงข้อมูลเดิมจากระบบนี้ไปใช้ได้ที่ระบบรายงานผลการเรียน เมนู "ดึงข้อมูลจากระบบทะเบียน"
export const GRADES_URL = "https://grades.banpadengschool.ac.th";
export const GRADE_OWNED_STUDENT_FIELDS = ["student_code", "full_name", "national_id", "name_prefix", "first_name", "last_name", "birth_date", "classroom", "grade_level", "status"];
export const GRADE_OWNED_DETAIL_FIELDS = ["gender", "weight_kg", "height_cm"];
export const GRADE_OWNED_MESSAGE = `ข้อมูลนี้แก้ได้ที่ระบบรายงานผลการเรียน (${GRADES_URL}) ที่เดียว`;

// ตัดช่องที่ระบบเกรดเป็นเจ้าของออกจากข้อมูลที่ส่งมาแก้ (ช่องอื่น เช่น ที่อยู่ ผู้ปกครอง สุขภาพ ยังแก้ได้ตามเดิม)
export function stripGradeOwned(body) {
  const removed = [];
  for (const f of [...GRADE_OWNED_STUDENT_FIELDS, ...GRADE_OWNED_DETAIL_FIELDS]) {
    if (body && Object.prototype.hasOwnProperty.call(body, f)) { delete body[f]; removed.push(f); }
  }
  return removed;
}
