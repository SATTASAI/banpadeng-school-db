import {handleSignatureRoute,signatureSql,ensureSignatures} from '../lib/signatures.js';
import {leaveSpanDays,leaveCalendar,normalizeLeaves,leaveFiscalSummary} from '../lib/leave-working-days.js';
import {getCurrentUser,jsonResponse} from '../lib/auth.js';
import {isPersonnelHead,isPersonnelMember} from '../lib/leave-permissions.js';
import {ensureLeaveData,executives,designatedDeputy,isDirector,isDeputy,validDate,calendarDays,today,leaveForm,leaveRecord} from '../lib/leave-data.js';
import {ensureLinePersonalSchema,linkedLineAccounts} from '../lib/line-personal.js';
import {ensureLineFeedSchema,DEFAULT_LEAVE_LINE_TEMPLATE,validLeaveLineTemplate} from '../lib/line-feed.js';
import {unreadNotificationsFor} from './notifications.js';
import {readLeaveAccess} from '../lib/leave-access.js';
import {leaveTypes,leaveLimits,leaveAllowance,leavePeriod,ownerClause,quotaGroupSql,quotaGroupOf,quotaCheck} from '../lib/leave-allowance.js';

const headers={'Cache-Control':'private, no-store'};
const json=(data,status=200)=>jsonResponse(data,status,headers);
const fail=(error,status=400)=>json({error},status);
const text=(value,max)=>typeof value==='string'?value.trim().slice(0,max):'';
const select=`SELECT r.*,u.full_name,ap.full_name approver_name,ack.full_name acknowledged_name,
 (SELECT personnel_id FROM personnel_accounts WHERE user_id=r.user_id LIMIT 1) applicant_personnel_id
 FROM leave_requests r JOIN users u ON u.id=r.user_id LEFT JOIN users ap ON ap.id=r.approved_by
 LEFT JOIN users ack ON ack.id=r.acknowledged_by`;
