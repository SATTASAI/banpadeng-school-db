import test from "node:test";
import assert from "node:assert/strict";
import { fixture, call } from "./notifications.test.mjs";
import { dispatchLineNotifications, buildLineDigest } from "../src/lib/line-feed.js";
import { linkedLineAccounts } from "../src/lib/line-personal.js";
import worker from "../src/index.js";

function mockLine(quota = { type: "none" }, usage = 0) {
  const pushes = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    if (u.endsWith("/v2/bot/message/push")) { pushes.push(JSON.parse(init.body)); return new Response("{}", { status: 200 }); }
    if (u.endsWith("/v2/bot/message/quota")) return Response.json(quota);
    if (u.endsWith("/v2/bot/message/quota/consumption")) return Response.json({ totalUsage: usage });
    return new Response("{}", { status: 404 });
  };
  return { pushes, restore: () => { globalThis.fetch = original; } };
}

async function setup() {
  const env = await fixture();
  env.LINE_CHANNEL_ACCESS_TOKEN = "token";
  env.PUBLIC_BASE_URL = "https://school.test";
  await call(env, "/api/overview");
  await call(env, "/api/notifications", "GET", undefined, 2);
  env.raw.exec(`CREATE TABLE IF NOT EXISTS line_user_links(user_id INTEGER PRIMARY KEY,line_user_id TEXT NOT NULL UNIQUE,display_name TEXT,
    status TEXT NOT NULL DEFAULT 'active',linked_at TEXT NOT NULL DEFAULT(datetime('now')),updated_at TEXT NOT NULL DEFAULT(datetime('now')));
    INSERT INTO line_user_links(user_id,line_user_id) VALUES(2,'U-teacher'),(3,'U-other');
    INSERT INTO tasks(id,title,created_by) VALUES(1,'งานค้างเดิม',1);INSERT INTO task_assignees(task_id,user_id) VALUES(1,2);`);
  return env;
}
const unlock = (env) => { try { env.raw.exec("UPDATE line_feed_runs SET started_at=NULL"); } catch {} };

test("digest text links straight to a single item or to the dashboard for several", () => {
  const one = buildLineDigest([{ title: "สอนแทน", message: "คาบ 2", url: "/substitutes.html" }], "https://s.test");
  assert.match(one, /https:\/\/s\.test\/substitutes\.html/);
  const many = buildLineDigest(Array.from({ length: 7 }, (_, i) => ({ title: `เรื่อง ${i}`, message: "x", url: "/x" })), "https://s.test");
  assert.match(many, /มีแจ้งเตือนใหม่ 7 รายการ/);
  assert.match(many, /และอีก 2 รายการ/);
  assert.match(many, /dashboard\.html/);
});

test("first run records the backlog, later events are pushed once per person and respect opt-out", async () => {
  const env = await setup();
  const line = mockLine();
  try {
    await dispatchLineNotifications(env);
    assert.equal(line.pushes.length, 0, "backlog is not sent when LINE is first linked");
    env.raw.exec(`INSERT INTO tasks(id,title,created_by) VALUES(2,'ส่งแผนการสอน',1),(3,'ประชุมกลุ่มสาระ',1);
      INSERT INTO task_assignees(task_id,user_id) VALUES(2,2),(3,2),(3,3);`);
    unlock(env);
    const run = await dispatchLineNotifications(env);
    assert.equal(run.messages_sent, 2);
    const teacher = line.pushes.find((p) => p.to === "U-teacher");
    assert.match(teacher.messages[0].text, /มีแจ้งเตือนใหม่ 2 รายการ/);
    assert.doesNotMatch(teacher.messages[0].text, /งานค้างเดิม/);
    unlock(env);
    await dispatchLineNotifications(env);
    assert.equal(line.pushes.length, 2, "nothing is sent twice");
    // ปิดรับทาง LINE
    assert.equal((await call(env, "/api/line/link", "PATCH", { notify_all: false }, 3)).status, 200);
    env.raw.exec("INSERT INTO tasks(id,title,created_by) VALUES(4,'งานใหม่',1);INSERT INTO task_assignees(task_id,user_id) VALUES(4,2),(4,3);");
    unlock(env);
    await dispatchLineNotifications(env);
    assert.deepEqual(line.pushes.slice(2).map((p) => p.to), ["U-teacher"]);
    // ถูกล็อกเมื่อรันถี่เกินไป
    assert.equal((await dispatchLineNotifications(env)).skipped, "locked");
  } finally { line.restore(); }
});

