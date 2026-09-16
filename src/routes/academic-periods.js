import { getCurrentUser, isAdmin, jsonResponse } from "../lib/auth.js";
import {
  ensureAcademicData,
  getCalendarForYear,
  getCurrentAcademicPeriod,
} from "../lib/academic-data.js";

const YEAR_STATUSES = ["draft", "active", "closed"];
const TERM_STATUSES = ["planned", "active", "closed"];

async function readBody(request) {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

function cleanText(value, maxLength = 500) {
  const text = value == null ? "" : String(value).trim();
  return text ? text.slice(0, maxLength) : null;
}

function isIsoDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value || "")) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function validateDateRange(startDate, endDate) {
  if (!isIsoDate(startDate) || !isIsoDate(endDate)) return "กรุณาระบุวันที่ให้ถูกต้อง";
  if (startDate > endDate) return "วันที่เริ่มต้องไม่อยู่หลังวันที่สิ้นสุด";
  return null;
}

async function requireUser(request, env, adminOnly = false) {
  const user = await getCurrentUser(request, env);
  if (!user || !user.role) return { error: jsonResponse({ error: "กรุณาเข้าสู่ระบบ" }, 401) };
  if (adminOnly && !isAdmin(user)) {
    return { error: jsonResponse({ error: "เฉพาะผู้บริหารหรือผู้ดูแลระบบเท่านั้นที่จัดการปีการศึกษาได้" }, 403) };
  }
  return { user };
}

async function audit(env, action, yearId, termId, userId, details = null) {
  await env.DB.prepare(
    `INSERT INTO academic_period_audit
       (action, academic_year_id, academic_term_id, actor_user_id, details)
     VALUES (?, ?, ?, ?, ?)`
  ).bind(action, yearId || null, termId || null, userId || null, details ? JSON.stringify(details) : null).run();
}

async function listPeriods(request, env) {
  const auth = await requireUser(request, env);
  if (auth.error) return auth.error;
  await ensureAcademicData(env);

  const [yearResult, termResult, auditResult, current] = await Promise.all([
    env.DB.prepare(
      `SELECT y.*,
              (SELECT COUNT(*) FROM academic_terms t WHERE t.academic_year_id = y.id) AS term_count,
              (SELECT COUNT(DISTINCT e.student_id) FROM student_enrollments e
               WHERE e.academic_year_id = y.id AND e.status = 'enrolled') AS student_count,
              (SELECT COUNT(*) FROM projects p WHERE p.academic_year_id = y.id) AS project_count,
              (SELECT COUNT(*) FROM tasks k WHERE k.academic_year_id = y.id) AS task_count
       FROM academic_years y ORDER BY y.year_be DESC`
    ).all(),
    env.DB.prepare(
      `SELECT t.*,
              (SELECT COUNT(*) FROM student_enrollments e
               WHERE e.academic_term_id = t.id AND e.status = 'enrolled') AS student_count,
              (SELECT COUNT(*) FROM projects p WHERE p.academic_term_id = t.id) AS project_count,
              (SELECT COUNT(*) FROM tasks k WHERE k.academic_term_id = t.id) AS task_count,
              (SELECT COUNT(*) FROM leave_requests l WHERE l.academic_term_id = t.id) AS leave_count
       FROM academic_terms t ORDER BY t.academic_year_id, t.term_number`
    ).all(),
    env.DB.prepare(
      `SELECT a.*, u.full_name AS actor_name, y.year_be, t.name AS term_name
       FROM academic_period_audit a
       LEFT JOIN users u ON u.id = a.actor_user_id
       LEFT JOIN academic_years y ON y.id = a.academic_year_id
       LEFT JOIN academic_terms t ON t.id = a.academic_term_id
       ORDER BY a.created_at DESC, a.id DESC LIMIT 30`
    ).all(),
    getCurrentAcademicPeriod(env),
  ]);

  const termsByYear = {};
  for (const term of termResult.results) {
    if (!termsByYear[term.academic_year_id]) termsByYear[term.academic_year_id] = [];
    termsByYear[term.academic_year_id].push(term);
  }
  const years = yearResult.results.map((year) => ({ ...year, terms: termsByYear[year.id] || [] }));
  return jsonResponse({ years, current, audit_log: auditResult.results, can_manage: isAdmin(auth.user) });
}

