import test from 'node:test';import assert from 'node:assert/strict';import {readFileSync} from 'node:fs';import {DatabaseSync} from 'node:sqlite';
import {signJWT,AUTH_COOKIE_NAME} from '../src/lib/crypto.js';import {resetAcademicDataInitialization} from '../src/lib/academic-data.js';
import {handleAcademicPeriodRoute,promoteGradeLevel,normalizeGrade} from '../src/routes/academic-periods.js';
async function fixture(){
 resetAcademicDataInitialization();
 const raw=new DatabaseSync(':memory:');raw.exec(readFileSync(new URL('../schema.sql',import.meta.url),'utf8'));
 raw.exec(`INSERT INTO users(id,email,password_hash,password_salt,full_name,role) VALUES(1,'a@t','x','x','ผอ','superadmin');`);
 const prepare=sql=>{let v=[];return {bind(...x){v=x;return this;},async first(){return raw.prepare(sql).get(...v)||null;},async all(){return {results:raw.prepare(sql).all(...v)};},async run(){const r=raw.prepare(sql).run(...v);return {meta:{changes:Number(r.changes),last_row_id:Number(r.lastInsertRowid)}};}};};
 const env={JWT_SECRET:'s',DB:{prepare,async batch(st){raw.exec('BEGIN');try{const o=[];for(const s of st)o.push(await s.run());raw.exec('COMMIT');return o;}catch(e){raw.exec('ROLLBACK');throw e;}}}};
 const token=await signJWT({sub:1},'s');
 const call=async(path,method='POST',body={})=>{const r=await handleAcademicPeriodRoute(new Request('https://t'+path,{method,headers:{cookie:`${AUTH_COOKIE_NAME}=${token}`},...(method==='GET'?{}:{body:JSON.stringify(body)})}),env,path,method);return {status:r.status,body:await r.json()};};
 // ปีเริ่มต้นสร้างตามวันที่จริง: บังคับให้เป็นภาค 1 กำลังใช้งาน ภาค 2 เตรียมการ
 await call('/api/academic-periods','GET');
 raw.exec(`UPDATE academic_terms SET status='planned';UPDATE academic_terms SET status='active' WHERE term_number=1;`);
 raw.exec(`INSERT INTO students(id,student_code,full_name,grade_level,classroom) VALUES(1,'1','ย้ายออกภาค2','ป.3','1'),(2,'2','ป6','ป.6','1'),(3,'3','ปกติ','ป.3','1')`);
 const year=(await call('/api/academic-periods','GET')).body.years[0];
 return {raw,call,year,t1:year.terms[0].id,t2:year.terms[1].id};
}
test('student who transferred out in term 2 is not promoted into the next year',async()=>{
 const {raw,call,year,t1}=await fixture();
 assert.equal((await call(`/api/academic-terms/${t1}/close`)).status,200);
 raw.exec(`UPDATE students SET status='transferred' WHERE id=1`);
 const r=await call(`/api/academic-years/${year.id}/rollover`,'POST',{copy_students:true});
 assert.equal(r.status,201);
 const rows=raw.prepare('SELECT student_id,grade_level,status FROM student_enrollments WHERE academic_year_id=? ORDER BY student_id').all(r.body.id).map(o=>[o.student_id,o.grade_level,o.status]);
 assert.deepEqual(rows,[[2,'ป.6','graduated'],[3,'ป.4','enrolled']]);
});
test('reopening a closed year returns to its latest term and keeps the latest student status',async()=>{
 const {raw,call,year,t1}=await fixture();
 await call(`/api/academic-terms/${t1}/close`);raw.exec(`UPDATE students SET status='transferred' WHERE id=1`);
 const next=(await call(`/api/academic-years/${year.id}/rollover`,'POST',{copy_students:true})).body.id;
 assert.equal((await call(`/api/academic-years/${next}/activate`)).status,200);
 const r=await call(`/api/academic-years/${year.id}/activate`,'POST',{reopen:true});
 assert.equal(r.body.current.term_number,2);
 assert.equal(raw.prepare('SELECT status FROM students WHERE id=1').get().status,'transferred');
});
test('activating a new year with auto-prepare fills the term that becomes active',async()=>{
 const {raw,call,year,t1}=await fixture();
 const next=(await call(`/api/academic-years/${year.id}/rollover`,'POST',{copy_students:false})).body.id;
 assert.equal((await call(`/api/academic-years/${next}/activate`)).status,400);
 const r=await call(`/api/academic-years/${next}/activate`,'POST',{auto_prepare_students:true});
 assert.equal(r.status,200);
 assert.equal(raw.prepare("SELECT COUNT(*) n FROM student_enrollments WHERE academic_term_id=? AND status='enrolled'").get(r.body.current.academic_term_id).n,2);
 assert.equal(raw.prepare('SELECT grade_level FROM students WHERE id=3').get().grade_level,'ป.4');
});
test('grade names in common Thai forms are promoted',()=>{
 for(const [from,to] of [['อนุบาล 1','อ.2'],['อนุบาลปีที่ 3','ป.1'],['ประถมศึกษาปีที่ ๓','ป.4'],['ประถมศึกษา 2','ป.3'],['ป 5','ป.6'],['ป.1','ป.2'],['อ.2','อ.3']])assert.equal(promoteGradeLevel(from).grade,to,from);
 assert.equal(promoteGradeLevel('ประถมศึกษาปีที่ 6').shouldCopy,false);
 assert.equal(normalizeGrade('ป.๔'),'ป.4');
});