test("quota reserve stops general pushes and a saved request triggers delivery right away", async () => {
  const env = await setup();
  const line = mockLine({ type: "limited", value: 300 }, 285);
  try {
    await dispatchLineNotifications(env);
    env.raw.exec("INSERT INTO tasks(id,title,created_by) VALUES(5,'งานด่วน',1);INSERT INTO task_assignees(task_id,user_id) VALUES(5,2);");
    unlock(env);
    const run = await dispatchLineNotifications(env);
    assert.equal(run.messages_sent, 0);
    assert.match(run.note, /โควตา/);
  } finally { line.restore(); }
  const ok = mockLine();
  try {
    unlock(env);
    const pending = [];
    const response = await worker.fetch(new Request("https://school.test/api/notifications/read", { method: "POST" }), env, { waitUntil: (p) => pending.push(p) });
    assert.equal(response.status, 401);
    assert.equal(pending.length, 0, "failed or excluded requests do not trigger LINE");
    const { signJWT } = await import("../src/lib/crypto.js");
    const token = await signJWT({ sub: 1 }, env.JWT_SECRET);
    await worker.fetch(new Request("https://school.test/api/line/link", { method: "PATCH", headers: { Cookie: `bpd_session=${token}`, "Content-Type": "application/json" }, body: JSON.stringify({ notify_all: true }) }), env, { waitUntil: (p) => pending.push(p) });
    assert.equal(pending.length, 1);
    await Promise.all(pending);
    assert.equal(ok.pushes.length, 1);
    assert.match(ok.pushes[0].messages[0].text, /งานด่วน/);
  } finally { ok.restore(); }
});

test("LINE goes only to the person who must act: finance queue to the finance officer, never one's own action", async () => {
  const env = await setup();
  env.raw.exec(`INSERT INTO users(id,email,password_hash,password_salt,full_name,role) VALUES(4,'exec@test','x','x','รองผอ','executive');
    INSERT INTO line_user_links(user_id,line_user_id) VALUES(4,'U-exec'),(1,'U-admin');
    INSERT OR REPLACE INTO budget_role_assignments(role_key,department,user_id) VALUES('finance_review','',3);`);
  const line = mockLine();
  try {
    await dispatchLineNotifications(env);
    env.raw.exec(`INSERT INTO project_expenses(id,project_id,fiscal_year,expense_date,description,amount,status,created_by) VALUES(900,10,2569,'2026-10-01','x',1,'pending',2);
      INSERT INTO project_workflow_events(token,expense_id,project_id,event_type,message,actor_id) VALUES('q1',900,10,'submit','มีคำขอเบิกจ่ายใหม่',2),('r1',900,10,'receive','การเงินรับเรื่องแล้ว',3);
      INSERT INTO project_notifications(event_token,user_id,audience) VALUES('q1',1,'finance'),('q1',3,'finance'),('q1',4,'finance'),('r1',2,'owners'),('r1',3,'owners');`);
    unlock(env);
    await dispatchLineNotifications(env);
    const to = line.pushes.map((p) => p.to).sort();
    assert.deepEqual(to, ["U-other", "U-teacher"], "finance officer gets the queue; owner gets receipt; executive/admin and the actor do not");
    const finance = line.pushes.find((p) => p.to === "U-other").messages[0].text;
    assert.match(finance, /มีคำขอเบิกจ่ายใหม่/);
    assert.doesNotMatch(finance, /รับเรื่องแล้ว/);
    const bell = await (await call(env, "/api/notifications", "GET", undefined, 4)).json();
    assert(bell.notifications.some((n) => n.message === "มีคำขอเบิกจ่ายใหม่"), "executives still see it in the in-app bell");
    assert(!("line_ok" in bell.notifications[0]));
  } finally { line.restore(); }
});

