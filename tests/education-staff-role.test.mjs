import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
import worker from '../src/index.js';
import {signJWT,generateSalt,hashPassword} from '../src/lib/crypto.js';
import {ensureBudgetSchema} from '../src/routes/budget.js';

async function fixture(){
 const raw=new DatabaseSync(':memory:');raw.exec(fs.readFileSync(new URL('../schema.sql',import.meta.url),'utf8'));
 if(raw.limits)raw.limits.compoundSelect=5;
 const salt=generateSalt(),hash=await hashPassword('viewer-pass-1',salt);
 raw.prepare(`INSERT INTO users(id,email,password_hash,password_salt,full_name,role) VALUES
  (1,'admin@test',?,?,'ผู้ดูแล','superadmin'),(2,'teacher@test',?,?,'ครู ก','teacher'),(9,'guest@test',?,?,'ผู้ชมภายนอก',NULL)`).run(hash,salt,hash,salt,hash,salt);
 raw.exec('INSERT INTO viewer_accounts(user_id) VALUES (9)');
 function prepare(sql){let values=[];return{bind(...v){values=v;return this},async first(){return raw.prepare(sql).get(...values)||null},async all(){return{results:raw.prepare(sql).all(...values)}},async run(){const r=raw.prepare(sql).run(...values);return{meta:{changes:Number(r.changes),last_row_id:Number(r.lastInsertRowid)}}}}}
 let tail=Promise.resolve();
 const env={raw,JWT_SECRET:'viewer-test',DB:{prepare,batch(statements){const next=tail.then(async()=>{raw.exec('BEGIN');try{const out=[];for(const s of statements)out.push(await s.run());raw.exec('COMMIT');return out}catch(e){raw.exec('ROLLBACK');throw e}});tail=next.catch(()=>{});return next}},
  ASSETS:{fetch:async()=>new Response('ok')}};
 await ensureBudgetSchema(env);return env;
}
const call=async(env,path,method='GET',body,user=9)=>{const token=await signJWT({sub:user},'viewer-test');const r=await worker.fetch(new Request('https://school.test'+path,{method,headers:{Cookie:`bpd_session=${token}`,'Content-Type':'application/json'},body:body?JSON.stringify(body):undefined}),env,{waitUntil(){}});return {status:r.status,body:await r.json().catch(()=>null)};};

test('education_staff role is stored as staff and shown as บุคลากรทางการศึกษา',async()=>{
 const env=await fixture();
 const r=await call(env,'/api/admin/users/2','PATCH',{role:'education_staff'},1);
 assert.equal(r.status,200);assert.equal(r.body.user.role,'education_staff');
 assert.equal(env.raw.prepare('SELECT role FROM users WHERE id=2').get().role,'staff');
 assert.equal((await call(env,'/api/auth/me','GET',undefined,2)).body.user.role,'staff');
 assert.equal((await call(env,'/api/admin/users','GET',undefined,1)).body.users.find(u=>u.id===2).role,'education_staff');
 assert.equal((await call(env,'/api/admin/users/2','PATCH',{role:'staff'},1)).body.user.role,'staff');
 assert.equal((await call(env,'/api/admin/users','GET',undefined,1)).body.users.find(u=>u.id===2).role,'staff');
 assert.equal((await call(env,'/api/admin/users/2','PATCH',{role:'education_staff'},2)).status,403);
});
