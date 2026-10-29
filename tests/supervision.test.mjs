import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {DatabaseSync} from 'node:sqlite';
import worker from '../src/index.js';
import {signJWT} from '../src/lib/crypto.js';
import {ensureBudgetSchema} from '../src/routes/budget.js';
import {summarizeScores,qualityLevel,slotStarted} from '../src/routes/supervision.js';

async function fixture(){
 const raw=new DatabaseSync(':memory:');raw.exec(fs.readFileSync(new URL('../schema.sql',import.meta.url),'utf8'));
 if(raw.limits)raw.limits.compoundSelect=5; // Cloudflare D1 allows at most five UNION terms
 raw.exec(`INSERT INTO users(id,email,password_hash,password_salt,full_name,role) VALUES
 (1,'admin@test','x','x','ผู้ดูแล','superadmin'),(2,'owner@test','x','x','ครู ก','teacher'),(3,'co@test','x','x','ครู ข','teacher');`);
 function prepare(sql){let values=[];return{bind(...v){values=v;return this},async first(){return raw.prepare(sql).get(...values)||null},async all(){return{results:raw.prepare(sql).all(...values)}},async run(){const r=raw.prepare(sql).run(...values);return{meta:{changes:Number(r.changes),last_row_id:Number(r.lastInsertRowid)}}}}}
 let tail=Promise.resolve();const env={raw,JWT_SECRET:'supervision-test',DB:{prepare,batch(statements){const next=tail.then(async()=>{raw.exec('BEGIN');try{const out=[];for(const s of statements)out.push(await s.run());raw.exec('COMMIT');return out}catch(e){raw.exec('ROLLBACK');throw e}});tail=next.catch(()=>{});return next}}};await ensureBudgetSchema(env);return env;
}
async function call(env,path,method='GET',body,user=1){const token=await signJWT({sub:user},env.JWT_SECRET);return worker.fetch(new Request('https://school.test'+path,{method,headers:{Cookie:`bpd_session=${token}`,'Content-Type':'application/json'},body:body?JSON.stringify(body):undefined}),env,{})}
const json=async(env,path,method='GET',body,user=1)=>{const r=await call(env,path,method,body,user);return {status:r.status,body:await r.json()};};
const ok=async(...args)=>{const r=await json(...args);assert.ok(r.status<300,`${args[1]} → ${r.status} ${JSON.stringify(r.body)}`);return r.body;};

async function school(){
 const env=await fixture();await call(env,'/api/overview');
 env.raw.exec(`INSERT INTO users(id,email,password_hash,password_salt,full_name,role) VALUES
  (5,'director@test','x','x','ผอ. ทดสอบ','executive'),(6,'deputy@test','x','x','รอง ผอ. ทดสอบ','superadmin'),(7,'hr@test','x','x','หัวหน้าฝ่ายวิชาการ','teacher');
  INSERT INTO academic_years(id,year_be,label,start_date,end_date,status) VALUES(90,2573,'ปีการศึกษา 2573','2030-01-01','2030-12-31','draft');
  INSERT INTO academic_terms(id,academic_year_id,term_number,name,start_date,end_date,status) VALUES(90,90,1,'ภาคเรียนที่ 1','2030-01-01','2030-03-31','planned');`);
 await call(env,'/api/overview');await call(env,'/api/supervision/permissions',undefined,undefined,5);
 for(const id of [2,3,5,6,7]){
  if(!env.raw.prepare('SELECT 1 FROM personnel_accounts WHERE user_id=?').get(id)){
   const name=env.raw.prepare('SELECT full_name FROM users WHERE id=?').get(id).full_name;
   const p=env.raw.prepare("INSERT INTO personnel_records(full_name,normalized_name,status) VALUES(?,?,'active')").run(name,'n'+id);
   env.raw.prepare('INSERT INTO personnel_accounts(user_id,personnel_id) VALUES(?,?)').run(id,Number(p.lastInsertRowid));
  }
 }
 const pid=id=>env.raw.prepare('SELECT personnel_id FROM personnel_accounts WHERE user_id=?').get(id).personnel_id;
 env.raw.prepare("UPDATE personnel_records SET position='ผู้อำนวยการโรงเรียน' WHERE id=?").run(pid(5));
 env.raw.prepare("UPDATE personnel_records SET position='รองผู้อำนวยการสถานศึกษา' WHERE id=?").run(pid(6));
 env.raw.prepare("UPDATE personnel_records SET position='ครู' WHERE id IN (?,?)").run(pid(2),pid(3));
 env.raw.prepare("INSERT INTO department_staff(department,personnel_id,is_head) VALUES('academic',?,1)").run(pid(7));
 return {env,pid};
}
const manual={visit_date:'2030-01-07',period:2,supervision_type:'teaching',topic:'การใช้คำถาม',subject:'ภาษาไทย',grade_level:'ป.4',classroom:'1'};