async function createYear(request, env) {
  const auth = await requireUser(request, env, true);
  if (auth.error) return auth.error;
  await ensureAcademicData(env);
  const body = await readBody(request);
  if (!body) return jsonResponse({ error: "รูปแบบข้อมูลไม่ถูกต้อง" }, 400);

  const yearBe = Number(body.year_be);
  if (!Number.isInteger(yearBe) || yearBe < 2500 || yearBe > 2700) {
    return jsonResponse({ error: "ปีการศึกษาต้องเป็น พ.ศ. ระหว่าง 2500–2700" }, 400);
  }
  const defaults = getCalendarForYear(yearBe);
  const label = cleanText(body.label, 100) || defaults.label;
  const startDate = body.start_date || defaults.start_date;
  const endDate = body.end_date || defaults.end_date;
  const dateError = validateDateRange(startDate, endDate);
  if (dateError) return jsonResponse({ error: dateError }, 400);

  const exists = await env.DB.prepare("SELECT id FROM academic_years WHERE year_be = ?").bind(yearBe).first();
  if (exists) return jsonResponse({ error: `มีปีการศึกษา ${yearBe} อยู่แล้ว` }, 409);

  const yearResult = await env.DB.prepare(
    `INSERT INTO academic_years (year_be, label, start_date, end_date, status, notes, created_by)
     VALUES (?, ?, ?, ?, 'draft', ?, ?)`
  ).bind(yearBe, label, startDate, endDate, cleanText(body.notes, 1000), auth.user.id).run();
  const yearId = yearResult.meta.last_row_id;

  if (body.create_terms !== false) {
    const termStatements = defaults.terms.map((term) => env.DB.prepare(
      `INSERT INTO academic_terms
         (academic_year_id, term_number, name, start_date, end_date, status)
       VALUES (?, ?, ?, ?, ?, 'planned')`
    ).bind(yearId, term.term_number, term.name, term.start_date, term.end_date));
    await env.DB.batch(termStatements);
  }
  await audit(env, "create_year", yearId, null, auth.user.id, { year_be: yearBe });
  return jsonResponse({ id: yearId, year_be: yearBe }, 201);
}

async function updateYear(request, env, yearId) {
  const auth = await requireUser(request, env, true);
  if (auth.error) return auth.error;
  await ensureAcademicData(env);
  const body = await readBody(request);
  if (!body) return jsonResponse({ error: "รูปแบบข้อมูลไม่ถูกต้อง" }, 400);
  const existing = await env.DB.prepare("SELECT * FROM academic_years WHERE id = ?").bind(yearId).first();
  if (!existing) return jsonResponse({ error: "ไม่พบปีการศึกษา" }, 404);

  const label = cleanText(body.label, 100) || existing.label;
  const startDate = body.start_date || existing.start_date;
  const endDate = body.end_date || existing.end_date;
  const dateError = validateDateRange(startDate, endDate);
  if (dateError) return jsonResponse({ error: dateError }, 400);
  const invalidTerm = await env.DB.prepare(
    `SELECT id FROM academic_terms
     WHERE academic_year_id = ? AND (start_date < ? OR end_date > ?) LIMIT 1`
  ).bind(yearId, startDate, endDate).first();
  if (invalidTerm) return jsonResponse({ error: "ช่วงปีการศึกษาใหม่ต้องครอบคลุมวันที่ของทุกภาคเรียน" }, 400);

  await env.DB.prepare(
    `UPDATE academic_years SET label = ?, start_date = ?, end_date = ?, notes = ?,
            updated_at = datetime('now') WHERE id = ?`
  ).bind(label, startDate, endDate, body.notes === undefined ? existing.notes : cleanText(body.notes, 1000), yearId).run();
  await audit(env, "update_year", yearId, null, auth.user.id);
  return jsonResponse({ ok: true });
}