test("a new leave pushes LINE to personnel head and designated deputy without early action permission",async()=>{
 const env=await setup();
 env.raw.exec(`INSERT INTO users(id,email,password_hash,password_salt,full_name,role) VALUES
 (4,'director-leave@test','x','x','ผอ. ตัวอย่าง','executive'),(5,'deputy-leave@test','x','x','รอง ผอ. บุคลากร','executive'),(6,'other-deputy@test','x','x','รอง ผอ. ฝ่ายอื่น','executive');
 INSERT INTO staff_profiles(user_id,position) VALUES
 (4,'ผู้อำนวยการโรงเรียนบ้านป่าเด็ง'),(5,'รองผู้อำนวยการโรงเรียนบ้านป่าเด็ง'),(6,'รองผู้อำนวยการโรงเรียนบ้านป่าเด็ง');
 INSERT INTO personnel_records(user_id,full_name,normalized_name,position) VALUES
 (4,'ผอ. ตัวอย่าง','ผอตัวอย่าง','ผู้อำนวยการโรงเรียนบ้านป่าเด็ง'),
 (5,'รอง ผอ. บุคลากร','รองผอบุคลากร','รองผู้อำนวยการโรงเรียนบ้านป่าเด็ง'),
 (6,'รอง ผอ. ฝ่ายอื่น','รองผอฝ่ายอื่น','รองผู้อำนวยการโรงเรียนบ้านป่าเด็ง');
 INSERT INTO personnel_accounts(user_id,personnel_id)
 SELECT user_id,id FROM personnel_records WHERE user_id IN (4,5,6);
 INSERT INTO line_user_links(user_id,line_user_id) VALUES(5,'U-deputy'),(6,'U-other-deputy');`);
 const head=env.raw.prepare('SELECT id FROM personnel_records WHERE user_id=3').get();
 assert.equal((await call(env,'/api/department-staff/personnel','POST',{personnel_id:head.id,is_head:true})).status,200);
 const deputy=env.raw.prepare('SELECT id FROM personnel_records WHERE user_id=5').get().id;
 env.raw.prepare('INSERT INTO leave_settings(id,deputy_personnel_id) VALUES(1,?)').run(deputy);
 const line=mockLine();
 try {
  await dispatchLineNotifications(env);
  const form={leave_type:'sick',reason:'ไม่สบาย',position:'ครู',start_date:'2026-10-19',end_date:'2026-10-19',contact_address:'บ้านพัก',contact_phone:'0000000000'};
  const response=await call(env,'/api/leave-requests','POST',form,2);
  assert.equal(response.status,201);
  const {id}=await response.json();
  unlock(env);
  await dispatchLineNotifications(env);
  assert.deepEqual(line.pushes.map(p=>p.to).sort(),['U-deputy','U-other']);
  assert(line.pushes.every(p=>p.messages[0].text.includes('การลา: ครู ก')));
  assert.equal((await call(env,`/api/leave-requests/${id}`,'PATCH',{action:'review',note:'ยังไม่ถึงคิว'},5)).status,403);
  assert.equal((await call(env,`/api/leave-requests/${id}`,'PATCH',{action:'forward',deputy_personnel_id:deputy},5)).status,403);
  assert.equal((await call(env,`/api/leave-requests/${id}`,'PATCH',{action:'acknowledge'},3)).status,200);
  assert.equal((await call(env,`/api/leave-requests/${id}`,'PATCH',{action:'forward',deputy_personnel_id:deputy},3)).status,200);
  unlock(env);
  await dispatchLineNotifications(env);
  assert.deepEqual(line.pushes.map(p=>p.to).sort(),['U-deputy','U-deputy','U-other']);
  const inbox=await (await call(env,'/api/leave-requests','GET',undefined,5)).json();
  assert.equal(inbox.leave_requests.find(r=>r.id===id).can_review,true);
 } finally {line.restore();}
});
test('first feed after a linked deputy receives a new leave, including one already read in the bell',async()=>{
 const env=await setup();
 env.raw.exec(`INSERT INTO users(id,email,password_hash,password_salt,full_name,role) VALUES(5,'deputy-first@test','x','x','รอง ผอ.','executive');
 INSERT INTO staff_profiles(user_id,position) VALUES(5,'รองผู้อำนวยการโรงเรียนบ้านป่าเด็ง');
 INSERT INTO personnel_records(user_id,full_name,normalized_name,position) VALUES(5,'รอง ผอ.','รองผอ','รองผู้อำนวยการโรงเรียนบ้านป่าเด็ง');
 INSERT INTO personnel_accounts(user_id,personnel_id) SELECT user_id,id FROM personnel_records WHERE user_id=5;
 INSERT INTO line_user_links(user_id,line_user_id,linked_at) VALUES(5,'U-first',datetime('now','-1 hour'))`);
 const head=env.raw.prepare('SELECT id FROM personnel_records WHERE user_id=3').get().id;
 await call(env,'/api/department-staff/personnel','POST',{personnel_id:head,is_head:true});
 const deputy=env.raw.prepare('SELECT id FROM personnel_records WHERE user_id=5').get().id;
 await call(env,'/api/leave-settings','PATCH',{deputy_personnel_id:deputy},3);
 const {id}=await (await call(env,'/api/leave-requests','POST',{leave_type:'sick',reason:'ทดสอบแจ้งเตือน',position:'ครู',start_date:'2026-10-19',end_date:'2026-10-19',contact_address:'บ้าน',contact_phone:'0000000000'},2)).json();
 await call(env,'/api/notifications/read','POST',{message_key:`leave:${id}:pending`},5);
 const line=mockLine();
 try{
  await dispatchLineNotifications(env);
  assert(line.pushes.some(p=>p.to==='U-first'&&p.messages[0].text.includes('การลา: ครู ก')));
  assert.equal(env.raw.prepare("SELECT status FROM line_feed_sent WHERE user_id=5 AND message_key=?").get(`leave:${id}:pending`).status,'sent');
 }finally{line.restore();}
});

