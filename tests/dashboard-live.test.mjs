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

const sharedEnv=await fixture();

test('dashboard includes earlier-year projects and immediately reflects allocations, income and disbursement ledgers without duplicate owners',async()=>{
 const env=sharedEnv;let response=await call(env,'/api/overview');assert.equal(response.status,200);assert.equal(response.headers.get('Cache-Control'),'no-store');let data=await response.json();assert.equal(data.total_project_budget,300);assert.equal(data.fiscal_year,null);
 const revision=data.data_revision;
 assert.equal((await call(env,'/api/projects/10','PATCH',{budget_amount:500})).status,200);
 const change=await (await call(env,'/api/overview/revision')).json();assert.notEqual(change.revision,revision);
 data=await (await call(env,'/api/overview')).json();assert.equal(data.total_project_budget,700);assert.equal(data.funding_summary.budgets[0].total_amount,500);assert.equal(data.department_summary.find(d=>d.department==='academic').total_budget,700);
 const selected=await (await call(env,'/api/overview?fiscal_year=2570')).json();assert.equal(selected.total_project_budget,200);
 env.raw.exec(`INSERT INTO budget_income(fiscal_year,received_date,source_name,source_type,amount,created_by) VALUES(2569,'2026-09-30','รับเงิน','subsidy',1000,1);
 INSERT INTO project_expenses(project_id,fiscal_year,expense_date,description,amount,status,created_by) VALUES(10,2569,'2026-09-30','จ่ายเงิน',40,'paid',1),(10,2569,'2026-09-30','รอจ่าย',20,'pending',1);`);
 data=await (await call(env,'/api/overview')).json();assert.equal(data.total_project_spent,40);assert.equal(data.total_project_remaining,660);assert.equal(data.funding_summary.budgets[0].spent_amount,40);assert.deepEqual(data.finance_summary,{received_amount:1000,paid_amount:40,reserved_amount:20,balance_amount:960});
 env.raw.exec('UPDATE projects SET spent_amount=999 WHERE id=10');data=await (await call(env,'/api/overview')).json();assert.equal(data.total_project_spent,40);
 assert.equal((await call(env,'/api/overview?fiscal_year=wrong')).status,400);
 assert.equal((await worker.fetch(new Request('https://school.test/api/overview/revision'),env,{})).status,401);
});

test('leave counts update on request, approval and deletion and selected-year days clip a cross-year leave',async()=>{
 const env=sharedEnv;const before=await (await call(env,'/api/overview')).json();
 const created=await call(env,'/api/leave-requests','POST',{leave_type:'sick',start_date:'2026-09-30',end_date:'2026-10-02'},2);assert.equal(created.status,201);const{id}=await created.json();
 let data=await (await call(env,'/api/overview')).json();assert.notEqual(data.data_revision,before.data_revision);assert.equal(data.leave_summary.pending,1);assert.equal(data.pending_leave_requests,1);
 assert.equal((await call(env,`/api/leave-requests/${id}`,'PATCH',{status:'approved'})).status,200);
 data=await (await call(env,'/api/overview')).json();assert.equal(data.leave_summary.approved,1);assert.equal(data.leave_summary.approved_days,3);assert.equal(data.pending_leave_requests,0);
 const selected=await (await call(env,'/api/overview?fiscal_year=2570')).json();assert.equal(selected.leave_summary.approved_days,2);assert.equal(selected.leave_summary.by_type[0].approved,1);
 const draft=await (await call(env,'/api/leave-requests','POST',{leave_type:'personal',start_date:'2026-10-01',end_date:'2026-10-01'},2)).json();
 assert.equal((await call(env,`/api/leave-requests/${draft.id}`,'DELETE',undefined,2)).status,200);
 data=await (await call(env,'/api/overview')).json();assert.equal(data.leave_summary.total,1);assert.equal(data.leave_summary.pending,0);
});