async function createTerm(request, env, yearId) {
  const auth = await requireUser(request, env, true);
  if (auth.error) return auth.error;
  await ensureAcademicData(env);
  const body = await readBody(request);
  if (!body) return jsonResponse({ error: "รูปแบบข้อมูลไม่ถูกต้อง" }, 400);
  const year = await env.DB.prepare("SELECT * FROM academic_years WHERE id = ?").bind(yearId).first();
  if (!year) return jsonResponse({ error: "ไม่พบปีการศึกษา" }, 404);
  if (year.status === "closed") return jsonResponse({ error: "ปีการศึกษานี้ปิดแล้ว ไม่สามารถเพิ่มภาคเรียนได้" }, 400);

  const termNumber = Number(body.term_number);
  if (!Number.isInteger(termNumber) || termNumber < 1 || termNumber > 3) {
    return jsonResponse({ error: "ลำดับภาคเรียนต้องอยู่ระหว่าง 1–3" }, 400);
  }
  const name = cleanText(body.name, 100) || `ภาคเรียนที่ ${termNumber}`;
  const dateError = validateDateRange(body.start_date, body.end_date);
  if (dateError) return jsonResponse({ error: dateError }, 400);
  if (body.start_date < year.start_date || body.end_date > year.end_date) {
    return jsonResponse({ error: "วันเริ่มและสิ้นสุดภาคเรียนต้องอยู่ภายในปีการศึกษา" }, 400);
  }
  const overlap = await env.DB.prepare(
    `SELECT id FROM academic_terms WHERE academic_year_id = ?
     AND NOT (end_date < ? OR start_date > ?) LIMIT 1`
  ).bind(yearId, body.start_date, body.end_date).first();
  if (overlap) return jsonResponse({ error: "ช่วงวันที่ภาคเรียนทับซ้อนกับภาคเรียนที่มีอยู่" }, 409);

  try {
    const result = await env.DB.prepare(
      `INSERT INTO academic_terms
         (academic_year_id, term_number, name, start_date, end_date, status)
       VALUES (?, ?, ?, ?, ?, 'planned')`
    ).bind(yearId, termNumber, name, body.start_date, body.end_date).run();
    await audit(env, "create_term", yearId, result.meta.last_row_id, auth.user.id);
    return jsonResponse({ id: result.meta.last_row_id }, 201);
  } catch {
    return jsonResponse({ error: `มีภาคเรียนลำดับที่ ${termNumber} อยู่แล้ว` }, 409);
  }
}

async function updateTerm(request, env, termId) {
  const auth = await requireUser(request, env, true);
  if (auth.error) return auth.error;
  await ensureAcademicData(env);
  const body = await readBody(request);
  if (!body) return jsonResponse({ error: "รูปแบบข้อมูลไม่ถูกต้อง" }, 400);
  const term = await env.DB.prepare(
    `SELECT t.*, y.start_date AS year_start, y.end_date AS year_end, y.status AS year_status
     FROM academic_terms t JOIN academic_years y ON y.id = t.academic_year_id WHERE t.id = ?`
  ).bind(termId).first();
  if (!term) return jsonResponse({ error: "ไม่พบภาคเรียน" }, 404);
  if (term.year_status === "closed") return jsonResponse({ error: "ปีการศึกษานี้ปิดแล้ว ไม่สามารถแก้ไขได้" }, 400);

  const name = cleanText(body.name, 100) || term.name;
  const startDate = body.start_date || term.start_date;
  const endDate = body.end_date || term.end_date;
  const dateError = validateDateRange(startDate, endDate);
  if (dateError) return jsonResponse({ error: dateError }, 400);
  if (startDate < term.year_start || endDate > term.year_end) {
    return jsonResponse({ error: "วันเริ่มและสิ้นสุดภาคเรียนต้องอยู่ภายในปีการศึกษา" }, 400);
  }
  const overlap = await env.DB.prepare(
    `SELECT id FROM academic_terms WHERE academic_year_id = ? AND id <> ?
     AND NOT (end_date < ? OR start_date > ?) LIMIT 1`
  ).bind(term.academic_year_id, termId, startDate, endDate).first();
  if (overlap) return jsonResponse({ error: "ช่วงวันที่ภาคเรียนทับซ้อนกับภาคเรียนอื่น" }, 409);

  await env.DB.prepare(
    `UPDATE academic_terms SET name = ?, start_date = ?, end_date = ?,
            updated_at = datetime('now') WHERE id = ?`
  ).bind(name, startDate, endDate, termId).run();
  await audit(env, "update_term", term.academic_year_id, termId, auth.user.id);
  return jsonResponse({ ok: true });
}

