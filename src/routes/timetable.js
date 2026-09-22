import { getCurrentUser, isAdmin, jsonResponse } from "../lib/auth.js";
import { ensurePersonnelData } from "../lib/personnel-data.js";

const noStore = { "Cache-Control": "private, no-store" };
const reply = (data, status=200) => jsonResponse(data,status,noStore);
const validId = value => Number.isSafeInteger(Number(value)) && Number(value)>0 ? Number(value) : null;
const validDate = value => typeof value==="string" && /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(value)) && new Date(`${value}T00:00:00Z`).toISOString().slice(0,10)===value;
const text = (value,max=120) => typeof value==="string" ? value.trim().slice(0,max+1) : "";
const ready = new WeakSet();

async function ensureSchema(env){
  if(ready.has(env.DB))return;
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS timetable_plans (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    academic_term_id INTEGER NOT NULL REFERENCES academic_terms(id),
    status TEXT NOT NULL CHECK(status IN ('draft','published','archived')),
    created_by INTEGER NOT NULL REFERENCES users(id),
    created_at TEXT NOT NULL DEFAULT(datetime('now')),
    published_at TEXT
  )`).run();
  await env.DB.prepare("CREATE UNIQUE INDEX IF NOT EXISTS uq_timetable_active_plan ON timetable_plans(academic_term_id,status) WHERE status IN ('draft','published')").run();
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS timetable_entries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    plan_id INTEGER NOT NULL REFERENCES timetable_plans(id) ON DELETE CASCADE,
    grade_level TEXT NOT NULL, classroom TEXT NOT NULL,
    weekday INTEGER NOT NULL CHECK(weekday BETWEEN 1 AND 5),
    period INTEGER NOT NULL CHECK(period BETWEEN 1 AND 6),
    subject TEXT NOT NULL, teacher_id INTEGER NOT NULL REFERENCES personnel_records(id),
    room_name TEXT,
    UNIQUE(plan_id,grade_level,classroom,weekday,period)
  )`).run();
  await env.DB.prepare("CREATE UNIQUE INDEX IF NOT EXISTS uq_timetable_teacher ON timetable_entries(plan_id,weekday,period,teacher_id)").run();
  await env.DB.prepare("CREATE UNIQUE INDEX IF NOT EXISTS uq_timetable_room ON timetable_entries(plan_id,weekday,period,room_name) WHERE room_name IS NOT NULL AND room_name<>''").run();
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS substitute_absences (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    absence_date TEXT NOT NULL, teacher_id INTEGER NOT NULL REFERENCES personnel_records(id),
    reason TEXT, created_by INTEGER NOT NULL REFERENCES users(id),
    created_at TEXT NOT NULL DEFAULT(datetime('now')),
    UNIQUE(absence_date,teacher_id)
  )`).run();
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS substitute_assignments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    absence_id INTEGER NOT NULL REFERENCES substitute_absences(id),
    timetable_entry_id INTEGER NOT NULL REFERENCES timetable_entries(id),
    substitute_teacher_id INTEGER NOT NULL REFERENCES personnel_records(id),
    weekday INTEGER NOT NULL, period INTEGER NOT NULL, absence_date TEXT NOT NULL,
    notes TEXT, created_by INTEGER NOT NULL REFERENCES users(id),
    created_at TEXT NOT NULL DEFAULT(datetime('now')),
    UNIQUE(absence_id,timetable_entry_id),
    UNIQUE(absence_date,period,substitute_teacher_id)
  )`).run();
  ready.add(env.DB);
}

async function termById(env, id){return id&&env.DB.prepare(`SELECT t.id,t.name,t.start_date,t.end_date,y.year_be FROM academic_terms t
  JOIN academic_years y ON y.id=t.academic_year_id WHERE t.id=?`).bind(id).first();}
