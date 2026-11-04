import {ensureDepartmentStaff,belongsToDepartment} from '../routes/department-staff.js';

export async function isPersonnelHead(env,user){
 if(!user?.role)return false;
 await ensureDepartmentStaff(env);
 const head=await env.DB.prepare(`SELECT 1 FROM department_staff d
 JOIN personnel_records p ON p.id=d.personnel_id AND p.status='active'
 JOIN personnel_accounts a ON a.personnel_id=p.id
 WHERE d.department='personnel' AND d.is_head=1 AND a.user_id=? LIMIT 1`).bind(user.id).first();
 return !!head;
}

// ครูฝ่ายบุคคล (สมาชิกฝ่ายบุคคลทุกคน รวมหัวหน้า) — ดูคำร้องขอลาทั้งหมดได้อย่างเดียว
export async function isPersonnelMember(env,user){
 if(!user?.role)return false;
 await ensureDepartmentStaff(env);
 const {results}=await env.DB.prepare(`SELECT p.id,p.departments,
  EXISTS(SELECT 1 FROM department_staff d WHERE d.department='personnel' AND d.personnel_id=p.id) in_staff
  FROM personnel_records p JOIN personnel_accounts a ON a.personnel_id=p.id
  WHERE a.user_id=? AND p.status='active'`).bind(user.id).all();
 return results.some(p=>Number(p.in_staff)===1||belongsToDepartment(p.departments,'personnel'));
}
