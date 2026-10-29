import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
import worker from '../src/index.js';
import {generateSalt,hashPassword} from '../src/lib/crypto.js';
import {rankChoiceToRecord,recordToRankChoice} from '../src/lib/rank-choice.js';

async function fixture(){
 const raw=new DatabaseSync(':memory:');raw.exec(fs.readFileSync(new URL('../schema.sql',import.meta.url),'utf8'));
 const salt=generateSalt(),hash=await hashPassword('correct-horse',salt);
 raw.prepare(`INSERT INTO users(id,email,password_hash,password_salt,full_name,role) VALUES
  (1,'admin@test',?,?,'ผู้ดูแล','superadmin'),(2,'teacher@test',?,?,'ครู ก','teacher'),(3,'other@test',?,?,'ครู ข','teacher')`).run(hash,salt,hash,salt,hash,salt);
 function prepare(sql){let values=[];return{bind(...v){values=v;return this},async first(){return raw.prepare(sql).get(...values)||null},async all(){return{results:raw.prepare(sql).all(...values)}},async run(){const r=raw.prepare(sql).run(...values);return{meta:{changes:Number(r.changes),last_row_id:Number(r.lastInsertRowid)}}}}}
 const env={raw,JWT_SECRET:'own-test',DB:{prepare,async batch(st){raw.exec('BEGIN');try{const out=[];for(const s of st)out.push(await s.run());raw.exec('COMMIT');return out}catch(e){raw.exec('ROLLBACK');throw e}}},
  ASSETS:{fetch:async()=>new Response('x',{headers:{'Content-Type':'text/html'}})}};
 return env;
}
async function req(env,path,{method='GET',body,cookie}={}){return worker.fetch(new Request('https://school.test'+path,{method,headers:{'Content-Type':'application/json','User-Agent':'test','CF-Connecting-IP':'203.0.113.9',...(cookie?{Cookie:`bpd_session=${cookie}`}:{})},body:body?JSON.stringify(body):undefined}),env,{waitUntil(){}});}
async function login(env,email){const r=await req(env,'/api/auth/login',{method:'POST',body:{email,password:'correct-horse'}});return (r.headers.get('Set-Cookie')||'').match(/bpd_session=([^;]*)/)?.[1];}

test('rank choice maps to position / academic_rank and back',()=>{
 assert.deepEqual(rankChoiceToRecord('ครูชำนาญการพิเศษ'),{position:'ครู',academic_rank:'ครูชำนาญการพิเศษ'});
 assert.deepEqual(rankChoiceToRecord('ครู'),{position:'ครู',academic_rank:null});
 assert.deepEqual(rankChoiceToRecord('ครูผู้ช่วย'),{position:'ครูผู้ช่วย',academic_rank:null});
 assert.deepEqual(rankChoiceToRecord('อื่น ๆ','เจ้าหน้าที่ธุรการ'),{position:'เจ้าหน้าที่ธุรการ',academic_rank:null});
 assert.ok(rankChoiceToRecord('อื่น ๆ','').error);assert.ok(rankChoiceToRecord('อื่น ๆ','ครูอัตราจ้าง').error);assert.ok(rankChoiceToRecord('').error);
 assert.equal(recordToRankChoice('ครูชำนาญการ',null).choice,'ครูชำนาญการ');
 assert.equal(recordToRankChoice('ครู','ชำนาญการพิเศษ').choice,'ครูชำนาญการพิเศษ');
 assert.deepEqual(recordToRankChoice('ผู้อำนวยการโรงเรียน','ชำนาญการพิเศษ'),{choice:'อื่น ๆ',other:'ผู้อำนวยการโรงเรียน'});
});

test('teachers edit their own personnel record only from account (my personnel), not the staff registry',async()=>{
 const env=await fixture();
 const admin=await login(env,'admin@test'),teacher=await login(env,'teacher@test');
 await req(env,'/api/staff',{cookie:admin}); // ensure personnel tables
 env.raw.exec("DELETE FROM personnel_accounts; DELETE FROM personnel_records;");
 env.raw.prepare(`INSERT INTO personnel_records(id,user_id,full_name,normalized_name,position,academic_rank,status) VALUES(10,2,'ครู ก','ครูก','ครู',NULL,'active'),(11,3,'ครู ข','ครูข','ครู',NULL,'active')`).run();
 env.raw.prepare('INSERT INTO personnel_accounts(user_id,personnel_id) VALUES(2,10),(3,11)').run();
 const got=await (await req(env,'/api/me/personnel',{cookie:teacher})).json();
 assert.equal(got.person.id,10);assert.equal(got.person.choice,'ครู');
 assert.equal((await req(env,'/api/staff/10',{method:'PATCH',cookie:teacher,body:{position:'ครู'}})).status,403);
 assert.equal((await req(env,'/api/me/personnel',{method:'PATCH',cookie:teacher,body:{phone:'0811111111'}})).status,400); // ต้องเลือกวิทยฐานะ
 const r=await req(env,'/api/me/personnel',{method:'PATCH',cookie:teacher,body:{rank_choice:'ครูชำนาญการ',phone:'0811111111',full_name:'เปลี่ยนชื่อ'}});
 assert.equal(r.status,200,await r.clone().text());
 const row=env.raw.prepare('SELECT full_name,position,academic_rank,phone FROM personnel_records WHERE id=10').get();
 assert.deepEqual({...row},{full_name:'ครู ก',position:'ครู',academic_rank:'ครูชำนาญการ',phone:'0811111111'});
 assert.equal(env.raw.prepare('SELECT phone FROM personnel_records WHERE id=11').get().phone,null);
 assert.equal((await req(env,'/api/staff/11',{method:'PATCH',cookie:admin,body:{position:'ครู',academic_rank:'ครูชำนาญการพิเศษ'}})).status,200);
});
