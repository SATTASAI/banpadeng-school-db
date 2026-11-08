import {seedLeaveCalendar} from './leave-calendar.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture,call} from './notifications.test.mjs';
import {ensureLeaveData} from '../src/lib/leave-data.js';
import {dashboardActivitySummary} from '../src/lib/dashboard-summary.js';
import {leaveStatistics} from '../src/lib/personnel-stats.js';

const form={substitute_teacher:'ครูผู้รับมอบหมาย',leave_type:'sick',reason:'มีไข้ ไปพบแพทย์',position:'ครู',request_date:'2026-10-06',start_date:'2026-10-06',end_date:'2026-10-06',leave_days:0.5,contact_address:'บ้านพักครู ที่อยู่ตัวอย่าง',contact_phone:'0000000000'};
async function setup(){
 const env=await fixture();
 seedLeaveCalendar(env);
 env.raw.exec(`INSERT INTO users(id,email,password_hash,password_salt,full_name,role) VALUES
 (4,'director@test','x','x','ผู้อำนวยการตัวอย่าง','executive'),(5,'deputy@test','x','x','รองผู้บริหารตัวอย่าง','executive'),(6,'other@test','x','x','รองฝ่ายอื่น','executive');
 INSERT INTO staff_profiles(user_id,position) VALUES(4,'ผู้อำนวยการโรงเรียนบ้านป่าเด็ง'),(5,'รองผู้อำนวยการโรงเรียนบ้านป่าเด็ง'),(6,'รองผู้อำนวยการโรงเรียนบ้านป่าเด็ง');`);
 await ensureLeaveData(env);
 const head=env.raw.prepare('SELECT id FROM personnel_records WHERE user_id=3').get();
 await call(env,'/api/department-staff/personnel','POST',{personnel_id:head.id,is_head:true});
 const deputy=env.raw.prepare('SELECT id FROM personnel_records WHERE user_id=5').get().id;
 env.raw.prepare('INSERT INTO leave_settings(id,deputy_personnel_id) VALUES(1,?)').run(deputy);
 return {env,deputy};
}
const notice=async(env,user,key)=>(await (await call(env,'/api/notifications','GET',undefined,user)).json()).notifications.some(n=>n.message_key===key);

test('director cannot approve before the personnel head acknowledges; combined approval is retired',async()=>{
 for(const stage of ['submitted','acknowledged']){
  const {env}=await setup();
  const {id}=await (await call(env,'/api/leave-requests','POST',form,2)).json(),path='/api/leave-requests/'+id;
  if(stage==='acknowledged'){
   env.raw.prepare("UPDATE leave_requests SET workflow_stage='acknowledged',acknowledged_by=3,acknowledged_at='2026-11-02T03:45:21Z' WHERE id=?").run(id);
   env.raw.prepare("INSERT INTO leave_events(leave_id,actor_id,action) VALUES(?,3,'acknowledged')").run(id);
  }
  const list=await (await call(env,'/api/leave-requests','GET',undefined,4)).json(),r=list.leave_requests.find(x=>x.id===id);
  assert.equal(r.can_acknowledge_approve,false);assert.equal(r.can_decide,false);
  assert.equal((await call(env,path,'PATCH',{action:'acknowledge_approve'},4)).status,409);
  assert.equal((await call(env,path,'PATCH',{action:'decide',status:'approved'},4)).status,409);
  assert.equal(env.raw.prepare('SELECT status FROM leave_requests WHERE id=?').get(id).status,'pending');
  assert.equal((await call(env,path,'PATCH',{action:'acknowledge'},3)).status,200);
  assert.equal((await call(env,path,'PATCH',{action:'decide',status:'approved',note:'อนุญาต'},4)).status,200);
  const events=env.raw.prepare('SELECT action FROM leave_events WHERE leave_id=? ORDER BY id').all(id).map(r=>r.action);
  assert.deepEqual(events,['submitted','acknowledged','forwarded','approved']);
  const summary=await dashboardActivitySummary(env);assert.equal(summary.leave_summary.approved,1);assert.equal(summary.leave_summary.approved_days,0.5);
  assert(await notice(env,2,'leave:'+id+':approved'));
 }
});

test('director own leave goes to a delegated deputy, who alone decides it',async()=>{
 const {env,deputy}=await setup();
 const {id}=await (await call(env,'/api/leave-requests','POST',form,4)).json(),path='/api/leave-requests/'+id;
 assert.equal((await call(env,path,'PATCH',{action:'acknowledge'},3)).status,409);
 assert.equal(env.raw.prepare('SELECT workflow_stage FROM leave_requests WHERE id=?').get(id).workflow_stage,'submitted');
 await call(env,'/api/leave-delegations','PATCH',{personnel_id:deputy,can_approve:true},4);
 assert.equal((await call(env,path,'PATCH',{action:'acknowledge'},3)).status,200);
 assert.deepEqual(env.raw.prepare('SELECT user_id,kind FROM leave_reviewers WHERE leave_id=? ORDER BY user_id').all(id).map(r=>({...r})),[{user_id:5,kind:'deputy'}]);
 assert.equal(env.raw.prepare('SELECT director_name FROM leave_requests WHERE id=?').get(id).director_name,'รองผู้บริหารตัวอย่าง');
 assert.equal((await call(env,path,'PATCH',{action:'decide',status:'approved'},4)).status,403);
 assert.equal((await call(env,path,'PATCH',{action:'decide',status:'approved'},6)).status,403);
 const list=await (await call(env,'/api/leave-requests','GET',undefined,5)).json();assert.equal(list.leave_requests.find(r=>r.id===id).can_decide,true);
 assert.equal((await call(env,path,'PATCH',{action:'decide',status:'approved'},5)).status,200);
 const row=env.raw.prepare('SELECT * FROM leave_requests WHERE id=?').get(id);
 assert.equal(row.status,'approved');assert.equal(row.approved_by,5);assert.equal(row.decision_name,'รองผู้บริหารตัวอย่าง');assert.equal(row.deputy_signature,null);
});