test('scores: total, percent out of 25 and quality bands',()=>{
 assert.deepEqual(summarizeScores([5,4,5,4,5]),{total:23,percent:92,level:'ดีเยี่ยม'});
 assert.equal(summarizeScores([3,3,3,3,3]).level,'พอใช้');assert.equal(qualityLevel(80),'ดีมาก');assert.equal(qualityLevel(59.99),'ควรพัฒนา');
 assert.equal(summarizeScores([5,5,5,5]),null);assert.equal(summarizeScores([5,5,5,5,6]),null);assert.equal(summarizeScores([5,5,5,5,4.5]),null);
 assert.equal(slotStarted('2030-01-07','09:30',{date:'2030-01-07',minutes:9*60+29}),false);
 assert.equal(slotStarted('2030-01-07','09:30',{date:'2030-01-07',minutes:9*60+30}),true);
 assert.equal(slotStarted('2030-01-06','09:30',{date:'2030-01-07',minutes:0}),true);
});

test('full flow: register → executives notified → accept → score → teacher sees only own result',async()=>{
 const {env}=await school();
 const perms=async u=>ok(env,'/api/supervision/permissions','GET',undefined,u);
 assert.equal((await perms(2)).evaluate,false);assert.equal((await perms(2)).staff,false);
 assert.equal((await perms(5)).evaluate,true);assert.equal((await perms(6)).evaluate,true);
 assert.equal((await perms(7)).evaluate,false);assert.equal((await perms(7)).view_all,true);assert.equal((await perms(7)).manage_evaluators,true);
 assert.equal((await perms(1)).manage_evaluators,true);assert.equal((await perms(1)).evaluate,false);

 assert.equal((await json(env,'/api/supervision/requests','POST',{...manual,subject:''},2)).status,400);
 assert.equal((await json(env,'/api/supervision/requests','POST',{...manual,visit_date:'2030-01-05'},2)).status,400,'weekend');
 assert.equal((await json(env,'/api/supervision/requests','POST',{...manual,visit_date:'2029-12-31'},2)).status,400,'outside term');
 const created=await ok(env,'/api/supervision/requests','POST',manual,2);const id=created.request.id;
 assert.equal(created.request.status,'pending');assert.equal(created.request.source,'manual');
 assert.equal((await json(env,'/api/supervision/requests','POST',manual,2)).status,409,'same teacher same slot');

 for(const u of [5,6]){const feed=await ok(env,'/api/notifications','GET',undefined,u);assert(feed.notifications.some(n=>n.message_key.startsWith('supervision:')&&/ขอรับนิเทศการสอน/.test(n.message)),'executive '+u+' notified');}
 assert(!(await ok(env,'/api/notifications','GET',undefined,3)).notifications.some(n=>n.message_key.startsWith('supervision:')));
 assert.equal((await json(env,'/api/supervision/requests?scope=all','GET',undefined,3)).status,403);

 assert.equal((await json(env,`/api/supervision/requests/${id}/accept`,'POST',{},7)).status,403,'academic head views but does not evaluate');
 await ok(env,`/api/supervision/requests/${id}/accept`,'POST',{},5);
 assert.equal((await json(env,`/api/supervision/requests/${id}/accept`,'POST',{},6)).status,409,'second executive cannot take it');
 const seen=(await ok(env,'/api/supervision/requests?scope=all','GET',undefined,6)).requests.find(r=>r.id===id);
 assert.equal(seen.supervisor_name,'ผอ. ทดสอบ');
 assert((await ok(env,'/api/notifications','GET',undefined,2)).notifications.some(n=>/รับนิเทศของคุณแล้ว/.test(n.message)));

 // ผู้บริหารคนเดียวรับนิเทศวันและคาบเดียวกันซ้ำไม่ได้
 const other=(await ok(env,'/api/supervision/requests','POST',{...manual,subject:'คณิตศาสตร์'},3)).request.id;
 const clash=await json(env,`/api/supervision/requests/${other}/accept`,'POST',{},5);assert.equal(clash.status,409);assert.match(clash.body.error,/วันและคาบเดียวกัน/);
 await ok(env,`/api/supervision/requests/${other}/accept`,'POST',{},6);

 assert.equal((await json(env,`/api/supervision/requests/${id}/evaluate`,'POST',{scores:[5,4,5,4,5]},6)).status,403,'only the accepting executive scores');
 assert.equal((await json(env,`/api/supervision/requests/${id}/evaluate`,'POST',{scores:[5,4,5,4]},5)).status,400,'all five items required');
 const saved=await ok(env,`/api/supervision/requests/${id}/evaluate`,'POST',{scores:[5,4,5,4,5],suggestion:'ใช้คำถามปลายเปิดดีมาก'},5);
 assert.equal(saved.request.status,'evaluated');assert.equal(saved.request.evaluation.total,23);assert.equal(saved.request.evaluation.percent,92);assert.equal(saved.request.evaluation.level,'ดีเยี่ยม');
 assert.equal(saved.request.evaluation.items[0].label,'การออกแบบแผนการจัดการเรียนรู้');
 assert.equal((await json(env,`/api/supervision/requests/${id}/evaluate`,'POST',{scores:[1,1,1,1,1]},5)).status,409,'cannot overwrite');
 assert.equal((await json(env,`/api/supervision/requests/${id}/cancel`,'POST',{},2)).status,409,'evaluated cannot be cancelled');

 const mine2=(await ok(env,'/api/supervision/requests?scope=mine','GET',undefined,2)).requests;
 assert.equal(mine2.length,1);assert.equal(mine2[0].evaluation.suggestion,'ใช้คำถามปลายเปิดดีมาก');assert.equal(mine2[0].evaluation.evaluator_name,'ผอ. ทดสอบ');
 const mine3=(await ok(env,'/api/supervision/requests?scope=mine','GET',undefined,3)).requests;
 assert.deepEqual(mine3.map(r=>r.id),[other],'teacher sees only own requests');
 assert((await ok(env,'/api/notifications','GET',undefined,2)).notifications.some(n=>/ผลการนิเทศของคุณพร้อมแล้ว/.test(n.message)));
 for(const u of [5,6,7,1]){const r=(await ok(env,'/api/supervision/requests?scope=all','GET',undefined,u)).requests.find(x=>x.id===id);assert.equal(r.evaluation.total,23,'executives, academic and admin see results: '+u);}
});

