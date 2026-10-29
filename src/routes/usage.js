// ตรวจสอบการเข้าใช้งาน (system + grades ใช้ตารางเดียวกันใน D1)
// เบราว์เซอร์ส่งสัญญาณทุก 60 วินาทีเฉพาะตอนหน้าจอเปิดอยู่ (visible) และส่ง end ตอนสลับไปหน้าอื่น/ปิดแท็บ
// เวลาใช้งาน = ผลรวมช่วงห่างระหว่างสัญญาณที่ต่อเนื่องกัน (ห่างไม่เกิน 120 วินาที) เก็บเป็นยอดรายวันต่อคน ต่อระบบ
import { getCurrentUser, jsonResponse } from "../lib/auth.js";

let usageSchemaReady = false;
export async function ensureUsageSchema(env) {
  if (usageSchemaReady) return;
  await env.DB.batch([
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS usage_daily (
      user_id INTEGER NOT NULL, app TEXT NOT NULL, day TEXT NOT NULL,
      seconds INTEGER NOT NULL DEFAULT 0, pings INTEGER NOT NULL DEFAULT 0,
      first_ts INTEGER NOT NULL, last_ts INTEGER NOT NULL, active INTEGER NOT NULL DEFAULT 1,
      PRIMARY KEY (user_id, app, day))`),
    env.DB.prepare("CREATE INDEX IF NOT EXISTS idx_usage_daily_day ON usage_daily(day, app)"),
  ]);
  usageSchemaReady = true;
}

export async function recordUsagePing(env, userId, app, end) {
  await ensureUsageSchema(env);
  const now = Math.floor(Date.now() / 1000);
  const day = new Date((now + 7 * 3600) * 1000).toISOString().slice(0, 10); // วันตามเวลาไทย
  await env.DB.prepare(`INSERT INTO usage_daily (user_id, app, day, seconds, pings, first_ts, last_ts, active)
      VALUES (?1, ?2, ?3, 0, 1, ?4, ?4, ?5)
      ON CONFLICT(user_id, app, day) DO UPDATE SET
        seconds = seconds + CASE WHEN active = 1 AND ?4 - last_ts BETWEEN 0 AND 120 THEN ?4 - last_ts ELSE 0 END,
        pings = pings + 1, last_ts = ?4, active = ?5`)
    .bind(userId, app, day, now, end ? 0 : 1).run();
}

export async function handleUsageRoute(request, env, pathname, method) {
  if (pathname === "/api/activity/ping" && method === "POST") {
    const acting = await getCurrentUser(request, env).catch(() => null);
    const user = acting?.impersonator || acting; // โหมดมุมมองบุคคลอื่น: นับเป็นเวลาของผู้ดูแลระบบเอง
    if (!user) return jsonResponse({ error: "กรุณาเข้าสู่ระบบ" }, 401);
    const body = await request.json().catch(() => ({}));
    await recordUsagePing(env, user.id, "system", !!body?.end);
    return jsonResponse({ ok: true });
  }
  if (pathname === "/api/admin/usage" && method === "GET") {
    const user = await getCurrentUser(request, env);
    if (!user) return jsonResponse({ error: "กรุณาเข้าสู่ระบบ" }, 401);
    if (user.role !== "superadmin") return jsonResponse({ error: "เฉพาะผู้ดูแลระบบเท่านั้น" }, 403);
    await ensureUsageSchema(env);
    const today = new Date(Date.now() + 7 * 3600e3).toISOString().slice(0, 10);
    const param = new URL(request.url).searchParams.get("month");
    const month = /^\d{4}-\d{2}$/.test(param || "") ? param : today.slice(0, 7);
    const [rows, users, last] = await env.DB.batch([
      env.DB.prepare(`SELECT user_id, app, day, seconds, pings, first_ts, last_ts FROM usage_daily
        WHERE day LIKE ? ORDER BY day`).bind(`${month}-%`),
      env.DB.prepare(`SELECT id, full_name, email, role FROM users WHERE status = 'active' ORDER BY full_name`),
      env.DB.prepare(`SELECT user_id, MAX(last_ts) AS last_ts FROM usage_daily GROUP BY user_id`),
    ]);
    const months = await env.DB.prepare(`SELECT DISTINCT substr(day, 1, 7) AS m FROM usage_daily ORDER BY m DESC`).all();
    return jsonResponse({ month, today, rows: rows.results, users: users.results, last_seen: last.results,
      months: months.results.map((r) => r.m) }, 200, { "Cache-Control": "private, no-store" });
  }
  return null;
}
