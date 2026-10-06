import {getCurrentUser,jsonResponse} from '../lib/auth.js';
import {isPersonnelHead} from '../lib/leave-permissions.js';
import {ensureLeaveData,executives,isDirector,isDeputy,validDate,calendarDays,today,leaveForm} from '../lib/leave-data.js';

const headers={'Cache-Control':'private, no-store'};
const json=(data,status=200)=>jsonResponse(data,status,headers);
const fail=(error,status=400)=>json({error},status);
const text=(value,max)=>typeof value==='string'?value.trim().slice(0,max):'';
const select=`SELECT r.*,u.full_name,ap.full_name approver_name,ack.full_name acknowledged_name
 FROM leave_requests r JOIN users u ON u.id=r.user_id LEFT JOIN users ap ON ap.id=r.approved_by
 LEFT JOIN users ack ON ack.id=r.acknowledged_by`;
export async function handleLeaveRoute(request,env,pathname,method) {
 const match=pathname.match(/^\/api\/leave-requests(?:\/(\d+))?$/);
 if(!match)return null;
 const user=await getCurrentUser(request,env);if(!user?.role)return fail('กรุณาเข้าสู่ระบบ',401);
 await ensureLeaveData(env);
 const head=await isPersonnelHead(env,user),admin=user.role==='superadmin',id=Number(match[1]);
 const people=await executives(env);
 const deputyChoices=people.filter(isDeputy).map(({user_ids,...p})=>p);
 if(!id&&method==='GET') {
  const {results}=await env.DB.prepare(`${select} WHERE ?=1 OR ?=1 OR r.user_id=? OR
   (?='executive' AND EXISTS(SELECT 1 FROM leave_reviewers v WHERE v.leave_id=r.id AND v.user_id=?))
   ORDER BY CASE WHEN r.status='pending' THEN 0 ELSE 1 END,r.created_at DESC,r.id DESC`).bind(admin?1:0,head?1:0,user.id,user.role,user.id).all();
  const {results:assigned}=await env.DB.prepare('SELECT leave_id,kind FROM leave_reviewers WHERE user_id=?').bind(user.id).all();
  const assignments=new Map(assigned.map(r=>[r.leave_id,r.kind]));
  const profile=await env.DB.prepare(`SELECT p.position,p.phone FROM personnel_records p JOIN personnel_accounts a ON a.personnel_id=p.id WHERE a.user_id=? AND p.status='active'`).bind(user.id).first();
  const setting=await env.DB.prepare('SELECT deputy_personnel_id FROM leave_settings WHERE id=1').first();
  return json({leave_requests:results.map(r=>({...r,can_acknowledge:head&&r.status==='pending'&&r.workflow_stage==='submitted',
   can_record:head&&r.status==='pending'&&r.workflow_stage==='acknowledged',can_forward:head&&r.status==='pending'&&r.workflow_stage==='acknowledged',
   can_review:user.role==='executive'&&assignments.get(r.id)==='deputy'&&r.status==='pending'&&r.workflow_stage==='forwarded',
   can_decide:user.role==='executive'&&assignments.get(r.id)==='director'&&r.status==='pending'&&r.workflow_stage==='forwarded',
   can_cancel:r.status==='pending'&&r.workflow_stage==='submitted'&&r.user_id===user.id})),
   is_personnel_head:head,can_view_pending:head||admin||assigned.length>0,deputy_choices:head?deputyChoices:[],
   default_deputy_id:setting?.deputy_personnel_id||null,profile:profile||{}});
 }
 if(id&&method==='GET') {
  const row=await env.DB.prepare(`${select} WHERE r.id=?`).bind(id).first();if(!row)return fail('ไม่พบคำขอลา',404);
  const assigned=user.role==='executive'&&await env.DB.prepare('SELECT 1 FROM leave_reviewers WHERE leave_id=? AND user_id=?').bind(id,user.id).first();
  if(row.user_id!==user.id&&!head&&!admin&&!assigned)return fail('ไม่มีสิทธิ์ดูใบลานี้',403);
  const {results:events}=await env.DB.prepare(`SELECT e.action,e.note,e.created_at,u.full_name FROM leave_events e JOIN users u ON u.id=e.actor_id WHERE e.leave_id=? ORDER BY e.id`).bind(id).all();
  return json({leave_request:await leaveForm(env,row),events});
 }
 if(!id&&method==='POST') {
  const body=await request.json().catch(()=>null);if(!body||typeof body!=='object')return fail('รูปแบบข้อมูลไม่ถูกต้อง');
  for(const [field,max] of [['reason',2000],['position',200],['contact_address',1000],['contact_phone',100]])if(typeof body[field]==='string'&&body[field].length>max)return fail('ข้อมูลยาวเกินกำหนด');
  if(!['sick','personal','maternity','other'].includes(body.leave_type))return fail('กรุณาเลือกประเภทการลา');
  const reason=text(body.reason,2000);if(!reason)return fail('กรุณาระบุเหตุผลการลา');
  if(!validDate(body.start_date)||!validDate(body.end_date)||body.end_date<body.start_date)return fail('วันที่เริ่มและสิ้นสุดการลาไม่ถูกต้อง');
  const days=Number(body.leave_days??calendarDays(body.start_date,body.end_date));
  if(!Number.isFinite(days)||days<=0||days>calendarDays(body.start_date,body.end_date)||days*2!==Math.round(days*2))return fail('จำนวนวันลาต้องมากกว่า 0 ไม่เกินช่วงวันที่ลา และระบุได้ทีละครึ่งวัน');
  const position=text(body.position,200),address=text(body.contact_address,1000),phone=text(body.contact_phone,100);
  if(!position||!address||!phone)return fail('กรุณาระบุตำแหน่ง ที่อยู่ระหว่างลา และเบอร์ติดต่อ');
  const date=body.request_date||today();if(!validDate(date))return fail('วันที่เขียนใบลาไม่ถูกต้อง');
  const results=await env.DB.batch([
   env.DB.prepare(`INSERT INTO leave_requests(user_id,leave_type,reason,start_date,end_date,position,request_date,leave_days,contact_address,contact_phone)
    VALUES(?,?,?,?,?,?,?,?,?,?)`).bind(user.id,body.leave_type,reason,body.start_date,body.end_date,position,date,days,address,phone),
   env.DB.prepare("INSERT INTO leave_events(leave_id,actor_id,action) VALUES(last_insert_rowid(),?,'submitted')").bind(user.id),
   env.DB.prepare("INSERT INTO audit_logs(user_id,action,resource,resource_id,details) SELECT ?,'create','leave_request',leave_id,? FROM leave_events WHERE id=last_insert_rowid()").bind(user.id,JSON.stringify({leave_type:body.leave_type,start_date:body.start_date,end_date:body.end_date}))
  ]);
  const newId=results[0].meta.last_row_id;
  return json({id:newId},201);
 }
 if(id&&method==='PATCH') {
  const body=await request.json().catch(()=>null);if(!body)return fail('รูปแบบข้อมูลไม่ถูกต้อง');
  if(body.note!==undefined&&(typeof body.note!=='string'||body.note.length>2000))return fail('บันทึกต้องเป็นข้อความไม่เกิน 2,000 ตัวอักษร');
  const row=await env.DB.prepare('SELECT * FROM leave_requests WHERE id=?').bind(id).first();if(!row)return fail('ไม่พบคำขอลา',404);
  const action=body.action||(body.status==='approved'||body.status==='rejected'?'decide':'');
  if(['acknowledge','record','forward'].includes(action)&&!head)return fail('เฉพาะหัวหน้าฝ่ายบุคลากรเท่านั้น',403);
  const now=new Date().toISOString(),note=text(body.note,2000);
  const change=async(sql,values,event,eventNote=note)=>{
   const statements=[env.DB.prepare(sql).bind(...values),env.DB.prepare(`INSERT INTO leave_events(leave_id,actor_id,action,note)
    SELECT ?,?,?,? WHERE changes()>0`).bind(id,user.id,event,eventNote),
    env.DB.prepare("INSERT INTO audit_logs(user_id,action,resource,resource_id,details) SELECT ?,?,'leave_request',?,? WHERE changes()>0").bind(user.id,event,id,JSON.stringify({action:event}))];
   const results=await env.DB.batch(statements);
   return results[0].meta.changes?json({ok:true}):fail('สถานะคำขอเปลี่ยนแล้ว กรุณาโหลดข้อมูลใหม่',409);
  };
  if(action==='acknowledge') {
   if(row.status!=='pending'||row.workflow_stage!=='submitted')return fail('คำขอนี้รับทราบแล้วหรือดำเนินการเสร็จแล้ว',409);
   return change(`UPDATE leave_requests SET workflow_stage='acknowledged',acknowledged_by=?,acknowledged_at=?,personnel_note=?
    WHERE id=? AND status='pending' AND workflow_stage='submitted'`,[user.id,now,note,id],'acknowledged');
  }
  if(action==='record') {
   if(row.status!=='pending'||row.workflow_stage!=='acknowledged')return fail('ต้องรับทราบก่อนบันทึก และยังไม่ส่งต่อ',409);
   return change(`UPDATE leave_requests SET personnel_note=? WHERE id=? AND status='pending' AND workflow_stage='acknowledged'`,[note,id],'recorded');
  }
  if(action==='forward') {
   if(row.status!=='pending'||row.workflow_stage!=='acknowledged')return fail('กรุณารับทราบและบันทึกก่อนส่งต่อ',409);
   const directors=people.filter(isDirector),deputy=people.find(p=>p.id===Number(body.deputy_personnel_id)&&isDeputy(p));
   if(directors.length!==1)return fail('ต้องมีผู้อำนวยการหนึ่งท่านที่มีบัญชีผู้บริหารใช้งานอยู่ กรุณาตรวจทะเบียนบุคลากร',409);
   if(!deputy)return fail('กรุณาเลือกรองผู้บริหารที่รับผิดชอบฝ่ายบุคลากรและมีบัญชีผู้บริหารใช้งานอยู่');
   const director=directors[0],token=crypto.randomUUID();
   const results=await env.DB.batch([
    env.DB.prepare(`UPDATE leave_requests SET workflow_stage='forwarded',forwarded_by=?,forwarded_at=?,forward_token=?,personnel_note=?,
     deputy_personnel_id=?,deputy_name=?,deputy_position=?,director_name=?,director_position=?
     WHERE id=? AND status='pending' AND workflow_stage='acknowledged'`).bind(user.id,now,token,body.note===undefined?row.personnel_note:note,deputy.id,deputy.full_name,deputy.position,director.full_name,director.position,id),
    ...[...director.user_ids.map(user_id=>({user_id,kind:'director'})),...deputy.user_ids.map(user_id=>({user_id,kind:'deputy'}))].map(r=>env.DB.prepare(`INSERT OR IGNORE INTO leave_reviewers(leave_id,user_id,kind)
     SELECT ?,?,? WHERE EXISTS(SELECT 1 FROM leave_requests WHERE id=? AND forward_token=?)`).bind(id,r.user_id,r.kind,id,token)),
    env.DB.prepare(`INSERT INTO leave_events(leave_id,actor_id,action,note) SELECT ?,?,'forwarded',? WHERE EXISTS(SELECT 1 FROM leave_requests WHERE id=? AND forward_token=?)`).bind(id,user.id,`ส่งถึง ${director.full_name} และ ${deputy.full_name}`,id,token),
    env.DB.prepare('INSERT INTO leave_settings(id,deputy_personnel_id) SELECT 1,? WHERE EXISTS(SELECT 1 FROM leave_requests WHERE id=? AND forward_token=?) ON CONFLICT(id) DO UPDATE SET deputy_personnel_id=excluded.deputy_personnel_id').bind(deputy.id,id,token),
    env.DB.prepare("INSERT INTO audit_logs(user_id,action,resource,resource_id,details) SELECT ?,'forward','leave_request',?,? WHERE EXISTS(SELECT 1 FROM leave_requests WHERE id=? AND forward_token=?)").bind(user.id,id,JSON.stringify({director_personnel_id:director.id,deputy_personnel_id:deputy.id}),id,token)
   ]);
   return results[0].meta.changes?json({ok:true}):fail('สถานะคำขอเปลี่ยนแล้ว กรุณาโหลดข้อมูลใหม่',409);
  }
  if(action==='review'||action==='decide') {
   const assignment=user.role==='executive'&&await env.DB.prepare('SELECT kind FROM leave_reviewers WHERE leave_id=? AND user_id=?').bind(id,user.id).first();
   if(!assignment||assignment.kind!==(action==='review'?'deputy':'director'))return fail(action==='review'?'เฉพาะรองผู้บริหารที่รับผิดชอบคำขอนี้':'เฉพาะผู้อำนวยการที่ได้รับคำขอนี้',403);
   if(row.status!=='pending'||row.workflow_stage!=='forwarded')return fail('คำขอยังไม่ถูกส่งต่อ หรือมีผลพิจารณาแล้ว',409);
   const person=people.find(p=>p.user_ids.includes(user.id));
   if(!person||(action==='review'?!isDeputy(person):!isDirector(person)))return fail('ตำแหน่งผู้พิจารณาไม่ตรงกับข้อมูลปัจจุบัน',403);
   if(action==='review') {
    if(!note)return fail('กรุณาระบุความเห็นผู้บังคับบัญชา');
    return change(`UPDATE leave_requests SET reviewer_name=?,reviewer_position=?,reviewer_comment=?,reviewer_at=?
     WHERE id=? AND status='pending' AND workflow_stage='forwarded'`,[person.full_name,person.position,note,now,id],'reviewed');
   }
   if(!['approved','rejected'].includes(body.status))return fail('กรุณาเลือกอนุญาตหรือไม่อนุญาต');
   if(!row.reviewer_at)return fail('กรุณารอรองผู้บริหารบันทึกความเห็นก่อนออกคำสั่ง',409);
   return change(`UPDATE leave_requests SET status=?,workflow_stage='completed',approved_by=?,approved_at=?,decision_note=?,decision_name=?,decision_position=?
    WHERE id=? AND status='pending' AND workflow_stage='forwarded'`,[body.status,user.id,now,note,person.full_name,person.position,id],body.status);
  }
  return fail('การดำเนินการไม่ถูกต้อง');
 }
 if(id&&method==='DELETE') {
  const row=await env.DB.prepare('SELECT user_id,status,workflow_stage FROM leave_requests WHERE id=?').bind(id).first();if(!row)return fail('ไม่พบคำขอลา',404);
  if(row.user_id!==user.id)return fail('เฉพาะผู้ยื่นคำขอเท่านั้น',403);
  if(row.status!=='pending'||row.workflow_stage!=='submitted')return fail('ยกเลิกได้ก่อนหัวหน้าฝ่ายรับทราบเท่านั้น',409);
  const results=await env.DB.batch([
   env.DB.prepare("DELETE FROM leave_requests WHERE id=? AND user_id=? AND status='pending' AND workflow_stage='submitted'").bind(id,user.id),
   env.DB.prepare("INSERT INTO audit_logs(user_id,action,resource,resource_id,details) SELECT ?,'delete','leave_request',?,? WHERE changes()>0").bind(user.id,id,JSON.stringify({previous_status:row.status}))
  ]);
  return results[0].meta.changes?json({ok:true}):fail('สถานะคำขอเปลี่ยนแล้ว',409);
 }
 return fail('Method not allowed',405);
}
