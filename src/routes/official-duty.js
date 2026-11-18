// การไปราชการ — บันทึกแจ้งระบบว่าครูไม่อยู่ (ไม่นับวันลา) เพื่อให้ฝ่ายบุคคลจัดสอนแทนได้
// ผอ. กดรับทราบ · แนบหนังสือคำสั่ง/ต้นเรื่องได้ (ไม่บังคับ) เก็บใน Google Drive โฟลเดอร์ "ไปราชการ"
import {getCurrentUser,jsonResponse} from '../lib/auth.js';
import {isPersonnelHead,isPersonnelMember} from '../lib/leave-permissions.js';
import {isSchoolDirector} from './student-deletion.js';

const headers={'Cache-Control':'private, no-store'};
const json=(data,status=200)=>jsonResponse(data,status,headers);
const fail=(error,status=400)=>json({error},status);
const text=(v,max)=>typeof v==='string'?v.trim().slice(0,max):'';
const validDate=v=>/^\d{4}-\d{2}-\d{2}$/.test(v||'')&&!Number.isNaN(Date.parse(v+'T00:00:00Z'));
export const DUTY_PARTS={full:'เต็มวัน',morning:'ครึ่งวันเช้า',afternoon:'ครึ่งวันบ่าย'};
// คาบที่ไม่อยู่ตามช่วงเวลา (พักกลางวันหลังคาบ 3): null = ทั้งวัน
export const dutyPeriods=part=>part==='morning'?[1,2,3]:part==='afternoon'?[4,5,6,7,8]:null;
const FILE_MAX=10*1024*1024;
const FILE_TYPES=new Set(['application/pdf','image/jpeg','image/png','image/webp','image/heic','application/vnd.openxmlformats-officedocument.wordprocessingml.document','application/msword']);

const ready=new WeakSet();
export async function ensureOfficialDuty(env){
 if(ready.has(env.DB))return;
 await env.DB.batch([
  env.DB.prepare(`CREATE TABLE IF NOT EXISTS official_duties(
   id INTEGER PRIMARY KEY AUTOINCREMENT,
   user_id INTEGER NOT NULL REFERENCES users(id),
   title TEXT NOT NULL,location TEXT,
   start_date TEXT NOT NULL,end_date TEXT NOT NULL,
   day_part TEXT NOT NULL DEFAULT 'full' CHECK(day_part IN ('full','morning','afternoon')),
   note TEXT,
   file_drive_id TEXT,file_name TEXT,file_mime TEXT,
   status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','acknowledged','cancelled')),
   acknowledged_by INTEGER REFERENCES users(id),acknowledged_at TEXT,
   cancelled_by INTEGER REFERENCES users(id),cancelled_at TEXT,
   created_at TEXT NOT NULL DEFAULT(datetime('now')),updated_at TEXT NOT NULL DEFAULT(datetime('now')))`),
  env.DB.prepare('CREATE INDEX IF NOT EXISTS idx_official_duties_dates ON official_duties(start_date,end_date)'),
  env.DB.prepare('CREATE INDEX IF NOT EXISTS idx_official_duties_user ON official_duties(user_id)')
 ]);
 ready.add(env.DB);
}
// ครูที่ไปราชการในวันที่กำหนด (ใช้ในหน้าจัดสอนแทน) — ไม่รวมที่ยกเลิก
export async function dutyAbsences(env,date){
 await ensureOfficialDuty(env);
 const {results}=await env.DB.prepare(`SELECT d.id AS duty_id,p.id AS teacher_id,p.full_name,d.title,d.location,d.day_part,d.status
  FROM official_duties d JOIN personnel_accounts a ON a.user_id=d.user_id
  JOIN personnel_records p ON p.id=a.personnel_id AND p.status='active'
  WHERE ? BETWEEN d.start_date AND d.end_date AND d.status<>'cancelled' ORDER BY p.full_name,d.id`).bind(date).all();
 return results;
}
export async function dutyDateRanges(env,first,last){
 await ensureOfficialDuty(env);
 const {results}=await env.DB.prepare(`SELECT d.start_date,d.end_date FROM official_duties d JOIN personnel_accounts a ON a.user_id=d.user_id
  JOIN personnel_records p ON p.id=a.personnel_id AND p.status='active'
  WHERE d.status<>'cancelled' AND d.start_date<=? AND d.end_date>=?`).bind(last,first).all();
 return results;
}
async function access(env,user){
 const director=await isSchoolDirector(env,user);
 const head=await isPersonnelHead(env,user),member=head||await isPersonnelMember(env,user);
 const admin=user.role==='superadmin';
 return {director,head,member,admin,viewAll:admin||director||member||user.role==='executive',manage:admin||head};
}
const select=`SELECT d.*,u.full_name,ack.full_name AS acknowledged_name FROM official_duties d
 JOIN users u ON u.id=d.user_id LEFT JOIN users ack ON ack.id=d.acknowledged_by`;
