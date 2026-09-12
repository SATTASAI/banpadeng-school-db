import {
  generateSalt,
  hashPassword,
  verifyPassword,
  signJWT,
  buildSessionCookie,
  buildClearCookie,
} from "./lib/crypto.js";
import { getCurrentUser, jsonResponse, isAdmin } from "./lib/auth.js";

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

// ---------- /api/auth/register ----------
async function handleRegister(request, env) {
  let body;
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ error: "รูปแบบข้อมูลไม่ถูกต้อง" }, 400);
  }

  const email = (body.email || "").trim().toLowerCase();
  const password = body.password || "";
  const fullName = (body.full_name || "").trim();

  if (!email || !isValidEmail(email)) {
    return jsonResponse({ error: "กรุณากรอกอีเมลให้ถูกต้อง" }, 400);
  }
  if (!fullName) {
    return jsonResponse({ error: "กรุณากรอกชื่อ-นามสกุล" }, 400);
  }
  if (!password || password.length < 8) {
    return jsonResponse({ error: "รหัสผ่านต้องมีอย่างน้อย 8 ตัวอักษร" }, 400);
  }

  const existing = await env.DB.prepare("SELECT id FROM users WHERE email = ?")
    .bind(email)
    .first();
  if (existing) {
    return jsonResponse({ error: "อีเมลนี้ถูกใช้สมัครสมาชิกไปแล้ว" }, 409);
  }

  const { count } = await env.DB.prepare("SELECT COUNT(*) as count FROM users").first();
  const isFirstUser = count === 0;

  const salt = generateSalt();
  const passwordHash = await hashPassword(password, salt);

  const result = await env.DB.prepare(
    `INSERT INTO users (email, password_hash, password_salt, full_name, role, status, approved_at)
     VALUES (?, ?, ?, ?, ?, 'active', ?)`
  )
    .bind(
      email,
      passwordHash,
      salt,
      fullName,
      isFirstUser ? "superadmin" : null,
      isFirstUser ? new Date().toISOString() : null
    )
    .run();

  const userId = result.meta.last_row_id;
  const token = await signJWT({ sub: userId }, env.JWT_SECRET);

  return jsonResponse(
    {
      user: {
        id: userId,
        email,
        full_name: fullName,
        role: isFirstUser ? "superadmin" : null,
        status: "active",
      },
    },
    201,
    { "Set-Cookie": buildSessionCookie(token) }
  );
}

// ---------- /api/auth/login ----------
async function handleLogin(request, env) {
  let body;
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ error: "รูปแบบข้อมูลไม่ถูกต้อง" }, 400);
  }

  const email = (body.email || "").trim().toLowerCase();
  const password = body.password || "";

  if (!email || !password) {
    return jsonResponse({ error: "กรุณากรอกอีเมลและรหัสผ่าน" }, 400);
  }

  const user = await env.DB.prepare(
    "SELECT id, email, full_name, role, status, password_hash, password_salt FROM users WHERE email = ?"
  )
    .bind(email)
    .first();

  if (!user) {
    return jsonResponse({ error: "อีเมลหรือรหัสผ่านไม่ถูกต้อง" }, 401);
  }

  const ok = await verifyPassword(password, user.password_salt, user.password_hash);
  if (!ok) {
    return jsonResponse({ error: "อีเมลหรือรหัสผ่านไม่ถูกต้อง" }, 401);
  }

  if (user.status !== "active") {
    return jsonResponse({ error: "บัญชีนี้ถูกระงับการใช้งาน กรุณาติดต่อผู้ดูแลระบบ" }, 403);
  }

  const token = await signJWT({ sub: user.id }, env.JWT_SECRET);

  return jsonResponse(
    {
      user: {
        id: user.id,
        email: user.email,
        full_name: user.full_name,
        role: user.role,
        status: user.status,
      },
    },
    200,
    { "Set-Cookie": buildSessionCookie(token) }
  );
}

// ---------- /api/auth/logout ----------
async function handleLogout() {
  return jsonResponse({ ok: true }, 200, { "Set-Cookie": buildClearCookie() });
}

