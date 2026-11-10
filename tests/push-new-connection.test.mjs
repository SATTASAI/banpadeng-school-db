import test from 'node:test';import assert from 'node:assert/strict';
import {fixture,call} from './notifications.test.mjs';
import {dispatchPushNotifications, pushPrefs} from '../src/lib/push-feed.js';
test('new connection baselines all old work including more than 50 rows and only sends future work',async()=>{
 const env=await fixture();await call(env,'/api/overview');env.NOTIFY_API_KEY='test';env.PUSH_PILOT_ROLES='all';
 for(let i=1;i<=70;i++)env.raw.exec(`INSERT INTO tasks(id,title,created_by,created_at) VALUES(${i},'งานเดิม ${i}',1,datetime('now','-2 days'));INSERT INTO task_assignees(task_id,user_id) VALUES(${i},2)`);
 const original=globalThis.fetch,sent=[];
 globalThis.fetch=async(url,init={})=>{const path=new URL(url).pathname;if(path==='/api/refs')return Response.json({refs:['u:2']});if(path==='/api/notifications'){sent.push(JSON.parse(init.body));return Response.json({});}throw Error('Unexpected '+url);};
 const run=async()=>{try{env.raw.exec("UPDATE push_feed_state SET started_at='2000-01-01'");}catch{}await dispatchPushNotifications(env);};
 try{
  await run();assert.equal(sent.length,0);
  // Expose older rows hidden by the first 50-row baseline; they must stay silent.
  env.raw.exec("UPDATE task_assignees SET status='done' WHERE 'task:'||task_id IN (SELECT message_key FROM push_feed_sent)");
  await run();assert.equal(sent.length,0);
  env.raw.exec("INSERT INTO tasks(id,title,created_by,created_at) VALUES(999,'งานใหม่หลังเชื่อม',1,datetime('now','+2 seconds'));INSERT INTO task_assignees(task_id,user_id) VALUES(999,2)");
  await run();assert.equal(sent.length,1);assert.match(sent[0].body,/งานใหม่หลังเชื่อม/);assert(!sent[0].body.includes('งานเดิม'));
 }finally{globalThis.fetch=original;}
});

test('School Notify links to the exact leave for the applicant and reviewer, including historical inbox items',async()=>{
 const env=await fixture();await call(env,'/api/overview');await call(env,'/api/notifications');
 env.NOTIFY_API_KEY='test';env.PUSH_PILOT_ROLES='all';
 await pushPrefs(env,{id:1});
 env.raw.exec(`INSERT INTO push_feed_users(user_id,started_at) VALUES(1,'2000-01-01'),(2,'2000-01-01');
  INSERT INTO leave_requests(id,user_id,leave_type,start_date,end_date,status,workflow_stage) VALUES
   (8,2,'sick','2026-11-10','2026-11-10','pending','submitted'),(9,2,'sick','2026-11-09','2026-11-09','approved','completed')`);
 const original=globalThis.fetch,sent=[];
 globalThis.fetch=async(url,init={})=>{
  const path=new URL(url).pathname;
  if(path==='/api/refs')return Response.json({refs:['u:1','u:2']});
  if(path==='/api/notifications'){sent.push(JSON.parse(init.body));return Response.json({});}
  throw Error('Unexpected '+url);
 };
 const origin='https://system.banpadengschool.ac.th';
 try{
  await dispatchPushNotifications(env,{origin});
  for(const [ref,path,title] of [['u:1','/leave.html?view=approval&request=8','เปิดหน้าพิจารณาการลา'],['u:2','/leave.html?request=9','เปิดคำขอลา']]){
   const payload=sent.find(r=>r.refs.includes(ref));
   assert.equal(payload.url,origin+path);
   assert.deepEqual(payload.actions[0],{title,url:origin+path});
  }
  env.raw.exec(`UPDATE push_feed_messages SET url='/leave-view.html?token=expired';
    UPDATE push_feed_state SET started_at='2000-01-01';
    INSERT INTO leave_requests(id,user_id,leave_type,start_date,end_date) VALUES
     (10,2,'sick','2026-11-10','2026-11-10'),(11,2,'sick','2026-11-10','2026-11-10')`);
  sent.length=0;
  await dispatchPushNotifications(env,{origin});
  assert.equal(sent[0].url,origin+'/notification.html');
  const inbox=await (await call(env,'/api/push/inbox?key=leave%3A8%3Apending')).json();
  assert.deepEqual(inbox.items.map(r=>r.url).sort(),[10,11,8].map(id=>'/leave.html?view=approval&request='+id));
  const applicant=await (await call(env,'/api/push/inbox','GET',undefined,2)).json();
  assert.deepEqual(applicant.items.map(r=>r.url),['/leave.html?request=9']);
 }finally{globalThis.fetch=original;}
});
