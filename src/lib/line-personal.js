// การแจ้งเตือน LINE รายบุคคล
// ผู้ใช้กด "เชื่อมต่อ LINE" ในหน้าบัญชี → ได้รหัสชั่วคราว → พิมพ์รหัสนั้นในแชต LINE OA ของโรงเรียน
// Webhook จับคู่รหัสกับ userId ของ LINE แล้วตอบกลับ (reply ไม่นับโควตา)
import { getCurrentUser, jsonResponse } from "./auth.js";
import { lineFeedPreference, setLineFeedPreference } from "./line-feed.js";
import { ensurePersonnelData } from "./personnel-data.js";

const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
const CODE_LENGTH = 6;
const CODE_TTL_MINUTES = 15;
const MAX_FAILED_ATTEMPTS_PER_HOUR = 5;
export const LINK_CODE_PATTERN = /^\s*BPD-?([A-Z0-9]{6})\s*$/i;

const ready = new WeakSet();
let cachedBotInfo = null;

export async function ensureLinePersonalSchema(env) {
  if (ready.has(env.DB)) return;
  await env.DB.batch([
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS line_user_links (
      user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      line_user_id TEXT NOT NULL UNIQUE,
      display_name TEXT,
      status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','blocked')),
      linked_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')))`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS line_link_codes (
      user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      code_hash TEXT NOT NULL UNIQUE,
      expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')))`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS line_link_failures (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      line_user_id TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')))`),
    env.DB.prepare("CREATE INDEX IF NOT EXISTS idx_line_link_failures_user ON line_link_failures(line_user_id, created_at)"),
  ]);
  ready.add(env.DB);
}

async function sha256Hex(text) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(String(text)));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function generateLinkCode(randomBytes = crypto.getRandomValues(new Uint8Array(CODE_LENGTH))) {
  let code = "";
  for (const byte of randomBytes) code += CODE_ALPHABET[byte % CODE_ALPHABET.length];
  return code;
}

function normalizeCode(text) {
  const match = String(text || "").match(LINK_CODE_PATTERN);
  return match ? match[1].toUpperCase() : null;
}

async function lineFetch(env, path, init = {}) {
  if (!env.LINE_CHANNEL_ACCESS_TOKEN) return null;
  return fetch(`https://api.line.me${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${env.LINE_CHANNEL_ACCESS_TOKEN}`, "Content-Type": "application/json", ...(init.headers || {}) },
  });
}

async function getBotInfo(env) {
  if (cachedBotInfo) return cachedBotInfo;
  try {
    const response = await lineFetch(env, "/v2/bot/info");
    if (!response?.ok) return null;
    const data = await response.json();
    cachedBotInfo = { basic_id: data.basicId || null, display_name: data.displayName || null };
    return cachedBotInfo;
  } catch {
    return null;
  }
}

function addFriendUrl(basicId) {
  return basicId ? `https://line.me/R/ti/p/${encodeURIComponent(basicId)}` : null;
}

async function replyText(env, replyToken, text) {
  if (!replyToken || !env.LINE_CHANNEL_ACCESS_TOKEN) return;
  try {
    await lineFetch(env, "/v2/bot/message/reply", {
      method: "POST",
      body: JSON.stringify({ replyToken, messages: [{ type: "text", text }] }),
    });
  } catch {
    // การตอบกลับล้มเหลวไม่กระทบการเชื่อมบัญชี
  }
}

async function fetchProfileName(env, lineUserId) {
  try {
    const response = await lineFetch(env, `/v2/bot/profile/${encodeURIComponent(lineUserId)}`);
    if (!response?.ok) return null;
    const data = await response.json();
    return String(data.displayName || "").slice(0, 160) || null;
  } catch {
    return null;
  }
}

