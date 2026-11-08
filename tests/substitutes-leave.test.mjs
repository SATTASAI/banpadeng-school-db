import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture,call} from './notifications.test.mjs';
import {ensureLeaveData} from '../src/lib/leave-data.js';

async function setup(){
 const env=await fixture();await ensureLeaveData(env);
 const person=user=>env.raw.prepare('SELECT id FROM personnel_records WHERE user_id=?').get(user).id;
 const absent=person(2),staff=person(3);
 await call(env,'/api/department-staff/personnel','POST',{personnel_id:staff,is_head:true});
 for(const [id,name] of [[4,'ครูว่าง'],[5,'ครูที่ลาอีกคน']]){
  env.raw.prepare("INSERT INTO users(id,email,password_hash,password_salt,full_name,role) VALUES(?,?,'x','x',?,'teacher')").run(id,'test'+id,name);
  env.raw.prepare("INSERT INTO personnel_records(user_id,full_name,normalized_name,position) VALUES(?,?,?,'ครู')").run(id,name,'test-person-'+id);
  env.raw.prepare('INSERT INTO personnel_accounts(user_id,personnel_id) VALUES(?,?)').run(id,person(id));
 }
 await call(env,'/api/substitutes/leaves?date=2026-10-06','GET',undefined,3);
 env.raw.exec(`INSERT INTO academic_years(id,year_be,label,start_date,end_date) VALUES(99,2569,'ทดสอบ','2026-05-01','2027-04-30');
 INSERT INTO academic_terms(id,academic_year_id,term_number,name,start_date,end_date) VALUES(99,99,1,'ทดสอบ','2026-05-01','2026-10-31');
 INSERT INTO timetable_plans(id,academic_term_id,status,created_by) VALUES(99,99,'published',1);`);
 for(const period of [1,2])env.raw.prepare("INSERT INTO timetable_entries(id,plan_id,grade_level,classroom,weekday,period,subject,teacher_id) VALUES(?,99,'ป.4','1',2,?,'ภาษาไทย',?)").run(period,period,absent);
 // ครูว่างและครูที่ลา สอน ป.4-6 ในวันอื่น (ช่วงชั้นเดียวกับคาบที่ต้องจัดแทน)
 env.raw.prepare("INSERT INTO timetable_entries(id,plan_id,grade_level,classroom,weekday,period,subject,teacher_id) VALUES(10,99,'ป.5','1',1,1,'คณิตศาสตร์',?)").run(person(4));
 env.raw.prepare("INSERT INTO timetable_entries(id,plan_id,grade_level,classroom,weekday,period,subject,teacher_id) VALUES(11,99,'ป.6','1',1,2,'คณิตศาสตร์',?)").run(person(5));
 env.raw.exec(`INSERT INTO users(id,email,password_hash,password_salt,full_name,role) VALUES(6,'old-account','x','x','บัญชีเดิม','teacher')`);
 env.raw.prepare('INSERT INTO personnel_accounts(user_id,personnel_id) VALUES(6,?)').run(absent);
 env.raw.exec(`INSERT INTO leave_requests(id,user_id,leave_type,leave_subtype,start_date,end_date,leave_days,status) VALUES
 (80,6,'other','lenient','2026-10-05','2026-10-07',0.5,'pending'),
 (81,5,'sick',NULL,'2026-10-06','2026-10-06',1,'approved'),
 (82,4,'personal',NULL,'2026-10-06','2026-10-06',1,'rejected'),
 (83,4,'personal',NULL,'2026-10-07','2026-10-07',1,'approved');`);
 return {env,absent,free:person(4),onLeave:person(5)};
}
const path='/api/substitutes/';
test('substitution reads canonical leave accounts and dates, preserves half-day/type/status, and excludes rejected requests',async()=>{
 const {env,absent}=await setup();
 const res=await call(env,path+'leaves?date=2026-10-06','GET',undefined,3);assert.equal(res.status,200);
 const rows=(await res.json()).leave_requests;assert.deepEqual(rows.map(r=>r.leave_request_id),[81,80]);
 const r=rows.find(r=>r.leave_request_id===80);assert.equal(r.teacher_id,absent);assert.equal(r.leave_type,'lenient');assert.equal(r.leave_days,0.5);assert.equal(r.status,'pending');assert.equal(r.end_date,'2026-10-07');assert(!('reason' in r));
 assert.equal((await call(env,path+'leaves?date=2026-02-30','GET',undefined,3)).status,400);
 assert.equal((await call(env,path+'leaves?date=2026-10-06','GET',undefined,2)).status,403);
 assert.equal((await call(env,path+'leaves?date=2026-10-06','GET',undefined,1)).status,200);
 assert.equal((await (await call(env,path+'permissions','GET',undefined,1)).json()).can_manage,true);
 env.raw.prepare("DELETE FROM leave_requests WHERE id=80").run();
 assert(!(await (await call(env,path+'leaves?date=2026-10-06','GET',undefined,3)).json()).leave_requests.some(r=>r.leave_request_id===80));
});
test('coverage excludes every teacher on pending or approved leave and assignment validates and retains its source',async()=>{
 const {env,absent,free,onLeave}=await setup();
 const url=path+`coverage?date=2026-10-06&teacher_id=${absent}`;
 const lessons=(await (await call(env,url,'GET',undefined,3)).json()).lessons;
 assert.equal(lessons.length,2);assert(lessons[0].available_teachers.some(t=>t.id===free));assert(!lessons[0].available_teachers.some(t=>t.id===onLeave));
 const data={date:'2026-10-06',teacher_id:absent,entry_id:1,substitute_teacher_id:free,leave_request_id:80};
 for(const patch of [{substitute_teacher_id:onLeave},{leave_request_id:81},{date:'2026-10-08'},{leave_request_id:999}])assert.equal((await call(env,path+'assignments','POST',{...data,...patch},3)).status,409);
 assert.equal((await call(env,path+'assignments','POST',data,2)).status,403);
 assert.equal((await call(env,path+'assignments','POST',data,1)).status,200);
 const rows=(await (await call(env,path+'assignments?date=2026-10-06','GET',undefined,3)).json()).assignments;
 assert.equal(rows[0].leave_request_id,80);assert.equal(rows[0].leave_status,'pending');assert.equal(rows[0].absent_name,'ครู ก');
 assert.equal(env.raw.prepare('SELECT status FROM leave_requests WHERE id=80').get().status,'pending');
 assert.equal((await call(env,path+'assignments','POST',data,3)).status,409);
 env.raw.exec("UPDATE leave_requests SET status='rejected' WHERE id=80");
 assert.equal((await call(env,path+'assignments','POST',{...data,entry_id:2},3)).status,409);
 assert.equal((await (await call(env,path+'assignments?date=2026-10-06','GET',undefined,3)).json()).assignments[0].leave_status,'rejected');
 env.raw.exec('PRAGMA foreign_keys=ON; DELETE FROM leave_requests WHERE id=80');
 assert.equal(env.raw.prepare('SELECT leave_request_id FROM substitute_assignments').get().leave_request_id,null);
});

