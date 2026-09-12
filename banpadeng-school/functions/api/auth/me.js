import { getCurrentUser, jsonResponse, isAdmin } from "../../_lib/auth.js";

export async function onRequestGet({ request, env }) {
  const user = await getCurrentUser(request, env);
  if (!user) {
    return jsonResponse({ user: null }, 200);
  }
  return jsonResponse({ user: { ...user, is_admin: isAdmin(user) } }, 200);
}
