import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
import worker from '../src/index.js';
import {signJWT} from '../src/lib/crypto.js';
import {ensureBudgetSchema} from '../src/routes/budget.js';

export async function fixture(){
 const raw=new DatabaseSync(':memory:');raw.exec(readFileSync(new URL('../schema.sql',import.meta.url),'utf8'));
 raw.exec(`INSERT INTO users(id,email,password_hash,password_salt,full_name,role) VALUES
 (1,'admin@test','x','x','ผู้ดูแล','superadmin'),(2,'owner@test','x','x','ครู ก','teacher'),(3,'co@test','x','x','ครู ข','teacher');
 INSERT INTO projects(id,department,name,budget_amount,fiscal_year,created_by,funding_type) VALUES
 (10,'academic','โครงการปีเดิม',100,2569,1,'subsidy'),(11,'academic','โครงการปีใหม่',200,2570,1,'free_education');
 INSERT INTO project_owners(project_id,user_id) VALUES (10,2),(10,3),(11,2);`);
 function prepare(sql){let values=[];return{bind(...v){values=v;return this},async first(){return raw.prepare(sql).get(...values)||null},async all(){return{results:raw.prepare(sql).all(...values)}},async run(){const r=raw.prepare(sql).run(...values);return{meta:{changes:Number(r.changes),last_row_id:Number(r.lastInsertRowid)}}}}}
 let tail=Promise.resolve();const env={raw,JWT_SECRET:'dashboard-test',DB:{prepare,batch(statements){const next=tail.then(async()=>{raw.exec('BEGIN');try{const out=[];for(const s of statements)out.push(await s.run());raw.exec('COMMIT');return out}catch(e){raw.exec('ROLLBACK');throw e}});tail=next.catch(()=>{});return next}}};await ensureBudgetSchema(env);return env;
}
export async function call(env,path,method='GET',body,user=1){const token=await signJWT({sub:user},env.JWT_SECRET);return worker.fetch(new Request('https://school.test'+path,{method,headers:{Cookie:`bpd_session=${token}`,'Content-Type':'application/json'},body:body?JSON.stringify(body):undefined}),env,{})}


