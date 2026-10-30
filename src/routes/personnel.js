import { workScopeSummary } from "../lib/work-scopes.js";
import { getCurrentUser, isAdmin, jsonResponse } from "../lib/auth.js";
import { ensurePersonnelData } from "../lib/personnel-data.js";
import {ensureLeaveData} from "../lib/leave-data.js";
import { leaveStatistics, substituteLoad, canViewPersonnelStats, canViewAllLeaveStats } from "../lib/personnel-stats.js";

const PROFILE_FIELDS = [
  ["personnel_type", "ประเภทบุคลากร"],
  ["position", "ตำแหน่ง"],
  ["phone", "เบอร์โทรศัพท์"],
  ["departments", "ฝ่ายงาน"],
  ["service_start_date", "วันที่เริ่มรับราชการ/เริ่มงาน"],
  ["education_level", "วุฒิการศึกษา"],
  ["major", "วิชาเอก"],
  ["institution", "สถาบันการศึกษา"],
  ["license_expiry_date", "วันหมดอายุใบประกอบวิชาชีพ"],
];

function number(value) { return Number(value || 0); }

function completeness(row) {
  const missing = PROFILE_FIELDS.filter(([field]) => !String(row[field] ?? "").trim()).map(([, label]) => label);
  const completed = PROFILE_FIELDS.length - missing.length;
  return { completed, total: PROFILE_FIELDS.length, percent: Math.round(completed / PROFILE_FIELDS.length * 100), missing };
}

async function overview(request, env) {
  const user = await getCurrentUser(request, env);
  if (!user?.role) return jsonResponse({ error: "กรุณาเข้าสู่ระบบ" }, 401);
  await ensurePersonnelData(env);
  await ensureLeaveData(env);

  // วันที่ตามเวลาไทย และต้นปีงบประมาณ (1 ต.ค.)
  const bkToday = new Date(Date.now() + 7 * 3600 * 1000).toISOString().slice(0, 10);
  const fyStart = `${Number(bkToday.slice(5, 7)) >= 10 ? bkToday.slice(0, 4) : Number(bkToday.slice(0, 4)) - 1}-10-01`;
  const canViewLeaves = await canViewAllLeaveStats(env, user);
  const [staff, leaveSummary, recentLeaves, tasks, workSummary, positions, projects] = await Promise.all([
    env.DB.prepare(`SELECT id,user_id,full_name,email,personnel_type,position_number,position,academic_rank,phone,
      departments,service_start_date,education_level,major,institution,employment_status,retirement_date,
      license_expiry_date,homeroom_classroom,teaching_periods
      FROM personnel_records WHERE status='active' ORDER BY full_name`).all(),
    env.DB.prepare(`SELECT
      COUNT(*) AS total_count,
      SUM(CASE WHEN status='pending' THEN 1 ELSE 0 END) AS pending_count,
      SUM(CASE WHEN status='approved' AND start_date<=? AND end_date>=? THEN 1 ELSE 0 END) AS absent_today,
      SUM(CASE WHEN status='approved' AND start_date>=? THEN COALESCE(leave_days,julianday(end_date)-julianday(start_date)+1) ELSE 0 END) AS approved_days_ytd
      FROM leave_requests`).bind(bkToday, bkToday, fyStart).first(),
    env.DB.prepare(`SELECT lr.id,COALESCE(lr.leave_subtype,lr.leave_type) leave_type,lr.start_date,lr.end_date,lr.status,u.full_name
      FROM leave_requests lr JOIN users u ON u.id=lr.user_id
      ORDER BY CASE lr.status WHEN 'pending' THEN 0 ELSE 1 END,lr.created_at DESC LIMIT 8`).all(),
    env.DB.prepare(`SELECT
      SUM(CASE WHEN status='open' THEN 1 ELSE 0 END) AS open_count,
      SUM(CASE WHEN status='open' AND due_date IS NOT NULL AND due_date<? THEN 1 ELSE 0 END) AS overdue_count
      FROM tasks`).bind(bkToday).first(),
    env.DB.prepare(`SELECT area,topic_key,
      COUNT(*) AS total_count,
      SUM(CASE WHEN status='completed' THEN 1 ELSE 0 END) AS completed_count,
      SUM(CASE WHEN status NOT IN ('completed','cancelled') AND due_date IS NOT NULL AND due_date<? THEN 1 ELSE 0 END) AS overdue_count
      FROM work_records WHERE area IN ('personnel','staff') GROUP BY area,topic_key`).bind(bkToday).all(),
    env.DB.prepare(`SELECT COALESCE(NULLIF(TRIM(position),''),'ไม่ระบุตำแหน่ง') AS label,COUNT(*) AS count
      FROM personnel_records WHERE status='active' GROUP BY COALESCE(NULLIF(TRIM(position),''),'ไม่ระบุตำแหน่ง')
      ORDER BY count DESC,label LIMIT 12`).all(),
    env.DB.prepare(`SELECT COUNT(*) AS total_count,
      SUM(CASE WHEN status='completed' THEN 1 ELSE 0 END) AS completed_count
      FROM projects WHERE COALESCE(management_area,department)='personnel'`).first(),
  ]);

  const today = bkToday;
  const people = staff.results.map((row) => ({
    id: row.id,
    user_id: row.user_id,
    full_name: row.full_name,
    position: row.position,
    personnel_type: row.personnel_type,
    academic_rank: row.academic_rank,
    employment_status: row.employment_status || "working",
    homeroom_classroom: row.homeroom_classroom,
    teaching_periods: row.teaching_periods,
    license_expiry_date: row.license_expiry_date,
    license_days_remaining: row.license_expiry_date
      ? Math.ceil((new Date(`${row.license_expiry_date}T00:00:00Z`) - new Date(`${today}T00:00:00Z`)) / 86400000)
      : null,
    completeness: completeness(row),
  }));
  const completeCount = people.filter((row) => row.completeness.percent === 100).length;
  const licenseAttention = people.filter((row) => row.license_days_remaining !== null && row.license_days_remaining <= 180).length;
  const workByTopic = Object.fromEntries(workSummary.results.filter(row => row.area === 'personnel').map((row) => [String(row.topic_key), {
    total: number(row.total_count), completed: number(row.completed_count), overdue: number(row.overdue_count),
  }]));
  workByTopic.project = { total: number(projects?.total_count), completed: number(projects?.completed_count), overdue: 0 };

  return jsonResponse({
    summary: {
      staff_count: people.length,
      complete_profiles: completeCount,
      incomplete_profiles: people.length - completeCount,
      pending_leave: number(leaveSummary?.pending_count),
      absent_today: number(leaveSummary?.absent_today),
      approved_leave_days_ytd: number(leaveSummary?.approved_days_ytd),
      open_tasks: number(tasks?.open_count),
      overdue_tasks: number(tasks?.overdue_count),
      license_attention: licenseAttention,
    },
    people,
    positions: positions.results.map((row) => ({ label: row.label, count: number(row.count) })),
    recent_leaves: canViewLeaves ? recentLeaves.results : [],
    can_view_leaves: canViewLeaves,
    work_by_topic: workByTopic,
    work_by_scope: workScopeSummary(workSummary.results),
    permissions: { can_manage: isAdmin(user) },
  }, 200, { "Cache-Control": "private, no-store" });
}

