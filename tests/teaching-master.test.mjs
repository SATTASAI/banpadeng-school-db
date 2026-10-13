// ภาระสอนจากฝ่ายวัดผล (ระบบรายงานผลการเรียน) เป็นข้อมูลกลาง: ตารางสอน จัดตารางอัตโนมัติ API เชื่อมตารางสอน และทะเบียนบุคลากรยึดข้อมูลนี้
import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture,call} from './notifications.test.mjs';
import {ensurePersonnelData} from '../src/lib/personnel-data.js';
import {teachingMaster,loadByPersonnel,periodsFromHours} from '../src/lib/teaching-master.js';
import {masterIssues} from '../src/lib/teaching-master-check.js';

async function setup(){
 const env=await fixture();await ensurePersonnelData(env);
 env.raw.exec(`INSERT INTO academic_years(id,year_be,label,start_date,end_date,status) VALUES(7,2569,'2569','2026-05-01','2027-03-31','active');
 INSERT INTO academic_terms(id,academic_year_id,term_number,name,start_date,end_date) VALUES(71,7,2,'ภาคเรียนที่ 2','2026-11-01','2027-03-31');
 INSERT INTO students(id,student_code,full_name,grade_level,classroom) VALUES(1,'S1','นักเรียน','ป.4','1');
 INSERT INTO student_enrollments(student_id,academic_year_id,academic_term_id,grade_level,classroom,status) VALUES(1,7,71,'ป.4','1','enrolled');
 CREATE TABLE gr_subjects(id INTEGER PRIMARY KEY,academic_year_id INTEGER,grade_level TEXT,code TEXT,name TEXT,hours_per_year INTEGER,sort_order INTEGER DEFAULT 0);
 CREATE TABLE gr_courses(id INTEGER PRIMARY KEY,subject_id INTEGER,classroom TEXT);
 CREATE TABLE gr_course_teachers(course_id INTEGER,user_id INTEGER,PRIMARY KEY(course_id,user_id));
 INSERT INTO gr_subjects VALUES(1,7,'ป.4','ท14101','ภาษาไทย',160,1),(2,7,'ป.4','ค14101','คณิตศาสตร์',160,2),(3,7,'ป.4','ว14101','วิทยาศาสตร์',80,3);
 INSERT INTO gr_courses VALUES(11,1,'1'),(12,2,'1'),(13,3,'1');
 INSERT INTO gr_course_teachers VALUES(11,2),(12,2),(13,3);`);
 // ครูสมัครใหม่ที่ฝ่ายวัดผลเพิ่งให้บทบาทครู (ยังไม่มีทะเบียนบุคลากร)
 env.raw.exec(`INSERT INTO users(id,email,password_hash,password_salt,full_name,role) VALUES(20,'new@test','x','x','ครูใหม่ ล่าสุด','teacher');
 INSERT INTO gr_subjects VALUES(4,7,'ป.4','อ14101','ภาษาอังกฤษ',40,4);INSERT INTO gr_courses VALUES(14,4,'1');INSERT INTO gr_course_teachers VALUES(14,20);`);
 const person=user=>env.raw.prepare('SELECT id FROM personnel_records WHERE user_id=?').get(user)?.id;
 return {env,person};
}

test('อ่านภาระสอนจากฝ่ายวัดผล: คาบ/สัปดาห์ = ชม./ปี ÷ 40 และผูกครูกับทะเบียนบุคลากร',async()=>{
 const {env,person}=await setup();
 assert.equal(periodsFromHours(160),4);assert.equal(periodsFromHours(40),1);assert.equal(periodsFromHours(10),1);
 const m=await teachingMaster(env,{termId:71});
 assert.equal(m.available,true);assert.equal(m.courses.length,4);
 const thai=m.courses.find(c=>c.subject==='ภาษาไทย');assert.equal(thai.periods_per_week,4);assert.equal(thai.teachers[0].personnel_id,person(2));
 assert.deepEqual(m.unlinked.map(u=>u.user_id),[20]);
 const load=loadByPersonnel(m).get(person(2));assert.equal(load.periods_per_week,8);assert.deepEqual(load.subjects,['ภาษาไทย (ป.4/1)','คณิตศาสตร์ (ป.4/1)']);
 assert.equal((await teachingMaster(env,{termId:999})).available,false);
});

test('หน้าตารางสอน: setup ส่งภาระสอนจากฝ่ายวัดผล ผูกทะเบียนครูใหม่ให้ และลงคาบรายวิชาได้เฉพาะครูผู้สอนของวิชานั้น',async()=>{
 const {env,person}=await setup();
 const setupRes=await (await call(env,'/api/timetable/setup?term_id=71')).json();
 assert.equal(setupRes.master.available,true);
 assert.equal(setupRes.master.unlinked.length,0); // ครูใหม่ได้ทะเบียนบุคลากรอัตโนมัติ
 assert.ok(person(20));
 const slot=(subject,teacher)=>call(env,'/api/timetable/slot','PUT',{term_id:71,grade_level:'ป.4',classroom:'1',weekday:1,period:1,subject,teacher_id:teacher});
 const wrong=await slot('ภาษาไทย',person(3));assert.equal(wrong.status,409);assert.match((await wrong.json()).error,/ฝ่ายวัดผล/);
 assert.equal((await slot('ภาษาไทย',person(2))).status,200);
 assert.equal((await slot('แนะแนว',person(3))).status,200); // กิจกรรมที่ไม่ใช่รายวิชา ลงได้อิสระ
});

