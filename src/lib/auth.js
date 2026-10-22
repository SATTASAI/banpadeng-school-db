import { AUTH_COOKIE_NAME, verifyJWT } from "./crypto.js";
import { sessionIsActive } from "./auth-sessions.js";
import { activeViewAs } from "./view-as.js";

export function parseCookies(request) {
  const header = request.headers.get("Cookie") || "";
  const cookies = {};
  header.split(";").forEach((part) => {
    const idx = part.indexOf("=");
    if (idx === -1) return;
    const key = part.slice(0, idx).trim();
    const val = part.slice(idx + 1).trim();
    if (key) cookies[key] = decodeURIComponent(val);
  });
  return cookies;
}

// คืนค่า user ปัจจุบันจากฐานข้อมูลจริง (ไม่ใช้แค่ข้อมูลใน token)
// เพื่อให้แน่ใจว่าถ้าแอดมินเปลี่ยนสิทธิ์/ระงับบัญชี จะมีผลทันทีในคำขอถัดไป
// ผู้ชมภายนอก (role viewer): ดูได้อย่างเดียว และหมดอายุตาม access_expires_at (วันที่ตามเวลาไทย ใช้ได้ถึงสิ้นวันนั้น)
export function viewerExpired(user, now = new Date()) {
  if (user?.role !== "viewer" || !user.access_expires_at) return false;
  const today = new Date(now.getTime() + 7 * 3600000).toISOString().slice(0, 10);
  return today > String(user.access_expires_at).slice(0, 10);
}
// บัญชีผู้ชมภายนอกเก็บในตาราง viewer_accounts (users.role = NULL เพราะ CHECK ของตาราง users รับเฉพาะ 4 บทบาทเดิม)
// ถ้าตารางหาย บัญชีจะกลายเป็น "รอกำหนดสิทธิ์" ซึ่งใช้งานไม่ได้เลย (ปลอดภัยกว่ากลายเป็นบทบาทอื่น)
export const VIEWER_COLUMNS = "EXISTS(SELECT 1 FROM viewer_accounts v WHERE v.user_id = users.id) AS is_viewer, (SELECT v.expires_at FROM viewer_accounts v WHERE v.user_id = users.id) AS access_expires_at";
const viewerTableReady = new WeakSet();
export async function ensureViewerTable(env) {
  if (!env?.DB || viewerTableReady.has(env.DB)) return;
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS viewer_accounts (
    user_id INTEGER PRIMARY KEY REFERENCES users(id), expires_at TEXT, created_by INTEGER REFERENCES users(id),
    created_at TEXT NOT NULL DEFAULT (datetime('now')))`).run();
  viewerTableReady.add(env.DB);
}
export function applyViewer(user) {
  if (!user) return user;
  if (Number(user.is_viewer) === 1) user.role = "viewer";
  else delete user.access_expires_at;
  delete user.is_viewer;
  return user;
}
// อ่านผู้ใช้ครั้งเดียวต่อคำขอ (ตัวกันสิทธิ์ผู้ชมและ handler ใช้ร่วมกัน)
const userCache = new WeakMap();
export function getCurrentUser(request, env) {
  if (!request || typeof request !== "object") return loadCurrentUser(request, env);
  if (!userCache.has(request)) userCache.set(request, loadCurrentUser(request, env).catch((e) => { userCache.delete(request); throw e; }));
  return userCache.get(request);
}
// อ่านแถวผู้ใช้: ลองคอลัมน์ครบก่อน แล้วค่อยลดลงทีละขั้น: ไม่มีตาราง viewer_accounts → ตัดเฉพาะคอลัมน์ผู้ชม (ยังตรวจ session_version)
// ไม่มีคอลัมน์ session_version (ฐานเดิมก่อน migration) → ใช้ชุดเล็กสุด
async function fetchUserRow(env, id) {
  const FULL = "SELECT id, email, full_name, role, status, session_version, password_changed_at, last_login_at, created_at";
  const attempts = [FULL + ", " + VIEWER_COLUMNS, FULL, "SELECT id, email, full_name, role, status, created_at"];
  for (let i = 0; i < attempts.length; i++) {
    try { return await env.DB.prepare(attempts[i] + " FROM users WHERE id = ?").bind(id).first(); }
    catch (error) {
      const message = String(error?.message || error).toLowerCase();
      const retry = (i === 0 && message.includes("viewer_accounts")) || message.includes("session_version") || message.includes("password_changed_at") || message.includes("last_login_at");
      if (!retry || i === attempts.length - 1) throw error;
    }
  }
  return null;
}

async function loadCurrentUser(request, env) {
  const cookies = parseCookies(request);
  const token = cookies[AUTH_COOKIE_NAME];
  if (!token) return null;

  const payload = await verifyJWT(token, env.JWT_SECRET);
  if (!payload || !payload.sub) return null;

  const user = await fetchUserRow(env, payload.sub);
  if (!user || user.status !== "active") return null;
  applyViewer(user);
  if (viewerExpired(user)) return null;
  if (user.session_version != null && Number(payload.sv || 1) !== Number(user.session_version)) return null;
  // ออกจากระบบรายอุปกรณ์: session ที่ถูกยกเลิกใช้ต่อไม่ได้
  if (!await sessionIsActive(env, payload)) return null;
  Object.defineProperty(user, "session_id", { value: payload.sid || null, enumerable: false });

  // โหมดมุมมองบุคคลอื่น: ผู้ดูแลระบบ (superadmin) ใช้ทดสอบว่าแต่ละบัญชีเห็นอะไร
  // คำขอทั้งหมดของ session นี้จะถูกตรวจสิทธิ์ในฐานะบัญชีเป้าหมาย (ดูได้อย่างเดียว — index.js บล็อกการบันทึก)
  // ตรวจว่ายังเป็น superadmin ทุกคำขอ ถ้าถูกลดสิทธิ์ โหมดนี้จะหยุดทันที
  if (user.role === "superadmin" && payload.sid) {
    const view = await activeViewAs(env, payload.sid, user.id);
    if (view && Number(view.target_user_id) !== Number(user.id)) {
      const target = await fetchUserRow(env, view.target_user_id);
      if (target && target.status === "active") {
        applyViewer(target);
        Object.defineProperty(target, "session_id", { value: payload.sid, enumerable: false });
        Object.defineProperty(target, "impersonator", { value: user, enumerable: false });
        Object.defineProperty(target, "view_as", { value: { started_at: view.started_at, expires_at: view.expires_at }, enumerable: false });
        return target;
      }
    }
  }
  return user;
}

// เคลียร์ผู้ใช้ที่อ่านไว้ของคำขอนี้ (หลังจบโหมดมุมมองบุคคลอื่นในคำขอเดียวกัน)
export function forgetCurrentUser(request) { if (request && typeof request === "object") userCache.delete(request); }

export function jsonResponse(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...extraHeaders },
  });
}

export const ADMIN_ROLES = ["superadmin", "executive"];

export function isAdmin(user) {
  return !!user && ADMIN_ROLES.includes(user.role);
}

// ---------- ผู้ชมภายนอก: อ่านได้เฉพาะ API ที่ไม่มีข้อมูลส่วนบุคคล ----------
const VIEWER_READ = [
  /^\/api\/auth\/me$/, /^\/api\/overview(\/revision)?$/, /^\/api\/notifications$/,
  /^\/api\/department-staff\/[a-z_]+$/, /^\/api\/department-staff\/[a-z_]+\/\d+\/photo$/,
  /^\/api\/departments\/[a-z_]+\/(projects|topics)$/,
  /^\/api\/academic-periods(\/[a-z-]+)?$/, /^\/api\/timetable\/(periods|entries|setup|structure)$/,
  /^\/api\/(supervision|evaluation|substitutes)\/permissions$/,
];
const VIEWER_WRITE = [/^\/api\/auth\/logout$/, /^\/api\/notifications\/read$/];
export function viewerMayAccess(method, pathname) {
  const m = String(method || "GET").toUpperCase();
  if (m === "GET" || m === "HEAD") return VIEWER_READ.some((r) => r.test(pathname));
  return VIEWER_WRITE.some((r) => r.test(pathname));
}
export const VIEWER_BLOCKED = { error: "บัญชีผู้ชมภายนอกดูได้อย่างเดียว ไม่สามารถใช้งานส่วนนี้ได้", code: "VIEWER_READ_ONLY" };
