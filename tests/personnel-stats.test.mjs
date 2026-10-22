import test from 'node:test';import assert from 'node:assert/strict';import {DatabaseSync} from 'node:sqlite';
import {leaveStatistics,substituteLoad,leavePeriod,weekRange,monthRange} from '../src/lib/personnel-stats.js';
function d1(db){return {prepare(sql){let args=[];const st={bind(...v){args=v;return st},async all(){return {results:db.prepare(sql).all(...args)}},async first(){return db.prepare(sql).get(...args)??null},async run(){return db.prepare(sql).run(...args)}};return st}}}
function seed(){const db=new DatabaseSync(':memory:');db.exec(`
CREATE TABLE users(id INTEGER PRIMARY KEY,full_name TEXT,role TEXT);
CREATE TABLE personnel_records(id INTEGER PRIMARY KEY,full_name TEXT,position TEXT,personnel_type TEXT,status TEXT,departments TEXT);
CREATE TABLE personnel_accounts(personnel_id INTEGER,user_id INTEGER);
CREATE TABLE leave_requests(id INTEGER PRIMARY KEY,user_id INTEGER,leave_type TEXT,leave_subtype TEXT,status TEXT,start_date TEXT,end_date TEXT,leave_days REAL);
CREATE TABLE substitute_absences(id INTEGER PRIMARY KEY,absence_date TEXT,teacher_id INTEGER);
CREATE TABLE substitute_assignments(id INTEGER PRIMARY KEY,absence_id INTEGER,substitute_teacher_id INTEGER,absence_date TEXT);
INSERT INTO users VALUES(1,'ครูเอ','teacher'),(2,'ครูบี','teacher'),(3,'ครูเอ บัญชี2','teacher');
INSERT INTO personnel_records VALUES(10,'ครูเอ','ครู','teacher','active','academic'),(20,'ครูบี','ครู','teacher','active','academic'),(30,'ครูซี','ครู','teacher','active','');
INSERT INTO personnel_accounts VALUES(10,1),(20,2),(10,3);
INSERT INTO leave_requests VALUES(1,1,'sick',NULL,'approved','2026-10-05','2026-10-06',2),(2,3,'personal',NULL,'approved','2026-11-02','2026-11-02',1),
 (3,2,'other','lenient','approved','2026-09-29','2026-10-02',4),(4,2,'sick',NULL,'pending','2026-10-10','2026-10-10',1),(5,1,'sick',NULL,'rejected','2026-10-12','2026-10-12',1);
INSERT INTO substitute_absences VALUES(1,'2026-10-20',10),(2,'2026-10-05',20);
INSERT INTO substitute_assignments VALUES(1,1,20,'2026-10-20'),(2,1,20,'2026-10-20'),(3,1,30,'2026-10-20'),(4,2,30,'2026-10-05');`);return db}
test('periods follow fiscal halves, Monday weeks and calendar months',()=>{
 assert.deepEqual([leavePeriod(2570,'h1').start,leavePeriod(2570,'h1').end],['2026-10-01','2027-03-31']);
 assert.equal(leavePeriod(2570,'2026-09'),null);assert.equal(leavePeriod(2570,'2026-11').end,'2026-11-30');
 assert.deepEqual(weekRange('2026-10-22'),{start:'2026-10-19',end:'2026-10-25'});assert.deepEqual(monthRange('2026-02-10'),{start:'2026-02-01',end:'2026-02-28'});
});
test('leave statistics group linked accounts, clip to the period and keep zero rows',async()=>{
 const db=seed(),env={DB:d1(db)};
 const all=await leaveStatistics(env,{fiscalYear:2570,period:'year'});
 const a=all.people.find(r=>r.name==='ครูเอ'),b=all.people.find(r=>r.name==='ครูบี');
 assert.equal(a.approved_times,2);assert.equal(a.approved_days,3);assert.equal(a.sick_personal_times,2);assert.equal(a.rejected,1);
 assert.equal(b.by_type.lenient.days,2);assert.equal(b.pending,1);assert.equal(all.people.length,3);
 const own=await leaveStatistics(env,{fiscalYear:2570,period:'year',onlyUserId:3});assert.equal(own.people.length,1);assert.equal(own.people[0].approved_times,2);
});
test('substitute load uses the same counts for week, month and custom range',async()=>{
 const db=seed(),env={DB:d1(db)};
 const s=await substituteLoad(env,{date:'2026-10-22'});
 const b=s.people.find(r=>r.personnel_id===20),c=s.people.find(r=>r.personnel_id===30),a=s.people.find(r=>r.personnel_id===10);
 assert.deepEqual([b.week,b.month,c.week,c.month],[2,2,1,2]);assert.equal(a.absences,3);assert.equal(s.summary.month_total,4);assert.equal(s.summary.teachers_week,2);
 const own=await substituteLoad(env,{date:'2026-10-22',onlyPersonnelId:30});assert.equal(own.people.length,1);assert.equal(own.summary.range_total,2);
});
