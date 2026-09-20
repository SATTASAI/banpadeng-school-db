import { getCurrentUser, isAdmin, jsonResponse } from "../lib/auth.js";

const FIELDS = [
  "assessment_date", "reading_result", "reading_evidence", "writing_result", "writing_evidence",
  "thinking_result", "thinking_evidence", "participation_result", "participation_evidence",
  "strengths", "needs", "support_plan", "followup_date", "followup_result", "followup_next",
  "learner_interests", "learner_learning_style", "learner_expectations", "learner_message",
  "family_context", "learner_group",
  "knowledge_result", "knowledge_evidence", "intellectual_result", "intellectual_evidence",
  "behavior_result", "behavior_evidence", "physical_result", "physical_evidence",
  "social_result", "social_evidence",
];
const NEW_FIELDS = FIELDS.slice(15);
const RATINGS = new Set(["ดี", "ปานกลาง", "ควรส่งเสริม"]);
const GROUPS = new Set(["ก้าวหน้า", "ตามเกณฑ์", "ควรส่งเสริม", "ต้องการการสนับสนุนเฉพาะ"]);
const RATING_FIELDS = new Set(["knowledge_result", "intellectual_result", "behavior_result", "physical_result", "social_result"]);
const DATE_FIELDS = new Set(["assessment_date", "followup_date"]);
const ROLES = new Set(["teacher", "staff", "executive", "superadmin"]);
const schemaReady = new WeakSet();

async function ensureSchema(env) {
  if (schemaReady.has(env.DB)) return;
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS learner_analyses (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    student_id INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
    academic_year_id INTEGER NOT NULL REFERENCES academic_years(id),
    academic_term_id INTEGER NOT NULL REFERENCES academic_terms(id),
    teacher_user_id INTEGER NOT NULL REFERENCES users(id),
    assessment_date TEXT, reading_result TEXT, reading_evidence TEXT,
    writing_result TEXT, writing_evidence TEXT, thinking_result TEXT, thinking_evidence TEXT,
    participation_result TEXT, participation_evidence TEXT, strengths TEXT, needs TEXT,
    support_plan TEXT, followup_date TEXT, followup_result TEXT, followup_next TEXT,
    ${NEW_FIELDS.map(field=>`${field} TEXT`).join(", ")},
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE (student_id, academic_term_id, teacher_user_id)
  )`).run();
  const { results: columns } = await env.DB.prepare("PRAGMA table_info(learner_analyses)").all();
  const existing = new Set(columns.map(column=>column.name));
  for (const field of NEW_FIELDS) {
    if (!existing.has(field)) {
      try { await env.DB.prepare(`ALTER TABLE learner_analyses ADD COLUMN ${field} TEXT`).run(); }
      catch (error) { if (!/duplicate column name/i.test(String(error?.message))) throw error; }
    }
  }
  await env.DB.prepare("CREATE INDEX IF NOT EXISTS idx_learner_analyses_period_teacher ON learner_analyses(academic_term_id,teacher_user_id,student_id)").run();
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS learner_class_assignments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    academic_term_id INTEGER NOT NULL REFERENCES academic_terms(id) ON DELETE CASCADE,
    grade_level TEXT NOT NULL,
    classroom TEXT NOT NULL,
    teacher_user_id INTEGER NOT NULL REFERENCES users(id),
    assigned_by INTEGER NOT NULL REFERENCES users(id),
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE (academic_term_id, grade_level, classroom, teacher_user_id)
  )`).run();
  await env.DB.prepare("CREATE INDEX IF NOT EXISTS idx_learner_class_assignments_teacher ON learner_class_assignments(teacher_user_id,academic_term_id,grade_level,classroom)").run();
  schemaReady.add(env.DB);
}