test('personnel head cannot acknowledge own leave; superadmin acknowledges it instead',async()=>{
 const {env}=await setup();
 const {id}=await (await call(env,'/api/leave-requests','POST',form,3)).json(),path='/api/leave-requests/'+id;
 const mine=await (await call(env,'/api/leave-requests','GET',undefined,3)).json();assert.equal(mine.leave_requests.find(r=>r.id===id).can_acknowledge,false);
 assert.equal((await call(env,path,'PATCH',{action:'acknowledge'},3)).status,403);
 const admin=await (await call(env,'/api/leave-requests','GET',undefined,1)).json();assert.equal(admin.leave_requests.find(r=>r.id===id).can_acknowledge,true);
 const teacherLeave=await (await call(env,'/api/leave-requests','POST',{...form,start_date:'2026-10-07',end_date:'2026-10-07'},2)).json();
 assert.equal((await call(env,'/api/leave-requests/'+teacherLeave.id,'PATCH',{action:'acknowledge'},1)).status,403);
 assert.equal((await call(env,path,'PATCH',{action:'acknowledge'},1)).status,200);
 assert.equal(env.raw.prepare('SELECT workflow_stage FROM leave_requests WHERE id=?').get(id).workflow_stage,'forwarded');
});

test('quota is re-checked at approval; pending leaves do not consume a turn',async()=>{
 const {env}=await setup();
 await call(env,'/api/leave-settings','PATCH',{limits:[{leave_type:'general',max_count:1},{leave_type:'lenient',max_count:2}]});
 const personal={...form,leave_type:'personal'};
 const first=await (await call(env,'/api/leave-requests','POST',personal,2)).json();
 const second=await call(env,'/api/leave-requests','POST',{...personal,start_date:'2026-10-07',end_date:'2026-10-07'},2);assert.equal(second.status,201);
 const {id:secondId}=await second.json();
 for(const id of [first.id,secondId])assert.equal((await call(env,'/api/leave-requests/'+id,'PATCH',{action:'acknowledge'},3)).status,200);
 assert.equal((await call(env,'/api/leave-requests/'+first.id,'PATCH',{action:'decide',status:'approved'},4)).status,200);
 const denied=await call(env,'/api/leave-requests/'+secondId,'PATCH',{action:'decide',status:'approved'},4);assert.equal(denied.status,409);
 assert.match((await denied.json()).error,/ครบ 1 ครั้ง/);
 assert.equal((await call(env,'/api/leave-requests/'+secondId,'PATCH',{action:'decide',status:'rejected'},4)).status,200);
 // Sick leave is never blocked by the quota.
 const sick=await (await call(env,'/api/leave-requests','POST',{...form,start_date:'2026-10-08',end_date:'2026-10-08'},2)).json();
 await call(env,'/api/leave-requests/'+sick.id,'PATCH',{action:'acknowledge'},3);
 assert.equal((await call(env,'/api/leave-requests/'+sick.id,'PATCH',{action:'decide',status:'approved'},4)).status,200);
});

