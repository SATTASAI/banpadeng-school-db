// ระบบลงทะเบียนนิเทศ (นิเทศการสอนและห้องเรียนพร้อมกัน)
// ครูลงทะเบียนคาบของตนเอง → ผู้มีสิทธิ์ประเมิน (ผอ. รอง ผอ. และผู้ที่ฝ่ายวิชาการแต่งตั้ง) รับนิเทศ → ผู้รับนิเทศบันทึกคะแนน
// ผลประเมิน: ครูเห็นเฉพาะของตนเอง ฝ่ายบริหารและฝ่ายวิชาการเห็นทั้งหมด
import {getCurrentUser,jsonResponse} from '../lib/auth.js';
import {ensurePersonnelData} from '../lib/personnel-data.js';
import {ensureDepartmentStaff,belongsToDepartment} from './department-staff.js';
import {loadStructure,DEFAULT_STRUCTURE} from '../lib/timetable-structure.js';

// ผู้ประเมินนิเทศการสอนและห้องเรียนพร้อมกันในคาบเดียว ใช้แบบประเมินเดียว 10 ข้อ (การสอน 5 + ห้องเรียน 5)
export const FORM_SECTIONS=[{label:'ด้านการสอน',items:['การออกแบบแผนการจัดการเรียนรู้','การจัดกิจกรรมที่เน้นผู้เรียนเป็นสำคัญ','การใช้สื่อและแหล่งเรียนรู้','การวัดและประเมินผลการเรียนรู้','การบริหารชั้นเรียนและการมีส่วนร่วม']},{label:'ด้านห้องเรียน',items:['ความสะอาดและความเป็นระเบียบ','ความปลอดภัยในห้องเรียน','การจัดมุมเรียนรู้และสื่อการสอน','บรรยากาศที่ส่งเสริมการเรียนรู้','การแสดงผลงานและข้อมูลผู้เรียน']}];
export const FORM_ITEMS=FORM_SECTIONS.flatMap(s=>s.items);
export const COMBINED_LABEL='นิเทศการสอนและห้องเรียน';
// ค่า supervision_type ในฐานข้อมูล: คำขอใหม่ทั้งหมดเก็บเป็น teaching (= นิเทศการสอนและห้องเรียน); classroom คงไว้สำหรับข้อมูลเดิม
export const SUPERVISION_TYPES={teaching:{label:COMBINED_LABEL},classroom:{label:'นิเทศห้องเรียน'}};
const LEGACY_LABELS={teaching:'นิเทศการสอน',classroom:'นิเทศห้องเรียน'};
export const MAX_SCORE=FORM_ITEMS.length*5;
export const QUALITY_LEVELS=[[90,'ดีเยี่ยม'],[80,'ดีมาก'],[70,'ดี'],[60,'พอใช้'],[0,'ควรพัฒนา']];
export function qualityLevel(percent){return QUALITY_LEVELS.find(([min])=>percent>=min)[1];}
export function summarizeScores(scores){
 if(!Array.isArray(scores)||scores.length!==FORM_ITEMS.length||!scores.every(s=>Number.isInteger(s)&&s>=1&&s<=5))return null;
 const total=scores.reduce((a,b)=>a+b,0),percent=Math.round(total/MAX_SCORE*10000)/100;
 return {total,percent,level:qualityLevel(percent)};
}

const headers={'Cache-Control':'private, no-store'};
const reply=(data,status=200)=>jsonResponse(data,status,headers);
const fail=(error,status=400)=>reply({error},status);
const text=(v,max)=>typeof v==='string'?v.normalize('NFC').replace(/\s+/g,' ').trim().slice(0,max):'';
const longText=(v,max)=>typeof v==='string'?v.normalize('NFC').replace(/\r\n?/g,'\n').trim().slice(0,max):'';
const validDate=s=>typeof s==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(s)&&new Date(s+'T00:00:00Z').toISOString().slice(0,10)===s;
const weekdayOf=s=>{const d=new Date(s+'T00:00:00Z').getUTCDay();return d>=1&&d<=5?d:0;};
const addDays=(s,n)=>{const d=new Date(s+'T00:00:00Z');d.setUTCDate(d.getUTCDate()+n);return d.toISOString().slice(0,10);};
// เวลาปัจจุบันตามเวลาประเทศไทย
export function bangkokNow(now=new Date()){const t=new Date(now.getTime()+7*3600000);return {date:t.toISOString().slice(0,10),minutes:t.getUTCHours()*60+t.getUTCMinutes()};}
const minutesOf=hhmm=>{const [h,m]=String(hhmm).split(':').map(Number);return h*60+m;};
export function slotStarted(date,startTime,now=bangkokNow()){return date<now.date||(date===now.date&&now.minutes>=minutesOf(startTime));}