test('substitution UI loads leaves when dates change and uses their canonical teacher without stale coverage',async()=>{
 const fs=await import('node:fs'),vm=await import('node:vm');
 const html=fs.readFileSync('public/substitutes.html','utf8'),nodes=new Map(),calls=[];
 const node=id=>{if(!nodes.has(id))nodes.set(id,{value:'',hidden:false,disabled:false,textContent:'',innerHTML:'',classList:{toggle(){}},querySelectorAll(){return []}});return nodes.get(id)};
 let delayed;const tick=()=>new Promise(resolve=>setImmediate(resolve));
 const sandbox=vm.createContext({URLSearchParams,location:{search:'?mode=leave'},SubstituteDayPlan:{init(){},reset(){},build(){}},document:{getElementById:node,querySelector:()=>node('page')},SubstituteOrderExport:{director:()=> 'ผู้อำนวยการ'},apiRequest:async(url)=>{
  calls.push(url);if(url==='/api/auth/me')return {user:{id:3}};
  if(url==='/api/substitutes/permissions')return {can_manage:true};if(url==='/api/staff')return {staff:[]};
  if(url.includes('/leaves?'))return {leave_requests:[{leave_request_id:80,teacher_id:42,full_name:'ครูตัวอย่าง',leave_type:'lenient',leave_days:0.5,status:'pending',start_date:'2026-10-06',end_date:'2026-10-06'}]};
  if(url.includes('/coverage?'))return new Promise(resolve=>{delayed=resolve});return {assignments:[]};
 }});
 vm.runInContext([...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].at(-1)[1],sandbox);await tick();
 assert.match(node('absentTeacher').innerHTML,/ลาอนุโลม/);assert.match(node('absentTeacher').innerHTML,/รอพิจารณา/);
 node('date').value='2026-10-06';node('absentTeacher').value='80';node('absentTeacher').onchange();await tick();
 assert(calls.some(url=>url.includes('coverage?date=2026-10-06&teacher_id=42')));assert.match(node('leaveInfo').textContent,/0.5 วัน/);
 node('date').value='2026-10-07';node('date').onchange();await tick();
 delayed({lessons:[{id:1,period:1,subject:'คาบเก่า',available_teachers:[]}],term:{name:'ทดสอบ',year_be:2569}});await tick();
 assert.equal(node('lessons').innerHTML,'');assert(calls.some(url=>url.includes('leaves?date=2026-10-07')));
 assert.match(html,/leave_request_id:leave.leave_request_id/);
});

