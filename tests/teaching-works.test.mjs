// ป่าเด็งโมเดล (แบบรายงาน + ภาพ ≤4 ต่อวิชา×ห้อง) และวิจัยในชั้นเรียน (PDF ต่อครู) — ส่งงานต่อภาคเรียน เก็บใน Google Drive
import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture,call} from './notifications.test.mjs';
import {ensurePersonnelData} from '../src/lib/personnel-data.js';
import worker from '../src/index.js';
import {signJWT} from '../src/lib/crypto.js';

const calls=[];let seq=0;
const realFetch=globalThis.fetch;
globalThis.fetch=async(url,init={})=>{url=String(url);
 if(!/googleapis|oauth2/.test(url))return realFetch(url,init);
 calls.push({url,method:init.method||'GET',body:typeof init.body==='string'?init.body:''});
 if(url.includes('oauth2'))return Response.json({access_token:'tok',expires_in:3600});
 if(url.includes('/upload/'))return Response.json({id:'file'+(++seq)});
 if(url.includes('alt=media'))return new Response('DATA');
 if(url.includes('/files?q='))return Response.json({files:[]});
 if(url.includes('/files?fields=id'))return Response.json({id:'folder'+(++seq)});
 return Response.json({});
};

async function setup(){
 const env=await fixture();await ensurePersonnelData(env);
 Object.assign(env,{GOOGLE_DRIVE_CLIENT_ID:'a',GOOGLE_DRIVE_CLIENT_SECRET:'b',GOOGLE_DRIVE_REFRESH_TOKEN:'c',GOOGLE_DRIVE_FOLDER_ID:'root'});
 env.raw.exec(`INSERT INTO academic_years(id,year_be,label,start_date,end_date,status) VALUES(7,2569,'2569','2026-05-01','2027-03-31','active');
 INSERT INTO academic_terms(id,academic_year_id,term_number,name,start_date,end_date,status) VALUES(71,7,2,'ภาคเรียนที่ 2','2026-11-01','2027-03-31','active');
 CREATE TABLE gr_subjects(id INTEGER PRIMARY KEY,academic_year_id INTEGER,grade_level TEXT,code TEXT,name TEXT,hours_per_year INTEGER,sort_order INTEGER DEFAULT 0);
 CREATE TABLE gr_courses(id INTEGER PRIMARY KEY,subject_id INTEGER,classroom TEXT);
 CREATE TABLE gr_course_teachers(course_id INTEGER,user_id INTEGER,PRIMARY KEY(course_id,user_id));
 INSERT INTO gr_subjects VALUES(1,7,'ป.4','ค14101','คณิตศาสตร์',160,1);
 INSERT INTO gr_courses VALUES(11,1,'1'),(12,1,'2');
 INSERT INTO gr_course_teachers VALUES(11,2),(12,2),(12,3);`);
 return env;
}
async function upload(env,path,fields,user){
 const fd=new FormData();for(const [k,v] of Object.entries(fields))fd.append(k,v);
 const token=await signJWT({sub:user},env.JWT_SECRET);
 return worker.fetch(new Request('https://school.test'+path,{method:'POST',body:fd,headers:{Cookie:`bpd_session=${token}`,Origin:'https://school.test'}}),env,{waitUntil(){}});
}
const jpg=(n='a.jpg')=>new File([new Uint8Array([0xff,0xd8,0xff,0xe0,1,2,3,4])],n,{type:'image/jpeg'});
const pdf=(n='a.pdf')=>new File([new TextEncoder().encode('%PDF-1.4 test')],n,{type:'application/pdf'});

