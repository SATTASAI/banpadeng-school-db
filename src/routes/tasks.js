// โมดูลจัดการงาน: มอบหมายงาน / ติดตามสถานะ
import { jsonResponse, isAdmin } from "../lib/auth.js";

const VALID_PRIORITIES = ["low", "normal", "high", "urgent"];
const VALID_ASSIGNEE_STATUSES = ["pending", "in_progress", "done"];

function isValidDate(str) {
  return /^\d{4}-\d{2}-\d{2}$/.test(str);
}

function parseIdList(raw) {
  if (!Array.isArray(raw)) return [];
  return [...new Set(raw.map(Number).filter((n) => Number.isInteger(n) && n > 0))];
}

async function attachAssignees(env, tasks) {
  if (tasks.length === 0) return tasks;
  const ids = tasks.map((t) => t.id);
  const placeholders = ids.map(() => "?").join(",");
  const { results } = await env.DB.prepare(
    `SELECT ta.task_id, ta.user_id, ta.status, ta.completed_at, u.full_name, u.role
     FROM task_assignees ta
     JOIN users u ON u.id = ta.user_id
     WHERE ta.task_id IN (${placeholders})
     ORDER BY u.full_name COLLATE NOCASE`
  )
    .bind(...ids)
    .all();

  const byTask = {};
  for (const row of results) {
    if (!byTask[row.task_id]) byTask[row.task_id] = [];
    byTask[row.task_id].push({
      user_id: row.user_id,
      full_name: row.full_name,
      role: row.role,
      status: row.status,
      completed_at: row.completed_at,
    });
  }
  return tasks.map((t) => ({ ...t, assignees: byTask[t.id] || [] }));
}

async function getTaskOr404(env, taskId) {
  return env.DB.prepare(
    `SELECT t.*, u.full_name AS creator_name FROM tasks t
     JOIN users u ON u.id = t.created_by WHERE t.id = ?`
  )
    .bind(taskId)
    .first();
}

function canManageTask(user, task) {
  return isAdmin(user) || task.created_by === user.id;
}

async function isAssigneeOfTask(env, taskId, userId) {
  const row = await env.DB.prepare(
    "SELECT 1 FROM task_assignees WHERE task_id = ? AND user_id = ?"
  )
    .bind(taskId, userId)
    .first();
  return !!row;
}

async function validateAssigneeIds(env, ids) {
  const placeholders = ids.map(() => "?").join(",");
  const { results } = await env.DB.prepare(
    `SELECT id FROM users WHERE id IN (${placeholders}) AND status = 'active' AND role IS NOT NULL`
  )
    .bind(...ids)
    .all();
  return results.length === ids.length;
}

// ---------- GET /api/tasks?view=assigned|created|all ----------
export async function handleListTasks(request, env, user) {
  const url = new URL(request.url);
  const view = url.searchParams.get("view") || "assigned";

  const orderClause =
    "ORDER BY CASE WHEN t.status='open' THEN 0 ELSE 1 END, COALESCE(t.due_date, '9999-12-31'), t.created_at DESC";

  let query;
  let params = [];

  if (view === "created") {
    query = `SELECT t.*, u.full_name AS creator_name FROM tasks t
              JOIN users u ON u.id = t.created_by
              WHERE t.created_by = ? ${orderClause}`;
    params = [user.id];
  } else if (view === "all") {
    if (!isAdmin(user)) return jsonResponse({ error: "ไม่มีสิทธิ์เข้าถึงส่วนนี้" }, 403);
    query = `SELECT t.*, u.full_name AS creator_name FROM tasks t
              JOIN users u ON u.id = t.created_by ${orderClause}`;
  } else {
    query = `SELECT t.*, u.full_name AS creator_name FROM tasks t
              JOIN users u ON u.id = t.created_by
              WHERE t.id IN (SELECT task_id FROM task_assignees WHERE user_id = ?) ${orderClause}`;
    params = [user.id];
  }

  const { results } = await env.DB.prepare(query).bind(...params).all();
  const tasks = await attachAssignees(env, results);
  return jsonResponse({ tasks });
}

