// นักเรียนย้ายออก = soft delete; ลบถาวรได้เมื่อผู้อำนวยการอนุมัติเท่านั้น
import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture,call} from './notifications.test.mjs';
import {ensureLeaveData} from '../src/lib/leave-data.js';

async function setup(){
 const env=await fixture();
 env.raw.exec(`INSERT INTO users(id,email,password_hash,password_salt,full_name,role) VALUES
  (4,'director@test','x','x','ผู้อำนวยการตัวอย่าง','executive'),(5,'deputy@test','x','x','รองผู้อำนวยการตัวอย่าง','executive');
  INSERT INTO staff_profiles(user_id,position) VALUES(4,'ผู้อำนวยการโรงเรียนบ้านป่าเด็ง'),(5,'รองผู้อำนวยการโรงเรียนบ้านป่าเด็ง');`);
 await ensureLeaveData(env);
 const json=async(r)=>({status:r.status,data:await r.json().catch(()=>null)});
 const api=async(path,method,body,user=1)=>json(await call(env,path,method,body,user));
 // นักเรียนเพิ่มที่ระบบรายงานผลการเรียน (ตารางเดียวกัน) — จำลองด้วยการเขียนตรง
 await api('/api/students','GET');
 env.raw.exec(`INSERT INTO students(id,student_code,full_name,national_id,name_prefix,first_name,last_name,grade_level,classroom,status)
  VALUES(50,'90001','เด็กชายย้าย ไปแล้ว','1100000000001','เด็กชาย','ย้าย','ไปแล้ว','ป.4','2','enrolled')`);
 const setStatus=(st)=>env.raw.prepare('UPDATE students SET status=? WHERE id=50').run(st);
 return {env,api,id:50,setStatus};
}

test('ข้อมูลที่ระบบรายงานผลการเรียนเป็นเจ้าของ แก้/เพิ่ม/นำเข้าที่ระบบทะเบียนไม่ได้ · ข้อมูลอื่นแก้ได้ · ลบตรงไม่ได้',async()=>{
 const {api,id,setStatus}=await setup();
 assert.equal((await api(`/api/students/${id}`,'DELETE')).status,409);
 const add=await api('/api/students','POST',{student_code:'90002',first_name:'ก',last_name:'ข'});
 assert.equal(add.status,409);assert.match(add.data.error,/ระบบรายงานผลการเรียน/);
 assert.equal((await api('/api/students/import','POST',{rows:[{student_code:'90003',first_name:'ก',last_name:'ข'}]})).status,409);
 // แก้เฉพาะช่องของระบบเกรด → 409 · ปนกับช่องอื่น → บันทึกเฉพาะช่องอื่น
 assert.equal((await api(`/api/students/${id}`,'PATCH',{status:'transferred',first_name:'เปลี่ยน'})).status,409);
 assert.equal((await api(`/api/students/${id}`,'PATCH',{first_name:'เปลี่ยน',allergies:'แพ้ถั่ว',weight_kg:99,religion:'พุทธ'})).status,200);
 const st=(await api(`/api/students/${id}`,'GET')).data.student;
 assert.equal(st.first_name,'ย้าย');assert.equal(st.allergies,'แพ้ถั่ว');assert.notEqual(st.weight_kg,99);
 // ย้ายออก (ทำที่ระบบเกรด) แล้วยังค้นหาเจอพร้อมสถานะ
 setStatus('transferred');
 assert.equal((await api('/api/students','GET')).data.students.find(s=>s.id===id).status,'transferred');
});

test('ลบถาวร: ต้องย้ายออกก่อน → ยื่นคำขอ → เฉพาะผู้อำนวยการอนุมัติ',async()=>{
 const {env,api,id,setStatus}=await setup();
 assert.equal((await api(`/api/students/${id}/delete-request`,'POST',{reason:'ข้อมูลซ้ำ'})).status,409); // ยังกำลังศึกษา
 setStatus('withdrawn');
 assert.equal((await api(`/api/students/${id}/delete-request`,'POST',{reason:''})).status,400);
 assert.equal((await api(`/api/students/${id}/delete-request`,'POST',{reason:'x'},2)).status,403); // ครู
 const req=await api(`/api/students/${id}/delete-request`,'POST',{reason:'บันทึกซ้ำโดยผิดพลาด'});
 assert.equal(req.status,201);
 assert.equal((await api(`/api/students/${id}/delete-request`,'POST',{reason:'อีกครั้ง'})).status,409);
 const rid=req.data.id;
 // ผู้อำนวยการได้รับแจ้งเตือน รองฯ ไม่ได้
 const feed=async(u)=>(await api('/api/notifications','GET',undefined,u)).data.notifications.map(n=>n.message_key);
 assert.ok((await feed(4)).includes(`student-delete:${rid}:pending`));
 assert.ok(!(await feed(5)).includes(`student-delete:${rid}:pending`));
 // ผู้ดูแลระบบและรองฯ อนุมัติไม่ได้
 assert.equal((await api(`/api/student-delete-requests/${rid}/approve`,'POST',{})).status,403);
 assert.equal((await api(`/api/student-delete-requests/${rid}/approve`,'POST',{},5)).status,403);
 const listed=(await api('/api/student-delete-requests','GET',undefined,4)).data;
 assert.equal(listed.can_decide,true);assert.equal(listed.requests[0].status,'pending');
 // ผู้อำนวยการอนุมัติ → ลบจริง พร้อมข้อมูลผลการเรียนที่อ้างถึง
 env.raw.exec(`CREATE TABLE IF NOT EXISTS gr_scores(item_id INTEGER, student_id INTEGER, score REAL); INSERT INTO gr_scores VALUES(1, ${id}, 10);`);
 assert.equal((await api(`/api/student-delete-requests/${rid}/approve`,'POST',{note:'อนุมัติ'},4)).status,200);
 assert.equal((await api(`/api/students/${id}`,'GET')).status,404);
 assert.equal(env.raw.prepare('SELECT COUNT(*) n FROM gr_scores WHERE student_id=?').get(id).n,0);
 assert.equal((await api(`/api/student-delete-requests/${rid}/approve`,'POST',{},4)).status,409);
 assert.ok((await feed(1)).includes(`student-delete:${rid}:approved`));
});

test('ไม่อนุมัติ / ยกเลิกคำขอ: ข้อมูลยังอยู่',async()=>{
 const {api,id,setStatus}=await setup();
 setStatus('transferred');
 const a=(await api(`/api/students/${id}/delete-request`,'POST',{reason:'ทดสอบ'})).data.id;
 assert.equal((await api(`/api/student-delete-requests/${a}/reject`,'POST',{note:'เก็บไว้'},4)).status,200);
 const b=(await api(`/api/students/${id}/delete-request`,'POST',{reason:'ทดสอบ 2'})).data.id;
 assert.equal((await api(`/api/student-delete-requests/${b}/cancel`,'POST',{},1)).status,200);
 assert.equal((await api(`/api/students/${id}`,'GET')).status,200);
});
