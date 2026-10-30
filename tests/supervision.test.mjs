import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {DatabaseSync} from 'node:sqlite';
import worker from '../src/index.js';
import {signJWT} from '../src/lib/crypto.js';
import {ensureBudgetSchema} from '../src/routes/budget.js';
import {summarizeScores,qualityLevel,slotStarted,supervisionMaintenance} from '../src/routes/supervision.js';
// Drive ปลอม: ตั้งค่าครบแต่เรียกเครือข่ายไม่ได้ (ทดสอบเส้นทางล้มเหลว/ลบซ้ำ)
const DRIVE={GOOGLE_DRIVE_CLIENT_ID:'x',GOOGLE_DRIVE_CLIENT_SECRET:'x',GOOGLE_DRIVE_REFRESH_TOKEN:'x',GOOGLE_DRIVE_FOLDER_ID:'x'};

async function fixture(){
 const raw=new DatabaseSync(':memory:');raw.exec(fs.readFileSync(new URL('../schema.sql',import.meta.url),'utf8'));
 if(raw.limits)raw.limits.compoundSelect=5; // Cloudflare D1 allows at most five UNION terms
 raw.exec(`INSERT INTO users(id,email,password_hash,password_salt,full_name,role) VALUES
 (1,'admin@test','x','x','ผู้ดูแล','superadmin'),(2,'owner@test','x','x','ครู ก','teacher'),(3,'co@test','x','x','ครู ข','teacher');`);
 function prepare(sql){let values=[];return{bind(...v){values=v;return this},async first(){return raw.prepare(sql).get(...values)||null},async all(){return{results:raw.prepare(sql).all(...values)}},async run(){const r=raw.prepare(sql).run(...values);return{meta:{changes:Number(r.changes),last_row_id:Number(r.lastInsertRowid)}}}}}
 let tail=Promise.resolve();const env={raw,JWT_SECRET:'supervision-test',SUPERVISION_OPEN_DATE:'2000-01-01',DB:{prepare,batch(statements){const next=tail.then(async()=>{raw.exec('BEGIN');try{const out=[];for(const s of statements)out.push(await s.run());raw.exec('COMMIT');return out}catch(e){raw.exec('ROLLBACK');throw e}});tail=next.catch(()=>{});return next}}};await ensureBudgetSchema(env);return env;
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
const FULL=[...Array(16).fill(3),...Array(26).fill(2)];           // 100
const GOOD=[...Array(16).fill(3),...Array(20).fill(2),...Array(6).fill(0)]; // 88 ดีมาก
const MID=[...Array(16).fill(2),...Array(26).fill(2)];             // 84
const LOW=[...Array(16).fill(1),...Array(26).fill(0)];             // 16
const manual={visit_date:'2030-01-07',period:2,supervision_type:'teaching',topic:'การใช้คำถาม',subject:'ภาษาไทย',grade_level:'ป.4',classroom:'1'};

test('scores: school form — 16 items 3/2/1 + 26 items 2/0, total out of 100 and quality bands',()=>{
 assert.deepEqual(summarizeScores(FULL),{total:100,percent:100,level:'ดีเยี่ยม'});
 assert.deepEqual(summarizeScores(GOOD),{total:88,percent:88,level:'ดีมาก'});
 assert.equal(summarizeScores(LOW).level,'ปรับปรุง');assert.equal(qualityLevel(80),'ดีมาก');assert.equal(qualityLevel(59.99),'ปรับปรุง');assert.equal(qualityLevel(60),'พอใช้');
 assert.equal(summarizeScores([5,4,5,4,5,5,4,5,4,5]),null,'old 10-item form rejected');
 assert.equal(summarizeScores([...FULL.slice(0,41),1]),null,'checklist item only 2 or 0');
 assert.equal(summarizeScores([0,...FULL.slice(1)]),null,'rating item only 3/2/1');
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
 const other=(await ok(env,'/api/supervision/requests','POST',{...manual,subject:'คณิตศาสตร์',grade_level:'ป.2'},3)).request.id;
 const clash=await json(env,`/api/supervision/requests/${other}/accept`,'POST',{},5);assert.equal(clash.status,409);assert.match(clash.body.error,/วันและคาบเดียวกัน/);
 await ok(env,`/api/supervision/requests/${other}/accept`,'POST',{},6);

 assert.equal((await json(env,`/api/supervision/requests/${id}/evaluate`,'POST',{scores:GOOD},6)).status,403,'only the accepting executive scores');
 assert.equal((await json(env,`/api/supervision/requests/${id}/evaluate`,'POST',{scores:GOOD.slice(0,10)},5)).status,400,'all 42 items required');
 const saved=await ok(env,`/api/supervision/requests/${id}/evaluate`,'POST',{scores:GOOD,suggestion:'ใช้คำถามปลายเปิดดีมาก'},5);
 assert.equal(saved.request.status,'evaluated');assert.equal(saved.request.evaluation.total,88);assert.equal(saved.request.evaluation.percent,88);assert.equal(saved.request.evaluation.level,'ดีมาก'); assert.equal(saved.request.type_label,'นิเทศการสอนและห้องเรียน');assert.equal(saved.request.evaluation.items.length,42);assert.equal(saved.request.evaluation.items[5].section,'ด้านที่ ๒ การจัดการเรียนการสอน');
 assert.equal(saved.request.evaluation.items[0].label,'ครูผู้สอนมีการวิเคราะห์หลักสูตร สอดคล้องมาตรฐานและบริบทผู้เรียน');assert.equal(saved.request.evaluation.items[41].max,2);assert.equal(saved.request.evaluation.items[41].group.startsWith('หมวดที่ 3'),true);
 assert.equal((await json(env,`/api/supervision/requests/${id}/evaluate`,'POST',{scores:LOW},5)).status,409,'cannot overwrite');
 assert.equal((await json(env,`/api/supervision/requests/${id}/cancel`,'POST',{},2)).status,409,'evaluated cannot be cancelled');

 const mine2=(await ok(env,'/api/supervision/requests?scope=mine','GET',undefined,2)).requests;
 assert.equal(mine2.length,1);assert.equal(mine2[0].evaluation.suggestion,'ใช้คำถามปลายเปิดดีมาก');assert.equal(mine2[0].evaluation.evaluator_name,'ผอ. ทดสอบ');
 const mine3=(await ok(env,'/api/supervision/requests?scope=mine','GET',undefined,3)).requests;
 assert.deepEqual(mine3.map(r=>r.id),[other],'teacher sees only own requests');
 assert((await ok(env,'/api/notifications','GET',undefined,2)).notifications.some(n=>/ผลการนิเทศของคุณพร้อมแล้ว/.test(n.message)));
 for(const u of [5,6,7,1]){const r=(await ok(env,'/api/supervision/requests?scope=all','GET',undefined,u)).requests.find(x=>x.id===id);assert.equal(r.evaluation.total,88,'executives, academic and admin see results: '+u);}
});

test('academic head appoints evaluators; appointed evaluators see only the results they scored',async()=>{
 const {env}=await school();
 const first=(await ok(env,'/api/supervision/requests','POST',manual,2)).request.id;
 await ok(env,`/api/supervision/requests/${first}/accept`,'POST',{},5);await ok(env,`/api/supervision/requests/${first}/evaluate`,'POST',{scores:MID},5);
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
 await ok(env,`/api/supervision/requests/${second}/evaluate`,'POST',{scores:MID},3);
 const all=(await ok(env,'/api/supervision/requests?scope=all','GET',undefined,3)).requests;
 assert.equal(all.find(r=>r.id===second).evaluation.percent,84);
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
 assert(n.groups.academic.some(i=>i.url==='/supervision-admin.html?view=results'&&i.label==='งานนิเทศภายใน'&&i.supervisionOnly==='view_all|manage_evaluators'));
 assert(n.groups.administration.some(i=>i.url==='/supervision-admin.html?view=summary'&&i.label==='ประเมินผลการนิเทศ'&&i.supervisionOnly==='view_all'));
 assert(!n.groups.personnel.some(i=>String(i.url).includes('supervision')),'no supervision menus left under personnel');
 assert.equal(n.parentFor('','/supervision-admin.html?view=results'),'academic');assert.equal(n.parentFor('','/supervision-admin.html?view=summary'),'administration');
 assert(!n.groups.academic.some(i=>i.url==='/supervision-admin.html?view=evaluators'),'evaluators folded into งานนิเทศภายใน');
 assert.equal(n.parentFor('supervision','/supervision.html'),'supervision');assert.equal(n.parentFor('','/supervision-admin.html?request=1'),'administration');
 assert.match(html,/data-supervision-only/);
});

test('a date + period accepts at most 3 registrations (3 evaluators); 4th is told the slot is full',async()=>{
 const {env}=await school();
 for(const [u,g] of [[2,'ป.4'],[3,'ป.1'],[7,'อ.2']])await ok(env,'/api/supervision/requests','POST',{...manual,grade_level:g},u);
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

test('same date + period: one registration per grade band (อนุบาล / ป.1–3 / ป.4–6)',async()=>{
 const {env}=await school();
 const r=await ok(env,'/api/supervision/requests','POST',{...manual,grade_level:'ป.5'},2);assert.equal(r.request.grade_band,'p46');
 const same=await json(env,'/api/supervision/requests','POST',{...manual,grade_level:'ป.6'},3);
 assert.equal(same.status,409);assert.match(same.body.error,/ช่วงชั้นป\.4–6/);
 await ok(env,'/api/supervision/requests','POST',{...manual,grade_level:'ป.3'},3);
 await ok(env,'/api/supervision/requests','POST',{...manual,grade_level:'อ.1'},7);
 const week=await ok(env,'/api/supervision/week?start=2030-01-07','GET',undefined,6);
 assert.deepEqual([...week.taken['2030-01-07|2']].sort(),['k','p13','p46']);
 assert.equal((await json(env,'/api/supervision/requests','POST',{...manual,grade_level:'ม.1'},6)).status,400,'unknown band');
 await ok(env,'/api/supervision/requests','POST',{...manual,period:3,grade_level:'ป.4'},6); // other period OK
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
 const full=await json(env,'/api/supervision/requests','POST',{...manual,grade_level:'ป.1'},3);assert.equal(full.status,409);assert.match(full.body.error,/คาบเต็ม/);
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

test('release: request leaves the releaser’s request list but stays pending for other evaluators',async()=>{
 const {env}=await school();
 const id=(await ok(env,'/api/supervision/requests','POST',manual,2)).request.id;
 await ok(env,`/api/supervision/requests/${id}/accept`,'POST',{},6);
 await ok(env,`/api/supervision/requests/${id}/release`,'POST',{},6);
 const mine=(await ok(env,'/api/supervision/requests?scope=all','GET',undefined,6)).requests.find(r=>r.id===id);
 assert.equal(mine.status,'pending');assert.equal(mine.released_by_me,true);assert.equal(mine.hidden_for_me,true,'hidden from the evaluator who released it');
 assert.equal((await ok(env,'/api/supervision/requests?scope=all','GET',undefined,5)).requests.find(r=>r.id===id).released_by_me,false,'others can still accept');
 await ok(env,`/api/supervision/requests/${id}/accept`,'POST',{},5);
 await ok(env,`/api/supervision/requests/${id}/release`,'POST',{note:'x'},5);
 // ผู้ประเมินทุกคนถอนแล้ว → กลับมาแสดงให้ทุกคน คำขอไม่หาย
 for(const u of [5,6])assert.equal((await ok(env,'/api/supervision/requests?scope=all','GET',undefined,u)).requests.find(r=>r.id===id).hidden_for_me,false,'visible again: '+u);
 await ok(env,`/api/supervision/requests/${id}/accept`,'POST',{a:1},6);
 assert.equal((await ok(env,'/api/supervision/requests?scope=all','GET',undefined,6)).requests.find(r=>r.id===id).released_by_me,false);
});

test('evaluator unavailable → teacher sends video link + images → evaluator notified and scores',async()=>{
 const {env}=await school();
 const id=(await ok(env,'/api/supervision/requests','POST',manual,2)).request.id;
 assert.equal((await json(env,`/api/supervision/requests/${id}/unavailable`,'POST',{},5)).status,403,'must accept first');
 await ok(env,`/api/supervision/requests/${id}/accept`,'POST',{},5);
 assert.equal((await json(env,`/api/supervision/requests/${id}/unavailable`,'POST',{},6)).status,403,'only the accepting evaluator');
 assert.equal((await json(env,`/api/supervision/requests/${id}/evidence`,'POST',{video_url:'https://youtu.be/x'},2)).status,409,'not requested yet');
 assert.equal((await json(env,`/api/supervision/requests/${id}/unavailable`,'POST',{note:'ติดประชุม'},5)).status,503,'Drive must be configured first');
 Object.assign(env,DRIVE);const realFetch=globalThis.fetch;globalThis.fetch=async()=>{throw new Error('Google Drive offline');};
 try{
 await ok(env,`/api/supervision/requests/${id}/unavailable`,'POST',{note:'ติดประชุม'},5);
 assert.equal((await json(env,`/api/supervision/requests/${id}/unavailable`,'POST',{note:'อีกครั้ง'},5)).status,409);
 const note=env.raw.prepare('SELECT message FROM supervision_notifications WHERE user_id=2 ORDER BY id DESC').get().message;
 assert.match(note,/ส่งลิงก์คลิปการสอน/);
 const r=(await ok(env,'/api/supervision/requests?scope=mine','GET',undefined,2)).requests.find(x=>x.id===id);
 assert.equal(r.evidence.note,'ติดประชุม');assert.equal(r.evidence.submitted_at,null);assert.equal(r.evidence.due_date,'2030-01-10','3 days after visit');
 assert.equal((await json(env,`/api/supervision/requests/${id}/evaluate`,'POST',{scores:MID},5)).status,409,'wait for evidence');
 // ภาพต้องอยู่ใน Drive: ยังไม่ได้ตั้งค่าจึงอัปโหลดไม่ได้
 const fd=new FormData();fd.append('file',new File([new Uint8Array([0xff,0xd8,0xff,0xe0,0,0,0,0,0,0,0,0,0,0,0,0])],'a.jpg',{type:'image/jpeg'}));
 const token=await signJWT({sub:2},env.JWT_SECRET);
 const up=await worker.fetch(new Request(`https://school.test/api/supervision/evidence/${id}/images`,{method:'POST',headers:{Cookie:`bpd_session=${token}`},body:fd}),env,{});
 assert.equal(up.status,502);assert.match((await up.json()).error,/Google Drive/);
 assert.equal(env.raw.prepare('SELECT COUNT(*) n FROM supervision_evidence_files').get().n,0);
 assert.equal((await json(env,`/api/supervision/requests/${id}/evidence`,'POST',{video_url:'https://youtu.be/x'},3)).status,403,'only the owner');
 assert.equal((await json(env,`/api/supervision/requests/${id}/evidence`,'POST',{video_url:'javascript:alert(1)'},2)).status,400);
 assert.equal((await json(env,`/api/supervision/requests/${id}/evidence`,'POST',{video_url:'https://youtu.be/x'},2)).status,400,'needs at least one image');
 env.raw.prepare("INSERT INTO supervision_evidence_files(request_id,drive_file_id,file_name,mime_type,file_size,uploaded_by) VALUES(?,?,?,?,?,?)").run(id,'drv1','a.jpg','image/jpeg',10,2);
 await ok(env,`/api/supervision/requests/${id}/evidence`,'POST',{video_url:'https://youtu.be/abc'},2);
 assert.match(env.raw.prepare('SELECT message FROM supervision_notifications WHERE user_id=5 ORDER BY id DESC').get().message,/ส่งลิงก์คลิปการสอนและภาพ 1 ภาพ/);
 const seen=(await ok(env,'/api/supervision/requests?scope=all','GET',undefined,5)).requests.find(x=>x.id===id);
 assert.equal(seen.evidence.video_url,'https://youtu.be/abc');assert.equal(seen.evidence.files.length,1);
 const fid=seen.evidence.files[0].id;
 assert.equal((await call(env,`/api/supervision/evidence/files/${fid}`,'GET',undefined,3)).status,404,'other teachers cannot view');
 await ok(env,'/api/supervision/evaluators','POST',{user_id:3},1);
 assert.equal((await ok(env,'/api/supervision/requests?scope=all','GET',undefined,3)).requests.find(x=>x.id===id).evidence,undefined,'appointed evaluator not responsible sees no evidence');
 await ok(env,`/api/supervision/requests/${id}/evaluate`,'POST',{scores:MID},5);
 assert.equal((await json(env,`/api/supervision/evidence/files/${fid}`,'DELETE',undefined,2)).status,409,'locked after evaluation');
 }finally{globalThis.fetch=realFetch;}
});

test('evidence: release with nothing sent clears the request; cancel purges files; cron reminds and flags overdue',async()=>{
 const {env}=await school();Object.assign(env,DRIVE);
 const realFetch=globalThis.fetch;globalThis.fetch=async()=>{throw new Error('offline');};
 try{
  const id=(await ok(env,'/api/supervision/requests','POST',manual,2)).request.id;
  await ok(env,`/api/supervision/requests/${id}/accept`,'POST',{},5);
  await ok(env,`/api/supervision/requests/${id}/unavailable`,'POST',{},5);
  await ok(env,`/api/supervision/requests/${id}/release`,'POST',{},5);
  assert.equal(env.raw.prepare('SELECT evidence_requested_at v FROM supervision_requests WHERE id=?').get(id).v,null,'cleared: teacher sent nothing');
  await ok(env,`/api/supervision/requests/${id}/accept`,'POST',{},6);
  await ok(env,`/api/supervision/requests/${id}/unavailable`,'POST',{n:2},6);
  // cron: ก่อน 07:00 ไม่เตือน, หลังจากนั้นวันละครั้ง, เลยกำหนดแจ้งผู้ประเมินครั้งเดียว
  const count=u=>env.raw.prepare('SELECT COUNT(*) n FROM supervision_notifications WHERE user_id=?').get(u).n;
  env.raw.prepare("UPDATE supervision_requests SET evidence_reminded_on=NULL WHERE id=?").run(id);
  const t0=count(2),s0=count(6);
  await supervisionMaintenance(env,{remove:async()=>{}},{date:'2030-01-08',minutes:6*60});assert.equal(count(2),t0);
  await supervisionMaintenance(env,{remove:async()=>{}},{date:'2030-01-08',minutes:8*60});assert.equal(count(2),t0+1);
  await supervisionMaintenance(env,{remove:async()=>{}},{date:'2030-01-08',minutes:9*60});assert.equal(count(2),t0+1,'once a day');
  await supervisionMaintenance(env,{remove:async()=>{}},{date:'2030-01-12',minutes:8*60});assert.equal(count(2),t0+2);assert.equal(count(6),s0+1,'evaluator told when overdue');
  await supervisionMaintenance(env,{remove:async()=>{}},{date:'2030-01-13',minutes:8*60});assert.equal(count(6),s0+1,'overdue told once');
  // ครูยกเลิกนัด → ลบภาพ; Drive ลบไม่ได้ → เก็บไว้ลองลบซ้ำใน cron
  env.raw.prepare("INSERT INTO supervision_evidence_files(request_id,drive_file_id,file_name,mime_type,file_size,uploaded_by) VALUES(?,?,?,?,?,?)").run(id,'drvX','a.jpg','image/jpeg',10,2);
  env.raw.prepare("UPDATE supervision_requests SET visit_date='2099-01-07' WHERE id=?").run(id);
  await ok(env,`/api/supervision/requests/${id}/cancel`,'POST',{},2);
  assert.equal(env.raw.prepare('SELECT COUNT(*) n FROM supervision_evidence_files').get().n,0);
  assert.equal(env.raw.prepare('SELECT COUNT(*) n FROM supervision_drive_trash').get().n,1);
  const r=await supervisionMaintenance(env,{remove:async()=>{}},{date:'2030-01-13',minutes:8*60});
  assert.equal(r.trashed,1);assert.equal(env.raw.prepare('SELECT COUNT(*) n FROM supervision_drive_trash').get().n,0);
 }finally{globalThis.fetch=realFetch;}
});

test('switching to the school form clears old-form results; requests go back to awaiting scores',async()=>{
 const {env}=await school();
 const id=(await ok(env,'/api/supervision/requests','POST',manual,2)).request.id;
 await ok(env,`/api/supervision/requests/${id}/accept`,'POST',{},5);
 const old=JSON.stringify(Array.from({length:10},(_,i)=>({section:'ด้านการสอน',label:'ข้อ '+i,score:4})));
 env.raw.prepare("INSERT INTO supervision_evaluations(request_id,evaluator_user_id,items_json,total,percent,quality_level) VALUES(?,?,?,?,?,?)").run(id,5,old,40,80,'ดีมาก');
 env.raw.prepare("UPDATE supervision_requests SET status='evaluated' WHERE id=?").run(id);
 const fresh={...env,DB:{...env.DB}}; // new isolate → schema check runs again
 const r=(await ok(fresh,'/api/supervision/requests?scope=mine','GET',undefined,2)).requests.find(x=>x.id===id);
 assert.equal(r.status,'confirmed');assert.equal(r.supervisor_user_id,5);assert.equal(r.evaluation,undefined);
 await ok(fresh,`/api/supervision/requests/${id}/evaluate`,'POST',{scores:FULL},5);
 const again={...env,DB:{...env.DB}};
 assert.equal((await ok(again,'/api/supervision/requests?scope=mine','GET',undefined,2)).requests.find(x=>x.id===id).evaluation.total,100,'new-form results are kept');
});

test('request lists include the director (not deputy) for the print form signature',async()=>{
 const {env}=await school();
 const mine=await ok(env,'/api/supervision/requests?scope=mine','GET',undefined,2);
 assert.deepEqual(mine.director,{name:'ผอ. ทดสอบ',position:'ผู้อำนวยการโรงเรียน'});
 assert.equal((await ok(env,'/api/supervision/requests?scope=all','GET',undefined,6)).director.name,'ผอ. ทดสอบ');
});

test('registration stays closed before the open date for teachers, superadmin may still book',async()=>{
 const {registrationClosed}=await import('../src/routes/supervision.js');
 const env={SUPERVISION_OPEN_DATE:'2026-11-02'};
 assert.equal(registrationClosed(env,{role:'teacher'},{date:'2026-11-01',minutes:1439}),true);
 assert.equal(registrationClosed(env,{role:'teacher'},{date:'2026-11-02',minutes:0}),false);
 assert.equal(registrationClosed(env,{role:'superadmin'},{date:'2026-10-30',minutes:0}),false);
 assert.equal(registrationClosed({},{role:'teacher'},{date:'2026-10-30',minutes:0}),true);
});
