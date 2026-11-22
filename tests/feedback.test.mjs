import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture,call} from './notifications.test.mjs';

test('anonymous feedback: anyone sends, no sender stored, admins read and get notified, daily limit',async()=>{
 const env=await fixture();
 assert.equal((await call(env,'/api/feedback','POST',{message:'  '},2)).status,400);
 assert.equal((await call(env,'/api/feedback','POST',{message:'ห้องน้ำชั้น 2 ควรซ่อม'},2)).status,201);
 const cols=env.raw.prepare('PRAGMA table_info(anonymous_feedback)').all().map(c=>c.name);
 assert.deepEqual(cols,['id','message','created_at']);
 const row=env.raw.prepare('SELECT * FROM anonymous_feedback').get();
 assert.equal(row.message,'ห้องน้ำชั้น 2 ควรซ่อม');assert.match(row.created_at,/^\d{4}-\d\d-\d\d \d\d:00:00$/);
 const quota=env.raw.prepare('SELECT token FROM anonymous_feedback_quota').all();
 assert.equal(quota.length,1);assert.doesNotMatch(quota[0].token,/(^|:)2(:|$)/);assert.match(quota[0].token,/^[0-9a-f]{64}$/);
 const teacher=await (await call(env,'/api/feedback','GET',undefined,2)).json();
 assert.equal(teacher.canRead,false);assert.equal(teacher.items,undefined);
 const admin=await (await call(env,'/api/feedback')).json();
 assert.equal(admin.canRead,true);assert.equal(admin.items.length,1);assert.equal(admin.items[0].user_id,undefined);
 const bell=await (await call(env,'/api/notifications')).json();
 assert.ok(bell.notifications.some(n=>n.message_key.startsWith('feedback:')&&n.url==='/feedback.html'));
 const teacherBell=await (await call(env,'/api/notifications','GET',undefined,2)).json();
 assert.ok(!teacherBell.notifications.some(n=>n.message_key.startsWith('feedback:')));
 for(let i=0;i<4;i++)assert.equal((await call(env,'/api/feedback','POST',{message:'ข้อ '+i},2)).status,201);
 assert.equal((await call(env,'/api/feedback','POST',{message:'เกิน'},2)).status,429);
 assert.equal((await call(env,'/api/feedback','POST',{message:'คนอื่นยังส่งได้'},3)).status,201);
});
