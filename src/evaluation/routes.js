import {getCurrentUser,jsonResponse,parseCookies} from '../lib/auth.js';
import {ensureDepartmentStaff} from '../routes/department-staff.js';
import {ensureEvaluationSchema} from './schema.js';
import {starterTemplates} from './templates.js';
import {EvaluationError,requireValue,validateRubric,validateScores,summarize} from './scoring.js';
export const EVALUATION_HOST='evaluate.banpadengschool.ac.th';
const cookieName='__Host-bpd_evaluator',days7=604800;
const response=(body,status=200,headers={})=>jsonResponse(body,status,{'Cache-Control':'private, no-store','Referrer-Policy':'no-referrer',...headers});
const clean=(value,max=500)=>String(value??'').trim().slice(0,max);
const idOf=value=>{const n=Number(value);requireValue(Number.isSafeInteger(n)&&n>0,'รหัสไม่ถูกต้อง');return n;};
const random=()=>Array.from(crypto.getRandomValues(new Uint8Array(32)),b=>b.toString(16).padStart(2,'0')).join('');
const hash=async text=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(text))),b=>b.toString(16).padStart(2,'0')).join('');
const now=()=>Math.floor(Date.now()/1000);
function live(a){return !a.revoked_at&&(!a.expires_at||a.expires_at>now());}
function date(value){return typeof value==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(value)&&!Number.isNaN(Date.parse(value))&&new Date(value+'T00:00:00Z').toISOString().slice(0,10)===value;}
async function input(request){
 requireValue((request.headers.get('content-type')||'').includes('application/json'),'รองรับข้อมูล JSON เท่านั้น',415);
 requireValue(Number(request.headers.get('content-length')||0)<=120000,'ข้อมูลมีขนาดใหญ่เกินไป',413);
 const reader=request.body?.getReader();let count=0;const chunks=[];
 if(reader)while(true){const {done,value}=await reader.read();if(done)break;count+=value.length;if(count>120000){await reader.cancel();throw new EvaluationError('ข้อมูลมีขนาดใหญ่เกินไป',413);}chunks.push(value);}
 const bytes=new Uint8Array(count);let offset=0;for(const c of chunks){bytes.set(c,offset);offset+=c.length;}
 try{return JSON.parse(new TextDecoder().decode(bytes));}catch{throw new EvaluationError('ข้อมูล JSON ไม่ถูกต้อง');}
}
export async function evaluationPermissions(env,user){
 if(!user?.role)return {access:false,manage:false,criteria:false,finalize:false};
 await ensureDepartmentStaff(env);
 const {results:heads}=await env.DB.prepare(`SELECT d.department FROM department_staff d
 JOIN personnel_records p ON p.id=d.personnel_id AND p.status='active'
 JOIN personnel_accounts a ON a.personnel_id=p.id WHERE d.is_head=1 AND a.user_id=?`).bind(user.id).all();
 const executive=user.role==='executive',admin=user.role==='superadmin',personnel=heads.some(h=>h.department==='personnel');
 return {access:executive||admin||heads.length>0,manage:executive||admin||personnel,criteria:admin||personnel,finalize:executive};
}
async function actor(request,env){
 const token=parseCookies(request)[cookieName];
 if(token&&/^[0-9a-f]{64}$/.test(token)){
  const guest=await env.DB.prepare('SELECT * FROM evaluation_assignments WHERE session_hash=? AND user_id IS NULL').bind(await hash(token)).first();
  if(guest&&live(guest))return {guest,user:null,permissions:{access:true,manage:false,criteria:false,finalize:false}};
 }
 const user=await getCurrentUser(request,env);
 return {user,guest:null,permissions:await evaluationPermissions(env,user)};
}
const requireAccess=a=>requireValue(a.permissions.access,'เฉพาะผู้บริหาร หัวหน้าฝ่าย ผู้ดูแลระบบ หรือกรรมการภายนอกที่ได้รับสิทธิ์',a.user?403:401);
const requireManage=a=>requireValue(a.permissions.manage,'ไม่มีสิทธิ์จัดการรอบประเมิน',403);
async function audit(env,a,caseId,action,detail={}){
 await env.DB.prepare('INSERT INTO evaluation_events(case_id,actor_user_id,actor_assignment_id,action,detail_json) VALUES(?,?,?,?,?)')
 .bind(caseId||null,a.user?.id||null,a.guest?.id||null,action,JSON.stringify(detail)).run();
}
async function caseById(env,id){const row=await env.DB.prepare(`SELECT c.*,p.full_name,p.position,p.academic_rank,t.name AS template_name,t.kind,t.reference
 FROM evaluation_cases c JOIN personnel_records p ON p.id=c.personnel_id JOIN evaluation_templates t ON t.id=c.template_id WHERE c.id=?`).bind(id).first();requireValue(row,'ไม่พบการประเมิน',404);return row;}
