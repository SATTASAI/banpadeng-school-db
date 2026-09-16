import {
  generateSalt,
  hashPassword,
  verifyPassword,
  signJWT,
  buildSessionCookie,
  buildClearCookie,
} from "./lib/crypto.js";
import { getCurrentUser, jsonResponse, isAdmin } from "./lib/auth.js";
import { ensurePersonnelData } from "./lib/personnel-data.js";
import { ensureAcademicData, getCurrentAcademicPeriod } from "./lib/academic-data.js";
import { handleAcademicPeriodRoute } from "./routes/academic-periods.js";

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

// ---------- ข้อมูลนักเรียน ----------
function canManageStudents(user) {
  return isAdmin(user) || user.role === "staff";
}

const STUDENT_DETAIL_FIELDS = [
  "weight_kg", "height_cm", "blood_type", "religion", "ethnicity", "nationality",
  "house_number", "village_no", "road_soi", "subdistrict", "district", "province",
  "guardian_prefix", "guardian_first_name", "guardian_last_name", "guardian_occupation",
  "guardian_relationship", "father_prefix", "father_first_name", "father_last_name",
  "father_occupation", "mother_prefix", "mother_first_name", "mother_last_name",
  "mother_occupation", "disadvantage",
];
const STUDENT_DETAIL_NUMBERS = new Set(["weight_kg", "height_cm"]);
let studentDetailsSchemaReady = false;

