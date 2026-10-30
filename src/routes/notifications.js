import {ensureFinanceQueueNotifications} from './project-workflow.js';
import {FINANCE_ROLE_SQL} from '../lib/finance-roles.js';
import {ensureProcurementSchema} from './procurement.js';
import {getCurrentUser,isAdmin,jsonResponse} from '../lib/auth.js';
import {isPersonnelHead} from '../lib/leave-permissions.js';
import {ensureLeaveData} from '../lib/leave-data.js';
import {ensureStudentDeletionSchema,isSchoolDirector} from './student-deletion.js';
const ready=new WeakSet();
async function ensure(env){if(ready.has(env.DB))return;await env.DB.prepare(`CREATE TABLE IF NOT EXISTS notification_reads (
 user_id INTEGER NOT NULL REFERENCES users(id),message_key TEXT NOT NULL,read_at TEXT NOT NULL DEFAULT(datetime('now')),PRIMARY KEY(user_id,message_key))`).run();ready.add(env.DB);}
// ตารางของโมดูลที่สร้างเมื่อเปิดใช้ครั้งแรก — รวมเข้า feed เฉพาะเมื่อมีตารางแล้ว
const OPTIONAL_TABLES=['substitute_assignments','substitute_absences','timetable_entries','personnel_accounts','personnel_records','correspondence_records','supervision_notifications','supervision_requests','security_notifications','maintenance_requests','maintenance_updates','department_staff'];
export async function optionalFeedTables(env){
 const {results}=await env.DB.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name IN (${OPTIONAL_TABLES.map(()=>'?').join(',')})`).bind(...OPTIONAL_TABLES).all();
 return new Set(results.map(r=>r.name));
}
function feed(env,user,personnelHead,director,tables=new Set(),forLine=false){
 const extra=[],extraValues=[];
 // Early notice for designated deputy is read-only; workflow roles are enforced by leave.js
 const earlyDeputy=`(?=1 AND r.status='pending' AND r.workflow_stage IN ('submitted','acknowledged')
 AND EXISTS(SELECT 1 FROM personnel_accounts a JOIN personnel_records p ON p.id=a.personnel_id
 WHERE p.id=r.deputy_personnel_id AND p.status='active' AND REPLACE(p.position,' ','') LIKE '%รองผู้อำนวยการ%' AND a.user_id=?))`;
 if(['substitute_assignments','substitute_absences','timetable_entries','personnel_accounts','personnel_records'].every(t=>tables.has(t))){
  extra.push(`SELECT 'substitute:'||a.id,'สอนแทน',
  'วันที่ '||a.absence_date||' คาบ '||a.period||' · '||COALESCE(e.classroom,'')||' '||COALESCE(e.subject,'')||COALESCE(' (แทน '||ap.full_name||')',''),
  a.created_at,'/substitutes.html',NULL,a.created_by,1
  FROM substitute_assignments a JOIN personnel_accounts pa ON pa.personnel_id=a.substitute_teacher_id
  LEFT JOIN timetable_entries e ON e.id=a.timetable_entry_id LEFT JOIN substitute_absences ab ON ab.id=a.absence_id
  LEFT JOIN personnel_records ap ON ap.id=ab.teacher_id
  WHERE pa.user_id=? AND a.absence_date>=date('now','+7 hours')`);extraValues.push(user.id);
 }
 if(tables.has('correspondence_records')){
  extra.push(`SELECT 'correspondence:'||c.id||':'||c.assigned_to,'หนังสือราชการ'||CASE WHEN c.urgency<>'normal' THEN ' (ด่วน)' ELSE '' END,
  c.subject||CASE WHEN c.due_date IS NOT NULL THEN ' · กำหนด '||c.due_date ELSE '' END,c.updated_at,'/correspondence.html?record='||c.id,NULL,NULL,1
  FROM correspondence_records c WHERE c.assigned_to=? AND c.created_by<>? AND c.status NOT IN ('completed','archived')`);extraValues.push(user.id,user.id);
 }
 // ระบบนิเทศ: กลุ่มข้อความแยก เพราะกลุ่ม secondary อาจเต็ม 5 terms แล้ว
 // แจ้งเตือนระบบนิเทศ และแจ้งเตือนความปลอดภัยบัญชี (อุปกรณ์ใหม่ รหัสผิด เปลี่ยนรหัส/สิทธิ์)
 const tertiaryTerms=[],tertiaryValues=[];
 if(tables.has('supervision_notifications')&&tables.has('supervision_requests')){tertiaryTerms.push(`SELECT 'supervision:'||n.id,'นิเทศการสอน',n.message,n.created_at,
 CASE WHEN r.teacher_user_id=n.user_id THEN '/supervision.html?request='||r.id ELSE '/supervision-admin.html?request='||r.id END,n.read_at,n.actor_id,1
 FROM supervision_notifications n JOIN supervision_requests r ON r.id=n.request_id WHERE n.user_id=?`);tertiaryValues.push(user.id);}
 if(tables.has('security_notifications')){tertiaryTerms.push(`SELECT 'security:'||n.id,'ความปลอดภัยบัญชี',n.message,n.created_at,'/account.html#devices',n.read_at,NULL,1
 FROM security_notifications n WHERE n.user_id=?`);tertiaryValues.push(user.id);}
 // แจ้งซ่อม (LINE ส่งแยกอยู่แล้ว จึงไม่รวมใน feed ของ LINE)
 // หัวหน้าฝ่ายบริหารทั่วไป: แจ้งใหม่รอมอบหมาย / ซ่อมเสร็จรอตรวจรับ · ผู้รับมอบหมาย: งานที่ได้รับ · ผู้แจ้ง: ซ่อมเสร็จแล้ว
 if(!forLine&&['maintenance_requests','maintenance_updates','department_staff','personnel_records','personnel_accounts'].every(t=>tables.has(t))){tertiaryTerms.push(`SELECT 'maintenance:'||x.id||':'||x.role||':'||x.stamp,x.title,x.request_no||' · '||x.mtitle,x.stamp,'/maintenance.html?request='||x.id,NULL,NULL,1 FROM (
 SELECT m.id,m.request_no,m.title mtitle,
  CASE WHEN me.head=1 AND m.status='reported' THEN 'head-new' WHEN me.head=1 AND m.status='completed' THEN 'head-done' WHEN m.status='assigned' AND m.assigned_to=me.uid THEN 'assignee' ELSE 'reporter' END role,
  CASE WHEN me.head=1 AND m.status='reported' THEN 'แจ้งซ่อมใหม่ รอมอบหมาย' WHEN me.head=1 AND m.status='completed' THEN 'ซ่อมเสร็จแล้ว รอตรวจรับ' WHEN m.status='assigned' AND m.assigned_to=me.uid THEN 'ได้รับมอบหมายงานซ่อม' ELSE 'งานที่คุณแจ้งซ่อมเสร็จแล้ว' END title,
  CASE WHEN m.status IN ('completed','verified') THEN COALESCE(m.completed_at,m.updated_at) ELSE m.updated_at END stamp
 FROM maintenance_requests m JOIN (SELECT ? uid,EXISTS(SELECT 1 FROM department_staff d JOIN personnel_records p ON p.id=d.personnel_id AND p.status='active'
  JOIN personnel_accounts a ON a.personnel_id=p.id WHERE d.department='general' AND d.is_head=1 AND a.user_id=?) head) me
 WHERE (me.head=1 AND m.status IN ('reported','completed'))
  OR (m.status='assigned' AND m.assigned_to=me.uid AND COALESCE((SELECT u.created_by FROM maintenance_updates u WHERE u.request_id=m.id ORDER BY u.id DESC LIMIT 1),0)<>me.uid)
  OR (m.reported_by=me.uid AND m.status IN ('completed','verified') AND m.completed_at>=datetime('now','-30 days')
   AND COALESCE((SELECT u.created_by FROM maintenance_updates u WHERE u.request_id=m.id AND u.new_status='completed' ORDER BY u.id DESC LIMIT 1),0)<>me.uid)
 ) x`);tertiaryValues.push(user.id,user.id);}
 const supervision=tertiaryTerms.length>0;
 const tertiary=supervision?`, tertiary_messages AS (
 ${tertiaryTerms.join('\n UNION ALL\n ')}
 )`:'';
 // D1 permits at most five terms in one compound SELECT. Keep each group below
 // that limit, including the two optional message sources.
 const sql=`WITH primary_messages AS (
 SELECT 'project:'||n.id message_key,'โครงการ: '||p.name title,v.message message,v.created_at created_at,
 CASE WHEN n.audience='finance' THEN '/budget.html?view=otherProjects&project='||p.id ELSE '/project-documents.html?project='||p.id END url,n.read_at read_at,
 v.actor_id actor_id,
 CASE WHEN n.audience<>'finance' THEN 1
  WHEN EXISTS(SELECT 1 FROM budget_role_assignments f WHERE f.role_key IN ${FINANCE_ROLE_SQL} AND f.department='' AND f.user_id=n.user_id) THEN 1
  WHEN NOT EXISTS(SELECT 1 FROM budget_role_assignments f WHERE f.role_key IN ${FINANCE_ROLE_SQL} AND f.department='') AND ?=1 THEN 1 ELSE 0 END line_ok
 FROM project_notifications n JOIN project_workflow_events v ON v.token=n.event_token JOIN projects p ON p.id=v.project_id WHERE n.user_id=?
 UNION ALL
 SELECT 'balance:'||r.id||':'||r.status,'คำขอแก้ยอด: '||p.name,
 CASE r.status WHEN 'pending' THEN 'มีคำขอแก้ไขยอดใช้ไปแล้ว รอพิจารณา' WHEN 'approved' THEN 'อนุมัติและปรับยอดใช้ไปแล้วเรียบร้อย' ELSE 'คำขอแก้ไขยอดไม่ได้รับอนุมัติ' END,
 COALESCE(r.reviewed_at,r.created_at),CASE WHEN ?=1 THEN '/dashboard.html' ELSE '/department.html?dept='||COALESCE(p.management_area,p.department) END,n.read_at,CASE WHEN r.status='pending' THEN r.requested_by ELSE r.reviewed_by END,1
 FROM project_balance_notifications n JOIN project_balance_requests r ON r.id=n.request_id JOIN projects p ON p.id=r.project_id WHERE n.user_id=?
 UNION ALL
 SELECT 'leave:'||r.id||':'||CASE WHEN r.status<>'pending' THEN r.status WHEN r.workflow_stage='forwarded' THEN CASE WHEN r.reviewer_at IS NOT NULL THEN 'reviewed' ELSE 'forwarded' END ELSE 'pending' END,'การลา: '||u.full_name,
 CASE r.status WHEN 'pending' THEN CASE WHEN r.workflow_stage='forwarded' THEN CASE WHEN r.reviewer_at IS NOT NULL THEN 'รองผู้บริหารบันทึกความเห็นแล้ว รอคำสั่งผู้อำนวยการ' ELSE 'หัวหน้าฝ่ายบุคลากรส่งใบลาให้พิจารณา' END ELSE 'มีคำขอลารอหัวหน้าฝ่ายบุคลากรรับทราบ' END WHEN 'approved' THEN 'คำขอลาได้รับอนุมัติแล้ว' ELSE 'คำขอลาไม่ได้รับอนุมัติ' END,
 COALESCE(r.approved_at,r.reviewer_at,r.forwarded_at,r.created_at),'/leave.html?request='||r.id,NULL,NULL,
 CASE WHEN (?=1 AND r.status='pending' AND r.workflow_stage='submitted') OR (r.user_id=? AND r.status IN ('approved','rejected')) OR ${earlyDeputy} OR
 (?=1 AND r.status='pending' AND r.workflow_stage='forwarded' AND EXISTS(
 SELECT 1 FROM leave_reviewers v WHERE v.leave_id=r.id AND v.user_id=? AND ((v.kind='deputy' AND r.reviewer_at IS NULL) OR (v.kind='director' AND r.reviewer_at IS NOT NULL)))) THEN 1 ELSE 0 END
 FROM leave_requests r JOIN users u ON u.id=r.user_id WHERE
 (?=1 AND r.status='pending') OR (?=1 AND r.status='pending' AND r.workflow_stage='submitted') OR ${earlyDeputy} OR
 (r.user_id=? AND r.status IN ('approved','rejected')) OR
 (?=1 AND r.status='pending' AND r.workflow_stage='forwarded' AND EXISTS(
 SELECT 1 FROM leave_reviewers v WHERE v.leave_id=r.id AND v.user_id=? AND (v.kind='director' OR r.reviewer_at IS NULL)))
 UNION ALL
 SELECT 'task:'||t.id,'งานที่ได้รับมอบหมาย',t.title,t.created_at,'/tasks.html',NULL,t.created_by,1
 FROM tasks t JOIN task_assignees a ON a.task_id=t.id WHERE a.user_id=? AND a.status<>'done' AND t.status='open'
 ), secondary_messages AS (
 SELECT 'approval:'||a.id,'เอกสารเบิกจ่ายรอลงนาม',p.name||' · '||a.step_label,a.updated_at,'/budget.html?view=requests',NULL,NULL,1
 FROM budget_request_approvals a JOIN project_expenses e ON e.id=a.expense_id JOIN projects p ON p.id=e.project_id JOIN (SELECT ? uid) me
 WHERE a.status='pending' AND e.status='pending' AND (a.assigned_user_id=me.uid OR (a.step_key='finance_review' AND e.created_by<>me.uid
  AND EXISTS(SELECT 1 FROM budget_role_assignments f WHERE f.role_key IN ${FINANCE_ROLE_SQL} AND f.department='' AND f.user_id=me.uid)))
 UNION ALL
 SELECT 'student-delete:'||d.id||':'||d.status,'ขอลบข้อมูลนักเรียนถาวร: '||d.student_name,
 CASE d.status WHEN 'pending' THEN 'รอผู้อำนวยการพิจารณา — '||d.reason WHEN 'approved' THEN 'ผู้อำนวยการอนุมัติ ลบข้อมูลแล้ว' ELSE 'ผู้อำนวยการไม่อนุมัติการลบ' END,
 COALESCE(d.decided_at,d.requested_at),'/students.html?delete_requests=1',NULL,CASE WHEN d.status='pending' THEN d.requested_by ELSE NULL END,1
 FROM student_delete_requests d WHERE (?=1 AND d.status='pending') OR (d.requested_by=? AND d.status IN ('approved','rejected'))
 UNION ALL
 SELECT 'procurement:'||n.id,'จัดซื้อจัดจ้าง: '||c.subject,n.message,n.created_at,'/procurement.html?case='||c.id,n.read_at,NULL,1
 FROM procurement_notifications n JOIN procurement_cases c ON c.id=n.case_id WHERE n.user_id=?
 ${extra.map(x=>'UNION ALL\n '+x).join('\n ')}
 )${tertiary}, messages AS (SELECT * FROM primary_messages UNION ALL SELECT * FROM secondary_messages${supervision?' UNION ALL SELECT * FROM tertiary_messages':''}
 ) SELECT m.* FROM messages m WHERE (m.read_at IS NULL AND NOT EXISTS(SELECT 1 FROM notification_reads r WHERE r.user_id=? AND r.message_key=m.message_key))${forLine?" OR m.message_key LIKE 'leave:%'":''}`;
 const executive=['executive','superadmin'].includes(user.role)?1:0;
 return {sql,values:[user.role==='superadmin'?1:0,user.id,isAdmin(user)?1:0,user.id,
 personnelHead?1:0,user.id,executive,user.id,executive,user.id,
 user.role==='superadmin'?1:0,personnelHead?1:0,executive,user.id,user.id,executive,user.id,
 user.id,user.id,director?1:0,user.id,user.id,...extraValues,...tertiaryValues,user.id]};
}
// รายการแจ้งเตือนที่ยังไม่อ่านของผู้ใช้หนึ่งคน (ใช้ร่วมกับการส่ง LINE)
export async function unreadNotificationsFor(env,user,limit=50,{forLine=false}={}){
 await ensure(env);await ensureProcurementSchema(env);await ensureLeaveData(env);await ensureStudentDeletionSchema(env);
 const q=feed(env,user,await isPersonnelHead(env,user),await isSchoolDirector(env,user),await optionalFeedTables(env),forLine);
 const {results}=await env.DB.prepare(`SELECT * FROM (${q.sql}) ORDER BY created_at DESC,message_key DESC LIMIT ?`).bind(...q.values,limit).all();
 return results.map(({read_at,...r})=>r);
}
export async function handleNotifications(request,env,pathname,method){
 if(pathname!=='/api/notifications'&&pathname!=='/api/notifications/read')return null;
 const user=await getCurrentUser(request,env);if(!user?.role)return jsonResponse({error:'กรุณาเข้าสู่ระบบ'},401);
 await ensure(env);await ensureProcurementSchema(env);await ensureLeaveData(env);await ensureStudentDeletionSchema(env);const q=feed(env,user,await isPersonnelHead(env,user),await isSchoolDirector(env,user),await optionalFeedTables(env));
 if(pathname==='/api/notifications'&&method==='GET'){
  await ensureFinanceQueueNotifications(env,user);
  const {results}=await env.DB.prepare(`SELECT *,COUNT(*) OVER() unread_count FROM (${q.sql}) ORDER BY created_at DESC,message_key DESC LIMIT 50`).bind(...q.values).all();
  return jsonResponse({unread_count:Number(results[0]?.unread_count||0),notifications:results.map(({unread_count,read_at,actor_id,line_ok,...r})=>r)},200,{'Cache-Control':'no-store'});
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
   ...((await optionalFeedTables(env)).has('security_notifications')?[env.DB.prepare(`UPDATE security_notifications SET read_at=datetime('now') WHERE user_id=? AND read_at IS NULL
    AND EXISTS(SELECT 1 FROM notification_reads r WHERE r.user_id=? AND r.message_key='security:'||security_notifications.id)`).bind(user.id,user.id)]:[]),
   ...((await optionalFeedTables(env)).has('supervision_notifications')?[env.DB.prepare(`UPDATE supervision_notifications SET read_at=datetime('now') WHERE user_id=? AND read_at IS NULL
    AND EXISTS(SELECT 1 FROM notification_reads r WHERE r.user_id=? AND r.message_key='supervision:'||supervision_notifications.id)`).bind(user.id,user.id)]:[]),
   env.DB.prepare(`UPDATE procurement_notifications SET read_at=datetime('now') WHERE user_id=? AND read_at IS NULL
    AND EXISTS(SELECT 1 FROM notification_reads r WHERE r.user_id=? AND r.message_key='procurement:'||procurement_notifications.id)`).bind(user.id,user.id),
   env.DB.prepare(`UPDATE project_balance_notifications SET read_at=datetime('now') WHERE user_id=? AND read_at IS NULL
    AND EXISTS(SELECT 1 FROM project_balance_requests b JOIN notification_reads r ON r.message_key='balance:'||b.id||':'||b.status
      WHERE b.id=project_balance_notifications.request_id AND r.user_id=?)`).bind(user.id,user.id),
  ]);
  return jsonResponse({ok:true,read_count:Number(result.meta.changes)});
 }
 return jsonResponse({error:'Method not allowed'},405);
}
