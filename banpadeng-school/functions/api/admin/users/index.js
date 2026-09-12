import { getCurrentUser, jsonResponse, isAdmin } from "../../../_lib/auth.js";

export async function onRequestGet({ request, env }) {
  const user = await getCurrentUser(request, env);
  if (!isAdmin(user)) {
    return jsonResponse({ error: "ไม่มีสิทธิ์เข้าถึงส่วนนี้" }, 403);
  }

  const { results } = await env.DB.prepare(
    "SELECT id, email, full_name, role, status, created_at, approved_at FROM users ORDER BY created_at DESC"
  ).all();

  return jsonResponse({ users: results });
}
