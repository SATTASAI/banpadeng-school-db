import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { signJWT } from '../src/lib/crypto.js';
import { ensureBudgetSchema, handleBudgetRoute } from '../src/routes/budget.js';
import worker from '../src/index.js';
import { handleProjectWorkflowRoute, notifyBudgetSupportingDocument, canAccessBudgetSupportingDocument, projectFundingSummary } from '../src/routes/project-workflow.js';

const secret='project-workflow-tests';
async function fixture(){
  const raw=new DatabaseSync(':memory:');raw.exec(readFileSync(new URL('../schema.sql',import.meta.url),'utf8'));
  raw.exec(`INSERT INTO users(id,email,password_hash,password_salt,full_name,role) VALUES
    (1,'admin@test','x','x','ผู้ดูแล','superadmin'),(2,'owner@test','x','x','เจ้าของ','teacher'),
    (3,'finance@test','x','x','การเงิน','staff'),(4,'other@test','x','x','ครูอื่น','teacher'),(5,'co-owner@test','x','x','เจ้าของร่วม','teacher');
    INSERT INTO projects(id,department,name,budget_amount,fiscal_year,created_by,funding_type) VALUES
    (10,'academic','อ่านคล่อง',1000,2570,1,'subsidy'),(11,'general','เรียนฟรี',2000,2570,1,'free_education'),
    (12,'budget','งานรายได้',3000,2570,1,'school_income'),(13,'personnel','โครงการเดิม',400,2570,1,NULL);
    INSERT INTO project_owners(project_id,user_id) VALUES(10,2),(10,5),(11,2),(12,2);
    INSERT INTO budget_role_assignments(role_key,department,user_id,assigned_by) VALUES('finance_review','',3,1);`);
  function prepare(sql){let values=[];return {bind(...v){values=v;return this;},async first(){return raw.prepare(sql).get(...values)||null;},async all(){return {results:raw.prepare(sql).all(...values)};},async run(){const r=raw.prepare(sql).run(...values);return {meta:{changes:Number(r.changes),last_row_id:Number(r.lastInsertRowid)}};}};}
  let tail=Promise.resolve();
  const env={raw,JWT_SECRET:secret,DB:{prepare,batch(statements){const task=tail.then(async()=>{raw.exec('BEGIN');try{const out=[];for(const s of statements)out.push(await s.run());raw.exec('COMMIT');return out;}catch(e){raw.exec('ROLLBACK');throw e;}});tail=task.catch(()=>{});return task;}}};
  await ensureBudgetSchema(env);return env;
}
async function call(env,user,path,method='GET',body){const token=await signJWT({sub:user},secret);const r=new Request('https://school.test/api/project-documents/'+path,{method,headers:{Cookie:'bpd_session='+token,'Content-Type':'application/json'},body:body?JSON.stringify(body):undefined});const response=await handleProjectWorkflowRoute(r,env,new URL(r.url).pathname,method);return {status:response.status,body:await response.json()};}
const payload=(amount=200,project=10)=>({project_id:project,expense_date:'2026-10-01',request_purpose:'ซื้อหนังสือ',necessity:'ใช้สอน',needed_date:'2026-10-05',payee:'ร้านหนังสือ',source_type:'school_income',items:[{description:'หนังสือ',quantity:2,unit_price:amount/2,unit:'เล่ม',category:'materials'}]});
const action=(env,user,id,name,extra={})=>call(env,user,`requests/${id}/action`,'POST',{action:name,...extra});
const payment={payment_no:'PAY-2570-1',payment_date:'2026-10-02',payment_method:'transfer',payment_reference:'TXN-100',payment_recipient:'ร้านหนังสือ',withholding_tax:2};


test('submit creates finance notifications without relying on SQL changes() connection state',async()=>{
 const env=await fixture();env.raw.function('changes',()=>0);
 const draft=await call(env,2,'requests','POST',payload());assert.equal(draft.status,201);
 const sent=await action(env,2,draft.body.id,'submit');assert.equal(sent.status,200);
 assert.equal(env.raw.prepare("SELECT COUNT(*) n FROM project_notifications WHERE audience='finance'").get().n,2);
 const overview=await call(env,3,'overview');assert.equal(overview.body.projects.find(p=>p.id===10).new_request_count,1);assert.equal(overview.body.notifications.length,1);
 assert.equal((await action(env,2,draft.body.id,'submit')).status,409);
 assert.equal(env.raw.prepare("SELECT COUNT(*) n FROM project_notifications WHERE audience='finance'").get().n,2);
 assert.equal((await action(env,3,draft.body.id,'receive')).status,200);assert.equal((await action(env,3,draft.body.id,'complete')).status,200);
 assert.equal((await action(env,3,draft.body.id,'pay',payment)).status,200);
 assert.equal(env.raw.prepare('SELECT spent_amount FROM projects WHERE id=10').get().spent_amount,200);
});
async function global(env,user,path,method='GET',body){const token=await signJWT({sub:user},secret);const r=await worker.fetch(new Request('https://school.test'+path,{method,headers:{Cookie:'bpd_session='+token,'Content-Type':'application/json'},body:body?JSON.stringify(body):undefined}),env,{});return{status:r.status,body:await r.json()};}
test('queued submissions with missing events are repaired once; read notifications do not reappear',async()=>{
 const env=await fixture();const draft=await call(env,2,'requests','POST',payload());await action(env,2,draft.body.id,'submit');
 env.raw.exec("DELETE FROM project_notifications;DELETE FROM project_workflow_events");
 const before=env.raw.prepare('SELECT amount,status,current_step FROM project_expenses WHERE id=?').get(draft.body.id);
 const first=await global(env,3,'/api/notifications');assert.equal(first.status,200);assert.equal(first.body.unread_count,1);assert.equal(first.body.notifications[0].url,'/budget.html?view=otherProjects&project=10');
 assert.equal(env.raw.prepare("SELECT COUNT(*) n FROM project_workflow_events WHERE event_type='submit_recovered'").get().n,1);
 const p=await call(env,3,'overview');assert.equal(p.body.projects.find(p=>p.id===10).unread_count,1);assert.equal(p.body.projects.find(p=>p.id===10).new_request_count,1);
 assert.deepEqual(env.raw.prepare('SELECT amount,status,current_step FROM project_expenses WHERE id=?').get(draft.body.id),before);
 await global(env,3,'/api/notifications/read','POST',{all:true});
 for(let i=0;i<3;i++)assert.equal((await global(env,3,'/api/notifications')).body.unread_count,0);
 assert.equal(env.raw.prepare("SELECT COUNT(*) n FROM project_workflow_events WHERE event_type='submit_recovered'").get().n,1);
});
test('finance assigned after submission sees pending requests from every fiscal year',async()=>{
 const env=await fixture();env.raw.exec('UPDATE projects SET fiscal_year=2569 WHERE id=10');
 const draft=await call(env,2,'requests','POST',payload());await action(env,2,draft.body.id,'submit');
 assert.equal((await global(env,4,'/api/notifications')).body.unread_count,0);
 env.raw.exec("UPDATE budget_role_assignments SET user_id=4 WHERE role_key='finance_review'");
 const feed=await global(env,4,'/api/notifications');assert.equal(feed.body.unread_count,1);
 const overview=await call(env,4,'overview');assert.equal(overview.body.permissions.can_finance,true);assert.equal(overview.body.projects.find(p=>p.id===10).new_request_count,1);
 assert.equal(overview.body.requests.find(r=>r.id===draft.body.id).fiscal_year,2569);
 assert.equal((await call(env,4,'overview?fiscal_year=2570')).body.requests.length,0);
});
