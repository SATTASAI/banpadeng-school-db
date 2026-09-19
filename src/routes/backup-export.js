import { getCurrentUser, jsonResponse } from "../lib/auth.js";
import { signJWT, verifyJWT } from "../lib/crypto.js";

const NO_STORE = { "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" };
const DATABASE_ID = "870fa9ec-122f-4161-a1ca-cc9979dcfa30";

class ExportFailure extends Error {
  constructor(stage, httpStatus = null, cloudflareCode = null) {
    super("D1 export failed");
    this.stage = stage;
    this.httpStatus = httpStatus;
    this.cloudflareCode = cloudflareCode;
  }
}

function backupConfig(env) {
  return Boolean(env.CLOUDFLARE_ACCOUNT_ID && env.CLOUDFLARE_D1_BACKUP_TOKEN);
}

async function callExport(env, bookmark) {
  const url = `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(env.CLOUDFLARE_ACCOUNT_ID)}/d1/database/${DATABASE_ID}/export`;
  const body = { output_format: "polling" };
  if (bookmark) body.current_bookmark = bookmark;
  let response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${env.CLOUDFLARE_D1_BACKUP_TOKEN.trim()}` },
      body: JSON.stringify(body),
    });
  } catch {
    throw new ExportFailure("cloudflare_connection");
  }
  const payload = await response.json().catch(() => null);
  if (!payload) throw new ExportFailure("cloudflare_response", response.status);
  if (!response.ok || !payload.success || payload.result?.status === "error" || payload.result?.success === false) {
    const code = payload.errors?.[0]?.code;
    throw new ExportFailure("cloudflare_export", response.status, Number.isInteger(code) ? code : null);
  }
  if (!payload.result) throw new ExportFailure("cloudflare_response", response.status);
  return payload.result;
}

export async function handleBackupExport(request, env, pathname) {
  if (request.method !== "POST") return jsonResponse({ error: "Method not allowed" }, 405, { ...NO_STORE, Allow: "POST" });
  const origin = request.headers.get("Origin");
  if (!origin || origin !== new URL(request.url).origin) return jsonResponse({ error: "คำขอไม่ถูกต้อง" }, 403, NO_STORE);
  const action = pathname.slice("/api/security/backup/".length);
  if (action !== "start" && action !== "poll" && action !== "download") return jsonResponse({ error: "ไม่พบคำสั่ง" }, 404, NO_STORE);
  let body;
  try { body = await request.json(); } catch { return jsonResponse({ error: "ข้อมูลคำขอไม่ถูกต้อง" }, 400, NO_STORE); }
  let user;
  let bookmark;
  if (action === "start" || action === "download") {
    user = await getCurrentUser(request, env);
    if (!user || user.role !== "superadmin") return jsonResponse({ error: "เฉพาะผู้ดูแลระบบเท่านั้น" }, 403, NO_STORE);
  }
  if (action !== "start") {
    const ticket = await verifyJWT(body?.ticket, env.JWT_SECRET);
    if (ticket?.purpose !== "d1_backup_export" || !Number.isInteger(ticket.sub) ||
      typeof ticket.bookmark !== "string" || ticket.bookmark.length > 512) {
      return jsonResponse({ error: "รหัสงานส่งออกไม่ถูกต้องหรือหมดอายุ" }, 403, NO_STORE);
    }
    if (action === "download" && ticket.sub !== user.id) return jsonResponse({ error: "ไม่มีสิทธิ์ดาวน์โหลดงานนี้" }, 403, NO_STORE);
    bookmark = ticket.bookmark;
  }
  if (!backupConfig(env)) return jsonResponse({ error: "ยังไม่ตั้งค่า CLOUDFLARE_ACCOUNT_ID และ CLOUDFLARE_D1_BACKUP_TOKEN" }, 503, NO_STORE);

  try {
    const result = await callExport(env, bookmark);
    bookmark = result.at_bookmark || bookmark;
    if (typeof bookmark !== "string" || !bookmark || bookmark.length > 512) throw new ExportFailure("missing_bookmark");
    if (action !== "download") {
      const ticket = action === "start" ? await signJWT({ purpose: "d1_backup_export", sub: user.id, bookmark }, env.JWT_SECRET, 600) : body.ticket;
      return jsonResponse({ status: result.status === "complete" ? "complete" : "pending", ticket }, 200, NO_STORE);
    }
    if (result.status !== "complete" || !result.result?.signed_url) return jsonResponse({ error: "งานส่งออกยังไม่เสร็จ กรุณารอสักครู่" }, 409, NO_STORE);

    // URL ชั่วคราวอยู่เฉพาะฝั่งเซิร์ฟเวอร์ ไม่ส่งต่อไปยังเบราว์เซอร์หรือบันทึกลงฐานข้อมูล
    let signedUrl;
    try { signedUrl = new URL(result.result.signed_url); }
    catch { throw new ExportFailure("invalid_download_url"); }
    if (signedUrl.protocol !== "https:") throw new ExportFailure("invalid_download_url");
    let download;
    try { download = await fetch(signedUrl.toString()); }
    catch { throw new ExportFailure("download_connection"); }
    if (!download.ok || !download.body) throw new ExportFailure("download_response", download.status);
    const filename = `banpadeng-d1-${new Date().toISOString().slice(0, 10)}.sql`;
    await env.DB.prepare("INSERT INTO backup_registry (backup_type, file_name, created_by) VALUES ('d1_sql_download', ?, ?)")
      .bind(filename, user.id).run();
    await env.DB.prepare("INSERT INTO audit_logs (user_id, action, resource, details, ip_address) VALUES (?, 'download', 'd1_backup', ?, ?)")
      .bind(user.id, JSON.stringify({ file_name: filename }), request.headers.get("CF-Connecting-IP") || null).run();
    return new Response(download.body, {
      headers: { ...NO_STORE, "Content-Type": "application/sql; charset=utf-8", "Content-Disposition": `attachment; filename="${filename}"` },
    });
  } catch (error) {
    const stage = error instanceof ExportFailure ? error.stage : "download_or_log";
    const diagnostic = error instanceof ExportFailure
      ? { stage, http_status: error.httpStatus, cloudflare_code: error.cloudflareCode }
      : { stage };
    // รายงานเฉพาะรหัสและขั้นตอน ไม่ส่งข้อความดิบซึ่งอาจมี URL ชั่วคราวหรือข้อมูลลับ
    const code = diagnostic.cloudflare_code == null ? "" : `, code ${diagnostic.cloudflare_code}`;
    const status = diagnostic.http_status == null ? "" : ` HTTP ${diagnostic.http_status}${code}`;
    return jsonResponse({ error: `ส่งออกฐานข้อมูลไม่สำเร็จ (${stage}${status})`, diagnostic }, 502, NO_STORE);
  }
}

export async function getBackupOverview(env) {
  const { results } = await env.DB.prepare(`SELECT b.file_name, b.backup_type, b.created_at, u.full_name AS created_by
    FROM backup_registry b LEFT JOIN users u ON u.id=b.created_by ORDER BY b.created_at DESC, b.id DESC LIMIT 20`).all();
  return { configured: backupConfig(env), history: results || [] };
}
