import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {licenseReminderQuery, LICENSE_RENEWAL_URL} from '../src/lib/license-reminders.js';
import {fixture, call} from './notifications.test.mjs';
import {ensurePersonnelData} from '../src/lib/personnel-data.js';
import {dispatchLineNotifications, buildLineDigest} from '../src/lib/line-feed.js';
import {dispatchPushNotifications,pushPrefs} from '../src/lib/push-feed.js';

function database() {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE users(id INTEGER, status TEXT, deleted_at TEXT, role TEXT);
    CREATE TABLE personnel_records(id INTEGER,user_id INTEGER,status TEXT,employment_status TEXT,license_expiry_date TEXT);
    CREATE TABLE personnel_accounts(user_id INTEGER,personnel_id INTEGER);
    INSERT INTO users VALUES(1,'active',NULL,'teacher'),(2,'active',NULL,'teacher');
    INSERT INTO personnel_records VALUES(11,1,'active','working','2027-02-05');`);
  return db;
}
function reminders(db, now='2026-11-08T01:00:00Z', user=1) {
  const q=licenseReminderQuery(user,true,now);
  return db.prepare(`WITH messages(message_key,title,message,created_at,url,read_at,actor_id,line_ok) AS (${q.sql}) SELECT * FROM messages`).all(...q.values);
}
test('Bangkok 08:00 boundary, strict <90 days, expired and invalid dates, private recipients',()=>{
  const db=database();
  assert.equal(reminders(db).length,1); // 89 days
  assert.equal(reminders(db,'2026-11-08T00:59:59Z').length,0);
  assert.equal(reminders(db,undefined,2).length,0);
  let row=reminders(db)[0];
  assert.equal(row.message_key,'license:11:2026-11-08');
  assert.match(row.message,/เหลือ 89 วัน/);
  assert.ok(row.message.includes(LICENSE_RENEWAL_URL));
  assert.equal(row.created_at,'2026-11-08 01:00:00');
  for(const [date,count,pattern] of [
    ['2027-02-06',0],['2026-11-08',1,/หมดอายุวันนี้/],['2026-11-07',1,/หมดอายุแล้ว 1 วัน/],
    ['2030-01-01',0],['',0],[null,0],['2026-02-30',0],['nonsense',0],
  ]) {
    db.prepare('UPDATE personnel_records SET license_expiry_date=?').run(date);
    const rows=reminders(db);assert.equal(rows.length,count,String(date));
    if(pattern)assert.match(rows[0].message,pattern);
  }
  db.exec("UPDATE personnel_records SET license_expiry_date='2026-11-08'; INSERT INTO personnel_accounts VALUES(2,11)");
  assert.equal(reminders(db,undefined,2)[0].message_key,reminders(db)[0].message_key);
  db.exec("UPDATE personnel_records SET employment_status='retired'");assert.equal(reminders(db).length,0);
  db.exec("UPDATE personnel_records SET employment_status='working',status='inactive'");assert.equal(reminders(db).length,0);
  db.exec("UPDATE personnel_records SET status='active'; UPDATE users SET status='suspended' WHERE id=1");assert.equal(reminders(db).length,0);
});

test('daily keys survive same-day edits and LINE digest always includes renewal link even in a batch',()=>{
  const db=database(), first=reminders(db)[0];
  db.exec("UPDATE personnel_records SET license_expiry_date='2026-11-10'");
  assert.equal(reminders(db)[0].message_key,first.message_key);
  assert.notEqual(reminders(db,'2026-11-09T01:00:00Z')[0].message_key,first.message_key);
  const digest=buildLineDigest([first,{title:'อื่น',message:'งาน',url:'/tasks.html'}]);
  assert.ok(digest.includes(LICENSE_RENEWAL_URL));
  assert.match(digest,/อัปเดตวันหมดอายุ/);
});

test('LINE and School Notify deliver on first run once daily despite reading; renewing stops both',async()=>{
  const env=await fixture();
  await call(env,'/api/overview');await ensurePersonnelData(env);
  await pushPrefs(env,{id:2});env.raw.exec("INSERT INTO push_feed_users(user_id,started_at) VALUES(2,'2000-01-01')");
  const today=env.raw.prepare("SELECT date('now','+7 hours') day").get().day;
  env.raw.exec(`UPDATE personnel_records SET license_expiry_date=NULL,user_id=CASE WHEN user_id=2 THEN NULL ELSE user_id END;
    DELETE FROM personnel_accounts WHERE user_id=2;
    INSERT INTO personnel_records(id,user_id,full_name,normalized_name,license_expiry_date) VALUES(9001,2,'License Test','license-test','${today}');
    INSERT INTO personnel_accounts(user_id,personnel_id) VALUES(2,9001);`);
  let clock=today+'T01:00:00Z';
  const prepare=env.DB.prepare;
  env.DB.prepare=(sql)=>{
    const stmt=prepare(sql);
    if(sql.includes('datetime(?,\'+7 hours\') local_now')){
      const bind=stmt.bind;
      stmt.bind=function(...v){return bind.apply(this,v.map(x=>x==='now'?clock:x));};
    }
    return stmt;
  };
  env.LINE_CHANNEL_ACCESS_TOKEN='test';env.NOTIFY_API_KEY='test';env.PUSH_PILOT_ROLES='all';
  await call(env,'/api/line/status','GET',undefined,2);
  env.raw.exec(`INSERT INTO line_user_links(user_id,line_user_id) VALUES(2,'U-license')`);
  const original=globalThis.fetch, line=[], push=[];
  globalThis.fetch=async(url,init={})=>{
    const path=new URL(url).pathname;
    if(path==='/v2/bot/message/push'){line.push(JSON.parse(init.body));return Response.json({});}
    if(path==='/v2/bot/message/quota')return Response.json({type:'none'});
    if(path==='/v2/bot/message/quota/consumption')return Response.json({totalUsage:0});
    if(path==='/api/refs')return Response.json({refs:['u:2','u:3']});
    if(path==='/api/notifications'){push.push(JSON.parse(init.body));return Response.json({});}
    return new Response('{}',{status:404});
  };
  const run=async()=>{
    env.raw.exec('UPDATE line_feed_runs SET started_at=NULL');
    env.raw.exec("UPDATE push_feed_state SET started_at='2000-01-01'");
    await dispatchLineNotifications(env);await dispatchPushNotifications(env);
  };
  try{
    // Reading in the school UI does not cancel the scheduled daily delivery.
    const before=await (await call(env,'/api/notifications','GET',undefined,2)).json();
    const key=before.notifications.find(r=>r.message_key.startsWith('license:')).message_key;
    await call(env,'/api/notifications/read','POST',{message_key:key},2);
    await dispatchLineNotifications(env);await dispatchPushNotifications(env);
    assert.equal(line.length,1);assert.equal(push.length,1);
    assert.deepEqual(push[0].refs,['u:2']);assert.equal(line[0].to,'U-license');
    assert.ok(line[0].messages[0].text.includes(LICENSE_RENEWAL_URL));assert.ok(push[0].body.includes(LICENSE_RENEWAL_URL));
    assert.equal(push[0].url,LICENSE_RENEWAL_URL);assert.deepEqual(push[0].actions,[{title:'ต่ออายุใบประกอบวิชาชีพ',url:LICENSE_RENEWAL_URL}]);
    await run();assert.equal(line.length,1);assert.equal(push.length,1);
    clock=env.raw.prepare("SELECT datetime(?,'+1 day') day").get(clock).day+'Z';
    await run();assert.equal(line.length,2);assert.equal(push.length,2);
    env.raw.exec("UPDATE personnel_records SET license_expiry_date='2035-01-01' WHERE id=9001");
    clock=env.raw.prepare("SELECT datetime(?,'+1 day') day").get(clock).day+'Z';
    await run();assert.equal(line.length,2);assert.equal(push.length,2);
  }finally{globalThis.fetch=original;}
});
