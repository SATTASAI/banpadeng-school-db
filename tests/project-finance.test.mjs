import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
import worker from '../src/index.js';
import {signJWT} from '../src/lib/crypto.js';
import {ensureBudgetSchema} from '../src/routes/budget.js';

export async function fixture(){
 const raw=new DatabaseSync(':memory:');raw.exec(readFileSync(new URL('../schema.sql',import.meta.url),'utf8'));raw.exec('ALTER TABLE projects ADD COLUMN academic_year_id INTEGER');
 raw.exec(`INSERT INTO users(id,email,password_hash,password_salt,full_name,role) VALUES
 (1,'admin@test','x','x','ผู้ดูแล','superadmin'),(2,'owner@test','x','x','ครู ก','teacher'),(3,'co@test','x','x','ครู ข','teacher');
 INSERT INTO projects(id,department,name,budget_amount,fiscal_year,created_by,funding_type) VALUES
 (10,'academic','โครงการปีเดิม',100,2569,1,'subsidy'),(11,'academic','โครงการปีใหม่',200,2570,1,'free_education');
 INSERT INTO project_owners(project_id,user_id) VALUES (10,2),(10,3),(11,2);`);
 function prepare(sql){let values=[];return{bind(...v){values=v;return this},async first(){return raw.prepare(sql).get(...values)||null},async all(){return{results:raw.prepare(sql).all(...values)}},async run(){const r=raw.prepare(sql).run(...values);return{meta:{changes:Number(r.changes),last_row_id:Number(r.lastInsertRowid)}}}}}
 let tail=Promise.resolve();const env={raw,JWT_SECRET:'dashboard-test',DB:{prepare,batch(statements){const next=tail.then(async()=>{raw.exec('BEGIN');try{const out=[];for(const s of statements)out.push(await s.run());raw.exec('COMMIT');return out}catch(e){raw.exec('ROLLBACK');throw e}});tail=next.catch(()=>{});return next}}};await ensureBudgetSchema(env);return env;
}
export async function call(env,path,method='GET',body,user=1){const token=await signJWT({sub:user},env.JWT_SECRET);return worker.fetch(new Request('https://school.test'+path,{method,headers:{Cookie:`bpd_session=${token}`,'Content-Type':'application/json'},body:body?JSON.stringify(body):undefined}),env,{})}


