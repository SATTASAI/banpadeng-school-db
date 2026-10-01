import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { handlePasswordResetRoute } from '../src/routes/password-reset.js';
import { generateSalt,hashPassword,verifyPassword,signJWT } from '../src/lib/crypto.js';
import { getCurrentUser } from '../src/lib/auth.js';

async function fixture() {
 const raw=new DatabaseSync(':memory:');
 raw.exec(`CREATE TABLE users(id INTEGER PRIMARY KEY,email TEXT,full_name TEXT,role TEXT,status TEXT,password_hash TEXT,password_salt TEXT,
 session_version INTEGER DEFAULT 1,password_changed_at TEXT,last_login_at TEXT,created_at TEXT DEFAULT(datetime('now')));
 CREATE TABLE audit_logs(user_id INTEGER,action TEXT,resource TEXT,resource_id INTEGER,details TEXT,ip_address TEXT);`);
 const salt=generateSalt(),hash=await hashPassword('old-password',salt);
 raw.prepare("INSERT INTO users(id,email,full_name,role,status,password_hash,password_salt) VALUES (1,'owner@example.invalid','ครู','teacher','active',?,?)").run(hash,salt);
 function prepare(sql){let values=[];return{bind(...v){values=v;return this},async first(){return raw.prepare(sql).get(...values)||null},async all(){return{results:raw.prepare(sql).all(...values)}},async run(){const r=raw.prepare(sql).run(...values);return{meta:{changes:Number(r.changes),last_row_id:Number(r.lastInsertRowid)}}}}}
 return {raw,DB:{prepare,async batch(statements){raw.exec('BEGIN');try{const result=[];for(const s of statements)result.push(await s.run());raw.exec('COMMIT');return result}catch(e){raw.exec('ROLLBACK');throw e}}},JWT_SECRET:'reset-test',RESEND_API_KEY:'fake-test-key',PASSWORD_RESET_FROM:'School <noreply@example.invalid>'};
}
function call(env,path,body,ip='test-ip'){return handlePasswordResetRoute(new Request('https://school.example'+path,{method:body?'POST':'GET',headers:{'Content-Type':'application/json','CF-Connecting-IP':ip},body:body?JSON.stringify(body):undefined}),env,path,body?'POST':'GET')}
async function withMail(fn,ok=true){const original=globalThis.fetch,mail=[];globalThis.fetch=async(url,options)=>{assert.equal(url,'https://api.resend.com/emails');mail.push(JSON.parse(options.body));return new Response('{}',{status:ok?200:503})};try{await fn(mail)}finally{globalThis.fetch=original}}
const tokenOf=mail=>mail[0].text.match(/#token=([a-f0-9]{64})/)[1];

test('recovery sends a single-use expiring link, hashes the token and revokes old sessions',async()=>withMail(async mail=>{
 const env=await fixture(),oldSession=await signJWT({sub:1,sv:1},env.JWT_SECRET);
 const response=await call(env,'/api/auth/forgot-password',{email:' OWNER@example.invalid '});assert.equal(response.status,200);assert.equal(mail.length,1);
 const token=tokenOf(mail),stored=env.raw.prepare('SELECT * FROM auth_password_resets').get();assert.notEqual(stored.token_hash,token);assert.equal(mail[0].to[0],'owner@example.invalid');
 const paid=await call(env,'/api/auth/reset-password',{token,new_password:'new-password'});assert.equal(paid.status,200);
 assert.match(paid.headers.get('Set-Cookie'),/Max-Age=0/);
 const user=env.raw.prepare('SELECT * FROM users').get();assert.equal(await verifyPassword('new-password',user.password_salt,user.password_hash),true);assert.equal(user.session_version,2);
 assert.equal(await getCurrentUser(new Request('https://school.example',{headers:{Cookie:`bpd_session=${oldSession}`}}),env),null);
 assert.equal((await call(env,'/api/auth/reset-password',{token,new_password:'replacement-password'})).status,400);
 assert.equal(env.raw.prepare("SELECT COUNT(*) n FROM audit_logs WHERE action='reset_password'").get().n,1);
}));

test('unknown and suspended addresses get the same reply and email/IP throttles prevent spam',async()=>withMail(async mail=>{
 const env=await fixture();const known=await call(env,'/api/auth/forgot-password',{email:'owner@example.invalid'});
 const unknown=await call(env,'/api/auth/forgot-password',{email:'unknown@example.invalid'});assert.deepEqual(await known.json(),await unknown.json());
 env.raw.exec("UPDATE users SET status='suspended'");
 const suspended=await call(env,'/api/auth/forgot-password',{email:'owner@example.invalid'},'second-ip');assert.equal(suspended.status,200);assert.equal(mail.length,1);
 for(let i=0;i<8;i++)assert.equal((await call(env,'/api/auth/forgot-password',{email:'unknown@example.invalid'})).status,200);
 assert.equal((await call(env,'/api/auth/forgot-password',{email:'unknown@example.invalid'})).status,429);
}));

test('expired links and links issued before a password change cannot update credentials',async()=>withMail(async mail=>{
 const env=await fixture();await call(env,'/api/auth/forgot-password',{email:'owner@example.invalid'});const token=tokenOf(mail);
 env.raw.exec("UPDATE auth_password_resets SET expires_at=datetime('now','-1 minute')");assert.equal((await call(env,'/api/auth/reset-password',{token,new_password:'new-password'})).status,400);
 env.raw.exec("UPDATE auth_password_resets SET expires_at=datetime('now','+30 minutes');UPDATE users SET session_version=2");assert.equal((await call(env,'/api/auth/reset-password',{token,new_password:'new-password'})).status,400);
 assert.equal(env.raw.prepare('SELECT COUNT(*) n FROM audit_logs').get().n,0);
}));

test('missing mail configuration is explicit and failed delivery leaves no usable token',async()=>withMail(async mail=>{
 const env=await fixture();delete env.RESEND_API_KEY;
 assert.equal((await call(env,'/api/auth/password-reset-status')).status,200);assert.equal((await (await call(env,'/api/auth/password-reset-status')).json()).available,false);
 assert.equal((await call(env,'/api/auth/forgot-password',{email:'owner@example.invalid'})).status,503);assert.equal(mail.length,0);
 env.RESEND_API_KEY='fake-key';assert.equal((await call(env,'/api/auth/forgot-password',{email:'owner@example.invalid'})).status,200);
 assert.equal(env.raw.prepare('SELECT COUNT(*) n FROM auth_password_resets').get().n,0);
},false));

test('replacement links invalidate older links and a rapid duplicate request sends no second email',async()=>withMail(async mail=>{
 const env=await fixture();await call(env,'/api/auth/forgot-password',{email:'owner@example.invalid'});const oldToken=tokenOf(mail);
 await call(env,'/api/auth/forgot-password',{email:'owner@example.invalid'});assert.equal(mail.length,1);
 env.raw.exec("UPDATE auth_reset_throttles SET last_requested_at=datetime('now','-2 minutes')");await call(env,'/api/auth/forgot-password',{email:'owner@example.invalid'});assert.equal(mail.length,2);
 assert.equal((await call(env,'/api/auth/reset-password',{token:oldToken,new_password:'new-password'})).status,400);
 const newToken=mail[1].text.match(/#token=([a-f0-9]{64})/)[1];assert.equal((await call(env,'/api/auth/reset-password',{token:newToken,new_password:'new-password'})).status,200);
}));
