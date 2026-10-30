import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { signJWT } from '../src/lib/crypto.js';
import { ensureBudgetSchema } from '../src/routes/budget.js';
import { handleProjectWorkflowRoute } from '../src/routes/project-workflow.js';

const secret='project-workflow-tests';
async function fixture(){
  const raw=new DatabaseSync(':memory:');raw.exec(readFileSync(new URL('../schema.sql',import.meta.url),'utf8'));
  raw.exec(`INSERT INTO users(id,email,password_hash,password_salt,full_name,role) VALUES
    (1,'admin@test','x','x','ผู้ดูแล','superadmin'),(2,'owner@test','x','x','เจ้าของ','teacher'),
    (3,'finance@test','x','x','การเงิน','staff'),(4,'other@test','x','x','ครูอื่น','teacher'),(5,'co-owner@test','x','x','เจ้าของร่วม','teacher'),(6,'director@test','x','x','ผู้อำนวยการ','executive');
    INSERT INTO projects(id,department,name,budget_amount,fiscal_year,created_by,funding_type) VALUES
    (10,'academic','อ่านคล่อง',1000,2570,1,'subsidy'),(11,'general','เรียนฟรี',2000,2570,1,'free_education'),
    (12,'budget','งานรายได้',3000,2570,1,'school_income'),(13,'personnel','โครงการเดิม',400,2570,1,NULL);
    INSERT INTO project_owners(project_id,user_id) VALUES(10,2),(10,5),(11,2),(12,2);
    INSERT INTO budget_role_assignments(role_key,department,user_id,assigned_by) VALUES('finance_review','',3,1),('director_approval','',6,1);`);
  function prepare(sql){let values=[];return {bind(...v){values=v;return this;},async first(){return raw.prepare(sql).get(...values)||null;},async all(){return {results:raw.prepare(sql).all(...values)};},async run(){const r=raw.prepare(sql).run(...values);return {meta:{changes:Number(r.changes),last_row_id:Number(r.lastInsertRowid)}};}};}
  let tail=Promise.resolve();
  const env={raw,JWT_SECRET:secret,DB:{prepare,batch(statements){const task=tail.then(async()=>{raw.exec('BEGIN');try{const out=[];for(const s of statements)out.push(await s.run());raw.exec('COMMIT');return out;}catch(e){raw.exec('ROLLBACK');throw e;}});tail=task.catch(()=>{});return task;}}};
  await ensureBudgetSchema(env);return env;
}
async function call(env,user,path,method='GET',body){const token=await signJWT({sub:user},secret);const r=new Request('https://school.test/api/project-documents/'+path,{method,headers:{Cookie:'bpd_session='+token,'Content-Type':'application/json'},body:body?JSON.stringify(body):undefined});const response=await handleProjectWorkflowRoute(r,env,new URL(r.url).pathname,method);return {status:response.status,body:await response.json()};}
const payload=(amount=200,project=10)=>({project_id:project,expense_date:'2026-10-01',request_purpose:'ซื้อหนังสือ',necessity:'ใช้สอน',needed_date:'2026-10-05',payee:'ร้านหนังสือ',source_type:'school_income',items:[{description:'หนังสือ',quantity:2,unit_price:amount/2,unit:'เล่ม',category:'materials'}]});
const action=(env,user,id,name,extra={})=>call(env,user,`requests/${id}/action`,'POST',{action:name,...extra});
const payment={payment_no:'PAY-2570-1',payment_date:'2026-10-02',payment_method:'transfer',payment_reference:'TXN-100',payment_recipient:'ร้านหนังสือ',withholding_tax:2};


async function memo(env,user,id){const token=await signJWT({sub:user},secret);const r=new Request(`https://school.test/api/project-documents/requests/${id}/memo`,{headers:{Cookie:'bpd_session='+token}});const res=await handleProjectWorkflowRoute(r,env,new URL(r.url).pathname,'GET');return {status:res.status,text:await res.text()};}
function addApprovers(env){env.raw.exec(`INSERT INTO users(id,email,password_hash,password_salt,full_name,role) VALUES
  (7,'head@test','x','x','นายหัวหน้า วิชาการ','teacher'),(8,'dep@test','x','x','นางสาวรอง วิชาการ','executive'),(9,'bhead@test','x','x','นางหัวหน้า งบประมาณ','teacher'),(10,'bdep@test','x','x','นายรอง งบประมาณ','executive'),(11,'proc@test','x','x','นายพัสดุ ทดสอบ','staff');
  INSERT INTO budget_role_assignments(role_key,department,user_id,assigned_by) VALUES('department_head','academic',7,1),('deputy_director','academic',8,1),('department_head','budget',9,1),('deputy_director','budget',10,1),('procurement_officer','',11,1);`);}

