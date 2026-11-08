import test from 'node:test';import assert from 'node:assert/strict';
import {fixture,call} from './notifications.test.mjs';
import {dispatchPushNotifications} from '../src/lib/push-feed.js';
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