const ready=new WeakMap();
export function ensureSupervisionSchema(env){
 if(ready.has(env.DB))return ready.get(env.DB);
 const p=env.DB.batch([
  env.DB.prepare(`CREATE TABLE IF NOT EXISTS supervision_requests (
   id INTEGER PRIMARY KEY AUTOINCREMENT,
   teacher_user_id INTEGER NOT NULL REFERENCES users(id),teacher_personnel_id INTEGER,academic_term_id INTEGER,
   visit_date TEXT NOT NULL,weekday INTEGER NOT NULL CHECK(weekday BETWEEN 1 AND 5),period INTEGER NOT NULL CHECK(period BETWEEN 1 AND 6),
   source TEXT NOT NULL CHECK(source IN ('timetable','manual')),timetable_entry_id INTEGER,
   subject TEXT NOT NULL,grade_level TEXT,classroom TEXT,room_name TEXT,
   supervision_type TEXT NOT NULL CHECK(supervision_type IN ('teaching','classroom')),topic TEXT,
   status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','confirmed','evaluated','cancelled')),
   supervisor_user_id INTEGER REFERENCES users(id),accepted_at TEXT,cancelled_at TEXT,cancelled_by INTEGER REFERENCES users(id),
   created_at TEXT NOT NULL DEFAULT(datetime('now')),updated_at TEXT NOT NULL DEFAULT(datetime('now')))`),
  // ครูจองคาบเดียวกันซ้ำไม่ได้ และผู้นิเทศรับนิเทศวันและคาบเดียวกันได้รายการเดียว (กันที่ระดับฐานข้อมูล)
  env.DB.prepare("CREATE UNIQUE INDEX IF NOT EXISTS uq_supervision_teacher_slot ON supervision_requests(teacher_user_id,visit_date,period) WHERE status<>'cancelled'"),
  env.DB.prepare("CREATE UNIQUE INDEX IF NOT EXISTS uq_supervision_supervisor_slot ON supervision_requests(supervisor_user_id,visit_date,period) WHERE supervisor_user_id IS NOT NULL AND status IN ('confirmed','evaluated')"),
  env.DB.prepare('CREATE INDEX IF NOT EXISTS idx_supervision_date ON supervision_requests(visit_date,period)'),
  env.DB.prepare(`CREATE TABLE IF NOT EXISTS supervision_evaluations (
   request_id INTEGER PRIMARY KEY REFERENCES supervision_requests(id) ON DELETE CASCADE,
   evaluator_user_id INTEGER NOT NULL REFERENCES users(id),items_json TEXT NOT NULL,
   total INTEGER NOT NULL,percent REAL NOT NULL,quality_level TEXT NOT NULL,suggestion TEXT,
   evaluated_at TEXT NOT NULL DEFAULT(datetime('now')))`),
  env.DB.prepare(`CREATE TABLE IF NOT EXISTS supervision_evaluators (
   user_id INTEGER PRIMARY KEY REFERENCES users(id),granted_by INTEGER REFERENCES users(id),granted_at TEXT NOT NULL DEFAULT(datetime('now')))`),
  env.DB.prepare(`CREATE TABLE IF NOT EXISTS supervision_notifications (
   id INTEGER PRIMARY KEY AUTOINCREMENT,user_id INTEGER NOT NULL REFERENCES users(id),
   request_id INTEGER NOT NULL REFERENCES supervision_requests(id) ON DELETE CASCADE,
   message TEXT NOT NULL,actor_id INTEGER,created_at TEXT NOT NULL DEFAULT(datetime('now')),read_at TEXT)`),
  env.DB.prepare('CREATE INDEX IF NOT EXISTS idx_supervision_notifications_user ON supervision_notifications(user_id,read_at)'),
  // วัน/คาบที่ผู้ประเมินไม่ว่าง (ผู้ประเมินตั้งเอง) period ว่าง = ไม่ว่างทั้งวัน — ลดจำนวนที่รับลงทะเบียนของคาบนั้น
  env.DB.prepare(`CREATE TABLE IF NOT EXISTS supervision_unavailability (
   id INTEGER PRIMARY KEY AUTOINCREMENT,user_id INTEGER NOT NULL REFERENCES users(id),unavailable_date TEXT NOT NULL,
   period INTEGER CHECK(period IS NULL OR period BETWEEN 1 AND 6),note TEXT,created_at TEXT NOT NULL DEFAULT(datetime('now')))`),
  env.DB.prepare('CREATE UNIQUE INDEX IF NOT EXISTS uq_supervision_unavailability ON supervision_unavailability(user_id,unavailable_date,COALESCE(period,0))'),
  env.DB.prepare('CREATE INDEX IF NOT EXISTS idx_supervision_unavailability_date ON supervision_unavailability(unavailable_date)'),
  // ผู้ประเมินที่ถอนการรับนิเทศ — รายการนั้นไม่ค้างในแท็บคำขอของผู้ที่ถอนแล้ว (ผู้ประเมินคนอื่นยังเห็นและรับได้)
  env.DB.prepare(`CREATE TABLE IF NOT EXISTS supervision_releases (
   request_id INTEGER NOT NULL REFERENCES supervision_requests(id) ON DELETE CASCADE,user_id INTEGER NOT NULL REFERENCES users(id),
   released_at TEXT NOT NULL DEFAULT(datetime('now')),PRIMARY KEY(request_id,user_id))`),
  // ภาพการสอน/สื่อการสอนที่ครูส่งแทนการนิเทศในห้องเรียน (ไฟล์อยู่ใน Google Drive โฟลเดอร์ "ภาพการนิเทศ")
  env.DB.prepare(`CREATE TABLE IF NOT EXISTS supervision_evidence_files (
   id INTEGER PRIMARY KEY AUTOINCREMENT,request_id INTEGER NOT NULL REFERENCES supervision_requests(id) ON DELETE CASCADE,
   drive_file_id TEXT NOT NULL,file_name TEXT NOT NULL,mime_type TEXT NOT NULL,file_size INTEGER NOT NULL,
   uploaded_by INTEGER NOT NULL REFERENCES users(id),created_at TEXT NOT NULL DEFAULT(datetime('now')))`),
  env.DB.prepare('CREATE INDEX IF NOT EXISTS idx_supervision_evidence_request ON supervision_evidence_files(request_id)'),
  // ไฟล์ Drive ที่ลบไม่สำเร็จ — Cron ลองลบซ้ำ ไม่ให้ภาพค้างใน Drive
  env.DB.prepare(`CREATE TABLE IF NOT EXISTS supervision_drive_trash (
   drive_file_id TEXT PRIMARY KEY,attempts INTEGER NOT NULL DEFAULT 0,last_error TEXT,created_at TEXT NOT NULL DEFAULT(datetime('now')))`)
 ]).then(async()=>{
  // คอลัมน์หลักฐานแทนการนิเทศ (ผู้ประเมินรับนิเทศแล้วแจ้งไม่ว่างไปนิเทศ → ครูส่งลิงก์คลิปและภาพ)
  const cols=new Set((await env.DB.prepare('PRAGMA table_info(supervision_requests)').all()).results.map(c=>c.name));
  const add=[['evidence_requested_at','TEXT'],['evidence_requested_by','INTEGER'],['evidence_note','TEXT'],['evidence_video_url','TEXT'],['evidence_submitted_at','TEXT'],['evidence_due_date','TEXT'],['evidence_reminded_on','TEXT'],['evidence_overdue_notified','INTEGER']].filter(([c])=>!cols.has(c));
  for(const [c,t] of add)await env.DB.prepare(`ALTER TABLE supervision_requests ADD COLUMN ${c} ${t}`).run().catch(e=>{if(!/duplicate column/i.test(String(e.message)))throw e;});
 }).catch(e=>{ready.delete(env.DB);throw e;});
 ready.set(env.DB,p);return p;
}

// ใช้ instr() แทน LIKE: รูปแบบ LIKE ภาษาไทยยาวเกินขีดจำกัดของ D1 (LIKE or GLOB pattern too complex)
const EXEC_POSITION=`instr(REPLACE(COALESCE(p.position,''),' ',''),'ผู้อำนวยการ')>0 AND instr(REPLACE(COALESCE(p.position,''),' ',''),'ผู้ช่วยผู้อำนวยการ')=0`;
const NONE={register:false,evaluate:false,view_all:false,manage_evaluators:false,staff:false,executive:false};
export async function supervisionPermissions(env,user){
 if(!user?.role||user.role==='viewer')return {...NONE};
 await ensureSupervisionSchema(env);await ensurePersonnelData(env);await ensureDepartmentStaff(env);
 const {results:people}=await env.DB.prepare(`SELECT p.id,p.position,p.departments,
  EXISTS(SELECT 1 FROM department_staff d WHERE d.personnel_id=p.id AND d.department='academic') in_academic,
  EXISTS(SELECT 1 FROM department_staff d WHERE d.personnel_id=p.id AND d.department='academic' AND d.is_head=1) academic_head,
  CASE WHEN ${EXEC_POSITION} THEN 1 ELSE 0 END exec_position
  FROM personnel_records p JOIN personnel_accounts a ON a.personnel_id=p.id WHERE a.user_id=? AND p.status='active'`).bind(user.id).all();
 const assigned=!!await env.DB.prepare('SELECT 1 FROM supervision_evaluators WHERE user_id=?').bind(user.id).first();
 const executive=user.role==='executive'||people.some(p=>Number(p.exec_position)===1);
 // งานนิเทศการศึกษาอยู่ในฝ่ายวิชาการ
 const academicHead=people.some(p=>Number(p.academic_head)===1);
 const academicStaff=academicHead||people.some(p=>Number(p.in_academic)===1||belongsToDepartment(p.departments,'academic'));
 const evaluate=executive||assigned;
 const viewAll=executive||academicStaff||user.role==='superadmin';
 const manage=user.role==='superadmin'||academicHead;
 return {register:true,evaluate,view_all:viewAll,manage_evaluators:manage,staff:evaluate||viewAll||manage,executive,assigned_evaluator:assigned};
}

// ผู้มีสิทธิ์ประเมินทั้งหมด (ใช้ส่งแจ้งเตือนคำขอใหม่)
async function evaluatorIds(env){
 const {results}=await env.DB.prepare(`SELECT u.id FROM users u WHERE u.status='active' AND u.deleted_at IS NULL AND (u.role='executive'
  OR EXISTS(SELECT 1 FROM supervision_evaluators s WHERE s.user_id=u.id)
  OR EXISTS(SELECT 1 FROM personnel_accounts a JOIN personnel_records p ON p.id=a.personnel_id AND p.status='active' WHERE a.user_id=u.id AND ${EXEC_POSITION}))`).all().catch(async e=>{
  if(!/deleted_at/.test(String(e.message)))throw e;
  return env.DB.prepare(`SELECT u.id FROM users u WHERE u.status='active' AND (u.role='executive'
   OR EXISTS(SELECT 1 FROM supervision_evaluators s WHERE s.user_id=u.id)
   OR EXISTS(SELECT 1 FROM personnel_accounts a JOIN personnel_records p ON p.id=a.personnel_id AND p.status='active' WHERE a.user_id=u.id AND ${EXEC_POSITION}))`).all();
 });
 return results.map(r=>Number(r.id));
}
function notifyStatements(env,userIds,requestId,message,actorId){
 return [...new Set(userIds)].filter(id=>id&&id!==actorId).map(id=>env.DB.prepare('INSERT INTO supervision_notifications(user_id,request_id,message,actor_id) VALUES(?,?,?,?)').bind(id,requestId,message.slice(0,400),actorId));
}

