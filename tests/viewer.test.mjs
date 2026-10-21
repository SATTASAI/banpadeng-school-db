import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
import worker from '../src/index.js';
import {signJWT,generateSalt,hashPassword} from '../src/lib/crypto.js';
import {ensureBudgetSchema} from '../src/routes/budget.js';
import {viewerMayAccess,viewerExpired} from '../src/lib/auth.js';

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

test('allowlist: overview, directories, projects and timetable only; never writes',()=>{
 for(const p of ['/api/overview','/api/department-staff/academic','/api/departments/budget/projects','/api/timetable/entries','/api/supervision/permissions','/api/auth/me'])assert.equal(viewerMayAccess('GET',p),true,p);
 for(const p of ['/api/students','/api/staff','/api/search','/api/leave-requests','/api/student-support','/api/supervision/requests','/api/admin/users','/api/personnel','/api/documents','/api/budget/requests','/api/maintenance/requests'])assert.equal(viewerMayAccess('GET',p),false,p);
 for(const p of ['/api/departments/budget/projects','/api/overview','/api/timetable/slot','/api/students'])assert.equal(viewerMayAccess('POST',p),false,p);
 assert.equal(viewerMayAccess('POST','/api/auth/logout'),true);
 assert.equal(viewerExpired({role:'viewer',access_expires_at:'2026-10-20'},new Date('2026-10-20T16:59:00Z')),false,'valid until end of day Bangkok');
 assert.equal(viewerExpired({role:'viewer',access_expires_at:'2026-10-20'},new Date('2026-10-20T17:00:00Z')),true);
 assert.equal(viewerExpired({role:'teacher',access_expires_at:'2000-01-01'}),false);
});

test('viewer reads the overview without personal data and is refused everywhere else',async()=>{
 const env=await fixture();
 const overview=await call(env,'/api/overview');assert.equal(overview.status,200);assert.deepEqual(overview.body.licenses_expiring,[]);
 assert.equal((await call(env,'/api/department-staff/academic')).status,200);
 for(const p of ['/api/students','/api/staff','/api/search?q=ก','/api/leave-requests','/api/users','/api/supervision/requests?scope=all'])assert.equal((await call(env,p)).status,403,p);
 const write=await call(env,'/api/departments/academic/projects','POST',{name:'x'});assert.equal(write.status,403);assert.equal(write.body.code,'VIEWER_READ_ONLY');
 for(const p of ['/api/auth/change-password','/api/auth/logout-all','/api/auth/sessions/revoke-others'])assert.equal((await call(env,p,'POST',{current_password:'viewer-pass-1',new_password:'hijacked-123'})).status,403,p);
 assert.equal((await call(env,'/api/auth/sessions')).status,403);
 assert.equal((await call(env,'/api/supervision/permissions')).body.staff,false);
 // teachers are unaffected
 assert.equal((await call(env,'/api/departments/academic/projects','GET',undefined,2)).status,200);
});

test('administrator sets the viewer role and expiry; expired accounts cannot sign in',async()=>{
 const env=await fixture();
 assert.equal((await call(env,'/api/admin/users/2','PATCH',{access_expires_at:'2030-01-01'},2)).status,403);
 assert.equal((await call(env,'/api/admin/users/9','PATCH',{access_expires_at:'not-a-date'},1)).status,400);
 assert.equal((await call(env,'/api/admin/users/9','PATCH',{access_expires_at:'2000-01-01'},1)).status,200);
 assert.equal((await call(env,'/api/auth/me')).body.user,null);
 const login=await worker.fetch(new Request('https://school.test/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email:'guest@test',password:'viewer-pass-1'})}),env,{waitUntil(){}});
 assert.equal(login.status,403);assert.match((await login.json()).error,/หมดอายุ/);
 await call(env,'/api/admin/users/9','PATCH',{access_expires_at:null},1);
 assert.equal((await call(env,'/api/auth/me')).body.user.role,'viewer');
 const list=(await call(env,'/api/admin/users','GET',undefined,1)).body.users;assert.equal(list.find(u=>u.id===9).role,'viewer');
 // admin turns a fresh account into a viewer and back
 assert.equal((await call(env,'/api/admin/users/2','PATCH',{role:'viewer'},1)).body.user.role,'viewer');
 assert.equal((await call(env,'/api/department-staff/academic','GET',undefined,2)).status,200);
 assert.equal((await call(env,'/api/staff','GET',undefined,2)).status,403);
 assert.equal((await call(env,'/api/admin/users/2','PATCH',{access_expires_at:'2099-12-31'},1)).status,200);
 assert.equal((await call(env,'/api/admin/users/2','PATCH',{role:'teacher'},1)).body.user.role,'teacher');
 assert.equal(env.raw.prepare('SELECT COUNT(*) n FROM viewer_accounts WHERE user_id=2').get().n,0);
 assert.equal((await call(env,'/api/admin/users/2','PATCH',{access_expires_at:'2099-12-31'},1)).status,400,'expiry only for viewers');
 assert.ok([400,409].includes((await call(env,'/api/admin/users/1','PATCH',{role:'viewer'},1)).status),'cannot demote yourself');
 // fail-safe: without the viewer table row the account has no role at all
 env.raw.exec('DELETE FROM viewer_accounts WHERE user_id=9');
 assert.equal((await call(env,'/api/auth/me')).body.user.role,null);
 assert.equal((await call(env,'/api/department-staff/academic')).status,401);
});