async function syncStudentMaster(env, termId) {
  await env.DB.prepare(
    `UPDATE students SET
       grade_level = (SELECT e.grade_level FROM student_enrollments e WHERE e.student_id = students.id AND e.academic_term_id = ?),
       classroom = (SELECT e.classroom FROM student_enrollments e WHERE e.student_id = students.id AND e.academic_term_id = ?),
       status = (SELECT e.status FROM student_enrollments e WHERE e.student_id = students.id AND e.academic_term_id = ?)
     WHERE EXISTS (SELECT 1 FROM student_enrollments e WHERE e.student_id = students.id AND e.academic_term_id = ?)`
  ).bind(termId, termId, termId, termId).run();
}

async function carryForwardTermRoster(env, sourceTermId, targetTermId, targetYearId) {
  const targetCount = await env.DB.prepare(
    "SELECT COUNT(*) AS count FROM student_enrollments WHERE academic_term_id = ?"
  ).bind(targetTermId).first();
  if (Number(targetCount?.count || 0) > 0 || !sourceTermId) return;
  await env.DB.prepare(
    `INSERT INTO student_enrollments
       (student_id, academic_year_id, academic_term_id, grade_level, classroom, status, promoted_from_id)
     SELECT student_id, ?, ?, grade_level, classroom, status, id
     FROM student_enrollments WHERE academic_term_id = ? AND status = 'enrolled'
     ON CONFLICT(student_id, academic_term_id) DO NOTHING`
  ).bind(targetYearId, targetTermId, sourceTermId).run();
}

async function activateYear(request, env, yearId) {
  const auth = await requireUser(request, env, true);
  if (auth.error) return auth.error;
  await ensureAcademicData(env);
  const body = (await readBody(request)) || {};
  const year = await env.DB.prepare("SELECT * FROM academic_years WHERE id = ?").bind(yearId).first();
  if (!year) return jsonResponse({ error: "ไม่พบปีการศึกษา" }, 404);
  if (year.status === "closed" && body.reopen !== true) {
    return jsonResponse({ error: "ปีการศึกษานี้ปิดแล้ว หากต้องการเปิดใหม่ต้องยืนยันการเปิดปีเก่า" }, 400);
  }

  let term = await env.DB.prepare(
    `SELECT * FROM academic_terms WHERE academic_year_id = ? AND status = 'active'
     ORDER BY term_number LIMIT 1`
  ).bind(yearId).first();
  if (!term) {
    term = await env.DB.prepare(
      `SELECT * FROM academic_terms WHERE academic_year_id = ? AND status = 'planned'
       ORDER BY term_number LIMIT 1`
    ).bind(yearId).first();
  }
  if (!term && body.reopen === true) {
    term = await env.DB.prepare(
      `SELECT * FROM academic_terms WHERE academic_year_id = ? ORDER BY term_number LIMIT 1`
    ).bind(yearId).first();
  }
  if (!term) return jsonResponse({ error: "ปีการศึกษานี้ยังไม่มีภาคเรียนที่เปิดใช้งานได้" }, 400);

  const current = await getCurrentAcademicPeriod(env);
  if (current?.academic_year_id === yearId && current?.academic_term_id === term.id) {
    return jsonResponse({ ok: true, current, unchanged: true });
  }

  const targetRoster = await env.DB.prepare(
    "SELECT COUNT(*) AS count FROM student_enrollments WHERE academic_term_id = ?"
  ).bind(term.id).first();
  if (Number(targetRoster?.count || 0) === 0 && current?.academic_year_id && current.academic_year_id !== yearId) {
    if (body.auto_prepare_students === true) {
      await copyStudentsBetweenYears(env, current.academic_year_id, yearId, body.promotion_mode || "promote");
    } else {
      return jsonResponse({ error: "ปีใหม่นี้ยังไม่มีทะเบียนนักเรียน กรุณาเตรียมทะเบียนหรือยืนยันการเลื่อนชั้นอัตโนมัติก่อนเปิดใช้งาน" }, 400);
    }
  }

  await env.DB.batch([
    env.DB.prepare("UPDATE academic_terms SET status = 'closed', updated_at = datetime('now') WHERE status = 'active' AND academic_year_id <> ?").bind(yearId),
    env.DB.prepare("UPDATE academic_terms SET status = 'planned', updated_at = datetime('now') WHERE status = 'active' AND academic_year_id = ? AND id <> ?").bind(yearId, term.id),
    env.DB.prepare("UPDATE academic_years SET status = 'closed', updated_at = datetime('now') WHERE status = 'active' AND id <> ?").bind(yearId),
    env.DB.prepare("UPDATE academic_years SET status = 'active', updated_at = datetime('now') WHERE id = ?").bind(yearId),
    env.DB.prepare("UPDATE academic_terms SET status = 'active', updated_at = datetime('now') WHERE id = ?").bind(term.id),
  ]);
  await syncStudentMaster(env, term.id);
  await audit(env, year.status === "closed" ? "reopen_year" : "activate_year", yearId, term.id, auth.user.id, {
    previous_year_id: current?.academic_year_id || null,
    previous_term_id: current?.academic_term_id || null,
  });
  return jsonResponse({ ok: true, current: await getCurrentAcademicPeriod(env) });
}

