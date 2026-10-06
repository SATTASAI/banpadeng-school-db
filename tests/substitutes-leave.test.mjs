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
 assert.equal((await call(env,path+'leaves?date=2026-10-06','GET',undefined,1)).status,403);
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
 assert.equal((await call(env,path+'assignments','POST',data,3)).status,200);
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