test('personnel head and superadmin edit or delete any leave with a reason; not their own; teachers cannot',async()=>{
 const {env}=await setup();
 const {id}=await (await call(env,'/api/leave-requests','POST',form,2)).json(),path='/api/leave-requests/'+id;
 await call(env,path,'PATCH',{action:'acknowledge'},3);await call(env,path,'PATCH',{action:'decide',status:'approved'},4);
 const edit={action:'edit',note:'ครูกลับมาก่อนกำหนด',leave_type:'personal',start_date:'2026-10-06',end_date:'2026-10-07',leave_days:1.5};
 assert.equal((await call(env,path,'PATCH',edit,2)).status,403);
 assert.equal((await call(env,path,'PATCH',{...edit,note:''},3)).status,400);
 assert.equal((await call(env,path,'PATCH',{...edit,leave_days:3},3)).status,400);
 assert.equal((await call(env,path,'PATCH',edit,3)).status,200);
 const row=env.raw.prepare('SELECT * FROM leave_requests WHERE id=?').get(id);
 assert.equal(row.status,'approved');assert.equal(row.leave_type,'personal');assert.equal(row.end_date,'2026-10-07');assert.equal(row.leave_days,1.5);
 assert(env.raw.prepare("SELECT 1 FROM leave_events WHERE leave_id=? AND action='edited'").get(id));
 assert.equal((await dashboardActivitySummary(env)).leave_summary.approved_days,1.5);
 const detail=await (await call(env,path,'GET',undefined,3)).json();assert.equal(detail.leave_request.can_edit,true);
 assert.equal((await (await call(env,path,'GET',undefined,2)).json()).leave_request.can_edit,false);
 const headLeave=await (await call(env,'/api/leave-requests','POST',{...form,start_date:'2026-10-08',end_date:'2026-10-08'},3)).json();
 assert.equal((await call(env,'/api/leave-requests/'+headLeave.id,'PATCH',{...edit,start_date:'2026-10-08',end_date:'2026-10-08',leave_days:1},3)).status,403);
 assert.equal((await call(env,'/api/leave-requests/'+headLeave.id,'PATCH',{...edit,start_date:'2026-10-08',end_date:'2026-10-08',leave_days:1},1)).status,200);
 assert.equal((await call(env,path,'DELETE',undefined,2)).status,409);
 assert.equal((await call(env,path,'DELETE',{},3)).status,400);
 assert.equal((await call(env,path,'DELETE',{note:'บันทึกซ้ำ'},3)).status,200);
 assert.equal(env.raw.prepare('SELECT COUNT(*) n FROM leave_requests WHERE id=?').get(id).n,0);
 const audit=JSON.parse(env.raw.prepare("SELECT details FROM audit_logs WHERE resource='leave_request' AND action='delete' AND resource_id=?").get(id).details);
 assert.equal(audit.reason,'บันทึกซ้ำ');assert.equal(audit.snapshot.status,'approved');assert(!('teacher_signature' in audit.snapshot));
});

test('maternity leave counts calendar days including weekends; my leave totals show only my own leave',async()=>{
 const {env}=await setup();
 const maternity={...form,leave_type:'maternity',start_date:'2026-11-06',end_date:'2026-11-09'};
 assert.equal((await (await call(env,'/api/leave-working-days?start=2026-11-06&end=2026-11-09&type=maternity','GET',undefined,2)).json()).working_days,4);
 assert.equal((await call(env,'/api/leave-requests','POST',{...maternity,leave_type:'sick',leave_days:4},2)).status,400);
 const created=await call(env,'/api/leave-requests','POST',{...maternity,leave_days:undefined},2);assert.equal(created.status,201);
 const {id}=await created.json();assert.equal(env.raw.prepare('SELECT leave_days FROM leave_requests WHERE id=?').get(id).leave_days,4);
 await call(env,'/api/leave-requests/'+id,'PATCH',{action:'acknowledge'},3);await call(env,'/api/leave-requests/'+id,'PATCH',{action:'decide',status:'approved'},4);
 const teacher=await (await call(env,'/api/leave-requests','GET',undefined,2)).json();assert.equal(teacher.fiscal_statistics.real.days,4);
 for(const uid of [1,3,4]){const data=await (await call(env,'/api/leave-requests','GET',undefined,uid)).json();assert.equal(data.fiscal_statistics.real.times,0);}
});

test('admin and current executives read every existing leave stage and legacy outcome without changing approval permissions or data',async()=>{
 const {env}=await setup();
 env.raw.exec(`INSERT INTO users(id,email,password_hash,password_salt,full_name,role) VALUES(7,'outsider@test','x','x','ครูอื่น','teacher');
  INSERT INTO leave_requests(id,user_id,leave_type,start_date,end_date,status,workflow_stage) VALUES
  (101,2,'sick','2025-10-01','2025-10-01','approved','submitted'),
  (102,2,'personal','2025-10-02','2025-10-02','rejected','submitted'),
  (103,2,'sick','2026-10-01','2026-10-01','pending','submitted'),
  (104,2,'sick','2026-10-02','2026-10-02','pending','acknowledged'),
  (105,2,'sick','2026-10-03','2026-10-03','pending','forwarded'),
  (106,2,'sick','2026-10-04','2026-10-04','approved','completed');`);
 const before=env.raw.prepare('SELECT * FROM leave_requests ORDER BY id').all();
 for(const uid of [1,4,5,6]){
  const list=await (await call(env,'/api/leave-requests','GET',undefined,uid)).json();
  assert.equal(list.can_view_all_leave,true);assert.equal(list.can_approve_leave,uid===4);assert.equal(list.can_manage_delegations,uid===4);
  assert.deepEqual(list.leave_requests.map(r=>r.id).sort(),[101,102,103,104,105,106]);
  for(const row of list.leave_requests){
   assert.equal(row.can_decide,uid===4&&row.id===105);
   assert.equal((await call(env,'/api/leave-requests/'+row.id,'GET',undefined,uid)).status,200);
  }
 }
 for(const uid of [1,5,6]){
  assert.equal((await call(env,'/api/leave-requests/105','PATCH',{status:'approved'},uid)).status,403);
  assert.equal((await call(env,'/api/leave-delegations','GET',undefined,uid)).status,403);
 }
 const outsider=await (await call(env,'/api/leave-requests','GET',undefined,7)).json();assert.equal(outsider.can_view_all_leave,false);assert.equal(outsider.leave_requests.length,0);
 assert.equal((await call(env,'/api/leave-requests/101','GET',undefined,7)).status,403);
 assert.deepEqual(env.raw.prepare('SELECT * FROM leave_requests ORDER BY id').all(),before);
 assert.equal(env.raw.prepare('SELECT COUNT(*) n FROM leave_events').get().n,0);
});

