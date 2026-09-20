import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { signJWT } from "../src/lib/crypto.js";
import { handleLearnerAnalysisRoute } from "../src/routes/learner-analysis.js";

const secret="learner-analysis-sqlite-test";
function environment({legacy=false}={}){
  const db=new DatabaseSync(":memory:");
  db.exec(`CREATE TABLE users(id INTEGER PRIMARY KEY,email TEXT,full_name TEXT,role TEXT,status TEXT,created_at TEXT);
    CREATE TABLE academic_years(id INTEGER PRIMARY KEY,year_be INTEGER);
    CREATE TABLE academic_terms(id INTEGER PRIMARY KEY,academic_year_id INTEGER,name TEXT);
    CREATE TABLE students(id INTEGER PRIMARY KEY,student_code TEXT,full_name TEXT,health_conditions TEXT,allergies TEXT);
    CREATE TABLE student_details(student_id INTEGER,disadvantage TEXT,guardian_prefix TEXT,
      guardian_first_name TEXT,guardian_last_name TEXT,guardian_relationship TEXT);
    CREATE TABLE guardians(id INTEGER PRIMARY KEY,student_id INTEGER,full_name TEXT,relationship TEXT,is_emergency_contact INTEGER);
    CREATE TABLE student_enrollments(student_id INTEGER,academic_term_id INTEGER,classroom TEXT,grade_level TEXT,status TEXT);
    CREATE TABLE learner_class_assignments(
      id INTEGER PRIMARY KEY,academic_term_id INTEGER,grade_level TEXT,classroom TEXT,
      teacher_user_id INTEGER,assigned_by INTEGER,created_at TEXT DEFAULT (datetime('now')),
      UNIQUE(academic_term_id,grade_level,classroom,teacher_user_id));
    INSERT INTO users VALUES (7,'one@example.invalid','ครูหนึ่ง','teacher','active','2026-01-01'),(8,'two@example.invalid','ครูสอง','teacher','active','2026-01-01'),(20,'head@example.invalid','ผู้บริหาร','executive','active','2026-01-01');
    INSERT INTO academic_years VALUES (2,2569),(3,2570);
    INSERT INTO academic_terms VALUES (4,2,'ภาคเรียนที่ 1'),(5,3,'ภาคเรียนที่ 1');
    INSERT INTO students VALUES (9,'S09','นักเรียน ก','แพ้อาหาร','ถั่ว'),(10,'S10','นักเรียน ข',NULL,NULL),(11,'S11','อีกห้อง',NULL,NULL),(12,'S12','คนละระดับ',NULL,NULL);
    INSERT INTO student_enrollments VALUES (9,4,'1','ป.4','enrolled'),(10,4,'1','ป.4','enrolled'),(11,4,'2','ป.4','enrolled'),(12,4,'1','ป.5','enrolled'),(9,5,'1','ป.5','enrolled');
    INSERT INTO student_details VALUES (9,NULL,NULL,'ผู้ปกครอง','ตัวอย่าง','มารดา');`);
  if(legacy) db.exec(`CREATE TABLE learner_analyses (
    id INTEGER PRIMARY KEY AUTOINCREMENT,student_id INTEGER NOT NULL,
    academic_year_id INTEGER NOT NULL,academic_term_id INTEGER NOT NULL,teacher_user_id INTEGER NOT NULL,
    assessment_date TEXT,reading_result TEXT,reading_evidence TEXT,writing_result TEXT,writing_evidence TEXT,
    thinking_result TEXT,thinking_evidence TEXT,participation_result TEXT,participation_evidence TEXT,
    strengths TEXT,needs TEXT,support_plan TEXT,followup_date TEXT,followup_result TEXT,followup_next TEXT,
    created_at TEXT DEFAULT (datetime('now')),updated_at TEXT DEFAULT (datetime('now')),
    UNIQUE(student_id,academic_term_id,teacher_user_id));`);
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
  await api(env,20,"assignments","POST",{term_id:4,grade_level:"ป.4",classroom:"1",teacher_user_id:7});
  await api(env,20,"assignments","POST",{term_id:4,grade_level:"ป.4",classroom:"1",teacher_user_id:8});
  await api(env,20,"assignments","POST",{term_id:4,grade_level:"ป.4",classroom:"2",teacher_user_id:7});
  await api(env,20,"assignments","POST",{term_id:4,grade_level:"ป.5",classroom:"1",teacher_user_id:7});
  await api(env,20,"assignments","POST",{term_id:5,grade_level:"ป.5",classroom:"1",teacher_user_id:7});
  const rosterPath="roster?term_id=4&grade_level="+encodeURIComponent("ป.4")+"&classroom=1&print=1";
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
  const otherGrade=await api(env,7,"roster?term_id=4&grade_level="+encodeURIComponent("ป.5")+"&classroom=1&print=1");
  assert.deepEqual(otherGrade.students.map(s=>s.id),[12]);
  const nextYear=await api(env,7,"roster?term_id=5&grade_level="+encodeURIComponent("ป.5")+"&classroom=1&print=1");
  assert.equal(nextYear.students[0].grade_level,"ป.5");
  assert.equal(nextYear.students[0].reading_result,null);
  const grades=await api(env,7,"grades?term_id=4");
  assert.deepEqual(grades.grades.map(row=>[row.grade_level,row.student_count]),[["ป.4",3],["ป.5",1]]);
  const classrooms=await api(env,7,"classrooms?term_id=4&grade_level="+encodeURIComponent("ป.4"));
  assert.deepEqual(classrooms.classrooms.map(row=>[row.classroom,row.student_count]),[["1",2],["2",1]]);
  const anotherClassrooms=await api(env,7,"classrooms?term_id=4&grade_level="+encodeURIComponent("ป.5"));
  assert.deepEqual(anotherClassrooms.classrooms.map(row=>row.classroom),["1"]);
});

