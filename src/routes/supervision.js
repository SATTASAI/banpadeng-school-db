// ระบบลงทะเบียนนิเทศ (นิเทศการสอน / นิเทศห้องเรียน)
// ครูลงทะเบียนคาบของตนเอง → ผู้มีสิทธิ์ประเมิน (ผอ. รอง ผอ. และผู้ที่ฝ่ายวิชาการแต่งตั้ง) รับนิเทศ → ผู้รับนิเทศบันทึกคะแนน
// ผลประเมิน: ครูเห็นเฉพาะของตนเอง ฝ่ายบริหารและฝ่ายวิชาการเห็นทั้งหมด
import {getCurrentUser,jsonResponse} from '../lib/auth.js';
import {ensurePersonnelData} from '../lib/personnel-data.js';
import {ensureDepartmentStaff,belongsToDepartment} from './department-staff.js';
import {loadStructure,DEFAULT_STRUCTURE} from '../lib/timetable-structure.js';

export const SUPERVISION_TYPES={
 teaching:{label:'นิเทศการสอน',items:['การออกแบบแผนการจัดการเรียนรู้','การจัดกิจกรรมที่เน้นผู้เรียนเป็นสำคัญ','การใช้สื่อและแหล่งเรียนรู้','การวัดและประเมินผลการเรียนรู้','การบริหารชั้นเรียนและการมีส่วนร่วม']},
 classroom:{label:'นิเทศห้องเรียน',items:['ความสะอาดและความเป็นระเบียบ','ความปลอดภัยในห้องเรียน','การจัดมุมเรียนรู้และสื่อการสอน','บรรยากาศที่ส่งเสริมการเรียนรู้','การแสดงผลงานและข้อมูลผู้เรียน']}
};
export const MAX_SCORE=25;
export const QUALITY_LEVELS=[[90,'ดีเยี่ยม'],[80,'ดีมาก'],[70,'ดี'],[60,'พอใช้'],[0,'ควรพัฒนา']];
export function qualityLevel(percent){return QUALITY_LEVELS.find(([min])=>percent>=min)[1];}
export function summarizeScores(scores){
 if(!Array.isArray(scores)||scores.length!==5||!scores.every(s=>Number.isInteger(s)&&s>=1&&s<=5))return null;
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
  env.DB.prepare('CREATE INDEX IF NOT EXISTS idx_supervision_notifications_user ON supervision_notifications(user_id,read_at)')
 ]).catch(e=>{ready.delete(env.DB);throw e;});
 ready.set(env.DB,p);return p;
}

const EXEC_POSITION=`REPLACE(COALESCE(p.position,''),' ','') LIKE '%ผู้อำนวยการ%' AND REPLACE(COALESCE(p.position,''),' ','') NOT LIKE '%ผู้ช่วยผู้อำนวยการ%'`;
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

const SELECT=`SELECT r.*,tu.full_name teacher_name,su.full_name supervisor_name,
 e.items_json,e.total,e.percent,e.quality_level,e.suggestion,e.evaluated_at,e.evaluator_user_id,eu.full_name evaluator_name,
 (SELECT p.position FROM personnel_accounts a JOIN personnel_records p ON p.id=a.personnel_id WHERE a.user_id=r.teacher_user_id LIMIT 1) teacher_position,
 (SELECT p.position FROM personnel_accounts a JOIN personnel_records p ON p.id=a.personnel_id WHERE a.user_id=r.supervisor_user_id LIMIT 1) supervisor_position,
 (SELECT p.position FROM personnel_accounts a JOIN personnel_records p ON p.id=a.personnel_id WHERE a.user_id=e.evaluator_user_id LIMIT 1) evaluator_position
 FROM supervision_requests r JOIN users tu ON tu.id=r.teacher_user_id LEFT JOIN users su ON su.id=r.supervisor_user_id
 LEFT JOIN supervision_evaluations e ON e.request_id=r.id LEFT JOIN users eu ON eu.id=e.evaluator_user_id`;