test('academic head appoints evaluators; appointed evaluators see only the results they scored',async()=>{
 const {env}=await school();
 const first=(await ok(env,'/api/supervision/requests','POST',manual,2)).request.id;
 await ok(env,`/api/supervision/requests/${first}/accept`,'POST',{},5);await ok(env,`/api/supervision/requests/${first}/evaluate`,'POST',{scores:[3,3,3,3,3]},5);
 assert.equal((await json(env,'/api/supervision/evaluators','POST',{user_id:3},2)).status,403,'teachers cannot appoint');
 assert.equal((await json(env,'/api/supervision/evaluators','POST',{user_id:3},5)).status,403,'executives cannot appoint unless academic head/admin');
 await ok(env,'/api/supervision/evaluators','POST',{user_id:3},7);
 const list=await ok(env,'/api/supervision/evaluators','GET',undefined,1);
 assert.deepEqual(list.assigned.map(a=>a.user_id),[3]);assert(list.automatic.some(a=>a.user_id===5)&&list.automatic.some(a=>a.user_id===6));
 const p3=await ok(env,'/api/supervision/permissions','GET',undefined,3);assert.equal(p3.evaluate,true);assert.equal(p3.view_all,false);

 const own=(await ok(env,'/api/supervision/requests','POST',{...manual,period:3},3)).request.id;
 assert.equal((await json(env,`/api/supervision/requests/${own}/accept`,'POST',{},3)).status,403,'no self-evaluation');
 const second=(await ok(env,'/api/supervision/requests','POST',{...manual,period:4},7)).request.id;
 await ok(env,`/api/supervision/requests/${second}/accept`,'POST',{},3);
 await ok(env,`/api/supervision/requests/${second}/release`,'POST',{},3);
 assert.equal((await ok(env,'/api/supervision/requests?scope=mine','GET',undefined,7)).requests.find(r=>r.id===second).status,'pending');
 await ok(env,`/api/supervision/requests/${second}/accept`,'POST',{},3);
 await ok(env,`/api/supervision/requests/${second}/evaluate`,'POST',{scores:[4,4,4,4,4]},3);
 const all=(await ok(env,'/api/supervision/requests?scope=all','GET',undefined,3)).requests;
 assert.equal(all.find(r=>r.id===second).evaluation.percent,80);
 assert.equal(all.find(r=>r.id===first).evaluation,undefined,'not shown: scored by someone else');
 await ok(env,'/api/supervision/evaluators/3','DELETE',undefined,1);
 assert.equal((await ok(env,'/api/supervision/permissions','GET',undefined,3)).evaluate,false);
});

