import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/index.js';
import { fixture, form } from './student-transfers.fixture.mjs';
import { handleTransferNotices } from '../src/routes/transfer-notices.js';
import { signJWT } from '../src/lib/crypto.js';
const body=(extra={})=>({client_ref:crypto.randomUUID(),student_name:'เด็กหญิงทดสอบ แจ้งย้าย',direction:'out',destination_school:'โรงเรียนทดสอบ',contact_phone:'081-234-5678',contact_address:'1 หมู่ 2 ตำบลทดสอบ',...extra});
async function call(env,path='/api/public/transfer-notices',method='POST',data,user=null,origin='https://school.test'){
 const headers={'Content-Type':'application/json','Origin':origin,'CF-Connecting-IP':'192.0.2.1'};
 if(user)headers.Cookie='bpd_session='+await signJWT({sub:user},env.JWT_SECRET);
 const req=new Request('https://school.test'+path,{method,headers,body:data===undefined?undefined:JSON.stringify(data)});
 return handleTransferNotices(req,env,path,method);
}
test('public intake records immutable evidence and idempotent receipt without creating a registry request',async()=>{
 const {env}=await fixture(),input=body();
 const response=await worker.fetch(new Request('https://school.test/api/public/transfer-notices',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(input)}),env,{});
 assert.equal(response.status,201);const saved=await response.json();assert.match(saved.receipt,/^TN-/);assert.ok(saved.created_at);assert.deepEqual(Object.keys(saved).sort(),['created_at','receipt']);
 assert.deepEqual(await (await call(env,undefined,undefined,{...input,student_name:'เปลี่ยนชื่อ'})).json(),saved);
 assert.equal(env.raw.prepare('SELECT COUNT(*) n FROM student_transfer_notices').get().n,1);
 assert.equal(env.raw.prepare('SELECT student_name FROM student_transfer_notices').get().student_name,input.student_name);
 assert.equal(env.raw.prepare('SELECT COUNT(*) n FROM student_transfer_requests').get().n,0);
 assert.equal((await call(env,undefined,'GET')).status,405);
});
test('staff permissions protect PII; acknowledgement preserves original evidence and first actor',async()=>{
 const {env}=await fixture();await call(env,undefined,undefined,body());const path='/api/student-transfers/notices';
 assert.equal((await call(env,path,'GET')).status,401);assert.equal((await call(env,path,'GET',undefined,3)).status,403);
 let res=await call(env,path,'GET',undefined,2);assert.equal(res.status,200);const row=(await res.json()).notices[0];assert.equal(row.contact_phone,'0812345678');
 const ack=path+'/'+row.id+'/acknowledge';assert.equal((await call(env,ack,'POST',undefined,3)).status,403);
 assert.equal((await call(env,ack,'POST',undefined,2)).status,200);assert.equal((await call(env,ack,'POST',undefined,1)).status,200);
 const saved=env.raw.prepare('SELECT * FROM student_transfer_notices').get();assert.equal(saved.acknowledged_by,2);assert.equal(saved.created_at,row.created_at);assert.equal(saved.student_name,row.student_name);
 assert.equal((await call(env,path+'/999/acknowledge','POST',undefined,1)).status,404);
});
test('validates inputs and blocks cross origin, oversized bodies, bots and repeated submissions',async()=>{
 const {env}=await fixture();
 for(const invalid of [{direction:'other'},{destination_school:''},{contact_phone:'abc'},{contact_address:''},{student_name:''},{client_ref:'bad'}])assert.equal((await call(env,undefined,undefined,body(invalid))).status,400);
 assert.equal((await call(env,undefined,undefined,body({website:'spam'}))).status,400);
 assert.equal((await call(env,undefined,undefined,body({contact_address:'x'.repeat(9000)}))).status,400);
 assert.equal((await call(env,undefined,undefined,body(),null,'https://other.test')).status,403);
 assert.equal((await call(env,undefined,undefined,body({direction:'in',destination_school:''}))).status,201);
 for(let i=0;i<19;i++)assert.equal((await call(env,undefined,undefined,body())).status,201);
 assert.equal((await call(env,undefined,undefined,body())).status,429);
});
test('pending summary requires registry permission and persists until explicit acknowledgement across pages',async()=>{
 const {env}=await fixture();const path='/api/student-transfers/notices';
 assert.equal((await call(env,path+'/summary','GET')).status,401);
 assert.equal((await call(env,path+'/summary','GET',undefined,3)).status,403);
 await call(env,undefined,undefined,body());
 let first=(await (await call(env,path,'GET',undefined,2)).json()).notices[0];
 assert.deepEqual(await (await call(env,path+'/summary','GET',undefined,2)).json(),{pending:1});
 // Viewing the list does not clear the pending indicator.
 assert.equal((await (await call(env,path,'GET',undefined,2)).json()).pending,1);
 await call(env,path+'/'+first.id+'/acknowledge','POST',undefined,2);
 assert.deepEqual(await (await call(env,path+'/summary','GET',undefined,2)).json(),{pending:0});
 const stmt=env.raw.prepare(`INSERT INTO student_transfer_notices(receipt,client_ref,student_name,direction,contact_phone,contact_address,acknowledged_at) VALUES(?,?,?,'in','0812345678','ที่อยู่',?)`);
 // Pending count must cover every page, and pending rows come first.
 stmt.run('pending-old','pending-old','รอตรวจสอบ',null);
 for(let i=0;i<51;i++)stmt.run('reviewed-'+i,'reviewed-'+i,'ตรวจแล้ว','2026-11-08 01:00:00');
 const listed=await (await call(env,path,'GET',undefined,2)).json();
 assert.equal(listed.total,53);assert.equal(listed.pending,1);assert.equal(listed.notices.length,50);assert.equal(listed.notices[0].student_name,'รอตรวจสอบ');
 assert.deepEqual(await (await call(env,path+'/summary','GET',undefined,2)).json(),{pending:1});
});