test('only the current director grants individual deputy approval; revoke applies to existing requests immediately',async()=>{
 const {env,deputy}=await setup(),endpoint='/api/leave-delegations';
 const {id}=await (await call(env,'/api/leave-requests','POST',form,2)).json(),path='/api/leave-requests/'+id;
 await call(env,path,'PATCH',{action:'acknowledge'},3);
 for(const uid of [1,2,3,5,6]){
  assert.equal((await call(env,endpoint,'GET',undefined,uid)).status,403);
  assert.equal((await call(env,endpoint,'PATCH',{personnel_id:deputy,can_approve:true},uid)).status,403);
 }
 // All current deputies can read forwarded requests, including deputies not assigned the LINE notice.
 assert.equal((await call(env,path,'GET',undefined,6)).status,200);
 const list=async uid=>(await (await call(env,'/api/leave-requests','GET',undefined,uid)).json());
 assert.equal((await list(5)).leave_requests.find(r=>r.id===id).can_decide,false);
 assert.equal((await call(env,path,'PATCH',{status:'approved'},5)).status,403);
 for(const body of [{personnel_id:deputy,can_approve:'true'},{personnel_id:String(deputy),can_approve:true},{personnel_id:9999,can_approve:true}])assert.equal((await call(env,endpoint,'PATCH',body,4)).status,400);
 assert.equal((await call(env,endpoint,'PATCH',{personnel_id:deputy,can_approve:true},4)).status,200);
 let permissions=await (await call(env,endpoint,'GET',undefined,4)).json();
 assert.equal(permissions.deputies.find(p=>p.id===deputy).can_approve,true);
 assert.equal((await list(5)).leave_requests.find(r=>r.id===id).can_decide,true);
 assert.equal((await list(6)).leave_requests.find(r=>r.id===id).can_decide,false);
 assert.equal((await call(env,endpoint,'PATCH',{personnel_id:deputy,can_approve:false},4)).status,200);
 assert.equal((await list(5)).leave_requests.find(r=>r.id===id).can_decide,false);
 assert.equal((await call(env,path,'PATCH',{status:'approved'},5)).status,403);
 await call(env,endpoint,'PATCH',{personnel_id:deputy,can_approve:true},4);
 assert.equal((await call(env,path,'PATCH',{status:'approved'},5)).status,200);
 const result=env.raw.prepare('SELECT * FROM leave_requests WHERE id=?').get(id);
 assert.equal(result.approved_by,5);assert.equal(result.decision_name,'รองผู้บริหารตัวอย่าง');
 assert.equal((await call(env,path,'PATCH',{status:'rejected'},4)).status,409);
 assert.equal(env.raw.prepare("SELECT COUNT(*) n FROM audit_logs WHERE resource='leave_approval_delegation'").get().n,3);
 assert.equal((await call(env,path,'GET',undefined,6)).status,200);
});

test('revocation between permission read and decision update prevents the decision and its history',async()=>{
 const {env,deputy}=await setup();
 await call(env,'/api/leave-delegations','PATCH',{personnel_id:deputy,can_approve:true},4);
 const {id}=await (await call(env,'/api/leave-requests','POST',form,2)).json(),path='/api/leave-requests/'+id;
 await call(env,path,'PATCH',{action:'acknowledge'},3);
 const batch=env.DB.batch.bind(env.DB);
 env.DB.batch=statements=>{env.raw.prepare('DELETE FROM leave_approval_delegations WHERE personnel_id=?').run(deputy);return batch(statements);};
 assert.equal((await call(env,path,'PATCH',{status:'approved'},5)).status,409);
 assert.equal(env.raw.prepare('SELECT status FROM leave_requests WHERE id=?').get(id).status,'pending');
 assert.equal(env.raw.prepare("SELECT COUNT(*) n FROM leave_events WHERE leave_id=? AND action='approved'").get(id).n,0);
});

