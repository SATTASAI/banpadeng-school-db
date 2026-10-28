// ปฏิทินปฏิบัติงานบนหน้า dashboard — อ่านวันหยุดจากระบบผลการเรียน (gr_holidays ใน D1 เดียวกัน) แบบอ่านอย่างเดียว
// แก้วันหยุดได้ที่ระบบ grades โดยฝ่ายวัดผลเท่านั้น · ผู้ชมภายนอกดูไม่ได้
import { getCurrentUser, jsonResponse } from "../lib/auth.js";
import { importantDaysBetween } from "../lib/thai-observances.js";

const safeAll = async (stmt) => { try { return (await stmt.all()).results || []; } catch { return []; } };

export async function handleWorkCalendarRoute(request, env, pathname, method) {
  if (pathname !== "/api/work-calendar" || method !== "GET") return null;
  const user = await getCurrentUser(request, env);
  if (!user) return jsonResponse({ error: "กรุณาเข้าสู่ระบบ" }, 401);
  if (!user.role || user.role === "viewer") return jsonResponse({ error: "ไม่มีสิทธิ์ดูปฏิทินปฏิบัติงาน" }, 403);

  const url = new URL(request.url);
  const yearParam = Number(url.searchParams.get("year")) || 0;
  const year = yearParam
    ? await env.DB.prepare("SELECT id, year_be, label, status, start_date, end_date FROM academic_years WHERE id = ?").bind(yearParam).first()
    : await env.DB.prepare("SELECT id, year_be, label, status, start_date, end_date FROM academic_years ORDER BY (status = 'active') DESC, year_be DESC LIMIT 1").first();
  if (!year) return jsonResponse({ error: "ยังไม่มีปีการศึกษาในระบบ" }, 404);

  const [terms, holidays] = await Promise.all([
    safeAll(env.DB.prepare("SELECT term_number, start_date, end_date FROM academic_terms WHERE academic_year_id = ? ORDER BY term_number").bind(year.id)),
    safeAll(env.DB.prepare(`SELECT h.holiday_date, h.name, CASE WHEN s.name = h.name THEN 1 ELSE 0 END AS gov FROM gr_holidays h
      LEFT JOIN gr_holiday_seeds s ON s.academic_year_id = h.academic_year_id AND s.holiday_date = h.holiday_date
      WHERE h.academic_year_id = ? ORDER BY h.holiday_date`).bind(year.id)),
  ]);
  const off = new Set(holidays.map((h) => h.holiday_date));
  let schoolDays = 0;
  for (const t of terms) {
    for (let d = new Date(`${t.start_date}T00:00:00Z`); d.toISOString().slice(0, 10) <= t.end_date; d.setUTCDate(d.getUTCDate() + 1)) {
      const wd = d.getUTCDay();
      if (wd !== 0 && wd !== 6 && !off.has(d.toISOString().slice(0, 10))) schoolDays++;
    }
  }
  const from = [year.start_date, terms[0]?.start_date].filter(Boolean).map((v) => String(v).slice(0, 10)).sort()[0];
  const to = [year.end_date, terms.at(-1)?.end_date].filter(Boolean).map((v) => String(v).slice(0, 10)).sort().at(-1);
  const important_days = from && to && /^\d{4}-\d{2}-\d{2}$/.test(from) && /^\d{4}-\d{2}-\d{2}$/.test(to) ? importantDaysBetween(from, to) : [];
  return jsonResponse({
    year: { id: year.id, year_be: year.year_be, label: year.label },
    terms, holidays, important_days, school_days: schoolDays,
  });
}
