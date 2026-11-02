import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture,call} from './notifications.test.mjs';
import {ensureLeaveData} from '../src/lib/leave-data.js';
import {leaveTypes} from '../src/lib/leave-allowance.js';
const form={leave_type:'lenient',reason:'เหตุผลทดสอบ',position:'ครู',start_date:'2026-10-06',end_date:'2026-10-06',contact_address:'บ้านพัก',contact_phone:'0000000000'};
const limits=(count)=>leaveTypes.map(leave_type=>({leave_type,max_count:leave_type==='lenient'?count:null}));
test('only personnel head/admin may configure validated limits; all types default to unlimited',async()=>{
 const env=await fixture();await ensureLeaveData(env);
 let data=await (await call(env,'/api/leave-allowance?date=2026-10-01','GET',undefined,2)).json();
 assert(data.types.every(r=>r.max_count===null&&r.remaining===null));
 assert.equal((await call(env,'/api/leave-settings','PATCH',{limits:limits(2)},2)).status,403);
 const person=env.raw.prepare('SELECT id FROM personnel_records WHERE user_id=3').get();
 await call(env,'/api/department-staff/personnel','POST',{personnel_id:person.id,is_head:true});
 for(const count of [-1,1.5,'2'])assert.equal((await call(env,'/api/leave-settings','PATCH',{limits:limits(count)},3)).status,400);
 assert.equal((await call(env,'/api/leave-settings','PATCH',{limits:limits(2).slice(1)},3)).status,400);
 assert.equal((await call(env,'/api/leave-settings','PATCH',{limits:limits(2)},3)).status,200);
 assert.equal((await call(env,'/api/leave-allowance?date=2026-02-30','GET',undefined,2)).status,400);
});
test('linked history, pending reservations, fiscal reset, cancellation and concurrent submissions respect limits',async()=>{
 const env=await fixture();await ensureLeaveData(env);
 const person=env.raw.prepare('SELECT personnel_id FROM personnel_accounts WHERE user_id=2').get();
 env.raw.prepare('INSERT OR REPLACE INTO personnel_accounts(user_id,personnel_id) VALUES(3,?)').run(person.personnel_id);
 env.raw.exec(`INSERT INTO leave_requests(user_id,leave_type,leave_subtype,start_date,end_date,status) VALUES
 (3,'other','lenient','2026-10-01','2026-10-01','approved'),
 (2,'other','lenient','2026-09-30','2026-09-30','approved'),
 (2,'other','lenient','2026-10-02','2026-10-02','rejected'),
 (2,'other',NULL,'2026-10-03','2026-10-03','approved');`);
 await call(env,'/api/leave-settings','PATCH',{limits:limits(2)});
 const submissions=await Promise.all([call(env,'/api/leave-requests','POST',form,2),call(env,'/api/leave-requests','POST',{...form,reason:'อีกคำขอ'},2)]);
 assert.deepEqual(submissions.map(r=>r.status).sort(),[201,409]);
 const winner=submissions.find(r=>r.status===201),{id}=await winner.json();
 let data=await (await call(env,'/api/leave-allowance?date=2026-10-06','GET',undefined,2)).json();
 assert.deepEqual(data.types.find(r=>r.leave_type==='lenient'),{leave_type:'lenient',max_count:2,approved:1,pending:1,remaining:0});
 assert.equal(env.raw.prepare('SELECT COUNT(*) n FROM leave_events').get().n,1);
 assert.equal(env.raw.prepare("SELECT COUNT(*) n FROM audit_logs WHERE resource='leave_request' AND action='create'").get().n,1);
 assert.equal((await call(env,'/api/leave-requests/'+id,'DELETE',undefined,2)).status,200);
 data=await (await call(env,'/api/leave-allowance?date=2026-10-06','GET',undefined,2)).json();assert.equal(data.types.find(r=>r.leave_type==='lenient').remaining,1);
 data=await (await call(env,'/api/leave-allowance?date=2027-10-01','GET',undefined,2)).json();assert.equal(data.types.find(r=>r.leave_type==='lenient').remaining,2);
 await call(env,'/api/leave-settings','PATCH',{limits:limits(0)});
 assert.equal((await call(env,'/api/leave-requests','POST',{...form,start_date:'2027-10-01',end_date:'2027-10-01'},2)).status,409);
 await call(env,'/api/leave-settings','PATCH',{limits:limits(null)});
 assert.equal((await call(env,'/api/leave-requests','POST',{...form,reason:'ไม่จำกัดสิทธิ์'},2)).status,201);
});
