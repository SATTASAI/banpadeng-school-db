import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { signJWT } from "../src/lib/crypto.js";
import { handleLearnerAnalysisRoute } from "../src/routes/learner-analysis.js";

const secret="learner-analysis-sqlite-test";
function environment(){
  const db=new DatabaseSync(":memory:");
  db.exec(`CREATE TABLE users(id INTEGER PRIMARY KEY,email TEXT,full_name TEXT,role TEXT,status TEXT,created_at TEXT);
    CREATE TABLE academic_years(id INTEGER PRIMARY KEY,year_be INTEGER);
    CREATE TABLE academic_terms(id INTEGER PRIMARY KEY,academic_year_id INTEGER,name TEXT);
    CREATE TABLE students(id INTEGER PRIMARY KEY,student_code TEXT,full_name TEXT,health_conditions TEXT,allergies TEXT);
    CREATE TABLE student_details(student_id INTEGER,disadvantage TEXT,guardian_prefix TEXT,
      guardian_first_name TEXT,guardian_last_name TEXT,guardian_relationship TEXT);
    CREATE TABLE guardians(id INTEGER PRIMARY KEY,student_id INTEGER,full_name TEXT,relationship TEXT,is_emergency_contact INTEGER);
    CREATE TABLE student_enrollments(student_id INTEGER,academic_term_id INTEGER,classroom TEXT,grade_level TEXT,status TEXT);
    INSERT INTO users VALUES (7,'one@example.invalid','ครูหนึ่ง','teacher','active','2026-01-01'),(8,'two@example.invalid','ครูสอง','teacher','active','2026-01-01');
    INSERT INTO academic_years VALUES (2,2569),(3,2570);
    INSERT INTO academic_terms VALUES (4,2,'ภาคเรียนที่ 1'),(5,3,'ภาคเรียนที่ 1');
    INSERT INTO students VALUES (9,'S09','นักเรียน ก','แพ้อาหาร','ถั่ว'),(10,'S10','นักเรียน ข',NULL,NULL),(11,'S11','อีกห้อง',NULL,NULL);
    INSERT INTO student_enrollments VALUES (9,4,'ป.4/1','ป.4','enrolled'),(10,4,'ป.4/1','ป.4','enrolled'),(11,4,'ป.4/2','ป.4','enrolled'),(9,5,'ป.5/1','ป.5','enrolled');
    INSERT INTO student_details VALUES (9,NULL,NULL,'ผู้ปกครอง','ตัวอย่าง','มารดา');`);
  return {JWT_SECRET:secret,DB:{prepare(sql){let values=[];const stmt=db.prepare(sql);
    return {bind(...args){values=args;return this;},async first(){return stmt.get(...values)||null;},
      async all(){return {results:stmt.all(...values)};},async run(){const r=stmt.run(...values);return {meta:{changes:r.changes,last_row_id:r.lastInsertRowid}};}};
  }}};
}
async function api(env,userId,path,method="GET",body){
  const token=await signJWT({sub:userId},secret);
  const request=new Request(`https://school.example/api/learner-analysis/${path}`,{
    method,headers:{Cookie:`bpd_session=${token}`,"Content-Type":"application/json"},body:body?JSON.stringify(body):undefined,
  });
  const response=await handleLearnerAnalysisRoute(request,env,new URL(request.url).pathname,method);
  assert.equal(response.status,200,await response.clone().text());
  return response.json();
}

test("real SQLite: room printing uses period enrollment, blanks for missing analysis, and teacher isolation",async()=>{
  const env=environment();
  const rosterPath="roster?term_id=4&classroom="+encodeURIComponent("ป.4/1")+"&print=1";
  const before=await api(env,7,rosterPath);
  assert.deepEqual(before.students.map(s=>s.id),[9,10]);
  assert.equal(before.students[0].analysis_id,null);
  assert.equal(before.students[0].health_conditions,"แพ้อาหาร");
  assert.equal(before.students[0].guardian_first_name,"ผู้ปกครอง");
  await api(env,7,"records/9","PUT",{term_id:4,reading_result:"อ่านได้",reading_evidence:"ตรวจจากการอ่านออกเสียง"});
  const mine=await api(env,7,rosterPath);
  assert.equal(mine.students[0].reading_result,"อ่านได้");
  assert.equal(mine.students[1].reading_result,null);
  const other=await api(env,8,rosterPath);
  assert.equal(other.students[0].reading_result,null);
  const nextYear=await api(env,7,"roster?term_id=5&classroom="+encodeURIComponent("ป.5/1")+"&print=1");
  assert.equal(nextYear.students[0].grade_level,"ป.5");
  assert.equal(nextYear.students[0].reading_result,null);
  const classrooms=await api(env,7,"classrooms?term_id=4");
  assert.deepEqual(classrooms.classrooms.map(row=>row.classroom),["ป.4/1","ป.4/2"]);
});