// รายการลาไม่ดึงข้อมูลภาพลายเซ็น (ใบละหลายสิบ KB) — ใช้เฉพาะตอนเปิดใบลาเดี่ยว/ส่งออกเอกสาร
const heavyColumns=new Set(['teacher_signature','deputy_signature','approver_signature','forward_token']);
const listSelectCache=new WeakMap();
async function listSelect(env){
 if(listSelectCache.has(env.DB))return listSelectCache.get(env.DB);
 const {results}=await env.DB.prepare('PRAGMA table_info(leave_requests)').all();
 const cols=results.map(c=>c.name).filter(n=>!heavyColumns.has(n)&&/^[a-z_]+$/.test(n));
 const sql=select.replace('SELECT r.*,',`SELECT ${cols.map(c=>'r.'+c).join(',')},`);listSelectCache.set(env.DB,sql);return sql;
}
const leaveInputTypes=['sick','personal','maternity','paternity','lenient','other'];
const typeLabels={sick:'ลาป่วย',personal:'ลากิจส่วนตัว',maternity:'ลาคลอดบุตร',paternity:'ลาไปช่วยเหลือภริยาที่คลอดบุตร',lenient:'ลาอนุโลม',other:'อื่น ๆ'};
// Additive subtypes retain the existing CHECK constraint shared with other systems.
const storedType=type=>['lenient','paternity'].includes(type)?'other':type;
const storedSubtype=type=>['lenient','paternity'].includes(type)?type:null;
const spanError=type=>type==='maternity'?'จำนวนวันลาคลอดต้องมากกว่า 0 ไม่เกินจำนวนวันตามปฏิทิน (นับรวมวันหยุด) และระบุได้ทีละครึ่งวัน':'จำนวนวันลาต้องมากกว่า 0 ไม่เกินจำนวนวันทำงาน (ไม่นับเสาร์ อาทิตย์ และวันหยุด) และระบุได้ทีละครึ่งวัน';
async function validLeaveDays(env,type,start,end,value){
 const maxDays=leaveSpanDays(type,start,end,await leaveCalendar(env));
 const days=Number(value??maxDays);
 return Number.isFinite(days)&&days>0&&days<=maxDays&&days*2===Math.round(days*2)?days:null;
}
// Personnel ids of active personnel-department heads (their own leave is acknowledged by superadmin).
async function personnelHeadIds(env){
 const {results}=await env.DB.prepare(`SELECT d.personnel_id pid,a.user_id FROM department_staff d JOIN personnel_records p ON p.id=d.personnel_id AND p.status='active'
  LEFT JOIN personnel_accounts a ON a.personnel_id=d.personnel_id WHERE d.department='personnel' AND d.is_head=1`).all();
 return {pids:new Set(results.map(r=>Number(r.pid))),users:new Set(results.filter(r=>r.user_id!=null).map(r=>Number(r.user_id)))};
}
async function personnelIdOf(env,userId){
 const row=await env.DB.prepare('SELECT personnel_id FROM personnel_accounts WHERE user_id=?').bind(userId).first();
 return row?.personnel_id==null?null:Number(row.personnel_id);
}
// ใบลาที่พิจารณาแล้ว (อนุญาต/ไม่อนุญาต) เก็บเป็น PDF ใน Google Drive: ใบลา > ปีงบประมาณ > ชื่อครู
// PDF สร้างในเบราว์เซอร์ (ฟอนต์ไทยชุดเดียวกับปุ่มดาวน์โหลด) แล้วส่งมาเก็บครั้งเดียวต่อใบ
const LEAVE_PDF_MAX=5*1024*1024;
const driveQuote=v=>String(v).replace(/\\/g,'\\\\').replace(/'/g,"\\'");
async function driveFolder(drive,token,parent,name){
 const q=encodeURIComponent(`'${driveQuote(parent)}' in parents and name='${driveQuote(name)}' and mimeType='application/vnd.google-apps.folder' and trashed=false`);
 const found=await drive.request(token,`/files?q=${q}&pageSize=1&fields=files(id)`).then(r=>r.json());
 if(found.files?.[0]?.id)return found.files[0].id;
 return (await drive.request(token,'/files?fields=id',{method:'POST',headers:{'Content-Type':'application/json'},
  body:JSON.stringify({name,mimeType:'application/vnd.google-apps.folder',parents:[parent]})}).then(r=>r.json())).id;
}
export function leaveFiscalYearBE(date){const y=Number(String(date).slice(0,4)),m=Number(String(date).slice(5,7));return (m>=10?y+1:y)+543;}
async function saveLeavePdf(request,env,id,drive){
 const user=await getCurrentUser(request,env);if(!user?.role)return fail('กรุณาเข้าสู่ระบบ',401);
 if(user.view_as?.read_only)return fail('โหมดดูบัญชีอื่นอ่านได้อย่างเดียว',403);
 await ensureLeaveData(env);
 const row=await env.DB.prepare(`SELECT r.id,r.user_id,r.status,r.workflow_stage,r.start_date,r.approved_by,r.drive_file_id,u.full_name
  FROM leave_requests r JOIN users u ON u.id=r.user_id WHERE r.id=?`).bind(id).first();
 if(!row)return fail('ไม่พบคำขอลา',404);
 if(!['approved','rejected'].includes(row.status))return fail('เก็บใบลาได้เมื่อพิจารณาแล้วเท่านั้น',409);
 if(row.drive_file_id)return json({ok:true,already:true});
 const people=await executives(env),person=people.find(p=>p.user_ids.includes(user.id));
 const allowed=user.role==='superadmin'||Number(row.approved_by)===Number(user.id)||await isPersonnelHead(env,user)||(!!person&&(isDirector(person)||isDeputy(person)));
 if(!allowed)return fail('ไม่มีสิทธิ์เก็บใบลานี้',403);
 if(!drive||drive.ready(env))return fail('ยังไม่ได้ตั้งค่า Google Drive',503);
 const bytes=new Uint8Array(await request.arrayBuffer());
 if(bytes.length<100||bytes.length>LEAVE_PDF_MAX||String.fromCharCode(...bytes.slice(0,5))!=='%PDF-')return fail('ไฟล์ใบลาต้องเป็น PDF ขนาดไม่เกิน 5 MB');
 const token=await drive.token(env);
 let parent=String(env.GOOGLE_DRIVE_FOLDER_ID);
 for(const name of ['ใบลา',`ปีงบประมาณ ${leaveFiscalYearBE(row.start_date)}`,String(row.full_name||'ไม่ระบุชื่อ').trim().slice(0,120)])parent=await driveFolder(drive,token,parent,name);
 const boundary=`leave_${crypto.randomUUID()}`,name=`ใบลา-${row.id}-${row.start_date}.pdf`;
 const body=new Blob([`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify({name,mimeType:'application/pdf',parents:[parent]})}\r\n`,
  `--${boundary}\r\nContent-Type: application/pdf\r\n\r\n`,bytes,`\r\n--${boundary}--`]);
 const file=await drive.request(token,'/upload/drive/v3/files?uploadType=multipart&fields=id,webViewLink',{method:'POST',headers:{'Content-Type':`multipart/related; boundary=${boundary}`},body}).then(r=>r.json());
 const saved=await env.DB.prepare("UPDATE leave_requests SET drive_file_id=?,drive_web_url=?,drive_saved_at=datetime('now') WHERE id=? AND drive_file_id IS NULL").bind(file.id,file.webViewLink||null,id).run();
 // อีกเครื่องเก็บไปก่อนแล้ว → ลบไฟล์ซ้ำทิ้ง
 if(!saved.meta.changes){await drive.request(token,`/files/${encodeURIComponent(file.id)}`,{method:'DELETE'}).catch(()=>{});return json({ok:true,already:true});}
 await env.DB.prepare("INSERT INTO audit_logs(user_id,action,resource,resource_id,details) VALUES(?,'drive_save','leave_request',?,?)").bind(user.id,id,JSON.stringify({drive_file_id:file.id})).run().catch(()=>{});
 return json({ok:true,drive_web_url:file.webViewLink||null});
}
export async function handleLeaveRoute(request,env,pathname,method,drive=null) {
 const drivePdf=pathname.match(/^\/api\/leave-requests\/(\d+)\/drive-pdf$/);
 if(drivePdf)return method==='POST'?saveLeavePdf(request,env,Number(drivePdf[1]),drive):fail('Method not allowed',405);
 const signatureResponse=await handleSignatureRoute(request,env,pathname,method);if(signatureResponse)return signatureResponse;
 if(pathname==='/api/leave-working-days'&&method==='GET'){
  const user=await getCurrentUser(request,env);if(!user?.role)return fail('กรุณาเข้าสู่ระบบ',401);
  const q=new URL(request.url).searchParams,start=q.get('start'),end=q.get('end'),type=q.get('type');
  if(!validDate(start)||!validDate(end)||end<start||calendarDays(start,end)>3660)return fail('ช่วงวันที่ลาไม่ถูกต้อง');
  return json({working_days:leaveSpanDays(type,start,end,await leaveCalendar(env)),counts_calendar_days:type==='maternity'});
 }
 if(pathname==='/api/leave-allowance'&&method==='GET'){
  const user=await getCurrentUser(request,env);if(!user?.role)return fail('กรุณาเข้าสู่ระบบ',401);
  await ensureLeaveData(env);
  const date=new URL(request.url).searchParams.get('date')||today();
  if(!validDate(date))return fail('วันที่ไม่ถูกต้อง');
  return json(await leaveAllowance(env,user.id,date));
 }
 if(pathname==='/api/leave-view'&&method==='POST'){
  const body=await request.json().catch(()=>null);
  await ensureLeaveData(env);
  const row=await readLeaveAccess(env,body?.token);
  if(!row)return fail('ลิงก์ไม่ถูกต้องหรือหมดอายุแล้ว',404);
  return json({leave:{...(await normalizeLeaves(env,[row]))[0],leave_type:row.leave_subtype||row.leave_type,leave_subtype:undefined}});
 }
 const deliveryMatch=pathname.match(/^\/api\/leave-requests\/(\d+)\/delivery$/);
 if(deliveryMatch&&method==='GET'){
  const user=await getCurrentUser(request,env);if(!user?.role)return fail('กรุณาเข้าสู่ระบบ',401);
  await ensureLeaveData(env);
  const id=Number(deliveryMatch[1]);
  const row=await env.DB.prepare('SELECT id,user_id,status,workflow_stage,deputy_personnel_id FROM leave_requests WHERE id=?').bind(id).first();
  if(!row)return fail('ไม่พบคำขอลา',404);
  const head=await isPersonnelHead(env,user),admin=user.role==='superadmin';
  const assigned=['executive','superadmin'].includes(user.role)&&await env.DB.prepare('SELECT 1 FROM leave_reviewers WHERE leave_id=? AND user_id=?').bind(id,user.id).first();
  if(row.user_id!==user.id&&!head&&!admin&&!assigned)return fail('ไม่มีสิทธิ์ดูใบลานี้',403);
  await ensureLinePersonalSchema(env);await ensureLineFeedSchema(env);
  const pendingHead=row.status==='pending'&&['submitted','acknowledged'].includes(row.workflow_stage);
  const pendingDirector=row.status==='pending'&&row.workflow_stage==='forwarded';
  const messageKey=`leave:${id}:${row.status!=='pending'?row.status:pendingDirector?'forwarded':'pending'}`;
  const {results:recipients}=await env.DB.prepare(`SELECT DISTINCT u.id user_id,u.full_name,'head' kind,u.role FROM users u
   JOIN personnel_accounts a ON a.user_id=u.id JOIN department_staff d ON d.personnel_id=a.personnel_id
   JOIN personnel_records p ON p.id=d.personnel_id WHERE d.department='personnel' AND d.is_head=1 AND p.status='active'
   AND u.status='active' AND u.deleted_at IS NULL AND ?=1
   UNION SELECT u.id,u.full_name,v.kind,u.role FROM leave_reviewers v JOIN users u ON u.id=v.user_id
   WHERE v.leave_id=? AND ?=1 AND u.role IN ('executive','superadmin') AND u.status='active' AND u.deleted_at IS NULL
   UNION SELECT u.id,u.full_name,'applicant',u.role FROM users u WHERE u.id=? AND ?=1 AND u.status='active' AND u.deleted_at IS NULL`).bind(pendingHead?1:0,id,pendingDirector?1:0,row.user_id,row.status!=='pending'?1:0).all();
  const links=await linkedLineAccounts(env);
  const {results:states}=await env.DB.prepare("SELECT user_id,status,error,updated_at FROM line_feed_sent WHERE message_key=?").bind(messageKey).all();
  const {results:preferences}=await env.DB.prepare('SELECT user_id,enabled FROM line_feed_users').all();
  const {results:blocked}=await env.DB.prepare("SELECT user_id FROM line_user_links WHERE status='blocked'").all();
  const run=await env.DB.prepare('SELECT started_at,finished_at,failures,note FROM line_feed_runs WHERE id=1').first();
  const stateById=new Map(states.map(s=>[Number(s.user_id),s])),pref=new Map(preferences.map(p=>[Number(p.user_id),Number(p.enabled)]));
  const blockedIds=new Set(blocked.map(b=>Number(b.user_id)));
  const feedChecks=await Promise.all(recipients.map(async r=>{
   try {const rows=await unreadNotificationsFor(env,{id:Number(r.user_id),role:r.role},50,{forLine:true});
    return {user_id:r.user_id,has_notice:rows.some(x=>x.message_key===messageKey),error:null};}
   catch(e){return {user_id:r.user_id,has_notice:false,error:String(e?.message||e).slice(0,300)};}
  }));
  const profileChecks=await Promise.all(recipients.map(async r=>{
   const link=links.find(l=>Number(l.user_id)===Number(r.user_id));
   if(!link||!env.LINE_CHANNEL_ACCESS_TOKEN)return {user_id:r.user_id,status:'not_checked'};
   try{
    const response=await fetch(`https://api.line.me/v2/bot/profile/${encodeURIComponent(link.line_user_id)}`,
     {headers:{Authorization:`Bearer ${env.LINE_CHANNEL_ACCESS_TOKEN}`},signal:AbortSignal.timeout(10000)});
    return {user_id:r.user_id,status:response.ok?'available':response.status===404?'unavailable':'unknown'};
   }catch{return {user_id:r.user_id,status:'unknown'};}
  }));
  return json({request_id:id,workflow_stage:row.workflow_stage,line_configured:!!env.LINE_CHANNEL_ACCESS_TOKEN,
   deputy_assigned:row.deputy_personnel_id!=null,recipients:recipients.map(r=>{
    const link=links.find(l=>Number(l.user_id)===Number(r.user_id));const state=stateById.get(Number(r.user_id));const feed=feedChecks.find(x=>Number(x.user_id)===Number(r.user_id));
    return {kind:r.kind,name:r.full_name,link_status:link?'active':blockedIds.has(Number(r.user_id))?'blocked':'not_linked',
     enabled:pref.get(Number(r.user_id))!==0&&(!link||pref.get(Number(link.link_owner_user_id))!==0),
     delivery_status:state?.status||'not_queued',error:state?.error||null,updated_at:state?.updated_at||null,
     feed_has_notice:feed?.has_notice||false,feed_error:feed?.error||null,
     oa_profile_status:profileChecks.find(x=>Number(x.user_id)===Number(r.user_id))?.status||'not_checked'};
   }),last_run:run||null});
 }
 if(pathname==='/api/leave-delegations'){
  const user=await getCurrentUser(request,env);if(!user?.role)return fail('กรุณาเข้าสู่ระบบ',401);
  await ensureLeaveData(env);
  const people=await executives(env),director=people.find(p=>isDirector(p)&&p.user_ids.includes(user.id));
  if(!director)return fail('เฉพาะผู้อำนวยการเท่านั้นที่มอบหรือถอนสิทธิ์อนุมัติการลาได้',403);
  if(method==='GET'){
   const {results:grants}=await env.DB.prepare('SELECT d.*,u.full_name granted_by_name FROM leave_approval_delegations d JOIN users u ON u.id=d.granted_by').all();
   return json({deputies:people.filter(isDeputy).map(p=>({id:p.id,full_name:p.full_name,position:p.position,
    can_approve:grants.some(g=>g.personnel_id===p.id),grant:grants.find(g=>g.personnel_id===p.id)||null}))});
  }
  if(method!=='PATCH')return fail('Method not allowed',405);
  const body=await request.json().catch(()=>null);
  if(!body||!Number.isSafeInteger(body.personnel_id)||typeof body.can_approve!=='boolean'||Object.keys(body).some(k=>!['personnel_id','can_approve'].includes(k)))return fail('ข้อมูลสิทธิ์ไม่ถูกต้อง');
  if(body.can_approve&&!people.some(p=>isDeputy(p)&&p.id===body.personnel_id))return fail('กรุณาเลือกรองผู้อำนวยการที่มีบัญชีผู้บริหารใช้งานอยู่');
  await env.DB.batch([
   body.can_approve?env.DB.prepare(`INSERT INTO leave_approval_delegations(personnel_id,granted_by) VALUES(?,?)
    ON CONFLICT(personnel_id) DO UPDATE SET granted_by=excluded.granted_by,granted_at=datetime('now')`).bind(body.personnel_id,user.id):
    env.DB.prepare('DELETE FROM leave_approval_delegations WHERE personnel_id=?').bind(body.personnel_id),
   env.DB.prepare("INSERT INTO audit_logs(user_id,action,resource,resource_id,details) VALUES(?,?,'leave_approval_delegation',?,?)")
    .bind(user.id,body.can_approve?'grant':'revoke',body.personnel_id,JSON.stringify({can_approve:body.can_approve}))
  ]);
  return json({ok:true});
 }
 if(pathname==='/api/leave-settings'){
  const user=await getCurrentUser(request,env);if(!user?.role)return fail('กรุณาเข้าสู่ระบบ',401);
  await ensureLeaveData(env);
  const head=await isPersonnelHead(env,user);
  if(!head&&user.role!=='superadmin')return fail('เฉพาะหัวหน้าฝ่ายบุคลากรหรือผู้ดูแลระบบ',403);
  const people=await executives(env);
  if(method==='GET'){
   await ensureLinePersonalSchema(env);
   const selected=await designatedDeputy(env,people);
   const saved=user.role==='superadmin'?await env.DB.prepare('SELECT line_template FROM leave_settings WHERE id=1').first():null;
   const links=await linkedLineAccounts(env);
   const {results:blocked}=await env.DB.prepare(`SELECT l.user_id,l.status FROM line_user_links l WHERE l.status='blocked'`).all();
   return json({limits:await leaveLimits(env),deputy_personnel_id:selected?.id??null,line_configured:!!env.LINE_CHANNEL_ACCESS_TOKEN,
    ...(user.role==='superadmin'?{line_template:saved?.line_template||DEFAULT_LEAVE_LINE_TEMPLATE}:{}),deputies:people.filter(isDeputy).map(p=>({
    id:p.id,full_name:p.full_name,position:p.position,
    line_status:p.user_ids.some(id=>links.some(l=>l.user_id===id))?'active':
     p.user_ids.some(id=>blocked.some(l=>l.user_id===id))?'blocked':'not_linked'
   }))});
  }
  if(method==='PATCH'){
   const body=await request.json().catch(()=>null);
   if(body&&Object.hasOwn(body,'limits')){
    if(Object.keys(body).length!==1||!Array.isArray(body.limits)||body.limits.length!==leaveTypes.length||
     new Set(body.limits.map(r=>r?.leave_type)).size!==leaveTypes.length||body.limits.some(r=>!r||!leaveTypes.includes(r.leave_type)||
     !(r.max_count===null||(Number.isSafeInteger(r.max_count)&&r.max_count>=0&&r.max_count<=10000))))return fail('ระบุจำนวนครั้งเป็นจำนวนเต็ม 0–10000 หรือเว้นว่างเพื่อไม่จำกัด ให้ครบทุกประเภท');
    await env.DB.batch(body.limits.map(r=>env.DB.prepare('INSERT INTO leave_term_limits(leave_type,max_count) VALUES(?,?) ON CONFLICT(leave_type) DO UPDATE SET max_count=excluded.max_count').bind(r.leave_type,r.max_count)));
    return json({ok:true,limits:await leaveLimits(env)});
   }
   if(body&&Object.hasOwn(body,'line_template')){
    if(user.role!=='superadmin')return fail('เฉพาะผู้ดูแลระบบเท่านั้น',403);
    if(Object.keys(body).some(k=>k!=='line_template')||!validLeaveLineTemplate(body.line_template))return fail('ข้อความต้องยาวไม่เกิน 400 ตัวอักษร ใช้ได้เฉพาะ {title} {message} {id} {link} {reason} {leave_dates} {phone}');
    const template=body.line_template.trim()||null;
    await env.DB.prepare('INSERT INTO leave_settings(id,line_template) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET line_template=excluded.line_template').bind(template).run();
    return json({ok:true,line_template:template||DEFAULT_LEAVE_LINE_TEMPLATE});
   }
   const deputy=people.find(p=>p.id===Number(body?.deputy_personnel_id)&&isDeputy(p));
   if(!deputy)return fail('กรุณาเลือกรองผู้อำนวยการที่มีบัญชีผู้บริหารใช้งานอยู่');
   await env.DB.batch([
    env.DB.prepare('INSERT INTO leave_settings(id,deputy_personnel_id) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET deputy_personnel_id=excluded.deputy_personnel_id').bind(deputy.id),
    // Assign the responsible deputy to pending drafts; notices start after acknowledgement.
    env.DB.prepare("UPDATE leave_requests SET deputy_personnel_id=? WHERE status='pending' AND workflow_stage IN ('submitted','acknowledged') AND deputy_personnel_id IS NULL").bind(deputy.id)
   ]);
   return json({ok:true,deputy_personnel_id:deputy.id});
  }
  return fail('Method not allowed',405);
 }
 const match=pathname.match(/^\/api\/leave-requests(?:\/(\d+))?$/);
 if(!match)return null;
 const user=await getCurrentUser(request,env);if(!user?.role)return fail('กรุณาเข้าสู่ระบบ',401);
 await ensureLeaveData(env);
 const head=await isPersonnelHead(env,user),admin=user.role==='superadmin',id=Number(match[1]);
 // ครูฝ่ายบุคคลเห็นคำร้องขอลาทั้งหมดเหมือนหัวหน้าฝ่าย แต่ดูได้อย่างเดียว (รับทราบ/แก้ไข/ลบยังเป็นของหัวหน้าฝ่าย)
 const hrViewer=head||await isPersonnelMember(env,user);
 // ผู้พิจารณาต้องยังเป็นบัญชีผู้บริหาร (ผู้บริหารที่ได้สิทธิ์ผู้ดูแลระบบด้วยก็ได้) — ถ้าถูกเปลี่ยนเป็นบัญชีครูจะหมดสิทธิ์ทันที
 const execAccount=['executive','superadmin'].includes(user.role);
 const people=await executives(env);
 const person=people.find(p=>p.user_ids.includes(user.id));
 const director=!!person&&isDirector(person),deputy=!!person&&isDeputy(person),management=director||deputy;
 const delegated=deputy&&!!await env.DB.prepare('SELECT 1 FROM leave_approval_delegations WHERE personnel_id=?').bind(person.id).first();
 const canDecide=director||delegated;
 const deputyChoices=people.filter(isDeputy).map(({user_ids,...p})=>p);
 const myPid=await personnelIdOf(env,user.id),heads=await personnelHeadIds(env);
 const own=r=>Number(r.user_id)===Number(user.id)||(myPid!=null&&Number(r.applicant_personnel_id)===myPid);
 const applicantIsHead=r=>heads.users.has(Number(r.user_id))||heads.pids.has(Number(r.applicant_personnel_id));
 // หัวหน้าฝ่ายบุคลากรรับทราบใบลาของตนเองไม่ได้ — ใบลาของหัวหน้าฝ่ายให้ superadmin รับทราบแทน
 const canAcknowledgeRow=r=>!own(r)&&(head||(admin&&applicantIsHead(r)));
 // แก้ไข/ลบใบลาได้ทุกสถานะ: หัวหน้าฝ่ายบุคลากรหรือ superadmin ยกเว้นใบลาของตนเอง
 const canEditRow=r=>!own(r)&&(head||admin);
 if(!id&&method==='GET') {
  const {results}=await env.DB.prepare(`${await listSelect(env)} WHERE ?=1 OR ?=1 OR ?=1 OR r.user_id=? OR
   (?=1 AND EXISTS(SELECT 1 FROM leave_reviewers v WHERE v.leave_id=r.id AND v.user_id=?)) OR
   (?=1 AND r.status='pending' AND r.workflow_stage='forwarded' AND EXISTS(
   SELECT 1 FROM personnel_accounts a JOIN personnel_records p ON p.id=a.personnel_id
   WHERE a.user_id=? AND p.id=r.deputy_personnel_id AND p.status='active' AND REPLACE(p.position,' ','') LIKE '%รองผู้อำนวยการ%'))
   ORDER BY CASE WHEN r.status='pending' THEN 0 ELSE 1 END,r.created_at DESC,r.id DESC`).bind(management?1:0,admin?1:0,hrViewer?1:0,user.id,execAccount?1:0,user.id,execAccount?1:0,user.id).all();
  const {results:assigned}=await env.DB.prepare('SELECT leave_id,kind FROM leave_reviewers WHERE user_id=?').bind(user.id).all();
  const earlyDeputy=execAccount&&results.some(r=>r.status==='pending'&&r.workflow_stage==='forwarded'&&people.some(p=>isDeputy(p)&&p.id===r.deputy_personnel_id&&p.user_ids.includes(user.id)));
  const profile=await env.DB.prepare(`SELECT p.position,p.phone FROM personnel_records p JOIN personnel_accounts a ON a.personnel_id=p.id WHERE a.user_id=? AND p.status='active'`).bind(user.id).first();
  const setting=await designatedDeputy(env,people);
  return json({fiscal_statistics:await leaveFiscalSummary(env,results.filter(own)),leave_requests:(await normalizeLeaves(env,results)).map(({teacher_signature,deputy_signature,approver_signature,...r})=>leaveRecord(r)).map(r=>({...r,can_acknowledge:canAcknowledgeRow(r)&&r.status==='pending'&&['submitted','acknowledged'].includes(r.workflow_stage),can_edit:canEditRow(r),
   drive_saved:!!r.drive_file_id,can_store_drive:['approved','rejected'].includes(r.status)&&!r.drive_file_id&&(admin||head||management||Number(r.approved_by)===Number(user.id)),
   can_record:false,can_forward:false,
   can_review:false,
   // ต้องผ่านการรับทราบของหัวหน้าฝ่ายบุคลากรก่อนเสมอ
   can_acknowledge_approve:false,
   can_decide:canDecide&&r.user_id!==user.id&&Number(r.applicant_personnel_id)!==Number(person.id)&&r.status==='pending'&&r.workflow_stage==='forwarded',
   can_cancel:r.status==='pending'&&r.workflow_stage==='submitted'&&r.user_id===user.id})),
   is_personnel_head:head,is_personnel_viewer:hrViewer,can_manage_delegations:director,is_leave_management:management,can_view_all_leave:admin||management,can_approve_leave:canDecide,
   can_view_pending:management||hrViewer||admin||assigned.length>0||earlyDeputy,deputy_choices:head?deputyChoices:[],
   default_deputy_id:setting?.id||null,profile:profile||{}});
 }
 if(id&&method==='GET') {
  const row=await env.DB.prepare(`${select} WHERE r.id=?`).bind(id).first();if(!row)return fail('ไม่พบคำขอลา',404);
  const assigned=execAccount&&await env.DB.prepare('SELECT 1 FROM leave_reviewers WHERE leave_id=? AND user_id=?').bind(id,user.id).first();
  const earlyDeputy=execAccount&&row.status==='pending'&&row.workflow_stage==='forwarded'&&people.some(p=>isDeputy(p)&&p.id===row.deputy_personnel_id&&p.user_ids.includes(user.id));
  if(row.user_id!==user.id&&!hrViewer&&!admin&&!assigned&&!earlyDeputy&&!management)return fail('ไม่มีสิทธิ์ดูใบลานี้',403);
  const {results:events}=await env.DB.prepare(`SELECT e.action,e.note,e.created_at,u.full_name FROM leave_events e JOIN users u ON u.id=e.actor_id WHERE e.leave_id=? ORDER BY e.id`).bind(id).all();
  return json({leave_request:{...(await leaveForm(env,row)),can_edit:canEditRow(row)},events});
 }
 if(!id&&method==='POST') {
  const body=await request.json().catch(()=>null);if(!body||typeof body!=='object')return fail('รูปแบบข้อมูลไม่ถูกต้อง');
  for(const [field,max] of [['reason',2000],['position',200],['contact_address',1000],['contact_phone',100],['applicant_note',2000],['substitute_teacher',500]])if(typeof body[field]==='string'&&body[field].length>max)return fail('ข้อมูลยาวเกินกำหนด');
  if(!leaveInputTypes.includes(body.leave_type))return fail('กรุณาเลือกประเภทการลา');
  const reason=text(body.reason,2000);if(!reason)return fail('กรุณาระบุเหตุผลการลา');
  if(!validDate(body.start_date)||!validDate(body.end_date)||body.end_date<body.start_date)return fail('วันที่เริ่มและสิ้นสุดการลาไม่ถูกต้อง');
  if(calendarDays(body.start_date,body.end_date)>3660)return fail('ช่วงวันที่ลายาวเกินกำหนด');
  const days=await validLeaveDays(env,body.leave_type,body.start_date,body.end_date,body.leave_days);
  if(days===null)return fail(spanError(body.leave_type));
  const position=text(body.position,200),address=text(body.contact_address,1000),phone=text(body.contact_phone,100);
  if(!position||!address||!phone)return fail('กรุณาระบุตำแหน่ง ที่อยู่ระหว่างลา และเบอร์ติดต่อ');
  const date=body.request_date||today();if(!validDate(date))return fail('วันที่เขียนใบลาไม่ถูกต้อง');
  // Remember the responsible deputy; notifications to executives start after acknowledgement.
  const deputyForNotice=await designatedDeputy(env,people);
  const period=await leavePeriod(env,body.start_date);
  if(!period)return fail('ไม่พบภาคเรียนที่ตรงกับวันเริ่มลา หรือช่วงภาคเรียนซ้อนกัน กรุณาให้ผู้รับผิดชอบตรวจปฏิทินปีการศึกษา');
  const applicantNote=text(body.applicant_note,2000),substituteTeacher=body.leave_type==='lenient'?text(body.substitute_teacher,500):'';
  if(body.leave_type==='lenient'&&!substituteTeacher)return fail('กรุณาระบุผู้ที่ได้รับมอบหมายคาบสอนแทน');
  await ensureSignatures(env);
  const quotaGroup=quotaGroupOf(body.leave_type);
  const results=await env.DB.batch([
   env.DB.prepare(`INSERT INTO leave_requests(user_id,leave_type,reason,start_date,end_date,position,request_date,leave_days,contact_address,contact_phone,leave_subtype,deputy_personnel_id,applicant_note,substitute_teacher,teacher_signature)
    SELECT ?,?,?,?,?,?,?,?,?,?,?,?,?,?,${signatureSql} WHERE
    (SELECT max_count FROM leave_term_limits WHERE leave_type=?) IS NULL OR
    (SELECT COUNT(*) FROM leave_requests WHERE ${ownerClause} AND ${quotaGroupSql}=? AND start_date BETWEEN ? AND ? AND status='approved')
    < (SELECT max_count FROM leave_term_limits WHERE leave_type=?)`).bind(user.id,storedType(body.leave_type),reason,body.start_date,body.end_date,position,date,days,address,phone,storedSubtype(body.leave_type),deputyForNotice?.id??null,applicantNote,substituteTeacher,user.id,user.id,user.id,quotaGroup,user.id,user.id,quotaGroup,period.from,period.to,quotaGroup),
   env.DB.prepare("INSERT INTO leave_events(leave_id,actor_id,action) SELECT last_insert_rowid(),?,'submitted' WHERE changes()>0").bind(user.id),
   env.DB.prepare("INSERT INTO audit_logs(user_id,action,resource,resource_id,details) SELECT ?,'create','leave_request',leave_id,? FROM leave_events WHERE id=last_insert_rowid() AND changes()>0").bind(user.id,JSON.stringify({leave_type:body.leave_type,start_date:body.start_date,end_date:body.end_date}))
  ]);
  if(!results[0].meta.changes)return fail('จำนวนครั้งการลากลุ่มนี้ที่อนุมัติแล้วครบตามเงื่อนไขภาคเรียนแล้ว',409);
  const newId=results[0].meta.last_row_id;
  return json({id:newId},201);
 }
 if(id&&method==='PATCH') {
  const body=await request.json().catch(()=>null);if(!body)return fail('รูปแบบข้อมูลไม่ถูกต้อง');
  if(body.note!==undefined&&(typeof body.note!=='string'||body.note.length>2000))return fail('บันทึกต้องเป็นข้อความไม่เกิน 2,000 ตัวอักษร');
  const row=await env.DB.prepare('SELECT r.*,(SELECT personnel_id FROM personnel_accounts WHERE user_id=r.user_id LIMIT 1) applicant_personnel_id FROM leave_requests r WHERE r.id=?').bind(id).first();if(!row)return fail('ไม่พบคำขอลา',404);
  const action=body.action||(body.status==='approved'||body.status==='rejected'?'decide':'');
  if(['acknowledge','record','forward'].includes(action)&&!canAcknowledgeRow(row))return fail(own(row)&&head?'ไม่สามารถรับทราบใบลาของตนเองได้ ใบลาของหัวหน้าฝ่ายบุคลากรให้ผู้ดูแลระบบรับทราบแทน':'เฉพาะหัวหน้าฝ่ายบุคลากรเท่านั้น',403);
  const now=new Date().toISOString(),note=text(body.note,2000);
  const change=async(sql,values,event,eventNote=note)=>{
   const statements=[env.DB.prepare(sql).bind(...values),env.DB.prepare(`INSERT INTO leave_events(leave_id,actor_id,action,note)
    SELECT ?,?,?,? WHERE changes()>0`).bind(id,user.id,event,eventNote),
    env.DB.prepare("INSERT INTO audit_logs(user_id,action,resource,resource_id,details) SELECT ?,?,'leave_request',?,? WHERE changes()>0").bind(user.id,event,id,JSON.stringify({action:event}))];
   const results=await env.DB.batch(statements);
   return results[0].meta.changes?json({ok:true}):fail('สถานะคำขอเปลี่ยนแล้ว กรุณาโหลดข้อมูลใหม่',409);
  };
  if(action==='acknowledge'||action==='forward') {
   if(row.status!=='pending'||!['submitted','acknowledged'].includes(row.workflow_stage))return fail('คำขอนี้รับทราบและส่งต่อแล้ว หรือดำเนินการเสร็จแล้ว',409);
   // Keep the old forward endpoint only for requests already acknowledged before this workflow change.
   if(action==='forward'&&row.workflow_stage!=='acknowledged')return fail('กรุณากดรับทราบเพื่อส่งต่ออัตโนมัติ',409);
   const directors=people.filter(isDirector);
   if(directors.length!==1)return fail('ต้องมีผู้อำนวยการหนึ่งท่านที่มีบัญชีผู้บริหารใช้งานอยู่ กรุณาตรวจทะเบียนบุคลากร',409);
   const director=directors[0],token=crypto.randomUUID();
   const applicantIsDirector=director.user_ids.map(Number).includes(Number(row.user_id))||Number(row.applicant_personnel_id)===Number(director.id);
   let deputy,reviewers,approverName,approverPosition;
   if(applicantIsDirector){
    // ใบลาของ ผอ. ส่งให้รอง ผอ. ที่ ผอ. มอบสิทธิ์อนุมัติการลาเป็นผู้อนุมัติ
    const {results:grants}=await env.DB.prepare('SELECT personnel_id FROM leave_approval_delegations').all();
    const approvers=people.filter(p=>isDeputy(p)&&grants.some(g=>Number(g.personnel_id)===p.id));
    if(!approvers.length)return fail('ใบลาของผู้อำนวยการต้องให้รองผู้อำนวยการที่ได้รับมอบสิทธิ์อนุมัติการลาเป็นผู้อนุมัติ กรุณาให้ ผอ. มอบสิทธิ์ก่อน',409);
    const preferred=await designatedDeputy(env,people);
    deputy=approvers.find(p=>p.id===preferred?.id)||approvers[0];
    reviewers=approvers.flatMap(p=>p.user_ids.map(user_id=>({user_id,kind:'deputy'})));
    approverName=deputy.full_name;approverPosition=deputy.position;
   }else{
    deputy=await designatedDeputy(env,people)||people.find(p=>p.id===row.deputy_personnel_id&&isDeputy(p));
    if(!deputy)return fail('กรุณาตั้งค่ารองผู้อำนวยการที่รับผิดชอบฝ่ายบุคลากรก่อนรับทราบ',409);
    reviewers=[...director.user_ids.map(user_id=>({user_id,kind:'director'})),...deputy.user_ids.map(user_id=>({user_id,kind:'deputy'}))];
    approverName=director.full_name;approverPosition=director.position;
   }
   const results=await env.DB.batch([
    env.DB.prepare(`UPDATE leave_requests SET workflow_stage='forwarded',forwarded_by=?,forwarded_at=?,forward_token=?,personnel_note=?,
     deputy_personnel_id=?,deputy_name=?,deputy_position=?,director_name=?,director_position=?,
     acknowledged_by=COALESCE(acknowledged_by,?),acknowledged_at=COALESCE(acknowledged_at,?)
     WHERE id=? AND status='pending' AND workflow_stage IN ('submitted','acknowledged')`).bind(user.id,now,token,body.note===undefined?row.personnel_note:note,deputy.id,deputy.full_name,deputy.position,approverName,approverPosition,user.id,now,id),
    ...reviewers.map(r=>env.DB.prepare(`INSERT OR IGNORE INTO leave_reviewers(leave_id,user_id,kind)
     SELECT ?,?,? WHERE EXISTS(SELECT 1 FROM leave_requests WHERE id=? AND forward_token=?)`).bind(id,r.user_id,r.kind,id,token)),
    ...(row.workflow_stage==='submitted'?[env.DB.prepare("INSERT INTO leave_events(leave_id,actor_id,action,note) SELECT ?,?,'acknowledged',? WHERE EXISTS(SELECT 1 FROM leave_requests WHERE id=? AND forward_token=?)").bind(id,user.id,note,id,token)]:[]),
    env.DB.prepare(`INSERT INTO leave_events(leave_id,actor_id,action,note) SELECT ?,?,'forwarded',? WHERE EXISTS(SELECT 1 FROM leave_requests WHERE id=? AND forward_token=?)`).bind(id,user.id,applicantIsDirector?`ใบลาของผู้อำนวยการ ส่งถึงรองผู้อำนวยการที่ได้รับมอบสิทธิ์ (${deputy.full_name})`:`ส่งถึง ${director.full_name} และ ${deputy.full_name}`,id,token),
    ...(applicantIsDirector?[]:[env.DB.prepare('INSERT INTO leave_settings(id,deputy_personnel_id) SELECT 1,? WHERE EXISTS(SELECT 1 FROM leave_requests WHERE id=? AND forward_token=?) ON CONFLICT(id) DO UPDATE SET deputy_personnel_id=excluded.deputy_personnel_id').bind(deputy.id,id,token)]),
    env.DB.prepare("INSERT INTO audit_logs(user_id,action,resource,resource_id,details) SELECT ?,'forward','leave_request',?,? WHERE EXISTS(SELECT 1 FROM leave_requests WHERE id=? AND forward_token=?)").bind(user.id,id,JSON.stringify({director_personnel_id:director.id,deputy_personnel_id:deputy.id}),id,token)
   ]);
   return results[0].meta.changes?json({ok:true}):fail('สถานะคำขอเปลี่ยนแล้ว กรุณาโหลดข้อมูลใหม่',409);
  }
  if(action==='review')return fail('รองผู้อำนวยการรับข้อมูลเพื่อทราบ ผู้อำนวยการเป็นผู้อนุมัติ',403);
  if(action==='acknowledge_approve')return fail('ต้องให้หัวหน้าฝ่ายบุคลากรรับทราบและส่งต่อก่อน จึงอนุญาตได้',409);
  if(action==='decide') {
   if(!canDecide)return fail('เฉพาะผู้อำนวยการหรือรองผู้อำนวยการที่ได้รับมอบสิทธิ์จาก ผอ.',403);
   if(row.status!=='pending'||row.workflow_stage!=='forwarded')return fail('คำขอยังไม่พร้อมพิจารณา หรือมีผลพิจารณาแล้ว',409);
   if(!['approved','rejected'].includes(body.status))return fail('กรุณาเลือกอนุญาตหรือไม่อนุญาต');
   if(Number(row.user_id)===Number(user.id)||Number(row.applicant_personnel_id)===Number(person.id))return fail('ไม่สามารถอนุมัติการลาของตนเองได้',403);
   const approving=body.status==='approved';
   // ตรวจจำนวนครั้งอีกครั้งตอนอนุมัติ (นับเฉพาะใบที่อนุมัติแล้ว)
   const quota=approving?await quotaCheck(env,row,id):{ok:true};
   if(!quota.ok)return fail(`อนุมัติไม่ได้: จำนวนครั้งการลากลุ่มนี้ที่อนุมัติแล้วครบ ${quota.max} ครั้งใน${quota.period.name||'ภาคเรียนนี้'}แล้ว`,409);
   const enforce=approving&&quota.max!=null;
   const applicantIsDirector=people.some(p=>isDirector(p)&&(p.user_ids.map(Number).includes(Number(row.user_id))||p.id===Number(row.applicant_personnel_id)));
   const signingDeputy=applicantIsDirector?null:people.find(p=>isDeputy(p)&&p.id===row.deputy_personnel_id)||await designatedDeputy(env,people);
   // ลายเซ็นคัดลอกในฐานข้อมูลด้วยซับคิวรี — ไม่ส่งข้อมูลภาพไปในคำสั่ง (เดิมลายเซ็น ผอ.+รอง ผอ. ทำให้คำสั่งเกินเพดาน D1 100 KB จนอนุมัติไม่ได้)
   await ensureSignatures(env);
   const deputySigner=approving&&signingDeputy?Number(signingDeputy.user_ids[0]):null;
   const approverSql=approving?signatureSql:'NULL',deputySql=deputySigner?signatureSql:'NULL';
   const signatureBinds=[...(approving?[user.id,user.id,user.id]:[]),...(deputySigner?[deputySigner,deputySigner,deputySigner]:[])];
   try{
   return await change(`UPDATE leave_requests SET status=?,workflow_stage='completed',approved_by=?,approved_at=?,decision_note=?,decision_name=?,decision_position=?,approver_signature=${approverSql},deputy_signature=${deputySql},deputy_name=COALESCE(deputy_name,?),deputy_position=COALESCE(deputy_position,?)
    WHERE id=? AND status='pending' AND workflow_stage='forwarded'
    AND (?=1 OR EXISTS(SELECT 1 FROM leave_approval_delegations WHERE personnel_id=?))
    AND (?=0 OR (SELECT COUNT(*) FROM leave_requests q WHERE ${ownerClause} AND ${quotaGroupSql}=? AND start_date BETWEEN ? AND ? AND status='approved' AND id<>?)<?)`,
    [body.status,user.id,now,note,person.full_name,person.position,...signatureBinds,signingDeputy?.full_name??null,signingDeputy?.position??null,id,director?1:0,person.id,
     enforce?1:0,row.user_id,row.user_id,quota.group??'',quota.period?.from??'',quota.period?.to??'',id,quota.max??0],body.status);
   }catch(e){
    // บันทึกความล้มเหลวไว้ตรวจย้อนหลัง (เดิมล้มแบบเงียบ ไม่มีร่องรอยว่าเคยกด)
    await env.DB.prepare("INSERT INTO audit_logs(user_id,action,resource,resource_id,details) VALUES(?,'decide_failed','leave_request',?,?)")
     .bind(user.id,id,JSON.stringify({status:body.status,error:String(e?.message||e).slice(0,300)})).run().catch(()=>{});
    return fail('บันทึกผลพิจารณาไม่สำเร็จ ระบบบันทึกข้อผิดพลาดไว้แล้ว กรุณาลองใหม่หรือแจ้งผู้ดูแลระบบ',500);
   }
  }
  if(action==='edit') {
   if(!canEditRow(row))return fail(own(row)?'ไม่สามารถแก้ไขใบลาของตนเองได้':'เฉพาะหัวหน้าฝ่ายบุคลากรหรือผู้ดูแลระบบ',403);
   if(!note)return fail('กรุณาระบุเหตุผลการแก้ไข');
   if(!leaveInputTypes.includes(body.leave_type))return fail('กรุณาเลือกประเภทการลา');
   if(!validDate(body.start_date)||!validDate(body.end_date)||body.end_date<body.start_date||calendarDays(body.start_date,body.end_date)>3660)return fail('วันที่เริ่มและสิ้นสุดการลาไม่ถูกต้อง');
   const days=await validLeaveDays(env,body.leave_type,body.start_date,body.end_date,body.leave_days);
   if(days===null)return fail(spanError(body.leave_type));
   const before=`${typeLabels[row.leave_subtype||row.leave_type]||row.leave_type} ${row.start_date} ถึง ${row.end_date} ${Number(row.leave_days)} วัน`;
   const after=`${typeLabels[body.leave_type]} ${body.start_date} ถึง ${body.end_date} ${days} วัน`;
   const statements=[env.DB.prepare(`UPDATE leave_requests SET leave_type=?,leave_subtype=?,start_date=?,end_date=?,leave_days=? WHERE id=? AND status=? AND start_date=? AND end_date=?`)
     .bind(storedType(body.leave_type),storedSubtype(body.leave_type),body.start_date,body.end_date,days,id,row.status,row.start_date,row.end_date),
    env.DB.prepare(`INSERT INTO leave_events(leave_id,actor_id,action,note) SELECT ?,?,'edited',? WHERE changes()>0`).bind(id,user.id,`${note} (เดิม: ${before} → ใหม่: ${after})`),
    env.DB.prepare("INSERT INTO audit_logs(user_id,action,resource,resource_id,details) SELECT ?,'edit','leave_request',?,? WHERE changes()>0")
     .bind(user.id,id,JSON.stringify({before:{leave_type:row.leave_subtype||row.leave_type,start_date:row.start_date,end_date:row.end_date,leave_days:row.leave_days},after:{leave_type:body.leave_type,start_date:body.start_date,end_date:body.end_date,leave_days:days},note}))];
   const results=await env.DB.batch(statements);
   return results[0].meta.changes?json({ok:true}):fail('ข้อมูลใบลาเปลี่ยนแล้ว กรุณาโหลดข้อมูลใหม่',409);
  }
  return fail('การดำเนินการไม่ถูกต้อง');
 }
 if(id&&method==='DELETE') {
  const row=await env.DB.prepare(`SELECT r.*,(SELECT personnel_id FROM personnel_accounts WHERE user_id=r.user_id LIMIT 1) applicant_personnel_id FROM leave_requests r WHERE r.id=?`).bind(id).first();if(!row)return fail('ไม่พบคำขอลา',404);
  if(canEditRow(row)){
   // หัวหน้าฝ่ายบุคลากร/superadmin ลบได้ทุกสถานะ เก็บสำเนาใบลาไว้ใน audit log
   const body=await request.json().catch(()=>null),reason=text(body?.note,2000);
   if(!reason)return fail('กรุณาระบุเหตุผลการลบใบลา');
   const {teacher_signature,deputy_signature,approver_signature,forward_token,...snapshot}=row;
   const results=await env.DB.batch([
    env.DB.prepare('DELETE FROM leave_requests WHERE id=? AND status=?').bind(id,row.status),
    env.DB.prepare("INSERT INTO audit_logs(user_id,action,resource,resource_id,details) SELECT ?,'delete','leave_request',?,? WHERE changes()>0").bind(user.id,id,JSON.stringify({reason,snapshot}))
   ]);
   return results[0].meta.changes?json({ok:true}):fail('สถานะคำขอเปลี่ยนแล้ว',409);
  }
  if(row.user_id!==user.id)return fail('เฉพาะผู้ยื่นคำขอ หัวหน้าฝ่ายบุคลากร หรือผู้ดูแลระบบ',403);
  if(row.status!=='pending'||row.workflow_stage!=='submitted')return fail('ยกเลิกได้ก่อนหัวหน้าฝ่ายรับทราบเท่านั้น หากต้องการแก้ไขหรือยกเลิกหลังจากนั้น กรุณาแจ้งหัวหน้าฝ่ายบุคลากร',409);
  const results=await env.DB.batch([
   env.DB.prepare("DELETE FROM leave_requests WHERE id=? AND user_id=? AND status='pending' AND workflow_stage='submitted'").bind(id,user.id),
   env.DB.prepare("INSERT INTO audit_logs(user_id,action,resource,resource_id,details) SELECT ?,'delete','leave_request',?,? WHERE changes()>0").bind(user.id,id,JSON.stringify({previous_status:row.status}))
  ]);
  return results[0].meta.changes?json({ok:true}):fail('สถานะคำขอเปลี่ยนแล้ว',409);
 }
 return fail('Method not allowed',405);
}
