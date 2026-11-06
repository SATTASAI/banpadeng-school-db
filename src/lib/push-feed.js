// แจ้งเตือนบนมือถือผ่าน Web Push (ระบบแจ้งเตือนกลาง school-notify — notify.banpadengschool.ac.th)
// ส่งทุกรายการในกระดิ่ง (src/routes/notifications.js) ให้ผู้ที่เปิดรับไว้ รวมเป็นแจ้งเตือนเดียวต่อคนต่อรอบ
// ทำงานคู่กับ LINE (line-feed.js) — LINE ส่งตามเดิม ไม่เปลี่ยน
// ช่วงทดลอง: ส่งเฉพาะบทบาทใน PUSH_PILOT_ROLES (ค่าเริ่มต้น superadmin; ใส่ all = ทุกคน)
// Secret ที่ต้องตั้ง: NOTIFY_API_KEY (ค่าเดียวกับ API_KEY ของ school-notify)
import { unreadNotificationsFor } from "../routes/notifications.js";
import { createLeaveAccessUrl } from "./leave-access.js";
import { leaveApprover } from "./line-feed.js";

const DEFAULT_NOTIFY_ORIGIN = "https://notify.banpadengschool.ac.th";
const DEFAULT_ORIGIN = "https://system.banpadengschool.ac.th";
const LOCK_SECONDS = 10;
const MAX_AGE_HOURS = 72;
const MAX_LINES = 5;
const LINK_DAYS = 7;
const EVENT_BUDGET_MS = 20000;
const CRON_BUDGET_MS = 60000;
const ready = new WeakSet();

const notifyOrigin = (env) => (env.NOTIFY_ORIGIN || DEFAULT_NOTIFY_ORIGIN).replace(/\/$/, "");
const age = (value) => {
  const text = String(value || "");
  const time = Date.parse(/[zZ]|[+-]\d\d:?\d\d$/.test(text) ? text : text.replace(" ", "T") + "Z");
  return Number.isFinite(time) ? (Date.now() - time) / 3600000 : 0;
};
const trim = (text, max) => { const v = String(text || "").replace(/\s+/g, " ").trim(); return v.length > max ? v.slice(0, max - 1) + "…" : v; };
const b64u = (bytes) => { let s = ""; for (const b of new Uint8Array(bytes)) s += String.fromCharCode(b); return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""); };

const actionLabel = (key) => { const k = String(key || ""); return k.startsWith("leave:") ? "เปิดใบลา" : k.startsWith("maintenance") ? "เปิดงานแจ้งซ่อม" : k.startsWith("supervision") ? "เปิดงานนิเทศ" : "เปิดหน้างาน"; };

export function pushAllowed(env, user) {
  if (!env.NOTIFY_API_KEY || !user?.role) return false;
  const roles = String(env.PUSH_PILOT_ROLES || "superadmin").split(",").map((s) => s.trim()).filter(Boolean);
  return roles.includes("all") || roles.includes(user.role);
}

async function ensureSchema(env) {
  if (ready.has(env.DB)) return;
  await env.DB.batch([
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS push_feed_sent (user_id INTEGER NOT NULL, message_key TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'sent', created_at TEXT NOT NULL DEFAULT (datetime('now')), PRIMARY KEY (user_id, message_key))`),
    env.DB.prepare("CREATE TABLE IF NOT EXISTS push_feed_users (user_id INTEGER PRIMARY KEY, started_at TEXT NOT NULL DEFAULT (datetime('now')))"),
    env.DB.prepare("CREATE TABLE IF NOT EXISTS push_feed_state (id INTEGER PRIMARY KEY CHECK (id = 1), started_at TEXT NOT NULL)"),
    env.DB.prepare("INSERT OR IGNORE INTO push_feed_state (id, started_at) VALUES (1, '2000-01-01 00:00:00')"),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS push_feed_messages (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, message_key TEXT NOT NULL,
      title TEXT NOT NULL, message TEXT, url TEXT, details TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')), UNIQUE (user_id, message_key))`),
    env.DB.prepare("CREATE INDEX IF NOT EXISTS idx_push_feed_messages_user ON push_feed_messages (user_id, id)"),
  ]);
  ready.add(env.DB);
}