function shape(row,{withResult}){
 const out={id:row.id,teacher_user_id:row.teacher_user_id,teacher_name:row.teacher_name,teacher_position:row.teacher_position||null,
  academic_term_id:row.academic_term_id,visit_date:row.visit_date,weekday:row.weekday,period:row.period,source:row.source,subject:row.subject,grade_level:row.grade_level,classroom:row.classroom,room_name:row.room_name,
  supervision_type:row.supervision_type,type_label:SUPERVISION_TYPES[row.supervision_type]?.label,topic:row.topic,status:row.status,
  supervisor_user_id:row.supervisor_user_id,supervisor_name:row.supervisor_name,supervisor_position:row.supervisor_position||null,
  accepted_at:row.accepted_at,created_at:row.created_at,cancelled_at:row.cancelled_at};
 if(row.status==='evaluated'&&withResult){
  let items=[];try{items=JSON.parse(row.items_json);}catch{}
  out.evaluation={items,total:row.total,percent:row.percent,level:row.quality_level,suggestion:row.suggestion,evaluated_at:row.evaluated_at,
   evaluator_user_id:row.evaluator_user_id,evaluator_name:row.evaluator_name,evaluator_position:row.evaluator_position||null};
 }
 return out;
}
async function loadRequest(env,id){return env.DB.prepare(`${SELECT} WHERE r.id=?`).bind(id).first();}
const TH_DAYS=['อา.','จ.','อ.','พ.','พฤ.','ศ.','ส.'],TH_MONTHS=['ม.ค.','ก.พ.','มี.ค.','เม.ย.','พ.ค.','มิ.ย.','ก.ค.','ส.ค.','ก.ย.','ต.ค.','พ.ย.','ธ.ค.'];
export function thaiDate(iso){const d=new Date(iso+'T00:00:00Z');return `${TH_DAYS[d.getUTCDay()]} ${d.getUTCDate()} ${TH_MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()+543}`;}
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
 return reply({start,end:dates[4],now,linked:personnelIds.length>0,
  terms:[...terms.values()].map(t=>({id:t.term.id,name:t.term.name,year_be:t.term.year_be,start_date:t.term.start_date,end_date:t.term.end_date,
   mode:t.plan?'timetable':'manual',times:t.structure.times,lunch:t.structure.lunch,
   lessons:t.lessons.map(l=>({entry_id:l.id,weekday:l.weekday,period:l.period,subject:l.subject,grade_level:l.grade_level,classroom:l.classroom,room_name:l.room_name}))})),
  days,requests:mine.map(r=>shape(r,{withResult:true})),default_times:DEFAULT_STRUCTURE.times});
}

