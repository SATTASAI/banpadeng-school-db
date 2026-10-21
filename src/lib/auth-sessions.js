// ความปลอดภัยบัญชีที่ใช้ร่วมกันระหว่างระบบบริหารโรงเรียน (system) และระบบรายงานผลการเรียน (grades)
// ไฟล์นี้มีสำเนาเหมือนกันใน repo students-report (src/lib/auth-sessions.js) เพราะสองระบบใช้ D1 และตาราง users เดียวกัน
// แก้ไฟล์หนึ่งต้องแก้อีกไฟล์ให้ตรงกัน
//
// - auth_sessions: หนึ่งแถวต่อการเข้าสู่ระบบหนึ่งครั้ง (หนึ่งอุปกรณ์/เบราว์เซอร์) → ดูรายการและออกจากระบบรายอุปกรณ์ได้
// - security_notifications: แจ้งเตือนความปลอดภัย (อุปกรณ์ใหม่ ใส่รหัสผิดจนถูกพัก เปลี่ยนรหัสผ่าน เปลี่ยนสิทธิ์)
//   ระบบ system รวมเข้ากระดิ่งแจ้งเตือนและส่ง LINE รายบุคคลให้อัตโนมัติ
// - Cloudflare Turnstile: ตรวจว่าไม่ใช่บอทที่หน้าเข้าสู่ระบบ/สมัคร/ลืมรหัสผ่าน (บังคับเมื่อตั้ง TURNSTILE_SECRET_KEY แล้วเท่านั้น)

export const SESSION_TTL_DAYS = 7; // ตรงกับอายุ token ใน crypto.js
const TOUCH_INTERVAL_MINUTES = 5;
const NEW_DEVICE_LOOKBACK_DAYS = 180;
export const APP_LABELS = { system: 'ระบบบริหารโรงเรียน', grades: 'ระบบรายงานผลการเรียน' };

const ready = new WeakMap();
export function ensureSessionSchema(env) {
  if (ready.has(env.DB)) return ready.get(env.DB);
  const p = env.DB.batch([
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS auth_sessions (
      id TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id), app TEXT NOT NULL,
      device_hash TEXT NOT NULL, device_label TEXT, user_agent TEXT, ip_address TEXT, country TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')), last_seen_at TEXT NOT NULL DEFAULT (datetime('now')),
      revoked_at TEXT, revoked_reason TEXT)`),
    env.DB.prepare('CREATE INDEX IF NOT EXISTS idx_auth_sessions_user ON auth_sessions(user_id, created_at)'),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS security_notifications (
      id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL REFERENCES users(id), kind TEXT NOT NULL,
      message TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')), read_at TEXT)`),
    env.DB.prepare('CREATE INDEX IF NOT EXISTS idx_security_notifications_user ON security_notifications(user_id, created_at)'),
  ]).catch((e) => { ready.delete(env.DB); throw e; });
  ready.set(env.DB, p);
  return p;
}

// ---------- อุปกรณ์ ----------
export function describeDevice(userAgent) {
  const ua = String(userAgent || '');
  const browser = /Edg\//.test(ua) ? 'Edge' : /OPR\/|Opera/.test(ua) ? 'Opera' : /SamsungBrowser/.test(ua) ? 'Samsung Internet'
    : /Line\//.test(ua) ? 'LINE' : /FBAN|FBAV/.test(ua) ? 'Facebook' : /Firefox\//.test(ua) ? 'Firefox'
    : /CriOS|Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : 'เบราว์เซอร์อื่น';
  const os = /iPhone/.test(ua) ? 'iPhone' : /iPad/.test(ua) ? 'iPad' : /Android/.test(ua) ? 'Android'
    : /Windows/.test(ua) ? 'Windows' : /Mac OS X|Macintosh/.test(ua) ? 'Mac' : /CrOS/.test(ua) ? 'Chromebook'
    : /Linux/.test(ua) ? 'Linux' : 'อุปกรณ์อื่น';
  return { browser, os, label: `${browser} บน ${os}` };
}
async function sha256Hex(text) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
function randomId() {
  return [...crypto.getRandomValues(new Uint8Array(24))].map((b) => b.toString(16).padStart(2, '0')).join('');
}
const clientIp = (request) => request.headers.get('CF-Connecting-IP') || null;
const clientCountry = (request) => request.cf?.country || request.headers.get('CF-IPCountry') || null;
function bangkokTime(date = new Date()) {
  return date.toLocaleString('th-TH', { timeZone: 'Asia/Bangkok', day: 'numeric', month: 'short', year: '2-digit', hour: '2-digit', minute: '2-digit' }) + ' น.';
}

