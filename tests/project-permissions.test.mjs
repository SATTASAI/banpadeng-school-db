import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
import worker from '../src/index.js';
import {signJWT} from '../src/lib/crypto.js';
import {ensureBudgetSchema} from '../src/routes/budget.js';

async function fixture(){
 const raw=new DatabaseSync(':memory:');raw.exec(readFileSync('schema.sql','utf8'));
 raw.exec(`INSERT INTO users(id,email,password_hash,password_salt,full_name,role,status) VALUES
 (1,'admin@test','x','x','ผู้ดูแล','superadmin','active'),(2,'teacher@test','x','x','ครูเจ้าของ','teacher','active'),
 (3,'other@test','x','x','ครูอื่น','teacher','active'),(4,'executive@test','x','x','ผู้บริหาร','executive','active'),
 (5,'finance@test','x','x','การเงิน','staff','active'),(6,'inactive@test','x','x','ปิดบัญชี','teacher','disabled'),
 (7,'viewer@test','x','x','รออนุมัติ',NULL,'active');
 INSERT INTO projects(id,department,name,budget_amount,fiscal_year,created_by,funding_type) VALUES
 (10,'academic','โครงการอ่าน 2569',100,2569,1,'subsidy'),(11,'general','โครงการดูแล 2570',200,2570,1,'subsidy'),(12,'budget','โครงการซ่อน 2570',300,2570,1,'subsidy');
 INSERT INTO project_owners(project_id,user_id) VALUES(10,2),(11,3);
 INSERT INTO budget_role_assignments(role_key,department,user_id) VALUES('finance_review','',5);`);
 function prepare(sql){let args=[];return {bind(...v){args=v;return this},async first(){return raw.prepare(sql).get(...args)||null},async all(){return {results:raw.prepare(sql).all(...args)}},async run(){if(/^\s*(SELECT|WITH)\b/i.test(sql))return {results:raw.prepare(sql).all(...args)};const v=raw.prepare(sql).run(...args);return {meta:{changes:Number(v.changes),last_row_id:Number(v.lastInsertRowid)}}}}}
 let pending=Promise.resolve();const env={raw,JWT_SECRET:'project-access-test',DB:{prepare,batch(statements){const operation=pending.then(async()=>{raw.exec('BEGIN');try{const rows=[];for(const s of statements)rows.push(await s.run());raw.exec('COMMIT');return rows}catch(e){raw.exec('ROLLBACK');throw e}});pending=operation.catch(()=>{});return operation}}};await ensureBudgetSchema(env);return env;
}
async function call(env,user,path,method='GET',body){const token=await signJWT({sub:user},env.JWT_SECRET);const res=await worker.fetch(new Request('https://school.test'+path,{method,headers:{Cookie:'bpd_session='+token,'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)}),env,{});return {status:res.status,body:await res.json()};}

test('catalog, dashboard, search, financial totals and direct file access enforce project ownership',async()=>{
 const env=await fixture();
 for(const user of [2,3,5]){
   const expected=user===2?[10]:user===3?[11]:[];
   const overview=await call(env,user,'/api/project-documents/overview');assert.equal(overview.status,200);assert.deepEqual(overview.body.projects.map(p=>p.id),expected);
   const dashboard=await call(env,user,'/api/overview');assert.equal(dashboard.status,200);assert.deepEqual(dashboard.body.department_summary.flatMap(d=>d.projects).map(p=>p.id),expected);
   const found=await call(env,user,'/api/search?q='+encodeURIComponent('โครงการ'));assert.equal(found.status,200,JSON.stringify(found.body));assert.equal(found.body.results.filter(r=>r.type==='project').length,expected.length);
 }
 assert.deepEqual((await call(env,2,'/api/budget/overview?fiscal_year=2570')).body.projects,[]);
 assert.equal((await call(env,2,'/api/budget/overview?fiscal_year=2570')).body.funding_summary.budgets.reduce((s,b)=>s+b.total_amount,0),0);
 assert.deepEqual((await call(env,2,'/api/departments/general/projects')).body.projects,[]);
 assert.equal((await call(env,2,'/api/projects/11/files')).status,403);
 assert.equal((await call(env,2,'/api/projects/11/expenses')).status,403);
 for(const user of [1,4])assert.equal((await call(env,user,'/api/project-documents/overview')).body.projects.length,3);
});

test('settings lists every school project and active account; reassignment immediately changes visibility and names',async()=>{
 const env=await fixture();assert.equal((await call(env,2,'/api/projects/settings')).status,403);
 for(const user of [1,4]){
   const result=await call(env,user,'/api/projects/settings');assert.equal(result.status,200);assert.equal(result.body.projects.length,3);assert(!result.body.users.some(u=>[6,7].includes(u.id)));
 }
 assert.equal((await call(env,1,'/api/projects/10','PATCH',{owner_ids:[3,3],name:'โครงการอ่านใหม่',department:'early_childhood'})).status,200);
 assert.deepEqual(env.raw.prepare('SELECT user_id FROM project_owners WHERE project_id=10').all().map(o=>o.user_id),[3]);
 assert.deepEqual((await call(env,2,'/api/departments/academic/projects')).body.projects,[]);
 const mine=await call(env,3,'/api/departments/early_childhood/projects');assert.equal(mine.body.projects[0].name,'โครงการอ่านใหม่');assert.equal(mine.body.projects[0].owners[0].user_id,3);
 env.raw.exec("UPDATE users SET full_name='ชื่อครูปรับปรุง' WHERE id=3");
 assert.match((await call(env,1,'/api/projects/settings')).body.projects.find(p=>p.id===10).owner_names,/ชื่อครูปรับปรุง/);
 assert.equal((await call(env,1,'/api/projects/10','PATCH',{owner_ids:[]})).status,200);
 assert.deepEqual((await call(env,3,'/api/departments/early_childhood/projects')).body.projects,[]);
});

test('invalid ownership edits preserve the previous assignments and project data atomically',async()=>{
 const env=await fixture();
 for(const ids of [[6],[7],[999],[-1],['bad'],'invalid']){
   assert.equal((await call(env,1,'/api/projects/10','PATCH',{owner_ids:ids,name:'ห้ามเปลี่ยน'})).status,400);
   assert.equal(env.raw.prepare('SELECT name FROM projects WHERE id=10').get().name,'โครงการอ่าน 2569');
   assert.equal(env.raw.prepare('SELECT user_id FROM project_owners WHERE project_id=10').get().user_id,2);
 }
 assert.equal((await call(env,2,'/api/projects/10','PATCH',{owner_ids:[3]})).status,403);
 assert.equal((await call(env,1,'/api/projects/999','PATCH',{name:'missing',confirm_duplicate:true})).status,404);
 env.raw.exec("CREATE TRIGGER fail_new_owner BEFORE INSERT ON project_owners WHEN NEW.user_id=3 BEGIN SELECT RAISE(ABORT,'simulated failure'); END");
 assert.equal((await call(env,1,'/api/projects/10','PATCH',{name:'เปลี่ยนพร้อมเจ้าของ',owner_ids:[3]})).status,500);
 assert.equal(env.raw.prepare('SELECT name FROM projects WHERE id=10').get().name,'โครงการอ่าน 2569');
 assert.equal(env.raw.prepare('SELECT user_id FROM project_owners WHERE project_id=10').get().user_id,2);
});

test('admins can delete uncommitted projects while paid and pending ledgers are protected',async()=>{
 const env=await fixture();assert.equal((await call(env,2,'/api/projects/10','DELETE')).status,403);
 assert.equal((await call(env,1,'/api/projects/10','DELETE')).status,200);
 env.raw.exec("INSERT INTO project_expenses(project_id,fiscal_year,expense_date,description,amount,status,created_by) VALUES(11,2570,'2026-11-08','ผูกพัน',50,'pending',1)");
 assert.equal((await call(env,1,'/api/projects/11','DELETE')).status,409);
 assert.equal(env.raw.prepare('SELECT COUNT(*) n FROM project_owners WHERE project_id=11').get().n,1);
});

test('school-wide catalogs and request details stay below the D1 parameter limit',async()=>{
 const env=await fixture();
 for(let i=0;i<120;i++){
   const id=1000+i;
   env.raw.prepare("INSERT INTO projects(id,department,name,budget_amount,fiscal_year,created_by,funding_type) VALUES(?,'academic',?,100,2570,1,'subsidy')").run(id,'โครงการ '+i);
   env.raw.prepare('INSERT INTO project_owners(project_id,user_id) VALUES(?,2)').run(id);
   env.raw.prepare("INSERT INTO project_expenses(project_id,fiscal_year,expense_date,description,amount,status,created_by,workflow_version) VALUES(?,2570,'2026-11-08','ร่าง',1,'draft',2,2)").run(id);
 }
 const prepare=env.DB.prepare;env.DB.prepare=sql=>{const statement=prepare(sql),bind=statement.bind;statement.bind=(...args)=>{assert(args.length<=100,'D1 bound parameter limit exceeded');return bind.apply(statement,args);};return statement;};
 const catalog=await call(env,2,'/api/departments/academic/projects');assert.equal(catalog.status,200);assert.equal(catalog.body.projects.length,121);
 const tasks=await call(env,2,'/api/project-documents/overview');assert.equal(tasks.status,200);assert.equal(tasks.body.requests.length,120);
});