test('a failed LINE push is retried by cron and marked sent, without a duplicate after success',async()=>{
 const env=await setup();
 const original=globalThis.fetch;let attempts=0;
 globalThis.fetch=async(url,init={})=>{
  if(String(url).endsWith('/v2/bot/message/push'))return new Response(attempts++===0?'temporary':'{}',{status:attempts===1?503:200});
  if(String(url).endsWith('/v2/bot/message/quota'))return Response.json({type:'none'});
  return Response.json({totalUsage:0});
 };
 try{
  await dispatchLineNotifications(env);
  env.raw.exec("INSERT INTO tasks(id,title,created_by) VALUES(9,'งานใหม่',1); INSERT INTO task_assignees(task_id,user_id) VALUES(9,2);");
  unlock(env);assert.equal((await dispatchLineNotifications(env)).failures,1);
  assert.equal(env.raw.prepare("SELECT status FROM line_feed_sent WHERE user_id=2 AND message_key='task:9'").get().status,'failed');
  env.raw.exec("UPDATE line_feed_sent SET updated_at=datetime('now','-2 minutes') WHERE user_id=2 AND message_key='task:9'");
  unlock(env);assert.equal((await dispatchLineNotifications(env)).messages_sent,1);
  unlock(env);await dispatchLineNotifications(env);
  assert.equal(attempts,2);
  assert.equal(env.raw.prepare("SELECT status FROM line_feed_sent WHERE user_id=2 AND message_key='task:9'").get().status,'sent');
 }finally{globalThis.fetch=original;}
});

