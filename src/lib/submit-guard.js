// ป้องกันการส่งข้อมูลซ้ำ (flooding) สำหรับระบบที่แจ้งเตือนเข้า LINE
// 1) กดส่งซ้ำ: ข้อมูลชุดเดิม (ผู้ใช้ + เส้นทาง + เนื้อหาเดียวกัน) ภายใน DUPLICATE_SECONDS ได้รับ 409 และไม่บันทึก/ไม่แจ้งเตือนซ้ำ
//    ถ้าคำขอครั้งแรกไม่สำเร็จ (สถานะ ≥ 400) ระบบปลดล็อกทันที ให้แก้ไขแล้วส่งใหม่ได้
// 2) ส่งถี่เกิน: ผู้ใช้หนึ่งคนบันทึกในระบบเหล่านี้ได้ไม่เกิน RATE_LIMIT ครั้งต่อนาที (429)
// 3) ปุ่มส่งแจ้งเตือนซ้ำของใบแจ้งซ่อม: ใบเดียวกันส่งได้ 1 ครั้งต่อ NOTIFY_COOLDOWN_SECONDS
// 4) ส่งงานเดิมซ้ำ: ข้อมูลชุดเดียวกันส่งสำเร็จได้ไม่เกิน REPEAT_LIMIT ครั้งใน FLOOD_WINDOW_SECONDS (แม้เว้นช่วงเกิน 20 วินาที)
// 5) ส่ง-ยกเลิกสลับไปมา: ยกเลิก/ถอน/ลบในระบบเดียวกันได้ไม่เกิน CHURN_LIMIT ครั้งใน FLOOD_WINDOW_SECONDS
//    ครบแล้วระบบนั้นพักรับการส่งและยกเลิกจากผู้ใช้คนนั้นจนพ้นช่วงเวลา
import { parseCookies, jsonResponse } from './auth.js';
import { AUTH_COOKIE_NAME } from './crypto.js';

export const DUPLICATE_SECONDS = 20;
export const RATE_LIMIT = 20;
export const NOTIFY_COOLDOWN_SECONDS = 120;
export const FLOOD_WINDOW_SECONDS = 600;
export const REPEAT_LIMIT = 2;
export const CHURN_LIMIT = 3;
const MAX_HASH_BYTES = 12 * 1024 * 1024;

// ระบบที่ส่งแจ้งเตือน LINE (ดู docs/line-notifications.md)
export const LINE_NOTIFYING_WRITE = /^\/api\/(maintenance\/requests|leave-requests|tasks|correspondence|project-documents|procurement|substitutes\/assignments|project-balance-requests|student-delete-requests|supervision\/requests|budget\/requests)(\/|$)/;
const EXEMPT = /\/(read|notifications\/read)$/;
const MAINTENANCE_NOTIFY = /^\/api\/maintenance\/requests\/(\d+)\/notify$/;
const UNDO_PATH = /\/(cancel|withdraw|recall|release|revoke)$/;
const UNDO_ACTION = /^(cancel|withdraw|recall|release|revoke|delete)/i;
// ระบบ = ส่วนแรกของเส้นทาง เช่น supervision/requests, leave-requests, tasks
const systemOf = (pathname) => pathname.match(LINE_NOTIFYING_WRITE)?.[1] || pathname;
function isUndo(method, pathname, body) {
  if (method === 'DELETE' || UNDO_PATH.test(pathname)) return true;
  try { const data = JSON.parse(new TextDecoder().decode(body)); return UNDO_ACTION.test(String(data?.action || data?.status || '')); } catch { return false; }
}
const waitText = (sec) => sec >= 60 ? `${Math.ceil(sec / 60)} นาที` : `${sec} วินาที`;

export function guardedWrite(method, pathname) {
  return ['POST', 'PUT', 'PATCH', 'DELETE'].includes(method) && LINE_NOTIFYING_WRITE.test(pathname) && !EXEMPT.test(pathname);
}

