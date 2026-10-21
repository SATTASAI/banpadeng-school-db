import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
import worker from '../src/index.js';
import {signJWT,generateSalt,hashPassword} from '../src/lib/crypto.js';
import {ensureBudgetSchema} from '../src/routes/budget.js';
import {describeDevice,applySecurityHeaders,CONTENT_SECURITY_POLICY} from '../src/lib/auth-sessions.js';

const CHROME_WIN='Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36';
const SAFARI_IPHONE='Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';

async function fixture(extra={}){
 const raw=new DatabaseSync(':memory:');raw.exec(fs.readFileSync(new URL('../schema.sql',import.meta.url),'utf8'));
 if(raw.limits)raw.limits.compoundSelect=5;
 const salt=generateSalt(),hash=await hashPassword('correct-horse',salt);
 raw.prepare(`INSERT INTO users(id,email,password_hash,password_salt,full_name,role) VALUES
  (1,'admin@test',?,?,'ผู้ดูแล','superadmin'),(2,'teacher@test',?,?,'ครู ก','teacher'),(3,'admin2@test',?,?,'ผู้ดูแลสอง','superadmin')`).run(hash,salt,hash,salt,hash,salt);
 function prepare(sql){let values=[];return{bind(...v){values=v;return this},async first(){return raw.prepare(sql).get(...values)||null},async all(){return{results:raw.prepare(sql).all(...values)}},async run(){const r=raw.prepare(sql).run(...values);return{meta:{changes:Number(r.changes),last_row_id:Number(r.lastInsertRowid)}}}}}
 let tail=Promise.resolve();
 const env={raw,JWT_SECRET:'sessions-test',...extra,DB:{prepare,batch(statements){const next=tail.then(async()=>{raw.exec('BEGIN');try{const out=[];for(const s of statements)out.push(await s.run());raw.exec('COMMIT');return out}catch(e){raw.exec('ROLLBACK');throw e}});tail=next.catch(()=>{});return next}},
  ASSETS:{fetch:async()=>new Response('<!doctype html><title>x</title>',{headers:{'Content-Type':'text/html; charset=utf-8'}})}};
 await ensureBudgetSchema(env);return env;
}
const cookieOf=res=>(res.headers.get('Set-Cookie')||'').match(/bpd_session=([^;]*)/)?.[1]||'';
async function req(env,path,{method='GET',body,cookie,ua=CHROME_WIN,ip='203.0.113.5'}={}){
 return worker.fetch(new Request('https://school.test'+path,{method,headers:{'Content-Type':'application/json','User-Agent':ua,'CF-Connecting-IP':ip,...(cookie?{Cookie:`bpd_session=${cookie}`}:{})},body:body?JSON.stringify(body):undefined}),env,{waitUntil(){}});
}
async function login(env,email,{body={},...opts}={}){const r=await req(env,'/api/auth/login',{...opts,method:'POST',body:{email,password:'correct-horse',...body}});return {res:r,cookie:cookieOf(r),json:await r.json()};}
const me=async(env,cookie)=>(await (await req(env,'/api/auth/me',{cookie})).json()).user;
const alerts=async(env,user)=>{const sv=env.raw.prepare('SELECT session_version FROM users WHERE id=?').get(user).session_version;const token=await signJWT({sub:user,sv},'sessions-test');const r=await (await req(env,'/api/notifications',{cookie:token})).json();if(!r.notifications)throw new Error('feed: '+JSON.stringify(r));return r.notifications.filter(n=>n.message_key.startsWith('security:'));};

test('device labels',()=>{
 assert.equal(describeDevice(CHROME_WIN).label,'Chrome บน Windows');assert.equal(describeDevice(SAFARI_IPHONE).label,'Safari บน iPhone');
 assert.equal(describeDevice('Mozilla/5.0 (Linux; Android 14) Line/14.0').label,'LINE บน Android');
});

