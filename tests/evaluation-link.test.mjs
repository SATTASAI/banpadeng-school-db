import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import worker from '../src/index.js';
import {signJWT} from '../src/lib/crypto.js';
import {handleEvaluationLogin,evaluationSessionUser,SESSION_COOKIE,LOGIN_COOKIE,SCHOOL_ORIGIN,EVALUATION_ORIGIN} from '../src/evaluation/session-link.js';
async function fixture(){const raw=new DatabaseSync(':memory:');raw.exec(readFileSync(new URL('../schema.sql',import.meta.url),'utf8'));
 raw.exec(`INSERT INTO users(id,email,password_hash,password_salt,full_name,role) VALUES(1,'admin@test','x','x','แอดมิน','superadmin'),(2,'teacher@test','x','x','ครู ก','teacher'),(3,'teacher2@test','x','x','ครู ข','teacher');`);
 function prepare(sql){let args=[];return{bind(...a){args=a;return this;},async first(){return raw.prepare(sql).get(...args)||null;},async all(){return{results:raw.prepare(sql).all(...args)};},async run(){const r=raw.prepare(sql).run(...args);return{meta:{changes:Number(r.changes),last_row_id:Number(r.lastInsertRowid)}};}};}
 const env={raw,JWT_SECRET:'evaluation-link-test',DB:{prepare,async batch(stmts){raw.exec('BEGIN');try{const out=[];for(const s of stmts)out.push(await s.run());raw.exec('COMMIT');return out;}catch(e){raw.exec('ROLLBACK');throw e;}}},ASSETS:{fetch:()=>new Response('asset')}};
 await school(env,'/api/evaluation/permissions');return env;
}
async function school(env,path,user=1,method='GET',form,origin=SCHOOL_ORIGIN){let version=1;try{version=env.raw.prepare('SELECT session_version FROM users WHERE id=?').get(user)?.session_version||1;}catch{}const token=user?await signJWT({sub:user,sv:version},env.JWT_SECRET):null;return worker.fetch(new Request(SCHOOL_ORIGIN+path,{method,headers:{...(token?{Cookie:'bpd_session='+token}:{}),...(method==='POST'?{Origin:origin,'Content-Type':'application/x-www-form-urlencoded'}:{})},body:form?new URLSearchParams(form):undefined}),env,{});}
async function start(env){const r=await handleEvaluationLogin(new Request(EVALUATION_ORIGIN+'/auth/start'),env),location=new URL(r.headers.get('location'));return{state:location.searchParams.get('state'),cookie:r.headers.get('set-cookie').split(';')[0],location};}
const authorize=(env,state,user=1,origin=SCHOOL_ORIGIN)=>school(env,'/api/evaluation-link/authorize',user,'POST',{state},origin);
const finish=(env,location,cookie)=>handleEvaluationLogin(new Request(location,{headers:{Cookie:cookie}}),env);