test('six-step memo approval follows approver settings and fills the printed form',async()=>{
  const env=await fixture();addApprovers(env);
  const id=(await call(env,2,'requests','POST',payload())).body.id;
  assert.equal((await action(env,2,id,'submit')).status,200);
  const step=()=>env.raw.prepare('SELECT current_step FROM project_expenses WHERE id=?').get(id).current_step;
  assert.equal(step(),'dept_head_review');
  let head=(await call(env,7,'overview?fiscal_year=2570')).body.requests.find(r=>r.id===id);
  assert.ok(head.can_review);assert.equal(head.review_step,'dept_head');
  assert.equal((await action(env,8,id,'review_approve')).status,403);
  assert.equal((await action(env,7,id,'review_approve')).status,400);
  assert.equal((await action(env,3,id,'receive')).status,409);
  assert.equal((await action(env,7,id,'review_approve',{plan_status:'in_plan'})).status,200);
  assert.equal(step(),'dept_deputy_review');
  assert.equal((await action(env,8,id,'review_approve')).status,200);
  assert.equal(step(),'finance_queue');
  assert.equal((await action(env,3,id,'receive')).status,200);
  assert.equal((await action(env,3,id,'complete')).status,200);
  assert.equal(step(),'budget_head_review');
  assert.equal((await action(env,9,id,'review_approve')).status,200);
  assert.equal(step(),'budget_deputy_review');
  assert.equal((await action(env,6,id,'approve')).status,409);
  assert.equal((await action(env,10,id,'review_approve')).status,200);
  assert.equal(step(),'director_approval');
  assert.equal((await action(env,6,id,'approve')).status,200);
  const doc=await memo(env,2,id);assert.equal(doc.status,200);
  for(const name of ['นายหัวหน้า วิชาการ','นางสาวรอง วิชาการ','การเงิน','นางหัวหน้า งบประมาณ','นายรอง งบประมาณ','ผู้อำนวยการ','นายพัสดุ ทดสอบ','อ่านคล่อง','สองร้อยบาทถ้วน'])assert.ok(doc.text.includes(name),name);
  assert.equal((await memo(env,4,id)).status,403);
  assert.equal((await memo(env,11,id)).status,200);
  const states=env.raw.prepare('SELECT step_key,status FROM project_expense_signoffs WHERE expense_id=? ORDER BY step_order').all(id).map(r=>r.status);
  assert.deepEqual(states,['approved','approved','approved','approved','approved','approved']);
});

test('reviewer return sends draft back and resubmission rebuilds the chain; requester-as-head is skipped',async()=>{
  const env=await fixture();addApprovers(env);
  const id=(await call(env,2,'requests','POST',payload())).body.id;
  await action(env,2,id,'submit');
  assert.equal((await action(env,7,id,'review_return')).status,400);
  assert.equal((await action(env,7,id,'review_return',{review_note:'แก้ราคา'})).status,200);
  assert.equal(env.raw.prepare('SELECT status FROM project_expenses WHERE id=?').get(id).status,'draft');
  assert.equal((await action(env,2,id,'submit')).status,200);
  assert.equal(env.raw.prepare("SELECT status FROM project_expense_signoffs WHERE expense_id=? AND step_key='dept_head'").get(id).status,'pending');
  env.raw.exec("UPDATE budget_role_assignments SET user_id=2 WHERE role_key='department_head' AND department='academic'");
  const id2=(await call(env,2,'requests','POST',payload(100))).body.id;
  await action(env,2,id2,'submit');
  assert.equal(env.raw.prepare('SELECT current_step FROM project_expenses WHERE id=?').get(id2).current_step,'dept_deputy_review');
});
