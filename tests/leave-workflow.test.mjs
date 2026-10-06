import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture,call} from './notifications.test.mjs';
import {ensureLeaveData} from '../src/lib/leave-data.js';
import {dashboardActivitySummary} from '../src/lib/dashboard-summary.js';

const form={leave_type:'sick',reason:'มีไข้ ไปพบแพทย์',position:'ครู',request_date:'2026-10-06',start_date:'2026-10-06',end_date:'2026-10-06',leave_days:0.5,contact_address:'บ้านพักครู ที่อยู่ตัวอย่าง',contact_phone:'0000000000'};
async function setup(){
 const env=await fixture();
 env.raw.exec(`INSERT INTO users(id,email,password_hash,password_salt,full_name,role) VALUES
 (4,'director@test','x','x','ผู้อำนวยการตัวอย่าง','executive'),(5,'deputy@test','x','x','รองผู้บริหารตัวอย่าง','executive'),(6,'other@test','x','x','รองฝ่ายอื่น','executive');
 INSERT INTO staff_profiles(user_id,position) VALUES(4,'ผู้อำนวยการโรงเรียนบ้านป่าเด็ง'),(5,'รองผู้อำนวยการโรงเรียนบ้านป่าเด็ง'),(6,'รองผู้อำนวยการโรงเรียนบ้านป่าเด็ง');`);
 await ensureLeaveData(env);
 const head=env.raw.prepare('SELECT id FROM personnel_records WHERE user_id=3').get();
 await call(env,'/api/department-staff/personnel','POST',{personnel_id:head.id,is_head:true});
 const deputy=env.raw.prepare('SELECT id FROM personnel_records WHERE user_id=5').get().id;
 return {env,deputy};
}
const notice=async(env,user,key)=>(await (await call(env,'/api/notifications','GET',undefined,user)).json()).notifications.some(n=>n.message_key===key);
test('leave goes through personnel acknowledgement, saved records, explicit executive forwarding, deputy opinion and director decision',async()=>{
 const {env,deputy}=await setup();
 const created=await call(env,'/api/leave-requests','POST',form,2);assert.equal(created.status,201);const {id}=await created.json();const path='/api/leave-requests/'+id;
 assert(await notice(env,3,`leave:${id}:pending`));assert(!await notice(env,4,`leave:${id}:pending`));assert(!await notice(env,6,`leave:${id}:pending`));
 assert.equal((await call(env,path,'GET',undefined,6)).status,403);
 assert.equal((await call(env,path,'PATCH',{action:'acknowledge'},2)).status,403);
 assert.equal((await call(env,path,'PATCH',{action:'acknowledge'},1)).status,403);
 assert.equal((await call(env,path,'PATCH',{action:'forward',deputy_personnel_id:deputy},3)).status,409);
 assert.equal((await call(env,path,'PATCH',{action:'acknowledge',note:'ตรวจสอบใบลาแล้ว'},3)).status,200);
 assert.equal((await call(env,path,'PATCH',{action:'acknowledge'},3)).status,409);
 assert(!await notice(env,3,`leave:${id}:pending`));
 assert.equal((await call(env,path,'DELETE',undefined,2)).status,409);
 assert.equal((await call(env,path,'PATCH',{action:'record',note:'บันทึกในทะเบียนแล้ว'},3)).status,200);
 assert.equal((await call(env,path,'PATCH',{action:'forward',deputy_personnel_id:9999},3)).status,400);
 assert.equal((await call(env,path,'PATCH',{action:'forward',deputy_personnel_id:deputy},3)).status,200);
 assert.equal((await call(env,path,'PATCH',{action:'forward',deputy_personnel_id:deputy},3)).status,409);
 assert(await notice(env,4,`leave:${id}:forwarded`));assert(await notice(env,5,`leave:${id}:forwarded`));assert(!await notice(env,6,`leave:${id}:forwarded`));
 assert.equal((await call(env,path,'PATCH',{action:'decide',status:'approved'},4)).status,409);
 assert.equal((await call(env,path,'PATCH',{action:'decide',status:'approved'},5)).status,403);
 await call(env,'/api/notifications/read','POST',{all:true},4);
 assert.equal((await call(env,path,'PATCH',{action:'review',note:'เห็นควรอนุญาต'},5)).status,200);
 assert(await notice(env,4,`leave:${id}:reviewed`));assert(!await notice(env,5,`leave:${id}:reviewed`));
 assert.equal((await call(env,path,'PATCH',{action:'decide',status:'approved',note:'อนุญาตตามเสนอ'},4)).status,200);
 assert.equal((await call(env,path,'PATCH',{action:'decide',status:'rejected'},4)).status,409);
 const detail=await (await call(env,path,'GET',undefined,3)).json();
 assert.equal(detail.leave_request.status,'approved');assert.equal(detail.leave_request.personnel_note,'บันทึกในทะเบียนแล้ว');assert.equal(detail.leave_request.deputy_name,'รองผู้บริหารตัวอย่าง');assert.equal(detail.leave_request.decision_name,'ผู้อำนวยการตัวอย่าง');
 assert.deepEqual(detail.events.map(e=>e.action),['submitted','acknowledged','recorded','forwarded','reviewed','approved']);
 assert.equal(env.raw.prepare("SELECT COUNT(*) n FROM audit_logs WHERE resource='leave_request' AND resource_id=?").get(String(id)).n,6);
 assert(await notice(env,2,`leave:${id}:approved`));
 const overview=await dashboardActivitySummary(env);assert.equal(overview.leave_summary.approved,1);assert.equal(overview.leave_summary.approved_days,0.5);assert.equal(overview.leave_summary.pending,0);
 const history=await (await call(env,'/api/leave-requests','GET',undefined,3)).json();assert(history.leave_requests.some(r=>r.id===id));
 // Permissions follow current accounts, not the token or a stale page.
 env.raw.exec("UPDATE users SET role='teacher' WHERE id=5");assert.equal((await call(env,path,'GET',undefined,5)).status,403);
});
test('concurrent forwarding creates one recorded transition and only the intended recipients',async()=>{
 const {env,deputy}=await setup();const {id}=await (await call(env,'/api/leave-requests','POST',form,2)).json(),path='/api/leave-requests/'+id;
 await call(env,path,'PATCH',{action:'acknowledge'},3);
 const responses=await Promise.all([call(env,path,'PATCH',{action:'forward',deputy_personnel_id:deputy},3),call(env,path,'PATCH',{action:'forward',deputy_personnel_id:deputy},3)]);
 assert.deepEqual(responses.map(r=>r.status).sort(),[200,409]);
 assert.equal(env.raw.prepare("SELECT COUNT(*) n FROM leave_events WHERE leave_id=? AND action='forwarded'").get(id).n,1);
 assert.equal(env.raw.prepare('SELECT COUNT(*) n FROM leave_reviewers WHERE leave_id=?').get(id).n,2);
});
test('all leave types require reasons and contact details, real dates and valid half-day units; drafts can be cancelled',async()=>{
 const {env}=await setup();
 for(const leave_type of ['sick','personal','maternity','other'])assert.equal((await call(env,'/api/leave-requests','POST',{...form,leave_type,reason:' '},2)).status,400);
 for(const patch of [{start_date:'2026-02-30'},{end_date:'2026-10-05'},{leave_days:2},{leave_days:0.3},{contact_phone:''},{position:''},{contact_address:''}])assert.equal((await call(env,'/api/leave-requests','POST',{...form,...patch},2)).status,400);
 const {id}=await (await call(env,'/api/leave-requests','POST',form,2)).json();assert.equal((await call(env,'/api/leave-requests/'+id,'DELETE',undefined,2)).status,200);
 assert.equal(env.raw.prepare('SELECT COUNT(*) n FROM leave_events WHERE leave_id=?').get(id).n,0);
});
test('form statistics and previous leave include canonical linked accounts, approved records only and the fiscal period',async()=>{
 const {env}=await setup();
 const p=env.raw.prepare('SELECT id FROM personnel_records WHERE user_id=2').get();
 env.raw.exec("INSERT INTO users(id,email,password_hash,password_salt,full_name,role) VALUES(7,'linked@test','x','x','บัญชีเดิมครู ก','teacher')");env.raw.prepare('INSERT INTO personnel_accounts(user_id,personnel_id) VALUES(7,?)').run(p.id);
 env.raw.exec(`INSERT INTO leave_requests(user_id,leave_type,start_date,end_date,leave_days,status) VALUES
 (7,'sick','2026-10-02','2026-10-02',0.5,'approved'),(2,'personal','2026-10-03','2026-10-03',1,'approved'),
 (2,'sick','2026-09-29','2026-09-29',1,'approved'),(2,'sick','2026-10-04','2026-10-04',1,'rejected');`);
 const {id}=await (await call(env,'/api/leave-requests','POST',form,2)).json();
 const {leave_request:r}=await (await call(env,'/api/leave-requests/'+id,'GET',undefined,2)).json();
 assert.equal(r.last_leave.leave_type,'personal');assert.equal(r.last_leave.start_date,'2026-10-03');
 assert.deepEqual(r.stats[0],{type:'sick',previous_count:1,previous_days:0.5,current_days:0.5,total_count:2,total_days:1});
 assert.equal(r.stats[1].total_days,1);assert.equal(r.statistics_period.from,'2026-10-01');
});
test('runtime migration preserves legacy leave records and permits the new head workflow',async()=>{
 const env=await fixture();env.raw.exec('DROP TABLE leave_requests; CREATE TABLE leave_requests(id INTEGER PRIMARY KEY,user_id INTEGER,leave_type TEXT,reason TEXT,start_date TEXT,end_date TEXT,status TEXT DEFAULT \'pending\',approved_by INTEGER,approved_at TEXT,created_at TEXT DEFAULT CURRENT_TIMESTAMP); INSERT INTO leave_requests(id,user_id,leave_type,start_date,end_date) VALUES(99,2,\'sick\',\'2026-10-01\',\'2026-10-01\');');
 await ensureLeaveData(env);const row=env.raw.prepare('SELECT * FROM leave_requests WHERE id=99').get();assert.equal(row.workflow_stage,'submitted');assert.equal(row.start_date,'2026-10-01');
 const {leave_request:r}=await (await call(env,'/api/leave-requests/99','GET',undefined,2)).json();assert.equal(r.leave_days,1);
});
