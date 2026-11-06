// งานค้าง (จุดแดง): นับงานที่ยังรอผู้ใช้คนนี้ดำเนินการ จุดแดงค้างจนงานเสร็จ ไม่หายเมื่อเปิดดู
// แต่ละรายการเห็นเฉพาะผู้มีสิทธิ์จัดการงานนั้น · ตารางที่ยังไม่ถูกสร้างจะถูกข้าม
import {getCurrentUser,isAdmin,jsonResponse} from '../lib/auth.js';
import {isPersonnelHead} from '../lib/leave-permissions.js';
import {isSchoolDirector} from './student-deletion.js';
import {budgetDirectorIds,canManageProjectFinance} from './project-workflow.js';
import {supervisionPermissions} from './supervision.js';
import {FINANCE_ROLE_SQL} from '../lib/finance-roles.js';

const REVIEW_STEPS="('dept_head_review','dept_deputy_review','budget_head_review','budget_deputy_review')";

async function count(env,sql,...values){
 try{const row=await env.DB.prepare(sql).bind(...values).first();return Number(row?.n||0);}
 catch(error){if(/no such (table|column)/i.test(String(error?.message)))return 0;throw error;}
}

export async function pendingWorkFor(env,user){
 const uid=user.id,admin=isAdmin(user),superadmin=user.role==='superadmin';
 const [head,director,budgetDirectors,finance,supervision]=await Promise.all([
  isPersonnelHead(env,user).catch(()=>false),isSchoolDirector(env,user).catch(()=>false),
  budgetDirectorIds(env).catch(()=>[]),canManageProjectFinance(env,user).catch(()=>false),
  supervisionPermissions(env,user).catch(()=>({}))]);
 const jobs=[];
 const add=(key,label,url,promise)=>jobs.push(promise.then(n=>({key,label,url,count:n})));

 // ใบลา: ค้างจนกว่า ผอ. อนุมัติ/ไม่อนุมัติ
 if(head||superadmin||director)add('leave','ใบลารออนุมัติ','/leave.html?view=approval',
  count(env,"SELECT COUNT(*) n FROM leave_requests WHERE status='pending' AND user_id<>?",uid));
 else if(user.role==='executive')add('leave','ใบลารออนุมัติ','/leave.html?view=approval',
  count(env,`SELECT COUNT(*) n FROM leave_requests r WHERE r.status='pending' AND r.workflow_stage='forwarded' AND r.user_id<>?
   AND EXISTS(SELECT 1 FROM leave_reviewers v WHERE v.leave_id=r.id AND v.user_id=? AND v.kind IN ('director','deputy'))`,uid,uid));

 // งานที่ได้รับมอบหมาย
 add('tasks','งานที่ได้รับมอบหมาย','/tasks.html',
  count(env,"SELECT COUNT(*) n FROM tasks t JOIN task_assignees a ON a.task_id=t.id WHERE a.user_id=? AND a.status<>'done' AND t.status='open'",uid));

 // คำขอเบิกจ่าย (แบบใหม่): รอผู้ตรวจลงนาม / รอ ผอ. อนุมัติ / รอฝ่ายการเงินรับเรื่อง
 add('expense-review','คำขอเบิกจ่ายรอลงนาม','/project-documents.html',
  count(env,`SELECT COUNT(DISTINCT e.id) n FROM project_expenses e JOIN project_expense_signoffs s ON s.expense_id=e.id
   WHERE e.workflow_version=2 AND e.status='pending' AND e.current_step IN ${REVIEW_STEPS} AND s.status='pending' AND s.assigned_user_id=?`,uid));
 if(budgetDirectors.includes(Number(uid)))add('expense-director','คำขอเบิกจ่ายรอ ผอ. อนุมัติ','/project-documents.html',
  count(env,"SELECT COUNT(*) n FROM project_expenses WHERE workflow_version=2 AND status='pending' AND current_step='director_approval' AND created_by<>?",uid));
 if(finance)add('finance-queue','คำขอเบิกจ่ายรอฝ่ายการเงิน','/finance-register.html',
  count(env,"SELECT COUNT(*) n FROM project_expenses WHERE workflow_version=2 AND status='pending' AND current_step IN ('finance_queue','finance_processing')"));

 // คำขอใช้งบ (แบบลงนามเดิม)
 add('budget-approval','คำขอใช้งบรอลงนาม','/budget.html?view=requests',
  count(env,`SELECT COUNT(*) n FROM budget_request_approvals a JOIN project_expenses e ON e.id=a.expense_id
   WHERE a.status='pending' AND e.status='pending' AND (a.assigned_user_id=? OR (a.step_key='finance_review' AND e.created_by<>?
   AND EXISTS(SELECT 1 FROM budget_role_assignments f WHERE f.role_key IN ${FINANCE_ROLE_SQL} AND f.department='' AND f.user_id=?)))`,uid,uid,uid));

 // คำขอแก้ไขยอดใช้ไปแล้ว (พิจารณาที่หน้าภาพรวม)
 if(admin)add('balance','คำขอแก้ไขยอดรอพิจารณา','/dashboard.html',
  count(env,"SELECT COUNT(*) n FROM project_balance_requests WHERE status='pending'"));

 // นิเทศ: รอผู้บริหารรับนิเทศ
 if(supervision.evaluate)add('supervision','คำขอรับนิเทศรอรับ','/supervision-admin.html',
  count(env,"SELECT COUNT(*) n FROM supervision_requests WHERE status='pending' AND teacher_user_id<>?",uid));

 // ผู้ใช้รอกำหนดสิทธิ์
 if(admin)add('users','ผู้ใช้รอกำหนดสิทธิ์','/admin-users.html',
  count(env,"SELECT COUNT(*) n FROM users WHERE (role IS NULL OR role='') AND deleted_at IS NULL"));

 // นักเรียน: ขอลบถาวร (ผอ.) · ย้ายเข้า-ออกรอพิจารณา
 if(director)add('student-delete','คำขอลบข้อมูลนักเรียน','/students.html?delete_requests=1',
  count(env,"SELECT COUNT(*) n FROM student_delete_requests WHERE status='pending'"));
 if(admin)add('transfers','คำขอย้ายเข้า-ออกรอพิจารณา','/dmcreport/',
  count(env,"SELECT COUNT(*) n FROM student_transfer_requests WHERE status IN ('pending','needs_documents')"));

 // แจ้งซ่อม: หัวหน้าฝ่ายบริหารทั่วไป (รอมอบหมาย/รอตรวจรับ) · ผู้รับมอบหมาย (กำลังซ่อม)
 add('maintenance','งานแจ้งซ่อมค้าง','/maintenance.html',
  count(env,`SELECT COUNT(*) n FROM maintenance_requests m JOIN (SELECT ? uid,EXISTS(SELECT 1 FROM department_staff d JOIN personnel_records p ON p.id=d.personnel_id AND p.status='active'
   JOIN personnel_accounts a ON a.personnel_id=p.id WHERE d.department='general' AND d.is_head=1 AND a.user_id=?) head) me
   WHERE (me.head=1 AND m.status IN ('reported','completed')) OR (m.status='assigned' AND m.assigned_to=me.uid)`,uid,uid));

 // หนังสือราชการที่มอบหมายให้และยังไม่เสร็จ
 add('correspondence','หนังสือราชการรอดำเนินการ','/correspondence.html',
  count(env,"SELECT COUNT(*) n FROM correspondence_records WHERE assigned_to=? AND created_by<>? AND status NOT IN ('completed','archived')",uid,uid));

 // พัสดุ: ยืมเกินกำหนดยังไม่คืน
 if(admin||user.role==='staff')add('inventory','พัสดุยืมเกินกำหนด','/inventory.html',
  count(env,`SELECT COUNT(*) n FROM inventory_transactions b WHERE b.transaction_type='borrow' AND b.due_date IS NOT NULL AND b.due_date<date('now','+7 hours')
   AND b.quantity>COALESCE((SELECT SUM(r.quantity) FROM inventory_transactions r WHERE r.transaction_type='return' AND r.related_transaction_id=b.id),0)`));

 // ธนาคารโรงเรียน: คำขอกู้รออนุมัติ
 if(admin)add('bank-loan','คำขอกู้รออนุมัติ','/school-bank.html',
  count(env,"SELECT COUNT(*) n FROM school_bank_loans WHERE status='requested'"));

 return (await Promise.all(jobs)).filter(item=>item.count>0);
}

export async function handlePendingWork(request,env,pathname,method){
 if(pathname!=='/api/pending-work')return null;
 if(method!=='GET')return jsonResponse({error:'Method not allowed'},405);
 const user=await getCurrentUser(request,env);
 if(!user?.role||user.role==='viewer')return jsonResponse({items:[]},200,{'Cache-Control':'no-store'});
 return jsonResponse({items:await pendingWorkFor(env,user)},200,{'Cache-Control':'no-store'});
}