function shape(r,user,acc){
 const own=Number(r.user_id)===Number(user.id);
 return {...r,file_drive_id:undefined,has_file:!!r.file_drive_id,day_part_label:DUTY_PARTS[r.day_part],
  can_acknowledge:acc.director&&r.status==='pending'&&!own,
  can_cancel:r.status!=='cancelled'&&(acc.manage||(own&&r.status==='pending')),
  can_attach:r.status!=='cancelled'&&(own||acc.manage)};
}
async function uploadFile(request,env,id,user,acc,drive){
 const row=await env.DB.prepare(select+' WHERE d.id=?').bind(id).first();
 if(!row)return fail('ไม่พบรายการไปราชการ',404);
 if(!shape(row,user,acc).can_attach)return fail('ไม่มีสิทธิ์แนบไฟล์รายการนี้',403);
 if(!drive||drive.ready(env))return fail('ยังไม่ได้ตั้งค่า Google Drive',503);
 const mime=String(request.headers.get('Content-Type')||'').split(';')[0].trim().toLowerCase();
 if(!FILE_TYPES.has(mime))return fail('แนบได้เฉพาะ PDF รูปภาพ หรือ Word');
 const bytes=new Uint8Array(await request.arrayBuffer());
 if(!bytes.length||bytes.length>FILE_MAX)return fail('ไฟล์ต้องมีขนาดไม่เกิน 10 MB');
 let name='หนังสือคำสั่ง';try{name=decodeURIComponent(request.headers.get('X-File-Name')||name);}catch{}
 name=name.replace(/[\\/:*?"<>|]/g,'_').slice(0,150)||'หนังสือคำสั่ง';
 const token=await drive.token(env),quote=v=>String(v).replace(/\\/g,'\\\\').replace(/'/g,"\\'");
 let parent=String(env.GOOGLE_DRIVE_FOLDER_ID);
 for(const folder of ['ไปราชการ',`ปี ${Number(String(row.start_date).slice(0,4))+543}`,String(row.full_name||'ไม่ระบุชื่อ').trim().slice(0,120)]){
  const q=encodeURIComponent(`'${quote(parent)}' in parents and name='${quote(folder)}' and mimeType='application/vnd.google-apps.folder' and trashed=false`);
  const found=await drive.request(token,`/files?q=${q}&pageSize=1&fields=files(id)`).then(r=>r.json());
  parent=found.files?.[0]?.id||(await drive.request(token,'/files?fields=id',{method:'POST',headers:{'Content-Type':'application/json'},
   body:JSON.stringify({name:folder,mimeType:'application/vnd.google-apps.folder',parents:[parent]})}).then(r=>r.json())).id;
 }
 const boundary=`duty_${crypto.randomUUID()}`,fileName=`ไปราชการ-${row.id}-${name}`;
 const body=new Blob([`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify({name:fileName,mimeType:mime,parents:[parent]})}\r\n`,
  `--${boundary}\r\nContent-Type: ${mime}\r\n\r\n`,bytes,`\r\n--${boundary}--`]);
 const file=await drive.request(token,'/upload/drive/v3/files?uploadType=multipart&fields=id',{method:'POST',headers:{'Content-Type':`multipart/related; boundary=${boundary}`},body}).then(r=>r.json());
 if(!file?.id)return fail('อัปโหลดไฟล์ไป Google Drive ไม่สำเร็จ',502);
 const old=row.file_drive_id;
 await env.DB.prepare("UPDATE official_duties SET file_drive_id=?,file_name=?,file_mime=?,updated_at=datetime('now') WHERE id=?").bind(file.id,name,mime,id).run();
 if(old)await drive.request(token,`/files/${encodeURIComponent(old)}`,{method:'DELETE'}).catch(()=>{});
 return json({ok:true});
}
async function readFile(env,id,user,acc,drive){
 const row=await env.DB.prepare('SELECT user_id,file_drive_id,file_name,file_mime FROM official_duties WHERE id=?').bind(id).first();
 if(!row?.file_drive_id)return fail('ไม่พบไฟล์',404);
 if(!acc.viewAll&&Number(row.user_id)!==Number(user.id))return fail('ไม่มีสิทธิ์เปิดไฟล์นี้',403);
 if(!drive||drive.ready(env))return fail('ยังไม่ได้ตั้งค่า Google Drive',503);
 const res=await drive.request(await drive.token(env),`/files/${encodeURIComponent(row.file_drive_id)}?alt=media&supportsAllDrives=true`);
 if(!res.ok)return fail('เปิดไฟล์จาก Google Drive ไม่สำเร็จ',502);
 return new Response(res.body,{headers:{'Content-Type':row.file_mime||'application/octet-stream','Cache-Control':'private, no-store',
  'Content-Disposition':`inline; filename*=UTF-8''${encodeURIComponent(row.file_name||'file')}`}});
}
export async function handleOfficialDutyRoute(request,env,pathname,method,drive=null){
 if(!pathname.startsWith('/api/official-duties'))return null;
 const user=await getCurrentUser(request,env);if(!user?.role)return fail('กรุณาเข้าสู่ระบบ',401);
 await ensureOfficialDuty(env);
 const acc=await access(env,user);
 const readOnly=!!user.view_as?.read_only||user.role==='viewer';
 const fileMatch=pathname.match(/^\/api\/official-duties\/(\d+)\/file$/);
 if(fileMatch){
  if(method==='GET')return readFile(env,Number(fileMatch[1]),user,acc,drive);
  if(method==='POST'){if(readOnly)return fail('โหมดดูบัญชีอื่นอ่านได้อย่างเดียว',403);return uploadFile(request,env,Number(fileMatch[1]),user,acc,drive);}
  return fail('Method not allowed',405);
 }
 if(pathname==='/api/official-duties'&&method==='GET'){
  const {results}=await env.DB.prepare(select+(acc.viewAll?'':' WHERE d.user_id=?')+' ORDER BY d.start_date DESC,d.id DESC LIMIT 500').bind(...(acc.viewAll?[]:[user.id])).all();
  return json({duties:results.map(r=>shape(r,user,acc)),can_view_all:acc.viewAll,is_director:acc.director});
 }
 if(readOnly)return fail('โหมดดูบัญชีอื่นอ่านได้อย่างเดียว',403);
 if(pathname==='/api/official-duties'&&method==='POST'){
  const body=await request.json().catch(()=>null);
  const title=text(body?.title,300),location=text(body?.location,300),note=text(body?.note,1000);
  const start=body?.start_date,end=body?.end_date,part=DUTY_PARTS[body?.day_part]?body.day_part:'full';
  if(!title)return fail('กรุณาระบุเรื่องที่ไปราชการ');
  if(!location)return fail('กรุณาระบุสถานที่');
  if(!validDate(start)||!validDate(end)||end<start)return fail('ระบุวันที่เริ่มและสิ้นสุดให้ถูกต้อง');
  if(part!=='full'&&start!==end)return fail('ไปราชการครึ่งวันต้องเป็นวันเดียวกัน');
  const dup=await env.DB.prepare("SELECT id FROM official_duties WHERE user_id=? AND status<>'cancelled' AND start_date<=? AND end_date>=? AND created_at>=datetime('now','-1 minute')").bind(user.id,end,start).first();
  if(dup)return fail('มีรายการไปราชการช่วงวันนี้เพิ่งบันทึกไปแล้ว',409);
  // ผอ. ไปราชการเอง = รับทราบอัตโนมัติ
  const self=acc.director;
  const r=await env.DB.prepare(`INSERT INTO official_duties(user_id,title,location,start_date,end_date,day_part,note,status,acknowledged_by,acknowledged_at)
   VALUES(?,?,?,?,?,?,?,?,?,${self?"datetime('now')":'NULL'})`).bind(user.id,title,location,start,end,part,note||null,self?'acknowledged':'pending',self?user.id:null).run();
  return json({ok:true,id:Number(r.meta.last_row_id)},201);
 }
 const one=pathname.match(/^\/api\/official-duties\/(\d+)$/);
 if(one){
  const id=Number(one[1]);
  const row=await env.DB.prepare(select+' WHERE d.id=?').bind(id).first();
  if(!row)return fail('ไม่พบรายการไปราชการ',404);
  const s=shape(row,user,acc);
  if(method==='PATCH'){
   const body=await request.json().catch(()=>null);
   if(body?.action==='acknowledge'){
    if(!s.can_acknowledge)return fail('เฉพาะ ผอ. ที่กดรับทราบได้',403);
    await env.DB.prepare("UPDATE official_duties SET status='acknowledged',acknowledged_by=?,acknowledged_at=datetime('now'),updated_at=datetime('now') WHERE id=? AND status='pending'").bind(user.id,id).run();
    return json({ok:true});
   }
   return fail('คำสั่งไม่ถูกต้อง');
  }
  if(method==='DELETE'){
   if(!s.can_cancel)return fail('ไม่มีสิทธิ์ยกเลิกรายการนี้',403);
   await env.DB.prepare("UPDATE official_duties SET status='cancelled',cancelled_by=?,cancelled_at=datetime('now'),updated_at=datetime('now') WHERE id=?").bind(user.id,id).run();
   return json({ok:true});
  }
  return fail('Method not allowed',405);
 }
 return fail('ไม่พบ endpoint',404);
}
