import {seedLeaveCalendar} from './leave-calendar.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture,call} from './notifications.test.mjs';
import {ensureLeaveData} from '../src/lib/leave-data.js';
import {dashboardActivitySummary} from '../src/lib/dashboard-summary.js';

const form={leave_type:'sick',reason:'มีไข้ ไปพบแพทย์',position:'ครู',request_date:'2026-10-06',start_date:'2026-10-06',end_date:'2026-10-06',leave_days:0.5,contact_address:'บ้านพักครู ที่อยู่ตัวอย่าง',contact_phone:'0000000000'};
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

test('acknowledge and approve handles submitted, legacy acknowledged and forwarded requests once and updates statistics',async()=>{
 for(const stage of ['submitted','acknowledged','forwarded']){
  const {env}=await setup();
  const {id}=await (await call(env,'/api/leave-requests','POST',form,2)).json(),path='/api/leave-requests/'+id;
  if(stage==='acknowledged'){
   env.raw.prepare("UPDATE leave_requests SET workflow_stage='acknowledged',acknowledged_by=3,acknowledged_at='2026-11-02T03:45:21Z' WHERE id=?").run(id);
   env.raw.prepare("INSERT INTO leave_events(leave_id,actor_id,action) VALUES(?,3,'acknowledged')").run(id);
  }
  if(stage==='forwarded')await call(env,path,'PATCH',{action:'acknowledge'},3);
  const before=env.raw.prepare('SELECT * FROM leave_requests WHERE id=?').get(id);
  const list=await (await call(env,'/api/leave-requests','GET',undefined,4)).json();assert.equal(list.leave_requests.find(r=>r.id===id).can_acknowledge_approve,true);
  for(const uid of [1,2,3,5,6])assert.equal((await call(env,path,'PATCH',{action:'acknowledge_approve'},uid)).status,403);
  assert.equal((await call(env,path,'PATCH',{action:'acknowledge_approve',note:'รับทราบและอนุมัติ'},4)).status,200);
  const after=env.raw.prepare('SELECT * FROM leave_requests WHERE id=?').get(id);
  assert.equal(after.status,'approved');assert.equal(after.workflow_stage,'completed');assert.equal(after.approved_by,4);
  assert.equal(after.decision_name,'ผู้อำนวยการตัวอย่าง');assert.equal(after.decision_note,'รับทราบและอนุมัติ');assert(after.approved_at);
  assert.equal(after.acknowledged_by,before.acknowledged_by||4);assert.equal(after.acknowledged_at,before.acknowledged_at||after.approved_at);
  assert.equal(after.forwarded_by,before.forwarded_by);assert.equal(after.forwarded_at,before.forwarded_at);
  const events=env.raw.prepare('SELECT action FROM leave_events WHERE leave_id=? ORDER BY id').all(id).map(r=>r.action);
  assert.deepEqual(events,stage==='forwarded'?['submitted','acknowledged','forwarded','approved']:['submitted','acknowledged','approved']);
  const summary=await dashboardActivitySummary(env);assert.equal(summary.leave_summary.approved,1);assert.equal(summary.leave_summary.approved_days,0.5);assert.equal(summary.leave_summary.pending,0);
  const allowance=await (await call(env,'/api/leave-allowance?date=2026-10-06','GET',undefined,2)).json();assert.equal(allowance.types.find(t=>t.leave_type==='general').approved,1);assert.equal(allowance.types.find(t=>t.leave_type==='general').pending,0);
  assert(await notice(env,2,'leave:'+id+':approved'));
  assert.equal((await call(env,path,'PATCH',{action:'acknowledge_approve'},4)).status,409);
  assert.deepEqual(env.raw.prepare('SELECT action FROM leave_events WHERE leave_id=? ORDER BY id').all(id).map(r=>r.action),events);
 }
});

test('combined approval uses deputy delegation, denies self-linked leave and prevents stale/revoked or concurrent decisions',async()=>{
 const {env,deputy}=await setup();
 const {id}=await (await call(env,'/api/leave-requests','POST',form,2)).json(),path='/api/leave-requests/'+id;
 await call(env,'/api/leave-delegations','PATCH',{personnel_id:deputy,can_approve:true},4);
 env.raw.prepare('UPDATE personnel_accounts SET personnel_id=? WHERE user_id=2').run(deputy);
 assert.equal((await call(env,path,'PATCH',{action:'acknowledge_approve'},5)).status,403);
 const owner=env.raw.prepare('SELECT id FROM personnel_records WHERE user_id=2').get();
 env.raw.prepare('UPDATE personnel_accounts SET personnel_id=? WHERE user_id=2').run(owner.id);
 const batch=env.DB.batch.bind(env.DB);
 env.DB.batch=statements=>{env.raw.prepare('DELETE FROM leave_approval_delegations WHERE personnel_id=?').run(deputy);return batch(statements);};
 assert.equal((await call(env,path,'PATCH',{action:'acknowledge_approve'},5)).status,409);
 assert.equal(env.raw.prepare('SELECT status FROM leave_requests WHERE id=?').get(id).status,'pending');
 assert.equal(env.raw.prepare('SELECT COUNT(*) n FROM leave_events WHERE leave_id=?').get(id).n,1);
 env.DB.batch=batch;
 await call(env,'/api/leave-delegations','PATCH',{personnel_id:deputy,can_approve:true},4);
 const responses=await Promise.all([call(env,path,'PATCH',{action:'acknowledge_approve'},5),call(env,path,'PATCH',{action:'acknowledge_approve'},4)]);
 assert.deepEqual(responses.map(r=>r.status).sort(),[200,409]);
 assert.equal(env.raw.prepare("SELECT COUNT(*) n FROM leave_events WHERE leave_id=? AND action='approved'").get(id).n,1);
 assert.equal(env.raw.prepare("SELECT COUNT(*) n FROM leave_events WHERE leave_id=? AND action='acknowledged'").get(id).n,1);
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
