import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
import {ensurePersonnelData,upsertSelfRegisteredPersonnel} from '../src/lib/personnel-data.js';
import {mergeConfirmedPersonnel,personnelIdentity} from '../src/lib/personnel-merge.js';
function environment(){
 const raw=new DatabaseSync(':memory:');
 raw.exec(`PRAGMA foreign_keys=ON;
 CREATE TABLE users(id INTEGER PRIMARY KEY,email TEXT UNIQUE,full_name TEXT,role TEXT,status TEXT,deleted_at TEXT);
 CREATE TABLE staff_profiles(user_id INTEGER PRIMARY KEY,position TEXT,subjects TEXT,phone TEXT,homeroom_classroom TEXT,license_expiry_date TEXT);`);
 function prepare(sql){let args=[];return {bind(...values){args=values;return this;},
 async first(){return raw.prepare(sql).get(...args)||null;},async all(){return {results:raw.prepare(sql).all(...args)};},
 async run(){const r=raw.prepare(sql).run(...args);return {meta:{changes:Number(r.changes),last_row_id:Number(r.lastInsertRowid)}};}};}
 return {raw,DB:{prepare,async batch(statements){raw.exec('BEGIN');try{const r=[];for(const s of statements)r.push(await s.run());raw.exec('COMMIT');return r;}catch(e){raw.exec('ROLLBACK');throw e;}}}};
}
test('merge confirmed identities (incl. Sattawat and the misspelled Phakakaew) preserves accounts licenses photos',async()=>{
 const env=environment();await ensurePersonnelData(env);
 assert.equal(env.raw.prepare("SELECT count(*) AS n FROM personnel_records WHERE status='active'").get().n,47);
 env.raw.exec(`CREATE TABLE department_staff(department TEXT,personnel_id INTEGER REFERENCES personnel_records(id),photo BLOB,photo_type TEXT,photo_version INTEGER DEFAULT 0,updated_by INTEGER,is_head INTEGER DEFAULT 0,PRIMARY KEY(department,personnel_id));
 CREATE UNIQUE INDEX department_head ON department_staff(department) WHERE is_head=1;
 CREATE TABLE timetable_entries(id INTEGER PRIMARY KEY,teacher_id INTEGER REFERENCES personnel_records(id));`);
 const names=['จิราพร สุขวงศ์','ประทุม ทองมี','ปิยลักษณ์ เอมรื่น','รพีภรณ์ สร้อยดอกไม้','ศตวรรต อิ่มเจริญ','นางสานางสาวราชาวดี สังขสังข์ทอง','นางสาววรรวรรณมาศ จันทร์ชัง','นางสาวผกาแก้ว จงจงเจริญ'];
 const inserted=[];
 for(let i=0;i<names.length;i++){
   env.raw.prepare("INSERT INTO users VALUES(?,?,?,'teacher','active',NULL)").run(i+1,`teacher${i}@example.invalid`,names[i]);
   const id=Number(env.raw.prepare(`INSERT INTO personnel_records(user_id,full_name,normalized_name,email,position,phone,departments)
     VALUES(?,?,?,?,'ครู',?,'academic')`).run(i+1,names[i],`duplicate-${i}`,`teacher${i}@example.invalid`,`081234567${i}`).lastInsertRowid);
   inserted.push(id);
 }
 assert.equal(env.raw.prepare("SELECT count(*) AS n FROM personnel_records WHERE status='active'").get().n,55);
 env.raw.prepare("INSERT INTO department_staff VALUES('academic',?,X'010203','image/png',2,1,1)").run(inserted[5]);
 env.raw.prepare('INSERT INTO timetable_entries VALUES(1,?)').run(inserted[5]);
 assert.equal(await mergeConfirmedPersonnel(env),8);
 assert.equal(env.raw.prepare("SELECT count(*) AS n FROM personnel_records WHERE status='active'").get().n,47);
 assert.equal(env.raw.prepare('SELECT count(*) AS n FROM personnel_merges').get().n,8);
 const active=env.raw.prepare("SELECT * FROM personnel_records WHERE status='active'").all();
 const person=active.find(p=>personnelIdentity(p.full_name)===personnelIdentity('ราชาวดี สังข์ทอง'));
 assert.equal(person.full_name,'ราชาวดี สังข์ทอง');
 assert.equal(person.phone,'0812345675');
 assert.ok(person.license_expiry_date);
 const member=env.raw.prepare("SELECT * FROM department_staff WHERE department='academic' AND personnel_id=?").get(person.id);
 assert.deepEqual([...member.photo],[1,2,3]);assert.equal(member.is_head,1);
 assert.equal(env.raw.prepare('SELECT teacher_id FROM timetable_entries').get().teacher_id,person.id);
 assert.equal(env.raw.prepare("SELECT count(*) AS n FROM personnel_records WHERE status='active'").get().n,47);
 const sattawat=active.filter(p=>personnelIdentity(p.full_name)===personnelIdentity('ศตวรรต อิ่มเจริญ'));
 assert.equal(sattawat.length,1);assert.equal(sattawat[0].full_name,'นายศตวรรต อิ่มเจริญ');assert.ok(sattawat[0].license_expiry_date);assert.equal(sattawat[0].phone,'0812345674');
 assert.equal(env.raw.prepare('SELECT personnel_id FROM personnel_accounts WHERE user_id=5').get().personnel_id,sattawat[0].id);
 const phaka=active.filter(p=>personnelIdentity(p.full_name)===personnelIdentity('ผกาแก้ว จงเจริญ'));
 assert.equal(phaka.length,1);assert.equal(phaka[0].full_name,'นางสาวผกาแก้ว จงเจริญ');assert.equal(phaka[0].user_id,8);assert.equal(phaka[0].phone,'0812345677');assert.ok(phaka[0].license_expiry_date);
 assert.equal(await mergeConfirmedPersonnel(env),0);
 env.raw.prepare("INSERT INTO users VALUES(90,'new@example.invalid','ราชาวดี สังข์ทอง',NULL,'active',NULL)").run();
 const updatedId=await upsertSelfRegisteredPersonnel(env,{user_id:90,email:'new@example.invalid',full_name:'นางสาว ราชาวดี สังข์ทอง',position:'ครูชำนาญการ',phone:'0899999999',departments:'academic'});
 assert.equal(updatedId,person.id);
 assert.equal(env.raw.prepare('SELECT personnel_id FROM personnel_accounts WHERE user_id=6').get().personnel_id,person.id);
 assert.equal(env.raw.prepare('SELECT personnel_id FROM personnel_accounts WHERE user_id=90').get().personnel_id,person.id);
 assert.equal(env.raw.prepare('SELECT role FROM users WHERE id=6').get().role,'teacher');
 assert.equal(env.raw.prepare('SELECT role FROM users WHERE id=90').get().role,null);
 assert.equal(env.raw.prepare('SELECT phone FROM personnel_records WHERE id=?').get(person.id).phone,'0899999999');
 assert.equal(env.raw.prepare("SELECT count(*) AS n FROM personnel_records WHERE status='active'").get().n,47);
 const source=readFileSync(new URL('../src/index.js',import.meta.url),'utf8');
 const AsyncFunction=Object.getPrototypeOf(async function(){}).constructor;
 const functionSource=source.slice(source.indexOf('async function handleUpdateStaff('),source.indexOf('// ---------- รายงาน ----------',source.indexOf('async function handleUpdateStaff(')));
 const update=new AsyncFunction('getCurrentUser','jsonResponse','ensurePersonnelData','isAdmin','writeAuditLog',`${functionSource}; return handleUpdateStaff;`);
 const response=(data,status=200)=>new Response(JSON.stringify(data),{status});
 const linkedUpdate=await update(async()=>({id:90,role:'teacher'}),response,async()=>{},()=>false,async()=>{});
 assert.equal((await linkedUpdate(new Request('https://school.example/api/staff/'+person.id,{method:'PATCH',body:JSON.stringify({phone:'0888888888'})}),env,person.id)).status,200);
 const unrelatedUpdate=await update(async()=>({id:1,role:'teacher'}),response,async()=>{},()=>false,async()=>{});
 assert.equal((await unrelatedUpdate(new Request('https://school.example/api/staff/'+person.id,{method:'PATCH',body:'{}'}),env,person.id)).status,403);

});
