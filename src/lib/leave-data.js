import {ensureDepartmentStaff} from '../routes/department-staff.js';

const ready = new WeakMap();
export function ensureLeaveData(env) {
 if (ready.has(env.DB)) return ready.get(env.DB);
 const promise = (async()=>{
  await ensureDepartmentStaff(env);
  const {results} = await env.DB.prepare('PRAGMA table_info(leave_requests)').all();
  const columns = {
   leave_subtype:'TEXT',workflow_stage:"TEXT NOT NULL DEFAULT 'submitted'",position:'TEXT',request_date:'TEXT',leave_days:'REAL',
   contact_address:'TEXT',contact_phone:'TEXT',acknowledged_by:'INTEGER',acknowledged_at:'TEXT',
   personnel_note:'TEXT',forwarded_by:'INTEGER',forwarded_at:'TEXT',forward_token:'TEXT',deputy_personnel_id:'INTEGER',
   deputy_name:'TEXT',deputy_position:'TEXT',director_name:'TEXT',director_position:'TEXT',
   reviewer_name:'TEXT',reviewer_position:'TEXT',reviewer_comment:'TEXT',reviewer_at:'TEXT',
   decision_note:'TEXT',decision_name:'TEXT',decision_position:'TEXT'
  };
  for (const [name,type] of Object.entries(columns)) if (!results.some(c=>c.name===name)) {
   try {await env.DB.prepare(`ALTER TABLE leave_requests ADD COLUMN ${name} ${type}`).run();}
   catch(e) {if (!/duplicate column name/i.test(String(e.message))) throw e;}
  }
  await env.DB.batch([
   env.DB.prepare(`CREATE TABLE IF NOT EXISTS leave_reviewers (
    leave_id INTEGER NOT NULL REFERENCES leave_requests(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id),kind TEXT NOT NULL,
    PRIMARY KEY(leave_id,user_id))`),
   env.DB.prepare(`CREATE TABLE IF NOT EXISTS leave_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,leave_id INTEGER NOT NULL REFERENCES leave_requests(id) ON DELETE CASCADE,
    actor_id INTEGER NOT NULL REFERENCES users(id),action TEXT NOT NULL,note TEXT,
    created_at TEXT NOT NULL DEFAULT(datetime('now')))`),
   env.DB.prepare('CREATE INDEX IF NOT EXISTS idx_leave_reviewers_user ON leave_reviewers(user_id,leave_id)'),
   env.DB.prepare("CREATE TABLE IF NOT EXISTS leave_settings (id INTEGER PRIMARY KEY CHECK(id=1),deputy_personnel_id INTEGER)")
  ]);
 })().catch(e=>{ready.delete(env.DB);throw e;});
 ready.set(env.DB,promise);return promise;
}

export function isDirector(p) {const position=String(p.position||'').replace(/\s/g,'');return /ผู้อำนวยการ/.test(position)&&!/รองผู้อำนวยการ|ผู้ช่วยผู้อำนวยการ/.test(position);}
export function isDeputy(p) {return /รองผู้อำนวยการ/.test(String(p.position||'').replace(/\s/g,''));}
export async function executives(env) {
 const {results}=await env.DB.prepare(`SELECT p.id,p.full_name,p.position,a.user_id
  FROM personnel_records p JOIN personnel_accounts a ON a.personnel_id=p.id
  JOIN users u ON u.id=a.user_id WHERE p.status='active' AND u.status='active' AND u.role='executive'`).all();
 const people=new Map();for (const p of results) {if(!people.has(p.id))people.set(p.id,{id:p.id,full_name:p.full_name,position:p.position,user_ids:[]});people.get(p.id).user_ids.push(p.user_id);}
 return [...people.values()];
}
export function validDate(s) {return typeof s==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(s)&&!Number.isNaN(Date.parse(s+'T00:00:00Z'))&&new Date(s+'T00:00:00Z').toISOString().slice(0,10)===s;}
export function calendarDays(start,end) {return Math.round((Date.parse(end+'T00:00:00Z')-Date.parse(start+'T00:00:00Z'))/86400000)+1;}
export function today() {return new Date().toLocaleDateString('sv-SE',{timeZone:'Asia/Bangkok'});}
// Additive subtype preserves existing D1 CHECK constraints and foreign-key history.
export function leaveRecord(row) {return {...row,leave_type:row.leave_subtype||row.leave_type};}
export async function leaveForm(env,row) {
 row=leaveRecord(row);
 const person=await env.DB.prepare(`SELECT p.* FROM personnel_records p JOIN personnel_accounts a ON a.personnel_id=p.id WHERE a.user_id=? AND p.status='active'`).bind(row.user_id).first();
 const start=row.start_date,year=Number(start.slice(0,4))-(start.slice(5,7)<'10'?1:0),from=`${year}-10-01`,to=`${year+1}-09-30`;
 const {results:storedHistory}=await env.DB.prepare(`SELECT r.* FROM leave_requests r
  WHERE r.status='approved' AND r.id<>? AND r.start_date<=? AND
  (r.user_id=? OR (? IS NOT NULL AND r.user_id IN (SELECT user_id FROM personnel_accounts WHERE personnel_id=?)))
  ORDER BY r.start_date DESC,r.id DESC`).bind(row.id,start,row.user_id,person?.id??null,person?.id??null).all();
 const history=storedHistory.map(leaveRecord);
 const stats=['sick','personal','maternity',...(row.leave_type==='lenient'||history.some(r=>r.leave_type==='lenient')?['lenient']:[]),...(row.leave_type==='other'?['other']:[])].map(type=>{
  const prior=history.filter(r=>r.leave_type===type&&r.start_date>=from&&r.start_date<=to);
  const previous_days=prior.reduce((sum,r)=>sum+Number(r.leave_days??calendarDays(r.start_date,r.end_date)),0),current_days=row.leave_type===type?Number(row.leave_days??calendarDays(row.start_date,row.end_date)):0;
  return {type,previous_count:prior.length,previous_days,current_days,total_count:prior.length+(current_days>0?1:0),total_days:previous_days+current_days};
 });
 const people=await executives(env),directors=people.filter(isDirector);
 return {...row,position:row.position||person?.position||'',request_date:row.request_date||row.created_at?.slice(0,10)||today(),
  leave_days:Number(row.leave_days??calendarDays(row.start_date,row.end_date)),last_leave:history[0]||null,stats,
  statistics_period:{from,to},director_name:row.director_name||(directors.length===1?directors[0].full_name:''),
  director_position:row.director_position||'ผู้อำนวยการโรงเรียนบ้านป่าเด็ง'};
}
