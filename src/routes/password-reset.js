import { generateSalt, hashPassword, buildClearCookie } from '../lib/crypto.js';
import { jsonResponse } from '../lib/auth.js';

const ready = new WeakSet();
export async function ensurePasswordResetSchema(env) {
  if (ready.has(env.DB)) return;
  await env.DB.batch([
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS auth_password_resets (
      token_hash TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id),
      session_version INTEGER NOT NULL, expires_at TEXT NOT NULL, used_at TEXT,
      created_at TEXT NOT NULL DEFAULT(datetime('now')))`),
    env.DB.prepare('CREATE INDEX IF NOT EXISTS idx_password_resets_user ON auth_password_resets(user_id)'),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS auth_reset_throttles (
      throttle_key TEXT PRIMARY KEY, request_count INTEGER NOT NULL,
      window_started_at TEXT NOT NULL, last_requested_at TEXT NOT NULL)`),
  ]);
  ready.add(env.DB);
}
async function digest(value) {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(bytes), b => b.toString(16).padStart(2, '0')).join('');
}
function mailConfig(env) {
  return { key: env.RESEND_API_KEY, from: env.PASSWORD_RESET_FROM || env.RESEND_FROM_EMAIL || env.EMAIL_FROM };
}
async function throttle(env, key, limit, cooldown = false) {
  const row = await env.DB.prepare(`INSERT INTO auth_reset_throttles
    (throttle_key,request_count,window_started_at,last_requested_at) VALUES (?,1,datetime('now'),datetime('now'))
    ON CONFLICT(throttle_key) DO UPDATE SET
      request_count=CASE WHEN window_started_at<=datetime('now','-15 minutes') THEN 1 ELSE request_count+1 END,
      window_started_at=CASE WHEN window_started_at<=datetime('now','-15 minutes') THEN datetime('now') ELSE window_started_at END,
      last_requested_at=datetime('now')
    WHERE ?=0 OR last_requested_at<=datetime('now','-60 seconds') OR window_started_at<=datetime('now','-15 minutes')
    RETURNING request_count`).bind(key,cooldown ? 1 : 0).first();
  return Boolean(row) && Number(row.request_count) <= limit;
}
const accepted = () => jsonResponse({ message: 'หากอีเมลนี้มีบัญชีที่ใช้งานอยู่ ระบบจะส่งลิงก์ตั้งรหัสผ่านใหม่ให้ กรุณาตรวจกล่องจดหมายและจดหมายขยะ' });
const invalid = () => jsonResponse({ error: 'ลิงก์หมดอายุหรือใช้แล้ว กรุณาขอลิงก์ตั้งรหัสผ่านใหม่อีกครั้ง' }, 400);

