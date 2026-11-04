import {normalizeLeaves,leaveCalendar,legacyCappedDays,effectiveLeaveDays} from './leave-working-days.js';
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
   decision_note:'TEXT',decision_name:'TEXT',decision_position:'TEXT',applicant_note:'TEXT',substitute_teacher:'TEXT',teacher_signature:'TEXT',deputy_signature:'TEXT',approver_signature:'TEXT'
  };
  for (const [name,type] of Object.entries(columns)) if (!results.some(c=>c.name===name)) {
   try {await env.DB.prepare(`ALTER TABLE leave_requests ADD COLUMN ${name} ${type}`).run();}
   catch(e) {if (!/duplicate column name/i.test(String(e.message))) throw e;}
  }
  await env.DB.batch([
   env.DB.prepare(`CREATE TABLE IF NOT EXISTS leave_approval_delegations (
    personnel_id INTEGER PRIMARY KEY REFERENCES personnel_records(id),
    granted_by INTEGER NOT NULL REFERENCES users(id),
    granted_at TEXT NOT NULL DEFAULT(datetime('now')))`),
   env.DB.prepare(`CREATE TABLE IF NOT EXISTS leave_reviewers (
    leave_id INTEGER NOT NULL REFERENCES leave_requests(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id),kind TEXT NOT NULL,
    PRIMARY KEY(leave_id,user_id))`),
   env.DB.prepare(`CREATE TABLE IF NOT EXISTS leave_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,leave_id INTEGER NOT NULL REFERENCES leave_requests(id) ON DELETE CASCADE,
    actor_id INTEGER NOT NULL REFERENCES users(id),action TEXT NOT NULL,note TEXT,
    created_at TEXT NOT NULL DEFAULT(datetime('now')))`),
   env.DB.prepare('CREATE INDEX IF NOT EXISTS idx_leave_reviewers_user ON leave_reviewers(user_id,leave_id)'),
   env.DB.prepare('CREATE TABLE IF NOT EXISTS leave_limits (leave_type TEXT PRIMARY KEY,max_count INTEGER CHECK(max_count IS NULL OR max_count>=0))'),
   env.DB.prepare("CREATE TABLE IF NOT EXISTS leave_term_limits (leave_type TEXT PRIMARY KEY CHECK(leave_type IN ('general','lenient')),max_count INTEGER CHECK(max_count IS NULL OR max_count>=0))"),
   env.DB.prepare("INSERT OR IGNORE INTO leave_term_limits(leave_type,max_count) VALUES('general',2),('lenient',2)"),
   env.DB.prepare("CREATE TABLE IF NOT EXISTS leave_settings (id INTEGER PRIMARY KEY CHECK(id=1),deputy_personnel_id INTEGER,line_template TEXT)")
  ]);
  const {results:settingColumns}=await env.DB.prepare('PRAGMA table_info(leave_settings)').all();
  for(const [name,type] of [['line_template','TEXT']])if(!settingColumns.some(c=>c.name===name)){
   try{await env.DB.prepare(`ALTER TABLE leave_settings ADD COLUMN ${name} ${type}`).run();}
   catch(e){if(!/duplicate column/i.test(String(e.message)))throw e;}
  }
  await freezeLeaveDays(env);
 })().catch(e=>{ready.delete(env.DB);throw e;});
 ready.set(env.DB,promise);return promise;
}

