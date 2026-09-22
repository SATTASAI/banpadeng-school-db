import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { signJWT } from "../src/lib/crypto.js";
import { handleTimetableRoute } from "../src/routes/timetable.js";
import { handleSchoolBankRoute } from "../src/routes/school-bank.js";

const secret="school-operations-test";
function fixture(){
  const db=new DatabaseSync(":memory:");
  db.exec(`PRAGMA foreign_keys=ON;
  CREATE TABLE users(id INTEGER PRIMARY KEY,email TEXT,full_name TEXT,role TEXT,status TEXT,created_at TEXT);
  CREATE TABLE staff_profiles(user_id INTEGER,position TEXT,subjects TEXT,phone TEXT,homeroom_classroom TEXT,license_expiry_date TEXT);
  CREATE TABLE academic_years(id INTEGER PRIMARY KEY,year_be INTEGER);
  CREATE TABLE academic_terms(id INTEGER PRIMARY KEY,academic_year_id INTEGER,name TEXT,start_date TEXT,end_date TEXT);
  CREATE TABLE students(id INTEGER PRIMARY KEY,student_code TEXT,full_name TEXT);
  CREATE TABLE student_enrollments(student_id INTEGER,academic_term_id INTEGER,grade_level TEXT,classroom TEXT,status TEXT);
  INSERT INTO users VALUES (1,'admin@example.invalid','ผู้บริหาร','executive','active','2026-01-01'),
    (2,'teacher@example.invalid','ครูหนึ่ง','teacher','active','2026-01-01'),
    (3,'staff@example.invalid','เจ้าหน้าที่','staff','active','2026-01-01'),
    (4,'other@example.invalid','ครูสอง','teacher','active','2026-01-01');
  INSERT INTO academic_years VALUES (1,2569);
  INSERT INTO academic_terms VALUES (1,1,'ภาคเรียนที่ 1','2026-09-01','2026-12-31');
  INSERT INTO students VALUES (9,'S09','นักเรียน ก'),(10,'S10','นักเรียน ข');
  INSERT INTO student_enrollments VALUES (9,1,'ป.4','1','enrolled'),(10,1,'ป.4','2','enrolled');`);
  function statement(sql){let args=[];return {
    bind(...values){args=values;return this},async first(){return db.prepare(sql).get(...args)||null},
    async all(){return {results:db.prepare(sql).all(...args)}},async run(){const meta=db.prepare(sql).run(...args);return {meta:{changes:meta.changes,last_row_id:Number(meta.lastInsertRowid)}}}
  }}
  return {JWT_SECRET:secret,DB:{prepare:statement,async batch(statements){db.exec("BEGIN");try{const values=[];for(const item of statements)values.push(await item.run());db.exec("COMMIT");return values}catch(error){db.exec("ROLLBACK");throw error}}},raw:db};
}
async function call(env,user,path,method="GET",body){
  const token=await signJWT({sub:user},secret);
  const request=new Request(`https://school.example/api/${path}`,{method,
    headers:{Cookie:`bpd_session=${token}`,"Content-Type":"application/json"},
    body:body?JSON.stringify(body):undefined});
  const handler=path.startsWith("school-bank/")?handleSchoolBankRoute:handleTimetableRoute;
  const response=await handler(request,env,new URL(request.url).pathname,method);
  return {status:response.status,body:await response.json()};
}
async function success(env,user,path,method="GET",body){const result=await call(env,user,path,method,body);assert.equal(result.status,200,JSON.stringify(result.body));return result.body}

