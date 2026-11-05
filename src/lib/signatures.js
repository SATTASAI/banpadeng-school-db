import {ensurePersonnelData} from './personnel-data.js';
import {getCurrentUser,jsonResponse} from './auth.js';
import {executives,isDirector,isDeputy,designatedDeputy} from './leave-data.js';

// ลายเซ็น 1 คน 1 ภาพ (PNG พื้นใส) ใช้ร่วมทุกเอกสาร · locked=1 เมื่อ Superadmin อัปโหลดจากหน้าตั้งค่าผู้อนุมัติ
// ลายเซ็นที่ล็อคแล้วเจ้าของเปลี่ยนเองไม่ได้ ต้องแจ้ง Superadmin
const ready=new WeakMap();
export function ensureSignatures(env){
 if(ready.has(env.DB))return ready.get(env.DB);
 const p=(async()=>{
  await ensurePersonnelData(env);
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS teacher_signatures (
   user_id INTEGER PRIMARY KEY,data_url TEXT NOT NULL,updated_at TEXT NOT NULL DEFAULT(datetime('now')),locked INTEGER NOT NULL DEFAULT 0)` ).run();
  const cols=(await env.DB.prepare('PRAGMA table_info(teacher_signatures)').all()).results;
  if(!cols.some(c=>c.name==='locked'))await env.DB.prepare('ALTER TABLE teacher_signatures ADD COLUMN locked INTEGER NOT NULL DEFAULT 0').run().catch(()=>{});
 })().catch(e=>{ready.delete(env.DB);throw e;});
 ready.set(env.DB,p);return p;
}
export async function signatureLocked(env,userId){
 await ensureSignatures(env);
 return !!(await env.DB.prepare('SELECT 1 FROM teacher_signatures WHERE user_id=? AND locked=1').bind(userId).first());
}
// ลายเซ็นหลายคนพร้อมกัน (สำหรับพิมพ์เอกสาร) → {user_id:data_url}
export async function signaturesFor(env,userIds){
 const out={};for(const id of [...new Set(userIds.map(Number).filter(Boolean))]){const s=await signatureFor(env,id);if(s)out[id]=s.data_url;}
 return out;
}
const LOCKED_MESSAGE='ลายเซ็นนี้ถูกล็อคโดยผู้ดูแลระบบ หากต้องการเปลี่ยน กรุณาแจ้ง Superadmin';
export {LOCKED_MESSAGE};
// ขนาดลายเซ็นสูงสุด: D1 จำกัดคำสั่ง SQL (รวมค่าที่ส่งเข้าไป) ไว้ 100 KB ต่อคำสั่ง เก็บให้ต่ำกว่ามากเพื่อให้มีที่เหลือ
export const SIGNATURE_MAX_BYTES=60*1024;
// ซับคิวรีลายเซ็นของบัญชี (รวมบัญชีที่ผูกบุคลากรเดียวกัน) — ให้ D1 คัดลอกลายเซ็นเองโดยไม่ต้องส่งข้อมูลภาพในคำสั่ง ใช้ค่าผูก 3 ตัว (userId ซ้ำ 3 ครั้ง)
export const signatureSql=`(SELECT s.data_url FROM teacher_signatures s WHERE s.user_id=? OR s.user_id IN
 (SELECT b.user_id FROM personnel_accounts a JOIN personnel_accounts b ON b.personnel_id=a.personnel_id WHERE a.user_id=?)
 ORDER BY (s.user_id=?) DESC,s.updated_at DESC LIMIT 1)`;
export async function signatureFor(env,userId){
 await ensureSignatures(env);
 return (await env.DB.prepare(`SELECT data_url,updated_at,locked FROM teacher_signatures WHERE user_id=? OR user_id IN
  (SELECT b.user_id FROM personnel_accounts a JOIN personnel_accounts b ON b.personnel_id=a.personnel_id WHERE a.user_id=?)
  ORDER BY (user_id=?) DESC,updated_at DESC LIMIT 1`).bind(userId,userId,userId).first())||null;
}
export function validSignature(value){
 if(typeof value!=='string'||value.length>SIGNATURE_MAX_BYTES||!/^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/.test(value))return false;
 try{
  const bytes=Uint8Array.from(atob(value.split(',')[1]),c=>c.charCodeAt(0));
  if(bytes.length<45||![137,80,78,71,13,10,26,10].every((n,i)=>bytes[i]===n)||String.fromCharCode(...bytes.slice(12,16))!=='IHDR')return false;
  const view=new DataView(bytes.buffer),w=view.getUint32(16),h=view.getUint32(20);
  if(!(w>0&&h>0&&w<=2000&&h<=2000&&w*h<=2000000))return false;
  let offset=8,hasData=false;
  while(offset+12<=bytes.length){
   const length=view.getUint32(offset),end=offset+12+length;
   if(end>bytes.length)return false;
   let crc=0xffffffff;
   for(let i=offset+4;i<end-4;i++){crc^=bytes[i];for(let bit=0;bit<8;bit++)crc=(crc>>>1)^((crc&1)?0xedb88320:0);}
   if(((crc^0xffffffff)>>>0)!==view.getUint32(end-4))return false;
   const type=String.fromCharCode(...bytes.slice(offset+4,offset+8));
   if(type==='IDAT'&&length)hasData=true;
   if(type==='IEND')return hasData&&length===0&&end===bytes.length;
   offset=end;
  }
  return false;
 }catch{return false;}
}
// ผู้ลงนามเอกสารใบลาและนิเทศ (นอกเหนือจากบทบาทงบประมาณ) สำหรับการ์ดในหน้าตั้งค่าผู้อนุมัติ
async function documentSigners(env){
 const people=await executives(env),out=[],add=(task,scope,p)=>{const user_id=Number(p?.user_ids?.[0]??p?.user_id);if(user_id)out.push({task,scope,user_id,full_name:p.full_name});};
 for(const p of people.filter(isDirector))add('ผู้อำนวยการ','ผู้อนุมัติใบลา · ลงนามแบบนิเทศ',p);
 add('รองผู้อำนวยการ (ใบลา)','ผู้ตรวจสอบใบลา',await designatedDeputy(env,people).catch(()=>null));
 const ev=await env.DB.prepare(`SELECT u.id user_id,u.full_name FROM supervision_evaluators s JOIN users u ON u.id=s.user_id
  WHERE u.status='active' AND u.deleted_at IS NULL ORDER BY u.full_name`).all().catch(()=>({results:[]}));
 for(const p of ev.results)add('ผู้นิเทศ','ลงนามแบบนิเทศการสอน',p);
 for(const p of people.filter(p=>isDeputy(p)))if(!out.some(x=>x.user_id===Number(p.user_ids[0])&&x.task==='ผู้นิเทศ'))add('ผู้นิเทศ (ผู้บริหาร)','ลงนามแบบนิเทศการสอน',p);
 return out;
}
async function signerList(env,user,reply){
 if(user.role!=='superadmin')return reply({error:'เฉพาะ Superadmin'},403);
 await ensureSignatures(env);
 const signers=await documentSigners(env);
 const {results}=await env.DB.prepare('SELECT user_id,locked,updated_at FROM teacher_signatures').all();
 return reply({signers,signed:Object.fromEntries(results.map(r=>[r.user_id,{locked:!!r.locked,updated_at:r.updated_at}]))});
}
export async function handleSignatureRoute(request,env,pathname,method){
 if(pathname!=='/api/signatures'&&pathname!=='/api/signatures/signers')return null;
 const reply=(body,status=200)=>jsonResponse(body,status,{'Cache-Control':'private, no-store'});
 const user=await getCurrentUser(request,env);
 if(!user?.role||user.role==='viewer')return reply({error:'กรุณาเข้าสู่ระบบด้วยบัญชีบุคลากร'},403);
 if(pathname==='/api/signatures/signers')return method==='GET'?signerList(env,user,reply):reply({error:'Method not allowed'},405);
 const param=new URL(request.url).searchParams.get('user_id');
 const target=Number(param||user.id),byAdmin=!!param&&user.role==='superadmin';
 if(!Number.isSafeInteger(target)||target<=0)return reply({error:'บัญชีไม่ถูกต้อง'},400);
 if(target!==Number(user.id)){
  if(user.role!=='superadmin')return reply({error:'ไม่มีสิทธิ์จัดการลายเซ็นของผู้อื่น'},403);
  const assigned=await env.DB.prepare(`SELECT 1 FROM users u WHERE u.id=? AND u.status='active' AND u.deleted_at IS NULL
   AND (EXISTS(SELECT 1 FROM budget_role_assignments b WHERE b.user_id=u.id)
    OR EXISTS(SELECT 1 FROM personnel_accounts a JOIN personnel_records p ON p.id=a.personnel_id
     WHERE a.user_id=u.id AND p.status='active' AND p.position LIKE '%ผู้อำนวยการ%'))`).bind(target).first()
   ||(await documentSigners(env)).some(s=>s.user_id===target);
  if(!assigned)return reply({error:'กรุณากำหนดบัญชีผู้อนุมัติก่อนอัปโหลดลายเซ็น'},403);
 }
 if(method==='GET')return reply({signature:await signatureFor(env,target)});
 if(method!=='PUT')return reply({error:'Method not allowed'},405);
 const body=await request.json().catch(()=>null);
 if(!validSignature(body?.data_url))return reply({error:'ลายเซ็นต้องเป็นภาพ PNG ขนาดไม่เกิน 60 KB และกว้าง/สูงไม่เกิน 2,000 พิกเซล'},400);
 await ensureSignatures(env);
 if(!byAdmin&&await signatureLocked(env,target))return reply({error:LOCKED_MESSAGE},423);
 await env.DB.batch([
  env.DB.prepare(`INSERT INTO teacher_signatures(user_id,data_url,locked) VALUES(?,?,?)
   ON CONFLICT(user_id) DO UPDATE SET data_url=excluded.data_url,locked=MAX(teacher_signatures.locked,excluded.locked),updated_at=datetime('now')`).bind(target,body.data_url,byAdmin?1:0),
  env.DB.prepare("INSERT INTO audit_logs(user_id,action,resource,resource_id,details) VALUES(?,'update','signature',?,?)")
   .bind(user.id,target,JSON.stringify({source:byAdmin?'approver_settings':'self',locked:byAdmin}))
 ]);
 return reply({ok:true,signature:await signatureFor(env,target)});
}