test('substitution without a leave request requires a reason and blocks the absent teacher as a substitute',async()=>{
 const {env,absent,free}=await setup();
 const teachers=(await (await call(env,path+'teachers?date=2026-10-06','GET',undefined,3)).json()).teachers;
 assert.deepEqual(teachers.find(t=>t.id===absent).lesson_count,2);assert(teachers.some(t=>t.id===free&&t.lesson_count===0));
 assert.equal((await call(env,path+'teachers?date=2026-10-06','GET',undefined,2)).status,403);
 const data={date:'2026-10-06',teacher_id:absent,entry_id:1,substitute_teacher_id:free,leave_request_id:null};
 assert.equal((await call(env,path+'assignments','POST',data,3)).status,400);
 assert.equal((await call(env,path+'assignments','POST',{...data,reason:'ไปราชการ'},3)).status,200);
 const rows=(await (await call(env,path+'assignments?date=2026-10-06','GET',undefined,3)).json()).assignments;
 assert.equal(rows[0].absence_reason,'ไปราชการ');assert.equal(rows[0].leave_request_id,null);
 assert.equal((await (await call(env,path+'teachers?date=2026-10-06','GET',undefined,3)).json()).teachers[0].absence_reason,'ไปราชการ');
});

test('cancel and change keep history, notify the replaced teacher and keep only the new teacher assigned',async()=>{
 const {env,absent,free}=await setup();
 env.raw.exec("INSERT INTO users(id,email,password_hash,password_salt,full_name,role) VALUES(7,'test7','x','x','ครูใหม่','teacher')");
 env.raw.exec("INSERT INTO personnel_records(user_id,full_name,normalized_name,position) VALUES(7,'ครูใหม่','test-person-7','ครู')");
 const other=env.raw.prepare('SELECT id FROM personnel_records WHERE user_id=7').get().id;
 env.raw.prepare('INSERT INTO personnel_accounts(user_id,personnel_id) VALUES(7,?)').run(other);
 env.raw.prepare("INSERT INTO timetable_entries(id,plan_id,grade_level,classroom,weekday,period,subject,teacher_id) VALUES(12,99,'ป.4','1',3,1,'ศิลปะ',?)").run(other);
 const today=new Date(Date.now()+7*3600e3).toISOString().slice(0,10);
 // วันที่ในอนาคตที่เป็นวันอังคาร (ตรงกับคาบทดสอบ weekday=2) และอยู่ในภาคเรียนทดสอบ
 env.raw.exec("UPDATE academic_terms SET end_date='2099-12-31' WHERE id=99");
 let d=new Date(today+'T12:00:00Z');while(d.getUTCDay()!==2)d=new Date(d.getTime()+864e5);const date=d.toISOString().slice(0,10);
 const base={date,teacher_id:absent,entry_id:1,substitute_teacher_id:free,leave_request_id:null,reason:'อบรม'};
 assert.equal((await call(env,path+'assignments','POST',base,3)).status,200);
 const id=env.raw.prepare('SELECT id FROM substitute_assignments').get().id;
 const keys=async user=>(await (await call(env,'/api/notifications','GET',undefined,user)).json()).notifications.map(n=>n.message_key);
 assert((await keys(4)).includes(`substitute:${id}:${free}`));
 assert.equal((await call(env,path+`assignments/${id}`,'PATCH',{substitute_teacher_id:free},3)).status,400);
 assert.equal((await call(env,path+`assignments/${id}`,'PATCH',{substitute_teacher_id:absent},3)).status,409);
 assert.equal((await call(env,path+`assignments/${id}`,'PATCH',{substitute_teacher_id:other},2)).status,403);
 assert.equal((await call(env,path+`assignments/${id}`,'PATCH',{substitute_teacher_id:other},3)).status,200);
 assert.equal(env.raw.prepare('SELECT substitute_teacher_id s FROM substitute_assignments WHERE id=?').get(id).s,other);
 assert((await keys(7)).includes(`substitute:${id}:${other}`));
 const k4=await keys(4);assert(!k4.includes(`substitute:${id}:${free}`));assert(k4.some(k=>k.startsWith('substitute-cancel:')));
 const mine4=await (await call(env,path+'mine','GET',undefined,4)).json();
 assert.equal(mine4.teaching.length,0);assert.equal(mine4.cancelled[0].action,'replaced');
 const mine7=await (await call(env,path+'mine','GET',undefined,7)).json();
 assert.equal(mine7.teaching[0].absence_reason,'อบรม');assert.equal(mine7.teaching[0].period,1);
 const mineAbsent=await (await call(env,path+'mine','GET',undefined,2)).json();
 assert.equal(mineAbsent.covered[0].substitute_name,'ครูใหม่');
 assert.equal((await call(env,path+`assignments/${id}`,'DELETE',undefined,2)).status,403);
 assert.equal((await call(env,path+`assignments/${id}`,'DELETE',undefined,3)).status,200);
 assert.equal(env.raw.prepare('SELECT COUNT(*) n FROM substitute_assignments').get().n,0);
 assert.equal(env.raw.prepare('SELECT COUNT(*) n FROM substitute_absences').get().n,0);
 assert.equal((await (await call(env,path+'mine','GET',undefined,7)).json()).cancelled[0].action,'cancelled');
 assert((await keys(7)).some(k=>k.startsWith('substitute-cancel:')));
 assert.equal((await call(env,path+`assignments/${id}`,'DELETE',undefined,3)).status,404);
});

