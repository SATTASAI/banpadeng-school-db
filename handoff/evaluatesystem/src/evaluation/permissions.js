export async function evaluationPermissions(env,user){
 if(!user?.role)return {access:false,manage:false,criteria:false,finalize:false};
 const {results:heads}=await env.DB.prepare(`SELECT d.department FROM department_staff d
 JOIN personnel_records p ON p.id=d.personnel_id AND p.status='active'
 JOIN personnel_accounts a ON a.personnel_id=p.id WHERE d.is_head=1 AND a.user_id=?`).bind(user.id).all();
 const executive=user.role==='executive',admin=user.role==='superadmin',personnel=heads.some(h=>h.department==='personnel');
 return {access:executive||admin||heads.length>0,manage:executive||admin||personnel,criteria:admin||personnel,finalize:executive};
}