test('school login authorizes a one-time code and creates a separate evaluatesystem session without sharing passwords or JWT',async()=>{
 const env=await fixture(),s=await start(env);assert.equal(s.location.origin,SCHOOL_ORIGIN);assert.match(s.cookie,new RegExp('^'+LOGIN_COOKIE+'='));
 const page=await school(env,s.location.pathname+s.location.search);assert.equal(page.status,200);const html=await page.text();assert.match(html,/document.getElementById\('evaluation-connect'\).submit\(\)/);assert.doesNotMatch(html,/ยืนยันและเข้าสู่ระบบประเมิน/);const nonce=html.match(/<script nonce="([0-9a-f]+)"/)[1];assert.ok(page.headers.get('content-security-policy').includes("script-src 'nonce-"+nonce+"'"));
 const approved=await authorize(env,s.state);assert.equal(approved.status,302);const callback=new URL(approved.headers.get('location'));assert.equal(callback.origin,EVALUATION_ORIGIN);assert(callback.searchParams.get('code'));
 const completed=await finish(env,callback,s.cookie);assert.equal(completed.status,302);assert.equal(completed.headers.get('location'),'/evaluate');
 const cookie=completed.headers.getSetCookie().find(c=>c.startsWith(SESSION_COOKIE+'=')).split(';')[0];assert(!cookie.includes('bpd_session='));
 const user=await evaluationSessionUser(new Request(EVALUATION_ORIGIN+'/api/evaluation/permissions',{headers:{Cookie:cookie}}),env);assert.equal(user.id,1);
 assert.equal((await finish(env,callback,s.cookie)).status,401);assert.equal((await authorize(env,s.state)).status,409);
 const saved=JSON.stringify(env.raw.prepare('SELECT * FROM evaluation_login_sessions').all());assert(!saved.includes(cookie.split('=')[1]));assert(!saved.includes('password'));
});
test('automatic school sign-in preserves POST Origin and allows only the evaluation redirect',async()=>{
 const env=await fixture(),s=await start(env);
 const page=await school(env,s.location.pathname+s.location.search);
 assert.equal(page.headers.get('referrer-policy'),'same-origin');
 const csp=page.headers.get('content-security-policy');
 assert.ok(csp.includes("form-action 'self' "+EVALUATION_ORIGIN+";"));
 assert.ok(csp.includes("frame-ancestors 'none'"));
 assert.equal((await authorize(env,s.state,1,'null')).status,403);
 assert.equal((await authorize(env,s.state,1,'https://other.example')).status,403);
 assert.equal((await authorize(env,s.state)).status,302);
});
test('login codes are bound to the browser state, expire, and reject cross-origin authorization and ordinary teachers',async()=>{
 const env=await fixture(),s=await start(env);
 assert.equal((await authorize(env,s.state,1,'https://other.example')).status,403);assert.equal((await authorize(env,s.state,2)).status,403);
 assert.equal((await school(env,s.location.pathname+s.location.search,2)).status,403);
 const anonymous=await school(env,s.location.pathname+s.location.search,null);assert.equal(anonymous.status,302);assert.match(anonymous.headers.get('location'),/login.*next=/);
 const approved=await authorize(env,s.state);const callback=approved.headers.get('location');assert.equal((await finish(env,callback,LOGIN_COOKIE+'='+'a'.repeat(64))).status,401);
 assert.equal((await finish(env,callback,s.cookie)).status,302);
 const expired=await start(env);env.raw.exec('UPDATE evaluation_login_requests SET expires_at=0');assert.equal((await authorize(env,expired.state)).status,409);
});
test('changing school session_version or deactivating the account revokes the independent evaluation session immediately',async()=>{
 const env=await fixture(),s=await start(env),approved=await authorize(env,s.state),completed=await finish(env,approved.headers.get('location'),s.cookie);
 const cookie=completed.headers.getSetCookie().find(c=>c.startsWith(SESSION_COOKIE+'=')).split(';')[0],request=new Request(EVALUATION_ORIGIN+'/',{headers:{Cookie:cookie}});
 assert.equal((await evaluationSessionUser(request,env)).id,1);env.raw.exec('UPDATE users SET session_version=session_version+1 WHERE id=1');assert.equal(await evaluationSessionUser(request,env),null);
 const next=await start(env),approved2=await authorize(env,next.state),completed2=await finish(env,approved2.headers.get('location'),next.cookie),cookie2=completed2.headers.getSetCookie().find(c=>c.startsWith(SESSION_COOKIE+'=')).split(';')[0];
 env.raw.exec("UPDATE users SET status='disabled' WHERE id=1");assert.equal(await evaluationSessionUser(new Request(EVALUATION_ORIGIN+'/',{headers:{Cookie:cookie2}}),env),null);
});
test('school APIs retain only published results and permissions; evaluation mutations moved to evaluatesystem',async()=>{
 const env=await fixture();assert.equal((await school(env,'/api/evaluation/cases')).status,410);assert.equal((await school(env,'/evaluate')).headers.get('location'),EVALUATION_ORIGIN+'/evaluate');
 env.raw.exec(`CREATE TABLE evaluation_templates(id INTEGER PRIMARY KEY,kind TEXT,name TEXT);
 CREATE TABLE evaluation_cases(id INTEGER PRIMARY KEY,personnel_id INTEGER,template_id INTEGER,title TEXT,fiscal_year INTEGER,cycle INTEGER,rank TEXT,published_at TEXT,state TEXT,result_json TEXT);`);
 const person=env.raw.prepare('SELECT personnel_id FROM personnel_accounts WHERE user_id=2').get().personnel_id;
 env.raw.prepare("INSERT INTO evaluation_templates VALUES(1,'pa','PA ทดสอบ')").run();
 env.raw.prepare("INSERT INTO evaluation_cases VALUES(1,?,1,'รอบทดสอบ',2570,1,'ครู','2026-10-18','published',?)").run(person,JSON.stringify({passed:true,average:80,members:[]}));
 const mine=await(await school(env,'/api/evaluation/results',2)).json();assert.equal(mine.results.length,1);assert.equal(mine.source,'evaluatesystem');assert.equal(mine.results[0].result.average,80);
 assert.equal((await(await school(env,'/api/evaluation/results',3)).json()).results.length,0);assert.equal((await school(env,'/api/evaluation/results',null)).status,401);
});
