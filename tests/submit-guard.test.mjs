import test from 'node:test';import assert from 'node:assert/strict';import {DatabaseSync} from 'node:sqlite';
import {checkSubmitGuard,guardedWrite,RATE_LIMIT} from '../src/lib/submit-guard.js';
function d1(db){const prep=sql=>{let args=[];const st={bind(...v){args=v;return st},async all(){return {results:db.prepare(sql).all(...args)}},async first(){return db.prepare(sql).get(...args)??null},async run(){const r=db.prepare(sql).run(...args);return {meta:{changes:Number(r.changes)}}}};return st};
 return {prepare:prep,async batch(list){for(const s of list)await s.run()}}}
const req=(path,body,{method='POST',cookie='bpd_session=abc'}={})=>new Request('https://school.test'+path,{method,headers:{Cookie:cookie,'Content-Type':'application/json'},body:JSON.stringify(body)});
test('only LINE-notifying writes are guarded',()=>{
 assert(guardedWrite('POST','/api/maintenance/requests'));assert(guardedWrite('PATCH','/api/leave-requests/4'));assert(guardedWrite('POST','/api/substitutes/assignments'));
 assert(!guardedWrite('GET','/api/maintenance/requests'));assert(!guardedWrite('POST','/api/students'));assert(!guardedWrite('POST','/api/project-documents/notifications/read'));
});
test('double submit is rejected once, released after a failed first attempt',async()=>{
 const env={DB:d1(new DatabaseSync(':memory:'))},t=1_800_000_000_000;
 const first=await checkSubmitGuard(req('/api/maintenance/requests',{title:'ไฟดับ'}),env,'/api/maintenance/requests',t);assert(first.release&&!first.response);
 const again=await checkSubmitGuard(req('/api/maintenance/requests',{title:'ไฟดับ'}),env,'/api/maintenance/requests',t+3000);assert.equal(again.response.status,409);
 const other=await checkSubmitGuard(req('/api/maintenance/requests',{title:'น้ำรั่ว'}),env,'/api/maintenance/requests',t+3000);assert(!other.response);
 const otherUser=await checkSubmitGuard(req('/api/maintenance/requests',{title:'ไฟดับ'},{cookie:'bpd_session=zzz'}),env,'/api/maintenance/requests',t+3000);assert(!otherUser.response);
 const later=await checkSubmitGuard(req('/api/maintenance/requests',{title:'ไฟดับ'}),env,'/api/maintenance/requests',t+25000);assert(!later.response);
 const failed=await checkSubmitGuard(req('/api/tasks',{title:'x'}),env,'/api/tasks',t);await failed.release();
 assert(!(await checkSubmitGuard(req('/api/tasks',{title:'x'}),env,'/api/tasks',t+1000)).response);
});
test('rate limit and maintenance LINE resend cooldown',async()=>{
 const env={DB:d1(new DatabaseSync(':memory:'))},t=1_800_000_000_000;
 for(let i=0;i<RATE_LIMIT;i++)assert(!(await checkSubmitGuard(req('/api/tasks',{i}),env,'/api/tasks',t+i)).response);
 const blocked=await checkSubmitGuard(req('/api/tasks',{i:'x'}),env,'/api/tasks',t+100);assert.equal(blocked.response.status,429);
 assert(!(await checkSubmitGuard(req('/api/maintenance/requests/7/notify',{}),env,'/api/maintenance/requests/7/notify',t)).response);
 assert.equal((await checkSubmitGuard(req('/api/maintenance/requests/7/notify',{},{cookie:'bpd_session=other'}),env,'/api/maintenance/requests/7/notify',t+30000)).response.status,429);
 assert(!(await checkSubmitGuard(req('/api/maintenance/requests/7/notify',{}),env,'/api/maintenance/requests/7/notify',t+121000)).response);
 assert.equal(await checkSubmitGuard(req('/api/tasks',{a:1},{cookie:''}),env,'/api/tasks',t),null);
});
test('same work resent many times and submit/cancel toggling are blocked',async()=>{
 const env={DB:d1(new DatabaseSync(':memory:'))},t=1_800_000_000_000,p='/api/supervision/requests',b={visit_date:'2030-01-07',period:2};
 assert(!(await checkSubmitGuard(req(p,b),env,p,t)).response);
 assert(!(await checkSubmitGuard(req(p,b),env,p,t+30000)).response,'second send after 20s allowed');
 const third=await checkSubmitGuard(req(p,b),env,p,t+60000);assert.equal(third.response.status,429);assert.equal((await third.response.json()).code,'REPEAT_LIMITED');
 assert(!(await checkSubmitGuard(req(p,b),env,p,t+601000)).response,'allowed again after the window');
 // ส่ง-ยกเลิกสลับไปมา
 const env2={DB:d1(new DatabaseSync(':memory:'))};
 for(let i=0;i<3;i++){
  assert(!(await checkSubmitGuard(req(p,{...b,period:i+1}),env2,p,t+i*1000)).response);
  assert(!(await checkSubmitGuard(req(`${p}/${i}/cancel`,{}),env2,`${p}/${i}/cancel`,t+i*1000+500)).response);
 }
 const again=await checkSubmitGuard(req(p,{...b,period:6}),env2,p,t+5000);assert.equal(again.response.status,429);assert.equal((await again.response.json()).code,'CHURN_LIMITED');
 assert(!(await checkSubmitGuard(req('/api/leave-requests',{x:1}),env2,'/api/leave-requests',t+5000)).response,'other systems unaffected');
 assert(!(await checkSubmitGuard(req(p,{...b,period:6}),env2,p,t+601000)).response,'released after the window');
 // ยกเลิกที่ไม่สำเร็จไม่นับ
 const env3={DB:d1(new DatabaseSync(':memory:'))};
 for(let i=0;i<5;i++){const g=await checkSubmitGuard(req('/api/leave-requests/9',{},{method:'DELETE'}),env3,'/api/leave-requests/9',t+i);await g.release();}
 assert(!(await checkSubmitGuard(req('/api/leave-requests',{y:1}),env3,'/api/leave-requests',t+10)).response);
 assert(!(await checkSubmitGuard(req('/api/procurement/cases/3',{action:'cancel',note:'x'}),env3,'/api/procurement/cases/3',t+20)).response);
});