test('system proposes same-band teachers with the fewest substitutions, spreads periods, and hides stats from teachers',async()=>{
 const {env,absent,free}=await setup();
 const add=(uid,name)=>{env.raw.prepare("INSERT INTO users(id,email,password_hash,password_salt,full_name,role) VALUES(?,?,'x','x',?,'teacher')").run(uid,'t'+uid,name);
  env.raw.prepare("INSERT INTO personnel_records(user_id,full_name,normalized_name,position) VALUES(?,?,?,'ครู')").run(uid,name,'p-'+uid);
  const id=env.raw.prepare('SELECT id FROM personnel_records WHERE user_id=?').get(uid).id;env.raw.prepare('INSERT INTO personnel_accounts(user_id,personnel_id) VALUES(?,?)').run(uid,id);return id;};
 const lower=add(20,'ครูป.ต้น'),cross=add(21,'ครูควบช่วงชั้น'),none=add(22,'ครูไม่มีคาบ');
 env.raw.prepare("INSERT INTO timetable_entries(id,plan_id,grade_level,classroom,weekday,period,subject,teacher_id) VALUES(20,99,'ป.2','1',1,3,'ไทย',?)").run(lower);
 env.raw.prepare("INSERT INTO timetable_entries(id,plan_id,grade_level,classroom,weekday,period,subject,teacher_id) VALUES(21,99,'ป.3','1',1,4,'ไทย',?)").run(cross);
 env.raw.prepare("INSERT INTO timetable_entries(id,plan_id,grade_level,classroom,weekday,period,subject,teacher_id) VALUES(22,99,'ป.6','1',1,5,'ไทย',?)").run(cross);
 const data=await (await call(env,path+'coverage?date=2026-10-06&teacher_id='+absent,'GET',undefined,3)).json();
 const ids=data.lessons[0].available_teachers.map(t=>t.id);
 assert(ids.includes(free)&&ids.includes(cross));assert(!ids.includes(lower));assert(!ids.includes(none));
 assert.equal(data.lessons[0].band,'p4-6');
 // สองคาบในวันเดียวกัน → เสนอคนละคน (ไม่จัดคนเดิมซ้ำ)
 const proposed=data.lessons.map(l=>l.proposed_teacher_id);assert(proposed.every(Boolean));assert.notEqual(proposed[0],proposed[1]);
 // ครูที่สอนแทนไปแล้วในภาคเรียน ถูกเสนอทีหลัง
 env.raw.exec(`INSERT INTO substitute_absences(id,absence_date,teacher_id,reason,created_by) VALUES(50,'2026-09-01',${lower},'x',1)`);
 env.raw.exec(`INSERT INTO substitute_assignments(absence_id,timetable_entry_id,substitute_teacher_id,weekday,period,absence_date,created_by) VALUES(50,20,${free},2,3,'2026-09-01',1)`);
 const again=await (await call(env,path+'coverage?date=2026-10-06&teacher_id='+absent,'GET',undefined,3)).json();
 assert.equal(again.lessons[0].proposed_teacher_id,cross);
 // ไม่ให้จัดครูต่างช่วงชั้น แม้ส่งตรงมาที่ API
 assert.equal((await call(env,path+'assignments','POST',{date:'2026-10-06',teacher_id:absent,entry_id:1,substitute_teacher_id:lower,leave_request_id:null,reason:'อบรม'},3)).status,409);
 // สถิติ: ครูทั่วไปไม่เห็น แม้ของตนเอง; ฝ่ายบุคคลเห็น
 assert.equal((await call(env,'/api/personnel/substitute-stats','GET',undefined,4)).status,403);
 assert.equal((await call(env,'/api/personnel/substitute-stats','GET',undefined,3)).status,200);
 assert.equal((await (await call(env,path+'permissions','GET',undefined,4)).json()).can_view_stats,false);
});