async function plan(env,termId,status){return env.DB.prepare("SELECT id,status,published_at FROM timetable_plans WHERE academic_term_id=? AND status=?").bind(termId,status).first();}
async function draft(env,termId,userId){
  let row=await plan(env,termId,"draft");if(row)return row;
  const published=await plan(env,termId,"published");
  await env.DB.prepare("INSERT OR IGNORE INTO timetable_plans(academic_term_id,status,created_by) VALUES (?,'draft',?)").bind(termId,userId).run();
  row=await plan(env,termId,"draft");
  if(published){
    await env.DB.prepare(`INSERT OR IGNORE INTO timetable_entries(plan_id,grade_level,classroom,weekday,period,subject,teacher_id,room_name)
      SELECT ?,grade_level,classroom,weekday,period,subject,teacher_id,room_name FROM timetable_entries WHERE plan_id=?`)
      .bind(row.id,published.id).run();
  }
  return row;
}
async function setup(env,term){
  const [classes,teachers,published,draftPlan]=await Promise.all([
    env.DB.prepare(`SELECT grade_level,classroom,COUNT(*) AS students FROM student_enrollments
      WHERE academic_term_id=? AND status='enrolled' AND TRIM(COALESCE(grade_level,''))<>'' AND TRIM(COALESCE(classroom,''))<>''
      GROUP BY grade_level,classroom ORDER BY grade_level,classroom`).bind(term.id).all(),
    env.DB.prepare(`SELECT p.id,p.full_name,p.subjects,p.homeroom_classroom FROM personnel_records p
      LEFT JOIN users u ON u.id=p.user_id WHERE p.status='active' AND (p.user_id IS NULL OR u.role IN ('teacher','staff'))
      ORDER BY p.full_name`).all(),
    plan(env,term.id,"published"),plan(env,term.id,"draft")
  ]);
  return reply({term,classes:classes.results,teachers:teachers.results,published,draft:draftPlan});
}
async function entries(env,term,view){
  const chosen=await plan(env,term.id,view);
  const rows=chosen?await env.DB.prepare(`SELECT e.*,p.full_name AS teacher_name FROM timetable_entries e
    JOIN personnel_records p ON p.id=e.teacher_id WHERE e.plan_id=?
    ORDER BY e.grade_level,e.classroom,e.weekday,e.period`).bind(chosen.id).all():{results:[]};
  return reply({term,plan:chosen,entries:rows.results});
}
async function saveSlot(request,env,term,user){
  const body=await request.json().catch(()=>null);
  const grade=text(body?.grade_level,80),room=text(body?.classroom,80),subject=text(body?.subject,120),roomName=text(body?.room_name,100);
  const day=Number(body?.weekday),period=Number(body?.period),teacherId=validId(body?.teacher_id);
  if(!grade||!room||!subject||subject.length>120||grade.length>80||room.length>80||roomName.length>100||
    !Number.isInteger(day)||day<1||day>5||!Number.isInteger(period)||period<1||period>6||!teacherId)
    return reply({error:"กรอกชั้น ห้อง วัน คาบ วิชา และครูให้ถูกต้อง"},400);
  const [knownRoom,teacher]=await Promise.all([
    env.DB.prepare("SELECT 1 FROM student_enrollments WHERE academic_term_id=? AND grade_level=? AND classroom=? AND status='enrolled' LIMIT 1").bind(term.id,grade,room).first(),
    env.DB.prepare(`SELECT p.id FROM personnel_records p LEFT JOIN users u ON u.id=p.user_id
      WHERE p.id=? AND p.status='active' AND (p.user_id IS NULL OR u.role IN ('teacher','staff'))`).bind(teacherId).first()
  ]);
  if(!knownRoom||!teacher)return reply({error:"ไม่พบห้องเรียนหรือครูในทะเบียน กรุณานำเข้าข้อมูลก่อน"},400);
  const current=await draft(env,term.id,user.id);
  try{
    await env.DB.prepare(`INSERT INTO timetable_entries(plan_id,grade_level,classroom,weekday,period,subject,teacher_id,room_name)
      VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(plan_id,grade_level,classroom,weekday,period)
      DO UPDATE SET subject=excluded.subject,teacher_id=excluded.teacher_id,room_name=excluded.room_name`)
      .bind(current.id,grade,room,day,period,subject,teacherId,roomName||null).run();
  }catch(error){if(/UNIQUE constraint/i.test(String(error)))return reply({error:"ครูหรือห้องสอนชนกับอีกชั้นในคาบนี้"},409);throw error;}
  return reply({ok:true});
}
async function deleteSlot(env,term,id){
  const current=await plan(env,term.id,"draft");if(!current)return reply({error:"ยังไม่มีร่างตาราง"},404);
  const result=await env.DB.prepare("DELETE FROM timetable_entries WHERE id=? AND plan_id=?").bind(id,current.id).run();
  return result.meta.changes?reply({ok:true}):reply({error:"ไม่พบคาบในร่าง"},404);
}
async function moveSlot(request,env,term,id){
  const body=await request.json().catch(()=>null),day=Number(body?.weekday),period=Number(body?.period);
  if(!Number.isInteger(day)||day<1||day>5||!Number.isInteger(period)||period<1||period>6)
    return reply({error:"วันหรือคาบไม่ถูกต้อง"},400);
  const current=await plan(env,term.id,"draft");if(!current)return reply({error:"ยังไม่มีร่างตาราง"},404);
  try{
    const result=await env.DB.prepare("UPDATE timetable_entries SET weekday=?,period=? WHERE id=? AND plan_id=?")
      .bind(day,period,id,current.id).run();
    return result.meta.changes?reply({ok:true}):reply({error:"ไม่พบคาบในร่าง"},404);
  }catch(error){if(/UNIQUE constraint/i.test(String(error)))return reply({error:"คาบปลายทางไม่ว่าง หรือครู/ห้องสอนชนกัน"},409);throw error;}
}
async function publish(env,term){
  const current=await plan(env,term.id,"draft");if(!current)return reply({error:"ยังไม่มีร่างตารางให้เผยแพร่"},400);
  const size=await env.DB.prepare("SELECT COUNT(*) AS count FROM timetable_entries WHERE plan_id=?").bind(current.id).first();
  if(!size.count)return reply({error:"เพิ่มคาบเรียนก่อนเผยแพร่"},400);
  await env.DB.batch([
    env.DB.prepare("UPDATE timetable_plans SET status='archived' WHERE academic_term_id=? AND status='published'").bind(term.id),
    env.DB.prepare("UPDATE timetable_plans SET status='published',published_at=datetime('now') WHERE id=? AND status='draft'").bind(current.id)
  ]);
  return reply({ok:true});
}