test('published timetable limits registration to the teacher’s own lessons; cancel notifies the supervisor',async()=>{
 const {env,pid}=await school();
 env.raw.exec(`CREATE TABLE IF NOT EXISTS timetable_plans(id INTEGER PRIMARY KEY AUTOINCREMENT,academic_term_id INTEGER NOT NULL,status TEXT NOT NULL,created_by INTEGER NOT NULL,created_at TEXT NOT NULL DEFAULT(datetime('now')),published_at TEXT);
  CREATE TABLE IF NOT EXISTS timetable_entries(id INTEGER PRIMARY KEY AUTOINCREMENT,plan_id INTEGER NOT NULL,grade_level TEXT NOT NULL,classroom TEXT NOT NULL,weekday INTEGER NOT NULL,period INTEGER NOT NULL,subject TEXT NOT NULL,teacher_id INTEGER NOT NULL,room_name TEXT);
  INSERT INTO timetable_plans(id,academic_term_id,status,created_by) VALUES(9,90,'published',1);`);
 env.raw.prepare("INSERT INTO timetable_entries(plan_id,grade_level,classroom,weekday,period,subject,teacher_id) VALUES(9,'ป.5','2',2,3,'วิทยาศาสตร์',?)").run(pid(2));
 const week=await ok(env,'/api/supervision/week?start=2030-01-09','GET',undefined,2);
 assert.equal(week.start,'2030-01-07');assert.equal(week.terms[0].mode,'timetable');assert.equal(week.terms[0].lessons.length,1);assert.equal(week.terms[0].times.length,6);
 const none=await json(env,'/api/supervision/requests','POST',{visit_date:'2030-01-08',period:1,supervision_type:'classroom'},2);
 assert.equal(none.status,409);assert.match(none.body.error,/ไม่มีคาบสอน/);
 const r=(await ok(env,'/api/supervision/requests','POST',{visit_date:'2030-01-08',period:3,supervision_type:'classroom',subject:'ปลอม'},2)).request;
 assert.equal(r.subject,'วิทยาศาสตร์');assert.equal(r.grade_level,'ป.5');assert.equal(r.source,'timetable');
 await ok(env,`/api/supervision/requests/${r.id}/accept`,'POST',{},6);
 assert.equal((await json(env,`/api/supervision/requests/${r.id}/cancel`,'POST',{},3)).status,403,'only the owner cancels');
 await ok(env,`/api/supervision/requests/${r.id}/cancel`,'POST',{},2);
 assert((await ok(env,'/api/notifications','GET',undefined,6)).notifications.some(n=>/ยกเลิกคำขอ/.test(n.message)));
 assert.equal((await ok(env,'/api/supervision/requests?scope=mine','GET',undefined,2)).requests.length,0);
 // จองคาบเดิมใหม่ได้หลังยกเลิก
 await ok(env,'/api/supervision/requests','POST',{visit_date:'2030-01-08',period:3,supervision_type:'teaching'},2);
 assert.equal((await json(env,'/api/supervision/requests','POST',{visit_date:'2020-01-07',period:1,supervision_type:'teaching'},2)).status,400,'past dates rejected');
});

test('menus: teacher registration under support, executive pages under administration and academic',()=>{
 const nav=vm.createContext({URL});vm.runInContext(fs.readFileSync('public/js/navigation-catalog.js','utf8'),nav);
 const n=nav.SchoolNavigation,html=fs.readFileSync('public/dashboard.html','utf8');
 const support=html.split('ระบบสนับสนุน</div>')[1].split('บริหารระบบ</div>')[0];assert(support.includes('data-page="supervision"'));
 assert(n.groups.administration.some(i=>i.url==='/supervision-admin.html'&&i.supervisionOnly==='evaluate'));
 assert(n.groups.academic.some(i=>i.url==='/supervision-admin.html?view=results'&&i.supervisionOnly==='view_all'));
 assert(n.groups.administration.some(i=>i.url==='/supervision-admin.html?view=summary'&&i.label==='ประเมินผลการนิเทศ'&&i.supervisionOnly==='view_all'));
 assert(!n.groups.personnel.some(i=>String(i.url).includes('supervision')),'no supervision menus left under personnel');
 assert.equal(n.parentFor('','/supervision-admin.html?view=results'),'academic');assert.equal(n.parentFor('','/supervision-admin.html?view=summary'),'administration');
 assert(n.groups.academic.some(i=>i.url==='/supervision-admin.html?view=evaluators'&&i.supervisionOnly==='manage_evaluators'));
 assert.equal(n.parentFor('supervision','/supervision.html'),'supervision');assert.equal(n.parentFor('','/supervision-admin.html?request=1'),'administration');
 assert.match(html,/data-supervision-only/);
});