test('delegation cannot approve a deputy own or linked leave, or survive losing executive role or current position',async()=>{
 const {env,deputy}=await setup();
 await call(env,'/api/leave-delegations','PATCH',{personnel_id:deputy,can_approve:true},4);
 const {id}=await (await call(env,'/api/leave-requests','POST',form,2)).json(),path='/api/leave-requests/'+id;
 await call(env,path,'PATCH',{action:'acknowledge'},3);
 env.raw.prepare('UPDATE personnel_accounts SET personnel_id=? WHERE user_id=2').run(deputy);
 assert.equal((await call(env,path,'PATCH',{status:'approved'},5)).status,403);
 const list=await (await call(env,'/api/leave-requests','GET',undefined,5)).json();assert.equal(list.leave_requests.find(r=>r.id===id).can_decide,false);
 env.raw.prepare('UPDATE leave_requests SET user_id=5 WHERE id=?').run(id);
 assert.equal((await call(env,path,'PATCH',{status:'approved'},5)).status,403);
 env.raw.exec("UPDATE users SET role='teacher' WHERE id=5");
 assert.equal((await call(env,path,'PATCH',{status:'approved'},5)).status,403);
 env.raw.exec("UPDATE users SET role='executive' WHERE id=5");
 env.raw.prepare("UPDATE personnel_records SET position='ครู' WHERE id=?").run(deputy);
 assert.equal((await call(env,path,'PATCH',{status:'approved'},5)).status,403);
 env.raw.exec("UPDATE personnel_records SET position='ครู' WHERE id=(SELECT personnel_id FROM personnel_accounts WHERE user_id=4)");
 assert.equal((await call(env,'/api/leave-delegations','PATCH',{personnel_id:deputy,can_approve:true},4)).status,403);
});
test('head acknowledgement forwards once to director and responsible deputy; only director decides, then statistics update',async()=>{
 const {env,deputy}=await setup();
 const created=await call(env,'/api/leave-requests','POST',form,2);assert.equal(created.status,201);
 const {id}=await created.json(),path='/api/leave-requests/'+id;
 assert(await notice(env,3,'leave:'+id+':pending'));assert(!await notice(env,5,'leave:'+id+':pending'));assert(!await notice(env,4,'leave:'+id+':pending'));
 assert.equal((await call(env,path,'GET',undefined,5)).status,200);
 for(const uid of [1,2,4,5,6])assert.equal((await call(env,path,'PATCH',{action:'acknowledge'},uid)).status,403);
 assert.equal((await call(env,path,'PATCH',{action:'decide',status:'approved'},4)).status,409);
 assert.equal((await call(env,path,'PATCH',{action:'acknowledge',note:'ตรวจสอบแล้ว'},3)).status,200);
 let row=env.raw.prepare('SELECT * FROM leave_requests WHERE id=?').get(id);
 assert.equal(row.workflow_stage,'forwarded');assert.equal(row.status,'pending');assert.equal(row.deputy_personnel_id,deputy);
 assert.equal(row.acknowledged_by,3);assert(row.acknowledged_at);assert.equal(row.personnel_note,'ตรวจสอบแล้ว');assert.equal(row.reviewer_at,null);
 assert(!await notice(env,3,'leave:'+id+':pending'));assert(await notice(env,4,'leave:'+id+':forwarded'));assert(await notice(env,5,'leave:'+id+':forwarded'));assert(!await notice(env,6,'leave:'+id+':forwarded'));
 const delivery=await (await call(env,path+'/delivery','GET',undefined,3)).json();
 assert.deepEqual(delivery.recipients.map(r=>r.kind).sort(),['deputy','director']);assert(delivery.recipients.every(r=>r.feed_has_notice));
 const summaryBefore=await dashboardActivitySummary(env);assert.equal(summaryBefore.leave_summary.approved,0);
 const deputyList=await (await call(env,'/api/leave-requests','GET',undefined,5)).json();assert.equal(deputyList.leave_requests.find(r=>r.id===id).can_review,false);assert.equal(deputyList.leave_requests.find(r=>r.id===id).can_decide,false);
 assert.equal((await call(env,path,'GET',undefined,5)).status,200);
 assert.equal((await call(env,path,'PATCH',{action:'acknowledge'},3)).status,409);
 assert.equal((await call(env,path,'DELETE',undefined,2)).status,409);
 for(const uid of [1,2,3,5,6])assert.equal((await call(env,path,'PATCH',{action:'decide',status:'approved'},uid)).status,403);
 assert.equal((await call(env,path,'PATCH',{action:'review',note:'ความเห็น'},5)).status,403);
 assert.equal((await call(env,path,'PATCH',{action:'decide',status:'approved',note:'อนุมัติ'},4)).status,200);
 assert.equal((await call(env,path,'PATCH',{action:'decide',status:'approved'},4)).status,409);
 const detail=await (await call(env,path,'GET',undefined,2)).json();
 assert.deepEqual(detail.events.map(e=>e.action),['submitted','acknowledged','forwarded','approved']);
 assert.equal(detail.leave_request.deputy_name,'รองผู้บริหารตัวอย่าง');assert.equal(detail.leave_request.decision_name,'ผู้อำนวยการตัวอย่าง');
 const summary=await dashboardActivitySummary(env);assert.equal(summary.leave_summary.approved,1);assert.equal(summary.leave_summary.approved_days,0.5);assert.equal(summary.leave_summary.pending,0);
 assert(await notice(env,2,'leave:'+id+':approved'));
 env.raw.exec("UPDATE users SET role='teacher' WHERE id=5");assert.equal((await call(env,path,'GET',undefined,5)).status,403);
});