test('publishing a new timetable remaps future substitutes to the same lesson and cancels moved lessons',async()=>{
 const {env,absent,free,onLeave}=await setup();
 env.raw.exec("UPDATE academic_terms SET end_date='2099-12-31' WHERE id=99");
 const today=new Date(Date.now()+7*3600e3).toISOString().slice(0,10);
 let d=new Date(today+'T12:00:00Z');d=new Date(d.getTime()+864e5);while(d.getUTCDay()!==2)d=new Date(d.getTime()+864e5);const date=d.toISOString().slice(0,10);
 for(const [entry,sub] of [[1,free],[2,onLeave]])assert.equal((await call(env,path+'assignments','POST',{date,teacher_id:absent,entry_id:entry,substitute_teacher_id:sub,leave_request_id:null,reason:'อบรม'},3)).status,200);
 // ร่างใหม่: คาบ 1 เหมือนเดิม, คาบ 2 ของครูที่ไม่อยู่ย้ายไปคาบ 3
 env.raw.exec(`INSERT INTO timetable_plans(id,academic_term_id,status,created_by) VALUES(100,99,'draft',1);
  INSERT INTO timetable_entries(plan_id,grade_level,classroom,weekday,period,subject,teacher_id)
  SELECT 100,grade_level,classroom,weekday,CASE WHEN id=2 THEN 3 ELSE period END,subject,teacher_id FROM timetable_entries WHERE plan_id=99;`);
 const res=await call(env,'/api/timetable/publish','POST',{term_id:99},1);assert.equal(res.status,200);
 assert.deepEqual((await res.json()).substitutes,{remapped:1,cancelled:1});
 const rows=env.raw.prepare('SELECT a.substitute_teacher_id s,e.plan_id p,e.period FROM substitute_assignments a JOIN timetable_entries e ON e.id=a.timetable_entry_id').all();
 assert.equal(rows.length,1);assert.equal(rows[0].s,free);assert.equal(rows[0].p,100);assert.equal(rows[0].period,1);
 const c=env.raw.prepare('SELECT substitute_teacher_id s,action FROM substitute_cancellations').all();
 assert.equal(c.length,1);assert.equal(c[0].s,onLeave);assert.equal(c[0].action,'cancelled');
 // คาบที่ถูกยกเลิก ระบบเสนอครูใหม่ในคาบที่ย้ายไป
 const cov=await (await call(env,path+'coverage?date='+date+'&teacher_id='+absent,'GET',undefined,3)).json();
 const moved=cov.lessons.find(l=>l.period===3);assert(moved&&!moved.assignment_id&&moved.proposed_teacher_id);
});