function weekday(date){const day=new Date(`${date}T12:00:00Z`).getUTCDay();return day>=1&&day<=5?day:null;}
async function coverage(env,date,teacherId){
  if(!validDate(date)||!teacherId)return reply({error:"เลือกวันที่และครูให้ถูกต้อง"},400);
  const day=weekday(date);if(!day)return reply({error:"เลือกวันจันทร์ถึงศุกร์"},400);
  const term=await env.DB.prepare(`SELECT t.id,t.name,y.year_be FROM academic_terms t JOIN academic_years y ON y.id=t.academic_year_id
    WHERE ? BETWEEN t.start_date AND t.end_date ORDER BY t.id DESC LIMIT 1`).bind(date).first();
  if(!term)return reply({error:"ไม่พบภาคเรียนที่ครอบคลุมวันที่นี้"},404);
  const published=await plan(env,term.id,"published");if(!published)return reply({error:"ยังไม่มีตารางสอนที่เผยแพร่ในภาคเรียนนี้"},400);
  const {results:lessons}=await env.DB.prepare(`SELECT e.id,e.grade_level,e.classroom,e.period,e.subject,e.room_name,
    a.id AS assignment_id,a.substitute_teacher_id,p.full_name AS substitute_name
    FROM timetable_entries e LEFT JOIN substitute_assignments a ON a.timetable_entry_id=e.id AND a.absence_date=?
    LEFT JOIN personnel_records p ON p.id=a.substitute_teacher_id
    WHERE e.plan_id=? AND e.weekday=? AND e.teacher_id=? ORDER BY e.period,e.grade_level,e.classroom`)
    .bind(date,published.id,day,teacherId).all();
  const {results:teachers}=await env.DB.prepare(`SELECT p.id,p.full_name FROM personnel_records p LEFT JOIN users u ON u.id=p.user_id
    WHERE p.status='active' AND p.id<>? AND (p.user_id IS NULL OR u.role IN ('teacher','staff')) ORDER BY p.full_name`).bind(teacherId).all();
  const {results:busy}=await env.DB.prepare(`SELECT teacher_id AS id,period FROM timetable_entries WHERE plan_id=? AND weekday=?
    UNION SELECT substitute_teacher_id AS id,period FROM substitute_assignments WHERE absence_date=?
    UNION SELECT a.teacher_id AS id,e.period FROM substitute_absences a
      JOIN timetable_entries e ON e.teacher_id=a.teacher_id AND e.plan_id=? AND e.weekday=? WHERE a.absence_date=?`)
    .bind(published.id,day,date,published.id,day,date).all();
  const {results:absences}=await env.DB.prepare("SELECT teacher_id FROM substitute_absences WHERE absence_date=?").bind(date).all();
  const unavailable=new Set(absences.map(a=>a.teacher_id));
  return reply({term,date,teacher_id:teacherId,lessons:lessons.map(l=>({...l,available_teachers:teachers.filter(t=>!unavailable.has(t.id)&&!busy.some(b=>b.id===t.id&&b.period===l.period))}))});
}
async function assign(request,env,user){
  const body=await request.json().catch(()=>null),date=body?.date,teacherId=validId(body?.teacher_id),entryId=validId(body?.entry_id),subId=validId(body?.substitute_teacher_id);
  if(!validDate(date)||!teacherId||!entryId||!subId||teacherId===subId)return reply({error:"เลือกวัน ครู คาบ และครูสอนแทนให้ถูกต้อง"},400);
  const result=await coverage(env,date,teacherId);
  if(result.status!==200)return result;
  const data=await result.json(),lesson=data.lessons.find(x=>x.id===entryId);
  if(!lesson||!lesson.available_teachers.some(t=>t.id===subId))return reply({error:"ครูสอนแทนไม่ว่างหรือคาบนี้ถูกจัดแล้ว"},409);
  const reason=text(body.reason,300),notes=text(body.notes,300);
  if(reason.length>300||notes.length>300)return reply({error:"หมายเหตุยาวเกินกำหนด"},400);
  await env.DB.prepare("INSERT OR IGNORE INTO substitute_absences(absence_date,teacher_id,reason,created_by) VALUES (?,?,?,?)")
    .bind(date,teacherId,reason||null,user.id).run();
  const absence=await env.DB.prepare("SELECT id FROM substitute_absences WHERE absence_date=? AND teacher_id=?").bind(date,teacherId).first();
  try{await env.DB.prepare(`INSERT INTO substitute_assignments(absence_id,timetable_entry_id,substitute_teacher_id,weekday,period,absence_date,notes,created_by)
    VALUES (?,?,?,?,?,?,?,?)`).bind(absence.id,entryId,subId,weekday(date),lesson.period,date,notes||null,user.id).run();}
  catch(error){if(/UNIQUE constraint/i.test(String(error)))return reply({error:"คาบนี้มีการมอบหมายครูแล้ว กรุณารีเฟรช"},409);throw error;}
  return reply({ok:true});
}
async function assignments(env,date){
  if(!validDate(date))return reply({error:"เลือกวันที่ให้ถูกต้อง"},400);
  const {results}=await env.DB.prepare(`SELECT a.id,a.absence_date,a.period,a.notes,e.subject,e.grade_level,e.classroom,
    absent.full_name AS absent_name,sub.full_name AS substitute_name
    FROM substitute_assignments a JOIN substitute_absences ab ON ab.id=a.absence_id
    JOIN timetable_entries e ON e.id=a.timetable_entry_id
    JOIN personnel_records absent ON absent.id=ab.teacher_id
    JOIN personnel_records sub ON sub.id=a.substitute_teacher_id
    WHERE a.absence_date=? ORDER BY a.period,e.grade_level,e.classroom`).bind(date).all();
  return reply({assignments:results});
}