test('concurrent acknowledgements create exactly one transition with one set of recipients',async()=>{
 const {env}=await setup();const {id}=await (await call(env,'/api/leave-requests','POST',form,2)).json();
 const responses=await Promise.all([call(env,'/api/leave-requests/'+id,'PATCH',{action:'acknowledge'},3),call(env,'/api/leave-requests/'+id,'PATCH',{action:'acknowledge'},3)]);
 assert.deepEqual(responses.map(r=>r.status).sort(),[200,409]);
 for(const action of ['acknowledged','forwarded'])assert.equal(env.raw.prepare('SELECT COUNT(*) n FROM leave_events WHERE leave_id=? AND action=?').get(id,action).n,1);
 assert.equal(env.raw.prepare('SELECT COUNT(*) n FROM leave_reviewers WHERE leave_id=?').get(id).n,2);
});

test('missing recipients leave the request untouched; saved personnel deputy is resolved when head acknowledges',async()=>{
 const {env,deputy}=await setup();env.raw.exec('DELETE FROM leave_settings');
 const {id}=await (await call(env,'/api/leave-requests','POST',form,2)).json(),path='/api/leave-requests/'+id;
 assert.equal((await call(env,path,'PATCH',{action:'acknowledge'},3)).status,409);
 assert.equal(env.raw.prepare('SELECT workflow_stage FROM leave_requests WHERE id=?').get(id).workflow_stage,'submitted');
 assert.equal(env.raw.prepare('SELECT COUNT(*) n FROM leave_reviewers').get().n,0);
 assert.equal((await call(env,'/api/leave-settings','PATCH',{deputy_personnel_id:deputy},2)).status,403);
 assert.equal((await call(env,'/api/leave-settings','PATCH',{deputy_personnel_id:deputy},3)).status,200);
 env.raw.exec("UPDATE users SET status='disabled' WHERE id=4");
 assert.equal((await call(env,path,'PATCH',{action:'acknowledge'},3)).status,409);
 env.raw.exec("UPDATE users SET status='active' WHERE id=4");
 assert.equal((await call(env,path,'PATCH',{action:'acknowledge'},3)).status,200);
});

test('legacy acknowledged requests can be forwarded with acknowledgement; already forwarded requests need no deputy review',async()=>{
 const {env}=await setup();const {id}=await (await call(env,'/api/leave-requests','POST',form,2)).json(),path='/api/leave-requests/'+id;
 env.raw.prepare("UPDATE leave_requests SET workflow_stage='acknowledged',acknowledged_by=3,acknowledged_at='2026-10-06T00:00:00Z' WHERE id=?").run(id);
 const list=await (await call(env,'/api/leave-requests','GET',undefined,3)).json();assert(list.leave_requests.find(r=>r.id===id).can_acknowledge);
 assert.equal((await call(env,path,'PATCH',{action:'acknowledge'},3)).status,200);
 assert.equal(env.raw.prepare('SELECT acknowledged_at FROM leave_requests WHERE id=?').get(id).acknowledged_at,'2026-10-06T00:00:00Z');
 assert.equal((await call(env,path,'PATCH',{action:'decide',status:'rejected'},4)).status,200);
 const summary=await dashboardActivitySummary(env);assert.equal(summary.leave_summary.approved,0);assert(await notice(env,2,'leave:'+id+':rejected'));
});

test('director cannot approve a linked personal leave or decide after losing the director position',async()=>{
 const {env}=await setup();const {id}=await (await call(env,'/api/leave-requests','POST',form,2)).json(),path='/api/leave-requests/'+id;
 assert.equal((await call(env,path,'PATCH',{action:'acknowledge'},3)).status,200);
 const director=env.raw.prepare('SELECT personnel_id FROM personnel_accounts WHERE user_id=4').get();
 env.raw.prepare('UPDATE personnel_accounts SET personnel_id=? WHERE user_id=2').run(director.personnel_id);
 assert.equal((await call(env,path,'PATCH',{action:'decide',status:'approved'},4)).status,403);
 env.raw.prepare("UPDATE personnel_records SET position='ครู' WHERE id=?").run(director.personnel_id);
 assert.equal((await call(env,path,'PATCH',{action:'decide',status:'approved'},4)).status,403);
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
 await call(env,'/api/leave-settings','PATCH',{limits:[{leave_type:'general',max_count:null},{leave_type:'lenient',max_count:2}]});
 const p=env.raw.prepare('SELECT id FROM personnel_records WHERE user_id=2').get();
 env.raw.exec("INSERT INTO users(id,email,password_hash,password_salt,full_name,role) VALUES(7,'linked@test','x','x','บัญชีเดิมครู ก','teacher')");env.raw.prepare('INSERT INTO personnel_accounts(user_id,personnel_id) VALUES(7,?)').run(p.id);
 env.raw.exec(`INSERT INTO leave_requests(user_id,leave_type,start_date,end_date,leave_days,status) VALUES
 (7,'sick','2026-10-02','2026-10-02',0.5,'approved'),(2,'personal','2026-10-03','2026-10-03',1,'approved'),
 (2,'sick','2026-09-29','2026-09-29',1,'approved'),(2,'sick','2026-10-04','2026-10-04',1,'rejected');`);
 const {id}=await (await call(env,'/api/leave-requests','POST',form,2)).json();
 const {leave_request:r}=await (await call(env,'/api/leave-requests/'+id,'GET',undefined,2)).json();
 assert.equal(r.last_leave.leave_type,'personal');assert.equal(r.last_leave.start_date,'2026-10-03');
 assert.deepEqual(r.stats[0],{type:'sick',previous_count:1,previous_days:0.5,current_days:0.5,total_count:2,total_days:1});
 // Stored leave_days is final (no recomputation from the calendar), so the raw 1-day record stays 1.
 assert.equal(r.stats[1].total_days,1);assert.equal(r.statistics_period.from,'2026-10-01');
});
test('runtime migration preserves legacy leave records and permits the new head workflow',async()=>{
 const env=await fixture();env.raw.exec('DROP TABLE leave_requests; CREATE TABLE leave_requests(id INTEGER PRIMARY KEY,user_id INTEGER,leave_type TEXT,reason TEXT,start_date TEXT,end_date TEXT,status TEXT DEFAULT \'pending\',approved_by INTEGER,approved_at TEXT,created_at TEXT DEFAULT CURRENT_TIMESTAMP); INSERT INTO leave_requests(id,user_id,leave_type,start_date,end_date) VALUES(99,2,\'sick\',\'2026-10-01\',\'2026-10-01\');');
 await ensureLeaveData(env);const row=env.raw.prepare('SELECT * FROM leave_requests WHERE id=99').get();assert.equal(row.workflow_stage,'submitted');assert.equal(row.start_date,'2026-10-01');
 const {leave_request:r}=await (await call(env,'/api/leave-requests/99','GET',undefined,2)).json();assert.equal(r.leave_days,1);
});