// One-time: store the capped value that used to be recomputed on every read, so later
// holiday-calendar edits can no longer change history (stored leave_days becomes final).
async function freezeLeaveDays(env){
 await env.DB.prepare('CREATE TABLE IF NOT EXISTS leave_migrations (key TEXT PRIMARY KEY,done_at TEXT NOT NULL DEFAULT(datetime(\'now\')))').run();
 if(await env.DB.prepare("SELECT 1 FROM leave_migrations WHERE key='freeze_leave_days'").first())return;
 const holidays=await leaveCalendar(env);
 const {results}=await env.DB.prepare('SELECT id,leave_type,leave_subtype,start_date,end_date,leave_days FROM leave_requests').all();
 const updates=results.map(r=>({id:r.id,days:legacyCappedDays(r,holidays)})).filter((u,i)=>results[i].leave_days==null||u.days!==Number(results[i].leave_days));
 const statements=updates.map(u=>env.DB.prepare('UPDATE leave_requests SET leave_days=? WHERE id=?').bind(u.days,u.id));
 statements.push(env.DB.prepare("INSERT OR IGNORE INTO leave_migrations(key) VALUES('freeze_leave_days')"));
 for(let i=0;i<statements.length;i+=50)await env.DB.batch(statements.slice(i,i+50));
}
export function isDirector(p) {const position=String(p.position||'').replace(/\s/g,'');return /ผู้อำนวยการ/.test(position)&&!/รองผู้อำนวยการ|ผู้ช่วยผู้อำนวยการ/.test(position);}
export function isDeputy(p) {return /รองผู้อำนวยการ/.test(String(p.position||'').replace(/\s/g,''));}
export async function executives(env) {
 const {results}=await env.DB.prepare(`SELECT p.id,p.full_name,p.position,a.user_id
  FROM personnel_records p JOIN personnel_accounts a ON a.personnel_id=p.id
  JOIN users u ON u.id=a.user_id WHERE p.status='active' AND u.status='active' AND u.deleted_at IS NULL AND u.role IN ('executive','superadmin')`).all();
 const people=new Map();for (const p of results) {if(!people.has(p.id))people.set(p.id,{id:p.id,full_name:p.full_name,position:p.position,user_ids:[]});people.get(p.id).user_ids.push(p.user_id);}
 return [...people.values()];
}
// The explicit leave assignment wins. A personnel-scoped executive assignment is a
// useful fallback before the first leave has ever been forwarded.
export async function designatedDeputy(env, people) {
 const deputies=people.filter(isDeputy);
 const setting=await env.DB.prepare('SELECT deputy_personnel_id FROM leave_settings WHERE id=1').first();
 const selected=deputies.find(p=>p.id===Number(setting?.deputy_personnel_id));
 if(selected)return selected;
 const assignment=await env.DB.prepare("SELECT user_id FROM budget_role_assignments WHERE role_key='deputy_director' AND department='personnel'").first().catch(()=>null);
 const scoped=deputies.filter(p=>p.user_ids.some(id=>id===Number(assignment?.user_id)));
 return scoped.length===1?scoped[0]:deputies.length===1?deputies[0]:null;
}
export function validDate(s) {return typeof s==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(s)&&!Number.isNaN(Date.parse(s+'T00:00:00Z'))&&new Date(s+'T00:00:00Z').toISOString().slice(0,10)===s;}
export function calendarDays(start,end) {return Math.round((Date.parse(end+'T00:00:00Z')-Date.parse(start+'T00:00:00Z'))/86400000)+1;}
export function today() {return new Date().toLocaleDateString('sv-SE',{timeZone:'Asia/Bangkok'});}
// Additive subtype preserves existing D1 CHECK constraints and foreign-key history.
export function leaveRecord(row) {return {...row,leave_type:row.leave_subtype||row.leave_type};}
// ลายเซ็นผู้บริหารบนใบลา: รอง ผอ. (ผู้ตรวจสอบ) เมื่อหัวหน้าฝ่ายบุคลากรรับทราบ/ส่งต่อแล้ว, ผอ. เมื่ออนุญาตแล้ว
// ใบลาที่ผ่านขั้นตอนไปก่อนมีลายเซ็นในระบบ → เติมจากลายเซ็นปัจจุบันแล้วบันทึกเป็นสำเนาถาวร
async function backfillSignatures(env,row,people){
 const done=row.status!=='cancelled'&&row.status!=='rejected'&&['forwarded','completed'].includes(row.workflow_stage);
 const out={deputy_signature:done?row.deputy_signature||null:null,approver_signature:row.status==='approved'?row.approver_signature||null:null};
 const {signatureFor}=await import('./signatures.js');
 const sign=async ids=>{for(const id of ids)if(id){const s=await signatureFor(env,id).catch(()=>null);if(s)return s.data_url;}return null;};
 const sets=[],binds=[];
 if(done&&!out.deputy_signature){
  const deputy=people.find(p=>p.id===Number(row.deputy_personnel_id))||(row.deputy_name&&people.find(p=>p.full_name===row.deputy_name))||null;
  out.deputy_signature=await sign(deputy?.user_ids||[]);
  if(out.deputy_signature){sets.push('deputy_signature=?');binds.push(out.deputy_signature);}
 }
 if(row.status==='approved'&&!out.approver_signature){
  out.approver_signature=await sign([row.approved_by]);
  if(out.approver_signature){sets.push('approver_signature=?');binds.push(out.approver_signature);}
 }
 if(sets.length)await env.DB.prepare(`UPDATE leave_requests SET ${sets.join(',')} WHERE id=?`).bind(...binds,row.id).run().catch(()=>{});
 return out;
}
export async function leaveForm(env,row) {
 row=leaveRecord((await normalizeLeaves(env,[row]))[0]);
 const person=await env.DB.prepare(`SELECT p.* FROM personnel_records p JOIN personnel_accounts a ON a.personnel_id=p.id WHERE a.user_id=? AND p.status='active'`).bind(row.user_id).first();
 const start=row.start_date,year=Number(start.slice(0,4))-(start.slice(5,7)<'10'?1:0),from=`${year}-10-01`,to=`${year+1}-09-30`;
 const {results:storedHistory}=await env.DB.prepare(`SELECT r.id,r.user_id,r.leave_type,r.leave_subtype,r.start_date,r.end_date,r.leave_days,r.status FROM leave_requests r
  WHERE r.status='approved' AND r.id<>? AND r.start_date<=? AND
  (r.user_id=? OR (? IS NOT NULL AND r.user_id IN (SELECT user_id FROM personnel_accounts WHERE personnel_id=?)))
  ORDER BY r.start_date DESC,r.id DESC`).bind(row.id,start,row.user_id,person?.id??null,person?.id??null).all();
 const holidays=await leaveCalendar(env),round=n=>Math.round(n*100)/100;
 const history=(await normalizeLeaves(env,storedHistory)).map(leaveRecord).filter(r=>(r.leave_type==='lenient')===(row.leave_type==='lenient'));
 const stats=(row.leave_type==='lenient'?['lenient']:['sick','personal','maternity',...(row.leave_type==='other'?['other']:[])]).map(type=>{
  // Same rule as statistics: a leave counts once in the year it starts; days follow the overlap.
  const typed=history.filter(r=>r.leave_type===type&&r.end_date>=from&&r.start_date<=to);
  const previous_count=typed.filter(r=>r.start_date>=from).length;
  const previous_days=round(typed.reduce((sum,r)=>sum+effectiveLeaveDays(r,holidays,from,to),0)),current_days=row.leave_type===type?round(effectiveLeaveDays(row,holidays,from,to)):0;
  return {type,previous_count,previous_days,current_days,total_count:previous_count+(row.leave_type===type?1:0),total_days:round(previous_days+current_days)};
 });
 const people=await executives(env),directors=people.filter(isDirector);
 const deputy=row.deputy_name?null:await designatedDeputy(env,people).catch(()=>null);
 Object.assign(row,await backfillSignatures(env,row,people));
 return {...row,deputy_name:row.deputy_name||deputy?.full_name||'',deputy_position:row.deputy_position||deputy?.position||'',position:row.position||person?.position||'',request_date:row.request_date||row.created_at?.slice(0,10)||today(),
  leave_days:Number(row.leave_days??calendarDays(row.start_date,row.end_date)),last_leave:history[0]||null,stats,
  statistics_period:{from,to,included_in_fiscal_year:row.leave_type!=='lenient'},director_name:row.director_name||(directors.length===1?directors[0].full_name:''),
  director_position:row.director_position||'ผู้อำนวยการโรงเรียนบ้านป่าเด็ง'};
}