// รับเหตุการณ์ Webhook จากแชต 1:1 — คืนค่า true เมื่อจัดการแล้ว
export async function handleLinePersonalEvent(env, event) {
  const lineUserId = event?.source?.type === "user" ? String(event.source.userId || "") : "";
  if (!lineUserId) return false;
  await ensureLinePersonalSchema(env);

  if (event.type === "unfollow") {
    await env.DB.prepare("UPDATE line_user_links SET status='blocked',updated_at=datetime('now') WHERE line_user_id=?").bind(lineUserId).run();
    return true;
  }
  if (event.type === "follow") {
    await env.DB.prepare("UPDATE line_user_links SET status='active',updated_at=datetime('now') WHERE line_user_id=?").bind(lineUserId).run();
    return false;
  }
  if (event.type !== "message" || event.message?.type !== "text") return false;
  const code = normalizeCode(event.message.text);
  if (!code) return false;

  const failures = await env.DB.prepare(`SELECT COUNT(*) AS n FROM line_link_failures
    WHERE line_user_id=? AND datetime(created_at)>=datetime('now','-1 hour')`).bind(lineUserId).first();
  if (Number(failures?.n || 0) >= MAX_FAILED_ATTEMPTS_PER_HOUR) {
    await replyText(env, event.replyToken, "ใส่รหัสผิดหลายครั้งเกินไป กรุณารอ 1 ชั่วโมงแล้วขอรหัสใหม่จากหน้าบัญชีในระบบ");
    return true;
  }

  const codeHash = await sha256Hex(code);
  const pending = await env.DB.prepare(`SELECT c.user_id,u.full_name FROM line_link_codes c JOIN users u ON u.id=c.user_id
    WHERE c.code_hash=? AND datetime(c.expires_at)>datetime('now') AND u.status='active'`).bind(codeHash).first();
  if (!pending) {
    await env.DB.prepare("INSERT INTO line_link_failures(line_user_id) VALUES (?)").bind(lineUserId).run();
    await replyText(env, event.replyToken, "ไม่พบรหัสนี้หรือรหัสหมดอายุแล้ว กรุณาขอรหัสใหม่จากเมนู บัญชีและความปลอดภัย → เชื่อมต่อ LINE");
    return true;
  }

  const existing = await env.DB.prepare(`SELECT l.user_id FROM line_user_links l JOIN users u ON u.id=l.user_id
    WHERE l.line_user_id=? AND l.user_id<>? AND u.status='active'`).bind(lineUserId, pending.user_id).first();
  if (existing) {
    await replyText(env, event.replyToken, "บัญชี LINE นี้เชื่อมกับผู้ใช้อื่นในระบบอยู่แล้ว กรุณายกเลิกการเชื่อมต่อจากบัญชีเดิมก่อน");
    return true;
  }

  const displayName = await fetchProfileName(env, lineUserId);
  await env.DB.batch([
    env.DB.prepare("DELETE FROM line_user_links WHERE line_user_id=? AND user_id<>?").bind(lineUserId, pending.user_id),
    env.DB.prepare(`INSERT INTO line_user_links(user_id,line_user_id,display_name,status) VALUES (?,?,?,'active')
      ON CONFLICT(user_id) DO UPDATE SET line_user_id=excluded.line_user_id,display_name=excluded.display_name,
        status='active',linked_at=datetime('now'),updated_at=datetime('now')`).bind(pending.user_id, lineUserId, displayName),
    env.DB.prepare("DELETE FROM line_link_codes WHERE user_id=?").bind(pending.user_id),
    env.DB.prepare("DELETE FROM line_link_failures WHERE line_user_id=?").bind(lineUserId),
  ]);
  await replyText(env, event.replyToken, `เชื่อมต่อสำเร็จ ✅\nบัญชีนี้จะได้รับการแจ้งเตือนของ ${pending.full_name} จากระบบโรงเรียนบ้านป่าเด็ง`);
  return true;
}

// คืน Map ของ user_id → { line_user_id, full_name } เฉพาะคนที่เชื่อมต่อและยังไม่บล็อก
export async function getLinkedLineUsers(env, userIds) {
  const ids = [...new Set((userIds || []).map(Number).filter((id) => Number.isInteger(id) && id > 0))];
  const map = new Map();
  if (!ids.length) return map;
  await ensureLinePersonalSchema(env);
  const { results } = await env.DB.prepare(`SELECT l.user_id,l.line_user_id,u.full_name FROM line_user_links l
    JOIN users u ON u.id=l.user_id WHERE l.status='active' AND u.status='active'
      AND l.user_id IN (${ids.map(() => "?").join(",")})`).bind(...ids).all();
  for (const row of results || []) map.set(Number(row.user_id), row);
  return map;
}