test('lenient leave remains distinct from other leave through notifications, approval, form history and dashboard totals',async()=>{
 const {env,deputy}=await setup();
 const created=await call(env,'/api/leave-requests','POST',{...form,leave_type:'lenient'},2);assert.equal(created.status,201);const {id}=await created.json();
 const list=await (await call(env,'/api/leave-requests','GET',undefined,3)).json();assert.equal(list.leave_requests.find(r=>r.id===id).leave_type,'lenient');assert(await notice(env,3,'leave:'+id+':pending'));
 let summary=await dashboardActivitySummary(env,2570);assert.equal(summary.leave_summary.by_type.find(r=>r.key==='lenient').pending,1);assert.equal(summary.leave_summary.by_type.find(r=>r.key==='other').total,0);
 await call(env,'/api/leave-requests/'+id,'PATCH',{action:'acknowledge'},3);
 assert.equal((await call(env,'/api/leave-requests/'+id,'PATCH',{action:'decide',status:'approved'},4)).status,200);
 summary=await dashboardActivitySummary(env,2570);const stats=summary.leave_summary.by_type.find(r=>r.key==='lenient');assert.equal(stats.label,'ลาอนุโลม');assert.equal(stats.approved,1);assert.equal(stats.approved_days,0.5);assert.equal(summary.leave_summary.total,1);
 const next=await (await call(env,'/api/leave-requests','POST',{...form,leave_type:'lenient',start_date:'2026-10-07',end_date:'2026-10-07'},2)).json();
 const {leave_request:r}=await (await call(env,'/api/leave-requests/'+next.id,'GET',undefined,2)).json();assert.equal(r.leave_type,'lenient');assert.equal(r.last_leave.leave_type,'lenient');const row=r.stats.find(s=>s.type==='lenient');assert.equal(row.previous_days,0.5);assert.equal(row.current_days,0.5);assert.equal(row.total_days,1);
 const other=await call(env,'/api/leave-requests','POST',{...form,leave_type:'other'},2);assert.equal(other.status,201);
 summary=await dashboardActivitySummary(env,2570);assert.equal(summary.leave_summary.by_type.find(r=>r.key==='other').total,1);assert.equal(summary.leave_summary.by_type.find(r=>r.key==='lenient').total,2);
});

test('decided leave forms are stored on Google Drive once, only by approvers/personnel head/admin',async()=>{
 const {env}=await setup();
 const {id}=await (await call(env,'/api/leave-requests','POST',form,2)).json(),path='/api/leave-requests/'+id;
 assert.equal((await call(env,path+'/drive-pdf','POST',undefined,1)).status,409);
 assert.equal((await call(env,path,'PATCH',{action:'acknowledge'},3)).status,200);
 assert.equal((await call(env,path,'PATCH',{action:'decide',status:'approved'},4)).status,200);
 const list=await (await call(env,'/api/leave-requests','GET',undefined,4)).json();
 const row=list.leave_requests.find(r=>r.id===id);
 assert.equal(row.can_store_drive,true);assert.equal(row.drive_saved,false);
 assert.equal('teacher_signature' in row||'forward_token' in row,false);
 const teacher=(await (await call(env,'/api/leave-requests','GET',undefined,2)).json()).leave_requests.find(r=>r.id===id);
 assert.equal(teacher.can_store_drive,false);
 assert.equal((await call(env,path+'/drive-pdf','POST',undefined,2)).status,403);
 // ฟิกซ์เจอร์ไม่มีการตั้งค่า Google Drive → ผู้มีสิทธิ์ได้ 503 (ไม่ใช่ 403)
 assert.equal((await call(env,path+'/drive-pdf','POST',undefined,4)).status,503);
 assert.equal((await call(env,path+'/drive-pdf','GET',undefined,4)).status,405);
});

