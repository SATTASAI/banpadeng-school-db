// วันที่ตรวจเทียบ Gregorian–Lunar Conversion Table ของ Hong Kong Observatory
// https://www.hko.gov.hk/en/gts/time/calendar/pdf/files/2026e.pdf
// https://www.hko.gov.hk/en/gts/time/calendar/pdf/files/2027e.pdf
// https://www.hko.gov.hk/en/gts/time/calendar/pdf/files/2028e.pdf
// เดือนจีนไม่ใช่เดือนจันทรคติไทย จึงไม่ใช้ lunarDate() ของไทยแทนกัน
// เพิ่มปีที่ตรวจสอบแล้วในตารางนี้ก่อนแสดงเทศกาลจีนของปีใหม่
export const CHINESE_FESTIVALS = {
  2026: { newYear: "02-17", lantern: "03-03", qingming: "04-05", dragonBoat: "06-19", ghost: "08-27", midAutumn: "09-25", vegetarian: "10-10" },
  2027: { newYear: "02-06", lantern: "02-20", qingming: "04-05", dragonBoat: "06-09", ghost: "08-16", midAutumn: "09-15", vegetarian: "09-30" },
  2028: { newYear: "01-26", lantern: "02-09", qingming: "04-04", dragonBoat: "05-28", ghost: "09-03", midAutumn: "10-03", vegetarian: "10-18" },
};

const NAMES = {
  newYear: "วันตรุษจีน", lantern: "เทศกาลโคมไฟ (หยวนเซียว)", qingming: "วันเช็งเม้ง",
  dragonBoat: "เทศกาลไหว้บ๊ะจ่าง", ghost: "วันสารทจีน", midAutumn: "วันไหว้พระจันทร์",
};
const addDays = (iso, n) => {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

export function chineseFestivals(year) {
  const dates = CHINESE_FESTIVALS[year];
  if (!dates) return []; // ไม่คาดเดาวันจันทรคติของปีที่ยังไม่ได้ตรวจสอบ
  const out = Object.entries(NAMES).map(([key, name]) => ({ date: `${year}-${dates[key]}`, name }));
  out.push({ date: addDays(`${year}-${dates.newYear}`, -2), name: "วันจ่าย (ตรุษจีน)" });
  out.push({ date: addDays(`${year}-${dates.newYear}`, -1), name: "วันไหว้ (ตรุษจีน)" });
  // กินเจ = วันที่ 1–9 เดือน 9 จีน (วันจัดงานของแต่ละพื้นที่อาจเริ่มก่อน/จบหลัง)
  // https://thai.tourismthailand.org/Articles/vegetarian-festival-24
  for (let i = 0; i < 9; i++) out.push({ date: addDays(`${year}-${dates.vegetarian}`, i), name: `เทศกาลกินเจ (วันที่ ${i + 1})` });
  return out;
}
