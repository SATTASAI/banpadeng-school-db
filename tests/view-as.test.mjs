import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
import worker from '../src/index.js';
import {signJWT} from '../src/lib/crypto.js';
import {ensureSessionSchema} from '../src/lib/auth-sessions.js';

async function fixture(){
 const raw=new DatabaseSync(':memory:');raw.exec(fs.readFileSync(new URL('../schema.sql',import.meta.url),'utf8'));
 if(raw.limits)raw.limits.compoundSelect=5;
 raw.exec(`INSERT INTO users(id,email,password_hash,password_salt,full_name,role) VALUES
  (1,'admin@test','x','x','ผู้ดูแล','superadmin'),(2,'teacher@test','x','x','ครู ก','teacher'),(3,'exec@test','x','x','ผอ.','executive'),(4,'off@test','x','x','ครูพักงาน','teacher')`);
 raw.exec(`UPDATE users SET status='disabled' WHERE id=4`);
 function prepare(sql){let values=[];return{bind(...v){values=v;return this},async first(){return raw.prepare(sql).get(...values)||null},async all(){return{results:raw.prepare(sql).all(...values)}},async run(){const r=raw.prepare(sql).run(...values);return{meta:{changes:Number(r.changes),last_row_id:Number(r.lastInsertRowid)}}}}}
 let tail=Promise.resolve();
 const env={raw,JWT_SECRET:'view-as-test',DB:{prepare,batch(statements){const next=tail.then(async()=>{raw.exec('BEGIN');try{const out=[];for(const s of statements)out.push(await s.run());raw.exec('COMMIT');return out}catch(e){raw.exec('ROLLBACK');throw e}});tail=next.catch(()=>{});return next}},
  ASSETS:{fetch:async()=>new Response('ok')}};
 await ensureSessionSchema(env);
 for(const [sid,uid] of [['a'.repeat(48),1],['b'.repeat(48),1],['c'.repeat(48),3]])raw.prepare(`INSERT INTO auth_sessions(id,user_id,app,device_hash) VALUES(?,?,'system','d')`).run(sid,uid);
 return env;
}
const tokens={};
async function call(env,path,method='GET',body,{user=1,sid='a'.repeat(48)}={}){
 const token=await signJWT({sub:user,sid},'view-as-test');
 const r=await worker.fetch(new Request('https://school.test'+path,{method,headers:{Cookie:`bpd_session=${token}`,'Content-Type':'application/json'},body:body?JSON.stringify(body):undefined}),env,{waitUntil(){}});
 return {status:r.status,body:await r.json().catch(()=>null)};
}

test('superadmin views the system as another account, read-only, on this session only',async()=>{
 const env=await fixture();
 assert.equal((await call(env,'/api/auth/me')).body.user.role,'superadmin');
 const start=await call(env,'/api/admin/view-as','POST',{user_id:2});
 assert.equal(start.status,200);assert.equal(start.body.active.target.id,2);assert.equal(start.body.active.admin.id,1);
 const me=(await call(env,'/api/auth/me')).body.user;
 assert.equal(me.id,2);assert.equal(me.role,'teacher');assert.equal(me.is_admin,false);assert.equal(me.view_as.read_only,true);
 // permissions follow the target account
 assert.equal((await call(env,'/api/admin/users')).status,403);
 // writes are refused while viewing as someone else
 const write=await call(env,'/api/departments/academic/projects','POST',{name:'ทดสอบ'});
 assert.equal(write.status,403);assert.equal(write.body.code,'VIEW_AS_READ_ONLY');
 assert.equal((await call(env,'/api/auth/change-password','POST',{current_password:'x',new_password:'yyyyyyyy'})).status,403);
 assert.equal(env.raw.prepare('SELECT COUNT(*) n FROM projects').get().n,0);
 // the admin's other device is not affected
 assert.equal((await call(env,'/api/auth/me','GET',undefined,{sid:'b'.repeat(48)})).body.user.id,1);
 // switch directly to another account, then stop
 assert.equal((await call(env,'/api/admin/view-as/candidates')).body.users.some(u=>u.id===3),true);
 assert.equal((await call(env,'/api/admin/view-as','POST',{user_id:3})).body.active.target.id,3);
 assert.equal((await call(env,'/api/auth/me')).body.user.id,3);
 assert.equal((await call(env,'/api/admin/view-as','DELETE')).body.ended,true);
 assert.equal((await call(env,'/api/auth/me')).body.user.id,1);
 const actions=env.raw.prepare("SELECT action,resource_id FROM audit_logs WHERE resource='view_as' ORDER BY id").all().map(r=>r.action+':'+r.resource_id);
 assert.deepEqual(actions,['view_as_start:2','view_as_start:3','view_as_end:3']);
});

test('only superadmins may use it; never self, disabled accounts, or after demotion/expiry',async()=>{
 const env=await fixture();
 assert.equal((await call(env,'/api/admin/view-as','POST',{user_id:2},{user:3,sid:'c'.repeat(48)})).status,403);
 assert.equal((await call(env,'/api/admin/view-as','POST',{user_id:2},{user:2})).status,401);
 assert.equal((await call(env,'/api/admin/view-as','POST',{user_id:1})).status,400);
 assert.equal((await call(env,'/api/admin/view-as','POST',{user_id:4})).status,400);
 assert.equal((await call(env,'/api/admin/view-as','POST',{user_id:999})).status,404);
 await call(env,'/api/admin/view-as','POST',{user_id:2});
 env.raw.exec("UPDATE admin_view_as SET expires_at=datetime('now','-1 minute')");
 assert.equal((await call(env,'/api/auth/me')).body.user.id,1,'expired view returns to the admin');
 await call(env,'/api/admin/view-as','POST',{user_id:2});
 env.raw.exec("UPDATE users SET role='teacher' WHERE id=1");
 assert.equal((await call(env,'/api/auth/me')).body.user.id,1,'demoted admin no longer views as others');
});

test('logging out while viewing ends the view and signs the admin out',async()=>{
 const env=await fixture();
 await call(env,'/api/admin/view-as','POST',{user_id:2});
 assert.equal((await call(env,'/api/auth/logout','POST')).status,200);
 assert.equal(env.raw.prepare('SELECT COUNT(*) n FROM admin_view_as').get().n,0);
 assert.ok(env.raw.prepare(`SELECT revoked_at FROM auth_sessions WHERE id=?`).get('a'.repeat(48)).revoked_at);
});