async function ensureStudentDetailsSchema(env) {
  if (studentDetailsSchemaReady) return;
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS student_details (
    student_id INTEGER PRIMARY KEY REFERENCES students(id) ON DELETE CASCADE,
    weight_kg REAL, height_cm REAL, blood_type TEXT, religion TEXT, ethnicity TEXT, nationality TEXT,
    house_number TEXT, village_no TEXT, road_soi TEXT, subdistrict TEXT, district TEXT, province TEXT,
    guardian_prefix TEXT, guardian_first_name TEXT, guardian_last_name TEXT, guardian_occupation TEXT,
    guardian_relationship TEXT, father_prefix TEXT, father_first_name TEXT, father_last_name TEXT,
    father_occupation TEXT, mother_prefix TEXT, mother_first_name TEXT, mother_last_name TEXT,
    mother_occupation TEXT, disadvantage TEXT,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`).run();
  studentDetailsSchemaReady = true;
}

function normalizeStudentDetail(field, value) {
  const text = value == null ? "" : String(value).trim();
  if (!text) return null;
  if (!STUDENT_DETAIL_NUMBERS.has(field)) return text;
  const number = Number(text.replace(",", "."));
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function getSubmittedStudentDetails(body) {
  return STUDENT_DETAIL_FIELDS
    .filter((field) => Object.prototype.hasOwnProperty.call(body || {}, field))
    .map((field) => ({ field, value: normalizeStudentDetail(field, body[field]) }));
}

function prepareStudentDetailsUpsert(env, studentIdOrCode, details, lookupByCode = false) {
  if (!details.length) return null;
  const fields = details.map((item) => item.field);
  const studentIdSql = lookupByCode ? "(SELECT id FROM students WHERE student_code = ?)" : "?";
  const conflictUpdates = fields.map((field) => `${field} = excluded.${field}`).join(", ");
  const statement = env.DB.prepare(`INSERT INTO student_details (student_id, ${fields.join(", ")}, updated_at)
    VALUES (${studentIdSql}, ${fields.map(() => "?").join(", ")}, datetime('now'))
    ON CONFLICT(student_id) DO UPDATE SET ${conflictUpdates}, updated_at = datetime('now')`);
  return statement.bind(studentIdOrCode, ...details.map((item) => item.value));
}

async function saveStudentDetails(env, studentId, body) {
  const details = getSubmittedStudentDetails(body);
  if (!details.length) return false;
  await ensureStudentDetailsSchema(env);
  await prepareStudentDetailsUpsert(env, studentId, details).run();
  return true;
}

// ---------- /api/students (GET) ----------
async function handleListStudents(request, env) {
  const user = await getCurrentUser(request, env);
  if (!user || !user.role) {
    return jsonResponse({ error: "กรุณาเข้าสู่ระบบ" }, 401);
  }

  const url = new URL(request.url);
  const termId = Number(url.searchParams.get("academic_term_id"));
  let results;
  if (Number.isInteger(termId) && termId > 0) {
    ({ results } = await env.DB.prepare(
      `SELECT s.*, e.grade_level AS grade_level, e.classroom AS classroom, e.status AS status,
              e.academic_year_id, e.academic_term_id
       FROM student_enrollments e JOIN students s ON s.id = e.student_id
       WHERE e.academic_term_id = ? ORDER BY e.classroom, s.full_name`
    ).bind(termId).all());
  } else {
    ({ results } = await env.DB.prepare(
      "SELECT * FROM students ORDER BY classroom, full_name"
    ).all());
  }

  return jsonResponse({ students: results, current_academic_period: await getCurrentAcademicPeriod(env) });
}

// ---------- /api/students/:id (GET) — รวมผู้ปกครอง ----------
async function handleGetStudent(request, env, studentId) {
  const user = await getCurrentUser(request, env);
  if (!user || !user.role) {
    return jsonResponse({ error: "กรุณาเข้าสู่ระบบ" }, 401);
  }

  const student = await env.DB.prepare("SELECT * FROM students WHERE id = ?").bind(studentId).first();
  if (!student) return jsonResponse({ error: "ไม่พบนักเรียน" }, 404);

  await ensureStudentDetailsSchema(env);

  const [guardianResult, details] = await Promise.all([
    env.DB.prepare("SELECT * FROM guardians WHERE student_id = ? ORDER BY is_emergency_contact DESC, id")
      .bind(studentId).all(),
    env.DB.prepare("SELECT * FROM student_details WHERE student_id = ?").bind(studentId).first(),
  ]);

  return jsonResponse({ student: { ...student, ...(details || {}), guardians: guardianResult.results } });
}

// ---------- /api/students (POST) ----------
function composeFullName(prefix, first, last, fallback) {
  const parts = [prefix, first, last].map((v) => (v || "").toString().trim()).filter(Boolean);
  if (parts.length > 0) return parts.join(" ");
  return (fallback || "").toString().trim();
}

async function handleCreateStudent(request, env) {
  const user = await getCurrentUser(request, env);
  if (!user || !user.role) {
    return jsonResponse({ error: "กรุณาเข้าสู่ระบบ" }, 401);
  }
  if (!canManageStudents(user)) {
    return jsonResponse({ error: "ไม่มีสิทธิ์เพิ่มข้อมูลนักเรียน" }, 403);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ error: "รูปแบบข้อมูลไม่ถูกต้อง" }, 400);
  }

  const studentCode = (body.student_code || "").trim();
  const namePrefix = (body.name_prefix || "").trim();
  const firstName = (body.first_name || "").trim();
  const lastName = (body.last_name || "").trim();
  const fullName = composeFullName(namePrefix, firstName, lastName, body.full_name);

  if (!studentCode) return jsonResponse({ error: "กรุณากรอกเลขประจำตัวนักเรียน" }, 400);
  if (!fullName) return jsonResponse({ error: "กรุณากรอกชื่อ-นามสกุลนักเรียน" }, 400);

  const existing = await env.DB.prepare("SELECT id FROM students WHERE student_code = ?")
    .bind(studentCode)
    .first();
  if (existing) return jsonResponse({ error: "เลขประจำตัวนี้ถูกใช้แล้ว" }, 409);

  const result = await env.DB.prepare(
    `INSERT INTO students
       (student_code, full_name, national_id, name_prefix, first_name, last_name, birth_date,
        classroom, grade_level, photo_url, health_conditions, allergies, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'enrolled')`
  )
    .bind(
      studentCode,
      fullName,
      body.national_id || null,
      namePrefix || null,
      firstName || null,
      lastName || null,
      body.birth_date || null,
      body.classroom || null,
      body.grade_level || null,
      body.photo_url || null,
      body.health_conditions || null,
      body.allergies || null
    )
    .run();

  await saveStudentDetails(env, result.meta.last_row_id, body);

  return jsonResponse({ id: result.meta.last_row_id }, 201);
}

// ---------- /api/students/:id (PATCH) ----------
async function handleUpdateStudent(request, env, studentId) {
  const user = await getCurrentUser(request, env);
  if (!user || !user.role) {
    return jsonResponse({ error: "กรุณาเข้าสู่ระบบ" }, 401);
  }
  if (!canManageStudents(user)) {
    return jsonResponse({ error: "ไม่มีสิทธิ์แก้ไขข้อมูลนักเรียน" }, 403);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ error: "รูปแบบข้อมูลไม่ถูกต้อง" }, 400);
  }

  // ถ้ามีการส่งชื่อแบบแยกส่วนมา ให้คำนวณ full_name ใหม่จากส่วนนั้นเสมอ
  if (body.name_prefix !== undefined || body.first_name !== undefined || body.last_name !== undefined) {
    body.full_name = composeFullName(body.name_prefix, body.first_name, body.last_name, body.full_name);
  }

  const fields = [
    "full_name",
    "national_id",
    "name_prefix",
    "first_name",
    "last_name",
    "birth_date",
    "classroom",
    "grade_level",
    "photo_url",
    "health_conditions",
    "allergies",
    "status",
  ];
  const updates = [];
  const values = [];
  for (const f of fields) {
    if (body[f] !== undefined) {
      updates.push(`${f} = ?`);
      values.push(body[f] || null);
    }
  }

  const hasStudentDetails = getSubmittedStudentDetails(body).length > 0;
  if (updates.length === 0 && !hasStudentDetails) return jsonResponse({ error: "ไม่มีข้อมูลที่จะอัปเดต" }, 400);

  if (updates.length > 0) {
    values.push(studentId);
    await env.DB.prepare(`UPDATE students SET ${updates.join(", ")} WHERE id = ?`).bind(...values).run();
  }
  if (hasStudentDetails) await saveStudentDetails(env, studentId, body);

  return jsonResponse({ ok: true });
}

// ---------- /api/students/:id (DELETE) ----------
async function handleDeleteStudent(request, env, studentId) {
  const user = await getCurrentUser(request, env);
  if (!user || !user.role) {
    return jsonResponse({ error: "กรุณาเข้าสู่ระบบ" }, 401);
  }
  if (!isAdmin(user)) {
    return jsonResponse({ error: "ไม่มีสิทธิ์ลบข้อมูลนักเรียน" }, 403);
  }

  await ensureStudentDetailsSchema(env);
  await env.DB.prepare("DELETE FROM student_details WHERE student_id = ?").bind(studentId).run();
  await env.DB.prepare("DELETE FROM guardians WHERE student_id = ?").bind(studentId).run();
  await env.DB.prepare("DELETE FROM students WHERE id = ?").bind(studentId).run();

  return jsonResponse({ ok: true });
}

// ---------- /api/students/:id/guardians (POST) ----------
async function handleAddGuardian(request, env, studentId) {
  const user = await getCurrentUser(request, env);
  if (!user || !user.role) {
    return jsonResponse({ error: "กรุณาเข้าสู่ระบบ" }, 401);
  }
  if (!canManageStudents(user)) {
    return jsonResponse({ error: "ไม่มีสิทธิ์เพิ่มผู้ปกครอง" }, 403);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ error: "รูปแบบข้อมูลไม่ถูกต้อง" }, 400);
  }

  const fullName = (body.full_name || "").trim();
  if (!fullName) return jsonResponse({ error: "กรุณากรอกชื่อผู้ปกครอง" }, 400);

  const result = await env.DB.prepare(
    `INSERT INTO guardians (student_id, full_name, relationship, phone, is_emergency_contact)
     VALUES (?, ?, ?, ?, ?)`
  )
    .bind(studentId, fullName, body.relationship || null, body.phone || null, body.is_emergency_contact ? 1 : 0)
    .run();

  return jsonResponse({ id: result.meta.last_row_id }, 201);
}

// ---------- /api/guardians/:id (PATCH) ----------
async function handleUpdateGuardian(request, env, guardianId) {
  const user = await getCurrentUser(request, env);
  if (!user || !user.role) {
    return jsonResponse({ error: "กรุณาเข้าสู่ระบบ" }, 401);
  }
  if (!canManageStudents(user)) {
    return jsonResponse({ error: "ไม่มีสิทธิ์แก้ไขผู้ปกครอง" }, 403);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ error: "รูปแบบข้อมูลไม่ถูกต้อง" }, 400);
  }

  const fields = ["full_name", "relationship", "phone"];
  const updates = [];
  const values = [];
  for (const f of fields) {
    if (body[f] !== undefined) {
      updates.push(`${f} = ?`);
      values.push(body[f] || null);
    }
  }
  if (body.is_emergency_contact !== undefined) {
    updates.push("is_emergency_contact = ?");
    values.push(body.is_emergency_contact ? 1 : 0);
  }
  if (updates.length === 0) return jsonResponse({ error: "ไม่มีข้อมูลที่จะอัปเดต" }, 400);

  values.push(guardianId);
  await env.DB.prepare(`UPDATE guardians SET ${updates.join(", ")} WHERE id = ?`).bind(...values).run();

  return jsonResponse({ ok: true });
}

// ---------- /api/guardians/:id (DELETE) ----------
async function handleDeleteGuardian(request, env, guardianId) {
  const user = await getCurrentUser(request, env);
  if (!user || !user.role) {
    return jsonResponse({ error: "กรุณาเข้าสู่ระบบ" }, 401);
  }
  if (!canManageStudents(user)) {
    return jsonResponse({ error: "ไม่มีสิทธิ์ลบผู้ปกครอง" }, 403);
  }

  await env.DB.prepare("DELETE FROM guardians WHERE id = ?").bind(guardianId).run();
  return jsonResponse({ ok: true });
}

// ---------- ข้อมูลครู/บุคลากร ----------

// ---------- /api/staff (GET) — ทำเนียบบุคลากร ----------
async function handleListStaff(request, env) {
  const user = await getCurrentUser(request, env);
  if (!user || !user.role) {
    return jsonResponse({ error: "กรุณาเข้าสู่ระบบ" }, 401);
  }

  await ensurePersonnelData(env);

  const { results } = await env.DB.prepare(
    `SELECT p.id, p.user_id, p.prefix, p.first_name, p.last_name, p.full_name,
            COALESCE(p.email, u.email) AS email, u.role,
            p.position, p.subjects, p.phone, p.homeroom_classroom,
            p.license_issue_date, p.license_expiry_date,
            p.source_file, p.source_sheet, p.source_row
     FROM personnel_records p
     LEFT JOIN users u ON u.id = p.user_id
     WHERE p.status = 'active'
     ORDER BY p.first_name, p.full_name`
  ).all();

  return jsonResponse({ staff: results });
}

// ---------- /api/staff/:id (PATCH) — แก้ไขข้อมูลตำแหน่ง/วิชา/ติดต่อ ----------
async function handleUpdateStaff(request, env, targetId) {
  const user = await getCurrentUser(request, env);
  if (!user || !user.role) {
    return jsonResponse({ error: "กรุณาเข้าสู่ระบบ" }, 401);
  }
  await ensurePersonnelData(env);

  const target = await env.DB.prepare("SELECT id, user_id FROM personnel_records WHERE id = ? AND status = 'active'")
    .bind(targetId)
    .first();
  if (!target) return jsonResponse({ error: "ไม่พบบุคลากรนี้" }, 404);
  if (!isAdmin(user) && user.id !== target.user_id) {
    return jsonResponse({ error: "แก้ไขได้เฉพาะข้อมูลของตัวเอง หรือต้องเป็นผู้ดูแลระบบ/ผู้บริหาร" }, 403);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ error: "รูปแบบข้อมูลไม่ถูกต้อง" }, 400);
  }

  const position = body.position || null;
  const subjects = body.subjects || null;
  const phone = body.phone || null;
  const homeroom_classroom = body.homeroom_classroom || null;
  const license_issue_date = body.license_issue_date || null;
  const license_expiry_date = body.license_expiry_date || null;

  await env.DB.prepare(
    `UPDATE personnel_records SET
       position = ?, subjects = ?, phone = ?, homeroom_classroom = ?,
       license_issue_date = ?, license_expiry_date = ?, updated_at = datetime('now')
     WHERE id = ?`
  )
    .bind(position, subjects, phone, homeroom_classroom, license_issue_date, license_expiry_date, targetId)
    .run();

  return jsonResponse({ ok: true });
}

// ---------- รายงาน ----------

// ---------- /api/reports/summary (GET) ----------
async function handleReportsSummary(request, env) {
  const user = await getCurrentUser(request, env);
  if (!user || !user.role) {
    return jsonResponse({ error: "กรุณาเข้าสู่ระบบ" }, 401);
  }

  const openTasks = await env.DB.prepare("SELECT COUNT(*) as count FROM tasks WHERE status = 'open'").first();
  const overdueTasks = await env.DB.prepare(
    "SELECT COUNT(*) as count FROM tasks WHERE status = 'open' AND due_date IS NOT NULL AND due_date < date('now')"
  ).first();

  const { results: tasksByAssignee } = await env.DB.prepare(
    `SELECT u.full_name,
            SUM(CASE WHEN ta.status != 'done' THEN 1 ELSE 0 END) as pending_count,
            SUM(CASE WHEN ta.status != 'done' AND t.due_date IS NOT NULL AND t.due_date < date('now') THEN 1 ELSE 0 END) as overdue_count
     FROM task_assignees ta
     JOIN users u ON u.id = ta.user_id
     JOIN tasks t ON t.id = ta.task_id
     WHERE t.status = 'open'
     GROUP BY u.id
     HAVING pending_count > 0
     ORDER BY pending_count DESC`
  ).all();

  const { results: studentsByStatus } = await env.DB.prepare(
    "SELECT status, COUNT(*) as count FROM students GROUP BY status"
  ).all();

  const { results: studentsByClassroom } = await env.DB.prepare(
    `SELECT COALESCE(classroom, 'ไม่ระบุห้อง') as classroom, COUNT(*) as count
     FROM students WHERE status = 'enrolled'
     GROUP BY classroom ORDER BY classroom`
  ).all();

  const staffCount = await env.DB.prepare(
    "SELECT COUNT(*) as count FROM users WHERE status = 'active' AND role IS NOT NULL"
  ).first();

  return jsonResponse({
    open_tasks: openTasks.count,
    overdue_tasks: overdueTasks.count,
    tasks_by_assignee: tasksByAssignee,
    students_by_status: studentsByStatus,
    students_by_classroom: studentsByClassroom,
    staff_count: staffCount.count,
  });
}

// ---------- 4 ฝ่ายงาน ----------
const DEPARTMENTS = ["academic", "budget", "personnel", "general"];

async function isProjectOwner(env, user, projectId) {
  if (isAdmin(user)) return true;
  const row = await env.DB.prepare("SELECT 1 FROM project_owners WHERE project_id = ? AND user_id = ?")
    .bind(projectId, user.id)
    .first();
  return !!row;
}

// ---------- /api/departments/:dept/projects (GET) ----------
async function handleListProjects(request, env, department) {
  const user = await getCurrentUser(request, env);
  if (!user || !user.role) return jsonResponse({ error: "กรุณาเข้าสู่ระบบ" }, 401);
  if (!DEPARTMENTS.includes(department)) return jsonResponse({ error: "ไม่พบฝ่ายงานนี้" }, 404);

  const { results: projects } = await env.DB.prepare(
    "SELECT * FROM projects WHERE department = ? ORDER BY status ASC, created_at DESC"
  )
    .bind(department)
    .all();

  if (projects.length === 0) return jsonResponse({ projects: [] });

  const ids = projects.map((p) => p.id);
  const placeholders = ids.map(() => "?").join(",");
  const { results: ownerRows } = await env.DB.prepare(
    `SELECT po.project_id, u.id as user_id, u.full_name
     FROM project_owners po JOIN users u ON u.id = po.user_id
     WHERE po.project_id IN (${placeholders})`
  )
    .bind(...ids)
    .all();

  const ownersByProject = {};
  for (const row of ownerRows) {
    if (!ownersByProject[row.project_id]) ownersByProject[row.project_id] = [];
    ownersByProject[row.project_id].push({ user_id: row.user_id, full_name: row.full_name });
  }

  const enriched = projects.map((p) => ({ ...p, owners: ownersByProject[p.id] || [] }));
  return jsonResponse({ projects: enriched });
}

// ---------- /api/departments/:dept/projects (POST) ----------
async function handleCreateProject(request, env, department) {
  const user = await getCurrentUser(request, env);
  if (!user || !user.role) return jsonResponse({ error: "กรุณาเข้าสู่ระบบ" }, 401);
  if (!DEPARTMENTS.includes(department)) return jsonResponse({ error: "ไม่พบฝ่ายงานนี้" }, 404);
  if (!isAdmin(user)) return jsonResponse({ error: "เฉพาะผู้บริหาร/ผู้ดูแลระบบเท่านั้นที่สร้างโครงการได้" }, 403);

  let body;
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ error: "รูปแบบข้อมูลไม่ถูกต้อง" }, 400);
  }

  const name = (body.name || "").trim();
  if (!name) return jsonResponse({ error: "กรุณากรอกชื่อโครงการ" }, 400);

  const ownerIds = Array.isArray(body.owner_ids) ? body.owner_ids.map(Number) : [];

  const result = await env.DB.prepare(
    `INSERT INTO projects (department, name, budget_amount, description, created_by)
     VALUES (?, ?, ?, ?, ?)`
  )
    .bind(department, name, body.budget_amount || null, body.description || null, user.id)
    .run();

  const projectId = result.meta.last_row_id;

  if (ownerIds.length > 0) {
    const inserts = ownerIds.map((uid) =>
      env.DB.prepare("INSERT INTO project_owners (project_id, user_id) VALUES (?, ?)").bind(projectId, uid)
    );
    await env.DB.batch(inserts);
  }

  return jsonResponse({ id: projectId }, 201);
}

// ---------- /api/projects/:id (PATCH) ----------
async function handleUpdateProject(request, env, projectId) {
  const user = await getCurrentUser(request, env);
  if (!user || !user.role) return jsonResponse({ error: "กรุณาเข้าสู่ระบบ" }, 401);
  if (!(await isProjectOwner(env, user, projectId))) {
    return jsonResponse({ error: "เฉพาะผู้ดูแลโครงการเท่านั้นที่แก้ไขได้" }, 403);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ error: "รูปแบบข้อมูลไม่ถูกต้อง" }, 400);
  }

  const updates = [];
  const values = [];
  if (body.name !== undefined) {
    updates.push("name = ?");
    values.push(String(body.name).trim());
  }
  if (body.budget_amount !== undefined) {
    updates.push("budget_amount = ?");
    values.push(body.budget_amount === "" ? null : body.budget_amount);
  }
  if (body.progress_percent !== undefined) {
    const p = Number(body.progress_percent);
    if (!(p >= 0 && p <= 100)) return jsonResponse({ error: "% ความคืบหน้าต้องอยู่ระหว่าง 0-100" }, 400);
    updates.push("progress_percent = ?");
    values.push(p);
  }
  if (body.status !== undefined && ["ongoing", "completed", "cancelled"].includes(body.status)) {
    updates.push("status = ?");
    values.push(body.status);
  }
  if (body.description !== undefined) {
    updates.push("description = ?");
    values.push(body.description || null);
  }

  if (updates.length > 0) {
    values.push(projectId);
    await env.DB.prepare(`UPDATE projects SET ${updates.join(", ")} WHERE id = ?`).bind(...values).run();
  }

  if (isAdmin(user) && Array.isArray(body.owner_ids)) {
    const ownerIds = body.owner_ids.map(Number);
    await env.DB.prepare("DELETE FROM project_owners WHERE project_id = ?").bind(projectId).run();
    if (ownerIds.length > 0) {
      const inserts = ownerIds.map((uid) =>
        env.DB.prepare("INSERT INTO project_owners (project_id, user_id) VALUES (?, ?)").bind(projectId, uid)
      );
      await env.DB.batch(inserts);
    }
  }

  return jsonResponse({ ok: true });
}

// ---------- /api/projects/:id (DELETE) ----------
async function handleDeleteProject(request, env, projectId) {
  const user = await getCurrentUser(request, env);
  if (!user || !user.role) return jsonResponse({ error: "กรุณาเข้าสู่ระบบ" }, 401);
  if (!isAdmin(user)) return jsonResponse({ error: "เฉพาะผู้บริหาร/ผู้ดูแลระบบเท่านั้นที่ลบโครงการได้" }, 403);

  await env.DB.prepare("DELETE FROM project_owners WHERE project_id = ?").bind(projectId).run();
  await env.DB.prepare("DELETE FROM projects WHERE id = ?").bind(projectId).run();
  return jsonResponse({ ok: true });
}

// ---------- /api/departments/:dept/topics (GET) ----------
async function handleListTopics(request, env, department) {
  const user = await getCurrentUser(request, env);
  if (!user || !user.role) return jsonResponse({ error: "กรุณาเข้าสู่ระบบ" }, 401);
  if (!DEPARTMENTS.includes(department)) return jsonResponse({ error: "ไม่พบฝ่ายงานนี้" }, 404);

  const { results } = await env.DB.prepare(
    "SELECT * FROM work_topics WHERE department = ? ORDER BY title"
  )
    .bind(department)
    .all();

  return jsonResponse({ topics: results });
}

// ---------- /api/departments/:dept/topics (POST) ----------
async function handleCreateTopic(request, env, department) {
  const user = await getCurrentUser(request, env);
  if (!user || !user.role) return jsonResponse({ error: "กรุณาเข้าสู่ระบบ" }, 401);
  if (!DEPARTMENTS.includes(department)) return jsonResponse({ error: "ไม่พบฝ่ายงานนี้" }, 404);
  if (!isAdmin(user)) return jsonResponse({ error: "เฉพาะผู้บริหาร/ผู้ดูแลระบบเท่านั้นที่เพิ่มหัวข้องานได้" }, 403);

  let body;
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ error: "รูปแบบข้อมูลไม่ถูกต้อง" }, 400);
  }

  const title = (body.title || "").trim();
  if (!title) return jsonResponse({ error: "กรุณากรอกชื่อหัวข้องาน" }, 400);

  const result = await env.DB.prepare(
    "INSERT INTO work_topics (department, title, description, created_by) VALUES (?, ?, ?, ?)"
  )
    .bind(department, title, body.description || null, user.id)
    .run();

  return jsonResponse({ id: result.meta.last_row_id }, 201);
}

// ---------- /api/topics/:id (PATCH) ----------
async function handleUpdateTopic(request, env, topicId) {
  const user = await getCurrentUser(request, env);
  if (!user || !user.role) return jsonResponse({ error: "กรุณาเข้าสู่ระบบ" }, 401);
  if (!isAdmin(user)) return jsonResponse({ error: "เฉพาะผู้บริหาร/ผู้ดูแลระบบเท่านั้นที่แก้ไขได้" }, 403);

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
    values.push(body.description || null);
  }
  if (updates.length === 0) return jsonResponse({ error: "ไม่มีข้อมูลที่จะอัปเดต" }, 400);

  values.push(topicId);
  await env.DB.prepare(`UPDATE work_topics SET ${updates.join(", ")} WHERE id = ?`).bind(...values).run();
  return jsonResponse({ ok: true });
}

// ---------- /api/topics/:id (DELETE) ----------
async function handleDeleteTopic(request, env, topicId) {
  const user = await getCurrentUser(request, env);
  if (!user || !user.role) return jsonResponse({ error: "กรุณาเข้าสู่ระบบ" }, 401);
  if (!isAdmin(user)) return jsonResponse({ error: "เฉพาะผู้บริหาร/ผู้ดูแลระบบเท่านั้นที่ลบได้" }, 403);

  await env.DB.prepare("DELETE FROM work_topics WHERE id = ?").bind(topicId).run();
  return jsonResponse({ ok: true });
}

// ---------- วันลา ----------
const LEAVE_TYPES = ["sick", "personal", "maternity", "other"];

// ---------- /api/leave-requests (GET) ----------
async function handleListLeaveRequests(request, env) {
  const user = await getCurrentUser(request, env);
  if (!user || !user.role) return jsonResponse({ error: "กรุณาเข้าสู่ระบบ" }, 401);

  let query, binds;
  if (isAdmin(user)) {
    query = `SELECT lr.*, u.full_name, ap.full_name as approver_name
              FROM leave_requests lr
              JOIN users u ON u.id = lr.user_id
              LEFT JOIN users ap ON ap.id = lr.approved_by
              ORDER BY lr.status ASC, lr.created_at DESC`;
    binds = [];
  } else {
    query = `SELECT lr.*, u.full_name, ap.full_name as approver_name
              FROM leave_requests lr
              JOIN users u ON u.id = lr.user_id
              LEFT JOIN users ap ON ap.id = lr.approved_by
              WHERE lr.user_id = ?
              ORDER BY lr.created_at DESC`;
    binds = [user.id];
  }

  const { results } = await env.DB.prepare(query).bind(...binds).all();
  return jsonResponse({ leave_requests: results });
}

// ---------- /api/leave-requests (POST) ----------
async function handleCreateLeaveRequest(request, env) {
  const user = await getCurrentUser(request, env);
  if (!user || !user.role) return jsonResponse({ error: "กรุณาเข้าสู่ระบบ" }, 401);

  let body;
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ error: "รูปแบบข้อมูลไม่ถูกต้อง" }, 400);
  }

  const leaveType = body.leave_type;
  if (!LEAVE_TYPES.includes(leaveType)) return jsonResponse({ error: "กรุณาเลือกประเภทการลา" }, 400);

  const reason = (body.reason || "").trim();
  if (leaveType === "other" && !reason) {
    return jsonResponse({ error: "กรุณาระบุเหตุผลเมื่อเลือกประเภท 'อื่นๆ'" }, 400);
  }

  if (!body.start_date || !body.end_date) {
    return jsonResponse({ error: "กรุณาระบุวันที่เริ่มและสิ้นสุดการลา" }, 400);
  }
  if (body.end_date < body.start_date) {
    return jsonResponse({ error: "วันที่สิ้นสุดต้องไม่ก่อนวันที่เริ่ม" }, 400);
  }

  const result = await env.DB.prepare(
    `INSERT INTO leave_requests (user_id, leave_type, reason, start_date, end_date)
     VALUES (?, ?, ?, ?, ?)`
  )
    .bind(user.id, leaveType, reason || null, body.start_date, body.end_date)
    .run();

  return jsonResponse({ id: result.meta.last_row_id }, 201);
}

// ---------- /api/leave-requests/:id (PATCH) — อนุมัติ/ไม่อนุมัติ (admin เท่านั้น) ----------
async function handleUpdateLeaveRequest(request, env, leaveId) {
  const user = await getCurrentUser(request, env);
  if (!user || !user.role) return jsonResponse({ error: "กรุณาเข้าสู่ระบบ" }, 401);
  if (!isAdmin(user)) return jsonResponse({ error: "เฉพาะผู้บริหาร/ผู้ดูแลระบบเท่านั้นที่อนุมัติได้" }, 403);

  let body;
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ error: "รูปแบบข้อมูลไม่ถูกต้อง" }, 400);
  }

  if (!["approved", "rejected"].includes(body.status)) {
    return jsonResponse({ error: "สถานะไม่ถูกต้อง" }, 400);
  }

  await env.DB.prepare(
    "UPDATE leave_requests SET status = ?, approved_by = ?, approved_at = ? WHERE id = ?"
  )
    .bind(body.status, user.id, new Date().toISOString(), leaveId)
    .run();

  return jsonResponse({ ok: true });
}

// ---------- /api/leave-requests/:id (DELETE) — ผู้ยื่นยกเลิกคำขอที่ยังรอดำเนินการ ----------
async function handleDeleteLeaveRequest(request, env, leaveId) {
  const user = await getCurrentUser(request, env);
  if (!user || !user.role) return jsonResponse({ error: "กรุณาเข้าสู่ระบบ" }, 401);

  const row = await env.DB.prepare("SELECT user_id, status FROM leave_requests WHERE id = ?")
    .bind(leaveId)
    .first();
  if (!row) return jsonResponse({ error: "ไม่พบคำขอลานี้" }, 404);
  if (row.user_id !== user.id && !isAdmin(user)) {
    return jsonResponse({ error: "ไม่มีสิทธิ์ยกเลิกคำขอนี้" }, 403);
  }
  if (row.status !== "pending" && !isAdmin(user)) {
    return jsonResponse({ error: "ยกเลิกได้เฉพาะคำขอที่ยังรอดำเนินการ" }, 400);
  }

  await env.DB.prepare("DELETE FROM leave_requests WHERE id = ?").bind(leaveId).run();
  return jsonResponse({ ok: true });
}

// ---------- /api/overview (GET) — ภาพรวมสำหรับหน้าแดชบอร์ด ----------
async function handleOverview(request, env) {
  const user = await getCurrentUser(request, env);
  if (!user || !user.role) return jsonResponse({ error: "กรุณาเข้าสู่ระบบ" }, 401);

  await Promise.all([ensurePersonnelData(env), ensureAcademicData(env)]);
  const currentAcademicPeriod = await getCurrentAcademicPeriod(env);

  const studentsEnrolled = await env.DB.prepare(
    "SELECT COUNT(*) as count FROM students WHERE status = 'enrolled'"
  ).first();
  const staffCount = await env.DB.prepare(
    "SELECT COUNT(*) as count FROM personnel_records WHERE status = 'active'"
  ).first();
  const openTasks = await env.DB.prepare("SELECT COUNT(*) as count FROM tasks WHERE status = 'open'").first();
  const overdueTasks = await env.DB.prepare(
    "SELECT COUNT(*) as count FROM tasks WHERE status = 'open' AND due_date IS NOT NULL AND due_date < date('now')"
  ).first();
  const ongoingProjects = await env.DB.prepare(
    "SELECT COUNT(*) as count FROM projects WHERE status = 'ongoing'"
  ).first();
  const pendingLeave = await env.DB.prepare(
    "SELECT COUNT(*) as count FROM leave_requests WHERE status = 'pending'"
  ).first();
  const { results: departmentRows } = await env.DB.prepare(
    `SELECT department,
            COUNT(*) AS project_count,
            ROUND(AVG(progress_percent), 0) AS average_progress,
            COALESCE(SUM(budget_amount), 0) AS total_budget
     FROM projects
     GROUP BY department`
  ).all();

  const { results: licensesExpiring } = await env.DB.prepare(
    `SELECT full_name, license_expiry_date,
            CAST(julianday(license_expiry_date) - julianday(date('now')) AS INTEGER) AS days_remaining
     FROM personnel_records
     WHERE status = 'active'
       AND license_expiry_date IS NOT NULL
     ORDER BY days_remaining ASC, full_name ASC`
  ).all();

  const departmentMap = Object.fromEntries(departmentRows.map((row) => [row.department, row]));
  const departmentSummary = DEPARTMENTS.map((department) => {
    const row = departmentMap[department];
    return {
      department,
      project_count: Number(row?.project_count || 0),
      average_progress: Number(row?.average_progress || 0),
      total_budget: Number(row?.total_budget || 0),
    };
  });

  return jsonResponse({
    students_enrolled: studentsEnrolled.count,
    staff_count: staffCount.count,
    open_tasks: openTasks.count,
    overdue_tasks: overdueTasks.count,
    ongoing_projects: ongoingProjects.count,
    pending_leave_requests: pendingLeave.count,
    total_project_budget: departmentSummary.reduce((sum, row) => sum + row.total_budget, 0),
    department_summary: departmentSummary,
    licenses_expiring: licensesExpiring,
    current_academic_period: currentAcademicPeriod,
  });
}

// ---------- /api/students/import (POST) — นำเข้าจาก Excel/CSV แบบ upsert ตามเลขประจำตัว ----------
async function handleImportStudents(request, env) {
  const user = await getCurrentUser(request, env);
  if (!user || !user.role) return jsonResponse({ error: "กรุณาเข้าสู่ระบบ" }, 401);
  if (!canManageStudents(user)) return jsonResponse({ error: "ไม่มีสิทธิ์นำเข้าข้อมูลนักเรียน" }, 403);

  let body;
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ error: "รูปแบบข้อมูลไม่ถูกต้อง" }, 400);
  }
  if (!body || !Array.isArray(body.rows) || body.rows.length === 0) {
    return jsonResponse({ error: "ไม่พบรายการนักเรียนสำหรับนำเข้า" }, 400);
  }
  if (body.rows.length > 20) {
    return jsonResponse({ error: "รับข้อมูลได้ครั้งละไม่เกิน 20 รายการ กรุณารีเฟรชหน้าเว็บเพื่อใช้ระบบแบ่งชุดอัตโนมัติ" }, 400);
  }

  const skipped = [];
  const validRows = [];
  const asText = (value) => value == null ? "" : String(value).trim();
  body.rows.forEach((row, index) => {
    if (!row || typeof row !== "object" || Array.isArray(row)) {
      skipped.push({ row: index + 1, reason: "รูปแบบข้อมูลไม่ถูกต้อง" });
      return;
    }
    const studentCode = asText(row.student_code);
    const prefix = asText(row.name_prefix);
    const first = asText(row.first_name);
    const last = asText(row.last_name);
    const fullName = composeFullName(prefix, first, last, row.full_name);
    if (!studentCode || !fullName) {
      skipped.push({ row: index + 1, reason: "ไม่มีเลขประจำตัวหรือชื่อ-นามสกุล" });
      return;
    }
    validRows.push({
      baseValues: [
        studentCode, fullName, asText(row.national_id) || null,
        prefix || null, first || null, last || null, asText(row.birth_date) || null,
        asText(row.classroom) || null, asText(row.grade_level) || null,
        asText(row.health_conditions) || null, asText(row.allergies) || null,
        asText(row.photo_url) || null,
      ],
      details: getSubmittedStudentDetails(row),
    });
  });
  if (!validRows.length) return jsonResponse({ created: 0, updated: 0, skipped });

  try {
    await ensureStudentDetailsSchema(env);
    // One lookup plus at most two writes per student (ทะเบียนหลัก + ข้อมูลเพิ่มเติม).
    const codes = [...new Set(validRows.map((row) => row.baseValues[0]))];
    const { results } = await env.DB.prepare(
      `SELECT student_code FROM students WHERE student_code IN (${codes.map(() => "?").join(",")})`
    ).bind(...codes).all();
    const knownCodes = new Set(results.map((row) => row.student_code));
    let created = 0;
    let updated = 0;
    const statements = [];
    validRows.forEach(({ baseValues: values, details }) => {
      if (knownCodes.has(values[0])) updated++;
      else { created++; knownCodes.add(values[0]); }
      // Retrying a committed batch updates the same student codes, without duplicates.
      statements.push(env.DB.prepare(`INSERT INTO students
        (student_code, full_name, national_id, name_prefix, first_name, last_name, birth_date,
         classroom, grade_level, health_conditions, allergies, photo_url, status)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'enrolled')
        ON CONFLICT(student_code) DO UPDATE SET
          full_name = excluded.full_name,
          national_id = COALESCE(excluded.national_id, students.national_id),
          name_prefix = COALESCE(excluded.name_prefix, students.name_prefix),
          first_name = COALESCE(excluded.first_name, students.first_name),
          last_name = COALESCE(excluded.last_name, students.last_name),
          birth_date = COALESCE(excluded.birth_date, students.birth_date),
          classroom = COALESCE(excluded.classroom, students.classroom),
          grade_level = COALESCE(excluded.grade_level, students.grade_level),
          health_conditions = COALESCE(excluded.health_conditions, students.health_conditions),
          allergies = COALESCE(excluded.allergies, students.allergies),
          photo_url = COALESCE(excluded.photo_url, students.photo_url)`).bind(...values));
      const detailStatement = prepareStudentDetailsUpsert(env, values[0], details, true);
      if (detailStatement) statements.push(detailStatement);
    });
    // D1 batch is transactional: an error rolls back every write in this batch.
    await env.DB.batch(statements);
    return jsonResponse({ created, updated, skipped });
  } catch (err) {
    const message = String(err && err.message || "");
    if (/no such column|has no column named/i.test(message)) {
      return jsonResponse({ error: "ฐานข้อมูลนักเรียนยังขาดคอลัมน์ที่ระบบต้องใช้ กรุณาให้ผู้ดูแลตรวจและเพิ่มคอลัมน์ตามคู่มือก่อนนำเข้าต่อ" }, 500);
    }
    return jsonResponse({ error: "บันทึกชุดนี้ไม่สำเร็จ กรุณาลองนำเข้าต่อจากชุดที่ค้าง หากยังไม่สำเร็จให้ผู้ดูแลตรวจฐานข้อมูลและข้อจำกัดการใช้งาน" }, 500);
  }
}

// ---------- /api/staff/import (POST) — นำเข้าโปรไฟล์บุคลากรจาก Excel/CSV โดยจับคู่ด้วยอีเมล ----------
async function handleImportStaff(request, env) {
  const user = await getCurrentUser(request, env);
  if (!user || !user.role) return jsonResponse({ error: "กรุณาเข้าสู่ระบบ" }, 401);
  if (!isAdmin(user)) return jsonResponse({ error: "เฉพาะผู้บริหาร/ผู้ดูแลระบบเท่านั้นที่นำเข้าข้อมูลบุคลากรได้" }, 403);

  let body;
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ error: "รูปแบบข้อมูลไม่ถูกต้อง" }, 400);
  }

  const rows = Array.isArray(body.rows) ? body.rows : [];
  let updated = 0;
  const skipped = [];

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const email = (row.email || "").toString().trim().toLowerCase();

    if (!email) {
      skipped.push({ row: i + 1, reason: "ไม่มีอีเมล" });
      continue;
    }

    const target = await env.DB.prepare(
      "SELECT id FROM users WHERE email = ? AND status = 'active' AND role IS NOT NULL"
    )
      .bind(email)
      .first();

    if (!target) {
      skipped.push({ row: i + 1, reason: `ไม่พบผู้ใช้งานอีเมล ${email} ในระบบ` });
      continue;
    }

    const position = row.position ? String(row.position).trim() : null;
    const subjects = row.subjects ? String(row.subjects).trim() : null;
    const phone = row.phone ? String(row.phone).trim() : null;
    const homeroom_classroom = row.homeroom_classroom ? String(row.homeroom_classroom).trim() : null;
    const license_expiry_date = row.license_expiry_date ? String(row.license_expiry_date).trim() : null;

    await env.DB.prepare(
      `INSERT INTO staff_profiles (user_id, position, subjects, phone, homeroom_classroom, license_expiry_date)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(user_id) DO UPDATE SET
         position = excluded.position,
         subjects = excluded.subjects,
         phone = excluded.phone,
         homeroom_classroom = excluded.homeroom_classroom,
         license_expiry_date = excluded.license_expiry_date`
    )
      .bind(target.id, position, subjects, phone, homeroom_classroom, license_expiry_date)
      .run();
    updated++;
  }

  return jsonResponse({ updated, skipped });
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

      // ติดตั้ง/อัปเกรดโครงสร้างปีการศึกษาก่อนใช้ API ภายในระบบ
      if (pathname.startsWith("/api/")) await ensureAcademicData(env);

      const academicPeriodResponse = await handleAcademicPeriodRoute(request, env, pathname, method);
      if (academicPeriodResponse) return academicPeriodResponse;
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

      if (pathname === "/api/students" && method === "GET") return await handleListStudents(request, env);
      if (pathname === "/api/students" && method === "POST") return await handleCreateStudent(request, env);
      if (pathname === "/api/students/import" && method === "POST") return await handleImportStudents(request, env);

      const studentGuardiansMatch = pathname.match(/^\/api\/students\/(\d+)\/guardians$/);
      if (studentGuardiansMatch && method === "POST") {
        return await handleAddGuardian(request, env, Number(studentGuardiansMatch[1]));
      }

      const studentMatch = pathname.match(/^\/api\/students\/(\d+)$/);
      if (studentMatch && method === "GET") return await handleGetStudent(request, env, Number(studentMatch[1]));
      if (studentMatch && method === "PATCH") return await handleUpdateStudent(request, env, Number(studentMatch[1]));
      if (studentMatch && method === "DELETE") return await handleDeleteStudent(request, env, Number(studentMatch[1]));

      const guardianMatch = pathname.match(/^\/api\/guardians\/(\d+)$/);
      if (guardianMatch && method === "PATCH") return await handleUpdateGuardian(request, env, Number(guardianMatch[1]));
      if (guardianMatch && method === "DELETE") return await handleDeleteGuardian(request, env, Number(guardianMatch[1]));

      if (pathname === "/api/staff" && method === "GET") return await handleListStaff(request, env);
      if (pathname === "/api/staff/import" && method === "POST") return await handleImportStaff(request, env);

      const staffMatch = pathname.match(/^\/api\/staff\/(\d+)$/);
      if (staffMatch && method === "PATCH") return await handleUpdateStaff(request, env, Number(staffMatch[1]));

      if (pathname === "/api/reports/summary" && method === "GET") return await handleReportsSummary(request, env);

      const deptProjectsMatch = pathname.match(/^\/api\/departments\/([a-z]+)\/projects$/);
      if (deptProjectsMatch && method === "GET") return await handleListProjects(request, env, deptProjectsMatch[1]);
      if (deptProjectsMatch && method === "POST") return await handleCreateProject(request, env, deptProjectsMatch[1]);

      const projectMatch = pathname.match(/^\/api\/projects\/(\d+)$/);
      if (projectMatch && method === "PATCH") return await handleUpdateProject(request, env, Number(projectMatch[1]));
      if (projectMatch && method === "DELETE") return await handleDeleteProject(request, env, Number(projectMatch[1]));

      const deptTopicsMatch = pathname.match(/^\/api\/departments\/([a-z]+)\/topics$/);
      if (deptTopicsMatch && method === "GET") return await handleListTopics(request, env, deptTopicsMatch[1]);
      if (deptTopicsMatch && method === "POST") return await handleCreateTopic(request, env, deptTopicsMatch[1]);

      const topicMatch = pathname.match(/^\/api\/topics\/(\d+)$/);
      if (topicMatch && method === "PATCH") return await handleUpdateTopic(request, env, Number(topicMatch[1]));
      if (topicMatch && method === "DELETE") return await handleDeleteTopic(request, env, Number(topicMatch[1]));

      if (pathname === "/api/leave-requests" && method === "GET") return await handleListLeaveRequests(request, env);
      if (pathname === "/api/leave-requests" && method === "POST") return await handleCreateLeaveRequest(request, env);

      const leaveMatch = pathname.match(/^\/api\/leave-requests\/(\d+)$/);
      if (leaveMatch && method === "PATCH") return await handleUpdateLeaveRequest(request, env, Number(leaveMatch[1]));
      if (leaveMatch && method === "DELETE") return await handleDeleteLeaveRequest(request, env, Number(leaveMatch[1]));

      if (pathname === "/api/overview" && method === "GET") return await handleOverview(request, env);

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