test('each login is a device session; list, revoke one, revoke others, logout',async()=>{
 const env=await fixture();
 const a=await login(env,'teacher@test');assert.equal(a.res.status,200);
 const payload=JSON.parse(Buffer.from(a.cookie.split('.')[1],'base64url'));assert.match(payload.sid,/^[a-f0-9]{48}$/);
 assert.equal((await alerts(env,2)).length,0,'first ever login does not alert');
 const b=await login(env,'teacher@test',{ua:SAFARI_IPHONE,ip:'198.51.100.7'});
 const newDevice=await alerts(env,2);assert.equal(newDevice.length,1);assert.match(newDevice[0].message,/อุปกรณ์ใหม่: Safari บน iPhone · IP 198\.51\.100\.7/);assert.equal(newDevice[0].url,'/account.html#devices');
 await login(env,'teacher@test');assert.equal((await alerts(env,2)).length,1,'known device does not alert again');

 const list=await (await req(env,'/api/auth/sessions',{cookie:a.cookie})).json();
 assert.equal(list.sessions.length,3);assert.equal(list.sessions.filter(s=>s.current).length,1);assert.equal(list.sessions.find(s=>s.current).id,payload.sid);
 const phone=list.sessions.find(s=>s.device_label==='Safari บน iPhone');assert.equal(phone.app_label,'ระบบบริหารโรงเรียน');
 assert.equal((await req(env,`/api/auth/sessions/${phone.id}/revoke`,{method:'POST',cookie:a.cookie})).status,200);
 assert.equal(await me(env,b.cookie),null,'revoked device is signed out');
 assert.equal((await me(env,a.cookie)).id,2);
 const other=await signJWT({sub:1},'sessions-test');
 assert.equal((await req(env,`/api/auth/sessions/${payload.sid}/revoke`,{method:'POST',cookie:other})).status,404,'cannot revoke someone else’s device');

 await req(env,'/api/auth/sessions/revoke-others',{method:'POST',cookie:a.cookie});
 assert.equal((await (await req(env,'/api/auth/sessions',{cookie:a.cookie})).json()).sessions.length,1);
 await req(env,'/api/auth/logout',{method:'POST',cookie:a.cookie});
 assert.equal(await me(env,a.cookie),null,'logout revokes the token itself');
 const purpose=await signJWT({sub:2,purpose:'d1_backup_export'},'sessions-test');
 assert.equal(await me(env,purpose),null,'purpose tokens are not sessions');
 assert.equal((await me(env,await signJWT({sub:2},'sessions-test'))).id,2,'older tokens without a session id keep working until expiry');
});

test('five wrong passwords alert the owner once; password change signs out other devices and alerts',async()=>{
 const env=await fixture();
 for(let i=0;i<5;i++)assert.equal((await req(env,'/api/auth/login',{method:'POST',body:{email:'teacher@test',password:'wrong'},ip:'192.0.2.9'})).status,401);
 assert.equal((await req(env,'/api/auth/login',{method:'POST',body:{email:'teacher@test',password:'correct-horse'},ip:'192.0.2.9'})).status,429);
 const lock=await alerts(env,2);assert.equal(lock.length,1);assert.match(lock[0].message,/ใส่รหัสผ่านผิด 5 ครั้ง.*IP 192\.0\.2\.9/);
 for(let i=0;i<5;i++)await req(env,'/api/auth/login',{method:'POST',body:{email:'nobody@test',password:'x'},ip:'192.0.2.9'});

 const a=await login(env,'teacher@test'),b=await login(env,'teacher@test',{ua:SAFARI_IPHONE});
 const changed=await req(env,'/api/auth/change-password',{method:'POST',cookie:a.cookie,body:{current_password:'correct-horse',new_password:'new-password-1'}});
 assert.equal(changed.status,200);const fresh=cookieOf(changed);
 assert.equal(await me(env,b.cookie),null);assert.equal((await me(env,fresh)).id,2);
 assert.equal((await (await req(env,'/api/auth/sessions',{cookie:fresh})).json()).sessions.length,1);
 assert((await alerts(env,2)).some(n=>/เปลี่ยนรหัสผ่านเรียบร้อย/.test(n.message)));
});

