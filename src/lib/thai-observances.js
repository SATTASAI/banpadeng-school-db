// วันสำคัญสำหรับปฏิทินโรงเรียน — แสดงประกอบเท่านั้น ไม่สร้าง gr_holidays
// และไม่มีผลต่อวันเรียน เวลาเรียน หรือบันทึกการมาเรียน
// วันตายตัว: https://manage.dld.go.th/index.php/th/news-head/relations/calendar2569
// วันเด็ก 2570: https://policy.bangkok.go.th/plans70/frontend/web/index.php?ID=9469&r=bma70projects%2Fview
// วันครู: https://elibrary.ksp.or.th/index.php?id_article=195&lvl=cmspage&pageid=4
import { lunarDate } from "./thai-holidays.js";
import { chineseFestivals } from "../data/chinese-festivals.js";

const FIXED = [
  ["01-16", "วันครู"],
  ["02-14", "วันวาเลนไทน์"],
  ["02-24", "วันศิลปินแห่งชาติ"],
  ["02-26", "วันสหกรณ์แห่งชาติ"],
  ["03-13", "วันช้างไทย"],
  ["04-02", "วันอนุรักษ์มรดกไทย"],
  ["05-01", "วันแรงงานแห่งชาติ"],
  ["05-31", "วันงดสูบบุหรี่โลก"],
  ["06-01", "วันดื่มนมโลก"],
  ["06-05", "วันสิ่งแวดล้อมโลก"],
  ["06-26", "วันสุนทรภู่ / วันต่อต้านยาเสพติดโลก"],
  ["07-01", "วันสถาปนาลูกเสือแห่งชาติ"],
  ["07-29", "วันภาษาไทยแห่งชาติ"],
  ["08-18", "วันวิทยาศาสตร์แห่งชาติ"],
  ["09-20", "วันเยาวชนแห่งชาติ"],
  ["10-31", "วันฮาโลวีน"],
  ["11-25", "วันวชิราวุธ / วันประถมศึกษาแห่งชาติ"],
  ["12-04", "วันสิ่งแวดล้อมไทย"],
  ["12-16", "วันกีฬาแห่งชาติ"],
  ["12-24", "วันคริสต์มาสอีฟ"],
  ["12-25", "วันคริสต์มาส"],
];

export function importantDaysBetween(from, to) {
  const out = [];
  for (let year = Number(from.slice(0, 4)); year <= Number(to.slice(0, 4)); year++) {
    for (const [md, name] of FIXED) out.push({ date: `${year}-${md}`, name });
    out.push(...chineseFestivals(year));
    // วันเด็ก = เสาร์ที่สองของเดือนมกราคม
    const jan1 = new Date(Date.UTC(year, 0, 1)).getUTCDay();
    const day = 8 + (6 - jan1 + 7) % 7;
    out.push({ date: `${year}-01-${String(day).padStart(2, "0")}`, name: "วันเด็กแห่งชาติ" });
    // วันออกพรรษา/ลอยกระทงใช้จันทรคติ ห้ามตรึงวันที่สุริยคติของปีก่อน
    for (let d = new Date(Date.UTC(year, 8, 1)); d.getUTCFullYear() === year; d.setUTCDate(d.getUTCDate() + 1)) {
      const date = d.toISOString().slice(0, 10), l = lunarDate(date);
      // สารทไทย = แรม 15 ค่ำ เดือน 10; ตักบาตรเทโว = แรม 1 ค่ำ เดือน 11
      // https://www.phuket.go.th/eng/blog-The%20Sart%20Thai%20day.php
      if (l.day === 30 && l.month === 10) out.push({ date, name: "วันสารทไทย" });
      if (l.day === 15 && l.month === 11) out.push({ date, name: "วันออกพรรษา" });
      if (l.day === 16 && l.month === 11) out.push({ date, name: "วันตักบาตรเทโว" });
      if (l.day === 15 && l.month === 12) out.push({ date, name: "วันลอยกระทง" });
    }
  }
  return out.filter((d) => d.date >= from && d.date <= to).sort((a, b) => a.date.localeCompare(b.date));
}
