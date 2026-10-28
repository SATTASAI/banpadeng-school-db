// วันหยุดราชการไทยประจำปี — คำนวณเอง ไม่ต้องรอกรอก
// - วันหยุดตามปฏิทินสุริยคติ (วันที่ตายตัว)
// - วันสำคัญทางพุทธศาสนาตามปฏิทินจันทรคติไทย (มาฆบูชา วิสาขบูชา อาสาฬหบูชา เข้าพรรษา)
//   ปีอธิกมาส (มีเดือน 8 สองหน): มาฆบูชาเลื่อนเป็นเดือน 4, วิสาขบูชาเดือน 7, อาสาฬหบูชาเดือน 8 หลัง
// - วันหยุดชดเชย: วันหยุดที่ตรงเสาร์/อาทิตย์ หยุดชดเชยวันทำการถัดไป (ยกเว้นวันเข้าพรรษา)
// ไม่รวม: วันพืชมงคล (วันที่กำหนดตามฤกษ์ทุกปี) และวันหยุดพิเศษตามมติ ครม. — ฝ่ายวัดผลเพิ่มเองในปฏิทิน
//
// การคำนวณจันทรคติพอร์ตจาก pythaidate (MIT, github.com/hmmbug/pythaidate) ตามคัมภีร์สุริยยาตร์ (Eade/Faraut)
// ตรวจกับวันหยุดที่ประกาศจริงปี 2566–2569 ตรงทุกวัน

const DAYS_IN_800_YEARS = 292207, UNITS = 800, EPOCH_OFFSET = 373;
const CS_JD_OFFSET = 1954167;
const DAY_COUNTS = { A: 354, B: 355, C: 384, c: 384 };
const fdiv = (a, b) => Math.floor(a / b);
const mod = (a, b) => ((a % b) + b) % b;

function lsYear(year) {
  const y = { year, offset: false };
  y.horakhun = fdiv(year * DAYS_IN_800_YEARS + EPOCH_OFFSET, UNITS) + 1;
  y.kammacapon = UNITS - mod(year * DAYS_IN_800_YEARS + EPOCH_OFFSET, UNITS);
  const avoQuot = fdiv(y.horakhun * 11 + 650, 692);
  y.avoman = mod(y.horakhun * 11 + 650, 692);
  if (y.avoman === 0) y.avoman = 692;
  y.tithi = mod(avoQuot + y.horakhun, 30);
  if (y.avoman === 692) y.tithi -= 1;
  y.weekday = mod(y.horakhun, 7);
  const h1 = fdiv((year + 1) * DAYS_IN_800_YEARS + EPOCH_OFFSET, UNITS) + 1;
  const tithi1 = mod(fdiv(h1 * 11 + 650, 692) + h1, 30);
  y.langsak = Math.max(1, y.tithi);
  let nyd = y.langsak;
  if (nyd < 6) nyd += 29;
  y.nyd = mod(y.weekday - nyd + 1 + 35, 7);
  y.leapday = y.kammacapon <= 207;
  y.cal = "A";
  if (y.tithi > 24 || y.tithi < 6) y.cal = "C";
  if (y.tithi === 25 && tithi1 === 5) y.cal = "A";
  if ((y.leapday && y.avoman <= 126) || (!y.leapday && y.avoman <= 137)) y.cal = y.cal !== "C" ? "B" : "c";
  y.nextNyd = mod(y.nyd + (y.cal === "A" ? 4 : y.cal === "B" ? 5 : 6), 7);
  return y;
}