export async function handleTimetableRoute(request,env,pathname,method){
  if(!pathname.startsWith("/api/timetable/")&&!pathname.startsWith("/api/substitutes/"))return null;
  const user=await getCurrentUser(request,env);if(!user||!user.role)return reply({error:"กรุณาเข้าสู่ระบบ"},401);
  if(!["teacher","staff","executive","superadmin"].includes(user.role))return reply({error:"ไม่มีสิทธิ์เข้าถึง"},403);
  await ensurePersonnelData(env);await ensureSchema(env);
  const url=new URL(request.url),isTimetable=pathname.startsWith("/api/timetable/");
  if(isTimetable){
    const term=await termById(env,validId(method==="GET"||method==="DELETE"?url.searchParams.get("term_id"):(await request.clone().json().catch(()=>null))?.term_id));
    if(!term)return reply({error:"เลือกภาคเรียนจากระบบก่อน"},400);
    if(pathname==="/api/timetable/setup"&&method==="GET")return setup(env,term);
    if(pathname==="/api/timetable/entries"&&method==="GET")return entries(env,term,url.searchParams.get("view")==="draft"?"draft":"published");
    if(!isAdmin(user))return reply({error:"ผู้บริหารหรือผู้ดูแลระบบเท่านั้นที่แก้ตารางสอนได้"},403);
    if(pathname==="/api/timetable/slot"&&method==="PUT")return saveSlot(request,env,term,user);
    const removed=pathname.match(/^\/api\/timetable\/slot\/(\d+)$/);
    if(removed&&method==="DELETE")return deleteSlot(env,term,Number(removed[1]));
    if(removed&&method==="PATCH")return moveSlot(request,env,term,Number(removed[1]));
    if(pathname==="/api/timetable/publish"&&method==="POST")return publish(env,term);
  }else{
    if(pathname==="/api/substitutes/coverage"&&method==="GET")return coverage(env,url.searchParams.get("date"),validId(url.searchParams.get("teacher_id")));
    if(pathname==="/api/substitutes/assignments"&&method==="GET")return assignments(env,url.searchParams.get("date"));
    if(!isAdmin(user))return reply({error:"ผู้บริหารหรือผู้ดูแลระบบเท่านั้นที่จัดครูสอนแทนได้"},403);
    if(pathname==="/api/substitutes/assignments"&&method==="POST")return assign(request,env,user);
  }
  return reply({error:"ไม่พบ endpoint"},404);
}
