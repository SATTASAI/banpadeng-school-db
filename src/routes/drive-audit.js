import { getCurrentUser, jsonResponse } from "../lib/auth.js";

const HEADERS = { "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" };
const PAGE_SIZE = 10;

// Check files registered in D1; this does not enumerate unregistered files in Drive.
export async function handleDriveAudit(request, env, getToken) {
  const user = await getCurrentUser(request, env);
  if (!user || user.role !== "superadmin") return jsonResponse({ error: "เฉพาะผู้ดูแลระบบเท่านั้น" }, 403, HEADERS);
  const offsetValue = new URL(request.url).searchParams.get("offset") || "0";
  if (!/^(0|[1-9]\d{0,8})$/.test(offsetValue)) return jsonResponse({ error: "ลำดับหน้าไม่ถูกต้อง" }, 400, HEADERS);
  const offset = Number(offsetValue);
  const total = Number((await env.DB.prepare("SELECT count(*) AS count FROM file_attachments WHERE storage_provider='drive'").first()).count);
  const { results: files } = await env.DB.prepare(
    "SELECT id, file_name, file_size, drive_file_id FROM file_attachments WHERE storage_provider='drive' ORDER BY id LIMIT ? OFFSET ?"
  ).bind(PAGE_SIZE, offset).all();
  if (!files?.length) return jsonResponse({ total, checked: [], next_offset: null }, 200, HEADERS);
  let token;
  try { token = await getToken(env); }
  catch { return jsonResponse({ error: "เชื่อมต่อ Google Drive ไม่สำเร็จ กรุณาตรวจการตั้งค่า" }, 502, HEADERS); }
  const checked = await Promise.all(files.map(async file => {
    if (!file.drive_file_id) return { id: file.id, file_name: file.file_name, status: "missing_reference" };
    try {
      const response = await fetch(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(file.drive_file_id)}?fields=id,size,trashed`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (response.status === 404 || response.status === 410) return { id: file.id, file_name: file.file_name, status: "missing" };
      if (response.status === 403 || response.status === 401) return { id: file.id, file_name: file.file_name, status: "inaccessible" };
      if (!response.ok) return { id: file.id, file_name: file.file_name, status: "error" };
      const metadata = await response.json();
      if (metadata.trashed) return { id: file.id, file_name: file.file_name, status: "trashed" };
      const expected = Number(file.file_size), actual = Number(metadata.size);
      return { id: file.id, file_name: file.file_name,
        status: Number.isFinite(expected) && Number.isFinite(actual) && expected !== actual ? "size_mismatch" : "ok" };
    } catch {
      return { id: file.id, file_name: file.file_name, status: "error" };
    }
  }));
  return jsonResponse({ total, checked, next_offset: offset + files.length < total ? offset + files.length : null }, 200, HEADERS);
}