test("legacy learner table gains five domain ratings and preserves saved observations",async()=>{
  const env=environment({legacy:true});
  await api(env,20,"assignments","POST",{term_id:4,grade_level:"ป.4",classroom:"1",teacher_user_id:7});
  await api(env,7,"records/9","PUT",{
    term_id:4,learner_interests:"ชอบวาดภาพ",learner_expectations:"อยากอ่านคล่อง",
    knowledge_result:"ปานกลาง",knowledge_evidence:"แบบทดสอบก่อนเรียน",
    physical_result:"ควรส่งเสริม",physical_evidence:"บันทึกการสังเกต",
    learner_group:"ต้องการการสนับสนุนเฉพาะ",support_goal:"อ่านออกเสียงได้คล่อง",
    support_plan:"ฝึกอ่านร่วมกับครู",support_owner:"ครูหนึ่ง",support_timeline:"4 สัปดาห์",
  });
  const record=await api(env,7,"records/9?term_id=4");
  assert.equal(record.analysis.learner_interests,"ชอบวาดภาพ");
  assert.equal(record.analysis.knowledge_result,"ปานกลาง");
  assert.equal(record.analysis.learner_group,"ต้องการการสนับสนุนเฉพาะ");
  assert.equal(record.analysis.support_goal,"อ่านออกเสียงได้คล่อง");
  assert.equal(record.analysis.support_owner,"ครูหนึ่ง");
  assert.equal(record.student.guardian_first_name,"ผู้ปกครอง");
  assert.equal(record.student.health_conditions,"แพ้อาหาร");
  const room=await api(env,7,"roster?term_id=4&grade_level="+encodeURIComponent("ป.4")+"&classroom=1&print=1");
  assert.equal(room.students[0].physical_evidence,"บันทึกการสังเกต");
  assert.equal(room.students[0].support_timeline,"4 สัปดาห์");
});

test("unassigned users cannot list, read, save or print students; revocation takes effect immediately",async()=>{
  const env=environment(),token=await signJWT({sub:7},secret);
  const raw=async(path,method="GET",body)=>{
    const request=new Request(`https://school.example/api/learner-analysis/${path}`,{
      method,headers:{Cookie:`bpd_session=${token}`,"Content-Type":"application/json"},
      body:body?JSON.stringify(body):undefined,
    });
    return handleLearnerAnalysisRoute(request,env,new URL(request.url).pathname,method);
  };
  const roomPath="roster?term_id=4&grade_level="+encodeURIComponent("ป.4")+"&classroom=1&print=1";
  assert.deepEqual((await (await raw("grades?term_id=4")).json()).grades,[]);
  assert.deepEqual((await (await raw("classrooms?term_id=4&grade_level="+encodeURIComponent("ป.4"))).json()).classrooms,[]);
  assert.equal((await raw(roomPath)).status,403);
  assert.equal((await raw("records/9?term_id=4")).status,403);
  assert.equal((await raw("records/9","PUT",{term_id:4,reading_result:"ไม่ควรบันทึก"})).status,403);
  assert.equal((await raw("assignments","POST",{term_id:4,grade_level:"ป.4",classroom:"1",teacher_user_id:7})).status,403);
  await api(env,20,"assignments","POST",{term_id:4,grade_level:"ป.4",classroom:"1",teacher_user_id:7});
  assert.equal((await raw(roomPath)).status,200);
  await api(env,7,"records/9","PUT",{term_id:4,reading_result:"อ่านได้"});
  const { assignments }=await api(env,20,"assignments?term_id=4&grade_level="+encodeURIComponent("ป.4")+"&classroom=1");
  assert.equal(assignments.length,1);
  await api(env,20,`assignments/${assignments[0].id}`,"DELETE");
  assert.equal((await raw(roomPath)).status,403);
  assert.equal((await raw("records/9?term_id=4")).status,403);
  assert.equal((await raw("records/9","PUT",{term_id:4,reading_result:"ห้ามแก้"})).status,403);
  assert.equal((await raw("roster?term_id=4&grade_level="+encodeURIComponent("ป.5")+"&classroom=1&print=1")).status,403);
});

test("grade and classroom are both required for roster and classroom lookup",async()=>{
  const env=environment();const token=await signJWT({sub:7},secret);
  for(const path of ["roster?term_id=4&classroom=1&print=1","classrooms?term_id=4"]){
    const request=new Request(`https://school.example/api/learner-analysis/${path}`,{headers:{Cookie:`bpd_session=${token}`}});
    const response=await handleLearnerAnalysisRoute(request,env,new URL(request.url).pathname,"GET");
    assert.equal(response.status,400);
  }
});