// A staff member can have more than one school login. The LINE match belongs to
// that person, so an executive login may use the link on their other login. Do
// not infer identity from display names or a group chat's last sender.
export async function linkedLineAccounts(env) {
  await ensureLinePersonalSchema(env);
  await ensurePersonnelData(env);
  const { results } = await env.DB.prepare(`WITH shared AS (
    SELECT a.user_id,MIN(l.line_user_id) line_user_id,MIN(l.linked_at) linked_at,MIN(l.user_id) owner_user_id
    FROM personnel_accounts a
    JOIN personnel_accounts other ON other.personnel_id=a.personnel_id
    JOIN line_user_links l ON l.user_id=other.user_id AND l.status='active'
    JOIN users owner ON owner.id=l.user_id AND owner.status='active' AND owner.deleted_at IS NULL
    JOIN personnel_records p ON p.id=a.personnel_id AND p.status='active'
    GROUP BY a.user_id HAVING COUNT(DISTINCT l.line_user_id)=1
  )
  SELECT u.id user_id,u.role,u.full_name,
    CASE WHEN direct.user_id IS NOT NULL THEN direct.line_user_id ELSE shared.line_user_id END line_user_id,
    CASE WHEN direct.user_id IS NOT NULL THEN direct.linked_at ELSE shared.linked_at END linked_at,
    CASE WHEN direct.user_id IS NOT NULL THEN direct.user_id ELSE shared.owner_user_id END link_owner_user_id
  FROM users u LEFT JOIN line_user_links direct ON direct.user_id=u.id
  LEFT JOIN shared ON shared.user_id=u.id
  WHERE u.status='active' AND u.role IS NOT NULL AND u.deleted_at IS NULL
    AND (direct.status='active' OR (direct.user_id IS NULL AND shared.line_user_id IS NOT NULL))
  ORDER BY u.id`).all();
  return results;
}

// ผู้รับรายบุคคลของงานซ่อมแต่ละเหตุการณ์ (ไม่ส่งหาคนที่เป็นผู้กดเอง)
export function maintenancePersonalRecipients(item, eventType, actorId = null) {
  if (!item) return [];
  const toAssignee = ["assigned", "verified"];
  const toReporter = ["in_progress", "waiting_parts", "completed", "cancelled"];
  const recipients = [];
  if (toAssignee.includes(eventType) && item.assigned_to) recipients.push({ user_id: Number(item.assigned_to), role: "assignee" });
  if (toReporter.includes(eventType) && item.reported_by) recipients.push({ user_id: Number(item.reported_by), role: "reporter" });
  const actor = Number(actorId || 0);
  return recipients.filter((recipient, index, list) =>
    recipient.user_id && recipient.user_id !== actor && list.findIndex((other) => other.user_id === recipient.user_id) === index);
}

export function maintenancePersonalHeadline(eventType, role) {
  if (role === "assignee") return eventType === "verified" ? "ผู้แจ้งตรวจรับงานที่คุณซ่อมแล้ว" : "คุณได้รับมอบหมายงานซ่อม";
  return {
    in_progress: "งานที่คุณแจ้งเริ่มซ่อมแล้ว",
    waiting_parts: "งานที่คุณแจ้งกำลังรออะไหล่",
    completed: "ซ่อมเสร็จแล้ว กรุณาตรวจรับ",
    cancelled: "งานที่คุณแจ้งถูกยกเลิก",
  }[eventType] || "อัปเดตงานที่คุณแจ้ง";
}

// ---------- API ----------
async function linkStatus(env, user) {
  const link = await env.DB.prepare("SELECT display_name,status,linked_at FROM line_user_links WHERE user_id=?").bind(user.id).first();
  const bot = await getBotInfo(env);
  return {
    configured: !!(env.LINE_CHANNEL_ACCESS_TOKEN && env.LINE_CHANNEL_SECRET),
    linked: !!link,
    blocked: link?.status === "blocked",
    display_name: link?.display_name || null,
    linked_at: link?.linked_at || null,
    notify_all: await lineFeedPreference(env, user.id),
    official_account: bot ? { basic_id: bot.basic_id, name: bot.display_name, add_friend_url: addFriendUrl(bot.basic_id) } : null,
  };
}

