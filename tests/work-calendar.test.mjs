import test from 'node:test';import assert from 'node:assert/strict';import {readFileSync} from 'node:fs';import {DatabaseSync} from 'node:sqlite';
import {signJWT,AUTH_COOKIE_NAME} from '../src/lib/crypto.js';import {resetAcademicDataInitialization} from '../src/lib/academic-data.js';
import {handleAcademicPeriodRoute} from '../src/routes/academic-periods.js';
import {handleWorkCalendarRoute} from '../src/routes/work-calendar.js';

async function fixture(){
 resetAcademicDataInitialization();
 const raw=new DatabaseSync(':memory:');raw.exec(readFileSync(new URL('../schema.sql',import.meta.url),'utf8'));
 raw.exec(`INSERT INTO users(id,email,password_hash,password_salt,full_name,role) VALUES(1,'a@t','x','x','ผอ','superadmin');`);
 const prepare=sql=>{let v=[];return {bind(...x){v=x;return this;},async first(){return raw.prepare(sql).get(...v)||null;},async all(){return {results:raw.prepare(sql).all(...v)};},async run(){const r=raw.prepare(sql).run(...v);return {meta:{changes:Number(r.changes),last_row_id:Number(r.lastInsertRowid)}};}};};
 const env={JWT_SECRET:'s',DB:{prepare,async batch(st){for(const s of st)await s.run();}}};
 const token=await signJWT({sub:1},'s');
 const req=(path)=>new Request('https://t'+path,{headers:{cookie:`${AUTH_COOKIE_NAME}=${token}`}});
 await handleAcademicPeriodRoute(req('/api/academic-periods'),env,'/api/academic-periods','GET');
 return {raw,env,req};
}

test('work calendar returns grades holidays read-only',async()=>{
 const {raw,env,req}=await fixture();
 const y=raw.prepare("SELECT id FROM academic_years LIMIT 1").get().id;
 const t=raw.prepare("SELECT start_date FROM academic_terms WHERE academic_year_id=? ORDER BY term_number LIMIT 1").get(y);
 raw.exec(`CREATE TABLE gr_holidays(academic_year_id INTEGER, holiday_date TEXT, name TEXT, created_by INTEGER, PRIMARY KEY(academic_year_id,holiday_date));
  CREATE TABLE gr_holiday_seeds(academic_year_id INTEGER, holiday_date TEXT, name TEXT, PRIMARY KEY(academic_year_id,holiday_date));`);
 raw.prepare("INSERT INTO gr_holidays VALUES(?,?,?,NULL)").run(y,t.start_date,'กิจกรรมโรงเรียน');
 const r=await handleWorkCalendarRoute(req('/api/work-calendar'),env,'/api/work-calendar','GET');
 const b=await r.json();
 assert.equal(r.status,200);
 assert.equal(b.holidays.length,1);
 assert.equal(b.holidays[0].name,'กิจกรรมโรงเรียน');
 assert.ok(b.terms.length>=1);
 assert.ok(Array.isArray(b.important_days));
 assert.equal(await handleWorkCalendarRoute(req('/api/work-calendar'),env,'/api/work-calendar','POST'),null);
});

test('work calendar works before grades tables exist',async()=>{
 const {env,req}=await fixture();
 const r=await handleWorkCalendarRoute(req('/api/work-calendar'),env,'/api/work-calendar','GET');
 assert.equal(r.status,200);
 assert.deepEqual((await r.json()).holidays,[]);
});

test('work calendar splits activity days (still school days) from holidays',async()=>{
 const {raw,env,req}=await fixture();
 const y=raw.prepare("SELECT id FROM academic_years LIMIT 1").get().id;
 raw.exec(`CREATE TABLE gr_holidays(academic_year_id INTEGER, holiday_date TEXT, name TEXT, kind TEXT NOT NULL DEFAULT 'holiday', created_by INTEGER, PRIMARY KEY(academic_year_id,holiday_date));
  CREATE TABLE gr_holiday_seeds(academic_year_id INTEGER, holiday_date TEXT, name TEXT, PRIMARY KEY(academic_year_id,holiday_date));`);
 const before=(await (await handleWorkCalendarRoute(req('/api/work-calendar'),env,'/api/work-calendar','GET')).json()).school_days;
 const d=raw.prepare("SELECT start_date FROM academic_terms WHERE academic_year_id=? ORDER BY term_number LIMIT 1").get(y).start_date;
 raw.prepare("INSERT INTO gr_holidays(academic_year_id,holiday_date,name,kind) VALUES(?,?,?,?)").run(y,d,'กีฬาสี','activity');
 const b=await (await handleWorkCalendarRoute(req('/api/work-calendar'),env,'/api/work-calendar','GET')).json();
 assert.equal(b.holidays.length,0);
 assert.equal(b.activities.length,1);
 assert.equal(b.activities[0].name,'กีฬาสี');
 assert.equal(b.school_days,before);
});
