import test from 'node:test';import assert from 'node:assert/strict';import {DatabaseSync} from 'node:sqlite';
import {attendanceDashboard,schoolDays} from '../src/lib/student-attendance.js';
function d1(db){return {prepare(sql){let args=[];const st={bind(...v){args=v;return st},async all(){return {results:db.prepare(sql).all(...args)}},async first(){return db.prepare(sql).get(...args)??null},async run(){return db.prepare(sql).run(...args)}};return st}}}
function seed({grades=true}={}){const db=new DatabaseSync(':memory:');db.exec(`
CREATE TABLE academic_years(id INTEGER PRIMARY KEY,year_be INTEGER,label TEXT,status TEXT);
CREATE TABLE academic_terms(id INTEGER PRIMARY KEY,academic_year_id INTEGER,term_number INTEGER,name TEXT,start_date TEXT,end_date TEXT,status TEXT);
CREATE TABLE student_enrollments(id INTEGER PRIMARY KEY,student_id INTEGER,academic_year_id INTEGER,academic_term_id INTEGER,grade_level TEXT,classroom TEXT,status TEXT);
INSERT INTO academic_years VALUES(1,2569,'ปีการศึกษา 2569','active');
INSERT INTO academic_terms VALUES(1,1,1,'ภาคเรียนที่ 1','2026-10-05','2026-10-09','closed'),(2,1,2,'ภาคเรียนที่ 2','2026-11-02','2026-11-06','active');
INSERT INTO student_enrollments(student_id,academic_year_id,academic_term_id,grade_level,classroom,status) VALUES
 (1,1,1,'ป.1','1','enrolled'),(2,1,1,'ป.1','1','enrolled'),(3,1,1,'อ.1','1','enrolled'),(4,1,1,'ป.1','1','enrolled'),
 (4,1,2,'ป.1','1','transferred'),(5,1,1,'ป.2','1','enrolled'),(5,1,2,'ป.1','2','enrolled');`);
if(grades)db.exec(`
CREATE TABLE gr_attendance(academic_year_id INTEGER,student_id INTEGER,att_date TEXT,code TEXT,recorded_by INTEGER,updated_at TEXT,PRIMARY KEY(student_id,att_date));
CREATE TABLE gr_holidays(academic_year_id INTEGER,holiday_date TEXT,name TEXT);
CREATE TABLE gr_settings(academic_year_id INTEGER PRIMARY KEY,attendance_pass_pct INTEGER);
CREATE TABLE gr_transfers(id INTEGER PRIMARY KEY,academic_year_id INTEGER,student_id INTEGER,direction TEXT,move_date TEXT,undone_at TEXT);
INSERT INTO gr_holidays VALUES(1,'2026-10-07','วันหยุด');
INSERT INTO gr_settings VALUES(1,80);
INSERT INTO gr_transfers VALUES(1,1,3,'in','2026-10-08',NULL);
INSERT INTO gr_attendance VALUES(1,1,'2026-10-05','ข',1,'2026-10-05 09:00'),(1,1,'2026-10-06','ป',1,'2026-10-06 09:00'),(1,1,'2026-10-09','ส',1,'2026-10-09 09:00'),
 (1,2,'2026-10-09','ล',1,'2026-10-09 10:00'),(1,4,'2026-10-09','ข',1,'2026-10-09 10:00'),(1,3,'2026-10-06','ข',1,'2026-10-06 08:00');`);
return {DB:d1(db)}}

test('school days skip weekends and holidays inside each term',()=>{
 assert.deepEqual(schoolDays([{start_date:'2026-10-05',end_date:'2026-10-11'}],['2026-10-07']),['2026-10-05','2026-10-06','2026-10-08','2026-10-09']);
});
test('between terms the dashboard reports the last school day with grades rules',async()=>{
 const s=await attendanceDashboard(seed(),{today:'2026-10-22'});
 assert.equal(s.available,true);assert.equal(s.in_session,false);assert.equal(s.report_date,'2026-10-09');
 assert.equal(s.next_term.start_date,'2026-11-02');assert.equal(s.term,null);
 // นักเรียนที่ย้ายออก (4) ไม่นับ · คนที่ย้ายห้อง (5) นับตามภาคเรียนล่าสุด
 assert.equal(s.day.enrolled,4);assert.equal(s.day.personal,1);assert.equal(s.day.late,1);assert.equal(s.day.absent,0);
 assert.equal(s.day.present,3);assert.equal(s.day.present_pct,75);
 const p1=s.grades.find(g=>g.grade==='ป.1');assert.equal(p1.enrolled,3);assert.equal(p1.rooms,2);
 assert.deepEqual(s.grades.map(g=>g.grade),['อ.1','ป.1']);
 // วันเรียนผ่านไป 4 วัน (หยุด 7 ต.ค.) · นักเรียน 3 ย้ายเข้า 8 ต.ค. นับ 2 วัน และขาดก่อนย้ายเข้าไม่นับ
 assert.equal(s.year.school_days_elapsed,4);assert.equal(s.year.school_days_total,9);
 assert.equal(s.year.student_days,4+4+2+4);assert.equal(s.year.absent_days,3);
 assert.equal(s.year.below_threshold,2); // นักเรียน 1: 2/4 = 50% · นักเรียน 2: 3/4 = 75% (< 80%)
 assert.equal(s.has_records,true);assert.equal(s.rooms.total,3);assert.equal(s.rooms.recorded_recent,2);
 assert.equal(s.trend.length,4);assert.equal(s.trend.at(-1).present,3);
});
test('during a term today is reported, and missing grades tables degrade gracefully',async()=>{
 const s=await attendanceDashboard(seed(),{today:'2026-11-03'});
 assert.equal(s.in_session,true);assert.equal(s.report_date,'2026-11-03');assert.equal(s.term.number,2);assert.equal(s.day.away,0);
 const none=await attendanceDashboard(seed({grades:false}),{today:'2026-11-03'});
 assert.equal(none.available,false);assert.equal(none.reason,'no_grades');
});
