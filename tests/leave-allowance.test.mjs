import {seedLeaveCalendar} from './leave-calendar.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture,call} from './notifications.test.mjs';
import {ensureLeaveData} from '../src/lib/leave-data.js';
import {leaveTypes} from '../src/lib/leave-allowance.js';
const form={substitute_teacher:'ครูผู้รับมอบหมาย',leave_type:'lenient',reason:'เหตุผลทดสอบ',position:'ครู',start_date:'2026-10-06',end_date:'2026-10-06',contact_address:'บ้านพัก',contact_phone:'0000000000'};
const limits=(count)=>leaveTypes.map(leave_type=>({leave_type,max_count:leave_type==='lenient'?count:null}));
test('only personnel head/admin may configure validated limits; both quota groups default to two per term',async()=>{
 const env=await fixture();await ensureLeaveData(env);seedLeaveCalendar(env);
 let data=await (await call(env,'/api/leave-allowance?date=2026-10-01','GET',undefined,2)).json();
 assert(data.types.every(r=>r.max_count===2&&r.remaining===2));
 assert.equal(data.types.length,2);assert.equal(data.period.term_number,1);
 assert.equal((await call(env,'/api/leave-settings','PATCH',{limits:limits(2)},2)).status,403);
 const person=env.raw.prepare('SELECT id FROM personnel_records WHERE user_id=3').get();
 await call(env,'/api/department-staff/personnel','POST',{personnel_id:person.id,is_head:true});
 for(const count of [-1,1.5,'2'])assert.equal((await call(env,'/api/leave-settings','PATCH',{limits:limits(count)},3)).status,400);
 assert.equal((await call(env,'/api/leave-settings','PATCH',{limits:limits(2).slice(1)},3)).status,400);
 assert.equal((await call(env,'/api/leave-settings','PATCH',{limits:limits(2)},3)).status,200);
 assert.equal((await call(env,'/api/leave-allowance?date=2026-02-30','GET',undefined,2)).status,400);
});

test('personal/other share two approved turns, sick and maternity are never blocked, lenient is separate; a new term resets',async()=>{
 const env=await fixture();await ensureLeaveData(env);seedLeaveCalendar(env);
 const submit=(type,start_date,reason)=>call(env,'/api/leave-requests','POST',{...form,leave_type:type,start_date,end_date:start_date,reason},2);
 const approve=async response=>{const {id}=await response.json();env.raw.prepare("UPDATE leave_requests SET status='approved',workflow_stage='completed' WHERE id=?").run(id);};
 await approve(await submit('personal','2026-10-30','กิจส่วนตัว'));
 await approve(await submit('other','2026-10-29','อื่น ๆ'));
 assert.equal((await submit('personal','2026-10-29','เกินสิทธิ์ทั่วไป')).status,409);
 // ลาป่วย/ลาคลอดยื่นได้เสมอ แม้สิทธิ์ลาทั่วไปครบแล้ว
 for(const day of ['2026-10-26','2026-10-27','2026-10-28'])await approve(await submit('sick',day,'ป่วย'));
 assert.equal((await submit('maternity','2026-10-28','คลอดบุตร')).status,201);
 await approve(await submit('lenient','2026-10-29','อนุโลมหนึ่ง'));
 // Pending requests no longer reserve a turn.
 assert.equal((await submit('lenient','2026-10-29','อนุโลมสอง (รอ)')).status,201);
 assert.equal((await submit('lenient','2026-10-29','อนุโลมสาม (รอ)')).status,201);
 const term2=await (await call(env,'/api/leave-allowance?date=2026-11-01','GET',undefined,2)).json();
 assert.equal(term2.period.term_number,2);assert(term2.types.every(r=>r.remaining===2));
 assert.equal((await submit('personal','2026-11-02','เทอมใหม่')).status,201);
 const denied=await submit('sick','2027-04-01','นอกภาคเรียน');assert.equal(denied.status,400);
 const outside=await (await call(env,'/api/leave-allowance?date=2027-04-01','GET',undefined,2)).json();assert.equal(outside.period,null);
 // Actual calendar dates win over hard-coded semester boundaries and current active term.
 env.raw.exec("UPDATE academic_terms SET end_date='2026-10-29' WHERE id=900; UPDATE academic_terms SET start_date='2026-10-30' WHERE id=901;");
 const moved=await (await call(env,'/api/leave-allowance?date=2026-10-31','GET',undefined,2)).json();
 assert.equal(moved.period.term_number,2);assert.equal(moved.types.find(r=>r.leave_type==='general').remaining,1);
 env.raw.exec("UPDATE academic_terms SET end_date='2026-11-02' WHERE id=900");
 assert.equal((await submit('lenient','2026-11-01','ปฏิทินซ้อนกัน')).status,400);
});

test('linked history counts approved turns only; pending does not reserve, cancellation, term reset and limits',async()=>{
 const env=await fixture();await ensureLeaveData(env);seedLeaveCalendar(env);
 const person=env.raw.prepare('SELECT personnel_id FROM personnel_accounts WHERE user_id=2').get();
 env.raw.prepare('INSERT OR REPLACE INTO personnel_accounts(user_id,personnel_id) VALUES(3,?)').run(person.personnel_id);
 env.raw.exec(`INSERT INTO leave_requests(user_id,leave_type,leave_subtype,start_date,end_date,status) VALUES
 (3,'other','lenient','2026-10-01','2026-10-01','approved'),
 (2,'other','lenient','2026-03-30','2026-03-30','approved'),
 (2,'other','lenient','2026-10-02','2026-10-02','rejected'),
 (2,'other',NULL,'2026-10-03','2026-10-03','approved');`);
 await call(env,'/api/leave-settings','PATCH',{limits:limits(2)});
 const submissions=await Promise.all([call(env,'/api/leave-requests','POST',form,2),call(env,'/api/leave-requests','POST',{...form,reason:'อีกคำขอ'},2)]);
 assert.deepEqual(submissions.map(r=>r.status),[201,201]);
 const {id}=await submissions[0].json();
 let data=await (await call(env,'/api/leave-allowance?date=2026-10-06','GET',undefined,2)).json();
 assert.deepEqual(data.types.find(r=>r.leave_type==='lenient'),{leave_type:'lenient',max_count:2,approved:1,pending:2,remaining:1});
 assert.equal(env.raw.prepare("SELECT COUNT(*) n FROM audit_logs WHERE resource='leave_request' AND action='create'").get().n,2);
 assert.equal((await call(env,'/api/leave-requests/'+id,'DELETE',undefined,2)).status,200);
 data=await (await call(env,'/api/leave-allowance?date=2026-10-06','GET',undefined,2)).json();assert.equal(data.types.find(r=>r.leave_type==='lenient').pending,1);
 data=await (await call(env,'/api/leave-allowance?date=2026-11-01','GET',undefined,2)).json();assert.equal(data.types.find(r=>r.leave_type==='lenient').remaining,2);
 await call(env,'/api/leave-settings','PATCH',{limits:limits(0)});
 assert.equal((await call(env,'/api/leave-requests','POST',{...form,start_date:'2026-11-02',end_date:'2026-11-02'},2)).status,409);
 await call(env,'/api/leave-settings','PATCH',{limits:limits(null)});
 assert.equal((await call(env,'/api/leave-requests','POST',{...form,reason:'ไม่จำกัดสิทธิ์'},2)).status,201);
});