// ---------- แจ้งเตือนความปลอดภัย ----------
export async function securityAlert(env, userIds, kind, message) {
  const ids = [...new Set((userIds || []).map(Number).filter((id) => Number.isInteger(id) && id > 0))];
  if (!ids.length) return;
  await ensureSessionSchema(env);
  await env.DB.batch(ids.map((id) => env.DB.prepare('INSERT INTO security_notifications(user_id, kind, message) VALUES (?, ?, ?)')
    .bind(id, kind, String(message).slice(0, 500))));
}
export async function superadminIds(env, exceptId = null) {
  const { results } = await env.DB.prepare("SELECT id FROM users WHERE role='superadmin' AND status='active' AND deleted_at IS NULL").all();
  return results.map((r) => Number(r.id)).filter((id) => id !== Number(exceptId));
}

// เรียกหลังเข้าสู่ระบบสำเร็จ: สร้าง session ใหม่ และแจ้งเตือนถ้าเป็นอุปกรณ์ที่บัญชีนี้ไม่เคยใช้
export async function createSession(env, userId, request, app) {
  await ensureSessionSchema(env);
  const ua = String(request.headers.get('User-Agent') || '').slice(0, 400);
  const device = describeDevice(ua);
  const deviceHash = (await sha256Hex(`${device.browser}|${device.os}`)).slice(0, 32);
  const ip = clientIp(request), country = clientCountry(request);
  const prior = await env.DB.prepare(`SELECT COUNT(*) total, SUM(CASE WHEN device_hash=? THEN 1 ELSE 0 END) same
    FROM auth_sessions WHERE user_id=? AND created_at > datetime('now', ?)`).bind(deviceHash, userId, `-${NEW_DEVICE_LOOKBACK_DAYS} days`).first();
  const id = randomId();
  await env.DB.prepare(`INSERT INTO auth_sessions(id, user_id, app, device_hash, device_label, user_agent, ip_address, country)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).bind(id, userId, app, deviceHash, device.label, ua, ip, country).run();
  // บัญชีที่เคยมีประวัติแล้วแต่เพิ่งใช้อุปกรณ์แบบนี้เป็นครั้งแรก → แจ้งเจ้าของบัญชี (ครั้งแรกของบัญชีไม่แจ้ง)
  const isNewDevice = Number(prior?.total || 0) > 0 && Number(prior?.same || 0) === 0;
  if (isNewDevice) {
    await securityAlert(env, [userId], 'new_device',
      `เข้าสู่ระบบ${APP_LABELS[app] || ''}จากอุปกรณ์ใหม่: ${device.label}${ip ? ` · IP ${ip}` : ''}${country && country !== 'TH' ? ` (${country})` : ''} · ${bangkokTime()} — ถ้าไม่ใช่คุณ ให้เปลี่ยนรหัสผ่านและออกจากระบบอุปกรณ์นั้นทันที`);
  }
  // ล้างประวัติเก่าเกิน 1 ปี
  await env.DB.prepare("DELETE FROM auth_sessions WHERE created_at < datetime('now','-365 days')").run();
  return { sid: id, new_device: isNewDevice, device };
}

// ตรวจ session ใน token: คืน false ถ้าถูกออกจากระบบแล้ว · token รุ่นเก่าที่ไม่มี sid ยังใช้ได้จนหมดอายุ
export async function sessionIsActive(env, payload) {
  if (payload?.purpose) return false; // token สำหรับงานเฉพาะ (เช่น ตั๋วสำรองข้อมูล) ห้ามใช้แทนการเข้าสู่ระบบ
  if (!payload?.sid) return true;
  let row;
  try {
    row = await env.DB.prepare('SELECT user_id, revoked_at, last_seen_at < datetime(\'now\', ?) AS stale FROM auth_sessions WHERE id = ?')
      .bind(`-${TOUCH_INTERVAL_MINUTES} minutes`, String(payload.sid)).first();
  } catch (e) {
    if (/no such table/i.test(String(e?.message))) return false;
    throw e;
  }
  if (!row || row.revoked_at || Number(row.user_id) !== Number(payload.sub)) return false;
  if (Number(row.stale) === 1) {
    await env.DB.prepare("UPDATE auth_sessions SET last_seen_at = datetime('now') WHERE id = ?").bind(String(payload.sid)).run().catch(() => {});
  }
  return true;
}

export async function revokeSession(env, sid, userId, reason = 'logout') {
  if (!sid) return 0;
  await ensureSessionSchema(env);
  const r = await env.DB.prepare("UPDATE auth_sessions SET revoked_at = datetime('now'), revoked_reason = ? WHERE id = ? AND user_id = ? AND revoked_at IS NULL")
    .bind(reason, String(sid), userId).run();
  return Number(r.meta?.changes || 0);
}
export async function revokeAllSessions(env, userId, reason, exceptSid = null) {
  await ensureSessionSchema(env);
  await env.DB.prepare("UPDATE auth_sessions SET revoked_at = datetime('now'), revoked_reason = ? WHERE user_id = ? AND revoked_at IS NULL AND id <> ?")
    .bind(reason, userId, String(exceptSid || '')).run();
}

export async function listSessions(env, userId, currentSid) {
  await ensureSessionSchema(env);
  const { results } = await env.DB.prepare(`SELECT id, app, device_label, ip_address, country, created_at, last_seen_at
    FROM auth_sessions WHERE user_id = ? AND revoked_at IS NULL AND created_at > datetime('now', ?)
    ORDER BY last_seen_at DESC LIMIT 50`).bind(userId, `-${SESSION_TTL_DAYS} days`).all();
  return results.map((s) => ({ ...s, app_label: APP_LABELS[s.app] || s.app, current: s.id === currentSid }));
}

// ใส่รหัสผิดจนถูกพัก 15 นาที → แจ้งเจ้าของบัญชี (ไม่เกิน 1 ครั้งต่อ 30 นาที)
export async function alertLockout(env, email, request, app) {
  const user = await env.DB.prepare('SELECT id FROM users WHERE email = ? AND deleted_at IS NULL').bind(email).first();
  if (!user) return;
  await ensureSessionSchema(env);
  const recent = await env.DB.prepare("SELECT 1 FROM security_notifications WHERE user_id=? AND kind='lockout' AND created_at > datetime('now','-30 minutes')").bind(user.id).first();
  if (recent) return;
  const ip = clientIp(request), country = clientCountry(request);
  await securityAlert(env, [user.id], 'lockout',
    `มีการใส่รหัสผ่านผิด 5 ครั้งที่${APP_LABELS[app] || 'ระบบ'}${ip ? ` จาก IP ${ip}` : ''}${country && country !== 'TH' ? ` (${country})` : ''} · ${bangkokTime()} ระบบพักการเข้าสู่ระบบจากที่นั่น 15 นาที — ถ้าไม่ใช่คุณ ควรเปลี่ยนรหัสผ่าน`);
}

// คืน true เมื่อการพยายามครั้งนี้ทำให้ถูกพัก (นับครบ 5 ครั้งพอดี)
export async function lockedNow(env, throttleKey) {
  const row = await env.DB.prepare('SELECT failure_count, locked_until FROM auth_login_throttles WHERE throttle_key = ?').bind(throttleKey).first();
  return !!row?.locked_until && Number(row.failure_count) === 5;
}

// ---------- Cloudflare Turnstile ----------
// ยังไม่ตั้ง TURNSTILE_SECRET_KEY → ไม่บังคับ (ใช้งานได้ตามเดิม)
// Cloudflare ตอบไม่ได้ชั่วคราว → ปล่อยผ่านเพื่อไม่ให้ครูทั้งโรงเรียนเข้าระบบไม่ได้ (การจำกัดรหัสผิด 5 ครั้งยังทำงาน)
export async function verifyTurnstile(env, token, request) {
  if (!env.TURNSTILE_SECRET_KEY) return { ok: true, skipped: true };
  if (!token || typeof token !== 'string' || token.length > 2048) return { ok: false };
  const form = new FormData();
  form.append('secret', env.TURNSTILE_SECRET_KEY);
  form.append('response', token);
  const ip = clientIp(request);
  if (ip) form.append('remoteip', ip);
  try {
    const res = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', { method: 'POST', body: form });
    if (!res.ok) return { ok: true, degraded: true };
    const data = await res.json();
    return { ok: !!data.success, codes: data['error-codes'] || [] };
  } catch {
    return { ok: true, degraded: true };
  }
}
export const TURNSTILE_ERROR = 'กรุณายืนยันว่าไม่ใช่บอท (ติ๊กช่องตรวจสอบ) แล้วลองใหม่';

// ---------- Security headers ----------
export const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline' 'unsafe-eval' https://cdnjs.cloudflare.com https://challenges.cloudflare.com",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' data: https://fonts.gstatic.com",
  "img-src 'self' data: blob: https:",
  "connect-src 'self' https://challenges.cloudflare.com",
  "frame-src 'self' blob: data: https://challenges.cloudflare.com",
  "worker-src 'self' blob:",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'self'",
].join('; ');
export const SECURITY_HEADERS = {
  'Strict-Transport-Security': 'max-age=31536000',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'SAMEORIGIN',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
};
// เพิ่ม header ความปลอดภัยโดยไม่ทับค่าที่หน้า/route ตั้งไว้เอง (เช่น Referrer-Policy: no-referrer)
export function applySecurityHeaders(response) {
  if (response.status === 101 || response.webSocket) return response;
  const r = new Response(response.body, response);
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) if (!r.headers.has(k)) r.headers.set(k, v);
  const type = r.headers.get('Content-Type') || '';
  if (type.includes('text/html') && !r.headers.has('Content-Security-Policy')) r.headers.set('Content-Security-Policy', CONTENT_SECURITY_POLICY);
  return r;
}
