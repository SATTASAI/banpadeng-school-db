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

// ---------- /api/users (GET) — รายชื่อผู้ใช้งานที่ active ไว้เลือกเป็นผู้รับมอบหมาย ----------
async function handleListUsers(request, env) {
  const user = await getCurrentUser(request, env);
  if (!user || !user.role) {
    return jsonResponse({ error: "กรุณาเข้าสู่ระบบ" }, 401);
  }

  const { results } = await env.DB.prepare(
    "SELECT id, full_name, role FROM users WHERE status = 'active' AND role IS NOT NULL ORDER BY full_name"
  ).all();

  return jsonResponse({ users: results });
}

// ---------- /api/tasks (GET) ----------
async function handleListTasks(request, env) {
  const user = await getCurrentUser(request, env);
  if (!user || !user.role) {
    return jsonResponse({ error: "กรุณาเข้าสู่ระบบ" }, 401);
  }

  let taskRows;
  if (isAdmin(user)) {
    taskRows = await env.DB.prepare(
      `SELECT t.*, u.full_name as creator_name FROM tasks t
       JOIN users u ON u.id = t.created_by
       ORDER BY t.status ASC, t.due_date IS NULL, t.due_date ASC, t.created_at DESC`
    ).all();
  } else {
    taskRows = await env.DB.prepare(
      `SELECT DISTINCT t.*, u.full_name as creator_name FROM tasks t
       JOIN users u ON u.id = t.created_by
       LEFT JOIN task_assignees ta ON ta.task_id = t.id
       WHERE t.created_by = ? OR ta.user_id = ?
       ORDER BY t.status ASC, t.due_date IS NULL, t.due_date ASC, t.created_at DESC`
    ).bind(user.id, user.id).all();
  }

  const tasks = taskRows.results;
  if (tasks.length === 0) return jsonResponse({ tasks: [] });

  const taskIds = tasks.map((t) => t.id);
  const placeholders = taskIds.map(() => "?").join(",");
  const { results: assigneeRows } = await env.DB.prepare(
    `SELECT ta.task_id, ta.user_id, ta.status, u.full_name
     FROM task_assignees ta JOIN users u ON u.id = ta.user_id
     WHERE ta.task_id IN (${placeholders})`
  )
    .bind(...taskIds)
    .all();

  const assigneesByTask = {};
  for (const row of assigneeRows) {
    if (!assigneesByTask[row.task_id]) assigneesByTask[row.task_id] = [];
    assigneesByTask[row.task_id].push({
      user_id: row.user_id,
      full_name: row.full_name,
      status: row.status,
    });
  }

  const enriched = tasks.map((t) => ({ ...t, assignees: assigneesByTask[t.id] || [] }));
  return jsonResponse({ tasks: enriched });
}

// ---------- /api/tasks (POST) ----------
async function handleCreateTask(request, env) {
  const user = await getCurrentUser(request, env);
  if (!user || !user.role) {
    return jsonResponse({ error: "กรุณาเข้าสู่ระบบ" }, 401);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ error: "รูปแบบข้อมูลไม่ถูกต้อง" }, 400);
  }

  const title = (body.title || "").trim();
  const description = (body.description || "").trim();
  const priority = ["low", "normal", "high"].includes(body.priority) ? body.priority : "normal";
  const dueDate = body.due_date || null;
  const assigneeIds = Array.isArray(body.assignee_ids) ? body.assignee_ids.map(Number) : [];

  if (!title) {
    return jsonResponse({ error: "กรุณากรอกชื่องาน" }, 400);
  }
  if (assigneeIds.length === 0) {
    return jsonResponse({ error: "กรุณาเลือกผู้รับผิดชอบอย่างน้อย 1 คน" }, 400);
  }

  const result = await env.DB.prepare(
    `INSERT INTO tasks (title, description, priority, due_date, created_by) VALUES (?, ?, ?, ?, ?)`
  )
    .bind(title, description || null, priority, dueDate, user.id)
    .run();

  const taskId = result.meta.last_row_id;

  const inserts = assigneeIds.map((uid) =>
    env.DB.prepare("INSERT INTO task_assignees (task_id, user_id) VALUES (?, ?)").bind(taskId, uid)
  );
  await env.DB.batch(inserts);

  return jsonResponse({ id: taskId }, 201);
}

// ---------- helpers ----------
async function canManageTask(env, user, taskId) {
  if (isAdmin(user)) return true;
  const task = await env.DB.prepare("SELECT created_by FROM tasks WHERE id = ?").bind(taskId).first();
  return !!task && task.created_by === user.id;
}

