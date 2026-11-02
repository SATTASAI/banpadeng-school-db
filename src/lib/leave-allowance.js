export const leaveTypes=['general','lenient'];
export const quotaGroupSql="CASE WHEN COALESCE(leave_subtype,leave_type)='lenient' THEN 'lenient' ELSE 'general' END";
export async function leavePeriod(env,date){
 const {results}=await env.DB.prepare(`SELECT t.id,t.academic_year_id,t.name,t.term_number,y.year_be,t.start_date AS "from",t.end_date AS "to"
 FROM academic_terms t JOIN academic_years y ON y.id=t.academic_year_id
 WHERE ? BETWEEN t.start_date AND t.end_date ORDER BY t.id`).bind(date).all();
 // A missing/overlapping calendar cannot silently grant a new quota.
 return results.length===1?results[0]:null;
}
// Count the same personnel record across linked accounts. Pending requests reserve a turn.
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
  return {...limit,approved,pending,remaining:limit.max_count===null?null:Math.max(0,limit.max_count-approved-pending)};
 })};
}