test('ป่าเด็งโมเดล: ครูกรอกแบบรายงาน + ภาพไม่เกิน 4 ต่อวิชา×ห้อง เลิกรับ PDF และฝ่ายวิชาการดึงข้อมูลสร้างเอกสาร',async()=>{
 const env=await setup();
 const mine=await (await call(env,'/api/teaching-works/padeng/mine','GET',undefined,2)).json();
 assert.equal(mine.courses.length,2);assert.equal(mine.term.id,71);
 const r0=mine.courses[0].report;
 assert.deepEqual([r0.academic_year,r0.term_no,r0.learning_area,r0.subject,r0.grade,r0.teacher_name],['2569','2','คณิตศาสตร์','คณิตศาสตร์','4/1','ครู ก']);
 for(let i=0;i<4;i++)assert.equal((await upload(env,'/api/teaching-works/padeng/upload',{kind:'image',course_id:'11',file:jpg()},2)).status,201);
 assert.equal((await upload(env,'/api/teaching-works/padeng/upload',{kind:'image',course_id:'11',file:jpg()},2)).status,409);
 assert.equal((await upload(env,'/api/teaching-works/padeng/upload',{kind:'pdf',course_id:'11',file:pdf()},2)).status,410); // เลิกใช้ PDF
 // PDF เดิมที่เคยส่งไว้ถูกซ่อน
 env.raw.exec(`INSERT INTO padeng_model_files(academic_term_id,course_id,user_id,kind,drive_file_id,file_name,mime_type) VALUES(71,11,2,'pdf','old','old.pdf','application/pdf')`);
 const oldPdf=env.raw.prepare("SELECT id FROM padeng_model_files WHERE kind='pdf'").get().id;
 assert.equal((await call(env,`/api/teaching-works/padeng/files/${oldPdf}`)).status,404);
 // แบบรายงาน: ต้องมีเรื่องที่สอนและผลการจัดกิจกรรม
 const body={term_id:71,course_id:11,topic:'การบวกเลข',result:'นักเรียนบวกเลขได้\nร้อยละ 80',teach_date:'2026-11-05',learning_area:'คณิตศาสตร์',subject:'คณิตศาสตร์',grade:'4/1',term_no:'2',academic_year:'2569',teacher_name:'ครู ก'};
 assert.equal((await call(env,'/api/teaching-works/padeng/report','PUT',{...body,topic:''},2)).status,400);
 assert.equal((await call(env,'/api/teaching-works/padeng/report','PUT',body,3)).status,403); // ครู 3 ไม่ได้สอนห้อง 1
 // ต้องมีลายเซ็นก่อน
 assert.equal((await call(env,'/api/teaching-works/padeng/report','PUT',body,2)).status,400);
 assert.equal((await call(env,'/api/teaching-works/padeng/signature','PUT',{data_url:'data:image/jpeg;base64,AAAA'},2)).status,400);
 const png='data:image/png;base64,'+Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a,0,0,0,0]).toString('base64');
 assert.equal((await call(env,'/api/teaching-works/padeng/signature','PUT',{data_url:png},2)).status,200);
 assert.equal((await call(env,'/api/teaching-works/padeng/report','PUT',body,2)).status,200);
 assert.equal((await call(env,'/api/teaching-works/padeng/report','PUT',{...body,topic:'การบวกเลขสองหลัก'},2)).status,200); // แก้ไขฉบับเดิม
 assert.equal(env.raw.prepare('SELECT COUNT(*) n FROM padeng_model_reports').get().n,1);
 const mine2=await (await call(env,'/api/teaching-works/padeng/mine','GET',undefined,2)).json();
 const c11=mine2.courses.find(c=>c.course_id===11);assert.equal(c11.complete,true);assert.equal(mine2.signature.data_url,png);assert.equal(c11.images.length,4);assert.equal(c11.report.result,'นักเรียนบวกเลขได้\nร้อยละ 80');
 // ความคืบหน้า: เฉพาะฝ่ายวิชาการ/ผู้ดูแล
 assert.equal((await call(env,'/api/teaching-works/padeng/progress','GET',undefined,3)).status,403);
 const prog=await (await call(env,'/api/teaching-works/padeng/progress')).json();
 const t2=prog.teachers.find(t=>t.user_id===2);assert.equal(t2.total,2);assert.equal(t2.complete,1);assert.equal(t2.images,4);assert.equal(t2.reports,1);assert.equal(t2.signed,true);
 assert.deepEqual(prog.grades,['ป.4']);
 // ข้อมูลเอกสาร: ฝ่ายวิชาการได้ทั้งหมด ครูได้เฉพาะของตนเอง
 const docs=await (await call(env,'/api/teaching-works/padeng/documents?term_id=71')).json();
 assert.equal(docs.items.length,1);assert.equal(docs.signatures[2],png);assert.equal(docs.items[0].topic,'การบวกเลขสองหลัก');assert.equal(docs.items[0].images.length,4);
 assert.equal((await call(env,'/api/teaching-works/padeng/documents?term_id=71','GET',undefined,3)).status,403);
 assert.equal((await call(env,'/api/teaching-works/padeng/documents?term_id=71&user_id=2&course_id=11','GET',undefined,2)).status,200);
 assert.equal((await call(env,'/api/teaching-works/padeng/documents?term_id=71&grade_level=ป.5')).status,404);
 // ดาวน์โหลดไฟล์เดี่ยว: เจ้าของ/ฝ่ายวิชาการได้ คนอื่นไม่ได้
 const id=env.raw.prepare("SELECT id FROM padeng_model_files WHERE kind='image' LIMIT 1").get().id;
 assert.equal((await call(env,`/api/teaching-works/padeng/files/${id}`,'GET',undefined,3)).status,403);
 assert.equal(await (await call(env,`/api/teaching-works/padeng/files/${id}`)).text(),'DATA');
 // ลบภาพของตัวเอง → ส่งเพิ่มได้อีก
 assert.equal((await call(env,`/api/teaching-works/padeng/files/${id}`,'DELETE',undefined,2)).status,200);
 assert.equal((await upload(env,'/api/teaching-works/padeng/upload',{kind:'image',course_id:'11',file:jpg()},2)).status,201);
});

test('วิจัยในชั้นเรียน: ครูส่ง PDF 1 ไฟล์ต่อภาคเรียน เก็บในโฟลเดอร์เดิม แยกปี/ภาคเรียน',async()=>{
 const env=await setup();calls.length=0;
 assert.equal((await upload(env,'/api/teaching-works/research/upload',{title:'',file:pdf()},3)).status,400);
 assert.equal((await upload(env,'/api/teaching-works/research/upload',{title:'การพัฒนาทักษะการอ่าน',file:pdf()},3)).status,201);
 const folders=calls.filter(c=>c.url.includes('/files?fields=id')).map(c=>JSON.parse(c.body));
 assert.equal(folders[0].parents[0],'1AprzYr6HU3ht_aGPwH0IFPle8j63YoFg');assert.deepEqual(folders.map(f=>f.name),['2569','ภาคเรียนที่ 2']);
 const mine=await (await call(env,'/api/teaching-works/research/mine','GET',undefined,3)).json();
 assert.equal(mine.file.title,'การพัฒนาทักษะการอ่าน');
 assert.equal((await upload(env,'/api/teaching-works/research/upload',{title:'เรื่องใหม่',file:pdf()},3)).status,201);
 const prog=await (await call(env,'/api/teaching-works/research/progress')).json();
 assert.equal(prog.teachers.find(t=>t.user_id===3).file.title,'เรื่องใหม่');
 assert.equal(prog.teachers.find(t=>t.user_id===2).file,null);
 assert.equal(env.raw.prepare('SELECT COUNT(*) n FROM classroom_research_files WHERE deleted_at IS NULL').get().n,1);
 const perms=await (await call(env,'/api/teaching-works/permissions','GET',undefined,2)).json();assert.equal(perms.academic,false);
});