// ---------- /api/auth/me ----------
async function handleMe(request, env) {
  const user = await getCurrentUser(request, env);
  if (!user) return jsonResponse({ user: null }, 200);
  return jsonResponse({ user: { ...user, is_admin: isAdmin(user) } }, 200);
}

// ---------- /api/admin/users (GET) ----------
async function handleAdminListUsers(request, env) {
  const user = await getCurrentUser(request, env);
  if (!isAdmin(user)) {
    return jsonResponse({ error: "ไม่มีสิทธิ์เข้าถึงส่วนนี้" }, 403);
  }

  const { results } = await env.DB.prepare(
    "SELECT id, email, full_name, role, status, created_at, approved_at FROM users ORDER BY created_at DESC"
  ).all();

  return jsonResponse({ users: results });
}

// ---------- /api/admin/users/:id (PATCH) ----------
const VALID_ROLES = ["teacher", "executive", "staff", "superadmin"];
const VALID_STATUSES = ["active", "disabled"];

async function handleAdminUpdateUser(request, env, targetId) {
  const admin = await getCurrentUser(request, env);
  if (!isAdmin(admin)) {
    return jsonResponse({ error: "ไม่มีสิทธิ์เข้าถึงส่วนนี้" }, 403);
  }

  if (!targetId) {
    return jsonResponse({ error: "รหัสผู้ใช้ไม่ถูกต้อง" }, 400);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ error: "รูปแบบข้อมูลไม่ถูกต้อง" }, 400);
  }

  const updates = [];
  const values = [];

  if (body.role !== undefined) {
    if (body.role !== null && !VALID_ROLES.includes(body.role)) {
      return jsonResponse({ error: "บทบาทไม่ถูกต้อง" }, 400);
    }
    updates.push("role = ?");
    values.push(body.role);
    if (body.role !== null) {
      updates.push("approved_at = ?", "approved_by = ?");
      values.push(new Date().toISOString(), admin.id);
    }
  }

  if (body.status !== undefined) {
    if (!VALID_STATUSES.includes(body.status)) {
      return jsonResponse({ error: "สถานะไม่ถูกต้อง" }, 400);
    }
    if (targetId === admin.id && body.status === "disabled") {
      return jsonResponse({ error: "ไม่สามารถระงับบัญชีของตัวเองได้" }, 400);
    }
    updates.push("status = ?");
    values.push(body.status);
  }

  if (updates.length === 0) {
    return jsonResponse({ error: "ไม่มีข้อมูลที่จะอัปเดต" }, 400);
  }

  values.push(targetId);
  await env.DB.prepare(`UPDATE users SET ${updates.join(", ")} WHERE id = ?`)
    .bind(...values)
    .run();

  const updated = await env.DB.prepare(
    "SELECT id, email, full_name, role, status, created_at, approved_at FROM users WHERE id = ?"
  )
    .bind(targetId)
    .first();

  return jsonResponse({ user: updated });
}

// ---------- Router ----------
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const { pathname } = url;
    const method = request.method;

    try {
      if (pathname === "/api/auth/register" && method === "POST") return await handleRegister(request, env);
      if (pathname === "/api/auth/login" && method === "POST") return await handleLogin(request, env);
      if (pathname === "/api/auth/logout" && method === "POST") return await handleLogout();
      if (pathname === "/api/auth/me" && method === "GET") return await handleMe(request, env);
      if (pathname === "/api/admin/users" && method === "GET") return await handleAdminListUsers(request, env);

      const adminUserMatch = pathname.match(/^\/api\/admin\/users\/(\d+)$/);
      if (adminUserMatch && method === "PATCH") {
        return await handleAdminUpdateUser(request, env, Number(adminUserMatch[1]));
      }

      if (pathname.startsWith("/api/")) {
        return jsonResponse({ error: "ไม่พบ endpoint นี้" }, 404);
      }
    } catch (err) {
      return jsonResponse({ error: "DEBUG: " + (err && err.stack ? err.stack : String(err)) }, 500);
    }

    // ทุก path อื่นๆ ให้เสิร์ฟไฟล์หน้าเว็บจากโฟลเดอร์ public/ ตามปกติ
    return env.ASSETS.fetch(request);
  },
};