async function findTerm(env, termId) {
  if (!Number.isSafeInteger(termId) || termId <= 0) return null;
  return env.DB.prepare(`SELECT t.id,t.academic_year_id,t.name,y.year_be
    FROM academic_terms t JOIN academic_years y ON y.id=t.academic_year_id WHERE t.id=?`)
    .bind(termId).first();
}

function normalizeField(field, raw) {
  if (raw == null || raw === "") return null;
  if (typeof raw !== "string" || raw.length > 4000) throw new Error("ข้อมูลยาวเกินกำหนดหรือรูปแบบไม่ถูกต้อง");
  const value = raw.trim();
  if (RATING_FIELDS.has(field) && value && !RATINGS.has(value)) throw new Error("ผลประเมินต้องเป็น ดี ปานกลาง หรือควรส่งเสริม");
  if (field === "learner_group" && value && !GROUPS.has(value)) throw new Error("กลุ่มผู้เรียนไม่ถูกต้อง");
  if (DATE_FIELDS.has(field) && value) {
    const date = new Date(`${value}T00:00:00Z`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(date.getTime()) || date.toISOString().slice(0,10)!==value) {
      throw new Error("วันที่ต้องอยู่ในรูปแบบปี-เดือน-วัน และเป็นวันที่มีอยู่จริง");
    }
  }
  return value || null;
}

async function canAccessRoom(env, user, termId, gradeLevel, classroom) {
  if (isAdmin(user)) return true;
  if (!gradeLevel || !classroom) return false;
  const assigned = await env.DB.prepare(`SELECT 1 FROM learner_class_assignments
    WHERE teacher_user_id=? AND academic_term_id=? AND grade_level=? AND classroom=?`)
    .bind(user.id, termId, gradeLevel, classroom).first();
  return !!assigned;
}

async function listAssignments(request, env) {
  const url = new URL(request.url);
  const term = await findTerm(env, Number(url.searchParams.get("term_id")));
  if (!term) return jsonResponse({ error:"กรุณาเลือกภาคเรียนที่ถูกต้อง" },400);
  const gradeLevel = (url.searchParams.get("grade_level") || "").trim();
  const classroom = (url.searchParams.get("classroom") || "").trim();
  if (!gradeLevel || !classroom || gradeLevel.length > 80 || classroom.length > 80)
    return jsonResponse({ error:"กรุณาเลือกระดับชั้นและห้องเรียน" },400);
  const { results } = await env.DB.prepare(`SELECT a.id,a.teacher_user_id,u.full_name,u.role
    FROM learner_class_assignments a JOIN users u ON u.id=a.teacher_user_id
    WHERE a.academic_term_id=? AND a.grade_level=? AND a.classroom=?
    ORDER BY u.full_name,u.id`).bind(term.id,gradeLevel,classroom).all();
  return jsonResponse({ assignments:results },200,{ "Cache-Control":"private, no-store" });
}

async function addAssignment(request, env, user) {
  const body = await request.json().catch(() => null);
  if (!body || typeof body !== "object" || Array.isArray(body)) return jsonResponse({ error:"ข้อมูลไม่ถูกต้อง" },400);
  const term = await findTerm(env, Number(body.term_id));
  if (!term) return jsonResponse({ error:"กรุณาเลือกภาคเรียนที่ถูกต้อง" },400);
  const gradeLevel = typeof body.grade_level === "string" ? body.grade_level.trim() : "";
  const classroom = typeof body.classroom === "string" ? body.classroom.trim() : "";
  const teacherId = Number(body.teacher_user_id);
  if (!gradeLevel || !classroom || gradeLevel.length > 80 || classroom.length > 80 ||
      !Number.isSafeInteger(teacherId) || teacherId <= 0) return jsonResponse({ error:"ข้อมูลห้องหรือครูไม่ถูกต้อง" },400);
  const room = await env.DB.prepare(`SELECT 1 FROM student_enrollments WHERE academic_term_id=?
    AND grade_level=? AND classroom=? AND status='enrolled' LIMIT 1`)
    .bind(term.id,gradeLevel,classroom).first();
  if (!room) return jsonResponse({ error:"ไม่พบห้องเรียนในภาคเรียนที่เลือก" },404);
  const teacher = await env.DB.prepare(`SELECT id FROM users
    WHERE id=? AND status='active' AND role IN ('teacher','staff')`).bind(teacherId).first();
  if (!teacher) return jsonResponse({ error:"กรุณาเลือกครูหรือบุคลากรที่ใช้งานอยู่" },400);
  await env.DB.prepare(`INSERT OR IGNORE INTO learner_class_assignments
    (academic_term_id,grade_level,classroom,teacher_user_id,assigned_by) VALUES (?,?,?,?,?)`)
    .bind(term.id,gradeLevel,classroom,teacherId,user.id).run();
  return jsonResponse({ ok:true },200,{ "Cache-Control":"private, no-store" });
}

