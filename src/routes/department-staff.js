import {getCurrentUser,jsonResponse} from '../lib/auth.js';
import {ensurePersonnelData} from '../lib/personnel-data.js';
export const DEPARTMENTS={academic:'ฝ่ายบริหารงานวิชาการ',early_childhood:'ฝ่ายปฐมวัย',budget:'ฝ่ายบริหารงบประมาณ',personnel:'ฝ่ายบริหารงานบุคคล',general:'ฝ่ายบริหารทั่วไป',administration:'ฝ่ายบริหารสถานศึกษา'};
const initialized=new WeakSet();
export function isSchoolExecutive(person){return person.personnel_type==='executive'||person.role==='executive'||/ผู้อำนวยการ|ผู้บริหารสถานศึกษา/.test(String(person.position||''));}
function isDirector(person){return /ผู้อำนวยการ/.test(String(person.position||''))&&!/รอง|ผู้ช่วย/.test(String(person.position||''));}
function eligible(person,dept){return dept==='administration'?isSchoolExecutive(person):!isSchoolExecutive(person);}

export function belongsToDepartment(value,dept){
 const aliases={academic:['academic','วิชาการ','ฝ่ายวิชาการ','ฝ่ายบริหารงานวิชาการ'],early_childhood:['early_childhood','ปฐมวัย','ฝ่ายปฐมวัย','ฝ่ายบริหารงานปฐมวัย'],budget:['budget','งบประมาณ','ฝ่ายงบประมาณ','ฝ่ายบริหารงบประมาณ','ฝ่ายบริหารงานงบประมาณ'],personnel:['personnel','บุคคล','ฝ่ายบุคคล','ฝ่ายบริหารงานบุคคล'],general:['general','ทั่วไป','บริหารทั่วไป','ฝ่ายบริหารทั่วไป','ฝ่ายบริหารงานทั่วไป']};
 return String(value||'').split(/[,;|\n]+/).some(s=>aliases[dept]?.includes(s.trim()));
}
async function ensure(env){
 await ensurePersonnelData(env);
 if(initialized.has(env.DB))return;
 await env.DB.prepare(`CREATE TABLE IF NOT EXISTS department_staff (
 department TEXT NOT NULL,personnel_id INTEGER NOT NULL REFERENCES personnel_records(id),photo BLOB,photo_type TEXT,photo_version INTEGER NOT NULL DEFAULT 0,
 updated_by INTEGER REFERENCES users(id),updated_at TEXT NOT NULL DEFAULT(datetime('now')),PRIMARY KEY(department,personnel_id))`).run();
 const {results:columns}=await env.DB.prepare('PRAGMA table_info(department_staff)').all();
 if(!columns.some(c=>c.name==='is_head')){try{await env.DB.prepare('ALTER TABLE department_staff ADD COLUMN is_head INTEGER NOT NULL DEFAULT 0').run()}catch(e){if(!/duplicate column name/i.test(String(e.message)))throw e}}
 await env.DB.prepare('CREATE UNIQUE INDEX IF NOT EXISTS idx_department_head ON department_staff(department) WHERE is_head=1').run();
 initialized.add(env.DB);
}
const safeHeaders={'Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff'};
export function imageType(bytes){
 if(bytes[0]===255&&bytes[1]===216&&bytes[2]===255)return 'image/jpeg';
 if([137,80,78,71,13,10,26,10].every((v,i)=>bytes[i]===v))return 'image/png';
 if(String.fromCharCode(...bytes.slice(0,4))==='RIFF'&&String.fromCharCode(...bytes.slice(8,12))==='WEBP')return 'image/webp';
 return null;
}
export async function handleDepartmentStaffRoute(request,env,pathname,method){
 const match=pathname.match(/^\/api\/department-staff\/([a-z_]+)(?:\/(\d+)(\/photo)?)?$/);
 if(!match)return null;
 const [,dept,rawId,photo]=match,id=Number(rawId);
 if(rawId&&(!Number.isSafeInteger(id)||id<1))return jsonResponse({error:'รหัสบุคลากรไม่ถูกต้อง'},400);
 if(!Object.hasOwn(DEPARTMENTS,dept))return jsonResponse({error:'ไม่พบฝ่ายงาน'},404);
 const user=await getCurrentUser(request,env);
 if(!user?.role)return jsonResponse({error:'กรุณาเข้าสู่ระบบ'},401);
 if(method!=='GET'&&user.role!=='superadmin')return jsonResponse({error:'เฉพาะผู้ดูแลระบบเท่านั้น'},403);
 await ensure(env);
 if(photo&&method==='GET'){
 const row=await env.DB.prepare('SELECT photo,photo_type FROM department_staff WHERE department=? AND personnel_id=?').bind(dept,id).first();
 if(!row?.photo)return jsonResponse({error:'ยังไม่มีรูปบุคลากร'},404);
 return new Response(Array.isArray(row.photo)?new Uint8Array(row.photo):row.photo,{headers:{...safeHeaders,'Content-Type':row.photo_type}});
 }
 if(!rawId&&method==='GET'){
 const {results}=await env.DB.prepare(`SELECT p.id,p.full_name,p.position,p.homeroom_classroom,p.departments,p.personnel_type,u.role,
 d.personnel_id AS member_id,d.is_head,d.photo_version,CASE WHEN d.photo IS NOT NULL THEN 1 ELSE 0 END AS has_photo,
 (SELECT x.department FROM department_staff x WHERE x.personnel_id=p.id AND x.photo IS NOT NULL ORDER BY x.updated_at DESC LIMIT 1) AS fallback_photo_department
 FROM personnel_records p LEFT JOIN users u ON u.id=p.user_id
 LEFT JOIN department_staff d ON d.personnel_id=p.id AND d.department=? WHERE p.status='active' ORDER BY p.full_name`).bind(dept).all();
 const candidates=results.filter(p=>eligible(p,dept));
 const people=candidates.filter(p=>dept==='administration'||p.member_id||belongsToDepartment(p.departments,dept)).map(p=>({id:p.id,full_name:p.full_name,position:p.position,homeroom_classroom:p.homeroom_classroom,
 is_head:dept==='administration'?isDirector(p):!!p.is_head,
 photo_url:p.has_photo?`/api/department-staff/${dept}/${p.id}/photo?v=${p.photo_version}`:dept==='administration'&&p.fallback_photo_department?`/api/department-staff/${p.fallback_photo_department}/${p.id}/photo`:null}));
 people.sort((a,b)=>Number(b.is_head)-Number(a.is_head)||a.full_name.localeCompare(b.full_name,'th'));
 return jsonResponse({department:dept,label:DEPARTMENTS[dept],people,choices:user.role==='superadmin'?candidates.map(p=>({id:p.id,full_name:p.full_name,position:p.position,homeroom_classroom:p.homeroom_classroom,is_head:dept!=='administration'&&!!p.is_head})):[],permissions:{can_manage:user.role==='superadmin'}},200,safeHeaders);
 }
 if(!rawId&&method==='POST'){
 let body;try{body=await request.json()}catch{return jsonResponse({error:'รูปแบบข้อมูลไม่ถูกต้อง'},400)}
 if(!body||typeof body!=='object'||Array.isArray(body))return jsonResponse({error:'รูปแบบข้อมูลไม่ถูกต้อง'},400);
 const name=String(body.full_name||'').trim(),position=String(body.position||'').trim(),classroom=String(body.homeroom_classroom||'').trim();
 if(name.length>200||position.length>200||classroom.length>100)return jsonResponse({error:'ข้อมูลยาวเกินกำหนด'},400);
 if(dept!=='administration'&&isSchoolExecutive({position}))return jsonResponse({error:'กรุณาเพิ่มผู้บริหารที่ฝ่ายบริหารสถานศึกษา'},409);
 let personId=Number(body.personnel_id);
 if(body.personnel_id!=null&&(!Number.isSafeInteger(personId)||personId<1))return jsonResponse({error:'บุคลากรไม่ถูกต้อง'},400);
 if(body.is_head!==undefined&&typeof body.is_head!=='boolean')return jsonResponse({error:'ข้อมูลหัวหน้าฝ่ายไม่ถูกต้อง'},400);
 if(personId){
 const selected=await env.DB.prepare("SELECT p.id,p.personnel_type,p.position,u.role FROM personnel_records p LEFT JOIN users u ON u.id=p.user_id WHERE p.id=? AND p.status='active'").bind(personId).first();
 if(!selected)return jsonResponse({error:'ไม่พบบุคลากร'},404);
 if(!eligible(selected,dept))return jsonResponse({error:dept==='administration'?'ฝ่ายนี้สำหรับผู้บริหารสถานศึกษาเท่านั้น':'ผู้บริหารอยู่ในฝ่ายบริหารสถานศึกษา'},409);
 }else{
 if(!name)return jsonResponse({error:'กรุณากรอกชื่อบุคลากร'},400);
 if(dept!=='administration'&&isSchoolExecutive({position}))return jsonResponse({error:'กรุณาเพิ่มผู้บริหารที่ฝ่ายบริหารสถานศึกษา'},409);
 const normalized=name.normalize('NFC').replace(/[\u200b-\u200f\u2060\ufeff\s.]+/g,'').toLowerCase();
 if(!normalized)return jsonResponse({error:'กรุณากรอกชื่อบุคลากร'},400);
 const existing=await env.DB.prepare('SELECT p.id,p.status,p.personnel_type,p.position,u.role FROM personnel_records p LEFT JOIN users u ON u.id=p.user_id WHERE normalized_name=?').bind(normalized).first();
 if(existing&&!eligible(existing,dept))return jsonResponse({error:'ประเภทบุคลากรไม่ตรงกับฝ่ายงาน'},409);
 if(existing&&existing.status!=='active')return jsonResponse({error:'บุคลากรชื่อนี้ถูกระงับในทะเบียน กรุณาตรวจทะเบียนบุคลากร'},409);
 await env.DB.prepare(`INSERT INTO personnel_records(full_name,normalized_name,position,homeroom_classroom,personnel_type,source_file)
 VALUES(?,?,?,?,?,'ทำเนียบฝ่ายงาน') ON CONFLICT(normalized_name) DO NOTHING`).bind(name,normalized,position||null,classroom||null,dept==='administration'?'executive':null).run();
 personId=Number((await env.DB.prepare('SELECT id FROM personnel_records WHERE normalized_name=?').bind(normalized).first())?.id);
 if(!personId)return jsonResponse({error:'เพิ่มบุคลากรไม่สำเร็จ'},409);
 }
 const currentMember=await env.DB.prepare('SELECT is_head FROM department_staff WHERE department=? AND personnel_id=?').bind(dept,personId).first();
 const isHead=dept==='administration'?0:body.is_head===undefined?Number(currentMember?.is_head||0):Number(body.is_head);
 await env.DB.batch([
 ...(isHead?[env.DB.prepare('UPDATE department_staff SET is_head=0 WHERE department=? AND is_head=1 AND personnel_id<>?').bind(dept,personId)]:[]),
 env.DB.prepare(`UPDATE personnel_records SET position=?,homeroom_classroom=?,updated_at=datetime('now') WHERE id=?`).bind(position||null,classroom||null,personId),
 env.DB.prepare(`INSERT INTO department_staff(department,personnel_id,updated_by,is_head) VALUES(?,?,?,?) ON CONFLICT(department,personnel_id)
 DO UPDATE SET is_head=excluded.is_head,updated_by=excluded.updated_by,updated_at=datetime('now')`).bind(dept,personId,user.id,isHead)
 ]);
 return jsonResponse({id:personId},200,safeHeaders);
 }
 if(photo&&method==='PUT'){
 const length=Number(request.headers.get('Content-Length'));
 if(length>131072)return jsonResponse({error:'รูปหลังย่อต้องไม่เกิน 128 KB'},413);
 const reader=request.body?.getReader(),chunks=[];let total=0;
 if(reader){while(true){const {value,done}=await reader.read();if(done)break;total+=value.length;if(total>131072){await reader.cancel();return jsonResponse({error:'รูปหลังย่อต้องไม่เกิน 128 KB'},413)}chunks.push(value)}}
 const bytes=new Uint8Array(total);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length}const type=imageType(bytes);
 if(!bytes.length||bytes.length>131072)return jsonResponse({error:'รูปหลังย่อต้องไม่เกิน 128 KB'},413);
 if(!type)return jsonResponse({error:'รองรับเฉพาะรูป JPEG, PNG หรือ WebP'},400);
 const person=await env.DB.prepare("SELECT p.id,p.departments,p.personnel_type,p.position,u.role FROM personnel_records p LEFT JOIN users u ON u.id=p.user_id WHERE p.id=? AND p.status='active'").bind(id).first();
 if(!person)return jsonResponse({error:'ไม่พบบุคลากร'},404);
 const member=await env.DB.prepare('SELECT personnel_id FROM department_staff WHERE department=? AND personnel_id=?').bind(dept,id).first();
 if(!eligible(person,dept))return jsonResponse({error:'ประเภทบุคลากรไม่ตรงกับฝ่ายงาน'},409);
 if(dept!=='administration'&&!member&&!belongsToDepartment(person.departments,dept))return jsonResponse({error:'บุคลากรยังไม่อยู่ในฝ่ายนี้'},409);
 await env.DB.prepare(`INSERT INTO department_staff(department,personnel_id,photo,photo_type,photo_version,updated_by) VALUES(?,?,?,?,1,?)
 ON CONFLICT(department,personnel_id) DO UPDATE SET photo=excluded.photo,photo_type=excluded.photo_type,photo_version=photo_version+1,updated_by=excluded.updated_by,updated_at=datetime('now')`).bind(dept,id,bytes.buffer,type,user.id).run();
 return jsonResponse({ok:true},200,safeHeaders);
 }
 return jsonResponse({error:'Method not allowed'},405);
}
