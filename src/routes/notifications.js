import {ensureFinanceQueueNotifications} from './project-workflow.js';
import {getCurrentUser,isAdmin,jsonResponse} from '../lib/auth.js';
const ready=new WeakSet();
async function ensure(env){if(ready.has(env.DB))return;await env.DB.prepare(`CREATE TABLE IF NOT EXISTS notification_reads (
 user_id INTEGER NOT NULL REFERENCES users(id),message_key TEXT NOT NULL,read_at TEXT NOT NULL DEFAULT(datetime('now')),PRIMARY KEY(user_id,message_key))`).run();ready.add(env.DB);}
function feed(env,user){
 const sql=`WITH messages AS (
 SELECT 'project:'||n.id message_key,'โครงการ: '||p.name title,v.message message,v.created_at created_at,
 CASE WHEN n.audience='finance' THEN '/budget.html?view=otherProjects&project='||p.id ELSE '/project-documents.html?project='||p.id END url,n.read_at read_at
 FROM project_notifications n JOIN project_workflow_events v ON v.token=n.event_token JOIN projects p ON p.id=v.project_id WHERE n.user_id=?
 UNION ALL
 SELECT 'balance:'||r.id||':'||r.status,'คำขอแก้ยอด: '||p.name,
 CASE r.status WHEN 'pending' THEN 'มีคำขอแก้ไขยอดใช้ไปแล้ว รอพิจารณา' WHEN 'approved' THEN 'อนุมัติและปรับยอดใช้ไปแล้วเรียบร้อย' ELSE 'คำขอแก้ไขยอดไม่ได้รับอนุมัติ' END,
 COALESCE(r.reviewed_at,r.created_at),CASE WHEN ?=1 THEN '/dashboard.html' ELSE '/department.html?dept='||COALESCE(p.management_area,p.department) END,n.read_at
 FROM project_balance_notifications n JOIN project_balance_requests r ON r.id=n.request_id JOIN projects p ON p.id=r.project_id WHERE n.user_id=?
 UNION ALL
 SELECT 'leave:'||r.id||':'||r.status,'การลา: '||u.full_name,
 CASE r.status WHEN 'pending' THEN 'มีคำขอลารอพิจารณา' WHEN 'approved' THEN 'คำขอลาได้รับอนุมัติแล้ว' ELSE 'คำขอลาไม่ได้รับอนุมัติ' END,
 COALESCE(r.approved_at,r.created_at),'/leave.html',NULL
 FROM leave_requests r JOIN users u ON u.id=r.user_id WHERE (?=1 AND r.status='pending') OR (r.user_id=? AND r.status IN ('approved','rejected'))
 UNION ALL
 SELECT 'task:'||t.id,'งานที่ได้รับมอบหมาย',t.title,t.created_at,'/tasks.html',NULL
 FROM tasks t JOIN task_assignees a ON a.task_id=t.id WHERE a.user_id=? AND a.status<>'done' AND t.status='open'
 UNION ALL
 SELECT 'approval:'||a.id,'เอกสารเบิกจ่ายรอลงนาม',p.name||' · '||a.step_label,a.updated_at,'/budget.html?view=requests',NULL
 FROM budget_request_approvals a JOIN project_expenses e ON e.id=a.expense_id JOIN projects p ON p.id=e.project_id
 WHERE a.assigned_user_id=? AND a.status='pending' AND e.status='pending'
 ) SELECT m.* FROM messages m WHERE m.read_at IS NULL AND NOT EXISTS(SELECT 1 FROM notification_reads r WHERE r.user_id=? AND r.message_key=m.message_key)`;
 return {sql,values:[user.id,isAdmin(user)?1:0,user.id,isAdmin(user)?1:0,user.id,user.id,user.id,user.id]};
}
export async function handleNotifications(request,env,pathname,method){
 if(pathname!=='/api/notifications'&&pathname!=='/api/notifications/read')return null;
 const user=await getCurrentUser(request,env);if(!user?.role)return jsonResponse({error:'กรุณาเข้าสู่ระบบ'},401);
 await ensure(env);const q=feed(env,user);
 if(pathname==='/api/notifications'&&method==='GET'){
  await ensureFinanceQueueNotifications(env,user);
  const {results}=await env.DB.prepare(`SELECT *,COUNT(*) OVER() unread_count FROM (${q.sql}) ORDER BY created_at DESC,message_key DESC LIMIT 50`).bind(...q.values).all();
  return jsonResponse({unread_count:Number(results[0]?.unread_count||0),notifications:results.map(({unread_count,read_at,...r})=>r)},200,{'Cache-Control':'no-store'});
 }
 if(pathname==='/api/notifications/read'&&method==='POST'){
  const body=await request.json().catch(()=>null);if(body?.all!==true&&!body?.message_key)return jsonResponse({error:'ระบุข้อความที่จะอ่าน'},400);
  const predicate=body.all===true?'':' WHERE message_key=?';
  const result=await env.DB.prepare(`INSERT OR IGNORE INTO notification_reads(user_id,message_key)
    SELECT ?,message_key FROM (${q.sql})${predicate}`).bind(user.id,...q.values,...(body.all===true?[]:[String(body.message_key)])).run();
  // Keep existing project badges and correction inboxes in sync with the global bar.
  await env.DB.batch([
   env.DB.prepare(`UPDATE project_notifications SET read_at=datetime('now') WHERE user_id=? AND read_at IS NULL
    AND EXISTS(SELECT 1 FROM notification_reads r WHERE r.user_id=? AND r.message_key='project:'||project_notifications.id)`).bind(user.id,user.id),
   env.DB.prepare(`UPDATE project_balance_notifications SET read_at=datetime('now') WHERE user_id=? AND read_at IS NULL
    AND EXISTS(SELECT 1 FROM project_balance_requests b JOIN notification_reads r ON r.message_key='balance:'||b.id||':'||b.status
      WHERE b.id=project_balance_notifications.request_id AND r.user_id=?)`).bind(user.id,user.id),
  ]);
  return jsonResponse({ok:true,read_count:Number(result.meta.changes)});
 }
 return jsonResponse({error:'Method not allowed'},405);
}
