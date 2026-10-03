import {ensurePersonnelData} from './personnel-data.js';
import {belongsToDepartment,isSchoolExecutive} from '../routes/department-staff.js';
export async function canManageSubstitutes(env,user){
 if(!user || !['teacher','staff','superadmin'].includes(user.role))return false;
 await ensurePersonnelData(env);
 const {results:people}=await env.DB.prepare(`SELECT p.id,p.departments,p.personnel_type,p.position
   FROM personnel_records p JOIN personnel_accounts a ON a.personnel_id=p.id
   WHERE a.user_id=? AND p.status='active'`).bind(user.id).all();
 const eligible=people.filter(p=>!isSchoolExecutive({...p,role:user.role}));
 if(eligible.some(p=>belongsToDepartment(p.departments,'personnel')))return true;
 if(!eligible.length)return false;
 const exists=await env.DB.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='department_staff'").first();
 if(!exists)return false;
 for(const person of eligible){
   if(await env.DB.prepare("SELECT personnel_id FROM department_staff WHERE department='personnel' AND personnel_id=?").bind(person.id).first())return true;
 }
 return false;
}