test('deputy receives the leave through an existing LINE match on another login of the same personnel',async()=>{
 const env=await setup();
 env.raw.exec(`INSERT INTO users(id,email,password_hash,password_salt,full_name,role) VALUES
 (5,'deputy-main@test','x','x','รอง ผอ.','executive'),
 (7,'deputy-old@test','x','x','บัญชีครูเดิมของรอง ผอ.','teacher'),
 (8,'head-old@test','x','x','บัญชีครูเดิมหัวหน้า','teacher');
 INSERT INTO personnel_records(user_id,full_name,normalized_name,position) VALUES
 (5,'รอง ผอ.','รองผอร่วมบัญชี','รองผู้อำนวยการโรงเรียนบ้านป่าเด็ง');
 INSERT INTO personnel_accounts(user_id,personnel_id)
 SELECT user_id,id FROM personnel_records WHERE user_id=5;
 INSERT INTO personnel_accounts(user_id,personnel_id)
 SELECT 7,id FROM personnel_records WHERE user_id=5;
 INSERT INTO personnel_accounts(user_id,personnel_id)
 SELECT 8,id FROM personnel_records WHERE user_id=3;
 INSERT INTO line_user_links(user_id,line_user_id,linked_at) VALUES(7,'U-shared-deputy',datetime('now','-1 hour'));`);
 const deputy=env.raw.prepare('SELECT id FROM personnel_records WHERE user_id=5').get().id;
 const head=env.raw.prepare('SELECT id FROM personnel_records WHERE user_id=3').get().id;
 await call(env,'/api/department-staff/personnel','POST',{personnel_id:head,is_head:true});
 assert.equal((await call(env,'/api/leave-settings','PATCH',{deputy_personnel_id:deputy},3)).status,200);
 const settings=await (await call(env,'/api/leave-settings','GET',undefined,3)).json();
 assert.equal(settings.deputies.find(p=>p.id===deputy).line_status,'active');
 const line=mockLine();
 try{
  await dispatchLineNotifications(env);
  const {id}=await (await call(env,'/api/leave-requests','POST',{leave_type:'sick',reason:'ทดสอบบัญชีร่วม',position:'ครู',start_date:'2026-10-19',end_date:'2026-10-19',contact_address:'บ้าน',contact_phone:'0000000000'},2)).json();
  unlock(env);await dispatchLineNotifications(env);
  assert.equal(line.pushes.filter(p=>p.to==='U-shared-deputy'&&p.messages[0].text.includes(`request=${id}`)).length,1);
  assert.equal(line.pushes.filter(p=>p.to==='U-other'&&p.messages[0].text.includes('การลา: ครู ก')).length,1,'the head gets only one copy across both accounts');
  assert.equal((await call(env,`/api/leave-requests/${id}`,'PATCH',{action:'review',note:'ก่อนส่งต่อ'},5)).status,403);
 }finally{line.restore();}
});
test('shared personnel lookup refuses ambiguous LINE matches and a blocked direct match',async()=>{
 const env=await setup();
 env.raw.exec(`INSERT INTO users(id,email,password_hash,password_salt,full_name,role) VALUES
 (5,'executive-ambiguous@test','x','x','รอง ผอ.','executive'),
 (6,'old-one@test','x','x','บัญชีเก่า ก','teacher'),
 (7,'old-two@test','x','x','บัญชีเก่า ข','teacher');
 INSERT INTO personnel_records(user_id,full_name,normalized_name,position) VALUES(5,'รอง ผอ.','รองผอทดสอบ','รองผู้อำนวยการ');
 INSERT INTO personnel_accounts(user_id,personnel_id)
 SELECT 5,id FROM personnel_records WHERE user_id=5;
 INSERT INTO personnel_accounts(user_id,personnel_id)
 SELECT 6,id FROM personnel_records WHERE user_id=5;
 INSERT INTO personnel_accounts(user_id,personnel_id)
 SELECT 7,id FROM personnel_records WHERE user_id=5;
 INSERT INTO line_user_links(user_id,line_user_id) VALUES(6,'U-one'),(7,'U-two');`);
 assert(!((await linkedLineAccounts(env)).some(p=>p.user_id===5)));
 env.raw.exec("INSERT INTO line_user_links(user_id,line_user_id,status) VALUES(5,'U-blocked','blocked')");
 assert(!((await linkedLineAccounts(env)).some(p=>p.user_id===5)));
});