const ready = new WeakSet();
async function ensureSchema(env) {
  if (ready.has(env.DB)) return;
  await env.DB.batch([
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS submit_guard (
      guard_key TEXT PRIMARY KEY, actor TEXT NOT NULL, kind TEXT NOT NULL, created_at INTEGER NOT NULL)`),
    env.DB.prepare('CREATE INDEX IF NOT EXISTS idx_submit_guard_actor ON submit_guard(actor,created_at)'),
  ]);
  ready.add(env.DB);
}

async function sha256(data) {
  const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;
  const hash = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(hash)].map((n) => n.toString(16).padStart(2, '0')).join('');
}

async function claim(env, key, actor, kind, seconds, window) {
  const result = await env.DB.prepare(`INSERT INTO submit_guard(guard_key,actor,kind,created_at) VALUES(?,?,?,?)
    ON CONFLICT(guard_key) DO UPDATE SET created_at=excluded.created_at,actor=excluded.actor WHERE submit_guard.created_at<=excluded.created_at-?`)
    .bind(key, actor, kind, seconds, window).run();
  return Number(result?.meta?.changes ?? result?.changes ?? 0) > 0;
}

// คืน null = ผ่าน, หรือคืน { response } ถ้าถูกบล็อก, หรือ { release } ให้เรียกเมื่อคำขอไม่สำเร็จ
export async function checkSubmitGuard(request, env, pathname, now = Date.now()) {
  const method = request.method;
  if (!env?.DB || !guardedWrite(method, pathname)) return null;
  const token = parseCookies(request)[AUTH_COOKIE_NAME];
  if (!token) return null; // ยังไม่ได้เข้าสู่ระบบ — ให้ระบบตอบ 401 ตามปกติ
  await ensureSchema(env);
  const actor = (await sha256('actor:' + token)).slice(0, 32), seconds = Math.floor(now / 1000);
  // ล้างรายการเก่า (เก็บไว้ไม่เกิน 10 นาที)
  await env.DB.prepare('DELETE FROM submit_guard WHERE created_at<?').bind(seconds - 600).run();

  const notify = pathname.match(MAINTENANCE_NOTIFY);
  if (notify) {
    const key = 'notify:maintenance:' + notify[1];
    if (!await claim(env, key, actor, 'notify', seconds, NOTIFY_COOLDOWN_SECONDS)) {
      const recent = await env.DB.prepare('SELECT created_at FROM submit_guard WHERE guard_key=?').bind(key).first();
      const wait = Math.max(1, NOTIFY_COOLDOWN_SECONDS - (seconds - Number(recent?.created_at || seconds)));
      return { response: jsonResponse({ error: `เพิ่งส่งแจ้งเตือน LINE ของใบแจ้งซ่อมนี้ไปแล้ว กรุณารออีก ${wait} วินาที`, code: 'NOTIFY_COOLDOWN', retry_after: wait }, 429, { 'Retry-After': String(wait) }) };
    }
    return { release: () => env.DB.prepare('DELETE FROM submit_guard WHERE guard_key=? AND created_at=?').bind(key, seconds).run() };
  }

  const count = await env.DB.prepare("SELECT COUNT(*) n FROM submit_guard WHERE actor=? AND kind='write' AND created_at>=?").bind(actor, seconds - 60).first();
  if (Number(count?.n || 0) >= RATE_LIMIT) {
    return { response: jsonResponse({ error: 'ส่งข้อมูลถี่เกินไป กรุณารอสักครู่แล้วลองใหม่', code: 'RATE_LIMITED', retry_after: 60 }, 429, { 'Retry-After': '60' }) };
  }
  const size = Number(request.headers.get('Content-Length') || 0);
  const body = size > MAX_HASH_BYTES ? new Uint8Array() : new Uint8Array(await request.clone().arrayBuffer());
  const bodyHash = await sha256(body);
  const system = systemOf(pathname), sysKey = (await sha256(system)).slice(0, 16);
  const since = seconds - FLOOD_WINDOW_SECONDS;
  const formLike = size <= MAX_HASH_BYTES && body.byteLength > 2;
  const undo = isUndo(method, pathname, body);
  const releases = [];
  const releaseAll = () => Promise.all(releases.map((f) => f()));
  const counted = async (prefix, kind) => {
    const key = `${prefix}:${seconds}:${crypto.randomUUID()}`;
    await env.DB.prepare('INSERT INTO submit_guard(guard_key,actor,kind,created_at) VALUES(?,?,?,?)').bind(key, actor, kind, seconds).run();
    releases.push(() => env.DB.prepare('DELETE FROM submit_guard WHERE guard_key=?').bind(key).run());
  };
  const stats = (prefix) => env.DB.prepare('SELECT COUNT(*) n,MIN(created_at) first FROM submit_guard WHERE actor=? AND guard_key LIKE ? AND created_at>=?').bind(actor, prefix + ':%', since).first();
  const blocked = (row, error, code) => {
    const wait = Math.max(1, Number(row?.first || seconds) + FLOOD_WINDOW_SECONDS - seconds);
    return { response: jsonResponse({ error: `${error} กรุณารออีก ${waitText(wait)}`, code, retry_after: wait }, 429, { 'Retry-After': String(wait) }) };
  };

  // ส่ง-ยกเลิกสลับไปมา: ยกเลิกครบเพดานแล้ว พักทั้งการส่งใหม่และการยกเลิกในระบบนั้น
  const churnPrefix = `churn:${actor}:${sysKey}`;
  const churn = await stats(churnPrefix);
  if (Number(churn?.n || 0) >= CHURN_LIMIT && (undo || method === 'POST')) {
    return blocked(churn, 'ส่งและยกเลิกรายการสลับไปมาบ่อยเกินไป ระบบพักการส่ง/ยกเลิกรายการนี้ชั่วคราวเพื่อไม่ให้แจ้งเตือนผู้เกี่ยวข้องซ้ำ ๆ', 'CHURN_LIMITED');
  }
  // ส่งงานเดิม (ข้อมูลชุดเดียวกัน) ซ้ำหลายครั้ง
  const repeatPrefix = `repeat:${actor}:${await sha256(`${method}|${pathname}|${new URL(request.url).search}|${bodyHash}`)}`;
  if (formLike && !undo) {
    const repeat = await stats(repeatPrefix);
    if (Number(repeat?.n || 0) >= REPEAT_LIMIT) return blocked(repeat, 'ส่งงานเดิมซ้ำหลายครั้งแล้ว ระบบไม่บันทึกและไม่แจ้งเตือนซ้ำ', 'REPEAT_LIMITED');
  }

  const key = 'write:' + await sha256(`${actor}|${method}|${pathname}|${new URL(request.url).search}|${bodyHash}`);
  // จองแบบ atomic: คำขอที่กดซ้ำพร้อมกันสองครั้ง จะผ่านได้เพียงครั้งเดียว
  // คำสั่งที่ไม่มีข้อมูลแนบ (เช่น รับเรื่อง/ปล่อยคืน) ตรวจสถานะซ้ำที่ระบบงานเองอยู่แล้ว จึงนับเฉพาะเพดานความถี่
  if (!await claim(env, key, actor, 'write', seconds, formLike ? DUPLICATE_SECONDS : 0)) {
    return { response: jsonResponse({ error: 'ระบบได้รับข้อมูลนี้แล้ว (กดส่งซ้ำ) — ไม่ได้บันทึกและไม่ได้แจ้งเตือนซ้ำ', code: 'DUPLICATE_SUBMIT' }, 409) };
  }
  releases.push(() => env.DB.prepare('DELETE FROM submit_guard WHERE guard_key=? AND created_at=?').bind(key, seconds).run());
  if (formLike && !undo) await counted(repeatPrefix, 'repeat');
  if (undo) await counted(churnPrefix, 'churn');
  return { release: releaseAll };
}