const yearCache = new Map();
function year0(year) {
  if (yearCache.has(year)) return yearCache.get(year);
  const y = [-2, -1, 0, 1, 2].map((d) => lsYear(year + d));
  if (y[2].tithi === 24 && y[3].tithi === 6) for (const v of y) { v.cal = "C"; v.nextNyd = mod(v.nextNyd + 2, 7); }
  for (const i of [1, 2, 3]) if (y[i].cal === "c") {
    const j = y[i].nyd === y[i - 1].nextNyd ? 1 : -1;
    y[i + j].cal = "B"; y[i + j].nextNyd = mod(y[i + j].nextNyd + 1, 7);
  }
  for (const i of [1, 2, 3]) if (y[i - 1].nextNyd !== y[i].nyd && y[i].nextNyd !== y[i + 1].nyd) {
    y[i].offset = true; y[i].langsak += 1; y[i].nyd = mod(y[i].nyd + 6, 7); y[i].nextNyd = mod(y[i].nextNyd + 6, 7);
  }
  for (const v of y) if (v.cal === "c") v.cal = "C";
  const r = y[2];
  r.offsetDays = r.langsak;
  if (r.offsetDays < 6 + (r.offset ? 1 : 0)) r.offsetDays += 29;
  yearCache.set(year, r);
  return r;
}

// เดือนตามลำดับในตาราง: 13 = เดือน 8 แรก (8), 14 = เดือน 8 หลัง (88), 15/16 = เดือน 5/6 ของปีถัดไป
const LUNAR_MONTHS = [0, 5, 6, 7, 8, 9, 10, 11, 12, 1, 2, 3, 4, 8, 88, 15, 16];
const FIND = {
  A: [[383, 16], [354, 15], [324, 12], [295, 11], [265, 10], [236, 9], [206, 8], [177, 7], [147, 6], [118, 5], [88, 4], [59, 3], [29, 2]],
  B: [[384, 16], [355, 15], [325, 12], [296, 11], [266, 10], [237, 9], [207, 8], [178, 7], [148, 6], [119, 5], [89, 4], [59, 3], [29, 2]],
  C: [[384, 15], [354, 12], [325, 11], [295, 10], [266, 9], [236, 8], [207, 7], [177, 6], [148, 5], [118, 14], [88, 13], [59, 3], [29, 2]],
};
function findDate(cal, days) {
  for (const [a, b] of FIND[cal]) if (days > a) return { month: LUNAR_MONTHS[b], day: days - a };
  return { month: LUNAR_MONTHS[1], day: days };
}

const jdOf = (iso) => fdiv(Date.parse(`${iso}T00:00:00Z`), 864e5) + 2440588;
const isoOfJd = (jd) => new Date((jd - 2440588) * 864e5).toISOString().slice(0, 10);

// วันที่สุริยคติ → { year (จ.ศ.), month (5..12,1..4, 8 หรือ 88), day, leap (ปีอธิกมาส) }
export function lunarDate(iso) {
  const hk = jdOf(iso) - CS_JD_OFFSET;
  let year = fdiv(hk * 800 - 373, 292207), days;
  if (mod(hk, 292207) === 95333) { year -= 1; days = 365; }
  else days = hk - year0(year).horakhun;
  let y0 = year0(year), inYear = 365 + (y0.leapday ? 1 : 0);
  while (days > inYear) { year += 1; days -= inYear; y0 = year0(year); inYear = 365 + (y0.leapday ? 1 : 0); }
  const { month, day } = findDate(y0.cal, y0.offsetDays + days);
  return { year, month: month > 12 && month !== 88 ? month - 10 : month, day, leap: y0.cal === "C" };
}

const addDays = (iso, n) => isoOfJd(jdOf(iso) + n);

// วันพระใหญ่ของปีคริสต์ศักราช ce — คืน { makha, visakha, asalha, lent }
export function buddhistHolidays(ce) {
  const leap = lunarDate(`${ce}-08-15`).leap; // ปีจันทรคติที่เริ่มกลางปีนี้มีเดือน 8 สองหนหรือไม่
  const want = { makha: leap ? 4 : 3, visakha: leap ? 7 : 6, asalha: leap ? 88 : 8 };
  const out = {};
  for (let d = `${ce}-01-01`; d <= `${ce}-09-30`; d = addDays(d, 1)) {
    const l = lunarDate(d);
    if (l.day !== 15) continue;
    for (const [k, m] of Object.entries(want)) if (!out[k] && l.month === m) out[k] = d;
  }
  out.lent = out.asalha && addDays(out.asalha, 1);
  return out;
}

