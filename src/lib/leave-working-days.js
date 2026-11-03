import {governmentHolidaysBetween} from './thai-holidays.js';

// Calendar data remains owned by grades. Activities are working days.
export async function leaveCalendar(env) {
 const {results:columns}=await env.DB.prepare('PRAGMA table_info(gr_holidays)').all();
 if(!columns.length)return [];
 const kind=columns.some(c=>c.name==='kind');
 const {results}=await env.DB.prepare(`SELECT DISTINCT holiday_date FROM gr_holidays${kind?" WHERE COALESCE(kind,'holiday')<>'activity'":''}`).all();
 return results.map(r=>r.holiday_date);
}
const governmentCache=new Map();
export function workingDays(start,end,holidays=[]) {
 if(!start||!end||end<start)return 0;
 const off=new Set(holidays);
 for(let y=Number(start.slice(0,4));y<=Number(end.slice(0,4));y++){
  if(!governmentCache.has(y))governmentCache.set(y,governmentHolidaysBetween(`${y}-01-01`,`${y}-12-31`).map(h=>h.date));
  for(const date of governmentCache.get(y))off.add(date);
 }
 let count=0;
 for(let d=new Date(start+'T00:00:00Z');d.toISOString().slice(0,10)<=end;d.setUTCDate(d.getUTCDate()+1)){
  if(d.getUTCDay()!==0&&d.getUTCDay()!==6&&!off.has(d.toISOString().slice(0,10)))count++;
 }
 return count;
}
// Preserve an explicitly reduced/half-day request, cap legacy calendar-day totals.
// Stored history is never rewritten, so later calendar edits cannot subtract twice.
export function effectiveLeaveDays(row,holidays=[],from=row.start_date,to=row.end_date) {
 const total=workingDays(row.start_date,row.end_date,holidays);
 if(!total)return 0;
 const stored=row.leave_days==null?total:Number(row.leave_days);
 const days=Math.max(0,Math.min(stored,total-(stored%1)));
 const overlap=workingDays(row.start_date>from?row.start_date:from,row.end_date<to?row.end_date:to,holidays);
 return days*overlap/total;
}
export async function normalizeLeaves(env,rows) {
 const holidays=await leaveCalendar(env);
 return rows.map(row=>({...row,leave_days:effectiveLeaveDays(row,holidays)}));
}
