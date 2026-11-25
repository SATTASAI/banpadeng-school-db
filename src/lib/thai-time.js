// วันที่ภาษาไทยตามเวลาไทย (Asia/Bangkok)
// รับได้ทั้งวันที่ล้วน (YYYY-MM-DD) และเวลาจากฐานข้อมูล (YYYY-MM-DD HH:MM:SS ซึ่งเก็บเป็น UTC)
export function thaiDateText(value, options = { day: "numeric", month: "long", year: "numeric" }) {
  if (!value) return "";
  const s = String(value).trim();
  const date = /^\d{4}-\d{2}-\d{2}$/.test(s) ? new Date(`${s}T12:00:00+07:00`)
    : new Date(/[zZ]$|[+-]\d\d:?\d\d$/.test(s) ? s.replace(" ", "T") : `${s.replace(" ", "T")}Z`);
  return Number.isNaN(date.getTime()) ? "" : date.toLocaleDateString("th-TH", { ...options, timeZone: "Asia/Bangkok" });
}