async function removeAssignment(env, id) {
  if (!Number.isSafeInteger(id) || id <= 0) return jsonResponse({ error:"รายการไม่ถูกต้อง" },400);
  await env.DB.prepare("DELETE FROM learner_class_assignments WHERE id=?").bind(id).run();
  return jsonResponse({ ok:true },200,{ "Cache-Control":"private, no-store" });
}

async function listClassroom(request, env, user) {
  const url = new URL(request.url);
  const term = await findTerm(env, Number(url.searchParams.get("term_id")));
  if (!term) return jsonResponse({ error:"กรุณาเลือกภาคเรียนที่ถูกต้อง" },400);
  const gradeLevel = (url.searchParams.get("grade_level") || "").trim();
  const classroom = (url.searchParams.get("classroom") || "").trim();
  if (!gradeLevel || gradeLevel.length > 80) return jsonResponse({ error:"กรุณาเลือกระดับชั้น" },400);
  if (!classroom || classroom.length > 80) return jsonResponse({ error:"กรุณาเลือกห้องเรียน" },400);
  await ensureSchema(env);
  if (!await canAccessRoom(env,user,term.id,gradeLevel,classroom))
    return jsonResponse({ error:"ไม่มีสิทธิ์เข้าถึงห้องนี้ กรุณาให้ผู้ดูแลมอบหมายครูประจำห้องก่อน" },403);
  const includePrint = url.searchParams.get("print") === "1";
  const columns = includePrint ? `s.health_conditions,s.allergies,d.disadvantage,
       d.guardian_prefix,d.guardian_first_name,d.guardian_last_name,d.guardian_relationship,
       (SELECT g.full_name FROM guardians g WHERE g.student_id=s.id
         ORDER BY g.is_emergency_contact DESC,g.id LIMIT 1) AS guardian_name_fallback,
       (SELECT g.relationship FROM guardians g WHERE g.student_id=s.id
         ORDER BY g.is_emergency_contact DESC,g.id LIMIT 1) AS guardian_relationship_fallback,` : "";
  const detailJoin = includePrint ? "LEFT JOIN student_details d ON d.student_id=s.id" : "";
  const analysisColumns = includePrint ? `${FIELDS.map(field=>`a.${field}`).join(",")},` : "";
  const { results } = await env.DB.prepare(`SELECT s.id,s.student_code,s.full_name,
       e.grade_level,e.classroom,${columns}${analysisColumns}
       a.id AS analysis_id,a.updated_at AS analysis_updated_at
     FROM student_enrollments e JOIN students s ON s.id=e.student_id
     ${detailJoin}
     LEFT JOIN learner_analyses a ON a.student_id=s.id AND a.academic_term_id=e.academic_term_id AND a.teacher_user_id=?
     WHERE e.academic_term_id=? AND e.grade_level=? AND e.classroom=? AND e.status='enrolled'
     ORDER BY s.full_name,s.id`).bind(user.id,term.id,gradeLevel,classroom).all();
  return jsonResponse({ term, grade_level:gradeLevel, classroom, teacher_name:user.full_name, students:results },200,
    { "Cache-Control":"private, no-store" });
}