async function closeYear(request, env, yearId) {
  const auth = await requireUser(request, env, true);
  if (auth.error) return auth.error;
  await ensureAcademicData(env);
  const year = await env.DB.prepare("SELECT * FROM academic_years WHERE id = ?").bind(yearId).first();
  if (!year) return jsonResponse({ error: "ไม่พบปีการศึกษา" }, 404);
  if (year.status === "active") {
    return jsonResponse({ error: "กรุณาเปิดใช้งานปีการศึกษาใหม่ก่อน เพื่อไม่ให้ระบบไม่มีช่วงเวลาปัจจุบัน" }, 400);
  }
  await env.DB.batch([
    env.DB.prepare("UPDATE academic_terms SET status = 'closed', updated_at = datetime('now') WHERE academic_year_id = ?").bind(yearId),
    env.DB.prepare("UPDATE academic_years SET status = 'closed', updated_at = datetime('now') WHERE id = ?").bind(yearId),
  ]);
  await audit(env, "close_year", yearId, null, auth.user.id);
  return jsonResponse({ ok: true });
}

async function activateTerm(request, env, termId) {
  const auth = await requireUser(request, env, true);
  if (auth.error) return auth.error;
  await ensureAcademicData(env);
  const body = (await readBody(request)) || {};
  const term = await env.DB.prepare(
    `SELECT t.*, y.status AS year_status FROM academic_terms t
     JOIN academic_years y ON y.id = t.academic_year_id WHERE t.id = ?`
  ).bind(termId).first();
  if (!term) return jsonResponse({ error: "ไม่พบภาคเรียน" }, 404);
  if ((term.status === "closed" || term.year_status === "closed") && body.reopen !== true) {
    return jsonResponse({ error: "ภาคเรียนหรือปีการศึกษานี้ปิดแล้ว ต้องยืนยันการเปิดใหม่" }, 400);
  }
  const current = await getCurrentAcademicPeriod(env);
  if (current?.academic_term_id === termId) return jsonResponse({ ok: true, current, unchanged: true });

  if (current?.academic_year_id === term.academic_year_id) {
    await carryForwardTermRoster(env, current.academic_term_id, termId, term.academic_year_id);
  } else {
    const targetRoster = await env.DB.prepare(
      "SELECT COUNT(*) AS count FROM student_enrollments WHERE academic_term_id = ?"
    ).bind(termId).first();
    if (Number(targetRoster?.count || 0) === 0) {
      return jsonResponse({ error: "ภาคเรียนนี้ยังไม่มีทะเบียนนักเรียน กรุณาเตรียมทะเบียนก่อนเปิดใช้งาน" }, 400);
    }
  }

  await env.DB.batch([
    env.DB.prepare("UPDATE academic_terms SET status = 'closed', updated_at = datetime('now') WHERE status = 'active' AND academic_year_id <> ?").bind(term.academic_year_id),
    env.DB.prepare("UPDATE academic_terms SET status = 'closed', updated_at = datetime('now') WHERE status = 'active' AND academic_year_id = ? AND id <> ?").bind(term.academic_year_id, termId),
    env.DB.prepare("UPDATE academic_years SET status = 'closed', updated_at = datetime('now') WHERE status = 'active' AND id <> ?").bind(term.academic_year_id),
    env.DB.prepare("UPDATE academic_years SET status = 'active', updated_at = datetime('now') WHERE id = ?").bind(term.academic_year_id),
    env.DB.prepare("UPDATE academic_terms SET status = 'active', updated_at = datetime('now') WHERE id = ?").bind(termId),
  ]);
  await syncStudentMaster(env, termId);
  await audit(env, term.status === "closed" ? "reopen_term" : "activate_term", term.academic_year_id, termId, auth.user.id, {
    previous_term_id: current?.academic_term_id || null,
  });
  return jsonResponse({ ok: true, current: await getCurrentAcademicPeriod(env) });
}

