// ส่งแจ้งเตือนทุกระบบทาง LINE รายบุคคล
// ใช้รายการเดียวกับกระดิ่งแจ้งเตือนในระบบ (src/routes/notifications.js) แล้วรวมเป็นข้อความเดียวต่อคนต่อรอบ
// ทำงานทุก 2 นาที (Cron) และหลังมีการบันทึกข้อมูลในระบบ (เว้นระยะอย่างน้อย LOCK_SECONDS)
// งานแจ้งซ่อมส่ง LINE ของตัวเองอยู่แล้ว และไม่อยู่ในรายการนี้ จึงไม่ซ้ำกัน
import { ensureLinePersonalSchema } from "./line-personal.js";
import { unreadNotificationsFor } from "../routes/notifications.js";

const ready = new WeakSet();
const LOCK_SECONDS = 15;
const MAX_AGE_HOURS = 72; // ไม่ส่งรายการที่เก่ากว่านี้ (เช่น ตอนเพิ่งเชื่อม LINE)
const MAX_LINES = 5;
const DEFAULT_ORIGIN = "https://system.banpadengschool.ac.th";

export async function ensureLineFeedSchema(env) {
  if (ready.has(env.DB)) return;
  await env.DB.batch([
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS line_feed_users (
      user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      enabled INTEGER NOT NULL DEFAULT 1, baseline_at TEXT NOT NULL DEFAULT (datetime('now')))`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS line_feed_sent (
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, message_key TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('baseline','pending','sent','failed','skipped')),
      error TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')), PRIMARY KEY(user_id, message_key))`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS line_feed_runs (
      id INTEGER PRIMARY KEY CHECK (id = 1), started_at TEXT, finished_at TEXT, trigger TEXT,
      users_checked INTEGER, messages_sent INTEGER, items_sent INTEGER, failures INTEGER, quota_remaining INTEGER, note TEXT)`),
    env.DB.prepare("CREATE INDEX IF NOT EXISTS idx_line_feed_sent_created ON line_feed_sent(created_at)"),
  ]);
  ready.add(env.DB);
}

const age = (value) => {
  const text = String(value || "");
  const time = Date.parse(/[zZ]|[+-]\d\d:?\d\d$/.test(text) ? text : text.replace(" ", "T") + "Z");
  return Number.isFinite(time) ? (Date.now() - time) / 3600000 : 0;
};
const trim = (text, max) => { const value = String(text || "").replace(/\s+/g, " ").trim(); return value.length > max ? value.slice(0, max - 1) + "…" : value; };

export function buildLineDigest(items, origin = DEFAULT_ORIGIN) {
  const base = String(origin || DEFAULT_ORIGIN).replace(/\/$/, "");
  const lines = items.slice(0, MAX_LINES).map((item) => `• ${trim(item.title, 80)}\n  ${trim(item.message, 160)}`);
  const more = items.length > MAX_LINES ? `\n…และอีก ${items.length - MAX_LINES} รายการ` : "";
  const link = items.length === 1 ? base + (items[0].url || "/dashboard.html") : base + "/dashboard.html";
  const head = items.length === 1 ? "🔔 แจ้งเตือนจากระบบโรงเรียนบ้านป่าเด็ง" : `🔔 มีแจ้งเตือนใหม่ ${items.length} รายการ`;
  return `${head}\n\n${lines.join("\n\n")}${more}\n\nเปิดดู: ${link}`;
}

async function lineJson(env, path) {
  try {
    const response = await fetch(`https://api.line.me${path}`, { headers: { Authorization: `Bearer ${env.LINE_CHANNEL_ACCESS_TOKEN}` } });
    return response.ok ? await response.json() : null;
  } catch { return null; }
}

async function quotaRemaining(env) {
  const [quota, usage] = await Promise.all([lineJson(env, "/v2/bot/message/quota"), lineJson(env, "/v2/bot/message/quota/consumption")]);
  if (quota?.type !== "limited" || !Number.isFinite(Number(quota?.value)) || !Number.isFinite(Number(usage?.totalUsage))) return null;
  return Math.max(0, Number(quota.value) - Number(usage.totalUsage));
}

async function push(env, to, text) {
  const response = await fetch("https://api.line.me/v2/bot/message/push", {
    method: "POST",
    headers: { Authorization: `Bearer ${env.LINE_CHANNEL_ACCESS_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ to, messages: [{ type: "text", text }] }),
  });
  if (!response.ok) throw new Error(`LINE ${response.status}: ${(await response.text()).slice(0, 200)}`);
}

async function acquire(env, trigger) {
  await env.DB.prepare("INSERT OR IGNORE INTO line_feed_runs(id) VALUES(1)").run();
  const result = await env.DB.prepare(`UPDATE line_feed_runs SET started_at=datetime('now'),trigger=?
    WHERE id=1 AND (started_at IS NULL OR started_at<datetime('now',?))`).bind(trigger, `-${LOCK_SECONDS} seconds`).run();
  return Boolean(result.meta.changes);
}

export async function dispatchLineNotifications(env, { trigger = "cron", origin = env.PUBLIC_BASE_URL || DEFAULT_ORIGIN } = {}) {
  if (!env.LINE_CHANNEL_ACCESS_TOKEN || !env.DB) return { skipped: "not_configured" };
  await ensureLinePersonalSchema(env);
  await ensureLineFeedSchema(env);
  if (!await acquire(env, trigger)) return { skipped: "locked" };
  const { results: people } = await env.DB.prepare(`SELECT l.user_id,l.line_user_id,u.id,u.role,u.full_name,COALESCE(f.enabled,1) enabled,f.user_id known
    FROM line_user_links l JOIN users u ON u.id=l.user_id LEFT JOIN line_feed_users f ON f.user_id=l.user_id
    WHERE l.status='active' AND u.status='active' AND u.role IS NOT NULL AND u.deleted_at IS NULL ORDER BY l.user_id`).all();
  const reserve = Number.isFinite(Number(env.LINE_FEED_RESERVE)) ? Number(env.LINE_FEED_RESERVE) : 20;
  let remaining, sent = 0, items = 0, failures = 0, quotaBlocked = 0;
  for (const person of people) {
    if (!Number(person.enabled)) continue;
    let rows;
    try { rows = await unreadNotificationsFor(env, { id: Number(person.user_id), role: person.role }, 50); }
    catch { failures++; continue; }
    // คนที่เพิ่งเชื่อม LINE: จดรายการที่ค้างอยู่ไว้เฉยๆ ไม่ส่งย้อนหลัง
    const fresh = await env.DB.prepare("INSERT OR IGNORE INTO line_feed_users(user_id) VALUES(?)").bind(person.user_id).run();
    if (fresh.meta.changes) {
      if (rows.length) await env.DB.batch(rows.map((row) => env.DB.prepare("INSERT OR IGNORE INTO line_feed_sent(user_id,message_key,status) VALUES(?,?,'baseline')").bind(person.user_id, row.message_key)));
      continue;
    }
    if (!rows.length) continue;
    const keys = rows.map((r) => r.message_key);
    const { results: seen } = await env.DB.prepare(`SELECT message_key FROM line_feed_sent WHERE user_id=? AND message_key IN (${keys.map(() => "?").join(",")})`).bind(person.user_id, ...keys).all();
    const known = new Set(seen.map((r) => r.message_key));
    const candidates = rows.filter((r) => !known.has(r.message_key));
    if (!candidates.length) continue;
    const old = candidates.filter((r) => age(r.created_at) > MAX_AGE_HOURS), current = candidates.filter((r) => age(r.created_at) <= MAX_AGE_HOURS);
    if (old.length) await env.DB.batch(old.map((r) => env.DB.prepare("INSERT OR IGNORE INTO line_feed_sent(user_id,message_key,status) VALUES(?,?,'skipped')").bind(person.user_id, r.message_key)));
    if (!current.length) continue;
    if (remaining === undefined) remaining = await quotaRemaining(env);
    if (remaining !== null && remaining <= reserve) { quotaBlocked++; continue; }
    // จองรายการก่อนส่ง เพื่อไม่ให้สองรอบที่ทำงานซ้อนกันส่งซ้ำ
    const claims = await env.DB.batch(current.map((r) => env.DB.prepare("INSERT OR IGNORE INTO line_feed_sent(user_id,message_key,status) VALUES(?,?,'pending')").bind(person.user_id, r.message_key)));
    const mine = current.filter((_, index) => claims[index].meta.changes);
    if (!mine.length) continue;
    const update = (status, error = null) => env.DB.batch(mine.map((r) => env.DB.prepare("UPDATE line_feed_sent SET status=?,error=? WHERE user_id=? AND message_key=? AND status='pending'").bind(status, error, person.user_id, r.message_key)));
    try {
      await push(env, person.line_user_id, buildLineDigest(mine, origin));
      await update("sent"); sent++; items += mine.length;
      if (remaining !== null) remaining--;
    } catch (error) {
      failures++; await update("failed", String(error?.message || error).slice(0, 300));
    }
  }
  await env.DB.prepare("DELETE FROM line_feed_sent WHERE created_at<datetime('now','-90 days')").run();
  const note = quotaBlocked ? `โควตา LINE ใกล้หมด ข้ามการส่ง ${quotaBlocked} คน (เก็บสำรองไว้ ${reserve} ข้อความ)` : null;
  await env.DB.prepare(`UPDATE line_feed_runs SET finished_at=datetime('now'),users_checked=?,messages_sent=?,items_sent=?,failures=?,quota_remaining=?,note=? WHERE id=1`)
    .bind(people.length, sent, items, failures, remaining ?? null, note).run();
  return { users_checked: people.length, messages_sent: sent, items_sent: items, failures, quota_remaining: remaining ?? null, note };
}

// ผู้ใช้เปิด/ปิดการรับแจ้งเตือนงานทั่วไปทาง LINE ของตนเอง (ไม่กระทบแจ้งเตือนงานซ่อม)
export async function lineFeedPreference(env, userId) {
  await ensureLineFeedSchema(env);
  const row = await env.DB.prepare("SELECT enabled FROM line_feed_users WHERE user_id=?").bind(userId).first();
  return row ? Boolean(row.enabled) : true;
}
export async function setLineFeedPreference(env, userId, enabled) {
  await ensureLineFeedSchema(env);
  await env.DB.prepare(`INSERT INTO line_feed_users(user_id,enabled) VALUES(?,?)
    ON CONFLICT(user_id) DO UPDATE SET enabled=excluded.enabled`).bind(userId, enabled ? 1 : 0).run();
}
