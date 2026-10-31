// ฝ่ายวิชาการ → แผนการจัดการเรียนการสอน: ดูความคืบหน้าที่ครูอัพโหลดจาก teachingmedia (อ่านอย่างเดียว)
import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture,call} from './notifications.test.mjs';
import {ensurePersonnelData} from '../src/lib/personnel-data.js';
import {ensureDepartmentStaff} from '../src/routes/department-staff.js';

const realFetch=globalThis.fetch;
globalThis.fetch=async(url,init={})=>{url=String(url);
 if(!/googleapis|oauth2/.test(url))return realFetch(url,init);
 if(url.includes('oauth2'))return Response.json({access_token:'tok',expires_in:3600});
 if(url.includes('alt=media'))return new Response('PLAN');
 return Response.json({});
};

test('แผนฯ: ผู้บริหาร/หัวหน้าวิชาการ/superadmin ดูความคืบหน้าและไฟล์ได้ ครูทั่วไปดูไม่ได้ และแก้ไขไม่ได้',async()=>{
 const env=await fixture();await ensurePersonnelData(env);
 Object.assign(env,{GOOGLE_DRIVE_CLIENT_ID:'a',GOOGLE_DRIVE_CLIENT_SECRET:'b',GOOGLE_DRIVE_REFRESH_TOKEN:'c',GOOGLE_DRIVE_FOLDER_ID:'root'});
 env.raw.exec(`INSERT INTO users(id,email,password_hash,password_salt,full_name,role) VALUES (4,'exec@test','x','x','รอง ผอ.','executive');
 INSERT INTO academic_years(id,year_be,label,start_date,end_date,status) VALUES(7,2569,'2569','2026-05-01','2027-03-31','active');
 INSERT INTO academic_terms(id,academic_year_id,term_number,name,start_date,end_date,status) VALUES(71,7,2,'ภาคเรียนที่ 2','2026-11-01','2027-03-31','active');
 CREATE TABLE gr_subjects(id INTEGER PRIMARY KEY,academic_year_id INTEGER,grade_level TEXT,code TEXT,name TEXT,hours_per_year INTEGER,sort_order INTEGER DEFAULT 0);
 CREATE TABLE gr_courses(id INTEGER PRIMARY KEY,subject_id INTEGER,classroom TEXT);
 CREATE TABLE gr_course_teachers(course_id INTEGER,user_id INTEGER,PRIMARY KEY(course_id,user_id));
 INSERT INTO gr_subjects VALUES(1,7,'ป.4','ค14101','คณิตศาสตร์',160,1);
 INSERT INTO gr_courses VALUES(11,1,'1'),(12,1,'2');
 INSERT INTO gr_course_teachers VALUES(11,2),(12,2),(12,3);
 CREATE TABLE tm_lesson_plans(id INTEGER PRIMARY KEY,owner_id INTEGER,academic_term_id INTEGER,year_be TEXT,term_number INTEGER,subject_name TEXT,subject_code TEXT,grade_level TEXT,unit_no INTEGER,
  title TEXT,file_name TEXT,ext TEXT,mime_type TEXT,file_size INTEGER,category TEXT,drive_file_id TEXT,drive_folder_id TEXT,preview_drive_id TEXT,created_at TEXT DEFAULT (datetime('now')),updated_at TEXT);
 INSERT INTO tm_lesson_plans(id,owner_id,academic_term_id,year_be,term_number,subject_name,subject_code,grade_level,unit_no,title,file_name,ext,mime_type,file_size,category,drive_file_id,drive_folder_id)
  VALUES(1,2,71,'2569',2,'คณิตศาสตร์','ค14101','ป.4',1,'แผน1','แผน1.pdf','pdf','application/pdf',100,'pdf','drv1','f1'),
        (2,2,71,'2569',2,'คณิตศาสตร์','ค14101','ป.4',1,'แผน1ก','แผน1ก.pdf','pdf','application/pdf',100,'pdf','drv2','f1');`);
 assert.equal((await (await call(env,'/api/lesson-plans/permissions','GET',undefined,3)).json()).view,false);
 assert.equal((await call(env,'/api/lesson-plans/progress','GET',undefined,3)).status,403);
 for(const u of [1,4])assert.equal((await (await call(env,'/api/lesson-plans/permissions','GET',undefined,u)).json()).view,true);
 const d=await (await call(env,'/api/lesson-plans/progress','GET',undefined,4)).json();
 assert.equal(d.term.id,71);
 const a=d.teachers.find(t=>t.user_id===2),b=d.teachers.find(t=>t.user_id===3);
 assert.equal(a.files,2);assert.equal(a.units,1);assert.equal(a.subjects.length,1,'สองห้องชั้นเดียวกันเป็นวิชาเดียว');
 assert.equal(b.files,0);assert.equal(b.subjects[0].units.length,0);
 const f=await call(env,'/api/lesson-plans/files/1?download=1','GET',undefined,1);
 assert.equal(f.status,200);assert.match(f.headers.get('Content-Disposition'),/^attachment/);assert.equal(await f.text(),'PLAN');
 assert.equal((await call(env,'/api/lesson-plans/files/1','DELETE',undefined,1)).status,405);
 // หัวหน้าฝ่ายวิชาการ (ไม่ใช่ผู้บริหาร) ดูได้
 env.raw.exec(`INSERT OR IGNORE INTO personnel_records(id,full_name,normalized_name,status) VALUES(90,'ครู ข','ครูข','active');
  INSERT OR IGNORE INTO personnel_accounts(personnel_id,user_id) VALUES(90,3);`);
 const pid=env.raw.prepare('SELECT personnel_id FROM personnel_accounts WHERE user_id=3').get().personnel_id;
 await ensureDepartmentStaff(env);
 env.raw.exec(`INSERT INTO department_staff(department,personnel_id,is_head) VALUES('academic',${pid},1)`);
 assert.equal((await (await call(env,'/api/lesson-plans/permissions','GET',undefined,3)).json()).view,true);
});
