// ข้อเสนอแนะไม่ระบุชื่อ: ทุกบัญชีส่งได้ แอดมินเท่านั้นที่อ่าน
// ไม่เก็บผู้ส่ง (ไม่มี user_id/IP) · กันสแปมด้วยโควตารายวันที่อ้างอิง HMAC ของผู้ใช้+วัน ซึ่งย้อนกลับเป็นตัวบุคคลไม่ได้หากไม่มี secret
import {getCurrentUser,isAdmin,jsonResponse} from '../lib/auth.js';

export const FEEDBACK_MAX_LENGTH=2000;
export const FEEDBACK_DAILY_LIMIT=5;
const ready=new WeakSet();
export async function ensureFeedbackSchema(env){
 if(ready.has(env.DB))return;
 await env.DB.batch([
  env.DB.prepare(`CREATE TABLE IF NOT EXISTS anonymous_feedback (
   id INTEGER PRIMARY KEY AUTOINCREMENT,
   message TEXT NOT NULL,
   created_at TEXT NOT NULL)`),
  env.DB.prepare(`CREATE TABLE IF NOT EXISTS anonymous_feedback_quota (
   token TEXT PRIMARY KEY,
   day TEXT NOT NULL,
   count INTEGER NOT NULL DEFAULT 0)`),
 ]);
 ready.add(env.DB);
}
const bangkokDay=()=>new Date(Date.now()+7*3600000).toISOString().slice(0,10);
// ปัดเวลาเป็นรายชั่วโมง เพื่อไม่ให้จับคู่เวลาส่งกับกิจกรรมอื่นของผู้ใช้ได้ง่าย
const hourStamp=()=>new Date().toISOString().slice(0,13).replace('T',' ')+':00:00';
async function quotaToken(env,userId,day){
 const key=await crypto.subtle.importKey('raw',new TextEncoder().encode(String(env.JWT_SECRET||'feedback')),{name:'HMAC',hash:'SHA-256'},false,['sign']);
 const sig=await crypto.subtle.sign('HMAC',key,new TextEncoder().encode(`anonymous-feedback:${userId}:${day}`));
 return [...new Uint8Array(sig)].map(b=>b.toString(16).padStart(2,'0')).join('');
}
export function cleanFeedback(text){
 const value=String(text??'').replace(/\r\n?/g,'\n').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g,'').trim();
 if(!value||value.length>FEEDBACK_MAX_LENGTH)return null;
 return value;
}

export async function handleFeedbackRoute(request,env,pathname,method){
 if(pathname!=='/api/feedback')return null;
 const user=await getCurrentUser(request,env);
 if(!user?.id)return jsonResponse({error:'กรุณาเข้าสู่ระบบ'},401);
 await ensureFeedbackSchema(env);
 if(method==='GET'){
  if(!isAdmin(user))return jsonResponse({canRead:false,max:FEEDBACK_MAX_LENGTH},200,{'Cache-Control':'no-store'});
  const {results}=await env.DB.prepare('SELECT id,message,created_at FROM anonymous_feedback ORDER BY id DESC LIMIT 200').all();
  return jsonResponse({canRead:true,items:results,max:FEEDBACK_MAX_LENGTH},200,{'Cache-Control':'no-store'});
 }
 if(method==='POST'){
  if(user.view_as)return jsonResponse({error:'โหมดดูในสิทธิ์ผู้อื่นส่งข้อเสนอแนะไม่ได้'},403);
  let body;try{body=await request.json();}catch{return jsonResponse({error:'ข้อมูลไม่ถูกต้อง'},400);}
  const message=cleanFeedback(body?.message);
  if(!message)return jsonResponse({error:`กรุณาพิมพ์ข้อเสนอแนะ (ไม่เกิน ${FEEDBACK_MAX_LENGTH} ตัวอักษร)`},400);
  const day=bangkokDay(),token=await quotaToken(env,user.id,day);
  await env.DB.prepare('DELETE FROM anonymous_feedback_quota WHERE day<>?').bind(day).run();
  const used=await env.DB.prepare('SELECT count FROM anonymous_feedback_quota WHERE token=?').bind(token).first();
  if((used?.count||0)>=FEEDBACK_DAILY_LIMIT)return jsonResponse({error:`ส่งได้วันละ ${FEEDBACK_DAILY_LIMIT} ครั้ง ลองใหม่พรุ่งนี้`},429);
  await env.DB.batch([
   env.DB.prepare('INSERT INTO anonymous_feedback (message,created_at) VALUES (?,?)').bind(message,hourStamp()),
   env.DB.prepare(`INSERT INTO anonymous_feedback_quota (token,day,count) VALUES (?,?,1)
    ON CONFLICT(token) DO UPDATE SET count=count+1`).bind(token,day),
  ]);
  return jsonResponse({ok:true},201);
 }
 return jsonResponse({error:'Method not allowed'},405);
}
