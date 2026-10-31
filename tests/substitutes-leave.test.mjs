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
 const sandbox=vm.createContext({document:{getElementById:node},SubstituteOrderExport:{director:()=> 'ผู้อำนวยการ'},apiRequest:async(url)=>{
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
 assert.deepEqual(teachers.map(t=>[t.id,t.lesson_count]),[[absent,2]]);
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
