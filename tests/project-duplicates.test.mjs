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

test('creation and editing allow shared names and require confirmation for matching details',async()=>{
 const base={name:'กิจกรรมชื่อเดียวกัน',fiscal_year:2570,budget_amount:1000,description:'รายละเอียดแรก',funding_type:'subsidy',owner_ids:[3]};
 const create=body=>call(1,'/api/departments/academic/projects','POST',body);
 let r=await create(base);assert.equal(r.status,201);const first=await r.json();
 r=await create({...base,description:'รายละเอียดสอง'});assert.equal(r.status,201);const second=await r.json();assert.notEqual(second.id,first.id);
 r=await create(base);assert.equal(r.status,409);assert.equal((await r.json()).code,'duplicate_project');
 const count=db.prepare('SELECT COUNT(*) n FROM projects').get().n;
 r=await create({...base,confirm_duplicate:true});assert.equal(r.status,201);assert.notEqual((await r.json()).id,first.id);
 assert.equal(db.prepare('SELECT COUNT(*) n FROM projects').get().n,count+1);
 r=await call(1,`/api/projects/${second.id}`,'PATCH',{description:base.description});assert.equal(r.status,409);
 assert.equal(db.prepare('SELECT description FROM projects WHERE id=?').get(second.id).description,'รายละเอียดสอง');
 r=await call(1,`/api/projects/${second.id}`,'PATCH',{description:base.description,confirm_duplicate:true});assert.equal(r.status,200);
 assert.equal(db.prepare('SELECT description FROM projects WHERE id=?').get(first.id).description,base.description);
 r=await call(3,'/api/departments/general/projects','POST',{...base,owner_ids:[1],budget_amount:5000});assert.equal(r.status,201);
 const teacher=await r.json();assert.equal(db.prepare('SELECT budget_amount FROM projects WHERE id=?').get(teacher.id).budget_amount,0);
 assert.equal(db.prepare('SELECT user_id FROM project_owners WHERE project_id=?').get(teacher.id).user_id,3);
});
