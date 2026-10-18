import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import worker from '../src/index.js';
import {signJWT} from '../src/lib/crypto.js';
import {validateRubric,validateScores,summarize} from '../src/evaluation/scoring.js';
import {starterTemplates} from '../src/evaluation/templates.js';
const origin='https://evaluate.banpadengschool.ac.th';
async function fixture(){
 const raw=new DatabaseSync(':memory:');raw.exec(readFileSync(new URL('../schema.sql',import.meta.url),'utf8'));
 raw.exec(`INSERT INTO users(id,email,password_hash,password_salt,full_name,role) VALUES
 (1,'admin@test','x','x','แอดมิน','superadmin'),(2,'teacher@test','x','x','ครูเป้าหมาย','teacher'),
 (3,'head@test','x','x','หัวหน้าฝ่ายบุคคล','teacher'),(4,'executive@test','x','x','ผู้อำนวยการ','executive'),
 (5,'academic@test','x','x','หัวหน้าฝ่ายวิชาการ','teacher'),(6,'outsider@test','x','x','ครูอื่น','teacher');`);
 function prepare(sql){let args=[];return {bind(...a){args=a;return this;},async first(){return raw.prepare(sql).get(...args)||null;},async all(){return {results:raw.prepare(sql).all(...args)};},async run(){const r=raw.prepare(sql).run(...args);return {meta:{changes:Number(r.changes),last_row_id:Number(r.lastInsertRowid)}};}};}
 const env={raw,JWT_SECRET:'evaluation-test-only',DB:{prepare,async batch(stmts){raw.exec('BEGIN');try{const results=[];for(const s of stmts)results.push(await s.run());raw.exec('COMMIT');return results;}catch(e){raw.exec('ROLLBACK');throw e;}}},ASSETS:{fetch:()=>new Response('asset')}};
 await call(env,'permissions');
 for(const [user,dept] of [[3,'personnel'],[5,'academic']]){const p=raw.prepare('SELECT personnel_id FROM personnel_accounts WHERE user_id=?').get(user);raw.prepare('INSERT INTO department_staff(department,personnel_id,is_head) VALUES(?,?,1)').run(dept,p.personnel_id);}
 return env;
}
async function call(env,path,method='GET',body,user=1,host=origin){const token=user?await signJWT({sub:user},env.JWT_SECRET):null;return worker.fetch(new Request(host+'/api/evaluation/'+path,{method,headers:{'Content-Type':'application/json',...(token?{Cookie:'bpd_session='+token}:{})},body:body===undefined?undefined:JSON.stringify(body)}),env,{});}
async function guest(env,path,cookie,method='GET',body){return worker.fetch(new Request(origin+'/api/evaluation/'+path,{method,headers:{Cookie:cookie,'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)}),env,{});}
async function createCase(env,external=false){
 const template=await call(env,'templates','POST',{...starterTemplates[0],verified:true,confirm_reference:true});assert.equal(template.status,201,await template.clone().text());const templateId=(await template.json()).id;
 const person=env.raw.prepare('SELECT personnel_id FROM personnel_accounts WHERE user_id=2').get().personnel_id;
 const res=await call(env,'cases','POST',{template_id:templateId,personnel_id:person,title:'PA ปี 2570',fiscal_year:2570,cycle:1,start_date:'2026-10-01',end_date:'2027-09-30',rank:'ครู',challenge:'พัฒนาผู้เรียน'});assert.equal(res.status,201,await res.clone().text());const id=(await res.json()).id;
 for(const user_id of [3,5,...(external?[]:[4])])assert.equal((await call(env,`cases/${id}/assignments`,'POST',{user_id})).status,201);
 let invitation;if(external){const r=await call(env,`cases/${id}/assignments`,'POST',{guest_name:'ผู้ทรงคุณวุฒิ',guest_org:'ภายนอก'});assert.equal(r.status,201);invitation=await r.json();}
 return {id,person,invitation,templateId};
}
async function submit(env,id,user,fill=.8){const d=await(await call(env,'cases/'+id,'GET',undefined,user)).json();const scores=Object.fromEntries(d.case.rubric.items.map(i=>[i.id,Math.max(i.min,i.max*fill)]));const r=await call(env,`cases/${id}/ballot`,'PUT',{scores,revision:d.mine.revision,submit:true},user);assert.equal(r.status,200,await r.clone().text());return scores;}

test('permissions follow current roles and department heads; only personnel head/admin edit criteria',async()=>{
 const env=await fixture();for(const user of [1,3,4,5])assert.equal((await(await call(env,'permissions','GET',undefined,user)).json()).access,true);
 for(const user of [2,6]){assert.equal((await call(env,'cases','GET',undefined,user)).status,403);assert.equal((await call(env,'templates','POST',starterTemplates[0],user)).status,403);}
 assert.equal((await call(env,'templates','POST',starterTemplates[0],4)).status,403);assert.equal((await call(env,'templates','POST',starterTemplates[0],5)).status,403);
 assert.equal((await call(env,'templates','POST',starterTemplates[0],3)).status,201);
 env.raw.exec("UPDATE department_staff SET is_head=0 WHERE department='academic'");assert.equal((await call(env,'cases','GET',undefined,5)).status,403);
 assert.equal((await call(env,'cases','GET',undefined,null)).status,401);
});
test('PA requires every member to pass; ballots freeze after submission, finalization is executive-only and results are private',async()=>{
 const env=await fixture(),{id}=await createCase(env);
 assert.equal((await call(env,`cases/${id}/ballot`,'PUT',{scores:{},revision:0,submit:true},3)).status,409);
 assert.equal((await call(env,`cases/${id}/open`,'POST',{})).status,200);
 assert.equal((await call(env,`cases/${id}/ballot`,'PUT',{scores:{},revision:0,submit:true},3)).status,400);
 await submit(env,id,3,.69);await submit(env,id,5,.95);await submit(env,id,4,.95);
 assert.equal((await call(env,`cases/${id}/ballot`,'PUT',{scores:{},revision:1},3)).status,409);
 assert.equal((await call(env,`cases/${id}/publish`,'POST',{},1)).status,403);
 assert.equal((await call(env,'results','GET',undefined,2)).status,200);assert.equal((await(await call(env,'results','GET',undefined,2)).json()).results.length,0);
 const published=await call(env,`cases/${id}/publish`,'POST',{},4);assert.equal(published.status,200,await published.clone().text());const result=(await published.json()).result;assert(result.average>70);assert.equal(result.passed,false);
 assert.equal((await(await call(env,'results','GET',undefined,2)).json()).results.length,1);assert.equal((await(await call(env,'results','GET',undefined,6)).json()).results.length,0);
 assert.equal((await call(env,'cases/'+id,'GET',undefined,2)).status,403);
 assert.equal((await call(env,`cases/${id}/reopen`,'POST',{assignment_id:1,reason:'ทดสอบ'})).status,409);
});
test('guest invitation is one-time, expires in 7 days, is scoped to one case, and revocation is immediate',async()=>{
 const env=await fixture(),{id,invitation}=await createCase(env,true);const token=new URLSearchParams(new URL(invitation.invitation_url).hash.slice(1)).get('invite');assert(token);
 assert(!JSON.stringify(env.raw.prepare('SELECT * FROM evaluation_assignments').all()).includes(token));
 const redeemed=await call(env,'guest/session','POST',{token},null);assert.equal(redeemed.status,200);const cookie=redeemed.headers.get('set-cookie').split(';')[0];assert.match(redeemed.headers.get('set-cookie'),/Secure; HttpOnly; SameSite=Strict/);
 assert.equal((await call(env,'guest/session','POST',{token},null)).status,401);
 assert.equal((await guest(env,'cases',cookie)).status,200);assert.equal((await guest(env,'templates',cookie)).status,403);assert.equal((await guest(env,'people',cookie)).status,403);
 const other=await createCase(env);assert.equal((await guest(env,'cases/'+other.id,cookie)).status,403);
 const own=await(await guest(env,'cases/'+id,cookie)).json();assert.equal(own.assignments.length,1);assert.equal(own.summary,null);assert.equal(own.mine.name,'ผู้ทรงคุณวุฒิ');
 assert.equal((await call(env,`cases/${id}/open`,'POST',{})).status,200);
 const scores=Object.fromEntries(own.case.rubric.items.map(i=>[i.id,i.max]));assert.equal((await guest(env,`cases/${id}/ballot`,cookie,'PUT',{scores,revision:0,submit:true})).status,200);
 assert.equal((await call(env,`cases/${id}/revoke`,'POST',{assignment_id:invitation.id,reason:'ครบหน้าที่'})).status,200);assert.equal((await guest(env,'cases',cookie)).status,401);
 const renewed=await call(env,`cases/${id}/renew`,'POST',{assignment_id:invitation.id,reason:'เชิญใหม่'});assert.equal(renewed.status,200);const replacement=(await renewed.json()).invitation_url;const token2=new URLSearchParams(new URL(replacement).hash.slice(1)).get('invite');
 env.raw.prepare('UPDATE evaluation_assignments SET expires_at=? WHERE id=?').run(Math.floor(Date.now()/1000)-1,invitation.id);assert.equal((await call(env,'guest/session','POST',{token:token2},null)).status,401);
});
test('strict evaluate host does not expose school routes, mutations reject cross-origin, and schema migration is isolated',async()=>{
 const env=await fixture();for(const path of ['/api/users','/dashboard.html','/api/line/webhook','/api/security/backup'])assert.equal((await worker.fetch(new Request(origin+path),env,{})).status,404);
 const r=await worker.fetch(new Request(origin+'/api/evaluation/templates',{method:'POST',headers:{Origin:'https://evil.example','Content-Type':'application/json'},body:'{}'}),env,{});assert.equal(r.status,403);
 assert.equal((await worker.fetch(new Request(origin+'/'),env,{})).headers.get('location'),origin+'/evaluate.html');
});
test('criteria versions cannot retroactively change a case; invalid dates, self evaluation and stale saves are rejected',async()=>{
 const env=await fixture(),{id,person,templateId}=await createCase(env);
 const copy=structuredClone(starterTemplates[0]);copy.rubric.threshold=90;assert.equal((await call(env,'templates','POST',{...copy,verified:true,confirm_reference:true},3)).status,201);
 const detail=await(await call(env,'cases/'+id)).json();assert.equal(detail.case.rubric.threshold,70);assert.equal(detail.case.template_id,templateId);
 const malformed=await call(env,'cases','POST',{personnel_id:person,template_id:templateId,title:'x',fiscal_year:2570,cycle:1,start_date:'2026-02-30',end_date:'2026-03-31'});assert.equal(malformed.status,400);
 await call(env,`cases/${id}/open`,'POST',{});const scores={'1.1':3};assert.equal((await call(env,`cases/${id}/ballot`,'PUT',{scores,revision:0},3)).status,200);assert.equal((await call(env,`cases/${id}/ballot`,'PUT',{scores,revision:0},3)).status,409);
 assert.equal((await call(env,`cases/${id}/publish`,'POST',{},4)).status,409);
 const ownId=env.raw.prepare('SELECT personnel_id FROM personnel_accounts WHERE user_id=4').get().personnel_id;env.raw.prepare('UPDATE evaluation_cases SET personnel_id=? WHERE id=?').run(ownId,id);
 assert.equal((await call(env,`cases/${id}/ballot`,'PUT',{scores:{},revision:0},4)).status,403);assert.equal((await call(env,`cases/${id}/publish`,'POST',{},4)).status,403);
});
test('checklist evaluates required count per section, finite scores, complete ballots, and drafts cannot be used as official templates',async()=>{
 const rubric={mode:'checklist',threshold:0,committee_size:2,items:[{id:'p.1',section:'วิชาชีพ',label:'ก',min:0,max:1},{id:'p.2',section:'วิชาชีพ',label:'ข',min:0,max:1},{id:'s.1',section:'สังคม',label:'ค',min:0,max:1}],groups:[{section:'วิชาชีพ',required:1},{section:'สังคม',required:1}]};validateRubric(rubric);
 const ballots=[{id:1,name:'ก',submitted_at:'now',scores_json:JSON.stringify({'p.1':1,'p.2':1,'s.1':0})},{id:2,name:'ข',submitted_at:'now',scores_json:JSON.stringify({'p.1':1,'p.2':1,'s.1':1})}];assert.equal(summarize(rubric,ballots).passed,false);
 assert.throws(()=>validateScores(rubric,{'p.1':.5}));assert.throws(()=>validateScores(starterTemplates[0].rubric,{'1.1':NaN}));assert.throws(()=>validateScores(starterTemplates[0].rubric,{'1.1':'3'}));assert.throws(()=>validateScores(starterTemplates[0].rubric,{'bogus':1}));
 const env=await fixture();const r=await call(env,'templates','POST',{...starterTemplates[1],verified:true,confirm_reference:true});assert.equal(r.status,400);
});

test('linked aliases cannot act as two committee members; expiry invalidates an already redeemed guest session',async()=>{
 const env=await fixture(),{id,invitation}=await createCase(env,true);
 const person=env.raw.prepare('SELECT personnel_id FROM personnel_accounts WHERE user_id=3').get().personnel_id;
 env.raw.exec("INSERT INTO users(id,email,password_hash,password_salt,full_name,role) VALUES(7,'alias@test','x','x','บัญชีอื่นของหัวหน้า','teacher')");env.raw.prepare('INSERT INTO personnel_accounts(user_id,personnel_id) VALUES(?,?)').run(7,person);
 await call(env,`cases/${id}/remove`,'POST',{assignment_id:invitation.id});
 assert.equal((await call(env,`cases/${id}/assignments`,'POST',{user_id:7})).status,409);
 const invited=await(await call(env,`cases/${id}/assignments`,'POST',{guest_name:'ผู้ทรงคุณวุฒิใหม่',guest_org:'ภายนอก'})).json();
 const token=new URLSearchParams(new URL(invited.invitation_url).hash.slice(1)).get('invite');const redeemed=await call(env,'guest/session','POST',{token},null);const cookie=redeemed.headers.get('set-cookie').split(';')[0];
 assert.equal((await guest(env,'cases',cookie)).status,200);
 env.raw.prepare('UPDATE evaluation_assignments SET expires_at=? WHERE id=?').run(Math.floor(Date.now()/1000)-1,invited.id);
 assert.equal((await guest(env,'cases',cookie)).status,401);
});

test('a guest cannot see other committee scores even after the executive publishes the result',async()=>{
 const env=await fixture(),{id,invitation}=await createCase(env,true);
 const token=new URLSearchParams(new URL(invitation.invitation_url).hash.slice(1)).get('invite');const redeemed=await call(env,'guest/session','POST',{token},null);const cookie=redeemed.headers.get('set-cookie').split(';')[0];
 await call(env,`cases/${id}/open`,'POST',{});await submit(env,id,3);await submit(env,id,5);
 const d=await(await guest(env,'cases/'+id,cookie)).json();const scores=Object.fromEntries(d.case.rubric.items.map(i=>[i.id,i.max]));await guest(env,`cases/${id}/ballot`,cookie,'PUT',{scores,revision:0,submit:true});
 assert.equal((await call(env,`cases/${id}/publish`,'POST',{},4)).status,200);
 const after=await(await guest(env,'cases/'+id,cookie)).json();assert.equal(after.case.result,null);assert.equal(after.summary,null);assert.equal(after.assignments.length,1);assert.equal(after.mine.name,'ผู้ทรงคุณวุฒิ');
});
