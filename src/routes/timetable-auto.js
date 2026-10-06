import {solveTimetable} from '../lib/timetable-solver.js';
import {jsonResponse} from '../lib/auth.js';
const reply=(data,status=200)=>jsonResponse(data,status,{'Cache-Control':'private, no-store'});
export async function ensureAutoSchema(env){
 await env.DB.prepare(`CREATE TABLE IF NOT EXISTS timetable_auto_config(academic_term_id INTEGER PRIMARY KEY REFERENCES academic_terms(id),config_json TEXT NOT NULL,updated_by INTEGER NOT NULL REFERENCES users(id),updated_at TEXT NOT NULL DEFAULT(datetime('now')))` ).run();
 const {results}=await env.DB.prepare('PRAGMA table_info(timetable_plans)').all();
 if(!results.some(c=>c.name==='revision')){try{await env.DB.prepare('ALTER TABLE timetable_plans ADD COLUMN revision INTEGER NOT NULL DEFAULT 0').run();}catch(e){if(!/duplicate column/i.test(String(e)))throw e;}}
 await env.DB.batch(['INSERT','UPDATE','DELETE'].map(action=>env.DB.prepare(`CREATE TRIGGER IF NOT EXISTS timetable_revision_${action.toLowerCase()} AFTER ${action} ON timetable_entries BEGIN UPDATE timetable_plans SET revision=revision+1 WHERE id=${action==='DELETE'?'OLD':'NEW'}.plan_id; END`)));
 await env.DB.prepare('CREATE TABLE IF NOT EXISTS timetable_auto_guard(id TEXT PRIMARY KEY, valid INTEGER NOT NULL CHECK(valid=1))').run();
}
export async function handleAuto(request,env,term,user,pathname,method,helpers){
 if(!pathname.startsWith('/api/timetable/auto'))return null;
 await ensureAutoSchema(env);
 if(pathname==='/api/timetable/auto/config'&&method==='GET'){
  const row=await env.DB.prepare('SELECT config_json FROM timetable_auto_config WHERE academic_term_id=?').bind(term.id).first();
  return reply({config:row?JSON.parse(row.config_json):null});
 }
 const body=await request.json().catch(()=>null),config=body?.config;
 if(!config||!Array.isArray(config.classes)||!Array.isArray(config.assignments)||!Array.isArray(config.unavailable)||(config.fixed!==undefined&&!Array.isArray(config.fixed))||typeof config.keep_existing!=='boolean'||JSON.stringify(config).length>200000)return reply({error:'ข้อมูลตั้งค่าจัดตารางไม่ถูกต้อง'},400);
 const setup=await (await helpers.setup(env,term)).json();
 const roomKey=a=>JSON.stringify([a.grade_level,a.classroom]);
 const known=new Set(setup.classes.map(roomKey)),teachers=new Set(setup.teachers.map(t=>t.id));
 if(config.classes.some(c=>!known.has(roomKey(c)))||config.assignments.some(a=>!teachers.has(a.teacher_id))||config.unavailable.some(a=>!teachers.has(a.teacher_id))||(config.fixed||[]).some(a=>!known.has(roomKey(a))||!teachers.has(a.teacher_id)))return reply({error:'ห้องเรียนหรือครูไม่อยู่ในทะเบียนของภาคเรียนนี้'},400);
 const chosen=await helpers.plan(env,term.id,'draft')||await helpers.plan(env,term.id,'published');
 const before=chosen?await env.DB.prepare('SELECT revision FROM timetable_plans WHERE id=?').bind(chosen.id).first():null;
 const existing=chosen?(await env.DB.prepare('SELECT * FROM timetable_entries WHERE plan_id=? ORDER BY id').bind(chosen.id).all()).results:[];
 const after=chosen?await env.DB.prepare('SELECT revision FROM timetable_plans WHERE id=?').bind(chosen.id).first():null;
 if(before?.revision!==after?.revision)return reply({error:'ตารางเปลี่ยนระหว่างอ่าน กรุณาทดลองจัดใหม่'},409);
 const fingerprint=chosen?`${chosen.id}:${before.revision}`:'empty';
 const result=solveTimetable({...config,existing});
 if(!result.ok)return reply({error:result.errors.join('\n'),...result},422);
 if(pathname==='/api/timetable/auto/config'&&method==='PUT'){
  await env.DB.prepare(`INSERT INTO timetable_auto_config(academic_term_id,config_json,updated_by) VALUES(?,?,?) ON CONFLICT(academic_term_id) DO UPDATE SET config_json=excluded.config_json,updated_by=excluded.updated_by,updated_at=datetime('now')`).bind(term.id,JSON.stringify(config),user.id).run();
  return reply({ok:true});
 }
 if(pathname==='/api/timetable/auto/preview'&&method==='POST')return reply({...result,fingerprint});
 if(pathname!=='/api/timetable/auto/apply'||method!=='POST')return reply({error:'ไม่พบ endpoint'},404);
 if(body.fingerprint!==fingerprint)return reply({error:'ตารางเปลี่ยนหลังทดลองจัด กรุณาทดลองจัดใหม่'},409);
 const current=await helpers.draft(env,term.id,user.id);
 const revision=await env.DB.prepare('SELECT revision FROM timetable_plans WHERE id=?').bind(current.id).first();
 const currentEntries=(await env.DB.prepare('SELECT * FROM timetable_entries WHERE plan_id=? ORDER BY id').bind(current.id).all()).results;
 const signature=rows=>JSON.stringify(rows.map(e=>[e.grade_level,e.classroom,e.weekday,e.period,e.subject,e.teacher_id,e.room_name||'']).sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b))));
 if(signature(currentEntries)!==signature(existing))return reply({error:'ร่างตารางเปลี่ยน กรุณาทดลองจัดใหม่'},409);
 const guard=crypto.randomUUID();
 const statements=[env.DB.prepare(`INSERT INTO timetable_auto_guard(id,valid) VALUES(?,CASE WHEN (SELECT revision FROM timetable_plans WHERE id=?)=? THEN 1 ELSE 0 END)`).bind(guard,current.id,revision.revision)];
 if(chosen)statements.push(env.DB.prepare(`INSERT INTO timetable_auto_guard(id,valid) VALUES(?,CASE WHEN (SELECT revision FROM timetable_plans WHERE id=?)=? THEN 1 ELSE 0 END)`).bind(guard+'source',chosen.id,before.revision));
 for(const c of config.classes)statements.push(env.DB.prepare('DELETE FROM timetable_entries WHERE plan_id=? AND grade_level=? AND classroom=?').bind(current.id,c.grade_level,c.classroom));
 for(const e of result.entries)statements.push(env.DB.prepare(`INSERT INTO timetable_entries(plan_id,grade_level,classroom,weekday,period,subject,teacher_id,room_name) VALUES(?,?,?,?,?,?,?,?)`).bind(current.id,e.grade_level,e.classroom,e.weekday,e.period,e.subject,e.teacher_id,e.room_name||null));
 statements.push(env.DB.prepare(`INSERT INTO timetable_auto_config(academic_term_id,config_json,updated_by) VALUES(?,?,?) ON CONFLICT(academic_term_id) DO UPDATE SET config_json=excluded.config_json,updated_by=excluded.updated_by,updated_at=datetime('now')`).bind(term.id,JSON.stringify(config),user.id));
 statements.push(env.DB.prepare('DELETE FROM timetable_auto_guard WHERE id IN (?,?)').bind(guard,guard+'source'));
 try{await env.DB.batch(statements);}catch(e){if(/constraint/i.test(String(e)))return reply({error:'ตารางเปลี่ยนหรือมีคาบชนกัน ข้อมูลเดิมไม่ถูกแทนที่ กรุณาทดลองจัดใหม่'},409);throw e;}
 return reply({ok:true,plan_id:current.id,summary:result.summary});
}