async function assignments(env,id){return (await env.DB.prepare(`SELECT a.*,COALESCE(u.full_name,a.guest_name) AS name,b.scores_json,b.comment,b.revision,b.submitted_at
 FROM evaluation_assignments a LEFT JOIN users u ON u.id=a.user_id LEFT JOIN evaluation_ballots b ON b.assignment_id=a.id WHERE a.case_id=? ORDER BY a.id`).bind(id).all()).results;}
async function owns(env,user,personId){return !!user&&!!await env.DB.prepare('SELECT 1 FROM personnel_accounts WHERE user_id=? AND personnel_id=?').bind(user.id,personId).first();}
const assigned=(a,rows)=>rows.find(r=>a.guest?r.id===a.guest.id:r.user_id===a.user?.id);
function safeAssignment(row,includeScores=false){const result={id:row.id,name:row.name,user_id:row.user_id,guest_org:row.guest_org,expires_at:row.expires_at,revoked_at:row.revoked_at,redeemed_at:row.redeemed_at,submitted_at:row.submitted_at,revision:row.revision??0};if(includeScores)Object.assign(result,{scores:JSON.parse(row.scores_json||'{}'),comment:row.comment||''});return result;}
function safeCase(row){const {rubric_json,result_json,...c}=row;return {...c,rubric:JSON.parse(rubric_json),result:result_json?JSON.parse(result_json):null};}
export async function handleEvaluationRoute(request,env,pathname,method){
 if(!pathname.startsWith('/api/evaluation/'))return null;
 try{
  if(!['GET','HEAD'].includes(method)){
   const origin=request.headers.get('origin');requireValue(!origin||origin===new URL(request.url).origin,'ที่มาคำขอไม่ถูกต้อง',403);
   requireValue(request.headers.get('sec-fetch-site')!=='cross-site','ไม่รับคำขอข้ามเว็บไซต์',403);
  }
  await ensureEvaluationSchema(env);
  if(pathname==='/api/evaluation/guest/session'&&method==='POST'){
   const body=await input(request);requireValue(typeof body.token==='string'&&/^[0-9a-f]{64}$/.test(body.token),'ลิงก์เชิญไม่ถูกต้อง',401);
   const token=random(),time=now();
   const updated=await env.DB.prepare(`UPDATE evaluation_assignments SET session_hash=?,redeemed_at=?
   WHERE invite_hash=? AND user_id IS NULL AND redeemed_at IS NULL AND revoked_at IS NULL AND expires_at>? RETURNING expires_at`)
   .bind(await hash(token),time,await hash(body.token),time).first();
   requireValue(updated,'ลิงก์หมดอายุ ถูกใช้แล้ว หรือถูกเพิกถอน',401);
   return response({ok:true,expires_at:updated.expires_at},200,{'Set-Cookie':`${cookieName}=${token}; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=${Math.max(0,updated.expires_at-time)}`});
  }
  if(pathname==='/api/evaluation/guest/logout'&&method==='POST'){
   const token=parseCookies(request)[cookieName];if(token)await env.DB.prepare('UPDATE evaluation_assignments SET session_hash=NULL WHERE session_hash=?').bind(await hash(token)).run();
   return response({ok:true},200,{'Set-Cookie':`${cookieName}=; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=0`});
  }
  const a=await actor(request,env);
  if(pathname==='/api/evaluation/permissions'&&method==='GET')return response({...a.permissions,user:a.user?{id:a.user.id,full_name:a.user.full_name}:null,guest:a.guest?{name:a.guest.guest_name,expires_at:a.guest.expires_at}:null});
  // This endpoint alone is also available to ordinary teachers on the school host.
  if(pathname==='/api/evaluation/results'&&method==='GET'){
   requireValue(a.user?.role,'กรุณาเข้าสู่ระบบ',401);
   const all=a.permissions.access;
   const rows=await env.DB.prepare(`SELECT c.id,c.personnel_id,p.full_name,c.title,c.fiscal_year,c.cycle,c.rank,c.published_at,c.result_json,t.kind,t.name AS template_name
   FROM evaluation_cases c JOIN personnel_records p ON p.id=c.personnel_id JOIN evaluation_templates t ON t.id=c.template_id
   WHERE c.state='published' ${all?'':`AND EXISTS (SELECT 1 FROM personnel_accounts x WHERE x.personnel_id=c.personnel_id AND x.user_id=?)`}
   ORDER BY c.fiscal_year DESC,c.published_at DESC,c.id DESC`).bind(...(all?[]:[a.user.id])).all();
   return response({results:rows.results.map(({result_json,...r})=>({...r,result:JSON.parse(result_json)})),can_evaluate:a.permissions.access});
  }
  requireAccess(a);
  if(pathname==='/api/evaluation/templates'&&method==='GET'){
   requireValue(!a.guest,'ไม่มีสิทธิ์ดูคลังเกณฑ์',403);
   const rows=await env.DB.prepare('SELECT * FROM evaluation_templates ORDER BY id DESC').all();
   return response({templates:rows.results.map(({rubric_json,...t})=>({...t,rubric:JSON.parse(rubric_json)})),starters:starterTemplates});
  }
  if(pathname==='/api/evaluation/templates'&&method==='POST'){
   requireValue(a.permissions.criteria,'เฉพาะหัวหน้าฝ่ายบุคคลและแอดมินแก้เกณฑ์ได้',403);
   const b=await input(request);requireValue(['pa','assistant'].includes(b.kind)&&clean(b.name),'ชื่อหรือประเภทเกณฑ์ไม่ถูกต้อง');validateRubric(b.rubric);
   requireValue(clean(b.reference),'ต้องระบุเอกสารอ้างอิง');
   if(b.verified){requireValue(b.confirm_reference===true,'ต้องยืนยันว่าตรวจเทียบเอกสารอ้างอิงแล้ว');requireValue(!b.rubric.items.some(i=>/รอระบุรายการ/.test(i.label)),'ยังมีรายการชั่วคราว ต้องแทนด้วยแบบ ก.ค.ศ. ฉบับเต็ม');}
   const r=await env.DB.prepare('INSERT INTO evaluation_templates(name,kind,reference,rubric_json,verified,created_by) VALUES(?,?,?,?,?,?)')
   .bind(clean(b.name,200),b.kind,clean(b.reference,2000),JSON.stringify(b.rubric),b.verified?1:0,a.user.id).run();
   await audit(env,a,null,'template_created',{template_id:r.meta.last_row_id,verified:!!b.verified});return response({id:r.meta.last_row_id},201);
  }
  if(pathname==='/api/evaluation/people'&&method==='GET'){
   requireManage(a);
   const people=await env.DB.prepare("SELECT id,full_name,position,academic_rank FROM personnel_records WHERE status='active' ORDER BY full_name").all();
   const candidates=await env.DB.prepare("SELECT id,full_name,role FROM users WHERE status='active' AND role IS NOT NULL ORDER BY full_name").all();
   // Eligibility is enforced again at assignment time. Current department heads are included.
   const heads=await env.DB.prepare(`SELECT DISTINCT x.user_id FROM department_staff d JOIN personnel_records p ON p.id=d.personnel_id AND p.status='active' JOIN personnel_accounts x ON x.personnel_id=p.id WHERE d.is_head=1`).all();
   const ids=new Set(heads.results.map(x=>x.user_id));
   return response({people:people.results,evaluators:candidates.results.filter(u=>['superadmin','executive'].includes(u.role)||ids.has(u.id))});
  }
  if(pathname==='/api/evaluation/cases'&&method==='GET'){
   const condition=a.permissions.manage?'1=1':a.guest?'EXISTS(SELECT 1 FROM evaluation_assignments a WHERE a.case_id=c.id AND a.id=?)':`EXISTS(SELECT 1 FROM evaluation_assignments a WHERE a.case_id=c.id AND a.user_id=?)`;
   const rows=await env.DB.prepare(`SELECT c.id,c.title,c.fiscal_year,c.cycle,c.state,c.personnel_id,p.full_name,t.kind,t.name AS template_name,
   (SELECT COUNT(*) FROM evaluation_assignments x WHERE x.case_id=c.id) AS committee_count,
   (SELECT COUNT(*) FROM evaluation_assignments x JOIN evaluation_ballots b ON b.assignment_id=x.id WHERE x.case_id=c.id AND b.submitted_at IS NOT NULL) AS submitted_count
   FROM evaluation_cases c JOIN personnel_records p ON p.id=c.personnel_id JOIN evaluation_templates t ON t.id=c.template_id WHERE ${condition} ORDER BY c.created_at DESC,c.id DESC`)
   .bind(...(a.permissions.manage?[]:[a.guest?.id||a.user.id])).all();return response({cases:rows.results});
  }
  if(pathname==='/api/evaluation/cases'&&method==='POST'){
   requireManage(a);const b=await input(request),personId=idOf(b.personnel_id),templateId=idOf(b.template_id);
   const person=await env.DB.prepare("SELECT id FROM personnel_records WHERE id=? AND status='active'").bind(personId).first();requireValue(person,'ไม่พบบุคลากร',404);
   const template=await env.DB.prepare('SELECT * FROM evaluation_templates WHERE id=?').bind(templateId).first();requireValue(template?.verified,'ต้องเลือกเกณฑ์ที่ตรวจสอบและยืนยันแล้ว');
   requireValue(clean(b.title)&&Number.isInteger(b.fiscal_year)&&b.fiscal_year>=2500&&b.fiscal_year<=2800,'ชื่อรอบหรือปีงบประมาณไม่ถูกต้อง');
   requireValue(Number.isInteger(b.cycle)&&b.cycle>=1&&b.cycle<=4,'ครั้งที่ประเมินไม่ถูกต้อง');
   requireValue(date(b.start_date)&&date(b.end_date)&&b.start_date<=b.end_date,'ช่วงวันที่ประเมินไม่ถูกต้อง');
   if(b.evidence_url)requireValue(/^https:\/\//.test(b.evidence_url)&&new URL(b.evidence_url).username===''&&new URL(b.evidence_url).password==='','ลิงก์หลักฐานต้องเป็น HTTPS');
   const r=await env.DB.prepare(`INSERT INTO evaluation_cases(personnel_id,template_id,title,fiscal_year,cycle,start_date,end_date,rank,challenge,evidence_url,rubric_json,created_by) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`)
   .bind(personId,templateId,clean(b.title,240),b.fiscal_year,b.cycle,b.start_date,b.end_date,clean(b.rank,200),clean(b.challenge,8000),clean(b.evidence_url,2000),template.rubric_json,a.user.id).run();
   await audit(env,a,r.meta.last_row_id,'created',{template_id:templateId});return response({id:r.meta.last_row_id},201);
  }
  const match=pathname.match(/^\/api\/evaluation\/cases\/(\d+)(?:\/(assignments|open|ballot|publish|reopen|revoke|renew|remove|events))?$/);
  if(!match)return response({error:'ไม่พบ endpoint การประเมิน'},404);
  const id=idOf(match[1]),action=match[2],c=await caseById(env,id),rows=await assignments(env,id),mine=assigned(a,rows);
  requireValue(a.permissions.manage||mine,'ไม่ได้รับมอบหมายให้ประเมินรายนี้',403);
  if(!action&&method==='GET'){
   const summary=rows.length===JSON.parse(c.rubric_json).committee_size&&rows.every(b=>b.submitted_at)?summarize(JSON.parse(c.rubric_json),rows):null;
   return response({case:safeCase(c),assignments:a.guest?rows.filter(r=>r.id===a.guest.id).map(r=>safeAssignment(r,true)):rows.map(r=>safeAssignment(r,a.permissions.manage||r.id===mine?.id)),mine:mine?safeAssignment(mine,true):null,summary:a.permissions.manage?summary:null,can_finalize:a.permissions.finalize&&!await owns(env,a.user,c.personnel_id)});
  }
  if(action==='events'&&method==='GET'){
   requireManage(a);const events=await env.DB.prepare(`SELECT e.id,e.action,e.detail_json,e.created_at,COALESCE(u.full_name,x.guest_name) AS actor FROM evaluation_events e LEFT JOIN users u ON u.id=e.actor_user_id LEFT JOIN evaluation_assignments x ON x.id=e.actor_assignment_id WHERE e.case_id=? ORDER BY e.id`).bind(id).all();return response({events:events.results});
  }
  if(action==='assignments'&&method==='POST'){
   requireManage(a);requireValue(c.state==='draft','กำหนดกรรมการได้ก่อนเปิดรอบเท่านั้น',409);const b=await input(request);
   requireValue(rows.length<JSON.parse(c.rubric_json).committee_size,'กรรมการครบตามเกณฑ์แล้ว',409);
   let userId=null,token=null,guestName=null,guestOrg=null,expires=null;
   if(b.user_id){userId=idOf(b.user_id);const user=await env.DB.prepare("SELECT id,role FROM users WHERE id=? AND status='active'").bind(userId).first();requireValue((await evaluationPermissions(env,user)).access,'บัญชีนี้ไม่มีสิทธิ์ประเมิน',403);requireValue(!await owns(env,user,c.personnel_id),'ห้ามประเมินตนเอง',403);requireValue(!rows.some(r=>r.user_id===userId),'กรรมการซ้ำ',409);
    const duplicate=await env.DB.prepare(`SELECT 1 FROM evaluation_assignments a JOIN personnel_accounts existing ON existing.user_id=a.user_id JOIN personnel_accounts selected ON selected.personnel_id=existing.personnel_id WHERE a.case_id=? AND selected.user_id=? LIMIT 1`).bind(id,userId).first();requireValue(!duplicate,'กรรมการคนเดียวกันมีบัญชีอื่นอยู่ในรอบนี้แล้ว',409);}
   else{guestName=clean(b.guest_name,200);guestOrg=clean(b.guest_org,300);requireValue(guestName&&guestOrg,'ต้องระบุชื่อและหน่วยงานผู้ทรงคุณวุฒิ');token=random();expires=now()+days7;}
   const r=await env.DB.prepare(`INSERT INTO evaluation_assignments(case_id,user_id,guest_name,guest_org,invite_hash,expires_at,created_by)
   SELECT ?,?,?,?,?,?,? WHERE (SELECT state FROM evaluation_cases WHERE id=?)='draft' AND (SELECT COUNT(*) FROM evaluation_assignments WHERE case_id=?)<?`)
   .bind(id,userId,guestName,guestOrg,token?await hash(token):null,expires,a.user.id,id,id,JSON.parse(c.rubric_json).committee_size).run();
   requireValue(r.meta.changes===1,'รอบหรือจำนวนกรรมการเปลี่ยน กรุณารีเฟรช',409);
   await audit(env,a,id,'assigned',{assignment_id:r.meta.last_row_id,external:!!token,expires_at:expires});
   return response({id:r.meta.last_row_id,expires_at:expires,invitation_url:token?`https://${EVALUATION_HOST}/evaluate.html#invite=${token}`:null},201);
  }
  if(action==='remove'&&method==='POST'){
   requireManage(a);requireValue(c.state==='draft','นำกรรมการออกได้ก่อนเปิดรอบเท่านั้น',409);const b=await input(request),assignmentId=idOf(b.assignment_id);
   requireValue(rows.some(r=>r.id===assignmentId),'ไม่พบกรรมการ',404);
   const r=await env.DB.prepare("DELETE FROM evaluation_assignments WHERE id=? AND case_id=? AND (SELECT state FROM evaluation_cases WHERE id=?)='draft' AND NOT EXISTS(SELECT 1 FROM evaluation_events WHERE actor_assignment_id=?)").bind(assignmentId,id,id,assignmentId).run();requireValue(r.meta.changes===1,'ไม่สามารถนำกรรมการรายนี้ออกได้',409);
   await audit(env,a,id,'assignment_removed',{assignment_id:assignmentId});return response({ok:true});
  }
  if(action==='renew'&&method==='POST'){
   requireManage(a);requireValue(c.state!=='published','รอบนี้ยืนยันผลแล้ว',409);const b=await input(request),assignmentId=idOf(b.assignment_id);
   requireValue(rows.some(r=>r.id===assignmentId&&!r.user_id),'ไม่พบกรรมการภายนอก',404);requireValue(clean(b.reason),'ต้องระบุเหตุผล');
   const token=random(),expires=now()+days7;
   const r=await env.DB.prepare("UPDATE evaluation_assignments SET invite_hash=?,session_hash=NULL,redeemed_at=NULL,revoked_at=NULL,expires_at=? WHERE id=? AND case_id=? AND (SELECT state FROM evaluation_cases WHERE id=?)<>'published'").bind(await hash(token),expires,assignmentId,id,id).run();requireValue(r.meta.changes===1,'รอบนี้ยืนยันผลแล้ว',409);
   await audit(env,a,id,'guest_renewed',{assignment_id:assignmentId,reason:clean(b.reason,2000),expires_at:expires});
   return response({invitation_url:`https://${EVALUATION_HOST}/evaluate.html#invite=${token}`,expires_at:expires});
  }
  if(action==='open'&&method==='POST'){
   requireManage(a);requireValue(rows.length===JSON.parse(c.rubric_json).committee_size,'ต้องแต่งตั้งกรรมการให้ครบ',409);
   for(const r of rows){requireValue(live(r),'กรรมการมีสิทธิ์หมดอายุหรือถูกเพิกถอน',409);if(r.user_id){const u=await env.DB.prepare("SELECT id,role FROM users WHERE id=? AND status='active'").bind(r.user_id).first();requireValue((await evaluationPermissions(env,u)).access&&!await owns(env,u,c.personnel_id),'กรรมการมีสิทธิ์ไม่ถูกต้อง',409);}}
   const r=await env.DB.prepare("UPDATE evaluation_cases SET state='open' WHERE id=? AND state='draft'").bind(id).run();requireValue(r.meta.changes===1,'รอบนี้เปิดแล้วหรือยืนยันผลแล้ว',409);
   await audit(env,a,id,'opened');return response({ok:true});
  }
  if(action==='ballot'&&method==='PUT'){
   requireValue(mine&&live(mine),'ไม่ได้รับมอบหมายหรือสิทธิ์หมดอายุ',403);requireValue(!await owns(env,a.user,c.personnel_id),'ห้ามประเมินตนเอง',403);
   requireValue(c.state==='open','รอบยังไม่เปิดหรือยืนยันผลแล้ว',409);requireValue(!mine.submitted_at,'ส่งคะแนนแล้ว ต้องขอเปิดแก้ไข',409);
   const b=await input(request);requireValue(Number.isInteger(b.revision)&&b.revision===(mine.revision??0),'คะแนนถูกแก้จากหน้าต่างอื่น กรุณาโหลดใหม่',409);
   requireValue(b.submit===undefined||typeof b.submit==='boolean','สถานะการส่งคะแนนไม่ถูกต้อง');validateScores(JSON.parse(c.rubric_json),b.scores,b.submit===true);
   const r=await env.DB.prepare(`INSERT INTO evaluation_ballots(assignment_id,scores_json,comment,revision,submitted_at)
   SELECT ?,?,?,1,CASE WHEN ?=1 THEN datetime('now') ELSE NULL END
   WHERE (SELECT state FROM evaluation_cases WHERE id=?)='open'
   AND EXISTS(SELECT 1 FROM evaluation_assignments x WHERE x.id=? AND x.revoked_at IS NULL AND (x.expires_at IS NULL OR x.expires_at>?))
   ON CONFLICT(assignment_id) DO UPDATE SET scores_json=excluded.scores_json,comment=excluded.comment,revision=evaluation_ballots.revision+1,
   submitted_at=excluded.submitted_at,updated_at=datetime('now') WHERE evaluation_ballots.submitted_at IS NULL AND evaluation_ballots.revision=?`)
   .bind(mine.id,JSON.stringify(b.scores),clean(b.comment,4000),b.submit?1:0,id,mine.id,now(),b.revision).run();requireValue(r.meta.changes===1,'คะแนนหรือสถานะรอบเปลี่ยน กรุณาโหลดใหม่',409);
   await audit(env,a,id,b.submit?'ballot_submitted':'ballot_saved',{assignment_id:mine.id,revision:b.revision+1});return response({ok:true,revision:b.revision+1});
  }
  if(action==='reopen'&&method==='POST'){
   requireManage(a);requireValue(c.state==='open','เปิดแก้ไขได้ก่อนยืนยันผลเท่านั้น',409);const b=await input(request),assignmentId=idOf(b.assignment_id);requireValue(clean(b.reason),'ต้องระบุเหตุผลการเปิดแก้คะแนน');requireValue(rows.some(r=>r.id===assignmentId),'กรรมการไม่อยู่ในรอบนี้',404);
   const r=await env.DB.prepare(`UPDATE evaluation_ballots SET submitted_at=NULL,revision=revision+1,updated_at=datetime('now') WHERE assignment_id=? AND submitted_at IS NOT NULL AND (SELECT state FROM evaluation_cases WHERE id=?)='open'`).bind(assignmentId,id).run();requireValue(r.meta.changes===1,'ไม่มีคะแนนที่เปิดแก้ไขได้',409);
   await audit(env,a,id,'ballot_reopened',{assignment_id:assignmentId,reason:clean(b.reason,2000)});return response({ok:true});
  }
  if(action==='revoke'&&method==='POST'){
   requireManage(a);const b=await input(request),assignmentId=idOf(b.assignment_id);requireValue(rows.some(r=>r.id===assignmentId&&!r.user_id),'ไม่พบกรรมการภายนอก',404);requireValue(clean(b.reason),'ต้องระบุเหตุผล');
   await env.DB.prepare('UPDATE evaluation_assignments SET revoked_at=?,session_hash=NULL,invite_hash=NULL WHERE id=? AND case_id=?').bind(now(),assignmentId,id).run();
   await audit(env,a,id,'guest_revoked',{assignment_id:assignmentId,reason:clean(b.reason,2000)});return response({ok:true});
  }
  if(action==='publish'&&method==='POST'){
   requireValue(a.permissions.finalize,'เฉพาะผู้บริหารยืนยันผลประเมิน',403);requireValue(!await owns(env,a.user,c.personnel_id),'ห้ามยืนยันผลของตนเอง',403);
   requireValue(c.state==='open','รอบนี้ยังไม่เปิดหรือยืนยันผลแล้ว',409);
   const result=summarize(JSON.parse(c.rubric_json),rows);
   // Ballots may be reopened concurrently: compare their revisions and submission markers atomically.
   const guards=rows.map(()=>`EXISTS(SELECT 1 FROM evaluation_ballots b WHERE b.assignment_id=? AND b.revision=? AND b.submitted_at IS NOT NULL)`);
   const r=await env.DB.prepare(`UPDATE evaluation_cases SET state='published',result_json=?,published_by=?,published_at=datetime('now') WHERE id=? AND state='open' AND ${guards.join(' AND ')}`)
   .bind(JSON.stringify(result),a.user.id,id,...rows.flatMap(r=>[r.id,r.revision])).run();requireValue(r.meta.changes===1,'คะแนนเปลี่ยน กรุณาโหลดใหม่ก่อนยืนยันผล',409);
   await audit(env,a,id,'published',{passed:result.passed});return response({ok:true,result});
  }
  return response({error:'Method not allowed'},405);
 }catch(e){if(e instanceof EvaluationError)return response({error:e.message},e.status);throw e;}
}

// A dedicated hostname serves only evaluation assets and APIs. No external grant is a school login.
export function evaluationHostPathAllowed(path){
 return path.startsWith('/api/evaluation/')||['/api/auth/login','/api/auth/logout','/','/evaluate','/evaluate.html','/css/evaluation.css','/js/evaluation.js'].includes(path);
}