async function closeTerm(request, env, termId) {
  const auth = await requireUser(request, env, true);
  if (auth.error) return auth.error;
  await ensureAcademicData(env);
  const term = await env.DB.prepare("SELECT * FROM academic_terms WHERE id = ?").bind(termId).first();
  if (!term) return jsonResponse({ error: "ไม่พบภาคเรียน" }, 404);
  if (term.status !== "active") {
    await env.DB.prepare("UPDATE academic_terms SET status = 'closed', updated_at = datetime('now') WHERE id = ?").bind(termId).run();
    await audit(env, "close_term", term.academic_year_id, termId, auth.user.id);
    return jsonResponse({ ok: true });
  }

  const nextTerm = await env.DB.prepare(
    `SELECT * FROM academic_terms WHERE academic_year_id = ? AND term_number > ? AND status = 'planned'
     ORDER BY term_number LIMIT 1`
  ).bind(term.academic_year_id, term.term_number).first();
  if (!nextTerm) {
    return jsonResponse({ error: "นี่เป็นภาคเรียนสุดท้าย กรุณาสร้างและเปิดปีการศึกษาถัดไปแทน เพื่อให้ระบบมีภาคเรียนปัจจุบันเสมอ" }, 400);
  }
  await carryForwardTermRoster(env, termId, nextTerm.id, term.academic_year_id);
  await env.DB.batch([
    env.DB.prepare("UPDATE academic_terms SET status = 'closed', updated_at = datetime('now') WHERE id = ?").bind(termId),
    env.DB.prepare("UPDATE academic_terms SET status = 'active', updated_at = datetime('now') WHERE id = ?").bind(nextTerm.id),
  ]);
  await syncStudentMaster(env, nextTerm.id);
  await audit(env, "advance_term", term.academic_year_id, nextTerm.id, auth.user.id, { closed_term_id: termId });
  return jsonResponse({ ok: true, current: await getCurrentAcademicPeriod(env) });
}

function normalizeGrade(value) {
  return String(value || "")
    .trim()
    .replaceAll("๑", "1").replaceAll("๒", "2").replaceAll("๓", "3")
    .replaceAll("๔", "4").replaceAll("๕", "5").replaceAll("๖", "6")
    .replace(/\s+/g, "")
    .replace("อนุบาล", "อ.")
    .replace("ประถมศึกษาปีที่", "ป.")
    .replace("ประถม", "ป.")
    .replace("ป..", "ป.")
    .replace("อ..", "อ.");
}

export function promoteGradeLevel(value) {
  const normalized = normalizeGrade(value);
  const mapping = {
    "อ.1": "อ.2", "อ1": "อ.2",
    "อ.2": "อ.3", "อ2": "อ.3",
    "อ.3": "ป.1", "อ3": "ป.1",
    "ป.1": "ป.2", "ป1": "ป.2",
    "ป.2": "ป.3", "ป2": "ป.3",
    "ป.3": "ป.4", "ป3": "ป.4",
    "ป.4": "ป.5", "ป4": "ป.5",
    "ป.5": "ป.6", "ป5": "ป.6",
  };
  if (mapping[normalized]) return { grade: mapping[normalized], shouldCopy: true };
  if (["ป.6", "ป6"].includes(normalized)) return { grade: null, shouldCopy: false, reason: "จบชั้นสูงสุด" };
  return { grade: value || null, shouldCopy: true, reason: "คงระดับชั้นเดิมเพราะไม่ตรงรูปแบบมาตรฐาน" };
}

function promoteClassroom(classroom, originalGrade, promotedGrade) {
  if (!classroom || !promotedGrade) return classroom || null;
  const original = String(originalGrade || "").trim();
  const value = String(classroom).trim();
  if (original && value.includes(original)) return value.replace(original, promotedGrade);
  const normalizedOriginal = normalizeGrade(originalGrade);
  if (normalizedOriginal && value.includes(normalizedOriginal)) return value.replace(normalizedOriginal, promotedGrade);
  return value;
}