test('จัดตารางอัตโนมัติ: ภาระสอนต้องครบและตรงฝ่ายวัดผล (วิชา ครู คาบ)',async()=>{
 const {env,person}=await setup();
 await call(env,'/api/timetable/setup?term_id=71'); // ผูกทะเบียนครูใหม่
 const master=await teachingMaster(env,{termId:71});
 const rows=master.courses.map(c=>({grade_level:'ป.4',classroom:'1',subject:c.subject,teacher_id:c.teachers[0].personnel_id,periods_per_week:c.periods_per_week}));
 const cfg=a=>({classes:[{grade_level:'ป.4',classroom:'1'}],assignments:a});
 assert.deepEqual(masterIssues(cfg([...rows,{grade_level:'ป.4',classroom:'1',subject:'แนะแนว',teacher_id:person(3),periods_per_week:1}]),master),[]);
 assert.match(masterIssues(cfg(rows.slice(1)),master).join(),/ภาษาไทย: ยังไม่มีในภาระสอน/);
 assert.match(masterIssues(cfg([{...rows[0],teacher_id:person(3)},...rows.slice(1)]),master).join(),/ครูต้องเป็น/);
 assert.match(masterIssues(cfg([{...rows[0],periods_per_week:9},...rows.slice(1)]),master).join(),/ต้องมี 4 คาบ/);
 assert.deepEqual(masterIssues(cfg([]),{available:false,courses:[]}),[]); // ยังไม่มีข้อมูลจากฝ่ายวัดผล → ใช้แบบเดิม
});

test('ทะเบียนบุคลากร: วิชาที่สอนและคาบสอนแสดงจากฝ่ายวัดผล แก้ที่ระบบนี้ไม่ได้',async()=>{
 const {env,person}=await setup();
 const list=await (await call(env,'/api/staff')).json();
 const t=list.staff.find(s=>s.id===person(2));
 assert.equal(list.teaching_source,'grade-system');assert.equal(t.teaching_periods,8);assert.match(t.subjects,/ภาษาไทย \(ป\.4\/1\)/);
 env.raw.prepare("UPDATE personnel_records SET subjects='เดิม',teaching_periods=3 WHERE id=?").run(person(2));
 const r=await call(env,'/api/staff/'+person(2),'PATCH',{subjects:'แก้เอง',teaching_periods:'20',phone:'0811111111'});
 assert.equal(r.status,200);
 const row=env.raw.prepare('SELECT subjects,teaching_periods,phone FROM personnel_records WHERE id=?').get(person(2));
 assert.deepEqual([row.subjects,row.teaching_periods,row.phone],['เดิม',3,'0811111111']);
});

test('API เชื่อมตารางสอน: ภาระสอนรายวิชามาจากฝ่ายวัดผล ส่วนกิจกรรมที่กรอกเองยังอยู่',async()=>{
 const {env,person}=await setup();env.SCHOOL_SYNC_TOKEN='x'.repeat(32);
 await call(env,'/api/timetable/setup?term_id=71'); // ผูกทะเบียนครูใหม่
 const {handleTimetableSyncRoute}=await import('../src/routes/timetable-sync.js');
 const run=()=>handleTimetableSyncRoute(new Request('https://s/api/integrations/timetable/master-data?term=2569-2',{headers:{'x-school-sync-token':'x'.repeat(32)}}),env,'/api/integrations/timetable/master-data','GET');
 await run(); // สร้างตารางภาระสอนเดิม
 env.raw.prepare("INSERT INTO academic_teaching_assignments(academic_term_id,personnel_id,classroom,subject_name,periods_per_week) VALUES(71,?,'ป.4/1','ภาษาไทย',9),(71,?,'ป.4/1','ลูกเสือ',1)").run(person(3),person(3));
 const d=await (await run()).json();
 assert.equal(d.teaching_source,'grade-system');
 const subj=id=>d.subjects.find(s=>s.id===id)?.name;
 const rows=d.assignments.map(a=>[subj(a.subjectId),a.periodsPerWeek]).sort();
 assert.deepEqual(rows,[['คณิตศาสตร์',4],['ภาษาอังกฤษ',1],['ภาษาไทย',4],['ลูกเสือ',1],['วิทยาศาสตร์',2]]);
 const teacher=d.teachers.find(t=>t.source.personnelId===person(2));assert.equal(teacher.source.teachingPeriods,8);
});
