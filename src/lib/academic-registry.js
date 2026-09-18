export const ACADEMIC_CENTERS = [
  {
    key: "curriculum",
    label: "หลักสูตรสถานศึกษา",
    description: "จัดทำ ทบทวน อนุมัติ และเก็บหลักสูตรสถานศึกษาอย่างเป็นระบบ",
    legacyKeys: ["0"],
  },
  {
    key: "lesson-plans",
    label: "แผนการจัดการเรียนรู้",
    description: "ส่ง ตรวจ ให้ข้อเสนอแนะ และติดตามแผนการจัดการเรียนรู้",
    legacyKeys: ["2"],
  },
  {
    key: "timetable",
    label: "ตารางเรียน ตารางสอน และห้องเรียน",
    description: "บริหารคาบเรียน ครู ห้อง และตรวจสอบตารางชนกัน",
    legacyKeys: ["3", "8", "9", "10", "11", "12", "13", "14", "15"],
  },
  {
    key: "assessment",
    label: "ตารางสอบและงานวัดผล",
    description: "ติดตามตารางสอบ งานวัดผล และกำหนดส่งใน Q-Info โดยไม่เก็บคะแนนซ้ำ",
    legacyKeys: ["4", "6"],
  },
  {
    key: "supervision-quality",
    label: "นิเทศ PLC และประกันคุณภาพ",
    description: "วางแผนนิเทศ ติดตาม PLC และรวบรวมหลักฐานประกันคุณภาพ",
    legacyKeys: ["7"],
  },
  {
    key: "projects-calendar",
    label: "โครงการ ปฏิทิน และกิจกรรมวิชาการ",
    description: "ติดตามโครงการ งบประมาณ ปฏิทิน และกิจกรรมวิชาการ",
    legacyKeys: ["1"],
  },
  {
    key: "qinfo",
    label: "Q-Info Center",
    description: "เปิด Q-Info และติดตามความพร้อมของงานโดยไม่บันทึกข้อมูลซ้ำ",
    legacyKeys: ["5"],
  },
  {
    key: "academic-reports",
    label: "รายงานและสรุปงานวิชาการ",
    description: "สรุปงานคงค้าง กำหนดส่ง และหลักฐานสำหรับผู้บริหาร",
    legacyKeys: [],
  },
];

export const ACADEMIC_CENTER_BY_KEY = Object.fromEntries(
  ACADEMIC_CENTERS.map((center) => [center.key, center])
);

const LEGACY_TO_KEY = Object.fromEntries(
  ACADEMIC_CENTERS.flatMap((center) => center.legacyKeys.map((legacyKey) => [legacyKey, center.key]))
);

export function resolveAcademicCenterKey(value) {
  const key = String(value ?? "").trim();
  if (ACADEMIC_CENTER_BY_KEY[key]) return key;
  return LEGACY_TO_KEY[key] || null;
}

export function getAcademicTopicKeys(value) {
  const resolved = resolveAcademicCenterKey(value);
  if (!resolved) return [];
  const center = ACADEMIC_CENTER_BY_KEY[resolved];
  return [resolved, ...center.legacyKeys];
}

export function getAcademicCenter(value) {
  const resolved = resolveAcademicCenterKey(value);
  return resolved ? ACADEMIC_CENTER_BY_KEY[resolved] : null;
}