test('leave-days lists weekdays with pending/approved leave for the calendar dots',async()=>{
 const {env}=await setup();
 const res=await call(env,'/api/substitutes/leave-days?month=2026-10','GET',undefined,3);assert.equal(res.status,200);
 const {dates}=await res.json();assert.deepEqual(dates,['2026-10-05','2026-10-06','2026-10-07']);
 assert.equal((await call(env,'/api/substitutes/leave-days?month=2026-13','GET',undefined,3)).status,400);
 assert.equal((await call(env,'/api/substitutes/leave-days?month=2026-10','GET',undefined,2)).status,403);
});
test('day plan covers several absent teachers at once without double-booking substitutes, then saves in one batch',async()=>{
 const {env,absent,free}=await setup();
 const person=user=>env.raw.prepare('SELECT id FROM personnel_records WHERE user_id=?').get(user).id;
 for(const [id,name] of [[7,'ครูไปราชการ'],[8,'ครูว่างสอง']]){
  env.raw.prepare("INSERT INTO users(id,email,password_hash,password_salt,full_name,role) VALUES(?,?,'x','x',?,'teacher')").run(id,'test'+id,name);
  env.raw.prepare("INSERT INTO personnel_records(user_id,full_name,normalized_name,position) VALUES(?,?,?,'ครู')").run(id,name,'test-person-'+id);
 }
 const away=person(7),spare=person(8);
 env.raw.prepare("INSERT INTO timetable_entries(id,plan_id,grade_level,classroom,weekday,period,subject,teacher_id) VALUES(20,99,'ป.4','2',2,1,'วิทยาศาสตร์',?)").run(away);
 env.raw.prepare("INSERT INTO timetable_entries(id,plan_id,grade_level,classroom,weekday,period,subject,teacher_id) VALUES(21,99,'ป.1','1',3,1,'ศิลปะ',?)").run(spare);
 const extras=[{teacher_id:away,reason:'ไปราชการ'}];
 const res=await call(env,path+'day-plan','POST',{date:'2026-10-06',extras},3);assert.equal(res.status,200,await res.clone().text());
 const plan=await res.json(),lessons=plan.teachers.flatMap(t=>t.lessons.map(l=>({...l,teacher_id:t.teacher_id})));
 assert.deepEqual(plan.teachers.map(t=>t.teacher_id).sort(),[absent,away,person(5)].sort());
 assert.equal(lessons.length,3);assert(lessons.every(l=>l.proposed_teacher_id));assert.equal(plan.unfilled,0);
 const p1=lessons.filter(l=>l.period===1).map(l=>l.proposed_teacher_id);assert.equal(new Set(p1).size,2);assert(p1.includes(free)&&p1.includes(spare));
 assert(lessons.find(l=>l.proposed_teacher_id===spare).cross_band);
 assert.equal((await call(env,path+'day-plan','POST',{date:'2026-10-06',extras},2)).status,403);
 // เลือกครูซ้ำคาบเดียวกัน → ปฏิเสธทั้งชุด
 const clash=lessons.filter(l=>l.period===1).map(l=>({teacher_id:l.teacher_id,entry_id:l.entry_id,substitute_teacher_id:free}));
 assert.equal((await call(env,path+'day-plan/save','POST',{date:'2026-10-06',items:clash,extras},3)).status,409);
 assert.equal(env.raw.prepare('SELECT COUNT(*) n FROM substitute_assignments').get().n,0);
 // ครูไม่มีใบลาต้องมีเหตุ
 const items=lessons.map(l=>({teacher_id:l.teacher_id,entry_id:l.entry_id,substitute_teacher_id:l.proposed_teacher_id}));
 assert.equal((await call(env,path+'day-plan/save','POST',{date:'2026-10-06',items,extras:[{teacher_id:away,reason:''}]},3)).status,409);
 const ok=await call(env,path+'day-plan/save','POST',{date:'2026-10-06',items,extras},3);assert.equal(ok.status,200,await ok.clone().text());assert.equal((await ok.json()).saved,3);
 const saved=(await (await call(env,path+'assignments?date=2026-10-06','GET',undefined,3)).json()).assignments;
 assert.equal(saved.length,3);assert.equal(saved.find(a=>a.absent_teacher_id===away).absence_reason,'ไปราชการ');assert(saved.filter(a=>a.absent_teacher_id===absent).every(a=>a.leave_request_id===80));
 assert.equal((await call(env,path+'day-plan/save','POST',{date:'2026-10-06',items,extras},3)).status,409);
 const again=await (await call(env,path+'day-plan','POST',{date:'2026-10-06'},3)).json();
 assert(again.teachers.find(t=>t.teacher_id===away).lessons.every(l=>l.assignment_id));
});

