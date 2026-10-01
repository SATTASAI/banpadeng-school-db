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

test('document workflow reserves funds, notifies both sides, and confirms payment exactly once',async()=>{
  const env=await fixture(),saved=await call(env,2,'requests','POST',payload());assert.equal(saved.status,201);const id=saved.body.id;
  assert.equal(env.raw.prepare('SELECT source_type FROM project_expenses WHERE id=?').get(id).source_type,'subsidy');
  assert.equal(env.raw.prepare('SELECT COUNT(*) n FROM project_notifications').get().n,0);
  assert.equal((await action(env,2,id,'submit')).status,200);
  let finance=(await call(env,3,'overview?fiscal_year=2570')).body;let p=finance.projects.find(p=>p.id===10);
  assert.equal(p.reserved_amount,200);assert.equal(p.remaining_amount,1000);assert.equal(p.available_amount,800);assert.equal(p.new_request_count,1);
  assert.equal(finance.notifications[0].event_type,'submit');assert.ok(p.unread_count);
  assert.equal((await action(env,2,id,'receive')).status,403);
  assert.equal((await action(env,3,id,'pay',payment)).status,409);
  assert.equal((await action(env,3,id,'receive')).status,200);
  assert.equal((await action(env,3,id,'complete')).status,200);
  assert.equal((await action(env,3,id,'pay',payment)).status,200);
  assert.equal((await action(env,3,id,'pay',payment)).status,409);
  const owner=(await call(env,2,'overview?department=academic&fiscal_year=2570')).body;
  p=owner.projects.find(p=>p.id===10);assert.equal(p.spent_amount,200);assert.equal(p.remaining_amount,800);assert.equal(p.reserved_amount,0);
  assert.equal(env.raw.prepare('SELECT spent_amount FROM projects WHERE id=10').get().spent_amount,200);
  assert.equal(owner.requests[0].net_paid,198);assert.equal(owner.notifications[0].event_type,'pay');
  assert.equal(env.raw.prepare("SELECT COUNT(*) n FROM project_workflow_events WHERE event_type='pay'").get().n,1);
  const summary=owner.funding_summary;assert.deepEqual(summary.budgets.map(b=>[b.key,b.total_amount,b.spent_amount,b.remaining_amount]),[['subsidy',1000,200,800],['free_education',2000,0,2000],['school_income',3000,0,3000]]);
  assert.equal(summary.unclassified.total_amount,400);
  assert.equal((await call(env,4,'overview')).body.requests.length,0);
  await call(env,2,'notifications/read','POST',{project_id:10});assert.equal((await call(env,2,'overview?department=academic')).body.projects[0].unread_count,0);
  assert.throws(()=>env.raw.prepare("UPDATE project_expenses SET amount=300 WHERE id=?").run(id),/confirmed_payment_locked/);
});

test('simultaneous submissions cannot overspend and stale actions create no duplicate alerts',async()=>{
  const env=await fixture();const a=await call(env,2,'requests','POST',payload(700)),b=await call(env,2,'requests','POST',payload(700));
  const submissions=await Promise.all([action(env,2,a.body.id,'submit'),action(env,2,b.body.id,'submit')]);
  assert.deepEqual(submissions.map(r=>r.status).sort(),[200,409]);
  const id=env.raw.prepare("SELECT id FROM project_expenses WHERE status='pending'").get().id;
  assert.equal((await action(env,2,id,'submit')).status,409);
  assert.equal(env.raw.prepare("SELECT COUNT(*) n FROM project_workflow_events WHERE event_type='submit'").get().n,1);
  assert.throws(()=>env.raw.prepare('UPDATE projects SET budget_amount=600 WHERE id=10').run(),/project_budget_exceeded/);
  const overview=(await call(env,3,'overview')).body;assert.equal(overview.projects.find(p=>p.id===10).reserved_amount,700);
});

test('returning a request releases reservation and allows an edited resubmission',async()=>{
  const env=await fixture();const saved=await call(env,2,'requests','POST',payload());const id=saved.body.id;await action(env,2,id,'submit');
  assert.equal((await action(env,3,id,'return',{review_note:'เพิ่มรายละเอียด'})).status,200);
  assert.equal((await call(env,2,'overview')).body.projects.find(p=>p.id===10).reserved_amount,0);
  assert.equal((await call(env,2,'requests/'+id,'PATCH',payload(300))).status,200);assert.equal((await action(env,2,id,'submit')).status,200);
  assert.equal((await call(env,3,'overview')).body.projects.find(p=>p.id===10).reserved_amount,300);
});

