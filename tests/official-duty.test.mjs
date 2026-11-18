import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture,call} from './notifications.test.mjs';

test('ไปราชการ: บันทึก ดูทะเบียน แจ้งเตือนทำงาน ยกเลิกได้ และไม่นับเป็นใบลา',async()=>{
 const env=await fixture();
 let r=await call(env,'/api/official-duties','POST',{title:'ประชุม',location:'สพป.',start_date:'2026-12-01',end_date:'2026-12-01',day_part:'morning'},2);
 assert.equal(r.status,201);const {id}=await r.json();
 assert.equal((await call(env,'/api/official-duties','POST',{title:'อบรม',location:'x',start_date:'2026-12-01',end_date:'2026-12-02',day_part:'afternoon'},2)).status,400);
 const mine=await (await call(env,'/api/official-duties','GET',undefined,2)).json();
 assert.equal(mine.duties.length,1);assert.equal(mine.duties[0].status,'pending');assert.equal(mine.duties[0].can_cancel,true);
 assert.equal((await (await call(env,'/api/official-duties','GET',undefined,3)).json()).duties.length,0);
 assert.equal((await call(env,'/api/notifications','GET',undefined,1)).status,200);
 assert.equal((await call(env,'/api/notifications','GET',undefined,2)).status,200);
 assert.equal((await call(env,`/api/official-duties/${id}`,'PATCH',{action:'acknowledge'},1)).status,403);
 assert.equal(env.raw.prepare('SELECT COUNT(*) n FROM leave_requests').get().n,0);
 assert.equal((await call(env,`/api/official-duties/${id}`,'DELETE',undefined,3)).status,403);
 assert.equal((await call(env,`/api/official-duties/${id}`,'DELETE',undefined,2)).status,200);
 assert.equal(env.raw.prepare('SELECT status FROM official_duties WHERE id=?').get(id).status,'cancelled');
});