async function pushText(env, lineUserId, text) {
  try {
    const response = await lineFetch(env, "/v2/bot/message/push", {
      method: "POST",
      body: JSON.stringify({ to: lineUserId, messages: [{ type: "text", text }] }),
    });
    return !!response?.ok;
  } catch {
    return false;
  }
}

// แอดมินจับคู่บัญชี LINE ที่แอดเพื่อน OA แล้ว กับรายชื่อครูในระบบ
async function handleAdminMatch(request, env, pathname, method, user) {
  if (user.role !== "superadmin") return jsonResponse({ error: "เฉพาะผู้ดูแลระบบเท่านั้นที่จับคู่บัญชี LINE ได้" }, 403);
  if (pathname === "/api/line/match" && method === "GET") {
    const { results: accounts } = await env.DB.prepare(`SELECT t.id,t.display_name,t.last_seen_at,t.first_seen_at,t.last_event_type,
        l.user_id AS linked_user_id,u.full_name AS linked_user_name,l.status AS link_status
      FROM line_targets t
      LEFT JOIN line_user_links l ON l.line_user_id=t.target_id
      LEFT JOIN users u ON u.id=l.user_id
      WHERE t.target_type='user' AND t.status<>'disabled'
      ORDER BY CASE WHEN l.user_id IS NULL THEN 0 ELSE 1 END, t.last_seen_at DESC`).all();
    const { results: teachers } = await env.DB.prepare(`SELECT u.id,u.full_name,u.role,l.status AS link_status,l.display_name AS line_name
      FROM users u LEFT JOIN line_user_links l ON l.user_id=u.id
      WHERE u.status='active' AND u.role IS NOT NULL ORDER BY u.full_name`).all();
    return jsonResponse({ accounts: accounts || [], users: teachers || [] });
  }
  if (pathname === "/api/line/match" && method === "POST") {
    const body = await request.json().catch(() => null);
    const targetId = Number(body?.account_id || 0), userId = Number(body?.user_id || 0);
    if (!targetId || !userId) return jsonResponse({ error: "กรุณาเลือกบัญชี LINE และชื่อครู" }, 400);
    const account = await env.DB.prepare("SELECT target_id,display_name FROM line_targets WHERE id=? AND target_type='user'").bind(targetId).first();
    if (!account) return jsonResponse({ error: "ไม่พบบัญชี LINE ที่เลือก" }, 404);
    const teacher = await env.DB.prepare("SELECT id,full_name FROM users WHERE id=? AND status='active' AND role IS NOT NULL").bind(userId).first();
    if (!teacher) return jsonResponse({ error: "ไม่พบผู้ใช้ที่เลือก" }, 404);
    const taken = await env.DB.prepare(`SELECT u.full_name FROM line_user_links l JOIN users u ON u.id=l.user_id
      WHERE l.line_user_id=? AND l.user_id<>? AND u.status='active'`).bind(account.target_id, userId).first();
    if (taken) return jsonResponse({ error: `บัญชี LINE นี้จับคู่กับ ${taken.full_name} อยู่แล้ว กรุณายกเลิกก่อน` }, 409);
    await env.DB.batch([
      env.DB.prepare("DELETE FROM line_user_links WHERE line_user_id=? AND user_id<>?").bind(account.target_id, userId),
      env.DB.prepare(`INSERT INTO line_user_links(user_id,line_user_id,display_name,status) VALUES (?,?,?,'active')
        ON CONFLICT(user_id) DO UPDATE SET line_user_id=excluded.line_user_id,display_name=excluded.display_name,
          status='active',linked_at=datetime('now'),updated_at=datetime('now')`).bind(userId, account.target_id, account.display_name || null),
      env.DB.prepare("DELETE FROM line_link_codes WHERE user_id=?").bind(userId),
    ]);
    // แจ้งเจ้าของบัญชีเพื่อยืนยันว่าจับคู่ถูกคน (ใช้โควตา 1 ข้อความ)
    const notified = body?.notify === false ? false : await pushText(env, account.target_id,
      `บัญชี LINE นี้ถูกเชื่อมกับ "${teacher.full_name}" ในระบบโรงเรียนบ้านป่าเด็งแล้ว ✅\nหากไม่ใช่คุณ กรุณาแจ้งผู้ดูแลระบบ`);
    return jsonResponse({ ok: true, notified });
  }
  const unlinkMatch = pathname.match(/^\/api\/line\/match\/(\d+)$/);
  if (unlinkMatch && method === "DELETE") {
    await env.DB.prepare("DELETE FROM line_user_links WHERE user_id=?").bind(Number(unlinkMatch[1])).run();
    return jsonResponse({ ok: true });
  }
  return jsonResponse({ error: "Method not allowed" }, 405);
}

