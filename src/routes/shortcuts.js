// เมนูลัดของฉัน: ผู้ใช้เลือกเมนูที่ใช้บ่อยไว้ในเมนูมือถือ เก็บตามบัญชี
import {getCurrentUser,jsonResponse} from '../lib/auth.js';

const MAX=12;
let ready=false;
async function ensure(env){
 if(ready)return;
 await env.DB.prepare(`CREATE TABLE IF NOT EXISTS user_shortcuts (
  user_id INTEGER PRIMARY KEY,
  items TEXT NOT NULL DEFAULT '[]',
  updated_at TEXT NOT NULL DEFAULT (datetime('now')))`).run();
 ready=true;
}
// เฉพาะลิงก์ภายในระบบ (path ขึ้นต้นด้วย / ตัวเดียว) หรือ https ภายนอกที่อยู่ในเมนูอยู่แล้ว
export function cleanShortcuts(list){
 if(!Array.isArray(list))return null;
 const out=[],seen=new Set();
 for(const it of list){
  const url=String(it?.url||'').trim(),label=String(it?.label||'').replace(/\s+/g,' ').trim().slice(0,60);
  const ok=(/^\/(?!\/)[^\s\\]*$/.test(url)||/^https:\/\/[a-z0-9.-]+\.banpadengschool\.ac\.th(\/[^\s\\]*)?$/i.test(url))&&url.length<=300;
  if(!ok||!label||seen.has(url))continue;
  seen.add(url);out.push({url,label});
  if(out.length>=MAX)break;
 }
 return out;
}

export async function handleShortcutsRoute(request,env,pathname,method){
 if(pathname!=='/api/shortcuts')return null;
 const user=await getCurrentUser(request,env);
 if(!user?.id)return jsonResponse({error:'กรุณาเข้าสู่ระบบ'},401);
 await ensure(env);
 if(method==='GET'){
  const row=await env.DB.prepare('SELECT items FROM user_shortcuts WHERE user_id=?').bind(user.id).first();
  let items=[];try{items=cleanShortcuts(JSON.parse(row?.items||'[]'))||[];}catch{}
  return jsonResponse({items,max:MAX},200,{'Cache-Control':'no-store'});
 }
 if(method==='PUT'){
  if(user.view_as)return jsonResponse({error:'โหมดดูในสิทธิ์ผู้อื่นแก้ไขไม่ได้'},403);
  let body;try{body=await request.json();}catch{return jsonResponse({error:'ข้อมูลไม่ถูกต้อง'},400);}
  const items=cleanShortcuts(body?.items);
  if(!items)return jsonResponse({error:'ข้อมูลไม่ถูกต้อง'},400);
  await env.DB.prepare(`INSERT INTO user_shortcuts (user_id,items,updated_at) VALUES (?,?,datetime('now'))
   ON CONFLICT(user_id) DO UPDATE SET items=excluded.items,updated_at=excluded.updated_at`).bind(user.id,JSON.stringify(items)).run();
  return jsonResponse({items,max:MAX});
 }
 return jsonResponse({error:'Method not allowed'},405);
}