async function listGrades(request, env, user) {
  const term = await findTerm(env, Number(new URL(request.url).searchParams.get("term_id")));
  if (!term) return jsonResponse({ error:"กรุณาเลือกภาคเรียนที่ถูกต้อง" },400);
  await ensureSchema(env);
  const filter = isAdmin(user) ? "" : `AND EXISTS (SELECT 1 FROM learner_class_assignments a
    WHERE a.academic_term_id=e.academic_term_id AND a.grade_level=e.grade_level
      AND a.classroom=e.classroom AND a.teacher_user_id=?)`;
  const { results } = await env.DB.prepare(`SELECT e.grade_level,COUNT(*) AS student_count
    FROM student_enrollments e WHERE e.academic_term_id=? AND e.status='enrolled'
      AND e.grade_level IS NOT NULL AND TRIM(e.grade_level)<>''
      ${filter}
    GROUP BY e.grade_level ORDER BY e.grade_level`)
    .bind(...(isAdmin(user) ? [term.id] : [term.id,user.id])).all();
  return jsonResponse({ term, grades:results },200,{ "Cache-Control":"private, no-store" });
}

async function listClassrooms(request, env, user) {
  const url = new URL(request.url);
  const term = await findTerm(env, Number(url.searchParams.get("term_id")));
  if (!term) return jsonResponse({ error:"กรุณาเลือกภาคเรียนที่ถูกต้อง" },400);
  const gradeLevel = (url.searchParams.get("grade_level") || "").trim();
  if (!gradeLevel || gradeLevel.length > 80) return jsonResponse({ error:"กรุณาเลือกระดับชั้น" },400);
  await ensureSchema(env);
  const filter = isAdmin(user) ? "" : `AND EXISTS (SELECT 1 FROM learner_class_assignments a
    WHERE a.academic_term_id=e.academic_term_id AND a.grade_level=e.grade_level
      AND a.classroom=e.classroom AND a.teacher_user_id=?)`;
  const { results } = await env.DB.prepare(`SELECT e.classroom,COUNT(*) AS student_count
    FROM student_enrollments e WHERE e.academic_term_id=? AND e.grade_level=? AND e.status='enrolled'
      AND e.classroom IS NOT NULL AND TRIM(e.classroom)<>''
      ${filter}
    GROUP BY e.classroom ORDER BY e.classroom`)
    .bind(...(isAdmin(user) ? [term.id,gradeLevel] : [term.id,gradeLevel,user.id])).all();
  return jsonResponse({ term, grade_level:gradeLevel, classrooms:results },200,{ "Cache-Control":"private, no-store" });
}

async function readRecord(request, env, user, studentId) {
  const term = await findTerm(env, Number(new URL(request.url).searchParams.get("term_id")));
  if (!term) return jsonResponse({ error:"กรุณาเลือกภาคเรียนที่ถูกต้อง" },400);
  await ensureSchema(env);
  const student = await env.DB.prepare(`SELECT s.id,s.student_code,s.full_name,e.grade_level,e.classroom
    FROM student_enrollments e JOIN students s ON s.id=e.student_id
    WHERE e.academic_term_id=? AND e.student_id=? AND e.status='enrolled'`)
    .bind(term.id,studentId).first();
  if (!student) return jsonResponse({ error:"ไม่พบนักเรียนในภาคเรียนที่เลือก" },404);
  if (!await canAccessRoom(env,user,term.id,student.grade_level,student.classroom))
    return jsonResponse({ error:"ไม่มีสิทธิ์เข้าถึงห้องของนักเรียนรายนี้" },403);
  const analysis = await env.DB.prepare(`SELECT ${FIELDS.join(",")},updated_at FROM learner_analyses
    WHERE student_id=? AND academic_term_id=? AND teacher_user_id=?`)
    .bind(studentId,term.id,user.id).first();
  return jsonResponse({ term,student,analysis },200,{ "Cache-Control":"private, no-store" });
}