// ---------- POST /api/tasks ----------
export async function handleCreateTask(request, env, user) {
  let body;
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ error: "รูปแบบข้อมูลไม่ถูกต้อง" }, 400);
  }

  const title = (body.title || "").trim();
  const description = (body.description || "").trim();
  const priority = VALID_PRIORITIES.includes(body.priority) ? body.priority : "normal";
  const dueDate = body.due_date ? String(body.due_date).trim() : null;
  const assigneeIds = parseIdList(body.assignee_ids);

  if (!title) return jsonResponse({ error: "กรุณากรอกชื่องาน" }, 400);
  if (dueDate && !isValidDate(dueDate)) return jsonResponse({ error: "รูปแบบวันที่ไม่ถูกต้อง" }, 400);
  if (assigneeIds.length === 0) return jsonResponse({ error: "กรุณาเลือกผู้รับผิดชอบอย่างน้อย 1 คน" }, 400);
  if (!(await validateAssigneeIds(env, assigneeIds))) {
    return jsonResponse({ error: "มีผู้รับผิดชอบที่ไม่ถูกต้องหรือยังไม่มีสิทธิ์ใช้งาน" }, 400);
  }

  const now = new Date().toISOString();
  const result = await env.DB.prepare(
    `INSERT INTO tasks (title, description, priority, due_date, status, created_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'open', ?, ?, ?)`
  )
    .bind(title, description, priority, dueDate, user.id, now, now)
    .run();

  const taskId = result.meta.last_row_id;

  await env.DB.batch(
    assigneeIds.map((uid) =>
      env.DB.prepare(
        "INSERT INTO task_assignees (task_id, user_id, status) VALUES (?, ?, 'pending')"
      ).bind(taskId, uid)
    )
  );

  const task = await getTaskOr404(env, taskId);
  const [withAssignees] = await attachAssignees(env, [task]);
  return jsonResponse({ task: withAssignees }, 201);
}

// ---------- GET /api/tasks/:id ----------
export async function handleGetTask(request, env, user, taskId) {
  const task = await getTaskOr404(env, taskId);
  if (!task) return jsonResponse({ error: "ไม่พบงานนี้" }, 404);

  if (!canManageTask(user, task) && !(await isAssigneeOfTask(env, taskId, user.id))) {
    return jsonResponse({ error: "ไม่มีสิทธิ์เข้าถึงงานนี้" }, 403);
  }

  const [withAssignees] = await attachAssignees(env, [task]);
  return jsonResponse({ task: withAssignees });
}

// ---------- PATCH /api/tasks/:id ----------
export async function handleUpdateTask(request, env, user, taskId) {
  const task = await getTaskOr404(env, taskId);
  if (!task) return jsonResponse({ error: "ไม่พบงานนี้" }, 404);
  if (!canManageTask(user, task)) return jsonResponse({ error: "ไม่มีสิทธิ์แก้ไขงานนี้" }, 403);

  let body;
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ error: "รูปแบบข้อมูลไม่ถูกต้อง" }, 400);
  }

  const updates = [];
  const values = [];

  if (body.title !== undefined) {
    const title = String(body.title).trim();
    if (!title) return jsonResponse({ error: "กรุณากรอกชื่องาน" }, 400);
    updates.push("title = ?");
    values.push(title);
  }
  if (body.description !== undefined) {
    updates.push("description = ?");
    values.push(String(body.description).trim());
  }
  if (body.priority !== undefined) {
    if (!VALID_PRIORITIES.includes(body.priority)) {
      return jsonResponse({ error: "ระดับความสำคัญไม่ถูกต้อง" }, 400);
    }
    updates.push("priority = ?");
    values.push(body.priority);
  }
  if (body.due_date !== undefined) {
    const dueDate = body.due_date ? String(body.due_date).trim() : null;
    if (dueDate && !isValidDate(dueDate)) return jsonResponse({ error: "รูปแบบวันที่ไม่ถูกต้อง" }, 400);
    updates.push("due_date = ?");
    values.push(dueDate);
  }
  if (body.status !== undefined) {
    if (!["open", "closed"].includes(body.status)) return jsonResponse({ error: "สถานะไม่ถูกต้อง" }, 400);
    updates.push("status = ?");
    values.push(body.status);
  }

  if (updates.length === 0) return jsonResponse({ error: "ไม่มีข้อมูลที่จะอัปเดต" }, 400);

  updates.push("updated_at = ?");
  values.push(new Date().toISOString());
  values.push(taskId);

  await env.DB.prepare(`UPDATE tasks SET ${updates.join(", ")} WHERE id = ?`)
    .bind(...values)
    .run();

  const updated = await getTaskOr404(env, taskId);
  const [withAssignees] = await attachAssignees(env, [updated]);
  return jsonResponse({ task: withAssignees });
}

