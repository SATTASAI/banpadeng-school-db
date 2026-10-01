import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
import worker from '../src/index.js';
import {signJWT} from '../src/lib/crypto.js';
import {ensureBudgetSchema} from '../src/routes/budget.js';

const db=new DatabaseSync(':memory:');db.exec(readFileSync(new URL('../schema.sql',import.meta.url),'utf8'));
db.exec(`INSERT INTO users(id,email,password_hash,password_salt,full_name,role) VALUES
 (1,'admin@test','x','x','Admin','superadmin'),(2,'executive@test','x','x','ผู้บริหาร','executive'),(3,'owner@test','x','x','เจ้าของ','teacher'),(4,'finance@test','x','x','การเงิน','staff');
 INSERT INTO projects(id,department,name,budget_amount,fiscal_year,created_by,funding_type) VALUES
 (10,'academic','แก้ยอดเดิม',1000,2570,1,'subsidy'),(11,'budget','ขอแก้ยอด',1000,2570,1,'school_income'),(12,'general','รออนุมัติ',1000,2570,1,'free_education');
 INSERT INTO project_owners(project_id,user_id) VALUES(10,3),(11,3),(12,3);
 INSERT INTO budget_role_assignments(role_key,department,user_id,assigned_by) VALUES('finance_review','',4,1);`);
function prepare(sql){let values=[];return{bind(...v){values=v;return this},async first(){return db.prepare(sql).get(...values)||null},async all(){return{results:db.prepare(sql).all(...values)}},async run(){const r=db.prepare(sql).run(...values);return{meta:{changes:Number(r.changes),last_row_id:Number(r.lastInsertRowid)}}}}}
let tail=Promise.resolve();const env={DB:{prepare,batch(statements){const next=tail.then(async()=>{db.exec('BEGIN');try{const out=[];for(const s of statements)out.push(await s.run());db.exec('COMMIT');return out}catch(e){db.exec('ROLLBACK');throw e}});tail=next.catch(()=>{});return next}},JWT_SECRET:'balance-test'};
await ensureBudgetSchema(env);
async function call(user,path,method='GET',body){const jwt=await signJWT({sub:user},env.JWT_SECRET);return worker.fetch(new Request('https://school.test'+path,{method,headers:{Cookie:`bpd_session=${jwt}`,'Content-Type':'application/json'},body:body?JSON.stringify(body):undefined}),env,{})}
const patch=(user,id,total,base)=>call(user,`/api/projects/${id}/spent-balance`,'PATCH',{total_spent:total,expected_total:base,reason:'แก้ยอดนำเข้าครั้งแรก'});
await call(1,'/api/overview');
// Confirmed electronic payment must never be altered when correcting an opening balance.
db.exec(`INSERT INTO project_expenses(id,project_id,fiscal_year,expense_date,description,amount,status,created_by,workflow_version) VALUES(50,10,2570,'2026-10-01','เบิกจ่ายจริง',100,'paid',1,2)`);

test('only admin/executive adjust historical spending; confirmed payment and opening attachment identity stay intact',async()=>{
 assert.equal((await patch(3,10,400,100)).status,403);assert.equal((await patch(4,10,400,100)).status,403);
 assert.equal((await patch(1,10,400,100)).status,200);const opening=db.prepare("SELECT id FROM project_expenses WHERE category='opening_balance' AND project_id=10").get().id;
 assert.equal((await patch(2,10,300,400)).status,200);
 assert.equal(db.prepare("SELECT id FROM project_expenses WHERE category='opening_balance' AND project_id=10").get().id,opening);
 assert.equal(db.prepare('SELECT amount FROM project_expenses WHERE id=50').get().amount,100);
 assert.equal((await patch(1,10,90,300)).status,409);
 assert.equal((await patch(2,10,100,300)).status,200);assert.equal(db.prepare('SELECT status FROM project_expenses WHERE id=?').get(opening).status,'cancelled');
 assert.equal((await patch(1,10,200,100)).status,200);assert.equal(db.prepare("SELECT id FROM project_expenses WHERE category='opening_balance' AND project_id=10").get().id,opening);
 assert.equal((await call(4,`/api/budget/requests/${opening}`,'PATCH',{amount:9})).status,409);
 assert.equal((await call(1,`/api/project-expenses/${opening}`,'DELETE')).status,409);
 const dashboard=await (await call(1,'/api/overview')).json();assert.equal(dashboard.total_project_spent,200);assert.equal(dashboard.funding_summary.budgets[0].spent_amount,200);
 assert.equal(db.prepare("SELECT COUNT(*) n FROM audit_logs WHERE action='adjust_opening_balance'").get().n,4);
});

test('proposal alerts both admin and executive; approval applies only the requested value once and notifies its requester',async()=>{
 let r=await call(3,'/api/projects/11/balance-requests','POST',{total_spent:250,reason:'ยอดใช้ไปแล้วจากข้อมูลเดิม'});assert.equal(r.status,201);const{id}=await r.json();
 assert.equal(db.prepare('SELECT COUNT(*) n FROM project_balance_notifications WHERE request_id=?').get(id).n,2);
 assert.equal(db.prepare('SELECT spent_amount FROM projects WHERE id=11').get().spent_amount,0);
 assert.equal((await call(4,`/api/project-balance-requests/${id}/review`,'POST',{action:'approve'})).status,403);
 const results=await Promise.all([call(1,`/api/project-balance-requests/${id}/review`,'POST',{action:'approve'}),call(2,`/api/project-balance-requests/${id}/review`,'POST',{action:'approve'})]);assert.deepEqual(results.map(r=>r.status).sort(),[200,409]);
 assert.equal(db.prepare('SELECT spent_amount FROM projects WHERE id=11').get().spent_amount,250);
 assert.equal(db.prepare('SELECT COUNT(*) n FROM project_balance_changes WHERE request_id=?').get(id).n,1);
 const own=await (await call(3,'/api/project-balance-requests')).json();assert.equal(own.requests.find(r=>r.id===id).unread,1);assert.equal(own.requests.find(r=>r.id===id).status,'approved');
 assert.equal((await call(3,'/api/project-balance-requests/read','POST',{id})).status,200);
 const inbox=await (await call(2,'/api/project-balance-requests')).json();assert.equal(inbox.can_review,true);
});

test('stale proposal cannot overwrite a newer balance; rejection unlocks a corrected request and records the review',async()=>{
 let r=await call(4,'/api/projects/12/balance-requests','POST',{total_spent:300,reason:'ตรวจยอดเดิม'});const{id}=await r.json();
 assert.equal((await call(3,'/api/projects/12/balance-requests','POST',{total_spent:400,reason:'ซ้ำ'})).status,409);
 assert.equal((await patch(1,12,100,0)).status,200);
 assert.equal((await call(2,`/api/project-balance-requests/${id}/review`,'POST',{action:'approve'})).status,409);
 assert.equal(db.prepare('SELECT spent_amount FROM projects WHERE id=12').get().spent_amount,100);
 assert.equal((await call(2,`/api/project-balance-requests/${id}/review`,'POST',{action:'reject',note:'ยอดเปลี่ยนแล้ว กรุณาส่งคำขอใหม่'})).status,200);
 r=await call(4,'/api/projects/12/balance-requests','POST',{total_spent:200,reason:'ยอดที่ตรวจแล้ว'});assert.equal(r.status,201);
 const teacherInbox=await (await call(3,'/api/project-balance-requests')).json();assert.ok(teacherInbox.requests.every(r=>r.requested_by===3));
 assert.equal((await worker.fetch(new Request('https://school.test/api/project-balance-requests'),env,{})).status,401);
});
