export const leaveTypes=['general','lenient'];
// These types do not consume the school's general personal/other leave turn quota.
export const quotaGroupSql="CASE WHEN COALESCE(leave_subtype,leave_type)='lenient' THEN 'lenient' WHEN COALESCE(leave_subtype,leave_type) IN ('sick','maternity','paternity') THEN 'exempt' ELSE 'general' END";
export function quotaGroupOf(type){return type==='lenient'?'lenient':['sick','maternity','paternity'].includes(type)?'exempt':'general';}
export async function leavePeriod(env,date){
 const {results}=await env.DB.prepare(`SELECT t.id,t.academic_year_id,t.name,t.term_number,y.year_be,t.start_date AS "from",t.end_date AS "to"
 FROM academic_terms t JOIN academic_years y ON y.id=t.academic_year_id
 WHERE ? BETWEEN t.start_date AND t.end_date ORDER BY t.id`).bind(date).all();
 // A missing/overlapping calendar cannot silently grant a new quota.
 return results.length===1?results[0]:null;
}
// Count the same personnel record across linked accounts. Only approved leaves use a turn;
// the quota is checked again when a leave is approved.
export const ownerClause=`(user_id=? OR user_id IN (SELECT other.user_id FROM personnel_accounts mine
 JOIN personnel_accounts other ON other.personnel_id=mine.personnel_id WHERE mine.user_id=?))`;
export async function leaveLimits(env){
 const {results}=await env.DB.prepare('SELECT leave_type,max_count FROM leave_term_limits').all();
 return leaveTypes.map(leave_type=>({leave_type,max_count:results.find(r=>r.leave_type===leave_type)?.max_count??null}));
}
export async function leaveAllowance(env,userId,date){
 const period=await leavePeriod(env,date),limits=await leaveLimits(env);
 if(!period)return {period:null,types:[],message:'ไม่พบภาคเรียนที่ตรงกับวันเริ่มลา หรือช่วงภาคเรียนซ้อนกัน กรุณาให้ผู้รับผิดชอบตรวจปฏิทินปีการศึกษา'};
 const {results}=await env.DB.prepare(`SELECT ${quotaGroupSql} type,status,COUNT(*) count
 FROM leave_requests WHERE ${ownerClause} AND start_date BETWEEN ? AND ? AND status IN ('approved','pending')
 GROUP BY ${quotaGroupSql},status`).bind(userId,userId,period.from,period.to).all();
 return {period,types:limits.map(limit=>{
  const approved=Number(results.find(r=>r.type===limit.leave_type&&r.status==='approved')?.count||0);
  const pending=Number(results.find(r=>r.type===limit.leave_type&&r.status==='pending')?.count||0);
  return {...limit,approved,pending,remaining:limit.max_count===null?null:Math.max(0,limit.max_count-approved)};
 })};
}
// Approved turns already used in the leave's term, excluding the leave itself.
export async function quotaCheck(env,row,excludeId=null){
 const type=row.leave_subtype||row.leave_type,group=quotaGroupOf(type);
 if(group==='exempt')return {ok:true};
 const period=await leavePeriod(env,row.start_date);if(!period)return {ok:true};
 const limit=(await leaveLimits(env)).find(l=>l.leave_type===group);
 if(!limit||limit.max_count===null)return {ok:true};
 const used=await env.DB.prepare(`SELECT COUNT(*) n FROM leave_requests WHERE ${ownerClause} AND ${quotaGroupSql}=? AND start_date BETWEEN ? AND ? AND status='approved' AND id<>?`)
  .bind(row.user_id,row.user_id,group,period.from,period.to,excludeId??-1).first();
 return {ok:Number(used.n)<limit.max_count,group,period,max:limit.max_count,used:Number(used.n)};
}