async function tableExists(env,name){return !!await env.DB.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").bind(name).first();}
async function termFor(env,date){
 return env.DB.prepare(`SELECT t.id,t.name,t.term_number,y.year_be,t.start_date,t.end_date FROM academic_terms t JOIN academic_years y ON y.id=t.academic_year_id
  WHERE ? BETWEEN t.start_date AND t.end_date ORDER BY t.id DESC LIMIT 1`).bind(date).first();
}
async function publishedPlan(env,termId){
 if(!await tableExists(env,'timetable_plans')||!await tableExists(env,'timetable_entries'))return null;
 return env.DB.prepare("SELECT id FROM timetable_plans WHERE academic_term_id=? AND status='published'").bind(termId).first();
}
async function personnelIdsOf(env,userId){
 const {results}=await env.DB.prepare("SELECT a.personnel_id id FROM personnel_accounts a JOIN personnel_records p ON p.id=a.personnel_id AND p.status='active' WHERE a.user_id=?").bind(userId).all();
 return results.map(r=>Number(r.id));
}
async function lessonsFor(env,planId,personnelIds,weekday=null){
 if(!personnelIds.length)return [];
 const marks=personnelIds.map(()=>'?').join(',');
 const {results}=await env.DB.prepare(`SELECT id,teacher_id,weekday,period,subject,grade_level,classroom,room_name FROM timetable_entries
  WHERE plan_id=? AND teacher_id IN (${marks})${weekday?' AND weekday=?':''} ORDER BY weekday,period`).bind(planId,...personnelIds,...(weekday?[weekday]:[])).all();
 return results;
}
async function periodTimes(env,termId){
 try{return (await loadStructure(env,termId)).structure;}catch{return DEFAULT_STRUCTURE;}
}

// วันหยุด/วันกิจกรรมจากปฏิทินระบบผลการเรียน (gr_holidays ใน D1 เดียวกัน) — วันหยุดจองไม่ได้ วันกิจกรรมจองได้เมื่อครูยืนยัน (confirm_activity)
async function holidaysOn(env,dates){
 const out=new Map();
 if(!dates.length||!await tableExists(env,'gr_holidays'))return out;
 const marks=dates.map(()=>'?').join(',');
 const sql=k=>`SELECT substr(holiday_date,1,10) d,name,${k?"COALESCE(kind,'holiday')":"'holiday'"} kind FROM gr_holidays WHERE substr(holiday_date,1,10) IN (${marks})`;
 const {results}=await env.DB.prepare(sql(true)).bind(...dates).all().catch(()=>env.DB.prepare(sql(false)).bind(...dates).all());
 for(const r of results)if(!out.has(r.d)||r.kind==='holiday')out.set(r.d,{name:r.name||'',kind:r.kind==='activity'?'activity':'holiday'});
 return out;
}
const holidayMsg=h=>`วันที่เลือกเป็นวันหยุด${h.name?' ('+h.name+')':''} กรุณาเลือกวันอื่น`;
const activityMsg=h=>`วันนี้ตรงกับวันกิจกรรม${h.name?' ('+h.name+')':''} ยืนยันจะจองคาบนี้วันนี้ใช่ไหม`;
// จำนวนที่รับลงทะเบียนได้ของวันที่+คาบ = 3 − ผู้ประเมินที่แจ้งไม่ว่าง (ไม่ติดลบ)
const CAPACITY_SQL=`MAX(0,?-(SELECT COUNT(DISTINCT user_id) FROM supervision_unavailability WHERE unavailable_date=? AND (period IS NULL OR period=?)))`;
async function termRequestOf(env,userId,termId){
 return env.DB.prepare("SELECT id,visit_date,period FROM supervision_requests WHERE teacher_user_id=? AND academic_term_id=? AND status<>'cancelled' LIMIT 1").bind(userId,termId).first();
}
const TERM_LIMIT_MSG='ลงทะเบียนได้ภาคเรียนละ 1 ครั้ง คุณลงทะเบียนในภาคเรียนนี้แล้ว หากต้องการเปลี่ยนวันหรือคาบ ให้ยกเลิกนัดเดิมก่อน (ก่อนวันนิเทศอย่างน้อย 1 วัน)';

const SELECT=`SELECT r.*,tu.full_name teacher_name,su.full_name supervisor_name,
 e.items_json,e.total,e.percent,e.quality_level,e.suggestion,e.evaluated_at,e.evaluator_user_id,eu.full_name evaluator_name,
 (SELECT p.position FROM personnel_accounts a JOIN personnel_records p ON p.id=a.personnel_id WHERE a.user_id=r.teacher_user_id LIMIT 1) teacher_position,
 (SELECT p.position FROM personnel_accounts a JOIN personnel_records p ON p.id=a.personnel_id WHERE a.user_id=r.supervisor_user_id LIMIT 1) supervisor_position,
 (SELECT p.position FROM personnel_accounts a JOIN personnel_records p ON p.id=a.personnel_id WHERE a.user_id=e.evaluator_user_id LIMIT 1) evaluator_position
 FROM supervision_requests r JOIN users tu ON tu.id=r.teacher_user_id LEFT JOIN users su ON su.id=r.supervisor_user_id
 LEFT JOIN supervision_evaluations e ON e.request_id=r.id LEFT JOIN users eu ON eu.id=e.evaluator_user_id`;
// ผลเดิมที่ประเมินแบบแยก (5 ข้อ) แสดงชื่อประเภทเดิม
function typeLabel(row){
 if(row.status==='evaluated'&&row.items_json){try{if(JSON.parse(row.items_json).length<FORM_ITEMS.length)return LEGACY_LABELS[row.supervision_type]||COMBINED_LABEL;}catch{}}
 return COMBINED_LABEL;
}
function shape(row,{withResult}){
 const out={id:row.id,teacher_user_id:row.teacher_user_id,teacher_name:row.teacher_name,teacher_position:row.teacher_position||null,
  academic_term_id:row.academic_term_id,visit_date:row.visit_date,weekday:row.weekday,period:row.period,source:row.source,subject:row.subject,grade_level:row.grade_level,classroom:row.classroom,room_name:row.room_name,
  supervision_type:row.supervision_type,type_label:typeLabel(row),topic:row.topic,status:row.status,
  supervisor_user_id:row.supervisor_user_id,supervisor_name:row.supervisor_name,supervisor_position:row.supervisor_position||null,
  accepted_at:row.accepted_at,created_at:row.created_at,cancelled_at:row.cancelled_at,
  // เลยวันนิเทศแล้วแต่ยังไม่มีผล: pending = ไม่มีผู้รับนิเทศ, confirmed = ค้างบันทึกคะแนน
  overdue:(row.status==='pending'||row.status==='confirmed')&&row.visit_date<bangkokNow().date,
  can_cancel:row.status!=='evaluated'&&bangkokNow().date<row.visit_date};
 if(row.evidence_requested_at)out.evidence={requested_at:row.evidence_requested_at,note:row.evidence_note||null,video_url:row.evidence_video_url||null,submitted_at:row.evidence_submitted_at||null,due_date:row.evidence_due_date||null,
  late:!row.evidence_submitted_at&&!!row.evidence_due_date&&row.evidence_due_date<bangkokNow().date,files:[]};
 if(row.status==='evaluated'&&withResult){
  let items=[];try{items=JSON.parse(row.items_json);}catch{}
  out.evaluation={items,total:row.total,percent:row.percent,level:row.quality_level,suggestion:row.suggestion,evaluated_at:row.evaluated_at,
   evaluator_user_id:row.evaluator_user_id,evaluator_name:row.evaluator_name,evaluator_position:row.evaluator_position||null};
 }
 return out;
}
async function loadRequest(env,id){return env.DB.prepare(`${SELECT} WHERE r.id=?`).bind(id).first();}
// แนบรายการภาพหลักฐานให้คำขอที่ผู้ประเมินแจ้งไม่ว่างไปนิเทศ
export const EVIDENCE_MAX_IMAGES=10,EVIDENCE_DAYS=3;
async function withEvidence(env,list){
 const ids=list.filter(r=>r.evidence).map(r=>r.id);
 if(!ids.length)return list;
 const {results}=await env.DB.prepare(`SELECT id,request_id,file_name,created_at FROM supervision_evidence_files WHERE request_id IN (${ids.map(()=>'?').join(',')}) ORDER BY id`).bind(...ids).all();
 const by=new Map(list.map(r=>[r.id,r]));
 for(const f of results)by.get(Number(f.request_id))?.evidence.files.push({id:f.id,file_name:f.file_name,url:`/api/supervision/evidence/files/${f.id}`,created_at:f.created_at});
 return list;
}
const TH_DAYS=['อา.','จ.','อ.','พ.','พฤ.','ศ.','ส.'],TH_MONTHS=['ม.ค.','ก.พ.','มี.ค.','เม.ย.','พ.ค.','มิ.ย.','ก.ค.','ส.ค.','ก.ย.','ต.ค.','พ.ย.','ธ.ค.'];
export function thaiDate(iso){const d=new Date(iso+'T00:00:00Z');return `${TH_DAYS[d.getUTCDay()]} ${d.getUTCDate()} ${TH_MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()+543}`;}
// ผู้ประเมินมี 3 คน: วันที่+คาบเดียวกันรับลงทะเบียนนิเทศได้สูงสุด 3 คำขอ (ไม่นับที่ยกเลิก)
export const SLOT_CAPACITY=3;
const FULL_MSG='ลงทะเบียนไม่ได้เนื่องจากคาบเต็ม กรุณาเลือกคาบอื่น';
const slotLabel=r=>`${thaiDate(r.visit_date)} คาบ ${r.period}`;

async function week(env,user,url){
 const now=bangkokNow();
 let start=url.searchParams.get('start');
 if(!validDate(start))start=now.date;
 const wd=new Date(start+'T00:00:00Z').getUTCDay();start=addDays(start,wd===0?-6:1-wd);
 const dates=[0,1,2,3,4].map(i=>addDays(start,i));
 const personnelIds=await personnelIdsOf(env,user.id);
 const terms=new Map(),days=[];
 for(const date of dates){
  const term=await termFor(env,date);
  if(term&&!terms.has(term.id)){
   const plan=await publishedPlan(env,term.id),structure=await periodTimes(env,term.id);
   terms.set(term.id,{term,plan,structure,lessons:plan?await lessonsFor(env,plan.id,personnelIds):[]});
  }
  days.push({date,weekday:weekdayOf(date),term_id:term?.id||null});
 }
 const marks=dates.map(()=>'?').join(',');
 const {results:mine}=await env.DB.prepare(`${SELECT} WHERE r.teacher_user_id=? AND r.status<>'cancelled' AND r.visit_date IN (${marks})`).bind(user.id,...dates).all();
 const {results:counts}=await env.DB.prepare(`SELECT visit_date,period,COUNT(*) n FROM supervision_requests WHERE status<>'cancelled' AND visit_date IN (${marks}) GROUP BY visit_date,period`).bind(...dates).all();
 const {results:away}=await env.DB.prepare(`SELECT user_id,unavailable_date d,period FROM supervision_unavailability WHERE unavailable_date IN (${marks})`).bind(...dates).all();
 const capacityOf=(d,p)=>Math.max(0,SLOT_CAPACITY-new Set(away.filter(a=>a.d===d&&(a.period==null||Number(a.period)===p)).map(a=>a.user_id)).size);
 const used=new Map(counts.map(r=>[`${r.visit_date}|${r.period}`,Number(r.n)]));
 const full=[];for(const d of dates)for(let p=1;p<=6;p++)if((used.get(`${d}|${p}`)||0)>=capacityOf(d,p))full.push(`${d}|${p}`);
 const holidays=await holidaysOn(env,dates);
 days.forEach(d=>{d.holiday=holidays.get(d.date)||null;});
 const registered=new Map();
 for(const id of terms.keys()){const r=await termRequestOf(env,user.id,id);registered.set(id,r?{id:r.id,visit_date:r.visit_date,period:r.period}:null);}
 return reply({start,end:dates[4],now,linked:personnelIds.length>0,capacity:SLOT_CAPACITY,full,
  terms:[...terms.values()].map(t=>({id:t.term.id,name:t.term.name,year_be:t.term.year_be,start_date:t.term.start_date,end_date:t.term.end_date,registered:registered.get(t.term.id),
   mode:t.plan?'timetable':'manual',times:t.structure.times,lunch:t.structure.lunch,
   lessons:t.lessons.map(l=>({entry_id:l.id,weekday:l.weekday,period:l.period,subject:l.subject,grade_level:l.grade_level,classroom:l.classroom,room_name:l.room_name}))})),
  days,requests:await withEvidence(env,mine.map(r=>shape(r,{withResult:true}))),default_times:DEFAULT_STRUCTURE.times});
}

async function createRequest(request,env,user){
 const body=await request.json().catch(()=>null);
 const date=body?.visit_date,period=Number(body?.period),type='teaching';
 if(!validDate(date)||!weekdayOf(date))return fail('เลือกวันจันทร์ถึงศุกร์ให้ถูกต้อง');
 if(!Number.isInteger(period)||period<1||period>6)return fail('เลือกคาบเรียนให้ถูกต้อง');
 const topic=longText(body.topic,500);
 const term=await termFor(env,date);if(!term)return fail('วันที่เลือกไม่อยู่ในภาคเรียน');
 const structure=await periodTimes(env,term.id);
 if(slotStarted(date,structure.times[period-1].start))return fail('ไม่สามารถเลือกวันหรือคาบที่ผ่านมาแล้ว');
 const holiday=(await holidaysOn(env,[date])).get(date);
 if(holiday?.kind==='holiday')return fail(holidayMsg(holiday));
 if(holiday?.kind==='activity'&&body.confirm_activity!==true)return reply({error:activityMsg(holiday),code:'activity_day',activity:holiday.name||''},409);
 if(await termRequestOf(env,user.id,term.id))return fail(TERM_LIMIT_MSG,409);
 const plan=await publishedPlan(env,term.id),personnelIds=await personnelIdsOf(env,user.id);
 let lesson;
 if(plan){
  if(!personnelIds.length)return fail('บัญชียังไม่ผูกกับทะเบียนบุคลากร จึงหาคาบสอนไม่ได้ กรุณาติดต่อผู้ดูแลระบบ',409);
  const lessons=await lessonsFor(env,plan.id,personnelIds,weekdayOf(date));
  lesson=lessons.find(l=>l.period===period);
  if(!lesson)return fail('คุณไม่มีคาบสอนในวันและคาบนี้ตามตารางสอนที่เผยแพร่',409);
 }else{
  const subject=text(body.subject,120),grade=text(body.grade_level,30),classroom=text(body.classroom,30);
  if(!subject||!grade)return fail('ยังไม่มีตารางสอนที่เผยแพร่ กรุณากรอกวิชาและชั้นเรียนที่สอนในคาบนี้');
  lesson={id:null,teacher_id:personnelIds[0]||null,subject,grade_level:grade,classroom,room_name:text(body.room_name,60)||null};
 }
 let id;
 try{
  // นับและเพิ่มในคำสั่งเดียว กันกดพร้อมกันแล้วเกินจำนวนผู้ประเมินที่ว่าง และกันลงทะเบียนเกินภาคละ 1 ครั้ง
  const result=await env.DB.prepare(`INSERT INTO supervision_requests(teacher_user_id,teacher_personnel_id,academic_term_id,visit_date,weekday,period,source,timetable_entry_id,subject,grade_level,classroom,room_name,supervision_type,topic)
   SELECT ?,?,?,?,?,?,?,?,?,?,?,?,?,? WHERE (SELECT COUNT(*) FROM supervision_requests WHERE visit_date=? AND period=? AND status<>'cancelled')<${CAPACITY_SQL}
   AND NOT EXISTS(SELECT 1 FROM supervision_requests WHERE teacher_user_id=? AND academic_term_id=? AND status<>'cancelled')`).bind(user.id,lesson.teacher_id||personnelIds[0]||null,term.id,date,weekdayOf(date),period,plan?'timetable':'manual',lesson.id,
   lesson.subject,lesson.grade_level,lesson.classroom||null,lesson.room_name||null,type,topic||null,date,period,SLOT_CAPACITY,date,period,user.id,term.id).run();
  if(!result.meta.changes)return fail(await termRequestOf(env,user.id,term.id)?TERM_LIMIT_MSG:FULL_MSG,409);
  id=Number(result.meta.last_row_id);
 }catch(e){if(/UNIQUE/i.test(String(e.message)))return fail('คุณลงทะเบียนคาบนี้ไว้แล้ว',409);throw e;}
 const room=[lesson.grade_level,lesson.classroom].filter(Boolean).join('/');
 const notes=notifyStatements(env,await evaluatorIds(env),id,`${user.full_name} ขอรับ${COMBINED_LABEL} ${slotLabel({visit_date:date,period})} · ${lesson.subject}${room?' '+room:''}`,user.id);
 if(notes.length)await env.DB.batch(notes);
 return reply({ok:true,request:(await withEvidence(env,[shape(await loadRequest(env,id),{withResult:true})]))[0]},201);
}

async function listRequests(env,user,url,perms){
 const scope=url.searchParams.get('scope')==='all'?'all':'mine';
 if(scope==='mine'){
  const {results}=await env.DB.prepare(`${SELECT} WHERE r.teacher_user_id=? AND r.status<>'cancelled' ORDER BY r.visit_date DESC,r.period`).bind(user.id).all();
  return reply({scope,requests:await withEvidence(env,results.map(r=>shape(r,{withResult:true})))});
 }
 if(!perms.evaluate&&!perms.view_all)return fail('เฉพาะฝ่ายบริหาร ฝ่ายวิชาการ หรือผู้มีสิทธิ์ประเมิน',403);
 const {results}=await env.DB.prepare(`${SELECT} WHERE r.status<>'cancelled' ORDER BY r.visit_date,r.period,r.id`).all();
 // ผู้ประเมินที่ได้รับแต่งตั้ง (ไม่ใช่ฝ่ายบริหาร/ฝ่ายวิชาการ) เห็นคะแนนเฉพาะรายการที่ตนประเมิน
 const released=new Set((await env.DB.prepare('SELECT request_id FROM supervision_releases WHERE user_id=?').bind(user.id).all()).results.map(r=>Number(r.request_id)));
 // ซ่อนได้เฉพาะเมื่อยังมีผู้ประเมินคนอื่นที่ยังไม่ถอนรายการนั้น และยังไม่เลยวันนิเทศ — ไม่ให้คำขอหายจากทุกคน
 const pool=released.size?await evaluatorIds(env):[];
 const releasers=new Map();
 if(released.size){const {results:rr}=await env.DB.prepare(`SELECT request_id,user_id FROM supervision_releases WHERE request_id IN (${[...released].map(()=>'?').join(',')})`).bind(...released).all();
  for(const x of rr){const k=Number(x.request_id);if(!releasers.has(k))releasers.set(k,new Set());releasers.get(k).add(Number(x.user_id));}}
 const someoneElse=r=>pool.some(id=>id!==r.teacher_user_id&&!releasers.get(r.id)?.has(id));
 // หลักฐาน (คลิป/ภาพ) เห็นได้เฉพาะครูเจ้าของ ผู้รับนิเทศ และฝ่ายบริหาร/ฝ่ายวิชาการ
 const list=results.map(r=>{const out=shape(r,{withResult:perms.view_all||r.evaluator_user_id===user.id||r.teacher_user_id===user.id});
  if(out.evidence&&!(perms.view_all||r.supervisor_user_id===user.id||r.teacher_user_id===user.id))delete out.evidence;
  // รายการที่ตนเองถอนการรับแล้วและยังรอผู้รับใหม่ — ไม่ค้างในแท็บคำขอของผู้ที่ถอน
  out.released_by_me=out.status==='pending'&&released.has(out.id);
  out.hidden_for_me=out.released_by_me&&!out.overdue&&someoneElse(r);return out;});
 return reply({scope,requests:await withEvidence(env,list)});
}

async function act(request,env,user,id,action,perms,services){
 const row=await loadRequest(env,id);
 if(!row||row.status==='cancelled')return fail('ไม่พบรายการนิเทศ',404);
 if(action==='cancel'){
  if(row.teacher_user_id!==user.id)return fail('ยกเลิกได้เฉพาะคำขอของตนเอง',403);
  if(row.status==='evaluated')return fail('รายการที่ประเมินแล้วยกเลิกไม่ได้',409);
  if(!(bangkokNow().date<row.visit_date))return fail('ยกเลิกหรือเลื่อนนัดได้ก่อนวันนิเทศอย่างน้อย 1 วันเท่านั้น',409);
  const r=await env.DB.prepare("UPDATE supervision_requests SET status='cancelled',cancelled_at=datetime('now'),cancelled_by=?,updated_at=datetime('now') WHERE id=? AND status IN ('pending','confirmed')").bind(user.id,id).run();
  if(!r.meta.changes)return fail('สถานะเปลี่ยนแล้ว กรุณาโหลดใหม่',409);
  await purgeEvidence(env,id,services);
  const to=row.supervisor_user_id?[row.supervisor_user_id]:await evaluatorIds(env);
  const notes=notifyStatements(env,to,id,`${row.teacher_name} ยกเลิกคำขอ${COMBINED_LABEL} ${slotLabel(row)}`,user.id);
  if(notes.length)await env.DB.batch(notes);
  return reply({ok:true});
 }
 if(!perms.evaluate)return fail('เฉพาะ ผอ. รอง ผอ. และผู้มีสิทธิ์ประเมินเท่านั้น',403);
 if(action==='accept'){
  if(row.teacher_user_id===user.id)return fail('ไม่สามารถรับนิเทศคำขอของตนเองได้',403);
  if(row.status!=='pending')return fail(row.supervisor_name?`รายการนี้ ${row.supervisor_name} รับนิเทศแล้ว`:'สถานะเปลี่ยนแล้ว กรุณาโหลดใหม่',409);
  const clash=await env.DB.prepare(`SELECT u.full_name FROM supervision_requests r JOIN users u ON u.id=r.teacher_user_id WHERE r.supervisor_user_id=? AND r.visit_date=? AND r.period=? AND r.status IN ('confirmed','evaluated') AND r.id<>?`).bind(user.id,row.visit_date,row.period,id).first();
  if(clash)return fail(`คุณรับนิเทศ ${clash.full_name} ในวันและคาบเดียวกันไว้แล้ว`,409);
  if(await env.DB.prepare('SELECT 1 FROM supervision_unavailability WHERE user_id=? AND unavailable_date=? AND (period IS NULL OR period=?)').bind(user.id,row.visit_date,row.period).first())
   return fail('คุณแจ้งไม่ว่างในวันและคาบนี้ไว้ ลบวันไม่ว่างก่อนจึงจะรับนิเทศได้',409);
  let r;
  try{r=await env.DB.prepare("UPDATE supervision_requests SET status='confirmed',supervisor_user_id=?,accepted_at=datetime('now'),updated_at=datetime('now') WHERE id=? AND status='pending'").bind(user.id,id).run();}
  catch(e){if(/UNIQUE/i.test(String(e.message)))return fail('คุณรับนิเทศในวันและคาบเดียวกันไว้แล้ว',409);throw e;}
  if(!r.meta.changes)return fail('มีผู้บริหารท่านอื่นรับนิเทศรายการนี้แล้ว กรุณาโหลดใหม่',409);
  const others=(await evaluatorIds(env)).filter(x=>x!==row.teacher_user_id);
  await env.DB.batch([
   env.DB.prepare('DELETE FROM supervision_releases WHERE request_id=? AND user_id=?').bind(id,user.id),
   ...notifyStatements(env,[row.teacher_user_id],id,`${user.full_name} รับนิเทศของคุณแล้ว: ${slotLabel(row)} (${COMBINED_LABEL})`,user.id),
   ...notifyStatements(env,others,id,`${user.full_name} รับนิเทศ ${row.teacher_name} ${slotLabel(row)}`,user.id)
  ]);
  return reply({ok:true});
 }
 if(row.supervisor_user_id!==user.id)return fail('เฉพาะผู้ที่รับนิเทศรายการนี้เท่านั้น',403);
 if(action==='release'){
  const r=await env.DB.prepare("UPDATE supervision_requests SET status='pending',supervisor_user_id=NULL,accepted_at=NULL,updated_at=datetime('now') WHERE id=? AND status='confirmed' AND supervisor_user_id=?").bind(id,user.id).run();
  if(!r.meta.changes)return fail('ถอนการรับได้เฉพาะรายการที่ยังไม่ประเมิน',409);
  // แจ้งไม่ว่างไว้แต่ครูยังไม่ได้ส่งอะไร → ล้างคำขอหลักฐาน ผู้รับคนใหม่เลือกเองว่าจะไปนิเทศหรือขอคลิปและภาพ
  if(row.evidence_requested_at&&!row.evidence_submitted_at&&!Number((await env.DB.prepare('SELECT COUNT(*) n FROM supervision_evidence_files WHERE request_id=?').bind(id).first()).n))
   await env.DB.prepare('UPDATE supervision_requests SET evidence_requested_at=NULL,evidence_requested_by=NULL,evidence_note=NULL,evidence_due_date=NULL,evidence_reminded_on=NULL,evidence_overdue_notified=NULL WHERE id=?').bind(id).run();
  const others=(await evaluatorIds(env)).filter(x=>x!==row.teacher_user_id);
  await env.DB.batch([
   env.DB.prepare('INSERT OR REPLACE INTO supervision_releases(request_id,user_id) VALUES(?,?)').bind(id,user.id),
   ...notifyStatements(env,[row.teacher_user_id],id,`${user.full_name} ถอนการรับนิเทศ ${slotLabel(row)} คำขอกลับไปรอผู้บริหารรับนิเทศ`,user.id),
   ...notifyStatements(env,others,id,`${user.full_name} ถอนการรับนิเทศ ${row.teacher_name} ${slotLabel(row)} — รอผู้รับนิเทศใหม่`,user.id)
  ]);
  return reply({ok:true});
 }
 if(action==='unavailable'){
  // ผู้ประเมินรับนิเทศแล้วแต่ไม่ว่างไปนิเทศ → ขอให้ครูส่งลิงก์คลิปการสอนและภาพการสอน/สื่อการสอนแทน
  if(row.status!=='confirmed')return fail('แจ้งไม่ว่างไปนิเทศได้เฉพาะรายการที่คุณรับนิเทศแล้วและยังไม่ประเมิน',409);
  if(row.evidence_requested_at)return fail('รายการนี้ขอให้ครูส่งคลิปและภาพแทนไว้แล้ว',409);
  const notReady=services?.ready?.(env);if(notReady||!services?.upload)return fail(`ยังไม่พร้อมรับภาพจากครู: ${notReady||'ยังไม่ได้ตั้งค่า Google Drive'} กรุณาแจ้งผู้ดูแลระบบ`,503);
  const body=await request.json().catch(()=>({}));const note=longText(body?.note,500)||null;
  // กำหนดส่ง: EVIDENCE_DAYS วันหลังวันนิเทศ หรือหลังวันที่แจ้ง (ถ้าแจ้งหลังวันนิเทศ)
  const today=bangkokNow().date,due=addDays(row.visit_date>today?row.visit_date:today,EVIDENCE_DAYS);
  const r=await env.DB.prepare("UPDATE supervision_requests SET evidence_requested_at=datetime('now'),evidence_requested_by=?,evidence_note=?,evidence_due_date=?,evidence_reminded_on=?,updated_at=datetime('now') WHERE id=? AND status='confirmed' AND supervisor_user_id=? AND evidence_requested_at IS NULL").bind(user.id,note,due,today,id,user.id).run();
  if(!r.meta.changes)return fail('สถานะเปลี่ยนแล้ว กรุณาโหลดใหม่',409);
  const notes=notifyStatements(env,[row.teacher_user_id],id,`${user.full_name} ไม่สะดวกไปนิเทศ ${slotLabel(row)} กรุณาส่งลิงก์คลิปการสอน และภาพการสอนหรือสื่อการสอน (ไม่เกิน ${EVIDENCE_MAX_IMAGES} ภาพ) แทน ภายใน ${thaiDate(due)} ที่เมนูลงทะเบียนนิเทศ → นัดหมายของฉัน${note?' · หมายเหตุ: '+note:''}`,user.id);
  if(notes.length)await env.DB.batch(notes);
  return reply({ok:true});
 }
 if(action==='evaluate'){
  if(row.status!=='confirmed')return fail('บันทึกคะแนนได้เฉพาะรายการที่ยืนยันนัดหมายแล้ว',409);
  if(row.evidence_requested_at&&!row.evidence_submitted_at)return fail('รอครูส่งลิงก์คลิปและภาพการสอนก่อน จึงบันทึกคะแนนจากหลักฐานได้',409);
  const body=await request.json().catch(()=>null);
  const scores=Array.isArray(body?.scores)?body.scores.map(Number):null,summary=summarizeScores(scores);
  if(!summary)return fail('กรุณาให้คะแนนครบทุกข้อ ข้อละ 1–5 คะแนน');
  const items=FORM_SECTIONS.flatMap(sec=>sec.items.map(label=>({section:sec.label,label}))).map((it,i)=>({...it,score:scores[i]}));
  const suggestion=longText(body.suggestion,3000);
  let results;
  try{
   results=await env.DB.batch([
    env.DB.prepare(`INSERT INTO supervision_evaluations(request_id,evaluator_user_id,items_json,total,percent,quality_level,suggestion)
     SELECT ?,?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM supervision_requests WHERE id=? AND status='confirmed' AND supervisor_user_id=?)`)
     .bind(id,user.id,JSON.stringify(items),summary.total,summary.percent,summary.level,suggestion||null,id,user.id),
    env.DB.prepare("UPDATE supervision_requests SET status='evaluated',updated_at=datetime('now') WHERE id=? AND status='confirmed' AND supervisor_user_id=? AND EXISTS(SELECT 1 FROM supervision_evaluations WHERE request_id=?)").bind(id,user.id,id)
   ]);
  }catch(e){if(/UNIQUE|PRIMARY/i.test(String(e.message)))return fail('รายการนี้บันทึกผลไปแล้ว',409);throw e;}
  if(!results[1].meta.changes)return fail('สถานะเปลี่ยนแล้ว กรุณาโหลดใหม่',409);
  const note=notifyStatements(env,[row.teacher_user_id],id,`ผลการนิเทศของคุณพร้อมแล้ว: ${slotLabel(row)} ได้ร้อยละ ${summary.percent} ระดับ${summary.level}`,user.id);
  if(note.length)await env.DB.batch(note);
  return reply({ok:true,request:shape(await loadRequest(env,id),{withResult:true})});
 }
 return fail('ไม่รู้จักคำสั่ง',404);
}

async function evaluators(request,env,user,method,userId){
 if(method==='GET'){
  const assigned=(await env.DB.prepare(`SELECT s.user_id,u.full_name,u.role,s.granted_at,g.full_name granted_by_name,
   (SELECT p.position FROM personnel_accounts a JOIN personnel_records p ON p.id=a.personnel_id WHERE a.user_id=u.id LIMIT 1) position
   FROM supervision_evaluators s JOIN users u ON u.id=s.user_id LEFT JOIN users g ON g.id=s.granted_by ORDER BY u.full_name`).all()).results;
  const automatic=(await env.DB.prepare(`SELECT DISTINCT u.id user_id,u.full_name,u.role,
   (SELECT p.position FROM personnel_accounts a JOIN personnel_records p ON p.id=a.personnel_id WHERE a.user_id=u.id LIMIT 1) position
   FROM users u WHERE u.status='active' AND u.deleted_at IS NULL AND (u.role='executive' OR EXISTS(SELECT 1 FROM personnel_accounts a JOIN personnel_records p ON p.id=a.personnel_id AND p.status='active' WHERE a.user_id=u.id AND ${EXEC_POSITION}))
   ORDER BY u.full_name`).all()).results;
  const candidates=(await env.DB.prepare(`SELECT u.id user_id,u.full_name,u.role,
   (SELECT p.position FROM personnel_accounts a JOIN personnel_records p ON p.id=a.personnel_id WHERE a.user_id=u.id LIMIT 1) position
   FROM users u WHERE u.status='active' AND u.deleted_at IS NULL AND u.role IN ('teacher','staff','executive','superadmin') ORDER BY u.full_name`).all()).results;
  return reply({assigned,automatic,candidates});
 }
 if(method==='POST'){
  const body=await request.json().catch(()=>null),id=Number(body?.user_id);
  if(!Number.isInteger(id)||id<1)return fail('เลือกผู้ใช้');
  const target=await env.DB.prepare("SELECT id,full_name FROM users WHERE id=? AND status='active' AND role IN ('teacher','staff','executive','superadmin')").bind(id).first();
  if(!target)return fail('ไม่พบผู้ใช้ที่ใช้งานอยู่',404);
  await env.DB.prepare('INSERT OR IGNORE INTO supervision_evaluators(user_id,granted_by) VALUES(?,?)').bind(id,user.id).run();
  return reply({ok:true});
 }
 if(method==='DELETE'){
  // ถอนสิทธิ์: นัดที่รับไว้แต่ยังไม่ประเมินกลับไปรอผู้รับนิเทศใหม่ และลบวันไม่ว่างของผู้นั้น
  const {results:open}=await env.DB.prepare(`${SELECT} WHERE r.supervisor_user_id=? AND r.status='confirmed'`).bind(userId).all();
  await env.DB.batch([
   env.DB.prepare('DELETE FROM supervision_evaluators WHERE user_id=?').bind(userId),
   env.DB.prepare('DELETE FROM supervision_unavailability WHERE user_id=?').bind(userId),
   env.DB.prepare("UPDATE supervision_requests SET status='pending',supervisor_user_id=NULL,accepted_at=NULL,updated_at=datetime('now') WHERE supervisor_user_id=? AND status='confirmed'").bind(userId)
  ]);
  if(open.length){
   const others=await evaluatorIds(env);
   await env.DB.batch(open.flatMap(r=>[
    ...notifyStatements(env,[r.teacher_user_id],r.id,`ผู้นิเทศเดิมถูกถอนสิทธิ์ประเมิน นัด ${slotLabel(r)} กลับไปรอผู้บริหารรับนิเทศ`,user.id),
    ...notifyStatements(env,others.filter(x=>x!==r.teacher_user_id&&x!==userId),r.id,`${r.teacher_name} ${slotLabel(r)} กลับไปรอผู้รับนิเทศใหม่ (ผู้นิเทศเดิมถูกถอนสิทธิ์)`,user.id)
   ]));
  }
  return reply({ok:true,released:open.length});
 }
 return fail('Method not allowed',405);
}

// วันไม่ว่างของผู้ประเมิน — ผู้ประเมินแจ้งเอง เห็นของผู้ประเมินทุกคนเพื่อประสานกัน ลบได้เฉพาะของตนเอง
async function unavailability(request,env,user,method,id,perms){
 if(!perms.evaluate)return fail('เฉพาะ ผอ. รอง ผอ. และผู้มีสิทธิ์ประเมินเท่านั้น',403);
 const today=bangkokNow().date;
 if(method==='GET'){
  const {results}=await env.DB.prepare(`SELECT s.id,s.user_id,u.full_name,s.unavailable_date,s.period,s.note,s.created_at FROM supervision_unavailability s JOIN users u ON u.id=s.user_id
   WHERE s.unavailable_date>=? ORDER BY s.unavailable_date,COALESCE(s.period,0),u.full_name`).bind(today).all();
  return reply({items:results.map(r=>({...r,mine:r.user_id===user.id}))});
 }
 if(method==='POST'&&!id){
  const body=await request.json().catch(()=>null),date=body?.date,period=body?.period==null||body.period===''?null:Number(body.period);
  if(!validDate(date)||!weekdayOf(date))return fail('เลือกวันจันทร์ถึงศุกร์ให้ถูกต้อง');
  if(date<today)return fail('ไม่สามารถแจ้งไม่ว่างย้อนหลังได้');
  if(period!==null&&(!Number.isInteger(period)||period<1||period>6))return fail('เลือกคาบให้ถูกต้อง');
  const busy=await env.DB.prepare(`SELECT r.period,u.full_name FROM supervision_requests r JOIN users u ON u.id=r.teacher_user_id WHERE r.supervisor_user_id=? AND r.status='confirmed' AND r.visit_date=?${period?' AND r.period=?':''} LIMIT 1`).bind(user.id,date,...(period?[period]:[])).first();
  if(busy)return fail(`คุณรับนิเทศ ${busy.full_name} คาบ ${busy.period} ในวันนี้ไว้แล้ว ถอนการรับก่อนจึงจะแจ้งไม่ว่างได้`,409);
  try{await env.DB.prepare('INSERT INTO supervision_unavailability(user_id,unavailable_date,period,note) VALUES(?,?,?,?)').bind(user.id,date,period,text(body.note,200)||null).run();}
  catch(e){if(/UNIQUE/i.test(String(e.message)))return fail('แจ้งไม่ว่างวันและคาบนี้ไว้แล้ว',409);throw e;}
  return reply({ok:true},201);
 }
 if(method==='DELETE'&&id){
  const r=await env.DB.prepare('DELETE FROM supervision_unavailability WHERE id=? AND user_id=?').bind(id,user.id).run();
  if(!r.meta.changes)return fail('ไม่พบรายการ หรือไม่ใช่รายการของคุณ',404);
  return reply({ok:true});
 }
 return fail('Method not allowed',405);
}

// ---------- หลักฐานแทนการนิเทศ (ลิงก์คลิป 1 ลิงก์ + ภาพไม่เกิน 10 ภาพ) ----------
// services มาจาก index.js: upload(env,file,requestId,name,mime) → {id}, read(env,driveFileId) → ReadableStream, remove(env,driveFileId), validate(file)
const IMAGE_MIMES=new Set(['image/jpeg','image/png','image/webp']);
export function validVideoUrl(v){
 const s=typeof v==='string'?v.trim():'';if(!s||s.length>500)return null;
 try{const u=new URL(s);return (u.protocol==='https:'||u.protocol==='http:')&&u.hostname.includes('.')?u.toString():null;}catch{return null;}
}
async function evidenceTarget(env,user,id){
 const row=await loadRequest(env,id);
 if(!row||row.status==='cancelled')return {error:fail('ไม่พบรายการนิเทศ',404)};
 if(row.teacher_user_id!==user.id)return {error:fail('ส่งหลักฐานได้เฉพาะคำขอของตนเอง',403)};
 if(!row.evidence_requested_at)return {error:fail('ผู้ประเมินยังไม่ได้แจ้งให้ส่งคลิปและภาพแทน',409)};
 if(row.status!=='confirmed')return {error:fail('รายการนี้ประเมินแล้ว แก้ไขหลักฐานไม่ได้',409)};
 return {row};
}
async function submitEvidence(request,env,user,id){
 const {row,error}=await evidenceTarget(env,user,id);if(error)return error;
 const body=await request.json().catch(()=>null);
 const url=validVideoUrl(body?.video_url);
 if(!url)return fail('กรุณาใส่ลิงก์คลิปการสอนให้ถูกต้อง (ขึ้นต้นด้วย https://)');
 const n=Number((await env.DB.prepare('SELECT COUNT(*) n FROM supervision_evidence_files WHERE request_id=?').bind(id).first()).n);
 if(!n)return fail('กรุณาแนบภาพการสอนหรือสื่อการสอนอย่างน้อย 1 ภาพ');
 const again=!!row.evidence_submitted_at;
 await env.DB.prepare("UPDATE supervision_requests SET evidence_video_url=?,evidence_submitted_at=datetime('now'),updated_at=datetime('now') WHERE id=?").bind(url,id).run();
 const notes=notifyStatements(env,[row.supervisor_user_id],id,`${row.teacher_name} ${again?'แก้ไข':'ส่ง'}ลิงก์คลิปการสอนและภาพ ${n} ภาพแล้ว: ${slotLabel(row)} — ประเมินจากหลักฐานได้ที่แท็บบันทึกคะแนน`,user.id);
 if(notes.length)await env.DB.batch(notes);
 return reply({ok:true,request:(await withEvidence(env,[shape(await loadRequest(env,id),{withResult:true})]))[0]});
}
async function uploadEvidenceImage(request,env,user,id,services){
 const {row,error}=await evidenceTarget(env,user,id);if(error)return error;
 if(!services?.upload)return fail('ยังไม่ได้ตั้งค่าการจัดเก็บภาพใน Google Drive',503);
 const n=Number((await env.DB.prepare('SELECT COUNT(*) n FROM supervision_evidence_files WHERE request_id=?').bind(id).first()).n);
 if(n>=EVIDENCE_MAX_IMAGES)return fail(`แนบภาพได้ไม่เกิน ${EVIDENCE_MAX_IMAGES} ภาพ`,409);
 const form=await request.formData().catch(()=>null),file=form?.get('file');
 const check=await services.validate(file,'supervision_evidence');
 if(check.error)return fail(check.error);
 if(!IMAGE_MIMES.has(check.mimeType))return fail('แนบได้เฉพาะไฟล์ภาพ JPG, PNG หรือ WEBP');
 const name=`${row.visit_date}_คาบ${row.period}_${String(file.name||'image').replace(/[^\p{L}\p{N}._ -]/gu,'_').slice(0,120)}`;
 let drive;
 try{drive=await services.upload(env,file,id,name,check.mimeType);}catch(e){return fail(e.message||'อัปโหลดภาพไม่สำเร็จ',502);}
 // นับซ้ำหลังอัปโหลด กันกดพร้อมกันหลายภาพจนเกินจำนวน
 const ins=await env.DB.prepare(`INSERT INTO supervision_evidence_files(request_id,drive_file_id,file_name,mime_type,file_size,uploaded_by)
  SELECT ?,?,?,?,?,? WHERE (SELECT COUNT(*) FROM supervision_evidence_files WHERE request_id=?)<?`).bind(id,drive.id,name,check.mimeType,file.size,user.id,id,EVIDENCE_MAX_IMAGES).run();
 if(!ins.meta.changes){await removeDrive(env,drive.id,services);return fail(`แนบภาพได้ไม่เกิน ${EVIDENCE_MAX_IMAGES} ภาพ`,409);}
 const fid=Number(ins.meta.last_row_id);
 return reply({ok:true,file:{id:fid,file_name:name,url:`/api/supervision/evidence/files/${fid}`}},201);
}
// ลบไฟล์ใน Drive ไม่สำเร็จ → เก็บไว้ให้ Cron ลองลบซ้ำ
async function removeDrive(env,driveFileId,services){
 try{if(!services?.remove)throw new Error('ยังไม่ได้ตั้งค่าการลบไฟล์ Drive');await services.remove(env,driveFileId);}
 catch(e){await env.DB.prepare('INSERT OR IGNORE INTO supervision_drive_trash(drive_file_id,last_error) VALUES(?,?)').bind(driveFileId,String(e.message||e).slice(0,300)).run().catch(()=>{});}
}
async function purgeEvidence(env,requestId,services){
 const {results}=await env.DB.prepare('SELECT id,drive_file_id FROM supervision_evidence_files WHERE request_id=?').bind(requestId).all();
 if(!results.length)return;
 await env.DB.prepare('DELETE FROM supervision_evidence_files WHERE request_id=?').bind(requestId).run();
 for(const f of results)await removeDrive(env,f.drive_file_id,services);
}
// งานรอบ Cron: ลบไฟล์ Drive ที่ค้าง + เตือนครูวันละครั้งจนกว่าจะส่งหลักฐาน + แจ้งผู้ประเมินเมื่อเลยกำหนด
export async function supervisionMaintenance(env,services,now=bangkokNow()){
 if(!env?.DB||!await tableExists(env,'supervision_requests'))return {skipped:true};
 await ensureSupervisionSchema(env);
 const out={reminded:0,overdue:0,trashed:0};
 const {results:trash}=await env.DB.prepare('SELECT drive_file_id,attempts FROM supervision_drive_trash WHERE attempts<10 ORDER BY created_at LIMIT 10').all();
 for(const t of trash){
  try{await services.remove(env,t.drive_file_id);await env.DB.prepare('DELETE FROM supervision_drive_trash WHERE drive_file_id=?').bind(t.drive_file_id).run();out.trashed++;}
  catch(e){await env.DB.prepare('UPDATE supervision_drive_trash SET attempts=attempts+1,last_error=? WHERE drive_file_id=?').bind(String(e.message||e).slice(0,300),t.drive_file_id).run();}
 }
 // เตือนครูเวลา 07:00 น. ขึ้นไป วันละครั้ง
 if(now.minutes>=7*60){
  const {results:due}=await env.DB.prepare(`SELECT r.id,r.teacher_user_id,r.supervisor_user_id,r.visit_date,r.period,r.evidence_due_date,r.evidence_overdue_notified,tu.full_name teacher_name
   FROM supervision_requests r JOIN users tu ON tu.id=r.teacher_user_id WHERE r.status='confirmed' AND r.evidence_requested_at IS NOT NULL AND r.evidence_submitted_at IS NULL
   AND (r.evidence_reminded_on IS NULL OR r.evidence_reminded_on<?) LIMIT 50`).bind(now.date).all();
  for(const r of due){
   const late=r.evidence_due_date&&r.evidence_due_date<now.date;
   const stmts=[env.DB.prepare('UPDATE supervision_requests SET evidence_reminded_on=? WHERE id=?').bind(now.date,r.id),
    ...notifyStatements(env,[r.teacher_user_id],r.id,late?`เลยกำหนดส่งคลิปและภาพการนิเทศ ${slotLabel(r)} (กำหนด ${thaiDate(r.evidence_due_date)}) กรุณาส่งโดยเร็ว`
     :`เตือน: ยังไม่ได้ส่งลิงก์คลิปและภาพการสอนแทนการนิเทศ ${slotLabel(r)} กำหนดส่ง ${thaiDate(r.evidence_due_date)}`,null)];
   if(late&&!r.evidence_overdue_notified){stmts.push(env.DB.prepare('UPDATE supervision_requests SET evidence_overdue_notified=1 WHERE id=?').bind(r.id),
    ...notifyStatements(env,[r.supervisor_user_id],r.id,`${r.teacher_name} ยังไม่ส่งคลิปและภาพการนิเทศ ${slotLabel(r)} เลยกำหนด ${thaiDate(r.evidence_due_date)} แล้ว`,null));out.overdue++;}
   await env.DB.batch(stmts);out.reminded++;
  }
 }
 return out;
}
async function evidenceFile(env,fileId){
 return env.DB.prepare('SELECT f.*,r.teacher_user_id,r.supervisor_user_id,r.status FROM supervision_evidence_files f JOIN supervision_requests r ON r.id=f.request_id WHERE f.id=?').bind(fileId).first();
}
async function readEvidenceImage(env,user,fileId,perms,services){
 const f=await evidenceFile(env,fileId);
 if(!f||!(f.teacher_user_id===user.id||f.supervisor_user_id===user.id||perms.view_all))return fail('ไม่พบภาพ หรือไม่มีสิทธิ์ดู',404);
 if(!services?.read)return fail('ยังไม่ได้ตั้งค่าการจัดเก็บภาพใน Google Drive',503);
 try{return new Response(await services.read(env,f.drive_file_id),{headers:{'Content-Type':f.mime_type,'Cache-Control':'private, max-age=604800, immutable','X-Content-Type-Options':'nosniff'}});}
 catch(e){return fail(e.message||'เปิดภาพไม่สำเร็จ',502);}
}
async function deleteEvidenceImage(env,user,fileId,services){
 const f=await evidenceFile(env,fileId);
 if(!f||f.teacher_user_id!==user.id)return fail('ไม่พบภาพ หรือไม่ใช่ภาพของคุณ',404);
 if(f.status!=='confirmed')return fail('รายการนี้ประเมินแล้ว ลบภาพไม่ได้',409);
 await env.DB.prepare('DELETE FROM supervision_evidence_files WHERE id=?').bind(fileId).run();
 await removeDrive(env,f.drive_file_id,services);
 return reply({ok:true});
}

export async function handleSupervisionRoute(request,env,pathname,method,services=null){
 if(!pathname.startsWith('/api/supervision/'))return null;
 const user=await getCurrentUser(request,env);
 if(!user?.role)return fail('กรุณาเข้าสู่ระบบ',401);
 const perms=await supervisionPermissions(env,user);
 const url=new URL(request.url);
 if(pathname==='/api/supervision/permissions'&&method==='GET')return reply({...perms,user:{id:user.id,full_name:user.full_name,role:user.role},
  form:{label:COMBINED_LABEL,sections:FORM_SECTIONS},max_score:MAX_SCORE,levels:QUALITY_LEVELS});
 if(pathname==='/api/supervision/week'&&method==='GET')return week(env,user,url);
 if(pathname==='/api/supervision/requests'&&method==='GET')return listRequests(env,user,url,perms);
 if(pathname==='/api/supervision/requests'&&method==='POST')return createRequest(request,env,user);
 const m=pathname.match(/^\/api\/supervision\/requests\/(\d+)\/(cancel|accept|release|unavailable|evaluate)$/);
 if(m&&method==='POST')return act(request,env,user,Number(m[1]),m[2],perms,services);
 const sub=pathname.match(/^\/api\/supervision\/requests\/(\d+)\/evidence$/);
 if(sub&&method==='POST')return submitEvidence(request,env,user,Number(sub[1]));
 // ภาพหลักฐาน: อยู่นอก /requests เพื่อไม่ให้การอัปโหลด/ลบภาพทีละรูปถูกนับเป็นการส่งซ้ำหรือยกเลิกถี่
 const up=pathname.match(/^\/api\/supervision\/evidence\/(\d+)\/images$/);
 if(up&&method==='POST')return uploadEvidenceImage(request,env,user,Number(up[1]),services);
 const file=pathname.match(/^\/api\/supervision\/evidence\/files\/(\d+)$/);
 if(file&&method==='GET')return readEvidenceImage(env,user,Number(file[1]),perms,services);
 if(file&&method==='DELETE')return deleteEvidenceImage(env,user,Number(file[1]),services);
 const ua=pathname.match(/^\/api\/supervision\/unavailability(?:\/(\d+))?$/);
 if(ua)return unavailability(request,env,user,method,ua[1]?Number(ua[1]):null,perms);
 const ev=pathname.match(/^\/api\/supervision\/evaluators(?:\/(\d+))?$/);
 if(ev){
  if(!perms.manage_evaluators)return fail('เฉพาะหัวหน้าฝ่ายวิชาการหรือผู้ดูแลระบบ',403);
  if(ev[1]&&method!=='DELETE')return fail('Method not allowed',405);
  return evaluators(request,env,user,method,Number(ev[1]));
 }
 return fail('ไม่พบ endpoint นี้',404);
}
