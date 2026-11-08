import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/index.js';
import {fixture,call} from './notifications.test.mjs';
import {handleTransferNotices,ensureTransferNotices} from '../src/routes/transfer-notices.js';
import {unreadNotificationsFor} from '../src/routes/notifications.js';
import {dispatchPushNotifications} from '../src/lib/push-feed.js';

const input=()=>({client_ref:crypto.randomUUID(),student_name:'นักเรียนทดสอบ แจ้งย้าย',direction:'out',destination_school:'โรงเรียนทดสอบ',contact_phone:'0812345678',contact_address:'ที่อยู่ส่วนตัว'});
const request=body=>new Request('https://school.test/api/public/transfer-notices',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
async function setup(){
 const env=await fixture();await call(env,'/api/overview');await ensureTransferNotices(env);
 env.raw.exec(`INSERT INTO student_transfer_access(user_id,granted_by) VALUES(2,1)`);
 return env;
}
test('transfer feed targets active registry grantees and superadmins; reading does not acknowledge; revoking or reviewing removes the work',async()=>{
 const env=await setup();await handleTransferNotices(request(input()),env,'/api/public/transfer-notices','POST');
 const feed=async(id,options)=> (await unreadNotificationsFor(env,{id,role:id===1?'superadmin':'teacher'},50,options)).filter(r=>r.message_key.startsWith('transfer-notice:'));
 assert.equal((await feed(1)).length,1);assert.equal((await feed(2)).length,1);assert.equal((await feed(3)).length,0);
 assert.equal((await feed(2,{forLine:true})).length,0);
 const row=(await feed(2))[0];assert.equal(row.url,'/dmcreport/?view=notices');
 await call(env,'/api/notifications/read','POST',{message_key:row.message_key},2);
 assert.equal((await feed(2)).length,0);assert.equal((await feed(2,{forDelivery:true})).length,1);
 assert.equal(env.raw.prepare('SELECT acknowledged_at FROM student_transfer_notices').get().acknowledged_at,null);
 for(const sql of ["UPDATE users SET status='disabled' WHERE id=2","UPDATE users SET status='active',deleted_at=datetime('now') WHERE id=2","UPDATE users SET deleted_at=NULL,role=NULL WHERE id=2"]){env.raw.exec(sql);assert.equal((await feed(2,{forDelivery:true})).length,0);}
 env.raw.exec("UPDATE users SET role='teacher' WHERE id=2; DELETE FROM student_transfer_access WHERE user_id=2");assert.equal((await feed(2,{forDelivery:true})).length,0);
 await call(env,'/api/student-transfers/notices/1/acknowledge','POST',undefined,1);assert.equal((await feed(1)).length,0);
});
test('public intake schedules School Notify to each authorized user once, with inbox and work link; transient errors retry',async()=>{
 const env=await setup();env.NOTIFY_API_KEY='test';env.PUSH_PILOT_ROLES='all';
 const original=globalThis.fetch,sent=[];let fail=true;
 globalThis.fetch=async(url,init={})=>{
  const path=new URL(url).pathname;
  if(path==='/api/refs')return Response.json({refs:['u:1','u:2','u:3']});
  if(path==='/api/notifications'){const payload=JSON.parse(init.body);if(fail&&payload.refs[0]==='u:2')return new Response('{}',{status:503});sent.push(payload);return Response.json({});}
  throw Error('Unexpected outgoing request '+url);
 };
 const run=async()=>{env.raw.exec("UPDATE push_feed_state SET started_at='2000-01-01'");await dispatchPushNotifications(env,{trigger:'event',origin:'https://system.banpadengschool.ac.th'});};
 try{
  const body=input(),background=[];
  const response=await worker.fetch(request(body),env,{waitUntil(promise){background.push(promise);}});assert.equal(response.status,201);
  assert.ok(background.length);await Promise.all(background);
  assert.deepEqual(sent.map(p=>p.refs[0]),['u:1']);
  fail=false;await run();assert.deepEqual(sent.map(p=>p.refs[0]),['u:1','u:2']);
  for(const message of sent){assert.match(message.title,/แจ้งย้ายออกใหม่/);assert.match(message.body,/นักเรียนทดสอบ/);assert.ok(message.body.includes('ตรวจสอบแจ้งย้าย: https://system.banpadengschool.ac.th/dmcreport/?view=notices'));assert.equal(message.url,'https://system.banpadengschool.ac.th/dmcreport/?view=notices');assert.ok(!message.body.includes(body.contact_address));assert.ok(!message.body.includes(body.contact_phone));assert.equal(message.actions[0].title,'ตรวจสอบแจ้งย้าย');assert.equal(message.actions[0].url,'https://system.banpadengschool.ac.th/dmcreport/?view=notices');}
  assert.equal(env.raw.prepare("SELECT COUNT(*) n FROM push_feed_messages WHERE message_key='transfer-notice:1'").get().n,2);
  assert.match(env.raw.prepare("SELECT message FROM push_feed_messages WHERE user_id=2 AND message_key='transfer-notice:1'").get().message,/https:\/\/system\.banpadengschool\.ac\.th\/dmcreport\/\?view=notices/);
  // Retrying the same form and recurring delivery never duplicate a notification.
  await handleTransferNotices(request(body),env,'/api/public/transfer-notices','POST');await run();assert.equal(sent.length,2);
  env.raw.exec(`DELETE FROM student_transfer_access WHERE user_id=2; INSERT INTO tasks(id,title,created_by) VALUES(999,'งานร่วมในรอบเดียวกัน',2); INSERT INTO task_assignees(task_id,user_id) VALUES(999,1);`);
  await handleTransferNotices(request({...input(),direction:'in',destination_school:''}),env,'/api/public/transfer-notices','POST');await run();
  assert.equal(sent.length,3);assert.deepEqual(sent[2].refs,['u:1']);assert.match(sent[2].body,/แจ้งย้ายเข้าใหม่/);assert.equal(sent[2].body.match(/https:\/\/system\.banpadengschool\.ac\.th\/dmcreport\/\?view=notices/g).length,1);
 }finally{globalThis.fetch=original;}
});
