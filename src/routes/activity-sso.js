// เปิดเว็บภาพกิจกรรม (activity.banpadengschool.ac.th) จากเมนู system โดยไม่ต้องล็อกอินซ้ำ
// system ออกรหัสใช้ครั้งเดียว (อายุ 60 วินาที) เก็บใน D1 ที่ใช้ร่วมกัน → activity /sso แลกเป็น session ของตัวเอง
import { getCurrentUser } from "../lib/auth.js";

const ACTIVITY_ORIGIN = "https://activity.banpadengschool.ac.th";

async function sha256Hex(text) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function handleActivitySsoRoute(request, env, pathname, method) {
  if (pathname !== "/api/activity-sso" || method !== "GET") return null;
  const current = await getCurrentUser(request, env);
  const user = current?.impersonator || current; // โหมดมุมมองบุคคลอื่น → ใช้บัญชีจริงของผู้ดูแล
  if (!user || user.role === "viewer") return Response.redirect(`${ACTIVITY_ORIGIN}/`, 302);
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS activity_sso_codes (
    code_hash TEXT PRIMARY KEY, user_id INTEGER NOT NULL, session_version INTEGER NOT NULL,
    expires_at INTEGER NOT NULL)`).run();
  const code = [...crypto.getRandomValues(new Uint8Array(32))].map((b) => b.toString(16).padStart(2, "0")).join("");
  const now = Math.floor(Date.now() / 1000);
  await env.DB.batch([
    env.DB.prepare("DELETE FROM activity_sso_codes WHERE expires_at < ?").bind(now),
    env.DB.prepare("INSERT INTO activity_sso_codes (code_hash, user_id, session_version, expires_at) VALUES (?, ?, ?, ?)")
      .bind(await sha256Hex(code), user.id, Number(user.session_version ?? 1), now + 60),
  ]);
  return new Response(null, { status: 302, headers: { Location: `${ACTIVITY_ORIGIN}/sso?code=${code}`, "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" } });
}
