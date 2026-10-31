// เมนูฝ่ายงานที่ผู้ใช้มองเห็น: เห็นเฉพาะฝ่ายที่ตนสังกัด
// superadmin / ผู้บริหาร (role executive หรือตำแหน่ง ผอ./รอง ผอ.) เห็นทุกฝ่าย
// ครูที่สอนอนุบาล (มีวิชาสอนชั้นอนุบาล / เป็นครูประจำชั้นอนุบาล / อยู่ในฝ่ายปฐมวัย) เห็นฝ่ายปฐมวัยเพิ่ม
// ซ่อนเฉพาะเมนู ไม่ได้กันการเปิดหน้าโดยตรง
import {getCurrentUser,jsonResponse,isAdmin} from '../lib/auth.js';
import {DEPARTMENTS,ensureDepartmentStaff,belongsToDepartment,isSchoolExecutive} from './department-staff.js';
import {supervisionPermissions} from './supervision.js';
import {evaluationPermissions} from '../evaluation/permissions.js';

const ALL=Object.keys(DEPARTMENTS);
const isKindergarten=grade=>/^\s*(อ\.|อนุบาล|K\d|kg)/i.test(String(grade||''));

async function tableSet(env,names){
 const list=names.map(()=>'?').join(',');
 const {results}=await env.DB.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name IN (${list})`).bind(...names).all().catch(()=>({results:[]}));
 return new Set((results||[]).map(r=>r.name));
}

async function teachesKindergarten(env,userId){
 const t=await tableSet(env,['gr_courses','gr_subjects','gr_course_teachers','gr_homerooms','learner_class_assignments']);
 if(t.has('gr_courses')&&t.has('gr_subjects')&&t.has('gr_course_teachers')){
  const {results}=await env.DB.prepare(`SELECT DISTINCT s.grade_level FROM gr_course_teachers ct JOIN gr_courses c ON c.id=ct.course_id
   JOIN gr_subjects s ON s.id=c.subject_id JOIN academic_years y ON y.id=s.academic_year_id WHERE ct.user_id=? AND y.status='active'`).bind(userId).all().catch(()=>({results:[]}));
  if((results||[]).some(r=>isKindergarten(r.grade_level)))return true;
 }
 if(t.has('gr_homerooms')){
  const {results}=await env.DB.prepare(`SELECT h.grade_level FROM gr_homerooms h JOIN academic_years y ON y.id=h.academic_year_id
   WHERE y.status='active' AND h.user_id=?`).bind(userId).all().catch(()=>({results:[]}));
  if((results||[]).some(r=>isKindergarten(r.grade_level)))return true;
 }
 if(t.has('learner_class_assignments')){
  const {results}=await env.DB.prepare(`SELECT a.grade_level FROM learner_class_assignments a JOIN academic_terms tm ON tm.id=a.academic_term_id
   WHERE tm.status='active' AND a.teacher_user_id=?`).bind(userId).all().catch(()=>({results:[]}));
  if((results||[]).some(r=>isKindergarten(r.grade_level)))return true;
 }
 return false;
}

export async function visibleDepartments(env,user){
 if(!user?.role)return {all:false,departments:[]};
 // viewer = บัญชีผู้ชมภายนอก (ดูอย่างเดียว) คงเห็นทุกฝ่ายตามเดิม
 if(user.role==='superadmin'||user.role==='viewer'||isAdmin(user))return {all:true,departments:ALL};
 await ensureDepartmentStaff(env);
 const {results:people}=await env.DB.prepare(`SELECT p.id,p.departments,p.position,p.personnel_type FROM personnel_records p
  WHERE p.status='active' AND (p.user_id=? OR p.id IN (SELECT personnel_id FROM personnel_accounts WHERE user_id=?))`).bind(user.id,user.id).all()
  .catch(()=>env.DB.prepare(`SELECT p.id,p.departments,p.position,p.personnel_type FROM personnel_records p WHERE p.status='active' AND p.user_id=?`).bind(user.id).all());
 if((people||[]).some(p=>isSchoolExecutive({...p,role:user.role})))return {all:true,departments:ALL};
 const set=new Set();
 const ids=(people||[]).map(p=>p.id);
 if(ids.length){
  const {results}=await env.DB.prepare(`SELECT DISTINCT department FROM department_staff WHERE personnel_id IN (${ids.map(()=>'?').join(',')})`).bind(...ids).all();
  for(const r of results||[])set.add(r.department);
 }
 for(const p of people||[])for(const d of ALL)if(belongsToDepartment(p.departments,d))set.add(d);
 if(!set.has('early_childhood')&&await teachesKindergarten(env,user.id))set.add('early_childhood');
 // ผู้ประเมินนิเทศที่ได้รับแต่งตั้ง และหัวหน้าฝ่าย (ประเมินผลการปฏิบัติงาน) ยังต้องเข้าเมนูย่อยใต้ฝ่ายบริหาร (เมนูย่อยกรองสิทธิ์ซ้ำอีกชั้น)
 if(!set.has('administration')){
  const [sp,ep]=await Promise.all([supervisionPermissions(env,user).catch(()=>({})),evaluationPermissions(env,user).catch(()=>({}))]);
  if(sp.evaluate||ep.access)set.add('administration');
 }
 return {all:false,departments:ALL.filter(d=>set.has(d))};
}

export async function handleNavVisibilityRoute(request,env,pathname,method){
 if(pathname!=='/api/navigation/departments')return null;
 if(method!=='GET')return jsonResponse({error:'Method not allowed'},405);
 const user=await getCurrentUser(request,env);
 if(!user?.role)return jsonResponse({error:'กรุณาเข้าสู่ระบบ'},401);
 return jsonResponse(await visibleDepartments(env,user));
}