test("timetable uses registered classes and teachers, protects draft, and finds free substitute",async()=>{
  const env=fixture();
  const setup=await success(env,1,"timetable/setup?term_id=1");
  assert.deepEqual(setup.classes.map(c=>c.classroom),["1","2"]);
  const one=setup.teachers.find(p=>p.full_name==="ครูหนึ่ง").id,two=setup.teachers.find(p=>p.full_name==="ครูสอง").id;
  assert.equal((await call(env,2,"timetable/slot","PUT",{term_id:1,grade_level:"ป.4",classroom:"1",weekday:1,period:1,subject:"ภาษาไทย",teacher_id:one})).status,403);
  const first={term_id:1,grade_level:"ป.4",classroom:"1",weekday:1,period:1,subject:"ภาษาไทย",teacher_id:one};
  await success(env,1,"timetable/slot","PUT",first);
  assert.equal((await call(env,1,"timetable/slot","PUT",{...first,classroom:"2",subject:"คณิตศาสตร์"})).status,409);
  assert.equal((await call(env,1,"timetable/slot","PUT",{...first,classroom:"2",teacher_id:two,room_name:"ห้องคอม"})).status,200);
  await success(env,1,"timetable/publish","POST",{term_id:1});
  assert.equal((await success(env,2,"timetable/entries?term_id=1&view=published")).entries.length,2);
  const coverage=await success(env,1,`substitutes/coverage?date=2026-09-21&teacher_id=${one}`);
  assert.equal(coverage.lessons.length,1);
  assert(!coverage.lessons[0].available_teachers.some(x=>x.id===two));
  const staff=setup.teachers.find(p=>p.full_name==="เจ้าหน้าที่").id;
  assert(coverage.lessons[0].available_teachers.some(x=>x.id===staff));
  await success(env,1,"substitutes/assignments","POST",{date:"2026-09-21",teacher_id:one,entry_id:coverage.lessons[0].id,substitute_teacher_id:staff});
  assert.equal((await success(env,1,"substitutes/assignments?date=2026-09-21")).assignments.length,1);
  assert.equal((await call(env,1,"substitutes/assignments","POST",{date:"2026-09-21",teacher_id:one,entry_id:coverage.lessons[0].id,substitute_teacher_id:staff})).status,409);
  await success(env,1,"timetable/slot","PUT",{...first,period:2,subject:"ภาษาอังกฤษ"});
  assert.equal((await success(env,1,"timetable/entries?term_id=1&view=published")).entries.length,2);
  assert.equal((await success(env,1,"timetable/entries?term_id=1&view=draft")).entries.length,3);
});

test("bank protects student money and tracks loan balance",async()=>{
  const env=fixture();
  assert.equal((await call(env,2,"school-bank/students?term_id=1")).status,403);
  let roster=await success(env,3,"school-bank/students?term_id=1");
  assert.equal(roster.students[0].account_id,null);
  const opened=await call(env,3,"school-bank/accounts","POST",{student_id:9,term_id:1});assert.equal(opened.status,201);
  roster=await success(env,3,"school-bank/students?term_id=1");const id=roster.students[0].account_id;
  assert.equal((await call(env,3,"school-bank/accounts","POST",{student_id:9,term_id:1})).status,409);
  const tx=async(type,amount,key)=>call(env,3,`school-bank/accounts/${id}/transactions`,"POST",{type,amount,request_key:key});
  assert.equal((await tx("deposit","100.20","request_abcdefghij1")).status,200);
  assert.equal((await tx("withdraw","101","request_abcdefghij2")).status,409);
  assert.equal((await tx("withdraw","20.10","request_abcdefghij3")).status,200);
  assert.equal((await tx("deposit","100.20","request_abcdefghij1")).status,409);
  let record=await success(env,3,`school-bank/accounts/${id}`);assert.equal(record.account.balance_satang,8010);
  assert.equal((await call(env,3,`school-bank/accounts/${id}`,"DELETE")).status,403);
  assert.equal((await call(env,3,`school-bank/accounts/${id}/loans`,"POST",{amount:"50",purpose:"วัสดุการเรียน"})).status,201);
  record=await success(env,1,`school-bank/accounts/${id}`);const loan=record.loans[0];
  await success(env,1,`school-bank/loans/${loan.id}/approve`,"POST",{});
  record=await success(env,1,`school-bank/accounts/${id}`);assert.equal(record.account.balance_satang,13010);assert.equal(record.loans[0].outstanding_satang,5000);
  assert.equal((await call(env,3,`school-bank/loans/${loan.id}/repay`,"POST",{amount:"51",request_key:"repay_abcdefghij1"})).status,409);
  await success(env,3,`school-bank/loans/${loan.id}/repay`,"POST",{amount:"50",request_key:"repay_abcdefghij2"});
  record=await success(env,1,`school-bank/accounts/${id}`);assert.equal(record.account.balance_satang,8010);assert.equal(record.loans[0].status,"closed");
  assert.equal((await call(env,1,`school-bank/accounts/${id}`,"DELETE")).status,409);
  await success(env,3,`school-bank/accounts/${id}/transactions`,"POST",{type:"withdraw",amount:"80.10",request_key:"request_abcdefghij4"});
  await success(env,1,`school-bank/accounts/${id}`,"DELETE");
  assert.equal((await call(env,3,`school-bank/accounts/${id}/transactions`,"POST",{type:"deposit",amount:"10",request_key:"request_abcdefghij5"})).status,404);
});