import {cents,money,sumMoney,projectFinancialRows,financialTotals,multiplyMoney} from '../src/lib/project-finance.js';
test('money rounds decimal half-satang and adds integer satang without binary subtraction errors',()=>{
 assert.equal(multiplyMoney(3,1.005),3.02);assert.equal(multiplyMoney(0.5,0.29),0.15);assert.equal(money('1.005'),1.01);assert.equal(money('2.675'),2.68);assert.equal(money('1.005e2'),100.5);
 assert.equal(sumMoney([0.1,0.2,-0.3]),0);assert.equal(cents('1000000000000.01'),100000000000001);
});
test('all project pages reconcile across fiscal years, owners, canceled projects and ledger statuses',async()=>{
 const env=await fixture();await call(env,'/api/overview');
 env.raw.exec(`UPDATE projects SET budget_amount=200.02 WHERE id=11;
 INSERT INTO projects(id,department,management_area,name,budget_amount,fiscal_year,created_by,funding_type,status) VALUES
 (12,'academic','early_childhood','ชื่อซ้ำ',100.01,2570,1,'school_income','cancelled');
 INSERT INTO project_expenses(project_id,fiscal_year,expense_date,description,amount,status,created_by,category,withholding_tax,net_paid) VALUES
 (11,2569,'2026-09-30','ยอดใช้เดิม',5.55,'paid',1,'opening_balance',0,NULL),
 (11,2569,'2026-09-30','จ่ายข้ามปี',6.75,'paid',1,'other',1,5.75),
 (11,2570,'2026-10-01','รอดำเนินการ',0.10,'pending',1,'other',0,NULL),
 (11,2570,'2026-10-01','อนุมัติรอจ่าย',0.20,'approved',1,'other',0,NULL),
 (11,2570,'2026-10-01','ร่าง',99.99,'draft',1,'other',0,NULL),
 (11,2570,'2026-10-01','ปฏิเสธ',99.99,'rejected',1,'other',0,NULL),
 (11,2570,'2026-10-01','ยกเลิก',99.99,'cancelled',1,'other',0,NULL),
 (12,2570,'2026-10-01','ประวัติโครงการยกเลิก',0.10,'paid',1,'other',0,NULL);
 UPDATE projects SET spent_amount=999 WHERE id=11;`);
 const overview=await (await call(env,'/api/overview?fiscal_year=2570')).json();
 assert.equal(overview.total_project_budget,300.03);assert.equal(overview.total_project_spent,12.4);assert.equal(overview.total_project_remaining,287.63);
 const dept=await (await call(env,'/api/departments/academic/projects')).json();const p=dept.projects.find(p=>p.id===11);
 assert.equal(p.spent_amount,12.3);assert.equal(p.remaining_amount,187.72);assert.equal(p.reserved_amount,0.3);assert.equal(p.available_amount,187.42);
 assert.equal(p.opening_spent_amount,5.55);assert.equal(p.confirmed_spent_amount,6.75);
 const docs=await (await call(env,'/api/project-documents/overview?fiscal_year=2570')).json();assert.equal(docs.projects.find(p=>p.id===11).available_amount,p.available_amount);
 const budget=await (await call(env,'/api/budget/overview?fiscal_year=2570')).json();assert.equal(budget.summary.paid_amount,12.4);assert.equal(budget.summary.available_amount,287.33);assert.equal(budget.projects.find(p=>p.id===11).spent_amount,12.3);
 const funds=overview.funding_summary.budgets;assert.equal(sumMoney(funds.map(p=>p.total_amount)),overview.total_project_budget);assert.equal(sumMoney(funds.map(p=>p.spent_amount)),overview.total_project_spent);
 const allDocs=await (await call(env,'/api/project-documents/overview')).json();assert.equal(sumMoney(allDocs.funding_summary.budgets.map(p=>p.total_amount)),400.03);
 const row=await projectFinancialRows(env,2570);assert.equal(financialTotals(row).available_amount,budget.summary.available_amount);
});
test('many small amounts agree with an independent integer ledger oracle',async()=>{
 const env=await fixture();await call(env,'/api/overview');let expected=0;
 for(let i=1;i<=120;i++){const n=i%29+1;env.raw.prepare("INSERT INTO project_expenses(project_id,fiscal_year,expense_date,description,amount,status,created_by) VALUES(11,2570,'2026-10-01','เศษสตางค์',?,'paid',1)").run(n/100);expected+=n;}
 const p=(await projectFinancialRows(env)).find(p=>p.id===11);assert.equal(p.spent_amount,expected/100);assert.equal(p.remaining_amount,(20000-expected)/100);
 assert.equal(env.raw.prepare('SELECT spent_amount FROM projects WHERE id=11').get().spent_amount,p.spent_amount);
});

test('legacy half-cent entries use the same rounding as new monetary values',async()=>{
 const env=await fixture();await call(env,'/api/overview');
 for(const amount of [1.005,2.675,0.145])env.raw.prepare("INSERT INTO project_expenses(project_id,fiscal_year,expense_date,description,amount,status,created_by) VALUES(11,2570,'2026-10-01','ข้อมูลเก่า',?,'paid',1)").run(amount);
 const p=(await projectFinancialRows(env)).find(p=>p.id===11);assert.equal(p.spent_amount,3.84);
 const response=await call(env,'/api/overview'),data=await response.json();assert.equal(response.status,200,JSON.stringify(data));assert.equal(data.total_project_spent,3.84);
});