export async function handleLinePersonalRoute(request, env, pathname, method) {
  const isMatch = pathname === "/api/line/match" || /^\/api\/line\/match\/\d+$/.test(pathname);
  if (!isMatch && pathname !== "/api/line/link" && pathname !== "/api/line/link/code" && pathname !== "/api/line/linked-users") return null;
  const user = await getCurrentUser(request, env);
  if (!user || !user.role) return jsonResponse({ error: "กรุณาเข้าสู่ระบบ" }, 401);
  await ensureLinePersonalSchema(env);
  if (isMatch) return handleAdminMatch(request, env, pathname, method, user);

  if (pathname === "/api/line/link" && method === "GET") return jsonResponse(await linkStatus(env, user));

  if (pathname === "/api/line/link" && method === "PATCH") {
    const body = await request.json().catch(() => null);
    if (typeof body?.notify_all !== "boolean") return jsonResponse({ error: "รูปแบบข้อมูลไม่ถูกต้อง" }, 400);
    await setLineFeedPreference(env, user.id, body.notify_all);
    return jsonResponse({ ok: true, notify_all: body.notify_all });
  }

  if (pathname === "/api/line/link" && method === "DELETE") {
    await env.DB.batch([
      env.DB.prepare("DELETE FROM line_user_links WHERE user_id=?").bind(user.id),
      env.DB.prepare("DELETE FROM line_link_codes WHERE user_id=?").bind(user.id),
    ]);
    return jsonResponse({ ok: true });
  }

  if (pathname === "/api/line/link/code" && method === "POST") {
    if (!env.LINE_CHANNEL_ACCESS_TOKEN || !env.LINE_CHANNEL_SECRET) {
      return jsonResponse({ error: "ผู้ดูแลระบบยังไม่ได้ตั้งค่า LINE ของโรงเรียน" }, 409);
    }
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const code = generateLinkCode();
      try {
        await env.DB.prepare(`INSERT INTO line_link_codes(user_id,code_hash,expires_at) VALUES (?,?,datetime('now','+${CODE_TTL_MINUTES} minutes'))
          ON CONFLICT(user_id) DO UPDATE SET code_hash=excluded.code_hash,expires_at=excluded.expires_at,created_at=datetime('now')`)
          .bind(user.id, await sha256Hex(code)).run();
        const status = await linkStatus(env, user);
        return jsonResponse({ code: `BPD-${code}`, expires_in_minutes: CODE_TTL_MINUTES, official_account: status.official_account });
      } catch (error) {
        if (!String(error?.message || error).toLowerCase().includes("unique")) throw error;
      }
    }
    return jsonResponse({ error: "สร้างรหัสไม่สำเร็จ กรุณาลองอีกครั้ง" }, 500);
  }

  if (pathname === "/api/line/linked-users" && method === "GET") {
    if (user.role !== "superadmin") return jsonResponse({ error: "เฉพาะผู้ดูแลระบบ" }, 403);
    const { results } = await env.DB.prepare(`SELECT u.id,u.full_name,u.role,l.display_name,l.status,l.linked_at
      FROM line_user_links l JOIN users u ON u.id=l.user_id WHERE u.status='active' ORDER BY u.full_name`).all();
    const total = await env.DB.prepare("SELECT COUNT(*) AS n FROM users WHERE status='active' AND role IS NOT NULL").first();
    return jsonResponse({ users: results || [], active_user_count: Number(total?.n || 0) });
  }

  return jsonResponse({ error: "Method not allowed" }, 405);
}