// ---------- DELETE /api/tasks/:id ----------
export async function handleDeleteTask(request, env, user, taskId) {
  const task = await getTaskOr404(env, taskId);
  if (!task) return jsonResponse({ error: "ไม่พบงานนี้" }, 404);
  if (!canManageTask(user, task)) return jsonResponse({ error: "ไม่มีสิทธิ์ลบงานนี้" }, 403);

  await env.DB.batch([
    env.DB.prepare("DELETE FROM task_assignees WHERE task_id = ?").bind(taskId),
    env.DB.prepare("DELETE FROM tasks WHERE id = ?").bind(taskId),
  ]);

  return jsonResponse({ ok: true });
}

// ---------- POST /api/tasks/:id/assignees ----------
export async function handleAddAssignees(request, env, user, taskId) {
  const task = await getTaskOr404(env, taskId);
  if (!task) return jsonResponse({ error: "ไม่พบงานนี้" }, 404);
  if (!canManageTask(user, task)) return jsonResponse({ error: "ไม่มีสิทธิ์แก้ไขงานนี้" }, 403);

  let body;
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ error: "รูปแบบข้อมูลไม่ถูกต้อง" }, 400);
  }

  const ids = Array.isArray(body.assignee_ids)
    ? parseIdList(body.assignee_ids)
    : parseIdList([body.user_id]);

  if (ids.length === 0) return jsonResponse({ error: "กรุณาเลือกผู้รับผิดชอบ" }, 400);
  if (!(await validateAssigneeIds(env, ids))) {
    return jsonResponse({ error: "มีผู้รับผิดชอบที่ไม่ถูกต้องหรือยังไม่มีสิทธิ์ใช้งาน" }, 400);
  }

  await env.DB.batch(
    ids.map((uid) =>
      env.DB.prepare(
        "INSERT OR IGNORE INTO task_assignees (task_id, user_id, status) VALUES (?, ?, 'pending')"
      ).bind(taskId, uid)
    )
  );

  const updated = await getTaskOr404(env, taskId);
  const [withAssignees] = await attachAssignees(env, [updated]);
  return jsonResponse({ task: withAssignees });
}

// ---------- DELETE /api/tasks/:id/assignees/:userId ----------
export async function handleRemoveAssignee(request, env, user, taskId, targetUserId) {
  const task = await getTaskOr404(env, taskId);
  if (!task) return jsonResponse({ error: "ไม่พบงานนี้" }, 404);
  if (!canManageTask(user, task)) return jsonResponse({ error: "ไม่มีสิทธิ์แก้ไขงานนี้" }, 403);

  await env.DB.prepare("DELETE FROM task_assignees WHERE task_id = ? AND user_id = ?")
    .bind(taskId, targetUserId)
    .run();

  const updated = await getTaskOr404(env, taskId);
  const [withAssignees] = await attachAssignees(env, [updated]);
  return jsonResponse({ task: withAssignees });
}

// ---------- PATCH /api/tasks/:id/assignees/:userId ----------
export async function handleUpdateAssigneeStatus(request, env, user, taskId, targetUserId) {
  const task = await getTaskOr404(env, taskId);
  if (!task) return jsonResponse({ error: "ไม่พบงานนี้" }, 404);

  const isSelf = user.id === targetUserId;
  if (!canManageTask(user, task) && !isSelf) {
    return jsonResponse({ error: "ไม่มีสิทธิ์แก้ไขสถานะนี้" }, 403);
  }
  if (isSelf && !(await isAssigneeOfTask(env, taskId, user.id))) {
    return jsonResponse({ error: "คุณไม่ได้เป็นผู้รับผิดชอบงานนี้" }, 403);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ error: "รูปแบบข้อมูลไม่ถูกต้อง" }, 400);
  }

  if (!VALID_ASSIGNEE_STATUSES.includes(body.status)) {
    return jsonResponse({ error: "สถานะไม่ถูกต้อง" }, 400);
  }

  const completedAt = body.status === "done" ? new Date().toISOString() : null;

  await env.DB.prepare(
    "UPDATE task_assignees SET status = ?, completed_at = ? WHERE task_id = ? AND user_id = ?"
  )
    .bind(body.status, completedAt, taskId, targetUserId)
    .run();

  const updated = await getTaskOr404(env, taskId);
  const [withAssignees] = await attachAssignees(env, [updated]);
  return jsonResponse({ task: withAssignees });
}