test('supplemental documents preserve every attachment and notify finance only after upload succeeds',async()=>{
  const env=await fixture();const saved=await call(env,2,'requests','POST',payload());const id=saved.body.id;
  await action(env,2,id,'submit');await action(env,3,id,'receive');await action(env,3,id,'complete');await action(env,3,id,'pay',payment);
  const first=await call(env,2,`requests/${id}/supporting-documents`,'POST',{title:'ใบเสร็จ'}),second=await call(env,5,`requests/${id}/supporting-documents`,'POST',{title:'หลักฐานเพิ่มเติม'});
  assert.equal(first.status,201);assert.equal(second.status,201);
  assert.equal(env.raw.prepare("SELECT COUNT(*) n FROM project_workflow_events WHERE event_type='attachment_added'").get().n,0);
  assert.equal(await canAccessBudgetSupportingDocument(env,{id:4,role:'teacher'},first.body.id),false);
  for(const d of [first,second]){env.raw.prepare("INSERT INTO file_attachments(entity_type,entity_id,object_key,file_name,mime_type,file_size,uploaded_by) VALUES('document',?,?,'receipt.pdf','application/pdf',10,2)").run(d.body.entity_id,'file-'+d.body.id);await notifyBudgetSupportingDocument(env,{id:2},d.body.id);}
  await notifyBudgetSupportingDocument(env,{id:2},first.body.id);
  const overview=(await call(env,3,'overview')).body;assert.equal(overview.requests[0].documents.filter(d=>d.attachment_id).length,2);
  assert.equal(overview.notifications.filter(n=>n.event_type==='attachment_added').length,2);
  assert.equal(overview.projects.find(p=>p.id===10).remaining_amount,800);
});

test('multi-owner projects do not multiply budget totals across modules',async()=>{
  const env=await fixture();const saved=await call(env,2,'requests','POST',payload(250));await action(env,2,saved.body.id,'submit');
  const token=await signJWT({sub:3},secret),request=new Request('https://school.test/api/budget/overview?fiscal_year=2570',{headers:{Cookie:'bpd_session='+token}});
  const response=await handleBudgetRoute(request,env,new URL(request.url).pathname,'GET'),body=await response.json();
  assert.equal(body.projects.find(p=>p.id===10).pending_amount,250);
  assert.deepEqual(body.funding_summary,await projectFundingSummary(env,2570));
});

test('Worker entry point enforces project funding and preserves supplemental files through the existing Drive uploader',async()=>{
  const env=await fixture();
  async function fetchAs(user,path,method='GET',body){const token=await signJWT({sub:user},secret);return worker.fetch(new Request('https://school.test'+path,{method,headers:{Cookie:'bpd_session='+token,...body instanceof FormData?{}:{'Content-Type':'application/json'}},body:body instanceof FormData?body:body?JSON.stringify(body):undefined}),env,{});}
  const ownerProjects=await fetchAs(2,'/api/departments/academic/projects');assert.equal(ownerProjects.status,200);
  assert.equal((await ownerProjects.json()).projects[0].funding_type,'subsidy');
  const invalid=await fetchAs(2,'/api/departments/general/projects','POST',{name:'โครงการใหม่'});assert.equal(invalid.status,400);
  const create=await fetchAs(2,'/api/departments/general/projects','POST',{name:'โครงการใหม่',funding_type:'free_education',fiscal_year:2570});assert.equal(create.status,201);
  const saved=await call(env,2,'requests','POST',payload());const id=saved.body.id;
  await action(env,2,id,'submit');
  assert.equal((await fetchAs(1,'/api/project-expenses/'+id,'PATCH',{status:'paid'})).status,409);
  const doc=await call(env,2,`requests/${id}/supporting-documents`,'POST',{title:'ใบเสร็จ'});
  Object.assign(env,{FILE_STORAGE_PROVIDER:'drive',GOOGLE_DRIVE_CLIENT_ID:'test-only',GOOGLE_DRIVE_CLIENT_SECRET:'test-only',GOOGLE_DRIVE_REFRESH_TOKEN:'test-only',GOOGLE_DRIVE_FOLDER_ID:'test-folder'});
  const original=globalThis.fetch;globalThis.fetch=async url=>Response.json(String(url).includes('oauth2')?{access_token:'test-only'}:String(url).includes('/upload/')?{id:'drive-file-test',webViewLink:'https://drive.example/file'}:{files:[{id:'test-folder'}]});
  try {
    const form=new FormData();form.set('file',new File(['%PDF-1.4\n%%EOF'], 'receipt.pdf',{type:'application/pdf'}));
    assert.equal((await fetchAs(4,`/api/attachments/document/${doc.body.entity_id}`,'POST',form)).status,403);
    const uploaded=await fetchAs(2,`/api/attachments/document/${doc.body.entity_id}`,'POST',form);assert.equal(uploaded.status,201);
    assert.equal((await fetchAs(2,`/api/attachments/document/${doc.body.entity_id}`,'POST',form)).status,409);
    const overview=(await call(env,3,'overview')).body;assert.equal(overview.notifications.filter(n=>n.event_type==='attachment_added').length,1);assert.equal(overview.requests[0].documents[0].file_name,'receipt.pdf');
    assert.equal((await fetchAs(2,'/api/projects/10','PATCH',{funding_type:'free_education'})).status,409);
    const overall=await fetchAs(2,'/api/overview');assert.equal(overall.status,200);assert.equal((await overall.json()).funding_summary.budgets.length,3);
  } finally {globalThis.fetch=original;}
});
