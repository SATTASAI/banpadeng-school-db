// เอกสารโครงการ: หมวดอัตโนมัติ, อัปโหลดเอกสาร/ภาพเข้า Drive (โครงการ/ปี/ฝ่าย/ชื่อโครงการ/หมวด), สิทธิ์, โฟลเดอร์, ย้อนหลัง 4 ปี
import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture,call} from './notifications.test.mjs';
import worker from '../src/index.js';
import {signJWT} from '../src/lib/crypto.js';

const calls=[];let seq=0;
const realFetch=globalThis.fetch;
globalThis.fetch=async(url,init={})=>{url=String(url);
 if(!/googleapis|oauth2/.test(url))return realFetch(url,init);
 calls.push({url,method:init.method||'GET',body:typeof init.body==='string'?init.body:''});
 if(url.includes('oauth2'))return Response.json({access_token:'tok',expires_in:3600});
 if(url.includes('/upload/'))return Response.json({id:'file'+(++seq)});
 if(url.includes('alt=media'))return new Response('%PDF-1.4 data');
 if(url.includes('/files?q=')){const existing=decodeURIComponent(url).includes("name = 'โครงการ'");return Response.json({files:existing?[{id:'old-root'}]:[]});}
 if(url.includes('/files?fields=id'))return Response.json({id:'folder'+(++seq)});
 return Response.json({});
};
async function send(env,path,fields,user,method='POST'){
 const fd=new FormData();for(const [k,v] of Object.entries(fields))fd.append(k,v);
 const token=await signJWT({sub:user},env.JWT_SECRET);
 return worker.fetch(new Request('https://school.test'+path,{method,body:fd,headers:{Cookie:`bpd_session=${token}`,Origin:'https://school.test'}}),env,{waitUntil(){}});
}
const pdf=(n='โครงการ.pdf')=>new File([new TextEncoder().encode('%PDF-1.4 test')],n,{type:'application/pdf'});
const jpg=(n='ภาพ.jpg')=>new File([new Uint8Array([0xff,0xd8,0xff,0xe0,1,2,3,4])],n,{type:'image/jpeg'});
const fake=(n='x.docx')=>new File([new TextEncoder().encode('not a zip')],n);

