// ส่งแจ้งเตือนทุกระบบทาง LINE รายบุคคล
// ใช้รายการเดียวกับกระดิ่งแจ้งเตือนในระบบ (src/routes/notifications.js) แล้วรวมเป็นข้อความเดียวต่อคนต่อรอบ
// ทำงานทุก 2 นาที (Cron) และหลังมีการบันทึกข้อมูลในระบบ (เว้นระยะอย่างน้อย LOCK_SECONDS)
// งานแจ้งซ่อมส่ง LINE ของตัวเองอยู่แล้ว และไม่อยู่ในรายการนี้ จึงไม่ซ้ำกัน
import { ensureLinePersonalSchema, linkedLineAccounts } from "./line-personal.js";
import { unreadNotificationsFor } from "../routes/notifications.js";
import { ensureLeaveData } from "./leave-data.js";
import { createLeaveAccessUrl } from "./leave-access.js";

const ready = new WeakSet();
const LOCK_SECONDS = 15;          // ระยะห่างขั้นต่ำระหว่างรอบ
const STALE_LOCK_MINUTES = 5;     // รอบที่ไม่จบ (เช่น ถูกตัด) ปล่อยล็อกหลังเวลานี้
const LINE_TIMEOUT_MS = 10000;    // LINE ตอบช้ากว่านี้ถือว่าล้มเหลว (ลองใหม่รอบถัดไปด้วย retry key เดิม)
const CONCURRENCY = 6;            // ประมวลผลผู้รับพร้อมกันกี่คน
// งานเบื้องหลังหลังตอบผู้ใช้มีเวลาจำกัด (~30 วินาที): รอบจากเหตุการณ์หยุดรับคนใหม่หลัง 20 วินาที ที่เหลือให้ Cron เก็บ
const EVENT_BUDGET_MS = 20000;
const CRON_BUDGET_MS = 10 * 60 * 1000;
const MAX_AGE_HOURS = 72; // ไม่ส่งรายการที่เก่ากว่านี้ (เช่น ตอนเพิ่งเชื่อม LINE)
const MAX_LINES = 5;
const DEFAULT_ORIGIN = "https://system.banpadengschool.ac.th";
export const DEFAULT_LEAVE_LINE_TEMPLATE = "• {title}\n  {message}\n  วันที่ลา: {leave_dates}\n  เหตุผลการลา: {reason}\n  เบอร์โทรศัพท์ครู: {phone}";
const LEAVE_FIELDS = new Set(["title", "message", "id", "link", "reason", "leave_dates", "phone"]);

export function validLeaveLineTemplate(value) {
  if (typeof value !== "string" || value.length > 400) return false;
  const fields = [...value.matchAll(/\{([^{}]*)\}/g)];
  return !/[{}]/.test(value.replace(/\{[^{}]*\}/g, "")) && fields.every(([, field]) => LEAVE_FIELDS.has(field));
}