export async function handlePasswordResetRoute(request, env, pathname, method) {
  if (!['/api/auth/forgot-password','/api/auth/reset-password','/api/auth/password-reset-status'].includes(pathname)) return null;
  const mail = mailConfig(env);
  if (pathname === '/api/auth/password-reset-status' && method === 'GET') {
    return jsonResponse({ available: Boolean(mail.key && mail.from) }, 200, { 'Cache-Control': 'no-store' });
  }
  if (method !== 'POST') return jsonResponse({ error: 'Method not allowed' }, 405, { Allow: 'POST' });
  await ensurePasswordResetSchema(env);
  const body = await request.json().catch(() => null);
  if (!body || typeof body !== 'object') return jsonResponse({ error: 'รูปแบบข้อมูลไม่ถูกต้อง' }, 400);
  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  if (!await throttle(env, await digest(`${pathname}|${ip}`), pathname.endsWith('forgot-password') ? 10 : 20)) {
    return jsonResponse({ error: 'ส่งคำขอหลายครั้ง กรุณารอ 15 นาทีแล้วลองใหม่' }, 429, { 'Retry-After': '900' });
  }
  if (pathname === '/api/auth/forgot-password') {
    const email = String(body.email || '').trim().toLowerCase();
    if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return jsonResponse({ error: 'กรุณากรอกอีเมลให้ถูกต้อง' }, 400);
    if (!mail.key || !mail.from) return jsonResponse({ error: 'ระบบส่งอีเมลยังไม่พร้อม กรุณาติดต่อผู้ดูแลระบบเพื่อรีเซ็ตรหัสผ่าน' }, 503);
    // The same response and cooldown apply to registered and unregistered addresses.
    if (!await throttle(env, await digest(`email|${email}`), 3, true)) return accepted();
    const user = await env.DB.prepare("SELECT id,email,session_version FROM users WHERE email=? AND status='active'").bind(email).first();
    if (!user) return accepted();
    const token = Array.from(crypto.getRandomValues(new Uint8Array(32)), b => b.toString(16).padStart(2, '0')).join('');
    const tokenHash = await digest(token);
    await env.DB.prepare(`INSERT INTO auth_password_resets(token_hash,user_id,session_version,expires_at)
      VALUES (?,?,?,datetime('now','+30 minutes'))`).bind(tokenHash,user.id,Number(user.session_version || 1)).run();
    // Fixed school origin prevents Host-header based reset-link poisoning; fragment keeps the token out of request logs.
    const url = `https://system.banpadengschool.ac.th/reset-password.html#token=${token}`;
    let sent = false;
    try {
      const response = await fetch('https://api.resend.com/emails', {
        method: 'POST', headers: { Authorization: `Bearer ${mail.key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ from: mail.from, to: [user.email], subject: 'ตั้งรหัสผ่านใหม่ — โรงเรียนบ้านป่าเด็ง',
          text: `มีคำขอตั้งรหัสผ่านใหม่สำหรับบัญชีของคุณ\n\nเปิดลิงก์นี้ภายใน 30 นาที:\n${url}\n\nหากคุณไม่ได้ขอ ให้ละเว้นอีเมลนี้ รหัสผ่านเดิมยังใช้งานได้` }),
        signal: AbortSignal.timeout(10000),
      });
      sent = response.ok;
    } catch { /* Never log provider credentials, response body, email or reset token. */ }
    if (!sent) {
      await env.DB.prepare('DELETE FROM auth_password_resets WHERE token_hash=?').bind(tokenHash).run();
      // Keep the public response identical so provider errors cannot reveal account existence.
      console.error('Password reset email delivery failed');
      return accepted();
    }
    await env.DB.batch([
      env.DB.prepare('DELETE FROM auth_password_resets WHERE user_id=? AND token_hash<>?').bind(user.id,tokenHash),
      env.DB.prepare("DELETE FROM auth_password_resets WHERE expires_at<datetime('now','-1 day')"),
      env.DB.prepare("DELETE FROM auth_reset_throttles WHERE window_started_at<datetime('now','-1 day')"),
    ]);
    return accepted();
  }
  const token = String(body.token || ''), password = String(body.new_password || '');
  if (!/^[a-f0-9]{64}$/.test(token)) return invalid();
  if (password.length < 8 || password.length > 256) return jsonResponse({ error: 'รหัสผ่านใหม่ต้องมี 8–256 ตัวอักษร' }, 400);
  const tokenHash = await digest(token);
  const row = await env.DB.prepare(`SELECT r.user_id,r.session_version FROM auth_password_resets r JOIN users u ON u.id=r.user_id
    WHERE r.token_hash=? AND r.used_at IS NULL AND r.expires_at>datetime('now')
      AND u.status='active' AND u.session_version=r.session_version`).bind(tokenHash).first();
  if (!row) return invalid();
  const salt = generateSalt(), hash = await hashPassword(password,salt);
  const results = await env.DB.batch([
    env.DB.prepare(`UPDATE users SET password_hash=?,password_salt=?,session_version=session_version+1,password_changed_at=datetime('now')
      WHERE id=? AND status='active' AND session_version=? AND EXISTS (
        SELECT 1 FROM auth_password_resets WHERE token_hash=? AND user_id=users.id AND used_at IS NULL AND expires_at>datetime('now'))`)
      .bind(hash,salt,row.user_id,row.session_version,tokenHash),
    env.DB.prepare("UPDATE auth_password_resets SET used_at=datetime('now') WHERE token_hash=? AND changes()=1").bind(tokenHash),
    env.DB.prepare(`INSERT INTO audit_logs(user_id,action,resource,resource_id,details,ip_address)
      SELECT ?,'reset_password','users',?,'{}',? WHERE changes()=1`).bind(row.user_id,row.user_id,ip),
  ]);
  if (!Number(results[0]?.meta?.changes)) return invalid();
  return jsonResponse({ message: 'ตั้งรหัสผ่านใหม่เรียบร้อย กรุณาเข้าสู่ระบบด้วยรหัสผ่านใหม่' }, 200,
    { 'Set-Cookie': buildClearCookie(), 'Cache-Control': 'no-store' });
}
