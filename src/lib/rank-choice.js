// ปุ่มเลือกตำแหน่ง/วิทยฐานะ (หน้าสมัครสมาชิก และ บัญชีของฉัน) ↔ personnel_records.position / academic_rank
// ระบบประเมิน PA เลือกชุดตัวชี้วัดจาก academic_rank · ครูผู้ช่วยแยกจาก position
export const RANK_CHOICES = ["ครูผู้ช่วย", "ครู", "ครูชำนาญการ", "ครูชำนาญการพิเศษ", "ครูเชี่ยวชาญ", "อื่น ๆ"];

// คืน { position, academic_rank } หรือ { error } · อื่น ๆ: ใช้ตำแหน่งที่พิมพ์ และคงวิทยฐานะเดิม (keepRank) ไว้
export function rankChoiceToRecord(choice, other, keepRank = null) {
  if (!RANK_CHOICES.includes(choice)) return { error: "กรุณาเลือกตำแหน่ง/วิทยฐานะ" };
  if (choice === "อื่น ๆ") {
    const position = String(other || "").trim().slice(0, 200);
    if (!position) return { error: "กรุณาระบุตำแหน่ง" };
    if (/^ครู/.test(position)) return { error: "ตำแหน่งครูให้เลือกจากปุ่มวิทยฐานะ" };
    return { position, academic_rank: keepRank || null };
  }
  if (choice === "ครูผู้ช่วย") return { position: "ครูผู้ช่วย", academic_rank: null };
  return { position: "ครู", academic_rank: choice === "ครู" ? null : choice };
}

export function recordToRankChoice(position, academicRank) {
  const pos = String(position || "").replace(/\s+/g, ""), rank = String(academicRank || "").replace(/\s+/g, "");
  if (!/^ครู/.test(pos)) return { choice: pos ? "อื่น ๆ" : "", other: String(position || "").trim() };
  if (/^ครูผู้ช่วย/.test(pos)) return { choice: "ครูผู้ช่วย", other: "" };
  const all = pos + rank;
  if (/เชี่ยวชาญ/.test(all)) return { choice: "ครูเชี่ยวชาญ", other: "" };
  if (/ชำนาญการพิเศษ/.test(all)) return { choice: "ครูชำนาญการพิเศษ", other: "" };
  if (/ชำนาญการ/.test(all)) return { choice: "ครูชำนาญการ", other: "" };
  return { choice: "ครู", other: "" };
}