// ---------- /api/tasks/:id (PATCH) — แก้ไขงาน/ปิดงาน/เปลี่ยนผู้รับผิดชอบ (ผู้สร้างหรือแอดมิน) ----------
async function handleUpdateTask(request, env, taskId) {
  const user = await getCurrentUser(request, env);
  if (!user || !user.role) {
    return jsonResponse({ error: "กรุณาเข้าสู่ระบบ" }, 401);
  }
  if (!(await canManageTask(env, user, taskId))) {
    return jsonResponse({ error: "ไม่มีสิทธิ์แก้ไขงานนี้" }, 403);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ error: "รูปแบบข้อมูลไม่ถูกต้อง" }, 400);
  }

  const updates = [];
  const values = [];
  if (body.title !== undefined) {
    updates.push("title = ?");
    values.push(String(body.title).trim());
  }
  if (body.description !== undefined) {
    updates.push("description = ?");
    values.push(body.description ? String(body.description).trim() : null);
  }
  if (body.priority !== undefined && ["low", "normal", "high"].includes(body.priority)) {
    updates.push("priority = ?");
    values.push(body.priority);
  }
  if (body.due_date !== undefined) {
    updates.push("due_date = ?");
    values.push(body.due_date || null);
  }
  if (body.status !== undefined && ["open", "closed"].includes(body.status)) {
    updates.push("status = ?");
    values.push(body.status);
  }

  if (updates.length > 0) {
    values.push(taskId);
    await env.DB.prepare(`UPDATE tasks SET ${updates.join(", ")} WHERE id = ?`).bind(...values).run();
  }

  if (Array.isArray(body.assignee_ids)) {
    const assigneeIds = body.assignee_ids.map(Number);
    await env.DB.prepare("DELETE FROM task_assignees WHERE task_id = ?").bind(taskId).run();
    if (assigneeIds.length > 0) {
      const inserts = assigneeIds.map((uid) =>
        env.DB.prepare("INSERT INTO task_assignees (task_id, user_id) VALUES (?, ?)").bind(taskId, uid)
      );
      await env.DB.batch(inserts);
    }
  }

  return jsonResponse({ ok: true });
}

// ---------- /api/tasks/:id (DELETE) ----------
async function handleDeleteTask(request, env, taskId) {
  const user = await getCurrentUser(request, env);
  if (!user || !user.role) {
    return jsonResponse({ error: "กรุณาเข้าสู่ระบบ" }, 401);
  }
  if (!(await canManageTask(env, user, taskId))) {
    return jsonResponse({ error: "ไม่มีสิทธิ์ลบงานนี้" }, 403);
  }

  await env.DB.prepare("DELETE FROM task_assignees WHERE task_id = ?").bind(taskId).run();
  await env.DB.prepare("DELETE FROM tasks WHERE id = ?").bind(taskId).run();

  return jsonResponse({ ok: true });
}

// ---------- /api/tasks/:id/status (PATCH) — ผู้รับมอบหมายอัปเดตสถานะของตัวเอง ----------
async function handleUpdateMyTaskStatus(request, env, taskId) {
  const user = await getCurrentUser(request, env);
  if (!user || !user.role) {
    return jsonResponse({ error: "กรุณาเข้าสู่ระบบ" }, 401);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ error: "รูปแบบข้อมูลไม่ถูกต้อง" }, 400);
  }

  if (!["pending", "in_progress", "done"].includes(body.status)) {
    return jsonResponse({ error: "สถานะไม่ถูกต้อง" }, 400);
  }

  const result = await env.DB.prepare(
    "UPDATE task_assignees SET status = ? WHERE task_id = ? AND user_id = ?"
  )
    .bind(body.status, taskId, user.id)
    .run();

  if (result.meta.changes === 0) {
    return jsonResponse({ error: "คุณไม่ได้เป็นผู้รับผิดชอบงานนี้" }, 403);
  }

  return jsonResponse({ ok: true });
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

      if (pathname === "/api/users" && method === "GET") return await handleListUsers(request, env);
      if (pathname === "/api/tasks" && method === "GET") return await handleListTasks(request, env);
      if (pathname === "/api/tasks" && method === "POST") return await handleCreateTask(request, env);

      const taskStatusMatch = pathname.match(/^\/api\/tasks\/(\d+)\/status$/);
      if (taskStatusMatch && method === "PATCH") {
        return await handleUpdateMyTaskStatus(request, env, Number(taskStatusMatch[1]));
      }

      const taskMatch = pathname.match(/^\/api\/tasks\/(\d+)$/);
      if (taskMatch && method === "PATCH") return await handleUpdateTask(request, env, Number(taskMatch[1]));
      if (taskMatch && method === "DELETE") return await handleDeleteTask(request, env, Number(taskMatch[1]));

      if (pathname.startsWith("/api/")) {
        return jsonResponse({ error: "ไม่พบ endpoint นี้" }, 404);
      }
    } catch (err) {
      return jsonResponse({ error: "เกิดข้อผิดพลาดภายในระบบ" }, 500);
    }

    // ทุก path อื่นๆ ให้เสิร์ฟไฟล์หน้าเว็บจากโฟลเดอร์ public/ ตามปกติ
    return env.ASSETS.fetch(request);
  },
};