test('special assignments override busy/leave/band conditions, retain the title, count each period, and notify teachers',async()=>{
 const {env,absent,free,onLeave}=await setup();
 let d=new Date(Date.now()+7*3600e3);while(d.getUTCDay()!==2)d=new Date(d.getTime()+864e5);const date=d.toISOString().slice(0,10);
 env.raw.exec("UPDATE academic_terms SET end_date='2099-12-31' WHERE id=99");
 env.raw.prepare('UPDATE leave_requests SET start_date=?,end_date=? WHERE id=81').run(date,date);
 // On-leave teacher is excluded ordinarily, but visible with a warning in special mode.
 const coverage=await (await call(env,path+`coverage?date=${date}&teacher_id=${absent}&mode=special`,'GET',undefined,3)).json();
 assert(coverage.lessons[0].available_teachers.some(t=>t.id===onLeave&&t.warning));
 const body={date,title:'เข้าร่วมกิจกรรมโรงเรียน',unavailable_ids:[onLeave],items:[1,2].map(entry_id=>({entry_id,teacher_id:absent,substitute_teacher_id:onLeave}))};
 assert.equal((await call(env,path+'special/save','POST',body,2)).status,403);
 for(const bad of [{title:''},{items:[{...body.items[0],substitute_teacher_id:absent}]},{unavailable_ids:[99999]},{items:[body.items[0],body.items[0]]}])assert([400,409].includes((await call(env,path+'special/save','POST',{...body,...bad},3)).status));
 assert.equal(env.raw.prepare('SELECT COUNT(*) n FROM substitute_assignments').get().n,0);
 const res=await call(env,path+'special/save','POST',body,3);assert.equal(res.status,200,await res.clone().text());assert.equal((await res.json()).saved,2);
 const rows=(await (await call(env,path+`assignments?date=${date}`,'GET',undefined,3)).json()).assignments;
 assert.equal(rows.length,2);assert(rows.every(r=>r.assignment_kind==='special'&&r.special_title===body.title&&r.leave_request_id===null));
 assert.deepEqual(JSON.parse(rows[0].unavailable_json),[onLeave]);
 const {substituteLoad}=await import('../src/lib/personnel-stats.js');const load=await substituteLoad(env,{date});assert.equal(load.people.find(p=>p.personnel_id===onLeave).month,2);
 const feed=await (await call(env,'/api/notifications','GET',undefined,5)).json();assert(feed.notifications.some(n=>n.message_key.startsWith('substitute:')));
 assert.equal((await call(env,path+'special/save','POST',body,3)).status,409);
 // A special assignment can also be changed to a teacher with their own teaching period.
 env.raw.prepare("INSERT INTO timetable_entries(id,plan_id,grade_level,classroom,weekday,period,subject,teacher_id) VALUES(20,99,'ป.1','1',2,1,'ไทย',?)").run(free);
 assert.equal((await call(env,path+'assignments/'+rows[0].id,'PATCH',{substitute_teacher_id:free},3)).status,200);
 const after=await (await call(env,path+`coverage?date=${date}&teacher_id=${absent}`,'GET',undefined,3)).json();assert(!after.lessons[0].available_teachers.some(t=>t.id===free));
 assert.equal((await call(env,path+'assignments/'+rows[0].id,'DELETE',undefined,3)).status,200);
 assert.equal(env.raw.prepare('SELECT COUNT(*) n FROM substitute_assignments').get().n,1);
});

test('special mode permits explicit same-period overlap and regular mode retains collision protection',async()=>{
 const {env,absent,free,onLeave}=await setup(),date='2026-10-06';
 env.raw.prepare("INSERT INTO timetable_entries(id,plan_id,grade_level,classroom,weekday,period,subject,teacher_id) VALUES(20,99,'ป.5','2',2,1,'ไทย',?)").run(onLeave);
 const base={date,title:'กรณีพิเศษ',unavailable_ids:[],items:[{entry_id:1,teacher_id:absent,substitute_teacher_id:free},{entry_id:20,teacher_id:onLeave,substitute_teacher_id:free}]};
 const res=await call(env,path+'special/save','POST',base,3);assert.equal(res.status,200,await res.clone().text());
 assert.equal(env.raw.prepare('SELECT COUNT(*) n FROM substitute_assignments WHERE period=1').get().n,2);
 assert.throws(()=>env.raw.prepare("UPDATE substitute_assignments SET assignment_kind='regular' WHERE timetable_entry_id=20").run(),/UNIQUE constraint/);
});