test('notification count and read receipts are isolated by user; new statuses notify again',async()=>{
 const env=await fixture();await call(env,'/api/overview');
 env.raw.exec(`INSERT INTO project_expenses(id,project_id,fiscal_year,expense_date,description,amount,status,created_by) VALUES(999,10,2569,'2026-09-30','จ่าย',1,'paid',1);
 INSERT INTO project_workflow_events(token,expense_id,project_id,event_type,message,actor_id) VALUES('test-notice',999,10,'pay','ยืนยันการเบิกจ่าย',1);
 INSERT INTO project_notifications(event_token,user_id,audience) VALUES('test-notice',2,'owners');
 INSERT INTO tasks(id,title,created_by) VALUES(1,'งานสำหรับครู',1);INSERT INTO task_assignees(task_id,user_id) VALUES(1,2);
 INSERT INTO leave_requests(id,user_id,leave_type,start_date,end_date) VALUES(1,2,'sick','2026-10-01','2026-10-02');`);
 let teacher=await (await call(env,'/api/notifications','GET',undefined,2)).json();assert.equal(teacher.unread_count,2);
 const admin=await (await call(env,'/api/notifications')).json();assert.equal(admin.unread_count,1);assert.equal(admin.notifications[0].url,'/leave.html?request=1');
 const outsider=await (await call(env,'/api/notifications','GET',undefined,3)).json();assert.equal(outsider.unread_count,0);
 const key=teacher.notifications.find(n=>n.message_key.startsWith('project:')).message_key;
 assert.equal((await call(env,'/api/notifications/read','POST',{message_key:key},3)).status,200);
 assert.equal((await (await call(env,'/api/notifications','GET',undefined,2)).json()).unread_count,2);
 await call(env,'/api/notifications/read','POST',{message_key:key},2);assert.notEqual(env.raw.prepare('SELECT read_at FROM project_notifications WHERE user_id=2').get().read_at,null);
 await call(env,'/api/notifications/read','POST',{all:true},2);assert.equal((await (await call(env,'/api/notifications','GET',undefined,2)).json()).unread_count,0);
 await call(env,'/api/notifications/read','POST',{all:true});env.raw.exec("UPDATE leave_requests SET status='approved',approved_at=datetime('now') WHERE id=1");
 teacher=await (await call(env,'/api/notifications','GET',undefined,2)).json();assert.equal(teacher.unread_count,1);assert.match(teacher.notifications[0].message,/อนุมัติ/);
 assert.equal((await worker.fetch(new Request('https://school.test/api/notifications'),env,{})).status,401);
});
test('notification badge counts every unread message even when the panel displays only fifty',async()=>{
 const env=await fixture();await call(env,'/api/overview');for(let i=1;i<=65;i++){env.raw.prepare('INSERT INTO tasks(id,title,created_by) VALUES(?,?,1)').run(i,'งาน '+i);env.raw.prepare('INSERT INTO task_assignees(task_id,user_id) VALUES(?,2)').run(i);}
 const feed=await (await call(env,'/api/notifications','GET',undefined,2)).json();assert.equal(feed.unread_count,65);assert.equal(feed.notifications.length,50);
 await call(env,'/api/notifications/read','POST',{all:true},2);assert.equal((await (await call(env,'/api/notifications','GET',undefined,2)).json()).unread_count,0);
});
test('new and existing leave requests notify the personnel head and their linked accounts, without notifying unrelated teachers',async()=>{
 const env=await fixture();await call(env,'/api/overview');await call(env,'/api/notifications');
 const person=env.raw.prepare('SELECT id FROM personnel_records WHERE user_id=3').get();
 assert.equal((await call(env,'/api/department-staff/personnel','POST',{personnel_id:person.id,is_head:true})).status,200);
 env.raw.exec(`INSERT INTO users(id,email,password_hash,password_salt,full_name,role) VALUES(4,'linked@test','x','x','บัญชีหัวหน้าฝ่าย','teacher');`);
 env.raw.prepare('INSERT INTO personnel_accounts(user_id,personnel_id) VALUES(4,?)').run(person.id);
 const created=await call(env,'/api/leave-requests','POST',{leave_type:'sick',reason:'ไม่สบาย',position:'ครู',contact_address:'ที่อยู่ทดสอบ',contact_phone:'0000000000',start_date:'2026-10-06',end_date:'2026-10-06'},2);
 assert.equal(created.status,201);const id=(await created.json()).id,key='leave:'+id+':pending';
 for(const user of [3,4]){
  const feed=await (await call(env,'/api/notifications','GET',undefined,user)).json();assert(feed.notifications.some(n=>n.message_key===key));
  const inbox=await (await call(env,'/api/leave-requests','GET',undefined,user)).json();assert.equal(inbox.can_view_pending,true);assert(inbox.leave_requests.some(r=>r.id===id));
 }
 const owner=await (await call(env,'/api/notifications','GET',undefined,2)).json();assert(!owner.notifications.some(n=>n.message_key===key));
 await call(env,'/api/notifications/read','POST',{message_key:key},3);
 assert(!(await (await call(env,'/api/notifications','GET',undefined,3)).json()).notifications.some(n=>n.message_key===key));
 assert((await (await call(env,'/api/notifications','GET',undefined,4)).json()).notifications.some(n=>n.message_key===key));
 // Head can inspect requests; final approval remains with existing authorized approvers.
 assert.equal((await call(env,'/api/leave-requests/'+id,'PATCH',{status:'approved'},3)).status,403);
 await call(env,'/api/department-staff/personnel','POST',{personnel_id:person.id,is_head:false});
 const revoked=await (await call(env,'/api/notifications','GET',undefined,4)).json();assert(!revoked.notifications.some(n=>n.message_key===key));
 const hidden=await (await call(env,'/api/leave-requests','GET',undefined,4)).json();assert.equal(hidden.can_view_pending,false);assert.equal(hidden.leave_requests.length,0);
 // Final decision alerts are independent of how the workflow reached that decision.
 env.raw.prepare("UPDATE leave_requests SET status='approved',approved_at=datetime('now') WHERE id=?").run(id);
 assert((await (await call(env,'/api/notifications','GET',undefined,2)).json()).notifications.some(n=>n.message_key==='leave:'+id+':approved'));
});
