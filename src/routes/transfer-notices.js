import { getCurrentUser, jsonResponse } from '../lib/auth.js';
import { ensureTransferAccess, mayUseTransfers } from '../lib/transfer-access.js';
import { ensureStudentTransfers } from './student-transfers.js';
const ready = new WeakSet();
const reply = (data, status=200) => jsonResponse(data,status,{'Cache-Control':'no-store'});
export async function ensureTransferNotices(env) {
  if (ready.has(env.DB)) return;
  await ensureTransferAccess(env);
  await env.DB.batch([
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS student_transfer_notices (
      id INTEGER PRIMARY KEY AUTOINCREMENT, receipt TEXT NOT NULL UNIQUE, client_ref TEXT NOT NULL UNIQUE,
      student_name TEXT NOT NULL, direction TEXT NOT NULL CHECK(direction IN ('in','out')),
      destination_school TEXT NOT NULL DEFAULT '', contact_phone TEXT NOT NULL, contact_address TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')), acknowledged_by INTEGER REFERENCES users(id), acknowledged_at TEXT)`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS student_transfer_notice_limits (
      bucket TEXT PRIMARY KEY, attempts INTEGER NOT NULL, expires_at INTEGER NOT NULL)`),
  ]);
  ready.add(env.DB);
}
export function normalizeNotice(body) {
  if (!body || typeof body !== 'object') return {error:'รูปแบบข้อมูลไม่ถูกต้อง'};
  const record={};
  for (const [key,max] of Object.entries({student_name:180,contact_phone:30,contact_address:1000})) {
    const value=typeof body[key]==='string'?body[key].trim():'';
    if (!value || value.length>max) return {error:'กรุณากรอกชื่อ เบอร์โทร และที่อยู่ให้ครบตามกำหนด'};
    record[key]=value;
  }
  record.contact_phone=record.contact_phone.replace(/[\s()-]/g,'');
  if (!/^(?:0\d{8,9}|\+\d{8,15})$/.test(record.contact_phone)) return {error:'กรุณาตรวจสอบเบอร์โทรศัพท์'};
  if (!['in','out'].includes(body.direction)) return {error:'กรุณาเลือกย้ายเข้าหรือย้ายออก'};
  record.direction=body.direction;
  record.destination_school=typeof body.destination_school==='string'?body.destination_school.trim():'';
  if (record.destination_school.length>200 || (body.direction==='out' && !record.destination_school)) return {error:'กรุณาระบุโรงเรียนปลายทางสำหรับการย้ายออก'};
  if (body.direction==='in') record.destination_school='';
  if (typeof body.client_ref!=='string' || !/^[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/i.test(body.client_ref)) return {error:'กรุณาเปิดแบบฟอร์มใหม่แล้วลองอีกครั้ง'};
  record.client_ref=body.client_ref;
  return {record};
}
async function boundedJson(request) {
  if (!request.headers.get('Content-Type')?.includes('application/json')) return null;
  const reader=request.body?.getReader(); if(!reader)return null;
  const chunks=[];let size=0;
  while(true){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>8192){await reader.cancel();return null;}chunks.push(value);}
  const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}
  try{return JSON.parse(new TextDecoder().decode(bytes));}catch{return null;}
}
export async function handleTransferNotices(request,env,path,method) {
  const publicPath=path==='/api/public/transfer-notices';
  const staffPath=path==='/api/student-transfers/notices' || path==='/api/student-transfers/notices/summary' || /^\/api\/student-transfers\/notices\/\d+\/acknowledge$/.test(path);
  if(!publicPath&&!staffPath)return null;
  if(publicPath && method!=='POST')return reply({error:'Method not allowed'},405);
  let user;
  if(staffPath){user=await getCurrentUser(request,env);if(!user?.role)return reply({error:'กรุณาเข้าสู่ระบบ'},401);if(!await mayUseTransfers(env,user))return reply({error:'ไม่มีสิทธิ์ดูหลักฐานแจ้งย้าย'},403);}
  if(!['GET','HEAD','OPTIONS'].includes(method)){
    const origin=request.headers.get('Origin');if(origin&&origin!==new URL(request.url).origin)return reply({error:'ไม่อนุญาตคำขอจากเว็บไซต์อื่น'},403);
  }
  await ensureTransferNotices(env);
  if(publicPath){
    const body=await boundedJson(request);const parsed=normalizeNotice(body);
    if(parsed.error)return reply({error:parsed.error},400);
    if(body.website)return reply({error:'ไม่สามารถรับข้อมูลได้'},400);
    const now=Math.floor(Date.now()/1000),ip=request.headers.get('CF-Connecting-IP')||'local';
    const hash=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(ip+':'+Math.floor(now/3600))))).map(x=>x.toString(16).padStart(2,'0')).join('');
    const limit=await env.DB.prepare(`INSERT INTO student_transfer_notice_limits(bucket,attempts,expires_at) VALUES(?,1,?) ON CONFLICT(bucket) DO UPDATE SET attempts=attempts+1 RETURNING attempts`).bind(hash,now+7200).first();
    if(limit.attempts>20)return reply({error:'ส่งข้อมูลถี่เกินไป กรุณาลองใหม่ภายหลัง'},429);
    await env.DB.prepare('DELETE FROM student_transfer_notice_limits WHERE expires_at < ?').bind(now).run();
    const r=parsed.record,receipt='TN-'+crypto.randomUUID().toUpperCase();
    await env.DB.prepare(`INSERT INTO student_transfer_notices(receipt,client_ref,student_name,direction,destination_school,contact_phone,contact_address) VALUES(?,?,?,?,?,?,?) ON CONFLICT(client_ref) DO NOTHING`).bind(receipt,r.client_ref,r.student_name,r.direction,r.destination_school,r.contact_phone,r.contact_address).run();
    // Receipt contains no personal data. Retrying the same form returns the original receipt and timestamp.
    const saved=await env.DB.prepare('SELECT receipt,created_at FROM student_transfer_notices WHERE client_ref=?').bind(r.client_ref).first();
    return reply(saved,201);
  }
  if(path==='/api/student-transfers/notices/summary'&&method==='GET'){
    const count=await env.DB.prepare('SELECT COUNT(*) pending FROM student_transfer_notices WHERE acknowledged_at IS NULL').first();
    return reply({pending:count.pending});
  }
  if(path==='/api/student-transfers/notices'&&method==='GET'){
    const url=new URL(request.url),offset=Math.floor(Math.max(0,Math.min(100000,Number(url.searchParams.get('offset'))||0)));
    await ensureStudentTransfers(env);
    const rows=await env.DB.prepare(`SELECT l.request_id,n.id,n.receipt,n.student_name,n.direction,n.destination_school,n.contact_phone,n.contact_address,n.created_at,n.acknowledged_at,u.full_name acknowledged_name FROM student_transfer_notices n LEFT JOIN student_transfer_notice_links l ON l.notice_id=n.id LEFT JOIN users u ON u.id=n.acknowledged_by ORDER BY (n.acknowledged_at IS NOT NULL), n.id DESC LIMIT 50 OFFSET ?`).bind(offset).all();
    const count=await env.DB.prepare('SELECT COUNT(*) total, COUNT(CASE WHEN acknowledged_at IS NULL THEN 1 END) pending FROM student_transfer_notices').first();
    return reply({notices:rows.results,total:count.total,pending:count.pending});
  }
  if(staffPath&&method==='POST'&&path.endsWith('/acknowledge')){
    const id=Number(path.split('/')[4]);
    if(!await env.DB.prepare('SELECT id FROM student_transfer_notices WHERE id=?').bind(id).first())return reply({error:'ไม่พบรายการ'},404);
    await ensureStudentTransfers(env);
    // D1 batch is atomic: acknowledgement is committed only with its request/link.
    // Stable notice client_ref + first reviewer make concurrent retries idempotent.
    await env.DB.batch([
      env.DB.prepare(`UPDATE student_transfer_notices SET acknowledged_by=?,acknowledged_at=datetime('now') WHERE id=? AND acknowledged_at IS NULL`).bind(user.id,id),
      env.DB.prepare(`INSERT INTO student_transfer_requests(client_ref,direction,student_code,student_name,grade_level,school_name,school_code,academic_year,term,move_date,reason,created_by)
        SELECT 'notice:'||n.id,n.direction,'',n.student_name,'',n.destination_school,'',
        CAST(strftime('%Y','now','+7 hours') AS INTEGER)+543-CASE WHEN CAST(strftime('%m','now','+7 hours') AS INTEGER)<5 THEN 1 ELSE 0 END,
        CASE WHEN CAST(strftime('%m','now','+7 hours') AS INTEGER)>=11 OR CAST(strftime('%m','now','+7 hours') AS INTEGER)<5 THEN 2 ELSE 1 END,
        '','',n.acknowledged_by FROM student_transfer_notices n WHERE n.id=?
        AND NOT EXISTS(SELECT 1 FROM student_transfer_notice_links l WHERE l.notice_id=n.id)
        AND NOT EXISTS(SELECT 1 FROM student_transfer_requests r WHERE r.created_by=n.acknowledged_by AND r.client_ref='notice:'||n.id)`).bind(id),
      env.DB.prepare(`INSERT OR IGNORE INTO student_transfer_notice_links(notice_id,request_id) SELECT n.id,r.id FROM student_transfer_notices n JOIN student_transfer_requests r ON r.created_by=n.acknowledged_by AND r.client_ref='notice:'||n.id WHERE n.id=?`).bind(id),
      env.DB.prepare(`INSERT INTO student_transfer_events(request_id,action,note,user_id) SELECT l.request_id,'notice_intake','สร้างคำร้องจากหลักฐานแจ้งย้าย '||n.receipt,? FROM student_transfer_notice_links l JOIN student_transfer_notices n ON n.id=l.notice_id WHERE l.notice_id=? AND NOT EXISTS(SELECT 1 FROM student_transfer_events e WHERE e.request_id=l.request_id AND e.action='notice_intake')`).bind(user.id,id),
    ]);
    const linked=await env.DB.prepare('SELECT request_id FROM student_transfer_notice_links WHERE notice_id=?').bind(id).first();
    return reply({ok:true,request_id:linked.request_id});
  }
  return reply({error:'Method not allowed'},405);
}
