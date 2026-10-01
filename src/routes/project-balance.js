import { money, sumMoney } from '../lib/project-finance.js';
import {getCurrentUser,isAdmin,jsonResponse} from '../lib/auth.js';
const ready=new WeakSet();
const round=money;
const amount=v=>v!==null && v!==undefined && v!=='' && Number.isFinite(Number(v)) && Number(v)>=0 && Number(v)<=1e12 ? round(v) : null;
export async function ensureProjectBalanceSchema(env){
 if(ready.has(env.DB))return;
 await env.DB.batch([
  env.DB.prepare(`CREATE TABLE IF NOT EXISTS project_balance_requests (
    id INTEGER PRIMARY KEY AUTOINCREMENT,project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    base_total REAL NOT NULL,requested_total REAL NOT NULL,reason TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','approved','rejected')),
    requested_by INTEGER NOT NULL REFERENCES users(id),reviewed_by INTEGER REFERENCES users(id),review_note TEXT,
    created_at TEXT NOT NULL DEFAULT(datetime('now')),reviewed_at TEXT)`),
  env.DB.prepare("CREATE UNIQUE INDEX IF NOT EXISTS idx_balance_pending_project ON project_balance_requests(project_id) WHERE status='pending'"),
  env.DB.prepare(`CREATE TABLE IF NOT EXISTS project_balance_notifications (
    request_id INTEGER NOT NULL REFERENCES project_balance_requests(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id),read_at TEXT,PRIMARY KEY(request_id,user_id))`),
  env.DB.prepare(`CREATE TABLE IF NOT EXISTS project_balance_changes (
    token TEXT PRIMARY KEY,project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,old_total REAL NOT NULL,new_total REAL NOT NULL,
    reason TEXT NOT NULL,actor_id INTEGER NOT NULL REFERENCES users(id),request_id INTEGER REFERENCES project_balance_requests(id),
    created_at TEXT NOT NULL DEFAULT(datetime('now')))`),
 ]);ready.add(env.DB);
}
async function project(env,id){return env.DB.prepare(`SELECT p.id,p.name,p.department,p.fiscal_year,p.budget_amount,p.funding_type,
 COALESCE((SELECT SUM(CAST(ROUND(amount*100+0.000001) AS INTEGER))/100.0 FROM project_expenses WHERE project_id=p.id AND status='paid'),0) total_spent,
 COALESCE((SELECT SUM(CAST(ROUND(amount*100+0.000001) AS INTEGER))/100.0 FROM project_expenses WHERE project_id=p.id AND status='paid' AND COALESCE(category,'other')<>'opening_balance'),0) confirmed_spent,
 COALESCE((SELECT SUM(CAST(ROUND(amount*100+0.000001) AS INTEGER))/100.0 FROM project_expenses WHERE project_id=p.id AND status='paid' AND category='opening_balance'),0) opening_spent
 FROM projects p WHERE p.id=?`).bind(id).first()}