const FIXED = [
  ["01-01", "วันขึ้นปีใหม่"],
  ["04-06", "วันจักรี"],
  ["04-13", "วันสงกรานต์"], ["04-14", "วันสงกรานต์"], ["04-15", "วันสงกรานต์"],
  ["05-04", "วันฉัตรมงคล"],
  ["06-03", "วันเฉลิมพระชนมพรรษาสมเด็จพระราชินี"],
  ["07-28", "วันเฉลิมพระชนมพรรษาพระบาทสมเด็จพระเจ้าอยู่หัว"],
  ["08-12", "วันแม่แห่งชาติ"],
  ["10-13", "วันนวมินทรมหาราช"],
  ["10-23", "วันปิยมหาราช"],
  ["12-05", "วันพ่อแห่งชาติ"],
  ["12-10", "วันรัฐธรรมนูญ"],
  ["12-31", "วันสิ้นปี"],
];

// วันหยุดราชการ (ยังไม่รวมชดเชย) ของปี ค.ศ. ce — วันเดียวกันสองวันสำคัญรวมเป็นรายการเดียว
function baseHolidays(ce) {
  const b = buddhistHolidays(ce);
  const list = FIXED.map(([md, name]) => ({ date: `${ce}-${md}`, name }));
  if (b.makha) list.push({ date: b.makha, name: "วันมาฆบูชา" });
  if (b.visakha) list.push({ date: b.visakha, name: "วันวิสาขบูชา" });
  if (b.asalha) list.push({ date: b.asalha, name: "วันอาสาฬหบูชา" });
  if (b.lent) list.push({ date: b.lent, name: "วันเข้าพรรษา", noSub: true });
  const byDate = new Map();
  for (const h of list) {
    const g = byDate.get(h.date);
    if (g) { g.name = `${g.name} / ${h.name}`; g.noSub = g.noSub && h.noSub; } else byDate.set(h.date, { ...h });
  }
  return [...byDate.values()].sort((x, y) => (x.date < y.date ? -1 : 1));
}

// วันหยุดชดเชย: ตรงเสาร์/อาทิตย์ → วันทำการถัดไปที่ไม่ใช่วันหยุด (ดูข้ามปีได้)
// ยกเว้นวันเข้าพรรษา · สงกรานต์ (13–15 เม.ย.) ชดเชยรวมไม่เกิน 1 วัน
function withSubstitutes(list) {
  const wd = (iso) => new Date(`${iso}T00:00:00Z`).getUTCDay();
  const taken = new Set(list.map((h) => h.date));
  const subs = [], songkranDone = new Set();
  for (const h of list) {
    if (h.noSub || ![0, 6].includes(wd(h.date))) continue;
    const songkran = /-04-1[345]$/.test(h.date);
    if (songkran) { if (songkranDone.has(h.date.slice(0, 4))) continue; songkranDone.add(h.date.slice(0, 4)); }
    let d = addDays(songkran ? `${h.date.slice(0, 4)}-04-15` : h.date, 1);
    while ([0, 6].includes(wd(d)) || taken.has(d)) d = addDays(d, 1);
    taken.add(d);
    subs.push({ date: d, name: `วันหยุดชดเชย${songkran ? "วันสงกรานต์" : h.name.split(" / ")[0]}` });
  }
  return [...list, ...subs].map(({ date, name }) => ({ date, name })).sort((x, y) => (x.date < y.date ? -1 : 1));
}

// วันหยุดราชการในช่วงวันที่ from–to (รวมปลาย) พร้อมวันหยุดชดเชย — [{ date, name }]
export function governmentHolidaysBetween(from, to) {
  const all = [];
  for (let ce = Number(from.slice(0, 4)) - 1; ce <= Number(to.slice(0, 4)); ce++) all.push(...baseHolidays(ce));
  return withSubstitutes(all).filter((h) => h.date >= from && h.date <= to);
}

// วันหยุดราชการทั้งปี ค.ศ. ce
export const governmentHolidays = (ce) => governmentHolidaysBetween(`${ce}-01-01`, `${ce}-12-31`);