test('kindergarten without a timetable supports manual periods in leave, no-leave and special workflows',async()=>{
 const {env}=await setup();
 for(const id of [8,9]){
 env.raw.prepare("INSERT INTO users(id,email,password_hash,password_salt,full_name,role) VALUES(?,?,'x','x',?,'teacher')").run(id,`k${id}`,`ครูอนุบาล ${id}`);
 env.raw.prepare("INSERT INTO personnel_records(user_id,full_name,normalized_name,position) VALUES(?,?,?,'ครู')").run(id,`ครูอนุบาล ${id}`,`kindergarten-${id}`);
 env.raw.prepare('INSERT INTO personnel_accounts(user_id,personnel_id) SELECT ?,id FROM personnel_records WHERE user_id=?').run(id,id);
 }
 const person=id=>env.raw.prepare('SELECT id FROM personnel_records WHERE user_id=?').get(id).id,teacher=person(8),sub=person(9);
 env.raw.exec("INSERT INTO leave_requests(id,user_id,leave_type,start_date,end_date,status) VALUES(90,8,'sick','2026-10-06','2026-10-06','approved')");
 const original=env.raw.prepare("SELECT COUNT(*) n FROM timetable_entries WHERE plan_id=99").get().n;
 for(const [date,kind] of [['2026-10-06','leave'],['2026-10-13','other'],['2026-10-20','special']]){
 const body={date,teacher_id:teacher,grade_level:'อ.2',classroom:'1',periods:[1,2]};
 assert.equal((await call(env,path+'manual-lessons','POST',body,2)).status,403);
 const res=await call(env,path+'manual-lessons','POST',body,3);assert.equal(res.status,200,await res.clone().text());
 const cov=await (await call(env,path+`coverage?date=${date}&teacher_id=${teacher}${kind==='special'?'&mode=special':''}`,'GET',undefined,3)).json();
 assert.equal(cov.lessons.length,2);assert.equal(cov.time_slots.length,6);assert(cov.lessons[0].available_teachers.some(t=>t.id===sub));
 if(kind==='special')assert.equal((await call(env,path+'special/save','POST',{date,title:'กิจกรรมอนุบาล',unavailable_ids:[],items:cov.lessons.map(l=>({teacher_id:teacher,entry_id:l.id,substitute_teacher_id:sub}))},3)).status,200);
 else for(const lesson of cov.lessons){const saved=await call(env,path+'assignments','POST',{date,teacher_id:teacher,entry_id:lesson.id,substitute_teacher_id:sub,leave_request_id:kind==='leave'?90:null,reason:kind==='other'?'อบรม':null},3);assert.equal(saved.status,200,await saved.clone().text())}
 const assignments=(await (await call(env,path+`assignments?date=${date}`,'GET',undefined,3)).json()).assignments;
 assert.equal(assignments.length,2);assert(assignments.every(a=>a.grade_level==='อ.2'&&a.classroom==='1'&&a.subject==='กิจกรรมปฐมวัย'));
 assert.equal((await call(env,path+'manual-lessons','POST',body,3)).status,409);
 }
 assert.equal(env.raw.prepare('SELECT COUNT(*) n FROM substitute_assignments WHERE substitute_teacher_id=?').get(sub).n,6);
 assert.equal(env.raw.prepare('SELECT COUNT(*) n FROM timetable_entries WHERE plan_id=99').get().n,original);
 const empty=await (await call(env,path+`coverage?date=2026-10-27&teacher_id=${teacher}`,'GET',undefined,3)).json();assert.equal(empty.lessons.length,0);
});

test('assignment schema migration retains existing IDs, source leaves and the notification ID sequence',async()=>{
 const {env,absent,free}=await setup();
 const saved=await call(env,path+'assignments','POST',{date:'2026-10-06',teacher_id:absent,entry_id:1,substitute_teacher_id:free,leave_request_id:80},3);assert.equal(saved.status,200);
 const old=env.raw.prepare('SELECT * FROM substitute_assignments').get();
 env.raw.exec(`DROP TRIGGER substitute_regular_insert; DROP TRIGGER substitute_regular_update;
 CREATE TABLE legacy_assignments(id INTEGER PRIMARY KEY AUTOINCREMENT,absence_id INTEGER NOT NULL REFERENCES substitute_absences(id),timetable_entry_id INTEGER NOT NULL REFERENCES timetable_entries(id),substitute_teacher_id INTEGER NOT NULL REFERENCES personnel_records(id),weekday INTEGER NOT NULL,period INTEGER NOT NULL,absence_date TEXT NOT NULL,notes TEXT,created_by INTEGER NOT NULL REFERENCES users(id),created_at TEXT NOT NULL DEFAULT(datetime('now')),leave_request_id INTEGER REFERENCES leave_requests(id) ON DELETE SET NULL,UNIQUE(absence_id,timetable_entry_id),UNIQUE(absence_date,period,substitute_teacher_id));
 INSERT INTO legacy_assignments SELECT id,absence_id,timetable_entry_id,substitute_teacher_id,weekday,period,absence_date,notes,created_by,created_at,leave_request_id FROM substitute_assignments;
 DROP TABLE substitute_assignments; ALTER TABLE legacy_assignments RENAME TO substitute_assignments;
 UPDATE sqlite_sequence SET seq=500 WHERE name='substitute_assignments';DELETE FROM substitute_schema_migrations;`);
 env.DB={...env.DB};
 assert.equal((await call(env,path+'assignments?date=2026-10-06','GET',undefined,3)).status,200);
 const migrated=env.raw.prepare('SELECT * FROM substitute_assignments').get();assert.equal(migrated.id,old.id);assert.equal(migrated.leave_request_id,80);assert.equal(migrated.assignment_kind,'regular');
 const next=await call(env,path+'assignments','POST',{date:'2026-10-06',teacher_id:absent,entry_id:2,substitute_teacher_id:free,leave_request_id:80},3);assert.equal(next.status,200,await next.clone().text());assert.equal(env.raw.prepare('SELECT MAX(id) n FROM substitute_assignments').get().n,501);
});