async function copyStudentsBetweenYears(env, sourceYearId, targetYearId, promotionMode = "promote") {
  const targetTerm = await env.DB.prepare(
    "SELECT id FROM academic_terms WHERE academic_year_id = ? AND term_number = 1"
  ).bind(targetYearId).first();
  if (!targetTerm) throw new Error("ปีปลายทางยังไม่มีภาคเรียนที่ 1");
  const targetCount = await env.DB.prepare(
    "SELECT COUNT(*) AS count FROM student_enrollments WHERE academic_term_id = ?"
  ).bind(targetTerm.id).first();
  if (Number(targetCount?.count || 0) > 0) {
    return { copied: 0, skipped: 0, retained_unknown_grade: 0, already_prepared: true };
  }

  const { results: enrollments } = await env.DB.prepare(
    `SELECT e.* FROM student_enrollments e
     JOIN academic_terms t ON t.id = e.academic_term_id
     JOIN (
       SELECT e2.student_id, MAX(t2.term_number) AS max_term
       FROM student_enrollments e2 JOIN academic_terms t2 ON t2.id = e2.academic_term_id
       WHERE e2.academic_year_id = ? AND e2.status = 'enrolled'
       GROUP BY e2.student_id
     ) latest ON latest.student_id = e.student_id AND latest.max_term = t.term_number
     WHERE e.academic_year_id = ? AND e.status = 'enrolled'`
  ).bind(sourceYearId, sourceYearId).all();

  const statements = [];
  let copied = 0;
  let skipped = 0;
  let retainedUnknownGrade = 0;
  for (const enrollment of enrollments) {
    const promotion = promotionMode === "same_class"
      ? { grade: enrollment.grade_level, shouldCopy: true }
      : promoteGradeLevel(enrollment.grade_level);
    if (!promotion.shouldCopy) {
      skipped++;
      statements.push(env.DB.prepare(
        `INSERT INTO student_enrollments
           (student_id, academic_year_id, academic_term_id, grade_level, classroom, status, promoted_from_id)
         VALUES (?, ?, ?, ?, ?, 'graduated', ?)`
      ).bind(enrollment.student_id, targetYearId, targetTerm.id, enrollment.grade_level, enrollment.classroom, enrollment.id));
      continue;
    }
    if (promotion.reason) retainedUnknownGrade++;
    const classroom = promotionMode === "same_class"
      ? enrollment.classroom
      : promoteClassroom(enrollment.classroom, enrollment.grade_level, promotion.grade);
    statements.push(env.DB.prepare(
      `INSERT INTO student_enrollments
         (student_id, academic_year_id, academic_term_id, grade_level, classroom, status, promoted_from_id)
       VALUES (?, ?, ?, ?, ?, 'enrolled', ?)`
    ).bind(enrollment.student_id, targetYearId, targetTerm.id, promotion.grade, classroom, enrollment.id));
    copied++;
  }
  for (let index = 0; index < statements.length; index += 100) {
    await env.DB.batch(statements.slice(index, index + 100));
  }
  return { copied, skipped, retained_unknown_grade: retainedUnknownGrade, already_prepared: false };
}

async function copyStudentsToYear(request, env, targetYearId) {
  const auth = await requireUser(request, env, true);
  if (auth.error) return auth.error;
  await ensureAcademicData(env);
  const body = (await readBody(request)) || {};
  const target = await env.DB.prepare("SELECT * FROM academic_years WHERE id = ?").bind(targetYearId).first();
  if (!target) return jsonResponse({ error: "ไม่พบปีการศึกษาปลายทาง" }, 404);
  if (target.status === "closed") return jsonResponse({ error: "ปีการศึกษานี้ปิดแล้ว" }, 400);
  const source = await env.DB.prepare("SELECT * FROM academic_years WHERE year_be = ?").bind(Number(target.year_be) - 1).first();
  if (!source) return jsonResponse({ error: "ไม่พบปีการศึกษาต้นทางของปีนี้" }, 400);
  try {
    const result = await copyStudentsBetweenYears(env, source.id, targetYearId, body.promotion_mode || "promote");
    await audit(env, "copy_students", targetYearId, null, auth.user.id, { source_year_id: source.id, ...result });
    return jsonResponse({ ok: true, ...result });
  } catch (error) {
    return jsonResponse({ error: error.message || "เตรียมทะเบียนนักเรียนไม่สำเร็จ" }, 400);
  }
}