test('เอกสารโครงการ: หมวด 4 หมวด อัปโหลด ดู ย้าย เปลี่ยนชื่อ ลบ และสิทธิ์',async()=>{
 const env=await fixture();
 Object.assign(env,{GOOGLE_DRIVE_CLIENT_ID:'a',GOOGLE_DRIVE_CLIENT_SECRET:'b',GOOGLE_DRIVE_REFRESH_TOKEN:'c',GOOGLE_DRIVE_FOLDER_ID:'root'});
 env.raw.exec(`INSERT INTO projects(id,department,name,budget_amount,fiscal_year,created_by) VALUES
  (20,'academic','โครงการปีเดิม',50,2567,1),(21,'academic','โครงการปีเดิม',50,2565,1),(22,'general','โครงการปีเดิม',50,2568,1);`);
 const list=await (await call(env,'/api/projects/10/files','GET',undefined,3)).json();
 assert.deepEqual(list.items.map(i=>i.name),['ไฟล์โครงการ','ภาคผนวก','รายการวัสดุอุปกรณ์','ภาพ']);
 assert.equal(list.can_manage,true); // ครู ข เป็นผู้ดูแลโครงการ 10
 // ย้อนหลัง 4 ปี: ชื่อเดียวกัน ฝ่ายเดียวกัน 2566–2569 (2565 เกิน, ฝ่ายอื่นไม่นับ)
 assert.deepEqual(list.years.map(y=>[y.fiscal_year,y.project_id]),[[2569,10],[2567,20]]);
 const cat=list.items.find(i=>i.category==='project').id, img=list.items.find(i=>i.category==='images').id;
 // คนนอกโครงการดูได้แต่อัปโหลดไม่ได้
 env.raw.exec(`INSERT INTO users(id,email,password_hash,password_salt,full_name,role) VALUES(4,'x@test','x','x','ครู ค','teacher')`);
 assert.equal((await (await call(env,'/api/projects/10/files','GET',undefined,4)).json()).can_manage,false);
 assert.equal((await send(env,'/api/projects/10/files',{file:pdf(),parent_id:String(cat)},4)).status,403);
 assert.equal((await send(env,'/api/projects/10/files',{file:fake()},2)).status,400);
 assert.equal((await send(env,'/api/projects/10/files',{file:pdf(),parent_id:String(cat)},2)).status,201);
 assert.equal((await send(env,'/api/projects/10/files',{file:jpg(),parent_id:String(img)},2)).status,201);
 // โฟลเดอร์ Drive: ใช้โฟลเดอร์ "โครงการ" เดิม → ปี → ฝ่าย → ชื่อโครงการ → หมวด
 const created=calls.filter(c=>c.url.includes('/files?fields=id')).map(c=>JSON.parse(c.body).name);
 assert.deepEqual(created.slice(0,4),['2569','ฝ่ายวิชาการ','โครงการปีเดิม','ไฟล์โครงการ']);
 assert.ok(calls.some(c=>c.url.includes('/files?fields=id')&&JSON.parse(c.body).parents[0]==='old-root'));
 // สร้างโฟลเดอร์ย่อย ย้ายไฟล์เข้า เปลี่ยนชื่อ (คงนามสกุล)
 const mk=await (await call(env,'/api/projects/10/folders','POST',{name:'ใบเสร็จ',parent_id:cat},2)).json();
 assert.equal((await call(env,'/api/projects/10/folders','POST',{name:'ใบเสร็จ',parent_id:cat},2)).status,409);
 let items=(await (await call(env,'/api/projects/10/files','GET',undefined,2)).json()).items;
 const file=items.find(i=>i.name==='โครงการ.pdf');
 assert.equal((await call(env,`/api/project-files/${file.id}`,'PATCH',{parent_id:mk.id},2)).status,200);
 assert.equal((await call(env,`/api/project-files/${file.id}`,'PATCH',{name:'แผนงาน'},2)).status,200);
 assert.equal((await call(env,`/api/project-files/${cat}`,'PATCH',{parent_id:mk.id},2)).status,400); // หมวดระบบย้ายไม่ได้
 assert.equal((await call(env,`/api/project-files/${mk.id}`,'PATCH',{parent_id:mk.id},2)).status,400); // ย้ายเข้าตัวเองไม่ได้
 items=(await (await call(env,'/api/projects/10/files','GET',undefined,2)).json()).items;
 assert.equal(items.find(i=>i.id===file.id).name,'แผนงาน.pdf');
 assert.equal(items.find(i=>i.id===file.id).parent_id,mk.id);
 // ดูตัวอย่าง (inline) ได้ทุกคนที่เข้าสู่ระบบ
 const view=await call(env,`/api/project-files/${file.id}/content`,'GET',undefined,4);
 assert.equal(view.status,200);assert.match(view.headers.get('content-disposition'),/^inline/);
 // แทนที่ไฟล์
 assert.equal((await send(env,`/api/project-files/${file.id}/replace`,{file:pdf('ฉบับแก้.pdf')},2)).status,200);
 // ลบโฟลเดอร์ที่มีไฟล์ไม่ได้ ลบไฟล์ก่อนแล้วลบโฟลเดอร์ได้
 assert.equal((await call(env,`/api/project-files/${mk.id}`,'DELETE',undefined,2)).status,409);
 assert.equal((await call(env,`/api/project-files/${file.id}`,'DELETE',undefined,4)).status,403);
 assert.equal((await call(env,`/api/project-files/${file.id}`,'DELETE',undefined,2)).status,200);
 assert.equal((await call(env,`/api/project-files/${mk.id}`,'DELETE',undefined,2)).status,200);
 assert.equal((await call(env,`/api/project-files/${cat}`,'DELETE',undefined,1)).status,400);
});