async function createRequest(request,env,user){
 const body=await request.json().catch(()=>null);
 const date=body?.visit_date,period=Number(body?.period),type=body?.supervision_type;
 if(!validDate(date)||!weekdayOf(date))return fail('เลือกวันจันทร์ถึงศุกร์ให้ถูกต้อง');
 if(!Number.isInteger(period)||period<1||period>6)return fail('เลือกคาบเรียนให้ถูกต้อง');
 if(!SUPERVISION_TYPES[type])return fail('เลือกประเภทการนิเทศ');
 const topic=longText(body.topic,500);
 const term=await termFor(env,date);if(!term)return fail('วันที่เลือกไม่อยู่ในภาคเรียน');
 const structure=await periodTimes(env,term.id);
 if(slotStarted(date,structure.times[period-1].start))return fail('ไม่สามารถเลือกวันหรือคาบที่ผ่านมาแล้ว');
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
  const result=await env.DB.prepare(`INSERT INTO supervision_requests(teacher_user_id,teacher_personnel_id,academic_term_id,visit_date,weekday,period,source,timetable_entry_id,subject,grade_level,classroom,room_name,supervision_type,topic)
   VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(user.id,lesson.teacher_id||personnelIds[0]||null,term.id,date,weekdayOf(date),period,plan?'timetable':'manual',lesson.id,
   lesson.subject,lesson.grade_level,lesson.classroom||null,lesson.room_name||null,type,topic||null).run();
  id=Number(result.meta.last_row_id);
 }catch(e){if(/UNIQUE/i.test(String(e.message)))return fail('คุณลงทะเบียนคาบนี้ไว้แล้ว',409);throw e;}
 const room=[lesson.grade_level,lesson.classroom].filter(Boolean).join('/');
 const notes=notifyStatements(env,await evaluatorIds(env),id,`${user.full_name} ขอรับ${SUPERVISION_TYPES[type].label} ${slotLabel({visit_date:date,period})} · ${lesson.subject}${room?' '+room:''}`,user.id);
 if(notes.length)await env.DB.batch(notes);
 return reply({ok:true,request:shape(await loadRequest(env,id),{withResult:true})},201);
}

async function listRequests(env,user,url,perms){
 const scope=url.searchParams.get('scope')==='all'?'all':'mine';
 if(scope==='mine'){
  const {results}=await env.DB.prepare(`${SELECT} WHERE r.teacher_user_id=? AND r.status<>'cancelled' ORDER BY r.visit_date DESC,r.period`).bind(user.id).all();
  return reply({scope,requests:results.map(r=>shape(r,{withResult:true}))});
 }
 if(!perms.evaluate&&!perms.view_all)return fail('เฉพาะฝ่ายบริหาร ฝ่ายวิชาการ หรือผู้มีสิทธิ์ประเมิน',403);
 const {results}=await env.DB.prepare(`${SELECT} WHERE r.status<>'cancelled' ORDER BY r.visit_date,r.period,r.id`).all();
 // ผู้ประเมินที่ได้รับแต่งตั้ง (ไม่ใช่ฝ่ายบริหาร/ฝ่ายวิชาการ) เห็นคะแนนเฉพาะรายการที่ตนประเมิน
 return reply({scope,requests:results.map(r=>shape(r,{withResult:perms.view_all||r.evaluator_user_id===user.id||r.teacher_user_id===user.id}))});
}

async function act(request,env,user,id,action,perms){
 const row=await loadRequest(env,id);
 if(!row||row.status==='cancelled')return fail('ไม่พบรายการนิเทศ',404);
 if(action==='cancel'){
  if(row.teacher_user_id!==user.id)return fail('ยกเลิกได้เฉพาะคำขอของตนเอง',403);
  if(row.status==='evaluated')return fail('รายการที่ประเมินแล้วยกเลิกไม่ได้',409);
  const r=await env.DB.prepare("UPDATE supervision_requests SET status='cancelled',cancelled_at=datetime('now'),cancelled_by=?,updated_at=datetime('now') WHERE id=? AND status IN ('pending','confirmed')").bind(user.id,id).run();
  if(!r.meta.changes)return fail('สถานะเปลี่ยนแล้ว กรุณาโหลดใหม่',409);
  const to=row.supervisor_user_id?[row.supervisor_user_id]:await evaluatorIds(env);
  const notes=notifyStatements(env,to,id,`${row.teacher_name} ยกเลิกคำขอ${SUPERVISION_TYPES[row.supervision_type].label} ${slotLabel(row)}`,user.id);
  if(notes.length)await env.DB.batch(notes);
  return reply({ok:true});
 }
 if(!perms.evaluate)return fail('เฉพาะ ผอ. รอง ผอ. และผู้มีสิทธิ์ประเมินเท่านั้น',403);
 if(action==='accept'){
  if(row.teacher_user_id===user.id)return fail('ไม่สามารถรับนิเทศคำขอของตนเองได้',403);
  if(row.status!=='pending')return fail(row.supervisor_name?`รายการนี้ ${row.supervisor_name} รับนิเทศแล้ว`:'สถานะเปลี่ยนแล้ว กรุณาโหลดใหม่',409);
  const clash=await env.DB.prepare(`SELECT u.full_name FROM supervision_requests r JOIN users u ON u.id=r.teacher_user_id WHERE r.supervisor_user_id=? AND r.visit_date=? AND r.period=? AND r.status IN ('confirmed','evaluated') AND r.id<>?`).bind(user.id,row.visit_date,row.period,id).first();
  if(clash)return fail(`คุณรับนิเทศ ${clash.full_name} ในวันและคาบเดียวกันไว้แล้ว`,409);
  let r;
  try{r=await env.DB.prepare("UPDATE supervision_requests SET status='confirmed',supervisor_user_id=?,accepted_at=datetime('now'),updated_at=datetime('now') WHERE id=? AND status='pending'").bind(user.id,id).run();}
  catch(e){if(/UNIQUE/i.test(String(e.message)))return fail('คุณรับนิเทศในวันและคาบเดียวกันไว้แล้ว',409);throw e;}
  if(!r.meta.changes)return fail('มีผู้บริหารท่านอื่นรับนิเทศรายการนี้แล้ว กรุณาโหลดใหม่',409);
  const others=(await evaluatorIds(env)).filter(x=>x!==row.teacher_user_id);
  await env.DB.batch([
   ...notifyStatements(env,[row.teacher_user_id],id,`${user.full_name} รับนิเทศของคุณแล้ว: ${slotLabel(row)} (${SUPERVISION_TYPES[row.supervision_type].label})`,user.id),
   ...notifyStatements(env,others,id,`${user.full_name} รับนิเทศ ${row.teacher_name} ${slotLabel(row)}`,user.id)
  ]);
  return reply({ok:true});
 }
 if(row.supervisor_user_id!==user.id)return fail('เฉพาะผู้ที่รับนิเทศรายการนี้เท่านั้น',403);
 if(action==='release'){
  const r=await env.DB.prepare("UPDATE supervision_requests SET status='pending',supervisor_user_id=NULL,accepted_at=NULL,updated_at=datetime('now') WHERE id=? AND status='confirmed' AND supervisor_user_id=?").bind(id,user.id).run();
  if(!r.meta.changes)return fail('ถอนการรับได้เฉพาะรายการที่ยังไม่ประเมิน',409);
  const others=(await evaluatorIds(env)).filter(x=>x!==row.teacher_user_id);
  await env.DB.batch([
   ...notifyStatements(env,[row.teacher_user_id],id,`${user.full_name} ถอนการรับนิเทศ ${slotLabel(row)} คำขอกลับไปรอผู้บริหารรับนิเทศ`,user.id),
   ...notifyStatements(env,others,id,`${user.full_name} ถอนการรับนิเทศ ${row.teacher_name} ${slotLabel(row)} — รอผู้รับนิเทศใหม่`,user.id)
  ]);
  return reply({ok:true});
 }
 if(action==='evaluate'){
  if(row.status!=='confirmed')return fail('บันทึกคะแนนได้เฉพาะรายการที่ยืนยันนัดหมายแล้ว',409);
  const body=await request.json().catch(()=>null);
  const scores=Array.isArray(body?.scores)?body.scores.map(Number):null,summary=summarizeScores(scores);
  if(!summary)return fail('กรุณาให้คะแนนครบทุกข้อ ข้อละ 1–5 คะแนน');
  const items=SUPERVISION_TYPES[row.supervision_type].items.map((label,i)=>({label,score:scores[i]}));
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
  const pending=await env.DB.prepare("SELECT COUNT(*) n FROM supervision_requests WHERE supervisor_user_id=? AND status='confirmed'").bind(userId).first();
  await env.DB.prepare('DELETE FROM supervision_evaluators WHERE user_id=?').bind(userId).run();
  return reply({ok:true,open_assignments:Number(pending?.n||0)});
 }
 return fail('Method not allowed',405);
}

export async function handleSupervisionRoute(request,env,pathname,method){
 if(!pathname.startsWith('/api/supervision/'))return null;
 const user=await getCurrentUser(request,env);
 if(!user?.role)return fail('กรุณาเข้าสู่ระบบ',401);
 const perms=await supervisionPermissions(env,user);
 const url=new URL(request.url);
 if(pathname==='/api/supervision/permissions'&&method==='GET')return reply({...perms,user:{id:user.id,full_name:user.full_name,role:user.role},
  types:Object.fromEntries(Object.entries(SUPERVISION_TYPES).map(([k,v])=>[k,{label:v.label,items:v.items}])),max_score:MAX_SCORE,levels:QUALITY_LEVELS});
 if(pathname==='/api/supervision/week'&&method==='GET')return week(env,user,url);
 if(pathname==='/api/supervision/requests'&&method==='GET')return listRequests(env,user,url,perms);
 if(pathname==='/api/supervision/requests'&&method==='POST')return createRequest(request,env,user);
 const m=pathname.match(/^\/api\/supervision\/requests\/(\d+)\/(cancel|accept|release|evaluate)$/);
 if(m&&method==='POST')return act(request,env,user,Number(m[1]),m[2],perms);
 const ev=pathname.match(/^\/api\/supervision\/evaluators(?:\/(\d+))?$/);
 if(ev){
  if(!perms.manage_evaluators)return fail('เฉพาะหัวหน้าฝ่ายวิชาการหรือผู้ดูแลระบบ',403);
  if(ev[1]&&method!=='DELETE')return fail('Method not allowed',405);
  return evaluators(request,env,user,method,Number(ev[1]));
 }
 return fail('ไม่พบ endpoint นี้',404);
}