function notifyFetch(env, path, init = {}) {
  return fetch(notifyOrigin(env) + path, {
    ...init,
    headers: { authorization: `Bearer ${env.NOTIFY_API_KEY}`, "content-type": "application/json" },
    signal: AbortSignal.timeout(10000),
  });
}

// ลายเซ็นผูกมือถือกับบัญชี (ลงชื่อด้วย NOTIFY_API_KEY) — school-notify ตรวจลายเซ็นก่อนผูก ref u:<id>
async function signLink(env, user, days = LINK_DAYS) {
  const payload = { ref: `u:${user.id}`, role: "teacher", label: trim(user.full_name || user.email || `ผู้ใช้ ${user.id}`, 80), exp: Date.now() + days * 86400000 };
  const body = b64u(new TextEncoder().encode(JSON.stringify(payload)));
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(env.NOTIFY_API_KEY), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return `${body}.${b64u(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body)))}`;
}
export async function createPushLink(env, user) {
  return `${notifyOrigin(env)}/?t=${await signLink(env, user)}`;
}

let publicKeyCache = null;
async function vapidPublicKey(env) {
  if (publicKeyCache) return publicKeyCache;
  const res = await notifyFetch(env, "/api/vapid-public-key");
  if (!res.ok) throw new Error(`notify ${res.status}`);
  publicKeyCache = (await res.json()).publicKey;
  return publicKeyCache;
}

export async function pushLinkStatus(env, user) {
  if (!pushAllowed(env, user)) return { allowed: false };
  let linked = null, publicKey = null;
  try {
    const [res, key] = await Promise.all([notifyFetch(env, "/api/refs?prefix=" + encodeURIComponent(`u:${user.id}`)), vapidPublicKey(env)]);
    if (res.ok) linked = ((await res.json()).refs || []).includes(`u:${user.id}`);
    publicKey = key;
  } catch { /* ระบบแจ้งเตือนไม่ตอบ: แสดงว่าไม่ทราบสถานะ */ }
  return { allowed: true, linked, publicKey, url: await createPushLink(env, user) };
}

// กดปุ่มเดียวในระบบ: เบราว์เซอร์สมัคร push แล้วส่ง subscription มาที่นี่ ระบบส่งต่อให้ school-notify พร้อมลายเซ็น
const validSubscription = (s) => s && typeof s.endpoint === "string" && /^https:\/\//.test(s.endpoint) && s.endpoint.length < 1000
  && typeof s.keys?.p256dh === "string" && typeof s.keys?.auth === "string";