export async function handlePersonnelRoute(request, env, pathname, method) {
  if (!pathname.startsWith("/api/personnel")) return null;
  if (pathname === "/api/personnel/overview" && method === "GET") return overview(request, env);
  if (pathname === "/api/personnel/leave-stats" && method === "GET") return leaveStatsRoute(request, env);
  if (pathname === "/api/personnel/substitute-stats" && method === "GET") return substituteStatsRoute(request, env);
  return jsonResponse({ error: "ไม่พบ endpoint ฝ่ายบริหารงานบุคคลนี้" }, 404);
}

// หน้าสถิติวันลา (ฝ่ายบุคคล) — ผู้บริหาร/ฝ่ายบุคลากร/ผู้ดูแลระบบเห็นทุกคน ครูทั่วไปเห็นเฉพาะของตนเอง
async function leaveStatsRoute(request, env) {
  const user = await getCurrentUser(request, env);
  if (!user?.role) return jsonResponse({ error: "กรุณาเข้าสู่ระบบ" }, 401);
  await ensurePersonnelData(env);
  await ensureLeaveData(env);
  const q = new URL(request.url).searchParams, all = await canViewAllLeaveStats(env, user);
  const data = await leaveStatistics(env, { fiscalYear: q.get("fiscal_year"), period: q.get("period") || "year", onlyUserId: all ? null : user.id });
  if (data.error) return jsonResponse({ error: data.error }, 400);
  return jsonResponse({ ...data, scope: all ? "all" : "self" }, 200, { "Cache-Control": "private, no-store" });
}

// หน้าสถิติการสอนแทน — ตัวเลขชุดเดียวกับหน้าจัดสอนแทนและแดชบอร์ด (substituteLoad)
async function substituteStatsRoute(request, env) {
  const user = await getCurrentUser(request, env);
  if (!user?.role) return jsonResponse({ error: "กรุณาเข้าสู่ระบบ" }, 401);
  await ensurePersonnelData(env);
  const q = new URL(request.url).searchParams, all = await canViewPersonnelStats(env, user);
  let own = null;
  if (!all) {
    own = await env.DB.prepare(`SELECT a.personnel_id FROM personnel_accounts a JOIN personnel_records p ON p.id=a.personnel_id AND p.status='active' WHERE a.user_id=? LIMIT 1`).bind(user.id).first();
    if (!own) return jsonResponse({ error: "บัญชีนี้ยังไม่ได้ผูกกับทะเบียนบุคลากร จึงยังไม่มีสถิติการสอนแทน" }, 404);
  }
  const data = await substituteLoad(env, { date: q.get("date") || undefined, start: q.get("start"), end: q.get("end"), onlyPersonnelId: own?.personnel_id ?? null });
  if (data.error) return jsonResponse({ error: data.error }, 400);
  return jsonResponse({ ...data, scope: all ? "all" : "self" }, 200, { "Cache-Control": "private, no-store" });
}
