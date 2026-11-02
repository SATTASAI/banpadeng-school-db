export const leaveTypes=['sick','personal','maternity','lenient','other'];
export function fiscalPeriod(date){
 const year=Number(date.slice(0,4))-(date.slice(5,7)<'10'?1:0);
 return {from:`${year}-10-01`,to:`${year+1}-09-30`};
}
// Count the same personnel record across linked accounts. Pending requests reserve a turn.
export const ownerClause=`(user_id=? OR user_id IN (SELECT other.user_id FROM personnel_accounts mine
 JOIN personnel_accounts other ON other.personnel_id=mine.personnel_id WHERE mine.user_id=?))`;
export async function leaveLimits(env){
 const {results}=await env.DB.prepare('SELECT leave_type,max_count FROM leave_limits').all();
 return leaveTypes.map(leave_type=>({leave_type,max_count:results.find(r=>r.leave_type===leave_type)?.max_count??null}));
}
export async function leaveAllowance(env,userId,date){
 const period=fiscalPeriod(date),limits=await leaveLimits(env);
 const {results}=await env.DB.prepare(`SELECT COALESCE(leave_subtype,leave_type) type,status,COUNT(*) count
 FROM leave_requests WHERE ${ownerClause} AND start_date BETWEEN ? AND ? AND status IN ('approved','pending')
 GROUP BY COALESCE(leave_subtype,leave_type),status`).bind(userId,userId,period.from,period.to).all();
 return {period,types:limits.map(limit=>{
  const approved=Number(results.find(r=>r.type===limit.leave_type&&r.status==='approved')?.count||0);
  const pending=Number(results.find(r=>r.type===limit.leave_type&&r.status==='pending')?.count||0);
  return {...limit,approved,pending,remaining:limit.max_count===null?null:Math.max(0,limit.max_count-approved-pending)};
 })};
}
