import {ensurePersonnelData} from './personnel-data.js';
import {getCurrentUser,jsonResponse} from './auth.js';

export async function ensureSignatures(env){
 await ensurePersonnelData(env);
 await env.DB.prepare(`CREATE TABLE IF NOT EXISTS teacher_signatures (
  user_id INTEGER PRIMARY KEY,data_url TEXT NOT NULL,updated_at TEXT NOT NULL DEFAULT(datetime('now')))` ).run();
}
export async function signatureFor(env,userId){
 await ensureSignatures(env);
 return (await env.DB.prepare(`SELECT data_url,updated_at FROM teacher_signatures WHERE user_id=? OR user_id IN
  (SELECT b.user_id FROM personnel_accounts a JOIN personnel_accounts b ON b.personnel_id=a.personnel_id WHERE a.user_id=?)
  ORDER BY (user_id=?) DESC,updated_at DESC LIMIT 1`).bind(userId,userId,userId).first())||null;
}
export function validSignature(value){
 if(typeof value!=='string'||value.length>400*1024||!/^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/.test(value))return false;
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
export async function handleSignatureRoute(request,env,pathname,method){
 if(pathname!=='/api/signatures')return null;
 const reply=(body,status=200)=>jsonResponse(body,status,{'Cache-Control':'private, no-store'});
 const user=await getCurrentUser(request,env);
 if(!user?.role||user.role==='viewer')return reply({error:'กรุณาเข้าสู่ระบบด้วยบัญชีบุคลากร'},403);
 const target=Number(new URL(request.url).searchParams.get('user_id')||user.id);
 if(!Number.isSafeInteger(target)||target<=0)return reply({error:'บัญชีไม่ถูกต้อง'},400);
 if(target!==Number(user.id)){
  if(user.role!=='superadmin')return reply({error:'ไม่มีสิทธิ์จัดการลายเซ็นของผู้อื่น'},403);
  const assigned=await env.DB.prepare(`SELECT 1 FROM users u WHERE u.id=? AND u.status='active' AND u.deleted_at IS NULL
   AND (EXISTS(SELECT 1 FROM budget_role_assignments b WHERE b.user_id=u.id)
    OR EXISTS(SELECT 1 FROM personnel_accounts a JOIN personnel_records p ON p.id=a.personnel_id
     WHERE a.user_id=u.id AND p.status='active' AND p.position LIKE '%ผู้อำนวยการ%'))`).bind(target).first();
  if(!assigned)return reply({error:'กรุณากำหนดบัญชีผู้อนุมัติก่อนอัปโหลดลายเซ็น'},403);
 }
 if(method==='GET')return reply({signature:await signatureFor(env,target)});
 if(method!=='PUT')return reply({error:'Method not allowed'},405);
 const body=await request.json().catch(()=>null);
 if(!validSignature(body?.data_url))return reply({error:'ลายเซ็นต้องเป็นภาพ PNG ขนาดไม่เกิน 400 KB และกว้าง/สูงไม่เกิน 2,000 พิกเซล'},400);
 await ensureSignatures(env);
 await env.DB.batch([
  env.DB.prepare(`INSERT INTO teacher_signatures(user_id,data_url) VALUES(?,?)
   ON CONFLICT(user_id) DO UPDATE SET data_url=excluded.data_url,updated_at=datetime('now')`).bind(target,body.data_url),
  env.DB.prepare("INSERT INTO audit_logs(user_id,action,resource,resource_id,details) VALUES(?,'update','signature',?,?)")
   .bind(user.id,target,JSON.stringify({source:target===Number(user.id)?'self':'approver_settings'}))
 ]);
 return reply({ok:true,signature:await signatureFor(env,target)});
}
