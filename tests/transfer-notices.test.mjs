import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/index.js';
import { fixture } from './student-transfers.fixture.mjs';
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
