import { getCurrentUser, isAdmin, jsonResponse } from "../lib/auth.js";

const FIELDS = [
  "assessment_date", "reading_result", "reading_evidence", "writing_result", "writing_evidence",
  "thinking_result", "thinking_evidence", "participation_result", "participation_evidence",
  "strengths", "needs", "support_plan", "followup_date", "followup_result", "followup_next",
];
const DATE_FIELDS = new Set(["assessment_date", "followup_date"]);
const ROLES = new Set(["teacher", "staff", "executive", "superadmin"]);
let schemaReady = false;

async function ensureSchema(env) {
  if (schemaReady) return;
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
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE (student_id, academic_term_id, teacher_user_id)
  )`).run();
  await env.DB.prepare("CREATE INDEX IF NOT EXISTS idx_learner_analyses_period_teacher ON learner_analyses(academic_term_id,teacher_user_id,student_id)").run();
  schemaReady = true;
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
  if (DATE_FIELDS.has(field) && value) {
    const date = new Date(`${value}T00:00:00Z`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(date.getTime()) || date.toISOString().slice(0,10)!==value) {
      throw new Error("วันที่ต้องอยู่ในรูปแบบปี-เดือน-วัน และเป็นวันที่มีอยู่จริง");
    }
  }
  return value || null;
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
  const includePrint = url.searchParams.get("print") === "1";
  const columns = includePrint ? `s.health_conditions,s.allergies,d.disadvantage,
       d.guardian_prefix,d.guardian_first_name,d.guardian_last_name,d.guardian_relationship,
       (SELECT g.full_name FROM guardians g WHERE g.student_id=s.id
         ORDER BY g.is_emergency_contact DESC,g.id LIMIT 1) AS guardian_name_fallback,
       (SELECT g.relationship FROM guardians g WHERE g.student_id=s.id
         ORDER BY g.is_emergency_contact DESC,g.id LIMIT 1) AS guardian_relationship_fallback,` : "";
  const detailJoin = includePrint ? "LEFT JOIN student_details d ON d.student_id=s.id" : "";
  const analysisColumns = includePrint ? `a.assessment_date,a.reading_result,a.reading_evidence,
       a.writing_result,a.writing_evidence,a.thinking_result,a.thinking_evidence,
       a.participation_result,a.participation_evidence,a.strengths,a.needs,a.support_plan,
       a.followup_date,a.followup_result,a.followup_next,` : "";
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

async function listGrades(request, env) {
  const term = await findTerm(env, Number(new URL(request.url).searchParams.get("term_id")));
  if (!term) return jsonResponse({ error:"กรุณาเลือกภาคเรียนที่ถูกต้อง" },400);
  const { results } = await env.DB.prepare(`SELECT e.grade_level,COUNT(*) AS student_count
    FROM student_enrollments e WHERE e.academic_term_id=? AND e.status='enrolled'
      AND e.grade_level IS NOT NULL AND TRIM(e.grade_level)<>''
    GROUP BY e.grade_level ORDER BY e.grade_level`).bind(term.id).all();
  return jsonResponse({ term, grades:results },200,{ "Cache-Control":"private, no-store" });
}

async function listClassrooms(request, env) {
  const url = new URL(request.url);
  const term = await findTerm(env, Number(url.searchParams.get("term_id")));
  if (!term) return jsonResponse({ error:"กรุณาเลือกภาคเรียนที่ถูกต้อง" },400);
  const gradeLevel = (url.searchParams.get("grade_level") || "").trim();
  if (!gradeLevel || gradeLevel.length > 80) return jsonResponse({ error:"กรุณาเลือกระดับชั้น" },400);
  const { results } = await env.DB.prepare(`SELECT e.classroom,COUNT(*) AS student_count
    FROM student_enrollments e WHERE e.academic_term_id=? AND e.grade_level=? AND e.status='enrolled'
      AND e.classroom IS NOT NULL AND TRIM(e.classroom)<>''
    GROUP BY e.classroom ORDER BY e.classroom`).bind(term.id,gradeLevel).all();
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
  const enrolled = await env.DB.prepare(`SELECT 1 FROM student_enrollments
    WHERE academic_term_id=? AND student_id=? AND status='enrolled'`).bind(term.id,studentId).first();
  if (!enrolled) return jsonResponse({ error:"ไม่พบนักเรียนในภาคเรียนที่เลือก" },404);
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
  if (pathname === "/api/learner-analysis/grades" && method === "GET") return listGrades(request,env);
  if (pathname === "/api/learner-analysis/classrooms" && method === "GET") return listClassrooms(request,env);
  if (pathname === "/api/learner-analysis/roster" && method === "GET") return listClassroom(request,env,user);
  const match = pathname.match(/^\/api\/learner-analysis\/records\/(\d+)$/);
  if (match && method === "GET") return readRecord(request,env,user,Number(match[1]));
  if (match && method === "PUT") return saveRecord(request,env,user,Number(match[1]));
  return jsonResponse({ error:"ไม่พบ endpoint นี้" },404);
}
