import {isAdmin} from './auth.js';
import {belongsToDepartment} from '../routes/department-staff.js';
export async function canManageTimetable(env,user){
 if(isAdmin(user))return true;
 if(!user||!['teacher','staff'].includes(user.role))return false;
 const {results}=await env.DB.prepare(`SELECT p.id,p.departments FROM personnel_records p JOIN personnel_accounts a ON a.personnel_id=p.id WHERE a.user_id=? AND p.status='active'`).bind(user.id).all();
 if(results.some(p=>belongsToDepartment(p.departments,'academic')))return true;
 const table=await env.DB.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='department_staff'").first();
 if(!table)return false;
 for(const p of results)if(await env.DB.prepare("SELECT personnel_id FROM department_staff WHERE department='academic' AND personnel_id=?").bind(p.id).first())return true;
 return false;
}