async function forward(env, path, body) {
  const res = await notifyFetch(env, path, { method: "POST", body: JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  return { status: res.ok ? 200 : res.status === 404 ? 404 : 502, data: res.ok ? data : { error: data.error || "ระบบแจ้งเตือนไม่ตอบสนอง ลองใหม่อีกครั้ง" } };
}
export async function handlePushRoute(request, env, user, action) {
  if (!pushAllowed(env, user)) return { status: 403, data: { error: "ยังไม่เปิดใช้แจ้งเตือนบนมือถือสำหรับบัญชีนี้" } };
  const body = await request.json().catch(() => null);
  if (action === "subscribe") {
    if (!validSubscription(body?.subscription)) return { status: 400, data: { error: "ข้อมูลการสมัครไม่ถูกต้อง" } };
    const { endpoint, keys } = body.subscription;
    return forward(env, "/api/subscribe", { subscription: { endpoint, keys: { p256dh: keys.p256dh, auth: keys.auth } }, roles: ["teacher"], token: await signLink(env, user, 1), exclusive: true,
      userAgent: (request.headers.get("user-agent") || "").slice(0, 200) });
  }
  if (typeof body?.endpoint !== "string") return { status: 400, data: { error: "ข้อมูลไม่ถูกต้อง" } };
  if (action === "unsubscribe") return forward(env, "/api/unsubscribe", { endpoint: body.endpoint });
  if (action === "test") return forward(env, "/api/test", { endpoint: body.endpoint });
  // เครื่องนี้ผูกกับบัญชีนี้อยู่จริงไหม (อาจถูกลบเพราะหมดอายุ หรือมีคนอื่นมาเปิดบนเครื่องเดียวกัน)
  if (action === "device") {
    const r = await forward(env, "/api/subscription", { endpoint: body.endpoint });
    if (r.status !== 200) return r;
    return { status: 200, data: { linked: Boolean(r.data.subscribed && (r.data.refs || []).includes(`u:${user.id}`)) } };
  }
  return { status: 404, data: { error: "ไม่พบ endpoint นี้" } };
}

async function acquire(env, trigger) {
  const wait = trigger === "cron" ? 1 : LOCK_SECONDS;
  const r = await env.DB.prepare(`UPDATE push_feed_state SET started_at = datetime('now') WHERE id = 1 AND started_at < datetime('now', ?)`)
    .bind(`-${wait} seconds`).run();
  return r.meta.changes === 1;
}

export async function dispatchPushNotifications(env, { trigger = "cron", origin = env.PUBLIC_BASE_URL || DEFAULT_ORIGIN } = {}) {
  if (!env.NOTIFY_API_KEY || !env.DB) return { skipped: "not_configured" };
  await ensureSchema(env);
  if (!await acquire(env, trigger)) return { skipped: "locked" };
  const deadline = Date.now() + (trigger === "cron" ? CRON_BUDGET_MS : EVENT_BUDGET_MS);
  // รายการที่จองไว้แต่รอบนั้นถูกตัดกลางคัน: ปล่อยให้ส่งใหม่
  await env.DB.prepare("DELETE FROM push_feed_sent WHERE status = 'pending' AND created_at < datetime('now', '-10 minutes')").run();
  await env.DB.prepare("DELETE FROM push_feed_messages WHERE created_at < datetime('now', '-90 days')").run();
  const stats = { people: 0, sent: 0, items: 0, failures: 0 };

  const res = await notifyFetch(env, "/api/refs?prefix=u:");
  if (!res.ok) return { skipped: `notify_${res.status}` };
  const ids = [...new Set(((await res.json()).refs || []).map((r) => Number(String(r).slice(2))).filter(Number.isInteger))];
  for (let i = 0; i < ids.length && Date.now() < deadline; i += 80) {
    const chunk = ids.slice(i, i + 80);
    const { results: users } = await env.DB.prepare(`SELECT id, role FROM users WHERE id IN (${chunk.map(() => "?").join(",")})`).bind(...chunk).all();
    for (const user of users) {
      if (Date.now() > deadline) break;
      if (!pushAllowed(env, user)) continue;
      stats.people++;
      try { await deliver(env, user, origin, stats); } catch (error) { stats.failures++; console.error("push feed", error); }
    }
  }
  return stats;
}

async function deliver(env, user, origin, stats) {
  let rows = await unreadNotificationsFor(env, { id: Number(user.id), role: user.role }, 50);
  rows = rows.filter((r) => Number(r.actor_id || 0) !== Number(user.id));

  // ครั้งแรกที่เปิดรับ: รายการค้างเดิมไม่ต้องส่ง (ไม่ให้แจ้งเตือนท่วม)
  const fresh = await env.DB.prepare("INSERT OR IGNORE INTO push_feed_users (user_id) VALUES (?)").bind(user.id).run();
  if (fresh.meta.changes) {
    if (rows.length) await env.DB.batch(rows.map((r) => env.DB.prepare("INSERT OR IGNORE INTO push_feed_sent (user_id, message_key, status) VALUES (?, ?, 'baseline')").bind(user.id, r.message_key)));
    return;
  }
  if (!rows.length) return;

  const keys = rows.map((r) => r.message_key);
  const { results: seen } = await env.DB.prepare(`SELECT message_key FROM push_feed_sent WHERE user_id = ? AND message_key IN (${keys.map(() => "?").join(",")})`)
    .bind(user.id, ...keys).all();
  const known = new Set(seen.map((r) => r.message_key));
  const candidates = rows.filter((r) => !known.has(r.message_key));
  if (!candidates.length) return;
  const old = candidates.filter((r) => age(r.created_at) > MAX_AGE_HOURS);
  if (old.length) await env.DB.batch(old.map((r) => env.DB.prepare("INSERT OR IGNORE INTO push_feed_sent (user_id, message_key, status) VALUES (?, ?, 'skipped')").bind(user.id, r.message_key)));
  const current = candidates.filter((r) => age(r.created_at) <= MAX_AGE_HOURS);
  if (!current.length) return;

  // จองก่อนส่ง กันสองรอบส่งซ้ำ
  const claims = await env.DB.batch(current.map((r) => env.DB.prepare("INSERT OR IGNORE INTO push_feed_sent (user_id, message_key, status) VALUES (?, ?, 'pending')").bind(user.id, r.message_key)));
  const mine = current.filter((_, i) => claims[i].meta.changes);
  if (!mine.length) return;

  let ok = false, permanent = false;
  try {
    const items = await Promise.all(mine.map(async (r) => {
      const leaveId = String(r.message_key).match(/^leave:(\d+):/)?.[1];
      let url = r.url || "/dashboard.html", details = null;
      if (leaveId) {
        details = await env.DB.prepare("SELECT reason, start_date, end_date, contact_phone, leave_days FROM leave_requests WHERE id = ?").bind(Number(leaveId)).first();
        url = /:forwarded$/.test(r.message_key) && await leaveApprover(env, Number(leaveId), Number(user.id))
          ? `/leave.html?request=${Number(leaveId)}`
          : (await createLeaveAccessUrl(env, r.message_key, Number(user.id))) || url;
      }
      const target = new URL(url, origin);
      return { ...r, details, path: target.origin === new URL(origin).origin ? target.pathname + target.search + target.hash : target.href };
    }));
    // เก็บข้อความไว้ให้หน้า "รายละเอียดแจ้งเตือน" (แบบ LINE OA) — กดแจ้งเตือนแล้วเห็นรายละเอียด + ปุ่มไปหน้างาน
    await env.DB.batch(items.map((r) => env.DB.prepare(`INSERT INTO push_feed_messages (user_id, message_key, title, message, url, details) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT (user_id, message_key) DO UPDATE SET title = excluded.title, message = excluded.message, url = excluded.url, details = excluded.details, created_at = datetime('now')`)
      .bind(user.id, r.message_key, trim(r.title, 200), String(r.message || "").slice(0, 2000), r.path, r.details ? JSON.stringify(r.details) : null)));
    const single = items.length === 1;
    const lines = items.slice(0, MAX_LINES).map((r) => `• ${trim(r.title, 60)}: ${trim(r.message, 80)}`);
    if (items.length > MAX_LINES) lines.push(`และอีก ${items.length - MAX_LINES} รายการ`);
    const leaveLine = (d) => d ? [d.start_date === d.end_date ? `วันที่ ${d.start_date}` : `${d.start_date} ถึง ${d.end_date}`, d.reason && `เหตุผล: ${trim(d.reason, 80)}`].filter(Boolean).join(" · ") : "";
    const res = await notifyFetch(env, "/api/notifications", {
      method: "POST",
      body: JSON.stringify({
        title: single ? trim(items[0].title, 120) : `แจ้งเตือนใหม่ ${items.length} รายการ`,
        body: single ? trim([items[0].message, leaveLine(items[0].details)].filter(Boolean).join("\n"), 500) : lines.join("\n"),
        url: new URL(single ? `/notification.html?key=${encodeURIComponent(items[0].message_key)}` : "/notification.html", origin).href,
        // ปุ่มบนแจ้งเตือน: ไปหน้างานนั้นโดยตรง (Android/คอมพิวเตอร์; iPhone แตะแล้วเปิดหน้ารายละเอียดที่มีปุ่มเดียวกัน)
        actions: single ? [{ title: actionLabel(items[0].message_key), url: new URL(items[0].path, origin).href }, { title: "ดูรายละเอียด", url: new URL(`/notification.html?key=${encodeURIComponent(items[0].message_key)}`, origin).href }]
          : [{ title: "ดูทั้งหมด", url: new URL("/notification.html", origin).href }],
        roles: ["all"],
        refs: [`u:${user.id}`],
        source: "system",
      }),
    });
    ok = res.ok;
    if (!ok && res.status >= 400 && res.status < 500 && res.status !== 429) permanent = true;
  } catch (error) {
    console.error("push send", error);
  }
  if (ok) {
    await env.DB.batch(mine.map((r) => env.DB.prepare("UPDATE push_feed_sent SET status = 'sent' WHERE user_id = ? AND message_key = ?").bind(user.id, r.message_key)));
    stats.sent++; stats.items += mine.length;
  } else if (permanent) {
    // ระบบแจ้งเตือนปฏิเสธข้อมูล (ไม่ใช่ปัญหาชั่วคราว): ไม่ลองซ้ำทุกรอบ
    await env.DB.batch(mine.map((r) => env.DB.prepare("UPDATE push_feed_sent SET status = 'failed' WHERE user_id = ? AND message_key = ?").bind(user.id, r.message_key)));
    stats.failures++;
  } else {
    // ส่งไม่สำเร็จ: ปล่อยรายการให้รอบถัดไปลองใหม่
    await env.DB.batch(mine.map((r) => env.DB.prepare("DELETE FROM push_feed_sent WHERE user_id = ? AND message_key = ? AND status = 'pending'").bind(user.id, r.message_key)));
    stats.failures++;
  }
}

// หน้าตรวจสอบการเชื่อมแจ้งเตือน (superadmin): ใครเชื่อมแล้วบ้าง กี่เครื่อง เครื่องอะไร ส่งถึงล่าสุดเมื่อไร
export async function pushSubscribersReport(env) {
  if (!env.NOTIFY_API_KEY) return { status: 503, data: { error: "ยังไม่ได้ตั้งค่า NOTIFY_API_KEY" } };
  const res = await notifyFetch(env, "/api/subscriptions?prefix=u:");
  if (!res.ok) return { status: 502, data: { error: "ระบบแจ้งเตือนไม่ตอบสนอง" } };
  const subs = (await res.json()).subscriptions || [];
  const byUser = new Map();
  for (const sub of subs) for (const ref of sub.refs) {
    const id = Number(String(ref).slice(2));
    if (!Number.isInteger(id)) continue;
    if (!byUser.has(id)) byUser.set(id, []);
    byUser.get(id).push({ device: sub.device, created_at: sub.created_at, last_ok_at: sub.last_ok_at, fail_count: sub.fail_count });
  }
  const { results: users } = await env.DB.prepare("SELECT id, full_name, email, role FROM users WHERE role IS NOT NULL AND role <> '' ORDER BY full_name").all();
  const rows = users.map((u) => ({ id: u.id, full_name: u.full_name, email: u.email, role: u.role, devices: byUser.get(Number(u.id)) || [] }));
  return { status: 200, data: { rows, linked: rows.filter((r) => r.devices.length).length, total: rows.length } };
}

export async function pushTestUser(env, userId) {
  if (!Number.isInteger(userId) || userId <= 0) return { status: 400, data: { error: "ข้อมูลไม่ถูกต้อง" } };
  return forward(env, "/api/notifications", {
    title: "ทดสอบการแจ้งเตือน", body: "ข้อความทดสอบจากผู้ดูแลระบบ โรงเรียนบ้านป่าเด็ง ✅", url: "/dashboard.html",
    roles: ["all"], refs: [`u:${userId}`], source: "system-test",
  });
}

// กล่องแจ้งเตือนของผู้ใช้ (หน้า notification.html)
export async function pushInbox(env, user, key) {
  await ensureSchema(env);
  const { results } = await env.DB.prepare("SELECT message_key, title, message, url, details, created_at FROM push_feed_messages WHERE user_id = ? ORDER BY id DESC LIMIT 50")
    .bind(user.id).all();
  let items = results;
  if (key && !items.some((r) => r.message_key === key)) {
    const one = await env.DB.prepare("SELECT message_key, title, message, url, details, created_at FROM push_feed_messages WHERE user_id = ? AND message_key = ?").bind(user.id, key).first();
    if (one) items = [one, ...items];
  }
  return items.map((r) => ({ ...r, details: r.details ? JSON.parse(r.details) : null }));
}