async function inbox(request,env,user){
 const params=new URL(request.url).searchParams,dept=params.get('department')||'',admin=isAdmin(user);
 const rows=await env.DB.prepare(`SELECT r.*,p.name project_name,COALESCE(p.management_area,p.department) department,
 u.full_name requester_name,v.full_name reviewer_name,
 EXISTS(SELECT 1 FROM project_balance_notifications n WHERE n.request_id=r.id AND n.user_id=? AND n.read_at IS NULL) unread
 FROM project_balance_requests r JOIN projects p ON p.id=r.project_id JOIN users u ON u.id=r.requested_by
 LEFT JOIN users v ON v.id=r.reviewed_by WHERE (?=1 OR r.requested_by=?) AND (?='' OR COALESCE(p.management_area,p.department)=?)
 ORDER BY CASE r.status WHEN 'pending' THEN 0 ELSE 1 END,r.id DESC LIMIT 100`).bind(user.id,admin?1:0,user.id,dept,dept).all();
 return jsonResponse({requests:rows.results,can_review:admin},200,{'Cache-Control':'no-store'});
}
async function propose(request,env,user,id){
 const body=await request.json().catch(()=>null),target=amount(body?.total_spent),reason=String(body?.reason||'').trim().slice(0,1500),p=await project(env,id);
 if(!p)return jsonResponse({error:'ไม่พบโครงการ'},404);
 if(target===null || !reason)return jsonResponse({error:'ระบุยอดเงินตั้งแต่ 0 และเหตุผลที่ขอแก้ไข'},400);
 if(target<round(p.confirmed_spent))return jsonResponse({error:'ยอดรวมต้องไม่น้อยกว่ายอดเบิกจ่ายที่ยืนยันแล้วในระบบ'},409);
 if(target===round(p.total_spent))return jsonResponse({error:'ยอดใหม่ตรงกับยอดปัจจุบันแล้ว'},400);
 try{
  const result=await env.DB.batch([
   env.DB.prepare(`INSERT INTO project_balance_requests(project_id,base_total,requested_total,reason,requested_by)
    VALUES (?,?,?,?,?)`).bind(id,round(p.total_spent),target,reason,user.id),
   env.DB.prepare(`INSERT INTO project_balance_notifications(request_id,user_id)
    SELECT (SELECT id FROM project_balance_requests WHERE project_id=? AND status='pending'),id FROM users
    WHERE status='active' AND role IN ('superadmin','executive')`).bind(id),
  ]);
  const requestId=Number(result[0].meta.last_row_id);
  return jsonResponse({id:requestId,message:'ส่งคำขอให้ผู้ดูแลระบบและผู้บริหารแล้ว'},201);
 }catch(e){if(String(e.message).includes('UNIQUE'))return jsonResponse({error:'โครงการนี้มีคำขอแก้ไขรอพิจารณาอยู่แล้ว'},409);throw e}
}
// The ledger and approval change together. Conditional insertion protects against stale approvals and concurrent edits.
async function change(env,user,id,target,base,reason,requestId=null){
 const p=await project(env,id);if(!p)return jsonResponse({error:'ไม่พบโครงการ'},404);
 if(target<round(p.confirmed_spent))return jsonResponse({error:'ยอดใหม่ต่ำกว่ารายการเบิกจ่ายที่ยืนยันแล้ว แก้ไขรายการเหล่านั้นผ่านช่องนี้ไม่ได้'},409);
 const token=crypto.randomUUID(),opening=sumMoney([target,-p.confirmed_spent]);
 const statements=[env.DB.prepare(`INSERT INTO project_balance_changes(token,project_id,old_total,new_total,reason,actor_id,request_id)
  SELECT ?,?,?,?,?,?,? WHERE ROUND(COALESCE((SELECT SUM(CAST(ROUND(amount*100+0.000001) AS INTEGER))/100.0 FROM project_expenses WHERE project_id=? AND status='paid'),0),2)=?
  AND ROUND(COALESCE((SELECT SUM(CAST(ROUND(amount*100+0.000001) AS INTEGER))/100.0 FROM project_expenses WHERE project_id=? AND status='paid' AND COALESCE(category,'other')<>'opening_balance'),0),2)=?
  AND (? IS NULL OR EXISTS(SELECT 1 FROM project_balance_requests WHERE id=? AND status='pending'))`)
  .bind(token,id,base,target,reason,user.id,requestId,id,base,id,round(p.confirmed_spent),requestId,requestId),
  env.DB.prepare(`UPDATE project_expenses SET amount=CASE WHEN ?>0 THEN ? ELSE amount END,
    status=CASE WHEN ?>0 THEN 'paid' ELSE 'cancelled' END,source_type=?,notes=?,approved_by=?,approved_at=datetime('now'),updated_at=datetime('now')
    WHERE project_id=? AND category='opening_balance' AND EXISTS(SELECT 1 FROM project_balance_changes WHERE token=?)`)
    .bind(opening,opening,opening,p.funding_type||"other",reason,user.id,id,token)];
 if(opening>0)statements.push(env.DB.prepare(`INSERT INTO project_expenses
   (project_id,fiscal_year,expense_date,document_no,category,description,amount,status,notes,created_by,approved_by,approved_at,paid_at,workflow_version,source_type)
   SELECT ?,?,date('now','+7 hours'),?,'opening_balance','ยอดใช้ไปแล้วก่อนเริ่มใช้ระบบ',?,'paid',?,?,?,datetime('now'),datetime('now'),1,?
   WHERE EXISTS(SELECT 1 FROM project_balance_changes WHERE token=?)
    AND NOT EXISTS(SELECT 1 FROM project_expenses WHERE project_id=? AND category='opening_balance')`)
   .bind(id,p.fiscal_year,'OPENING-'+id,opening,reason,user.id,user.id,p.funding_type||"other",token,id));
 if(requestId){
  statements.push(env.DB.prepare("UPDATE project_balance_requests SET status='approved',reviewed_by=?,review_note=?,reviewed_at=datetime('now') WHERE id=? AND EXISTS(SELECT 1 FROM project_balance_changes WHERE token=?)").bind(user.id,reason,requestId,token));
  statements.push(env.DB.prepare("UPDATE project_balance_notifications SET read_at=datetime('now') WHERE request_id=? AND EXISTS(SELECT 1 FROM project_balance_changes WHERE token=?)").bind(requestId,token));
  statements.push(env.DB.prepare(`INSERT INTO project_balance_notifications(request_id,user_id,read_at)
   SELECT id,requested_by,NULL FROM project_balance_requests WHERE id=? AND EXISTS(SELECT 1 FROM project_balance_changes WHERE token=?)
   ON CONFLICT(request_id,user_id) DO UPDATE SET read_at=NULL`).bind(requestId,token));
 }
 statements.push(env.DB.prepare(`INSERT INTO audit_logs(user_id,action,resource,resource_id,details)
  SELECT ?,'adjust_opening_balance','project',?,? WHERE EXISTS(SELECT 1 FROM project_balance_changes WHERE token=?)`)
  .bind(user.id,id,JSON.stringify({old_total:base,new_total:target,opening_balance:opening,request_id:requestId,reason}),token));
 const result=await env.DB.batch(statements);
 if(!result[0]?.meta?.changes)return jsonResponse({error:'ยอดเงินหรือสถานะคำขอเปลี่ยนแล้ว กรุณารีเฟรชและตรวจยอดใหม่ก่อนดำเนินการ'},409);
 return jsonResponse({message:'ปรับยอดใช้ไปแล้วและยอดคงเหลือทั้งระบบเรียบร้อย',total_spent:target,opening_balance:opening});
}
async function direct(request,env,user,id){
 if(!isAdmin(user))return jsonResponse({error:'เฉพาะผู้ดูแลระบบและผู้บริหารเท่านั้น กรุณาส่งคำขออนุญาตแก้ไข'},403);
 const body=await request.json().catch(()=>null),target=amount(body?.total_spent),base=amount(body?.expected_total),reason=String(body?.reason||'').trim().slice(0,1500);
 if(target===null||base===null||!reason)return jsonResponse({error:'กรุณาระบุยอดใหม่ ยอดเดิม และเหตุผลแก้ไข'},400);
 return change(env,user,id,target,base,reason);
}
async function review(request,env,user,id){
 if(!isAdmin(user))return jsonResponse({error:'เฉพาะผู้ดูแลระบบและผู้บริหารเท่านั้นที่พิจารณาได้'},403);
 const body=await request.json().catch(()=>null),row=await env.DB.prepare('SELECT * FROM project_balance_requests WHERE id=?').bind(id).first();
 if(!row)return jsonResponse({error:'ไม่พบคำขอ'},404);
 if(row.status!=='pending')return jsonResponse({error:'คำขอนี้พิจารณาแล้ว'},409);
 const note=String(body?.note||'').trim().slice(0,1500);
 if(body?.action==='approve')return change(env,user,row.project_id,row.requested_total,row.base_total,note||row.reason,row.id);
 if(body?.action!=='reject'||!note)return jsonResponse({error:'เลือกอนุมัติหรือไม่อนุมัติ และระบุเหตุผลเมื่อไม่อนุมัติ'},400);
 // Conditional status update prevents an overlapping approval and rejection.
 const result=await env.DB.batch([
  env.DB.prepare("UPDATE project_balance_requests SET status='rejected',reviewed_by=?,review_note=?,reviewed_at=datetime('now') WHERE id=? AND status='pending'").bind(user.id,note,id),
  env.DB.prepare("UPDATE project_balance_notifications SET read_at=datetime('now') WHERE request_id=? AND changes()=1").bind(id),
  env.DB.prepare(`INSERT INTO project_balance_notifications(request_id,user_id,read_at)
   SELECT id,requested_by,NULL FROM project_balance_requests WHERE id=? AND changes()>0
   ON CONFLICT(request_id,user_id) DO UPDATE SET read_at=NULL`).bind(id),
  env.DB.prepare(`INSERT INTO audit_logs(user_id,action,resource,resource_id,details)
   SELECT ?,'reject_balance_correction','project_balance_request',?,? WHERE changes()=1`).bind(user.id,id,JSON.stringify({note})),
 ]);
 if(!result[0]?.meta?.changes)return jsonResponse({error:'คำขอนี้พิจารณาแล้ว'},409);
 return jsonResponse({message:'ไม่อนุมัติคำขอแล้ว'});
}
export async function handleProjectBalanceRoute(request,env,pathname,method){
 const directMatch=pathname.match(/^\/api\/projects\/(\d+)\/spent-balance$/),proposeMatch=pathname.match(/^\/api\/projects\/(\d+)\/balance-requests$/),reviewMatch=pathname.match(/^\/api\/project-balance-requests\/(\d+)\/review$/);
 if(!directMatch&&!proposeMatch&&!reviewMatch&&pathname!=='/api/project-balance-requests'&&pathname!=='/api/project-balance-requests/read')return null;
 const user=await getCurrentUser(request,env);if(!user?.role)return jsonResponse({error:'กรุณาเข้าสู่ระบบ'},401);
 await ensureProjectBalanceSchema(env);
 if(directMatch&&method==='PATCH')return direct(request,env,user,Number(directMatch[1]));
 if(proposeMatch&&method==='POST')return propose(request,env,user,Number(proposeMatch[1]));
 if(reviewMatch&&method==='POST')return review(request,env,user,Number(reviewMatch[1]));
 if(pathname==='/api/project-balance-requests'&&method==='GET')return inbox(request,env,user);
 if(pathname==='/api/project-balance-requests/read'&&method==='POST'){
  const body=await request.json().catch(()=>null);await env.DB.prepare("UPDATE project_balance_notifications SET read_at=datetime('now') WHERE request_id=? AND user_id=?").bind(Number(body?.id)||0,user.id).run();return jsonResponse({ok:true});
 }
 return jsonResponse({error:'Method not allowed'},405);
}