export async function ensureLineFeedSchema(env) {
  if (ready.has(env.DB)) return;
  await env.DB.batch([
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS line_feed_users (
      user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      enabled INTEGER NOT NULL DEFAULT 1, baseline_at TEXT NOT NULL DEFAULT (datetime('now')))`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS line_feed_sent (
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, message_key TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('baseline','pending','sent','failed','skipped')),
      error TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')), PRIMARY KEY(user_id, message_key))`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS line_feed_runs (
      id INTEGER PRIMARY KEY CHECK (id = 1), started_at TEXT, finished_at TEXT, trigger TEXT,
      users_checked INTEGER, messages_sent INTEGER, items_sent INTEGER, failures INTEGER, quota_remaining INTEGER, note TEXT)`),
    env.DB.prepare("CREATE INDEX IF NOT EXISTS idx_line_feed_sent_created ON line_feed_sent(created_at)"),
  ]);
  const {results:columns}=await env.DB.prepare('PRAGMA table_info(line_feed_sent)').all();
  if(!columns.some(c=>c.name==='updated_at')){
    try{await env.DB.prepare('ALTER TABLE line_feed_sent ADD COLUMN updated_at TEXT').run();}
    catch(error){if(!/duplicate column/i.test(String(error?.message)))throw error;}
  }
  ready.add(env.DB);
}

const age = (value) => {
  const text = String(value || "");
  const time = Date.parse(/[zZ]|[+-]\d\d:?\d\d$/.test(text) ? text : text.replace(" ", "T") + "Z");
  return Number.isFinite(time) ? (Date.now() - time) / 3600000 : 0;
};
const trim = (text, max) => { const value = String(text || "").replace(/\s+/g, " ").trim(); return value.length > max ? value.slice(0, max - 1) + "…" : value; };

function leaveDate(value) {
  const match=String(value||'').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  return match?`${Number(match[3])}/${Number(match[2])}/${Number(match[1])+543}`:'—';
}

export function buildLineDigest(items, origin = DEFAULT_ORIGIN, leaveTemplate = DEFAULT_LEAVE_LINE_TEMPLATE) {
  const base = String(origin || DEFAULT_ORIGIN).replace(/\/$/, "");
  const lines = items.slice(0, MAX_LINES).map((item) => {
    if (!String(item.message_key || "").startsWith("leave:")) return `• ${trim(item.title, 80)}\n  ${trim(item.message, 160)}`;
    const fields={title:trim(item.title,80),message:trim(item.message,160),id:String(item.message_key).split(":")[1],link:base+(item.url||"/leave.html"),reason:trim(item.reason,300)||"—",phone:trim(item.contact_phone,100)||"—",
      leave_dates:item.start_date===item.end_date?leaveDate(item.start_date):`${leaveDate(item.start_date)} ถึง ${leaveDate(item.end_date)}`};
    const rendered=(leaveTemplate || DEFAULT_LEAVE_LINE_TEMPLATE).replace(/\{(title|message|id|link|reason|leave_dates|phone)\}/g,(_,key)=>fields[key]);
    const body=rendered.length>750?rendered.slice(0,749)+"…":rendered;
    return items.length>1&&!body.includes(fields.link)?`${body}\n  เปิดใบลา: ${fields.link}`:body;
  });
  const more = items.length > MAX_LINES ? `\n…และอีก ${items.length - MAX_LINES} รายการ` : "";
  const link = items.length === 1 ? base + (items[0].url || "/dashboard.html") : base + "/dashboard.html";
  const head = items.length === 1 ? "🔔 แจ้งเตือนจากระบบโรงเรียนบ้านป่าเด็ง" : `🔔 มีแจ้งเตือนใหม่ ${items.length} รายการ`;
  return `${head}\n\n${lines.join("\n\n")}${more}\n\nเปิดดู: ${link}`;
}

async function lineJson(env, path) {
  try {
    const response = await fetch(`https://api.line.me${path}`, { headers: { Authorization: `Bearer ${env.LINE_CHANNEL_ACCESS_TOKEN}` }, signal: AbortSignal.timeout(LINE_TIMEOUT_MS) });
    return response.ok ? await response.json() : null;
  } catch { return null; }
}

async function quotaRemaining(env) {
  const [quota, usage] = await Promise.all([lineJson(env, "/v2/bot/message/quota"), lineJson(env, "/v2/bot/message/quota/consumption")]);
  if (quota?.type !== "limited" || !Number.isFinite(Number(quota?.value)) || !Number.isFinite(Number(usage?.totalUsage))) return null;
  return Math.max(0, Number(quota.value) - Number(usage.totalUsage));
}

// retry key คงที่ต่อ (ผู้รับ + ชุดรายการ): ถ้า LINE รับไปแล้วแต่คำตอบหาย การลองใหม่จะไม่ส่งซ้ำ (LINE ตอบ 409)
export async function retryKeyFor(to, keys) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${to}|${[...keys].sort().join(",")}`));
  const h = [...new Uint8Array(digest).slice(0, 16)].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-${((parseInt(h[16], 16) & 3) | 8).toString(16)}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}
// คืน { ok, permanent, error } — 4xx (ยกเว้น 429) ส่งซ้ำก็ไม่สำเร็จ จึงไม่ลองใหม่
export function classifyPushFailure(status, body = "") {
  if (status === 409) return { ok: true }; // retry key นี้ LINE รับไปแล้ว
  const permanent = status >= 400 && status < 500 && status !== 429;
  return { ok: false, permanent, error: `LINE ${status}: ${String(body).slice(0, 200)}` };
}
async function push(env, to, text, retryKey) {
  let response;
  try {
    response = await fetch("https://api.line.me/v2/bot/message/push", {
      method: "POST",
      headers: { Authorization: `Bearer ${env.LINE_CHANNEL_ACCESS_TOKEN}`, "Content-Type": "application/json", ...(retryKey ? { "X-Line-Retry-Key": retryKey } : {}) },
      body: JSON.stringify({ to, messages: [{ type: "text", text }] }),
      signal: AbortSignal.timeout(LINE_TIMEOUT_MS),
    });
  } catch (error) {
    return { ok: false, permanent: false, error: error?.name === "TimeoutError" ? "LINE ไม่ตอบภายใน 10 วินาที" : String(error?.message || error).slice(0, 200) };
  }
  if (response.ok) return { ok: true };
  return classifyPushFailure(response.status, await response.text().catch(() => ""));
}

// ล็อกถือไว้จนรอบจบ (finished_at) — กันรอบใหม่ทับรอบที่ยังทำงานอยู่; รอบที่ค้าง/ถูกตัดปล่อยหลัง STALE_LOCK_MINUTES
async function acquire(env, trigger) {
  await env.DB.prepare("INSERT OR IGNORE INTO line_feed_runs(id) VALUES(1)").run();
  const result = await env.DB.prepare(`UPDATE line_feed_runs SET started_at=datetime('now'),finished_at=NULL,trigger=?
    WHERE id=1 AND (started_at IS NULL
      OR (finished_at IS NOT NULL AND finished_at>=started_at AND started_at<datetime('now',?))
      OR started_at<datetime('now',?))`).bind(trigger, `-${LOCK_SECONDS} seconds`, `-${STALE_LOCK_MINUTES} minutes`).run();
  return Boolean(result.meta.changes);
}

// ล้างข้อมูลเก่าของระบบ LINE (เรียกจากรอบ Cron)
async function cleanup(env) {
  const tables = new Set((await env.DB.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('line_webhook_events','leave_line_access','line_link_failures')").all()).results.map((r) => r.name));
  const statements = [env.DB.prepare("DELETE FROM line_feed_sent WHERE created_at<datetime('now','-90 days')")];
  if (tables.has("line_webhook_events")) statements.push(env.DB.prepare("DELETE FROM line_webhook_events WHERE received_at<datetime('now','-30 days')"));
  if (tables.has("leave_line_access")) statements.push(env.DB.prepare("DELETE FROM leave_line_access WHERE expires_at<datetime('now','-1 day')"));
  if (tables.has("line_link_failures")) statements.push(env.DB.prepare("DELETE FROM line_link_failures WHERE created_at<datetime('now','-1 day')"));
  await env.DB.batch(statements);
}

export async function dispatchLineNotifications(env, { trigger = "cron", origin = env.PUBLIC_BASE_URL || DEFAULT_ORIGIN, budgetMs } = {}) {
  if (!env.LINE_CHANNEL_ACCESS_TOKEN || !env.DB) return { skipped: "not_configured" };
  await ensureLinePersonalSchema(env);
  await ensureLineFeedSchema(env);
  if (!await acquire(env, trigger)) return { skipped: "locked" };
  const deadline = Date.now() + (budgetMs ?? (trigger === "cron" ? CRON_BUDGET_MS : EVENT_BUDGET_MS));
  const stats = { people: 0, sent: 0, items: 0, failures: 0, quotaBlocked: 0, deferred: 0, remaining: undefined };
  const reserve = Number.isFinite(Number(env.LINE_FEED_RESERVE)) ? Number(env.LINE_FEED_RESERVE) : 20;
  try {
    await ensureLeaveData(env);
    const leaveSetting=await env.DB.prepare('SELECT line_template FROM leave_settings WHERE id=1').first();
    const leaveTemplate=leaveSetting?.line_template||DEFAULT_LEAVE_LINE_TEMPLATE;
    const people=await linkedLineAccounts(env);
    stats.people = people.length;
    const {results:preferences}=await env.DB.prepare('SELECT user_id,enabled FROM line_feed_users').all();
    const enabled=new Map(preferences.map(r=>[Number(r.user_id),Number(r.enabled)]));
    let quotaPromise;
    const quota = () => (quotaPromise ||= quotaRemaining(env).then((value) => { stats.remaining = value; return value; }));
    const context = { env, origin, leaveTemplate, enabled, reserve, quota, stats };
    // หลายบัญชีของบุคลากรคนเดียวอาจใช้ LINE ID เดียวกัน: ประมวลผลกลุ่มเดียวกันตามลำดับ (ส่งครั้งเดียว) กลุ่มต่างกันทำพร้อมกัน
    const groups = [...people.reduce((map, person) => map.set(person.line_user_id, [...(map.get(person.line_user_id) || []), person]), new Map()).values()];
    let next = 0;
    const worker = async () => {
      while (next < groups.length) {
        if (Date.now() > deadline) { stats.deferred += groups.length - next; next = groups.length; return; }
        const group = groups[next++], delivered = new Set();
        for (const person of group) {
          try { await deliverToPerson(context, person, delivered); }
          catch { stats.failures++; }
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, groups.length) }, worker));
    if (trigger === "cron") await cleanup(env).catch(() => {});
  } finally {
    stats.notes = [];
    const notes = stats.notes;
    if (stats.quotaBlocked) notes.push(`โควตา LINE ใกล้หมด ข้ามการส่ง ${stats.quotaBlocked} คน (เก็บสำรองไว้ ${reserve} ข้อความ)`);
    if (stats.deferred) notes.push(`หมดเวลารอบนี้ เลื่อน ${stats.deferred} คนไปรอบ Cron ถัดไป`);
    await env.DB.prepare(`UPDATE line_feed_runs SET finished_at=datetime('now'),users_checked=?,messages_sent=?,items_sent=?,failures=?,quota_remaining=?,note=? WHERE id=1`)
      .bind(stats.people, stats.sent, stats.items, stats.failures, stats.remaining ?? null, notes.join(" · ") || null).run().catch(() => {});
  }
  return { users_checked: stats.people, messages_sent: stats.sent, items_sent: stats.items, failures: stats.failures, quota_remaining: stats.remaining ?? null, deferred: stats.deferred, note: stats.notes.join(" · ") || null };
}

async function deliverToPerson({ env, origin, leaveTemplate, enabled, reserve, quota, stats }, person, delivered) {
  if (enabled.get(Number(person.user_id))===0 || enabled.get(Number(person.link_owner_user_id))===0) return;
  let rows;
  try { rows = await unreadNotificationsFor(env, { id: Number(person.user_id), role: person.role }, 50, {forLine:true}); }
  catch { stats.failures++; return; }
  // A deputy's early leave notice is read-only, but still needs a LINE message.
  // (เช่น คิวการเงินที่ผู้บริหารเห็นในระบบ หรือใบลาทั้งหมดที่ผู้ดูแลระบบเห็น) — ยังเห็นที่กระดิ่งในระบบตามเดิม
  rows = rows.filter((r) => Number(r.line_ok ?? 1) === 1 && Number(r.actor_id || 0) !== Number(person.user_id));
  // First run: baseline the old queue. Leaves created after the LINE link must
  // still be delivered, even when the first cron run occurs after submission.
  const fresh = await env.DB.prepare("INSERT OR IGNORE INTO line_feed_users(user_id) VALUES(?)").bind(person.user_id).run();
  if (fresh.meta.changes) {
    const old=rows.filter(r=>!r.message_key.startsWith('leave:')||String(r.created_at)<String(person.linked_at));
    if(old.length) await env.DB.batch(old.map(row=>env.DB.prepare("INSERT OR IGNORE INTO line_feed_sent(user_id,message_key,status) VALUES(?,?,'baseline')").bind(person.user_id,row.message_key)));
  }
  if (!rows.length) return;
  const keys = rows.map((r) => r.message_key);
  const { results: seen } = await env.DB.prepare(`SELECT message_key,status,updated_at,created_at FROM line_feed_sent WHERE user_id=? AND message_key IN (${keys.map(() => "?").join(",")})`).bind(person.user_id, ...keys).all();
  const known = new Map(seen.map(r=>[r.message_key,r]));
  const candidates = rows.filter(r=>{
    const state=known.get(r.message_key);
    if(!state)return true;
    if(!['failed','pending'].includes(state.status))return false;
    const elapsed=age(state.updated_at||state.created_at);
    return elapsed >= (state.status==='pending'?5/60:1/60);
  });
  if (!candidates.length) return;
  const old = candidates.filter((r) => age(r.created_at) > MAX_AGE_HOURS), current = candidates.filter((r) => age(r.created_at) <= MAX_AGE_HOURS);
  if (old.length) await env.DB.batch(old.map((r) => env.DB.prepare("INSERT OR IGNORE INTO line_feed_sent(user_id,message_key,status) VALUES(?,?,'skipped')").bind(person.user_id, r.message_key)));
  if (!current.length) return;
  // Two school logins for one person may both see the same item. Record it
  // against each login, but send only one copy to their shared LINE account.
  const duplicates=current.filter(r=>delivered.has(r.message_key));
  if(duplicates.length)await env.DB.batch(duplicates.map(r=>env.DB.prepare(`INSERT INTO line_feed_sent(user_id,message_key,status) VALUES(?,?,'sent')
    ON CONFLICT(user_id,message_key) DO UPDATE SET status='sent',error=NULL,updated_at=datetime('now')`).bind(person.user_id,r.message_key)));
  const outstanding=current.filter(r=>!delivered.has(r.message_key));
  if(!outstanding.length)return;
  const remaining = await quota();
  if (remaining !== null && stats.remaining <= reserve) { stats.quotaBlocked++; return; }
  // จองรายการก่อนส่ง เพื่อไม่ให้สองรอบที่ทำงานซ้อนกันส่งซ้ำ
  const claims = await env.DB.batch(outstanding.map(r=>known.has(r.message_key)
    ? env.DB.prepare(`UPDATE line_feed_sent SET status='pending',updated_at=datetime('now'),error=NULL
      WHERE user_id=? AND message_key=? AND status=? AND COALESCE(updated_at,created_at)<datetime('now',?)`)
      .bind(person.user_id,r.message_key,known.get(r.message_key).status,known.get(r.message_key).status==='pending'?'-5 minutes':'-1 minute')
    : env.DB.prepare("INSERT OR IGNORE INTO line_feed_sent(user_id,message_key,status) VALUES(?,?,'pending')").bind(person.user_id,r.message_key)));
  const mine = outstanding.filter((_, index) => claims[index].meta.changes);
  if (!mine.length) return;
  const update = (status, error = null) => env.DB.batch(mine.map((r) => env.DB.prepare("UPDATE line_feed_sent SET status=?,error=?,updated_at=datetime('now') WHERE user_id=? AND message_key=? AND status='pending'").bind(status, error, person.user_id, r.message_key)));
  let result;
  try {
    const linked=await Promise.all(mine.map(async r=>{
      const leaveId=String(r.message_key).match(/^leave:(\d+):/)?.[1];
      const details=leaveId?await env.DB.prepare('SELECT reason,start_date,end_date,contact_phone FROM leave_requests WHERE id=?').bind(Number(leaveId)).first():null;
      return {...r,...details,url:await createLeaveAccessUrl(env,r.message_key,Number(person.user_id))||r.url};
    }));
    result = await push(env, person.line_user_id, buildLineDigest(linked, origin, leaveTemplate), await retryKeyFor(person.line_user_id, mine.map((r) => r.message_key)));
  } catch (error) {
    result = { ok: false, permanent: false, error: String(error?.message || error).slice(0, 300) };
  }
  if (result.ok) {
    await update("sent"); stats.sent++; stats.items += mine.length;
    for(const row of mine)delivered.add(row.message_key);
    if (stats.remaining !== null && stats.remaining !== undefined) stats.remaining--;
  } else {
    // ล้มเหลวถาวร (เช่น ปลายทางไม่ถูกต้อง) ไม่ลองซ้ำ — ชั่วคราว (หมดเวลา/LINE ขัดข้อง/429) ลองใหม่รอบถัดไป
    stats.failures++; await update(result.permanent ? "skipped" : "failed", result.error);
  }
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