test('paternity flows through approval and keeps a separate working-day type in forms and statistics',async()=>{
 const {env}=await setup();
 // The school's personal/other turn cap must not block this separate leave type.
 await call(env,'/api/leave-settings','PATCH',{limits:[{leave_type:'general',max_count:0},{leave_type:'lenient',max_count:2}]});
 env.raw.exec("CREATE TABLE gr_holidays(holiday_date TEXT,kind TEXT); INSERT INTO gr_holidays VALUES('2026-11-10','holiday')");
 const request={...form,leave_type:'paternity',reason:'ช่วยเหลือภริยาหลังคลอดบุตร',start_date:'2026-11-06',end_date:'2026-11-10',leave_days:undefined};
 const preview=await (await call(env,'/api/leave-working-days?start=2026-11-06&end=2026-11-10&type=paternity','GET',undefined,2)).json();
 assert.equal(preview.working_days,2);assert.equal(preview.counts_calendar_days,false);
 assert.equal((await call(env,'/api/leave-requests','POST',{...request,leave_days:5},2)).status,400);
 assert.equal((await call(env,'/api/leave-requests','POST',{...request,start_date:'2026-11-07',end_date:'2026-11-08'},2)).status,400);
 const response=await call(env,'/api/leave-requests','POST',request,2);assert.equal(response.status,201);
 const {id}=await response.json(),path='/api/leave-requests/'+id;
 const stored=env.raw.prepare('SELECT leave_type,leave_subtype,leave_days FROM leave_requests WHERE id=?').get(id);
 assert.deepEqual({...stored},{leave_type:'other',leave_subtype:'paternity',leave_days:2});
 assert.equal((await call(env,path,'PATCH',{action:'decide',status:'approved'},4)).status,409);
 assert.equal((await call(env,path,'PATCH',{action:'acknowledge'},3)).status,200);
 assert.equal((await call(env,path,'PATCH',{action:'decide',status:'approved'},4)).status,200);
 const list=await (await call(env,'/api/leave-requests','GET',undefined,2)).json();
 assert.equal(list.leave_requests.find(r=>r.id===id).leave_type,'paternity');
 const detail=await (await call(env,path,'GET',undefined,2)).json();
 assert.equal(detail.leave_request.leave_type,'paternity');
 assert.deepEqual(detail.leave_request.stats.map(s=>s.type),['paternity']);
 assert.equal(detail.leave_request.stats[0].current_days,2);
 const stats=await leaveStatistics(env,{fiscalYear:2570});
 assert.equal(stats.by_type.find(r=>r.key==='paternity').days,2);
 assert.equal(stats.by_type.find(r=>r.key==='other').days,0);
 assert.equal(stats.summary.approved_days,2);
 const summary=await dashboardActivitySummary(env,2570);
 assert.equal(summary.leave_summary.by_type.find(r=>r.key==='paternity').approved_days,2);
 assert.equal(summary.leave_summary.approved_days,2);
});

test('editing between maternity and paternity applies each day rule and clears obsolete subtypes',async()=>{
 const {env}=await setup();
 const created=await call(env,'/api/leave-requests','POST',{...form,leave_type:'maternity',start_date:'2026-11-06',end_date:'2026-11-09',leave_days:4},2);
 assert.equal(created.status,201);const {id}=await created.json(),path='/api/leave-requests/'+id;
 const edit={action:'edit',leave_type:'paternity',start_date:'2026-11-06',end_date:'2026-11-09',leave_days:4,note:'แก้ประเภทให้ตรงกับผู้ยื่น'};
 assert.equal((await call(env,path,'PATCH',edit,2)).status,403);
 assert.equal((await call(env,path,'PATCH',edit,1)).status,400);
 assert.equal((await call(env,path,'PATCH',{...edit,leave_days:2},1)).status,200);
 assert.deepEqual({...env.raw.prepare('SELECT leave_type,leave_subtype,leave_days FROM leave_requests WHERE id=?').get(id)},{leave_type:'other',leave_subtype:'paternity',leave_days:2});
 assert.equal((await call(env,path,'PATCH',{...edit,leave_type:'maternity',leave_days:4},1)).status,200);
 assert.deepEqual({...env.raw.prepare('SELECT leave_type,leave_subtype,leave_days FROM leave_requests WHERE id=?').get(id)},{leave_type:'maternity',leave_subtype:null,leave_days:4});
});

test('personnel overview retains leave types when prorating maternity and paternity through today',async t=>{
 const {env}=await setup();t.mock.method(Date,'now',()=>Date.UTC(2026,10,8,5));
 env.raw.exec(`INSERT INTO leave_requests(user_id,leave_type,leave_subtype,start_date,end_date,leave_days,status) VALUES
 (2,'maternity',NULL,'2026-11-06','2026-11-09',4,'approved'),
 (2,'other','paternity','2026-11-06','2026-11-09',2,'approved')`);
 const response=await call(env,'/api/personnel/overview');assert.equal(response.status,200);
 // Fri–Sun: 3 calendar days of maternity + Friday only for paternity.
 assert.equal((await response.json()).summary.approved_leave_days_ytd,4);
});