test('a date + period accepts at most 3 registrations (3 evaluators); 4th is told the slot is full',async()=>{
 const {env}=await school();
 for(const u of [2,3,7])await ok(env,'/api/supervision/requests','POST',manual,u);
 const full=await json(env,'/api/supervision/requests','POST',manual,6);
 assert.equal(full.status,409);assert.equal(full.body.error,'ลงทะเบียนไม่ได้เนื่องจากคาบเต็ม กรุณาเลือกคาบอื่น');
 await ok(env,'/api/supervision/requests','POST',{...manual,period:3},1); // other period still open
 await ok(env,'/api/supervision/requests','POST',{...manual,visit_date:'2030-01-14'},5); // same period, other date still open
 const week=await ok(env,'/api/supervision/week?start=2030-01-07','GET',undefined,6);
 assert.equal(week.capacity,3);assert.deepEqual(week.full,['2030-01-07|2']);
 const id=env.raw.prepare("SELECT id FROM supervision_requests WHERE teacher_user_id=2").get().id;
 await ok(env,`/api/supervision/requests/${id}/cancel`,'POST',{},2); // a cancellation frees a seat
 await ok(env,'/api/supervision/requests','POST',manual,6);
});

test('one registration per teacher per term; rebooking after cancelling is allowed',async()=>{
 const {env}=await school();
 const first=(await ok(env,'/api/supervision/requests','POST',manual,2)).request.id;
 const again=await json(env,'/api/supervision/requests','POST',{...manual,period:5},2);
 assert.equal(again.status,409);assert.match(again.body.error,/ภาคเรียนละ 1 ครั้ง/);
 assert.equal((await ok(env,'/api/supervision/week?start=2030-01-07','GET',undefined,2)).terms[0].registered.id,first);
 await ok(env,`/api/supervision/requests/${first}/cancel`,'POST',{},2);
 await ok(env,'/api/supervision/requests','POST',{...manual,period:5},2);
});

test('holidays cannot be booked; activity days need confirmation',async()=>{
 const {env}=await school();
 env.raw.exec(`CREATE TABLE IF NOT EXISTS gr_holidays(id INTEGER PRIMARY KEY,academic_year_id INTEGER,holiday_date TEXT,name TEXT,kind TEXT);
  INSERT INTO gr_holidays(academic_year_id,holiday_date,name,kind) VALUES(90,'2030-01-08','วันหยุดทดสอบ','holiday'),(90,'2030-01-09','กีฬาสี','activity');`);
 const h=await json(env,'/api/supervision/requests','POST',{...manual,visit_date:'2030-01-08'},2);assert.equal(h.status,400);assert.match(h.body.error,/วันหยุด \(วันหยุดทดสอบ\)/);
 const a=await json(env,'/api/supervision/requests','POST',{...manual,visit_date:'2030-01-09'},2);assert.equal(a.status,409);assert.equal(a.body.code,'activity_day');
 assert.equal(a.body.error,'วันนี้ตรงกับวันกิจกรรม (กีฬาสี) ยืนยันจะจองคาบนี้วันนี้ใช่ไหม');
 assert.equal((await ok(env,'/api/supervision/requests','POST',{...manual,visit_date:'2030-01-09',confirm_activity:true},2)).request.visit_date,'2030-01-09');
 const week=await ok(env,'/api/supervision/week?start=2030-01-07','GET',undefined,2);
 assert.equal(week.days[1].holiday.kind,'holiday');assert.equal(week.days[2].holiday.kind,'activity');assert.equal(week.days[0].holiday,null);
});