async function saveRecord(request, env, user, studentId) {
  const body = await request.json().catch(() => null);
  if (!body || typeof body !== "object" || Array.isArray(body)) return jsonResponse({ error:"ข้อมูลไม่ถูกต้อง" },400);
  const term = await findTerm(env, Number(body.term_id));
  if (!term) return jsonResponse({ error:"กรุณาเลือกภาคเรียนที่ถูกต้อง" },400);
  await ensureSchema(env);
  const enrolled = await env.DB.prepare(`SELECT grade_level,classroom FROM student_enrollments
    WHERE academic_term_id=? AND student_id=? AND status='enrolled'`).bind(term.id,studentId).first();
  if (!enrolled) return jsonResponse({ error:"ไม่พบนักเรียนในภาคเรียนที่เลือก" },404);
  if (!await canAccessRoom(env,user,term.id,enrolled.grade_level,enrolled.classroom))
    return jsonResponse({ error:"ไม่มีสิทธิ์บันทึกข้อมูลนักเรียนรายนี้" },403);
  let values;
  try { values = FIELDS.map((field) => normalizeField(field,body[field])); }
  catch(error) { return jsonResponse({ error:error.message },400); }
  await ensureSchema(env);
  const set = FIELDS.map(field=>`${field}=excluded.${field}`).join(",");
  await env.DB.prepare(`INSERT INTO learner_analyses
    (student_id,academic_year_id,academic_term_id,teacher_user_id,${FIELDS.join(",")})
    VALUES (?,?,?, ?,${FIELDS.map(()=>"?").join(",")})
    ON CONFLICT(student_id,academic_term_id,teacher_user_id)
    DO UPDATE SET ${set},updated_at=datetime('now')`)
    .bind(studentId,term.academic_year_id,term.id,user.id,...values).run();
  return jsonResponse({ ok:true });
}

export async function handleLearnerAnalysisRoute(request, env, pathname, method) {
  if (!pathname.startsWith("/api/learner-analysis/")) return null;
  const user = await getCurrentUser(request,env);
  if (!user || !user.role) return jsonResponse({ error:"กรุณาเข้าสู่ระบบ" },401);
  if (!ROLES.has(user.role) && !isAdmin(user)) return jsonResponse({ error:"ไม่มีสิทธิ์เข้าถึง" },403);
  if (pathname.startsWith("/api/learner-analysis/assignments")) {
    if (!isAdmin(user)) return jsonResponse({ error:"เฉพาะผู้บริหารหรือผู้ดูแลระบบ" },403);
    await ensureSchema(env);
    if (pathname === "/api/learner-analysis/assignments" && method === "GET") return listAssignments(request,env);
    if (pathname === "/api/learner-analysis/assignments" && method === "POST") return addAssignment(request,env,user);
    const match = pathname.match(/^\/api\/learner-analysis\/assignments\/(\d+)$/);
    if (match && method === "DELETE") return removeAssignment(env,Number(match[1]));
    return jsonResponse({ error:"ไม่พบ endpoint นี้" },404);
  }
  if (pathname === "/api/learner-analysis/grades" && method === "GET") return listGrades(request,env,user);
  if (pathname === "/api/learner-analysis/classrooms" && method === "GET") return listClassrooms(request,env,user);
  if (pathname === "/api/learner-analysis/roster" && method === "GET") return listClassroom(request,env,user);
  const match = pathname.match(/^\/api\/learner-analysis\/records\/(\d+)$/);
  if (match && method === "GET") return readRecord(request,env,user,Number(match[1]));
  if (match && method === "PUT") return saveRecord(request,env,user,Number(match[1]));
  return jsonResponse({ error:"ไม่พบ endpoint นี้" },404);
}