test('review atomically creates one editable pending request, transfers contact evidence and keeps concurrent review idempotent',async()=>{
 const {env,call:registry}=await fixture();
 await call(env,undefined,undefined,body({student_name:'เด็กชายทดสอบ ย้ายออก'}));
 const ack='/api/student-transfers/notices/1/acknowledge';
 const responses=await Promise.all([call(env,ack,'POST',undefined,2),call(env,ack,'POST',undefined,1)]);
 const results=await Promise.all(responses.map(r=>r.json()));assert.equal(results[0].request_id,results[1].request_id);const id=results[0].request_id;
 assert.equal(env.raw.prepare('SELECT COUNT(*) n FROM student_transfer_requests').get().n,1);
 let detail=await (await registry('/'+id)).json();assert.equal(detail.request.status,'pending');assert.equal(detail.request.student_code,'');assert.equal(detail.request.move_date,'');assert.equal(detail.request.reason,'');assert.equal(detail.request.school_name,'โรงเรียนทดสอบ');
 assert.equal(detail.notice.contact_phone,'0812345678');assert.equal(detail.notice.contact_address,'1 หมู่ 2 ตำบลทดสอบ');assert.equal(detail.events.filter(e=>e.action==='notice_intake').length,1);
 assert.equal((await registry('/'+id+'/decision','POST',{status:'approved',version:1},1)).status,400);
 assert.equal((await registry('/'+id+'/details','PATCH',{...form(),version:1},3)).status,403);
 assert.equal((await registry('','POST',form({client_ref:'notice:1'}))).status,400);
 const complete=form({student_code:'1001',student_name:'เด็กชายทดสอบ ย้ายออก',direction:'out',version:1});
 assert.equal((await registry('/'+id+'/details','PATCH',{...complete,student_code:'not-real'})).status,400);
 assert.equal((await registry('/'+id+'/details','PATCH',complete)).status,200);
 assert.equal((await registry('/'+id+'/details','PATCH',complete)).status,409);
 detail=await (await registry('/'+id)).json();assert.equal(detail.request.version,2);assert.equal(detail.request.student_code,'1001');assert.equal(detail.request.grade_level,complete.grade_level);assert.equal(detail.notice.student_name,'เด็กชายทดสอบ ย้ายออก');
 assert.equal(env.raw.prepare("SELECT status FROM students WHERE student_code='1001'").get().status,'enrolled');
 const listed=await (await call(env,'/api/student-transfers/notices','GET',undefined,2)).json();assert.equal(listed.notices[0].request_id,id);assert.equal(listed.pending,0);
 assert.equal((await (await call(env,ack,'POST',undefined,1)).json()).request_id,id);
});
test('migration permits several incomplete requests and failure leaves the notice pending; old reviews can create a request without replacing first reviewer',async()=>{
 const {env}=await fixture();
 // Simulate the earlier index on a deployed database.
 env.raw.exec("DROP INDEX idx_transfer_active_with_code; CREATE UNIQUE INDEX idx_transfer_active ON student_transfer_requests(student_code,direction,academic_year,term) WHERE status NOT IN ('rejected','cancelled')");env.DB={...env.DB};
 await call(env,undefined,undefined,body());
 env.raw.exec("CREATE TRIGGER fail_notice_intake BEFORE INSERT ON student_transfer_requests BEGIN SELECT RAISE(ABORT,'simulated storage failure'); END;");
 await assert.rejects(call(env,'/api/student-transfers/notices/1/acknowledge','POST',undefined,2),/simulated storage failure/);
 assert.equal(env.raw.prepare('SELECT acknowledged_at FROM student_transfer_notices').get().acknowledged_at,null);assert.equal(env.raw.prepare('SELECT COUNT(*) n FROM student_transfer_notice_links').get().n,0);
 env.raw.exec('DROP TRIGGER fail_notice_intake');
 await call(env,'/api/student-transfers/notices/1/acknowledge','POST',undefined,2);
 await call(env,undefined,undefined,body());env.raw.exec("UPDATE student_transfer_notices SET acknowledged_by=2,acknowledged_at='2026-11-08 01:00:00' WHERE id=2");
 await call(env,'/api/student-transfers/notices/2/acknowledge','POST',undefined,1);
 assert.equal(env.raw.prepare('SELECT COUNT(*) n FROM student_transfer_requests').get().n,2);
 const old=env.raw.prepare('SELECT acknowledged_by,acknowledged_at FROM student_transfer_notices WHERE id=2').get();assert.equal(old.acknowledged_by,2);assert.equal(old.acknowledged_at,'2026-11-08 01:00:00');
});
test('editing metadata preserves uniqueness and requires document verification again',async()=>{
 const {env,call:registry}=await fixture();
 const id=(await (await registry('','POST',form())).json()).id;
 env.raw.prepare("INSERT INTO student_transfer_documents(request_id,kind,file_name,mime_type,file_size,drive_file_id,verified,uploaded_by) VALUES(?,'referral','test.pdf','application/pdf',1,'drive-test',1,2)").run(id);
 assert.equal((await registry('/'+id+'/details','PATCH',{...form(),reason:'เหตุผลเพิ่มเติม',version:1})).status,200);
 assert.equal(env.raw.prepare('SELECT verified FROM student_transfer_documents WHERE request_id=?').get(id).verified,0);
 const other=(await (await registry('','POST',form({student_code:'2002'}))).json()).id;
 assert.equal((await registry('/'+other+'/details','PATCH',{...form(),version:1})).status,409);
 assert.equal(env.raw.prepare('SELECT version FROM student_transfer_requests WHERE id=?').get(other).version,1);
});
