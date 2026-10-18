import {getCurrentUser,jsonResponse} from '../lib/auth.js';
import {evaluationPermissions} from './permissions.js';
export async function handleEvaluationRead(request,env,path,method){
 if(method!=='GET'||!['/api/evaluation/results','/api/evaluation/permissions'].includes(path))return null;
 const user=await getCurrentUser(request,env),permissions=await evaluationPermissions(env,user);
 const reply=(data,status=200)=>jsonResponse(data,status,{'Cache-Control':'private, no-store'});
 if(path.endsWith('/permissions'))return reply({...permissions,user:user?{id:user.id,full_name:user.full_name}:null,guest:null});
 if(!user?.role)return reply({error:'กรุณาเข้าสู่ระบบ'},401);
 try{
 const rows=await env.DB.prepare(`SELECT c.id,c.personnel_id,p.full_name,c.title,c.fiscal_year,c.cycle,c.rank,c.published_at,c.result_json,t.kind,t.name AS template_name,t.reference
 FROM evaluation_cases c JOIN personnel_records p ON p.id=c.personnel_id JOIN evaluation_templates t ON t.id=c.template_id
 WHERE c.state='published' ${permissions.access?'':`AND EXISTS(SELECT 1 FROM personnel_accounts a WHERE a.personnel_id=c.personnel_id AND a.user_id=?)`}
 ORDER BY c.fiscal_year DESC,c.published_at DESC,c.id DESC`).bind(...(permissions.access?[]:[user.id])).all();
 return reply({results:rows.results.map(({result_json,...r})=>({...r,result:JSON.parse(result_json)})),can_evaluate:permissions.access,source:'evaluatesystem'});
 }catch(e){if(/no such table: evaluation_/.test(String(e.message)))return reply({results:[],can_evaluate:permissions.access,source:'evaluatesystem'});throw e;}
}