async function rolloverYear(request, env, sourceYearId) {
  const auth = await requireUser(request, env, true);
  if (auth.error) return auth.error;
  await ensureAcademicData(env);
  const body = (await readBody(request)) || {};
  const source = await env.DB.prepare("SELECT * FROM academic_years WHERE id = ?").bind(sourceYearId).first();
  if (!source) return jsonResponse({ error: "ไม่พบปีการศึกษาต้นทาง" }, 404);
  const nextYearBe = Number(source.year_be) + 1;
  const exists = await env.DB.prepare("SELECT id FROM academic_years WHERE year_be = ?").bind(nextYearBe).first();
  if (exists) return jsonResponse({ error: `มีปีการศึกษา ${nextYearBe} อยู่แล้ว` }, 409);

  const calendar = getCalendarForYear(nextYearBe);
  const yearResult = await env.DB.prepare(
    `INSERT INTO academic_years (year_be, label, start_date, end_date, status, notes, created_by)
     VALUES (?, ?, ?, ?, 'draft', ?, ?)`
  ).bind(nextYearBe, calendar.label, calendar.start_date, calendar.end_date, `สร้างต่อจากปีการศึกษา ${source.year_be}`, auth.user.id).run();
  const targetYearId = yearResult.meta.last_row_id;
  await env.DB.batch(calendar.terms.map((term) => env.DB.prepare(
    `INSERT INTO academic_terms
       (academic_year_id, term_number, name, start_date, end_date, status)
     VALUES (?, ?, ?, ?, ?, 'planned')`
  ).bind(targetYearId, term.term_number, term.name, term.start_date, term.end_date)));

  let copyResult = { copied: 0, skipped: 0, retained_unknown_grade: 0, already_prepared: false };
  if (body.copy_students === true) {
    copyResult = await copyStudentsBetweenYears(env, sourceYearId, targetYearId, body.promotion_mode || "promote");
  }

  await audit(env, "rollover_year", targetYearId, null, auth.user.id, {
    source_year_id: sourceYearId,
    copy_students: body.copy_students === true,
    promotion_mode: body.promotion_mode || "promote",
    ...copyResult,
  });
  return jsonResponse({
    id: targetYearId,
    year_be: nextYearBe,
    copied_students: copyResult.copied,
    skipped_students: copyResult.skipped,
    retained_unknown_grade: copyResult.retained_unknown_grade,
  }, 201);
}

export async function handleAcademicPeriodRoute(request, env, pathname, method) {
  if (pathname === "/api/academic-periods" && method === "GET") return listPeriods(request, env);
  if (pathname === "/api/academic-years" && method === "POST") return createYear(request, env);

  let match = pathname.match(/^\/api\/academic-years\/(\d+)$/);
  if (match && method === "PATCH") return updateYear(request, env, Number(match[1]));
  match = pathname.match(/^\/api\/academic-years\/(\d+)\/terms$/);
  if (match && method === "POST") return createTerm(request, env, Number(match[1]));
  match = pathname.match(/^\/api\/academic-years\/(\d+)\/activate$/);
  if (match && method === "POST") return activateYear(request, env, Number(match[1]));
  match = pathname.match(/^\/api\/academic-years\/(\d+)\/close$/);
  if (match && method === "POST") return closeYear(request, env, Number(match[1]));
  match = pathname.match(/^\/api\/academic-years\/(\d+)\/rollover$/);
  if (match && method === "POST") return rolloverYear(request, env, Number(match[1]));
  match = pathname.match(/^\/api\/academic-years\/(\d+)\/copy-students$/);
  if (match && method === "POST") return copyStudentsToYear(request, env, Number(match[1]));

  match = pathname.match(/^\/api\/academic-terms\/(\d+)$/);
  if (match && method === "PATCH") return updateTerm(request, env, Number(match[1]));
  match = pathname.match(/^\/api\/academic-terms\/(\d+)\/activate$/);
  if (match && method === "POST") return activateTerm(request, env, Number(match[1]));
  match = pathname.match(/^\/api\/academic-terms\/(\d+)\/close$/);
  if (match && method === "POST") return closeTerm(request, env, Number(match[1]));

  return null;
}

export const ACADEMIC_YEAR_STATUSES = YEAR_STATUSES;
export const ACADEMIC_TERM_STATUSES = TERM_STATUSES;
