import {substituteLoad,canViewPersonnelStats} from '../lib/personnel-stats.js';
import {loadStructure,validateStructure,ensureStructureSchema,canEditStructure,BANDS} from "../lib/timetable-structure.js";
import {ensureAcademicData} from "../lib/academic-data.js";
import {canManageTimetable,canViewAllTimetables} from "../lib/timetable-permissions.js";
import {handleAuto} from "./timetable-auto.js";
import {normalizeRoomName,roomNameKey} from "../lib/timetable-solver.js";
import {ensureLeaveData} from "../lib/leave-data.js";
import {canManageSubstitutes} from "../lib/substitute-permissions.js";
import { getCurrentUser, jsonResponse } from "../lib/auth.js";
import { ensurePersonnelData, linkExistingAccounts } from "../lib/personnel-data.js";
import { teachingMaster, subjectsOfRoom, normalizeSubject } from "../lib/teaching-master.js";

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
  const {results:columns}=await env.DB.prepare("PRAGMA table_info(substitute_assignments)").all();
  if(!columns.some(c=>c.name==='leave_request_id')){
    try{await env.DB.prepare("ALTER TABLE substitute_assignments ADD COLUMN leave_request_id INTEGER REFERENCES leave_requests(id) ON DELETE SET NULL").run();}
    catch(e){if(!/duplicate column name/i.test(String(e)))throw e;}
  }
  // บันทึกการยกเลิก/เปลี่ยนครูสอนแทน — ใช้แจ้งครูที่ถูกยกเลิก (กระดิ่ง + LINE) และเป็นประวัติ
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS substitute_cancellations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    assignment_id INTEGER NOT NULL, substitute_teacher_id INTEGER NOT NULL REFERENCES personnel_records(id),
    absence_date TEXT NOT NULL, period INTEGER NOT NULL,
    grade_level TEXT, classroom TEXT, subject TEXT, absent_name TEXT,
    action TEXT NOT NULL CHECK(action IN ('cancelled','replaced')),
    cancelled_by INTEGER NOT NULL REFERENCES users(id),
    created_at TEXT NOT NULL DEFAULT(datetime('now'))
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
async function setup(env,term,canManage=false){
  // ภาระสอน (วิชา × ห้อง × ครู) จากฝ่ายวัดผล — ข้อมูลกลางที่ตารางสอนต้องยึด
  let master=await teachingMaster(env,{termId:term.id});
  if(master.unlinked.length){await linkExistingAccounts(env);master=await teachingMaster(env,{termId:term.id});}
  const [classes,teachers,published,draftPlan]=await Promise.all([
    env.DB.prepare(`SELECT grade_level,classroom,COUNT(*) AS students FROM student_enrollments
      WHERE academic_term_id=? AND status='enrolled' AND TRIM(COALESCE(grade_level,''))<>'' AND TRIM(COALESCE(classroom,''))<>''
      GROUP BY grade_level,classroom ORDER BY grade_level,classroom`).bind(term.id).all(),
    env.DB.prepare(`SELECT p.id,p.full_name,p.subjects,p.homeroom_classroom FROM personnel_records p
      LEFT JOIN users u ON u.id=p.user_id WHERE p.status='active' AND (p.user_id IS NULL OR u.role IN ('teacher','staff'))
      ORDER BY p.full_name`).all(),
    plan(env,term.id,"published"),plan(env,term.id,"draft")
  ]);
  // ครูประจำชั้น (จากระบบรายงานผลการเรียน) — ใช้เป็นผู้สอนคาบกิจกรรมพัฒนาผู้เรียนตั้งต้น
  const hasHomerooms=await env.DB.prepare("SELECT 1 AS ok FROM sqlite_master WHERE type='table' AND name='gr_homerooms'").first();
  const homerooms=hasHomerooms?(await env.DB.prepare(`SELECT h.grade_level,h.classroom,p.id AS personnel_id FROM gr_homerooms h
    JOIN personnel_records p ON p.user_id=h.user_id AND p.status='active' WHERE h.academic_year_id=(SELECT academic_year_id FROM academic_terms WHERE id=?) ORDER BY h.grade_level,h.classroom,p.full_name`).bind(term.id).all()).results:[];
  return reply({term,classes:classes.results,teachers:teachers.results,published,draft:draftPlan,can_manage:canManage,master,homerooms});
}
async function entries(env,term,view){
  const chosen=await plan(env,term.id,view);
  const rows=chosen?await env.DB.prepare(`SELECT e.*,p.full_name AS teacher_name FROM timetable_entries e
    JOIN personnel_records p ON p.id=e.teacher_id WHERE e.plan_id=?
    ORDER BY e.grade_level,e.classroom,e.weekday,e.period`).bind(chosen.id).all():{results:[]};
  return reply({term,plan:chosen,entries:rows.results});
}
// ตารางสอนรวม: ร่างดูได้เฉพาะผู้จัดตาราง, ตารางที่เผยแพร่ดูได้เฉพาะผู้จัดตาราง/หัวหน้าฝ่ายวิชาการ/ผู้บริหาร/ผู้ดูแลระบบ
async function guardedEntries(env,user,term,view){
  const canManage=await canManageTimetable(env,user);
  if(view==="draft"&&!canManage)return reply({error:"เฉพาะผู้จัดตารางสอนที่ดูร่างตารางได้"},403);
  if(!canManage&&!(await canViewAllTimetables(env,user)))return reply({error:"เฉพาะหัวหน้าฝ่ายวิชาการ ผู้บริหาร หรือผู้ดูแลระบบ"},403);
  return entries(env,term,view);
}
async function timetablePermissions(env,user){
  return reply({view_all:await canViewAllTimetables(env,user),manage:await canManageTimetable(env,user)});
}
// ตารางสอนของฉัน (หน้าบัญชีของฉัน): เห็นเฉพาะคาบของตนเองในตารางที่เผยแพร่
async function mySchedule(env,user,termId){
  const {results:terms}=await env.DB.prepare(`SELECT t.*,y.year_be FROM academic_terms t JOIN academic_years y ON y.id=t.academic_year_id
    ORDER BY y.year_be DESC,t.id DESC`).all();
  const term=termId?terms.find(t=>t.id===termId):(terms.find(t=>t.status==="active")||terms[0]);
  const list=terms.map(t=>({id:t.id,name:t.name,year_be:t.year_be}));
  if(!term)return reply({term:null,terms:list,entries:[]});
  const published=await plan(env,term.id,"published");
  const {results:mine}=await env.DB.prepare(`SELECT id FROM personnel_records WHERE user_id=?
    UNION SELECT personnel_id AS id FROM personnel_accounts WHERE user_id=?`).bind(user.id,user.id).all();
  const ids=mine.map(r=>r.id).filter(Boolean);
  const rows=published&&ids.length?(await env.DB.prepare(`SELECT id,grade_level,classroom,weekday,period,subject,room_name FROM timetable_entries
    WHERE plan_id=? AND teacher_id IN (${ids.map(()=>"?").join(",")}) ORDER BY weekday,period`).bind(published.id,...ids).all()).results:[];
  return reply({term:{id:term.id,name:term.name,year_be:term.year_be},terms:list,published:!!published,entries:rows});
}
async function saveSlot(request,env,term,user){
  const body=await request.json().catch(()=>null);
  const grade=text(body?.grade_level,80),room=text(body?.classroom,80),subject=text(body?.subject,120),rawRoomName=text(body?.room_name,100);
  const day=Number(body?.weekday),period=Number(body?.period),teacherId=validId(body?.teacher_id);
  if(!grade||!room||!subject||subject.length>120||grade.length>80||room.length>80||rawRoomName.length>100||
    !Number.isInteger(day)||day<1||day>5||!Number.isInteger(period)||period<1||period>6||!teacherId)
    return reply({error:"กรอกชั้น ห้อง วัน คาบ วิชา และครูให้ถูกต้อง"},400);
  const [knownRoom,teacher]=await Promise.all([
    env.DB.prepare("SELECT 1 FROM student_enrollments WHERE academic_term_id=? AND grade_level=? AND classroom=? AND status='enrolled' LIMIT 1").bind(term.id,grade,room).first(),
    env.DB.prepare(`SELECT p.id FROM personnel_records p LEFT JOIN users u ON u.id=p.user_id
      WHERE p.id=? AND p.status='active' AND (p.user_id IS NULL OR u.role IN ('teacher','staff'))`).bind(teacherId).first()
  ]);
  if(!knownRoom||!teacher)return reply({error:"ไม่พบห้องเรียนหรือครูในทะเบียน กรุณานำเข้าข้อมูลก่อน"},400);
  // วิชาที่ฝ่ายวัดผลกำหนดครูผู้สอนไว้แล้ว ต้องลงด้วยครูผู้สอนของวิชานั้นเท่านั้น (กิจกรรม เช่น แนะแนว ลูกเสือ ลงได้อิสระ)
  const master=await teachingMaster(env,{termId:term.id});
  const course=subjectsOfRoom(master,grade,room).get(normalizeSubject(subject));
  if(course&&!course.teachers.some(t=>t.personnel_id===teacherId))
    return reply({error:`วิชา${course.subject} ห้อง ${grade}/${room} ฝ่ายวัดผลกำหนดครูผู้สอนเป็น ${course.teachers.map(t=>t.full_name).join(", ")} — แก้ครูผู้สอนได้ที่ระบบรายงานผลการเรียน`},409);
  const current=await draft(env,term.id,user.id);
  // ห้องสอนเฉพาะ: ใช้ตัวสะกดเดิมที่มีในร่างแล้ว ("ห้อง คอม" = "ห้องคอม") เพื่อให้ตรวจห้องชนได้จริง
  let roomName=normalizeRoomName(rawRoomName);
  if(roomName){
    const {results:names}=await env.DB.prepare("SELECT DISTINCT room_name FROM timetable_entries WHERE plan_id=? AND TRIM(COALESCE(room_name,''))<>''").bind(current.id).all();
    roomName=names.map(r=>r.room_name).find(n=>roomNameKey(n)===roomNameKey(roomName))||roomName;
  }
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
async function publish(env,term,user){
  const current=await plan(env,term.id,"draft");if(!current)return reply({error:"ยังไม่มีร่างตารางให้เผยแพร่"},400);
  const size=await env.DB.prepare("SELECT COUNT(*) AS count FROM timetable_entries WHERE plan_id=?").bind(current.id).first();
  if(!size.count)return reply({error:"เพิ่มคาบเรียนก่อนเผยแพร่"},400);
  const previous=await plan(env,term.id,"published");
  await env.DB.batch([
    env.DB.prepare("UPDATE timetable_plans SET status='archived' WHERE academic_term_id=? AND status='published'").bind(term.id),
    env.DB.prepare("UPDATE timetable_plans SET status='published',published_at=datetime('now') WHERE id=? AND status='draft'").bind(current.id)
  ]);
  const substitutes=previous?await syncSubstitutes(env,previous.id,current.id,user):{remapped:0,cancelled:0};
  return reply({ok:true,substitutes});
}
// ตารางสอนเปลี่ยน (เผยแพร่ใหม่): คาบสอนแทนตั้งแต่วันนี้ที่ผูกกับตารางเดิม
// - คาบเดิมยังอยู่ (ครู/ชั้น/ห้อง/วัน/คาบเดียวกัน) และครูสอนแทนยังว่าง → ย้ายไปผูกกับตารางใหม่อัตโนมัติ
// - คาบถูกย้าย/ลบ หรือครูสอนแทนมีคาบสอนเองแล้ว → ยกเลิก แจ้งครูสอนแทน และให้ระบบเสนอครูใหม่ในหน้าจัดสอนแทน
async function syncSubstitutes(env,oldPlanId,newPlanId,user){
  const {results}=await env.DB.prepare(`SELECT a.id,a.absence_date,a.substitute_teacher_id,e.teacher_id,e.grade_level,e.classroom,e.weekday,e.period
    FROM substitute_assignments a JOIN timetable_entries e ON e.id=a.timetable_entry_id
    WHERE e.plan_id=? AND a.absence_date>=date('now','+7 hours')`).bind(oldPlanId).all();
  let remapped=0,cancelled=0;
  for(const r of results){
    const next=await env.DB.prepare(`SELECT id FROM timetable_entries WHERE plan_id=? AND teacher_id=? AND grade_level=? AND classroom=? AND weekday=? AND period=?`)
      .bind(newPlanId,r.teacher_id,r.grade_level,r.classroom,r.weekday,r.period).first();
    const busy=next&&await env.DB.prepare("SELECT 1 FROM timetable_entries WHERE plan_id=? AND teacher_id=? AND weekday=? AND period=?")
      .bind(newPlanId,r.substitute_teacher_id,r.weekday,r.period).first();
    if(next&&!busy){await env.DB.prepare("UPDATE substitute_assignments SET timetable_entry_id=? WHERE id=?").bind(next.id,r.id).run();remapped++;continue;}
    const a=await assignmentDetail(env,r.id);if(!a)continue;
    await env.DB.batch([cancellationRow(env,a,'cancelled',user),env.DB.prepare("DELETE FROM substitute_assignments WHERE id=?").bind(r.id)]);
    cancelled++;
  }
  return {remapped,cancelled};
}

function weekday(date){const day=new Date(`${date}T12:00:00Z`).getUTCDay();return day>=1&&day<=5?day:null;}
// Canonical personnel accounts include prior accounts merged into the same teacher.
async function leaveAbsences(env,date){
  if(!validDate(date))return reply({error:"เลือกวันที่ให้ถูกต้อง"},400);
  const {results}=await env.DB.prepare(`SELECT r.id AS leave_request_id,p.id AS teacher_id,p.full_name,
    COALESCE(r.leave_subtype,r.leave_type) AS leave_type,r.start_date,r.end_date,r.leave_days,r.status,r.workflow_stage
    FROM leave_requests r JOIN personnel_accounts a ON a.user_id=r.user_id
    JOIN personnel_records p ON p.id=a.personnel_id AND p.status='active'
    WHERE ? BETWEEN r.start_date AND r.end_date AND r.status IN ('pending','approved')
    ORDER BY CASE r.status WHEN 'approved' THEN 0 ELSE 1 END,p.full_name,r.id`).bind(date).all();
  return reply({date,leave_requests:results});
}
async function sourceLeave(env,id,date,teacherId){
  return env.DB.prepare(`SELECT r.id FROM leave_requests r JOIN personnel_accounts a ON a.user_id=r.user_id
    JOIN personnel_records p ON p.id=a.personnel_id AND p.status='active'
    WHERE r.id=? AND a.personnel_id=? AND ? BETWEEN r.start_date AND r.end_date
    AND r.status IN ('pending','approved')`).bind(id,teacherId,date).first();
}
async function coverage(env,date,teacherId){
  if(!validDate(date)||!teacherId)return reply({error:"เลือกวันที่และครูให้ถูกต้อง"},400);
  const day=weekday(date);if(!day)return reply({error:"เลือกวันจันทร์ถึงศุกร์"},400);
  const term=await env.DB.prepare(`SELECT t.id,t.name,y.year_be,t.start_date,t.end_date FROM academic_terms t JOIN academic_years y ON y.id=t.academic_year_id
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
  const leaveData=await (await leaveAbsences(env,date)).json();
  const unavailable=new Set([...absences.map(a=>a.teacher_id),...leaveData.leave_requests.map(r=>r.teacher_id)]);
  // ภาระสอนแทนของสัปดาห์/เดือนของวันที่เลือก — ตัวเลขชุดเดียวกับหน้าสถิติการสอนแทนและแดชบอร์ด
  // เรียงครูที่ถูกจัดน้อยก่อน เพื่อกระจายงานสอนแทนให้เท่ากัน
  const load=await substituteLoad(env,{date});const loadById=new Map((load.people||[]).map(p=>[p.personnel_id,p]));
  // ช่วงชั้นของครูดูจากตารางสอนที่เผยแพร่ (ครูที่สอนหลายช่วงชั้น = ควบช่วงชั้น จัดได้ทุกช่วงที่สอน); ครูที่ไม่มีคาบในตารางไม่ถูกจัด
  const {results:gradeRows}=await env.DB.prepare("SELECT DISTINCT teacher_id,grade_level FROM timetable_entries WHERE plan_id=? AND teacher_id IS NOT NULL").bind(published.id).all();
  const bands=new Map();for(const r of gradeRows){if(!bands.has(r.teacher_id))bands.set(r.teacher_id,new Set());bands.get(r.teacher_id).add(gradeBand(r.grade_level));}
  // สถิติทั้งภาคเรียน + วันล่าสุดที่สอนแทน + จำนวนคาบที่ถูกจัดในวันนี้ — ใช้เลือกครูที่ถูกจัดน้อยและไม่ซ้ำคนเดิม
  const {results:termRows}=await env.DB.prepare(`SELECT substitute_teacher_id AS id,COUNT(*) AS term_count,MAX(absence_date) AS last_date,
    SUM(CASE WHEN absence_date=? THEN 1 ELSE 0 END) AS day_count FROM substitute_assignments WHERE absence_date BETWEEN ? AND ? GROUP BY substitute_teacher_id`)
    .bind(date,term.start_date,term.end_date).all();
  const termById=new Map(termRows.map(r=>[r.id,r]));
  const withLoad=teachers.filter(t=>bands.has(t.id)).map(t=>({...t,bands:[...bands.get(t.id)],week_count:loadById.get(t.id)?.week||0,month_count:loadById.get(t.id)?.month||0,
    term_count:termById.get(t.id)?.term_count||0,day_count:termById.get(t.id)?.day_count||0,last_date:termById.get(t.id)?.last_date||null}))
    .sort((a,b)=>a.term_count-b.term_count||a.month_count-b.month_count||a.week_count-b.week_count||String(a.full_name).localeCompare(String(b.full_name),'th'));
  const result=lessons.map(l=>{const band=gradeBand(l.grade_level);return {...l,band,available_teachers:withLoad.filter(t=>t.bands.includes(band)&&!unavailable.has(t.id)&&!busy.some(b=>b.id===t.id&&b.period===l.period))};});
  // ข้อเสนอของระบบ: ทีละคาบ เลือกครูที่ (1) ถูกจัดในวันนั้นน้อยสุด รวมข้อเสนอก่อนหน้า (2) สอนแทนทั้งภาคเรียนน้อยสุด
  // (3) เดือน/สัปดาห์น้อยสุด (4) ไม่ได้สอนแทนนานสุด — ค่าเฉลี่ยจึงใกล้กันและไม่จัดคนเดิมซ้ำ ผู้จัดยอมรับหรือเลือกเองได้
  const extra=new Map();
  for(const l of result){
    if(l.assignment_id||!l.available_teachers.length){l.proposed_teacher_id=null;continue;}
    const score=t=>[(t.day_count||0)+(extra.get(t.id)||0),t.term_count+(extra.get(t.id)||0),t.month_count,t.week_count];
    const pick=[...l.available_teachers].sort((a,b)=>{const x=score(a),y=score(b);for(let i=0;i<x.length;i++)if(x[i]!==y[i])return x[i]-y[i];
      return String(a.last_date||'').localeCompare(String(b.last_date||''))||String(a.full_name).localeCompare(String(b.full_name),'th');})[0];
    l.proposed_teacher_id=pick.id;extra.set(pick.id,(extra.get(pick.id)||0)+1);
  }
  return reply({term,date,teacher_id:teacherId,load:{week:load.week,month:load.month},lessons:result});
}
// ช่วงชั้น: อนุบาล / ป.1-3 / ป.4-6
function gradeBand(grade){const s=String(grade||'');if(/^อ|อนุบาล/.test(s))return 'kindergarten';const n=Number((s.match(/\d+/)||[])[0]);
  return n>=1&&n<=3?'p1-3':n>=4&&n<=6?'p4-6':s;}
async function assign(request,env,user){
  const body=await request.json().catch(()=>null),date=body?.date,teacherId=validId(body?.teacher_id),entryId=validId(body?.entry_id),subId=validId(body?.substitute_teacher_id);
  if(!validDate(date)||!teacherId||!entryId||!subId||teacherId===subId)return reply({error:"เลือกวัน ครู คาบ และครูสอนแทนให้ถูกต้อง"},400);
  const leaveId=body.leave_request_id==null?null:validId(body.leave_request_id);
  if(body.leave_request_id!=null&&(!leaveId||!await sourceLeave(env,leaveId,date,teacherId)))
    return reply({error:"ใบลาไม่ตรงกับครูหรือวันที่ หรือถูกยกเลิก/ไม่อนุมัติแล้ว กรุณาโหลดข้อมูลใหม่"},409);
  // จัดแทนโดยไม่มีใบลา (ไปราชการ อบรม พานักเรียนไปกิจกรรม ฯลฯ) ต้องระบุเหตุที่ไม่อยู่
  if(leaveId==null&&!text(body.reason,300))return reply({error:"ระบุเหตุที่ครูไม่อยู่ เช่น ไปราชการ หรืออบรม"},400);
  const result=await coverage(env,date,teacherId);
  if(result.status!==200)return result;
  const data=await result.json(),lesson=data.lessons.find(x=>x.id===entryId);
  if(!lesson||!lesson.available_teachers.some(t=>t.id===subId))return reply({error:"ครูสอนแทนไม่ว่างหรือคาบนี้ถูกจัดแล้ว"},409);
  const reason=text(body.reason,300),notes=text(body.notes,300);
  if(reason.length>300||notes.length>300)return reply({error:"หมายเหตุยาวเกินกำหนด"},400);
  await env.DB.prepare("INSERT OR IGNORE INTO substitute_absences(absence_date,teacher_id,reason,created_by) VALUES (?,?,?,?)")
    .bind(date,teacherId,reason||null,user.id).run();
  const absence=await env.DB.prepare("SELECT id FROM substitute_absences WHERE absence_date=? AND teacher_id=?").bind(date,teacherId).first();
  try{const inserted=await env.DB.prepare(`INSERT INTO substitute_assignments(absence_id,timetable_entry_id,substitute_teacher_id,weekday,period,absence_date,notes,created_by,leave_request_id)
    SELECT ?,?,?,?,?,?,?,?,?
    WHERE (? IS NULL OR EXISTS(SELECT 1 FROM leave_requests r JOIN personnel_accounts a ON a.user_id=r.user_id
      WHERE r.id=? AND a.personnel_id=? AND ? BETWEEN r.start_date AND r.end_date AND r.status IN ('pending','approved')))
    AND NOT EXISTS(SELECT 1 FROM leave_requests r JOIN personnel_accounts a ON a.user_id=r.user_id
      WHERE a.personnel_id=? AND ? BETWEEN r.start_date AND r.end_date AND r.status IN ('pending','approved'))`)
    .bind(absence.id,entryId,subId,weekday(date),lesson.period,date,notes||null,user.id,leaveId,
      leaveId,leaveId,teacherId,date,subId,date).run();
    if(!inserted.meta.changes)return reply({error:"ข้อมูลการลาเปลี่ยนระหว่างบันทึก กรุณาโหลดข้อมูลใหม่"},409);
  }
  catch(error){if(/UNIQUE constraint/i.test(String(error)))return reply({error:"คาบนี้มีการมอบหมายครูแล้ว กรุณารีเฟรช"},409);throw error;}
  return reply({ok:true});
}
async function assignments(env,date){
  if(!validDate(date))return reply({error:"เลือกวันที่ให้ถูกต้อง"},400);
  const {results}=await env.DB.prepare(`SELECT a.id,a.absence_date,a.period,a.notes,a.leave_request_id,r.status AS leave_status,e.subject,e.grade_level,e.classroom,
    absent.full_name AS absent_name,sub.full_name AS substitute_name,ab.teacher_id AS absent_teacher_id,ab.reason AS absence_reason,
    a.substitute_teacher_id,a.timetable_entry_id AS entry_id
    FROM substitute_assignments a LEFT JOIN leave_requests r ON r.id=a.leave_request_id JOIN substitute_absences ab ON ab.id=a.absence_id
    JOIN timetable_entries e ON e.id=a.timetable_entry_id
    JOIN personnel_records absent ON absent.id=ab.teacher_id
    JOIN personnel_records sub ON sub.id=a.substitute_teacher_id
    WHERE a.absence_date=? ORDER BY a.period,e.grade_level,e.classroom`).bind(date).all();
  return reply({assignments:results});
}
// ครูที่มีคาบสอนในวันนั้นตามตารางที่เผยแพร่ — ใช้เลือกครูที่ไม่อยู่โดยไม่มีใบลา
async function teachersForDay(env,date){
  if(!validDate(date))return reply({error:"เลือกวันที่ให้ถูกต้อง"},400);
  const day=weekday(date);if(!day)return reply({error:"เลือกวันจันทร์ถึงศุกร์"},400);
  const term=await env.DB.prepare(`SELECT t.id FROM academic_terms t WHERE ? BETWEEN t.start_date AND t.end_date ORDER BY t.id DESC LIMIT 1`).bind(date).first();
  if(!term)return reply({error:"ไม่พบภาคเรียนที่ครอบคลุมวันที่นี้"},404);
  const published=await plan(env,term.id,"published");if(!published)return reply({error:"ยังไม่มีตารางสอนที่เผยแพร่ในภาคเรียนนี้"},400);
  const {results}=await env.DB.prepare(`SELECT p.id,p.full_name,COUNT(e.id) AS lesson_count,
    (SELECT ab.reason FROM substitute_absences ab WHERE ab.teacher_id=p.id AND ab.absence_date=?) AS absence_reason
    FROM personnel_records p JOIN timetable_entries e ON e.teacher_id=p.id AND e.plan_id=? AND e.weekday=?
    WHERE p.status='active' GROUP BY p.id ORDER BY p.full_name`).bind(date,published.id,day).all();
  return reply({date,teachers:results});
}
async function assignmentDetail(env,id){
  return env.DB.prepare(`SELECT a.id,a.absence_id,a.absence_date,a.period,a.timetable_entry_id,a.substitute_teacher_id,ab.teacher_id AS absent_teacher_id,
    e.grade_level,e.classroom,e.subject,absent.full_name AS absent_name
    FROM substitute_assignments a JOIN substitute_absences ab ON ab.id=a.absence_id
    LEFT JOIN timetable_entries e ON e.id=a.timetable_entry_id LEFT JOIN personnel_records absent ON absent.id=ab.teacher_id WHERE a.id=?`).bind(id).first();
}
function cancellationRow(env,a,action,user){
  return env.DB.prepare(`INSERT INTO substitute_cancellations(assignment_id,substitute_teacher_id,absence_date,period,grade_level,classroom,subject,absent_name,action,cancelled_by)
    VALUES(?,?,?,?,?,?,?,?,?,?)`).bind(a.id,a.substitute_teacher_id,a.absence_date,a.period,a.grade_level,a.classroom,a.subject,a.absent_name,action,user.id);
}
// ยกเลิกครูสอนแทน: เก็บประวัติ + แจ้งครูที่ถูกยกเลิก; ถ้าครูที่ไม่อยู่ไม่เหลือคาบที่จัดแทนในวันนั้น ลบรายการไม่อยู่ออกด้วย
async function cancelAssignment(env,id,user){
  const a=await assignmentDetail(env,id);if(!a)return reply({error:"ไม่พบรายการสอนแทน กรุณารีเฟรช"},404);
  await env.DB.batch([
    cancellationRow(env,a,'cancelled',user),
    env.DB.prepare("DELETE FROM substitute_assignments WHERE id=?").bind(id),
    env.DB.prepare("DELETE FROM substitute_absences WHERE id=? AND NOT EXISTS(SELECT 1 FROM substitute_assignments WHERE absence_id=?)").bind(a.absence_id,a.absence_id)
  ]);
  return reply({ok:true});
}
// เปลี่ยนครูสอนแทน: ตรวจว่าครูใหม่ว่างในคาบนั้น (เงื่อนไขเดียวกับตอนจัด) แล้วแจ้งทั้งครูเดิม (ยกเลิก) และครูใหม่ (ได้รับมอบหมาย)
async function changeAssignment(request,env,id,user){
  const body=await request.json().catch(()=>null),subId=validId(body?.substitute_teacher_id);
  if(!subId)return reply({error:"เลือกครูสอนแทนคนใหม่"},400);
  const a=await assignmentDetail(env,id);if(!a)return reply({error:"ไม่พบรายการสอนแทน กรุณารีเฟรช"},404);
  if(subId===a.substitute_teacher_id)return reply({error:"เป็นครูคนเดิมอยู่แล้ว"},400);
  const result=await coverage(env,a.absence_date,a.absent_teacher_id);if(result.status!==200)return result;
  const lesson=(await result.json()).lessons.find(x=>x.id===a.timetable_entry_id);
  if(!lesson||!lesson.available_teachers.some(t=>t.id===subId))return reply({error:"ครูที่เลือกไม่ว่างในคาบนี้ กรุณาเลือกใหม่"},409);
  try{
    // UPDATE ก่อน แล้วบันทึกการยกเลิกของครูเดิมเฉพาะเมื่อเปลี่ยนสำเร็จ (ทั้งหมดอยู่ใน transaction เดียวกัน)
    const [updated]=await env.DB.batch([
      env.DB.prepare(`UPDATE substitute_assignments SET substitute_teacher_id=?,created_by=?,created_at=datetime('now')
        WHERE id=? AND substitute_teacher_id=? AND NOT EXISTS(SELECT 1 FROM leave_requests r JOIN personnel_accounts pa ON pa.user_id=r.user_id
        WHERE pa.personnel_id=? AND ? BETWEEN r.start_date AND r.end_date AND r.status IN ('pending','approved'))`)
        .bind(subId,user.id,id,a.substitute_teacher_id,subId,a.absence_date),
      env.DB.prepare(`INSERT INTO substitute_cancellations(assignment_id,substitute_teacher_id,absence_date,period,grade_level,classroom,subject,absent_name,action,cancelled_by)
        SELECT ?,?,?,?,?,?,?,?,'replaced',? WHERE EXISTS(SELECT 1 FROM substitute_assignments WHERE id=? AND substitute_teacher_id=?)`)
        .bind(a.id,a.substitute_teacher_id,a.absence_date,a.period,a.grade_level,a.classroom,a.subject,a.absent_name,user.id,id,subId)
    ]);
    if(!updated.meta.changes)return reply({error:"ข้อมูลเปลี่ยนระหว่างบันทึก กรุณาโหลดข้อมูลใหม่"},409);
  }catch(error){if(/UNIQUE constraint/i.test(String(error)))return reply({error:"ครูที่เลือกถูกจัดสอนแทนในคาบนี้แล้ว กรุณารีเฟรช"},409);throw error;}
  return reply({ok:true});
}
// หน้าคาบสอนแทนของฉัน: ครูทุกคนดูได้เฉพาะของตัวเอง (ผ่านบัญชีที่ผูกกับทะเบียนบุคลากร)
async function mine(env,user){
  const {results:people}=await env.DB.prepare("SELECT personnel_id FROM personnel_accounts WHERE user_id=?").bind(user.id).all();
  const ids=people.map(p=>p.personnel_id);
  if(!ids.length)return reply({linked:false,today:null,teaching:[],covered:[],cancelled:[]});
  const marks=ids.map(()=>'?').join(',');
  const today=(await env.DB.prepare("SELECT date('now','+7 hours') AS d").first()).d;
  const {results:teaching}=await env.DB.prepare(`SELECT a.id,a.absence_date,a.period,a.notes,e.grade_level,e.classroom,e.subject,e.room_name,
    absent.full_name AS absent_name,ab.reason AS absence_reason,a.created_at
    FROM substitute_assignments a JOIN substitute_absences ab ON ab.id=a.absence_id
    LEFT JOIN timetable_entries e ON e.id=a.timetable_entry_id LEFT JOIN personnel_records absent ON absent.id=ab.teacher_id
    WHERE a.substitute_teacher_id IN (${marks}) AND a.absence_date>=date(?,'-30 days')
    ORDER BY a.absence_date DESC,a.period`).bind(...ids,today).all();
  const {results:covered}=await env.DB.prepare(`SELECT a.id,a.absence_date,a.period,e.grade_level,e.classroom,e.subject,sub.full_name AS substitute_name
    FROM substitute_assignments a JOIN substitute_absences ab ON ab.id=a.absence_id
    LEFT JOIN timetable_entries e ON e.id=a.timetable_entry_id LEFT JOIN personnel_records sub ON sub.id=a.substitute_teacher_id
    WHERE ab.teacher_id IN (${marks}) AND a.absence_date>=date(?,'-30 days')
    ORDER BY a.absence_date DESC,a.period`).bind(...ids,today).all();
  const {results:cancelled}=await env.DB.prepare(`SELECT id,absence_date,period,grade_level,classroom,subject,absent_name,action,created_at
    FROM substitute_cancellations WHERE substitute_teacher_id IN (${marks}) AND absence_date>=?
    ORDER BY absence_date,period`).bind(...ids,today).all();
  return reply({linked:true,today,teaching,covered,cancelled});
}

// Timetable reads must not initialize budget, inventory, documents or personnel backfills.
export async function handleTimetableReadRoute(request,env,pathname,method){
  if(method!=="GET"||!["/api/timetable/periods","/api/timetable/setup","/api/timetable/entries","/api/timetable/auto/config"].includes(pathname))return null;
  const user=await getCurrentUser(request,env);
  if(!user||!user.role)return reply({error:"กรุณาเข้าสู่ระบบ"},401);
  if(!["teacher","staff","executive","superadmin"].includes(user.role))return reply({error:"ไม่มีสิทธิ์เข้าถึง"},403);
  const required=pathname==="/api/timetable/periods"?["academic_years","academic_terms"]:["academic_years","academic_terms","student_enrollments","personnel_records","personnel_accounts","timetable_plans","timetable_entries",...(pathname.endsWith('/config')?["timetable_auto_config"]:[])];
  const {results}=await env.DB.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name IN (${required.map(()=>'?').join(',')})`).bind(...required).all();
  if(results.length!==required.length)return null; // First installation uses the normal migration path.
  if(pathname==="/api/timetable/periods")return timetablePeriods(env);
  const term=await termById(env,validId(new URL(request.url).searchParams.get('term_id')));
  if(!term)return reply({error:"เลือกภาคเรียนจากระบบก่อน"},400);
  if(pathname==="/api/timetable/entries")return guardedEntries(env,user,term,new URL(request.url).searchParams.get('view')==='draft'?'draft':'published');
  const canManage=await canManageTimetable(env,user);
  if(pathname==="/api/timetable/setup")return setup(env,term,canManage);
  if(!canManage)return reply({error:"เฉพาะฝ่ายวิชาการ ผู้บริหาร หรือผู้ดูแลระบบ"},403);
  const row=await env.DB.prepare('SELECT config_json FROM timetable_auto_config WHERE academic_term_id=?').bind(term.id).first();
  return reply({config:row?JSON.parse(row.config_json):null,structure:(await loadStructure(env,term.id)).structure});
}
export async function timetablePeriods(env){
  const [years,terms]=await Promise.all([
    env.DB.prepare('SELECT id,year_be,label,status FROM academic_years ORDER BY year_be DESC').all(),
    env.DB.prepare('SELECT id,academic_year_id,name,term_number,status FROM academic_terms ORDER BY academic_year_id,term_number').all()
  ]);
  return reply({years:years.results.map(y=>({...y,terms:terms.results.filter(t=>t.academic_year_id===y.id)}))});
}

export async function handleTimetableRoute(request,env,pathname,method){
  if(!pathname.startsWith("/api/timetable/")&&!pathname.startsWith("/api/substitutes/"))return null;
  const user=await getCurrentUser(request,env);if(!user||!user.role)return reply({error:"กรุณาเข้าสู่ระบบ"},401);
  if(!["teacher","staff","executive","superadmin"].includes(user.role))return reply({error:"ไม่มีสิทธิ์เข้าถึง"},403);
  const isSubstitute=pathname.startsWith('/api/substitutes/');
  if(isSubstitute){
    const allowed=await canManageSubstitutes(env,user);
    if(pathname==='/api/substitutes/permissions'&&method==='GET')return reply({can_manage:allowed,can_view_stats:await canViewPersonnelStats(env,user)});
    if(pathname==='/api/substitutes/mine'&&method==='GET'){await ensurePersonnelData(env);await ensureSchema(env);return mine(env,user);}
    if(!allowed)return reply({error:'เฉพาะเจ้าหน้าที่ฝ่ายบุคลากรหรือผู้ดูแลระบบเท่านั้น'},403);
  }
  if(pathname==="/api/timetable/periods"&&method==="GET"){await ensureAcademicData(env);return timetablePeriods(env);}
  await ensurePersonnelData(env);await ensureSchema(env);if(isSubstitute)await ensureLeaveData(env);
  const url=new URL(request.url),isTimetable=pathname.startsWith("/api/timetable/");
  if(pathname==="/api/timetable/permissions"&&method==="GET")return timetablePermissions(env,user);
  if(pathname==="/api/timetable/my-schedule"&&method==="GET")return mySchedule(env,user,validId(url.searchParams.get("term_id")));
  if(isTimetable){
    const term=await termById(env,validId(method==="GET"||method==="DELETE"?url.searchParams.get("term_id"):(await request.clone().json().catch(()=>null))?.term_id));
    if(!term)return reply({error:"เลือกภาคเรียนจากระบบก่อน"},400);
    const canManage=await canManageTimetable(env,user);
    if(pathname==="/api/timetable/setup"&&method==="GET")return setup(env,term,canManage);
    if(pathname==="/api/timetable/auto/config"&&method==="GET"){if(!canManage)return reply({error:"เฉพาะฝ่ายวิชาการ ผู้บริหาร หรือผู้ดูแลระบบ"},403);return handleAuto(request,env,term,user,pathname,method,{setup,plan,draft});}
    if(pathname==="/api/timetable/entries"&&method==="GET")return guardedEntries(env,user,term,url.searchParams.get("view")==="draft"?"draft":"published");
    // โครงเวลาเรียน (แม่แบบ ป.ต้น / ป.ปลาย): ดูได้ทุกคน แก้ได้เฉพาะฝ่ายวัดผล ผู้จัดตาราง และผู้ดูแลระบบ
    if(pathname==="/api/timetable/structure"){
      const canEdit=await canEditStructure(env,user);
      if(method==="GET")return reply({...(await loadStructure(env,term.id)),bands:BANDS,can_edit:canEdit,term});
      if(method==="PUT"){
        if(!canEdit)return reply({error:"เฉพาะฝ่ายวัดผล ฝ่ายวิชาการ หรือผู้ดูแลระบบที่แก้โครงเวลาเรียนได้"},403);
        const body=await request.json().catch(()=>null),checked=validateStructure(body?.structure);
        if(checked.error)return reply({error:checked.error},400);
        await ensureStructureSchema(env);
        await env.DB.prepare(`INSERT INTO timetable_structure(academic_term_id,config_json,updated_by) VALUES(?,?,?)
          ON CONFLICT(academic_term_id) DO UPDATE SET config_json=excluded.config_json,updated_by=excluded.updated_by,updated_at=datetime('now')`).bind(term.id,JSON.stringify(checked.structure),user.id).run();
        await env.DB.prepare("INSERT INTO audit_logs(user_id,action,resource,resource_id,details) VALUES(?,?,?,?,?)").bind(user.id,"update","timetable_structure",term.id,JSON.stringify(checked.structure)).run().catch(()=>{});
        return reply({ok:true,structure:checked.structure});
      }
    }
    if(!canManage)return reply({error:"เฉพาะฝ่ายวิชาการ ผู้บริหาร หรือผู้ดูแลระบบที่แก้ตารางสอนได้"},403);
    const autoResponse=await handleAuto(request,env,term,user,pathname,method,{setup,plan,draft});if(autoResponse)return autoResponse;
    if(pathname==="/api/timetable/slot"&&method==="PUT")return saveSlot(request,env,term,user);
    const removed=pathname.match(/^\/api\/timetable\/slot\/(\d+)$/);
    if(removed&&method==="DELETE")return deleteSlot(env,term,Number(removed[1]));
    if(removed&&method==="PATCH")return moveSlot(request,env,term,Number(removed[1]));
    if(pathname==="/api/timetable/publish"&&method==="POST")return publish(env,term,user);
  }else{
    if(pathname==="/api/substitutes/leaves"&&method==="GET")return leaveAbsences(env,url.searchParams.get("date"));
    if(pathname==="/api/substitutes/coverage"&&method==="GET")return coverage(env,url.searchParams.get("date"),validId(url.searchParams.get("teacher_id")));
    if(pathname==="/api/substitutes/assignments"&&method==="GET")return assignments(env,url.searchParams.get("date"));

    if(pathname==="/api/substitutes/assignments"&&method==="POST")return assign(request,env,user);
    if(pathname==="/api/substitutes/teachers"&&method==="GET")return teachersForDay(env,url.searchParams.get("date"));
    const one=pathname.match(/^\/api\/substitutes\/assignments\/(\d+)$/);
    if(one&&method==="DELETE")return cancelAssignment(env,Number(one[1]),user);
    if(one&&method==="PATCH")return changeAssignment(request,env,Number(one[1]),user);
  }
  return reply({error:"ไม่พบ endpoint"},404);
}
