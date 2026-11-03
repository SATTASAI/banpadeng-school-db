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
// ลาคลอดนับวันต่อเนื่องรวมวันหยุดตามระเบียบ ประเภทอื่นนับเฉพาะวันทำงาน
export function calendarDaysBetween(start,end){
 if(!start||!end||end<start)return 0;
 return Math.round((Date.parse(end+'T00:00:00Z')-Date.parse(start+'T00:00:00Z'))/86400000)+1;
}
export function leaveSpanDays(type,start,end,holidays=[]){
 return type==='maternity'?calendarDaysBetween(start,end):workingDays(start,end,holidays);
}
const rowType=row=>row.leave_subtype||row.leave_type;
// Pre-freeze rule: cap stored totals to the span (legacy rows stored calendar days).
// Used once by the freeze migration; afterwards stored leave_days is the source of truth.
export function legacyCappedDays(row,holidays=[]){
 const total=leaveSpanDays(rowType(row),row.start_date,row.end_date,holidays);
 if(!total)return 0;
 const stored=row.leave_days==null?total:Number(row.leave_days);
 return Math.max(0,Math.min(stored,total-(stored%1)));
}
// Stored leave_days is frozen at submission/edit, so later calendar edits never change
// approved history. Only a leave that straddles the requested range is prorated.
export function effectiveLeaveDays(row,holidays=[],from=row.start_date,to=row.end_date) {
 const type=rowType(row),a=row.start_date>from?row.start_date:from,b=row.end_date<to?row.end_date:to;
 if(b<a)return 0;
 const total=leaveSpanDays(type,row.start_date,row.end_date,holidays);
 const stored=row.leave_days==null?total:Number(row.leave_days);
 if(a===row.start_date&&b===row.end_date)return stored;
 const span=total||calendarDaysBetween(row.start_date,row.end_date);
 const overlap=total?leaveSpanDays(type,a,b,holidays):calendarDaysBetween(a,b);
 return span?stored*overlap/span:0;
}
export async function normalizeLeaves(env,rows) {
 const holidays=await leaveCalendar(env);
 return rows.map(row=>({...row,leave_days:effectiveLeaveDays(row,holidays)}));
}
export async function leaveFiscalSummary(env,rows,date=new Date(Date.now()+7*3600e3).toISOString().slice(0,10)){
 const year=Number(date.slice(0,4))+(date.slice(5,7)>='10'?1:0),from=`${year-1}-10-01`,to=`${year}-09-30`;
 const holidays=await leaveCalendar(env),real={times:0,days:0},lenient={times:0,days:0};
 for(const row of rows){
  if(row.status!=='approved'||row.end_date<from||row.start_date>to)continue;
  const group=(row.leave_subtype||row.leave_type)==='lenient'?lenient:real;
  // One leave = one time, counted in the period of its start date; days follow the overlap.
  if(row.start_date>=from&&row.start_date<=to)group.times++;group.days+=effectiveLeaveDays(row,holidays,from,to);
 }
 real.days=Math.round(real.days*100)/100;lenient.days=Math.round(lenient.days*100)/100;
 return {from,to,real,lenient};
}
