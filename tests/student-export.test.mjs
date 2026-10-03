import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const ctx=vm.createContext({});vm.runInContext(fs.readFileSync('public/js/student-export.js','utf8'),ctx);const e=ctx.StudentExport;
const rows=[{id:1,student_code:'0012',national_id:'0123456789012',full_name:'เด็กหญิง ก & ข',gender:'female',grade_level:'ป.2',classroom:'2',status:'enrolled'},{id:2,student_code:'0002',full_name:'เด็กชาย ค',gender:'ชาย',grade_level:'ป.10',classroom:'10',status:'enrolled'},{id:3,student_code:'=1+1',full_name:'ทดสอบ',gender:null,grade_level:'ป.2',classroom:'2',status:'graduated'}];
test('export filters gender grade status and natural sorts without mutating roster',()=>{
 assert.equal(e.select(rows,{gender:'หญิง',grade:'ป.2',status:'enrolled'})[0].id,1);
 assert.equal(e.select(rows,{gender:'ไม่ระบุ'})[0].id,3);
 assert.equal(e.select(rows.filter(s=>s.id!==3),{sort:'code'})[0].id,2);
 assert.equal(e.select(rows,{sort:'grade',direction:'desc'})[0].id,2);
 assert.equal(rows[0].id,1);
 assert.equal(e.select(Array.from({length:105},()=>rows[0]),{}).length,105);
});
test('exports preserve codes as text and split complete roster into groups',()=>{
 const groups=e.groups(rows,'grade_level');assert.equal(groups.length,2);assert.equal(groups[0][1].length,2);
 const table=e.table(rows,['student_code','gender']);assert.equal(table[1][0],'0012');assert.equal(table[3][0],'=1+1');assert.equal(table[1][1],'หญิง');
});
test('Word escapes XML and PDF repeats table headers with Thai font',()=>{
 const data=e.groups(rows,''),files=e.docxFiles(data,['full_name','student_code']);assert.match(files['word/document.xml'],/ก &amp; ข/);assert.match(files['word/document.xml'],/w:tblHeader/);assert.equal(Object.keys(files).length,3);
 const pdf=e.pdfDefinition(data,['full_name','student_code']);assert.equal(pdf.defaultStyle.font,'Sarabun');assert.equal(pdf.content[2].table.headerRows,1);assert.equal(pdf.content[2].table.body.length,4);
});

test('national ID is exported as text with all 13 digits in each format',()=>{
 const keys=['national_id'],data=e.groups(rows.slice(0,1),'');
 assert.equal(e.table(rows,keys)[1][0],'0123456789012');
 assert.match(e.docxFiles(data,keys)['word/document.xml'],/0123456789012/);
 assert.equal(e.pdfDefinition(data,keys).content[2].table.body[1][0].text,'0123456789012');
});

test('authenticated export includes national ID while normal list excludes it, including term rosters',async()=>{
 const {DatabaseSync}=await import('node:sqlite');const db=new DatabaseSync(':memory:');
 db.exec(`CREATE TABLE students(id INTEGER,student_code TEXT,full_name TEXT,national_id TEXT,grade_level TEXT,classroom TEXT,status TEXT);
 CREATE TABLE student_details(student_id INTEGER,gender TEXT);
 CREATE TABLE student_enrollments(student_id INTEGER,grade_level TEXT,classroom TEXT,status TEXT,academic_year_id INTEGER,academic_term_id INTEGER);
 INSERT INTO students VALUES(1,'0012','ทดสอบ','0123456789012','ป.1','1','enrolled');
 INSERT INTO student_details VALUES(1,'หญิง');
 INSERT INTO student_enrollments VALUES(1,'ป.2','2','enrolled',1,2);`);
 let user={role:'teacher'};
 const worker=fs.readFileSync('src/index.js','utf8');const a=worker.indexOf('async function handleListStudents('),b=worker.indexOf('// ---------- /api/students/:id',a);
 const context=vm.createContext({URL,getCurrentUser:async()=>user,ensureStudentDetailsSchema:async()=>{},getCurrentAcademicPeriod:async()=>({}),jsonResponse:(body,status=200)=>({body,status})});vm.runInContext(worker.slice(a,b),context);
 const env={DB:{prepare(sql){let args=[];return {bind(...values){args=values;return this;},async all(){return {results:db.prepare(sql).all(...args)};}};}}};
 for(const term of ['', '?academic_term_id=2']) {
  const request={url:'https://school.test/api/students'+term};
  const normal=await context.handleListStudents(request,env);assert.equal(Object.hasOwn(normal.body.students[0],'national_id'),false);
  const exported=await context.handleListStudents(request,env,true);assert.equal(exported.body.students[0].national_id,'0123456789012');assert.equal(exported.body.students[0].grade_level,term?'ป.2':'ป.1');
 }
 user=null;assert.equal((await context.handleListStudents({url:'https://school.test/api/students/export'},env,true)).status,401);
 assert.match(worker,/pathname === "\/api\/students\/export" && method === "GET"\) return await handleListStudents\(request, env, true\)/);
 db.close();
});