test('role and status changes alert the account owner and other administrators',async()=>{
 const env=await fixture();const admin=await signJWT({sub:1},'sessions-test');
 const t=await login(env,'teacher@test');
 assert.equal((await req(env,'/api/admin/users/2',{method:'PATCH',cookie:admin,body:{role:'executive'}})).status,200);
 assert.match((await alerts(env,2))[0].message,/บทบาท ครู → ผู้บริหาร/);
 assert.match((await alerts(env,3))[0].message,/ผู้ดูแล เปลี่ยนสิทธิ์บัญชี ครู ก/);
 assert.equal((await alerts(env,1)).length,0,'the acting administrator is not alerted');
 await req(env,'/api/admin/users/2',{method:'PATCH',cookie:admin,body:{full_name:'ครู ก ใหม่'}});
 assert.equal((await alerts(env,2)).length,1,'name-only edits do not alert');
 await req(env,'/api/admin/users/2',{method:'PATCH',cookie:admin,body:{status:'disabled'}});
 assert.equal(await me(env,t.cookie),null);
});

test('Turnstile is enforced only when the secret is configured',async()=>{
 const open=await fixture();assert.equal((await login(open,'teacher@test')).res.status,200);
 const env=await fixture({TURNSTILE_SECRET_KEY:'secret'});const realFetch=globalThis.fetch;let sent;
 globalThis.fetch=async(url,init)=>{if(String(url).includes('turnstile')){sent=Object.fromEntries(init.body);return new Response(JSON.stringify({success:sent.response==='good-token'}));}return realFetch(url,init);};
 try{
  const missing=await login(env,'teacher@test');assert.equal(missing.res.status,400);assert.match(missing.json.error,/ไม่ใช่บอท/);
  assert.equal((await login(env,'teacher@test',{body:{turnstile_token:'bad'}})).res.status,400);
  assert.equal((await login(env,'teacher@test',{body:{turnstile_token:'good-token'}})).res.status,200);
  assert.equal(sent.secret,'secret');assert.equal(sent.remoteip,'203.0.113.5');
  assert.equal((await req(env,'/api/auth/register',{method:'POST',body:{email:'n@test',password:'12345678',full_name:'ใหม่'}})).status,400);
  assert.equal((await req(env,'/api/auth/forgot-password',{method:'POST',body:{email:'n@test'}})).status,400);
  globalThis.fetch=async()=>{throw new Error('network down');};
  assert.equal((await login(env,'teacher@test',{body:{turnstile_token:'anything'}})).res.status,200,'Cloudflare outage does not lock teachers out');
 }finally{globalThis.fetch=realFetch;}
});

test('security headers: CSP on pages, existing headers kept',async()=>{
 const env=await fixture();
 const page=await req(env,'/login.html');
 assert.equal(page.headers.get('Content-Security-Policy'),CONTENT_SECURITY_POLICY);assert.match(CONTENT_SECURITY_POLICY,/challenges\.cloudflare\.com/);assert.match(CONTENT_SECURITY_POLICY,/frame-ancestors 'self'/);
 assert.equal(page.headers.get('X-Frame-Options'),'SAMEORIGIN');assert.equal(page.headers.get('Strict-Transport-Security'),'max-age=31536000');
 const api=await req(env,'/api/auth/me');assert.equal(api.headers.get('X-Content-Type-Options'),'nosniff');assert.equal(api.headers.get('Content-Security-Policy'),null);
 const kept=applySecurityHeaders(new Response('x',{headers:{'Referrer-Policy':'no-referrer','Content-Type':'text/html'}}));assert.equal(kept.headers.get('Referrer-Policy'),'no-referrer');
 for(const f of ['login','register','forgot-password'])assert.match(fs.readFileSync(`public/${f}.html`,'utf8'),/data-turnstile[\s\S]*turnstile\/v0\/api\.js\?render=explicit&onload=onSchoolTurnstile/);
});
