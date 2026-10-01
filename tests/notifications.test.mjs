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
 const admin=await (await call(env,'/api/notifications')).json();assert.equal(admin.unread_count,1);assert.equal(admin.notifications[0].url,'/leave.html');
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
