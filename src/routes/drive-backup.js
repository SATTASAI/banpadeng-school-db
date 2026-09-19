import { getCurrentUser, jsonResponse } from "../lib/auth.js";

const HEADERS = { "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" };
const PAGE_SIZE = 50;

async function requireBackupAdmin(request, env) {
  const user = await getCurrentUser(request, env);
  return user?.role === "superadmin";
}

function parseId(value) {
  if (!/^(0|[1-9]\d{0,11})$/.test(String(value ?? ""))) return null;
  const id = Number(value);
  return Number.isSafeInteger(id) ? id : null;
}

// Capture max_id at the start. A later upload does not silently enter the backup in progress.
export async function handleDriveBackupManifest(request, env) {
  if (!await requireBackupAdmin(request, env)) return jsonResponse({ error: "เฉพาะผู้ดูแลระบบเท่านั้น" }, 403, HEADERS);
  const params = new URL(request.url).searchParams;
  const after = parseId(params.get("after") ?? "0");
  const suppliedMax = params.get("max_id");
  const maxId = suppliedMax === null ? null : parseId(suppliedMax);
  if (after === null || (suppliedMax !== null && maxId === null)) {
    return jsonResponse({ error: "ช่วงรหัสไฟล์ไม่ถูกต้อง" }, 400, HEADERS);
  }
  const snapshot = maxId === null
    ? await env.DB.prepare("SELECT COALESCE(MAX(id), 0) AS max_id, COUNT(*) AS total FROM file_attachments WHERE storage_provider='drive'").first()
    : null;
  const ceiling = maxId ?? Number(snapshot.max_id);
  const { results = [] } = await env.DB.prepare(`SELECT id, entity_type, entity_id, file_name, mime_type, file_size,
    file_hash, created_at FROM file_attachments WHERE storage_provider='drive' AND id>? AND id<=?
    ORDER BY id LIMIT ?`).bind(after, ceiling, PAGE_SIZE + 1).all();
  const files = results.slice(0, PAGE_SIZE).map(row => ({
    id: row.id, entity_type: row.entity_type, entity_id: row.entity_id,
    file_name: row.file_name, mime_type: row.mime_type, file_size: row.file_size,
    sha256: /^[a-f0-9]{64}$/i.test(row.file_hash || "") ? row.file_hash.toLowerCase() : null,
    created_at: row.created_at,
  }));
  return jsonResponse({ max_id: ceiling, total: snapshot ? Number(snapshot.total) : null,
    files, next_after: results.length > PAGE_SIZE ? files.at(-1).id : null }, 200, HEADERS);
}

export async function handleDriveBackupFile(request, env, id, getToken) {
  if (!await requireBackupAdmin(request, env)) return jsonResponse({ error: "เฉพาะผู้ดูแลระบบเท่านั้น" }, 403, HEADERS);
  const attachmentId = parseId(id);
  if (!attachmentId || attachmentId !== Number(id)) return jsonResponse({ error: "รหัสไฟล์ไม่ถูกต้อง" }, 400, HEADERS);
  const file = await env.DB.prepare(`SELECT drive_file_id FROM file_attachments
    WHERE id=? AND storage_provider='drive'`).bind(attachmentId).first();
  if (!file?.drive_file_id) return jsonResponse({ error: "ไม่พบไฟล์ที่ลงทะเบียนใน Drive" }, 404, HEADERS);
  try {
    const token = await getToken(env);
    const response = await fetch(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(file.drive_file_id)}?alt=media`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!response.ok || !response.body) {
      return jsonResponse({ error: response.status === 404 ? "ไฟล์ใน Drive หายไป" : `อ่านไฟล์จาก Drive ไม่สำเร็จ (${response.status})` }, 502, HEADERS);
    }
    return new Response(response.body, { headers: {
      ...HEADERS, "Content-Type": "application/octet-stream",
      "Content-Disposition": `attachment; filename="attachment-${attachmentId}"`,
      "Content-Security-Policy": "default-src 'none'",
    } });
  } catch {
    return jsonResponse({ error: "เชื่อมต่อ Google Drive ไม่สำเร็จ" }, 502, HEADERS);
  }
}
