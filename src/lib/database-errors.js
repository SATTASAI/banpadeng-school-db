import {jsonResponse} from './auth.js';
// D1 reports provider failures through Error.cause in the Worker binding.
export function databaseQuotaResponse(error,now=new Date()){
 const seen=new Set(),messages=[];for(let e=error;e&&!seen.has(e);e=e.cause){seen.add(e);messages.push(String(e.message||e));}
 const message=messages.join(' ').toLowerCase();
 const kind=message.includes('daily row read limit')?'read':message.includes('daily row write limit')?'write':null;
 if(!kind)return null;
 const reset=new Date(now);reset.setUTCHours(24,0,0,0);
 const date=new Intl.DateTimeFormat('th-TH',{timeZone:'Asia/Bangkok',day:'numeric',month:'long',year:'numeric'}).format(reset);
 return jsonResponse({error:`โควต้า${kind==='read'?'อ่าน':'เขียน'}ข้อมูลรายวันของฐานข้อมูล Cloudflare D1 แบบฟรีครบแล้ว ระบบจะเริ่มใช้งานได้อีกครั้งวันที่ ${date} เวลา 07:00 น. (เวลาไทย) หากต้องการใช้งานทันที ผู้ดูแลต้องอัปเกรดแพ็กเกจ Cloudflare`,code:'DATABASE_DAILY_QUOTA_EXCEEDED',quota_kind:kind,reset_at:reset.toISOString()},503,{'Cache-Control':'no-store','Retry-After':String(Math.max(1,Math.ceil((reset-now)/1000)))});
}
