import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
import worker from '../src/index.js';
import {generateSalt,hashPassword} from '../src/lib/crypto.js';
import {splitName,joinName} from '../src/lib/self-name.js';

async function fixture(){
 const raw=new DatabaseSync(':memory:');raw.exec(fs.readFileSync(new URL('../schema.sql',import.meta.url),'utf8'));
 const salt=generateSalt(),hash=await hashPassword('correct-horse',salt);
 raw.prepare(`INSERT INTO users(id,email,password_hash,password_salt,full_name,role) VALUES
  (1,'admin@test',?,?,'ผู้ดูแล','superadmin'),(2,'teacher@test',?,?,'สมศรี ใจดี','teacher'),(3,'other@test',?,?,'ครู ข','teacher')`).run(hash,salt,hash,salt,hash,salt);
 function prepare(sql){let values=[];return{bind(...v){values=v;return this},async first(){return raw.prepare(sql).get(...values)||null},async all(){return{results:raw.prepare(sql).all(...values)}},async run(){const r=raw.prepare(sql).run(...values);return{meta:{changes:Number(r.changes),last_row_id:Number(r.lastInsertRowid)}}}}}
 return {raw,JWT_SECRET:'personnel-name-test',DB:{prepare,async batch(st){raw.exec('BEGIN');try{const out=[];for(const s of st)out.push(await s.run());raw.exec('COMMIT');return out}catch(e){raw.exec('ROLLBACK');throw e}}},
  ASSETS:{fetch:async()=>new Response('x',{headers:{'Content-Type':'text/html'}})}};
}
async function req(env,path,{method='GET',body,cookie}={}){return worker.fetch(new Request('https://school.test'+path,{method,headers:{'Content-Type':'application/json','User-Agent':'test','CF-Connecting-IP':'203.0.113.9',...(cookie?{Cookie:`bpd_session=${cookie}`}:{})},body:body?JSON.stringify(body):undefined}),env,{waitUntil(){}});}
async function login(env,email){const r=await req(env,'/api/auth/login',{method:'POST',body:{email,password:'correct-horse'}});return (r.headers.get('Set-Cookie')||'').match(/bpd_session=([^;]*)/)?.[1];}

test('split / join keeps the title prefix',()=>{
 assert.deepEqual(splitName('นางสาว สมศรี ใจดี','นางสาว'),{prefix:'นางสาว',first_name:'สมศรี',last_name:'ใจดี'});
 assert.deepEqual(splitName('นางสาวสมศรี ใจดี'),{prefix:'นางสาว',first_name:'สมศรี',last_name:'ใจดี'});
 assert.deepEqual(splitName('ครู ข'),{prefix:null,first_name:'ครู',last_name:'ข'});
 assert.equal(joinName('นาง','สมศรี','ดีมาก',false),'นางสมศรี ดีมาก');
});

test('teacher edits own personnel-record name; account name and other records untouched',async()=>{
 const env=await fixture();
 const admin=await login(env,'admin@test'),teacher=await login(env,'teacher@test');
 await req(env,'/api/staff',{cookie:admin});
 env.raw.exec("DELETE FROM personnel_accounts; DELETE FROM personnel_records;");
 env.raw.prepare(`INSERT INTO personnel_records(id,user_id,prefix,first_name,last_name,full_name,normalized_name,position,status) VALUES(10,2,'นางสาว','สมศรี','ใจดี','นางสาว สมศรี ใจดี','นางสาวสมศรีใจดี','ครู','active'),(11,3,NULL,'ครู','ข','ครู ข','ครูข','ครู','active'),(12,NULL,'นางสาว','ครู','ข','นางสาว ครู ข','นางสาวครูข','ครู','active')`).run();
 env.raw.prepare('INSERT INTO personnel_accounts(user_id,personnel_id) VALUES(2,10),(3,11)').run();
 const got=(await (await req(env,'/api/me/personnel',{cookie:teacher})).json()).person;
 assert.deepEqual([got.name_prefix,got.first_name,got.last_name],['นางสาว','สมศรี','ใจดี']);
 const base={rank_choice:'ครู'};
 assert.equal((await req(env,'/api/me/personnel',{method:'PATCH',cookie:teacher,body:{...base,first_name:'',last_name:'x'}})).status,400);
 assert.equal((await req(env,'/api/me/personnel',{method:'PATCH',cookie:teacher,body:{...base,first_name:'<b>',last_name:'x'}})).status,400);
 assert.equal((await req(env,'/api/me/personnel',{method:'PATCH',cookie:teacher,body:{...base,first_name:'ครู',last_name:'ข'}})).status,409);
 const r=await req(env,'/api/me/personnel',{method:'PATCH',cookie:teacher,body:{...base,first_name:' สมศรี ',last_name:' รักเรียน '}});
 assert.equal(r.status,200,await r.clone().text());
 assert.deepEqual({...env.raw.prepare('SELECT first_name,last_name,full_name,normalized_name FROM personnel_records WHERE id=10').get()},
  {first_name:'สมศรี',last_name:'รักเรียน',full_name:'นางสาว สมศรี รักเรียน',normalized_name:'นางสาวสมศรีรักเรียน'});
 assert.equal(env.raw.prepare('SELECT full_name FROM users WHERE id=2').get().full_name,'สมศรี ใจดี');
 assert.equal(env.raw.prepare('SELECT full_name FROM personnel_records WHERE id=11').get().full_name,'ครู ข');
 const audit=JSON.parse(env.raw.prepare("SELECT details FROM audit_logs WHERE resource='personnel' ORDER BY id DESC").get().details);
 assert.equal(audit.previous_full_name,'นางสาว สมศรี ใจดี');
});
