import {ensureDepartmentStaff} from '../routes/department-staff.js';

export async function isPersonnelHead(env,user){
 if(!user?.role)return false;
 await ensureDepartmentStaff(env);
 const head=await env.DB.prepare(`SELECT 1 FROM department_staff d
 JOIN personnel_records p ON p.id=d.personnel_id AND p.status='active'
 JOIN personnel_accounts a ON a.personnel_id=p.id
 WHERE d.department='personnel' AND d.is_head=1 AND a.user_id=? LIMIT 1`).bind(user.id).first();
 return !!head;
}