test('evaluator unavailability lowers the slot capacity and blocks accepting that slot',async()=>{
 const {env}=await school();
 assert.equal((await json(env,'/api/supervision/unavailability','POST',{date:'2030-01-07',period:2},2)).status,403,'teachers cannot');
 await ok(env,'/api/supervision/unavailability','POST',{date:'2030-01-07',period:2,note:'ประชุม'},5);
 await ok(env,'/api/supervision/unavailability','POST',{date:'2030-01-07'},6); // whole day
 assert.equal((await json(env,'/api/supervision/unavailability','POST',{date:'2030-01-07'},6)).status,409,'duplicate');
 // 3 − 2 ไม่ว่าง = รับได้ 1 คำขอ
 await ok(env,'/api/supervision/requests','POST',manual,2);
 const full=await json(env,'/api/supervision/requests','POST',manual,3);assert.equal(full.status,409);assert.match(full.body.error,/คาบเต็ม/);
 const week=await ok(env,'/api/supervision/week?start=2030-01-07','GET',undefined,3);assert(week.full.includes('2030-01-07|2'));assert(!week.full.includes('2030-01-07|3'));
 const id=env.raw.prepare('SELECT id FROM supervision_requests WHERE teacher_user_id=2').get().id;
 const blocked=await json(env,`/api/supervision/requests/${id}/accept`,'POST',{},5);assert.equal(blocked.status,409);assert.match(blocked.body.error,/แจ้งไม่ว่าง/);
 const list=(await ok(env,'/api/supervision/unavailability','GET',undefined,5)).items;assert.equal(list.length,2);
 const mineRow=list.find(r=>r.mine);
 assert.equal((await json(env,`/api/supervision/unavailability/${list.find(r=>!r.mine).id}`,'DELETE',undefined,5)).status,404,'only own');
 await ok(env,`/api/supervision/unavailability/${mineRow.id}`,'DELETE',undefined,5);
 await ok(env,`/api/supervision/requests/${id}/accept`,'POST',{},5);
 // แจ้งไม่ว่างทับนัดที่รับไว้แล้วไม่ได้
 const clash=await json(env,'/api/supervision/unavailability','POST',{date:'2030-01-07',period:2},5);assert.equal(clash.status,409);assert.match(clash.body.error,/ถอนการรับ/);
});

test('cancel only until the day before; overdue flag; revoking an evaluator frees their open assignments',async()=>{
 const {env}=await school();
 const {date:today}=(await import('../src/routes/supervision.js')).bangkokNow();
 const yesterday=new Date(Date.parse(today+'T00:00:00Z')-86400000).toISOString().slice(0,10);
 const ins=(u,d,st,sup)=>Number(env.raw.prepare("INSERT INTO supervision_requests(teacher_user_id,academic_term_id,visit_date,weekday,period,source,subject,supervision_type,status,supervisor_user_id) VALUES(?,90,?,1,1,'manual','ไทย','teaching',?,?)").run(u,d,st,sup).lastInsertRowid);
 const todayId=ins(2,today,'pending',null);
 const c=await json(env,`/api/supervision/requests/${todayId}/cancel`,'POST',{},2);assert.equal(c.status,409);assert.match(c.body.error,/ก่อนวันนิเทศอย่างน้อย 1 วัน/);
 const late=ins(3,yesterday,'confirmed',5);
 const mine=(await ok(env,'/api/supervision/requests?scope=mine','GET',undefined,3)).requests[0];
 assert.equal(mine.overdue,true);assert.equal(mine.can_cancel,false);
 assert.equal((await ok(env,'/api/supervision/requests?scope=mine','GET',undefined,2)).requests[0].overdue,false);

 await ok(env,'/api/supervision/evaluators','POST',{user_id:7},1);
 const open=(await ok(env,'/api/supervision/requests','POST',manual,6)).request.id;
 await ok(env,`/api/supervision/requests/${open}/accept`,'POST',{},7);
 await ok(env,'/api/supervision/unavailability','POST',{date:'2030-01-08'},7);
 const res=await ok(env,'/api/supervision/evaluators/7','DELETE',undefined,1);assert.equal(res.released,1);
 const back=(await ok(env,'/api/supervision/requests?scope=all','GET',undefined,5)).requests.find(r=>r.id===open);
 assert.equal(back.status,'pending');assert.equal(back.supervisor_user_id,null);
 assert.equal(env.raw.prepare('SELECT COUNT(*) n FROM supervision_unavailability WHERE user_id=7').get().n,0);
 assert((await ok(env,'/api/notifications','GET',undefined,6)).notifications.some(n=>/ถูกถอนสิทธิ์/.test(n.message)));
 assert.equal(late>0,true);
});
