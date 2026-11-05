import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { signJWT } from "../src/lib/crypto.js";
import { handleMeritRoute, parseDate, periodOf } from "../src/routes/student-merit.js";

const secret = "merit-test";
function environment() {
  const db = new DatabaseSync(":memory:");
  db.exec(`CREATE TABLE users(id INTEGER PRIMARY KEY,email TEXT,full_name TEXT,role TEXT,status TEXT,created_at TEXT,deleted_at TEXT);
    CREATE TABLE academic_years(id INTEGER PRIMARY KEY,year_be INTEGER,status TEXT);
    CREATE TABLE academic_terms(id INTEGER PRIMARY KEY,academic_year_id INTEGER,term_number INTEGER,start_date TEXT,end_date TEXT,status TEXT);
    CREATE TABLE gr_homerooms(academic_year_id INTEGER,grade_level TEXT,classroom TEXT,user_id INTEGER);
    CREATE TABLE budget_role_assignments(role_key TEXT,department TEXT,user_id INTEGER);
    CREATE TABLE students(id INTEGER PRIMARY KEY,student_code TEXT UNIQUE,full_name TEXT,grade_level TEXT,classroom TEXT,status TEXT);
    CREATE TABLE audit_logs(id INTEGER PRIMARY KEY,user_id INTEGER,action TEXT,resource TEXT,resource_id INTEGER,details TEXT,ip_address TEXT);
    INSERT INTO users VALUES (1,'h@x','ครูประจำชั้น','teacher','active','',NULL),(2,'o@x','ผู้รับผิดชอบ','teacher','active','',NULL),(3,'e@x','ผอ.','executive','active','',NULL),(4,'n@x','ครูทั่วไป','teacher','active','',NULL);
    INSERT INTO academic_years VALUES (5,2569,'active');
    INSERT INTO academic_terms VALUES (1,5,1,'2026-05-16','2026-10-10','closed'),(2,5,2,'2026-11-01','2027-03-31','active');
    INSERT INTO gr_homerooms VALUES (5,'ป.4','2',1),(5,'อ.2','1',4);
    INSERT INTO budget_role_assignments VALUES ('foundmoney_officer','',2);
    INSERT INTO students VALUES (10,'0010','เด็กชายหนึ่ง ดี','ป.4','2','enrolled'),(11,'0011','เด็กหญิงสอง ดี','ป.4','2','enrolled'),(12,'0012','เด็กชายสาม ดี','ป.5','1','enrolled'),(13,'0013','เด็กชายอนุบาล','อ.2','1','enrolled');`);
  const wrap = (sql) => { let values = []; const stmt = db.prepare(sql);
    return { bind(...a) { values = a; return this; }, async first() { return stmt.get(...values) || null; }, async all() { return { results: stmt.all(...values) }; },
      async run() { const r = stmt.run(...values); return { meta: { changes: r.changes, last_row_id: Number(r.lastInsertRowid) } }; }, _sync() { stmt.run(...values); } }; };
  return { db, JWT_SECRET: secret, DB: { prepare: wrap, async batch(list) { db.exec("BEGIN"); try { list.forEach((s) => s._sync()); db.exec("COMMIT"); } catch (e) { db.exec("ROLLBACK"); throw e; } } } };
}
const drive = { ready: () => "ยังไม่ได้ตั้งค่า Google Drive", token: async () => "t", request: async () => new Response("{}") };
async function api(env, userId, path, method = "GET", body) {
  const token = await signJWT({ sub: userId }, secret);
  const isForm = body instanceof FormData;
  const request = new Request(`https://school.example${path}`, { method, headers: { Cookie: `bpd_session=${token}`, ...(isForm ? {} : { "Content-Type": "application/json" }) }, body: body ? (isForm ? body : JSON.stringify(body)) : undefined });
  const response = await handleMeritRoute(request, env, new URL(request.url).pathname, method, drive);
  return { status: response.status, data: await response.json() };
}

test("dates and periods (break counts as previous term)", async () => {
  const env = environment();
  assert.equal(parseDate("5/11/2569"), "2026-11-05"); assert.equal(parseDate("31/02/2026"), undefined);
  assert.deepEqual(await periodOf(env, "2026-10-20"), { year: 2569, term: 1, year_id: 5 });
  assert.deepEqual(await periodOf(env, "2026-11-03"), { year: 2569, term: 2, year_id: 5 });
});

test("homeroom records good deeds for own room, imports xlsx rows, others cannot", async () => {
  const env = environment();
  let r = await api(env, 1, "/api/merit/good", "POST", { records: [{ student_id: 10, deed_date: "2026-11-03", category: "ช่วยเหลือผู้อื่น", detail: "ช่วยครู" }, { student_id: 11, deed_date: "2026-08-01", category: "ทำการบ้านดี" }] });
  assert.equal(r.status, 200); assert.equal(r.data.saved, 2);
  r = await api(env, 1, "/api/merit/good", "POST", { records: [{ student_id: 12, deed_date: "2026-11-03", category: "ช่วยเหลือผู้อื่น" }] });
  assert.equal(r.status, 400);
  r = await api(env, 1, "/api/merit/good/import", "POST", { rows: [{ student_code: "0010", deed_date: "4/11/2569", category: "จิตอาสา/บำเพ็ญประโยชน์" }, { full_name: "ด.ญ.สอง ดี", deed_date: "2026-11-04", category: "ซื่อสัตย์สุจริต" }, { student_code: "0012", deed_date: "2026-11-04", category: "x" }, { student_code: "0010", deed_date: "2099-01-01", category: "x" }] });
  assert.equal(r.data.saved, 2); assert.deepEqual(r.data.skipped.map((x) => x.row), [3, 4]);
  r = await api(env, 1, "/api/merit/good?academic_year=2569");
  assert.equal(r.data.records.length, 4); assert.deepEqual(r.data.students.map((s) => s.id).sort(), [10, 11]);
  assert.equal(r.data.records.find((x) => x.student_id === 11 && x.term === 1).category, "อื่น ๆ");
  r = await api(env, 3, "/api/merit/good"); assert.equal(r.data.records.length, 4); assert.equal(r.data.permissions.can_write, false);
  r = await api(env, 3, "/api/merit/good", "POST", { records: [{ student_id: 10, deed_date: "2026-11-03", category: "อื่น ๆ" }] }); assert.equal(r.status, 403);
  r = await api(env, 2, "/api/merit/good"); assert.equal(r.status, 403, "money officer has no good-deed access");
});

test("good deeds and found money add +1 behaviour point once (ป.1–6 only)", async () => {
  const env = environment();
  await api(env, 1, "/api/merit/good", "POST", { records: [{ student_id: 10, deed_date: "2026-11-03", category: "ช่วยเหลือผู้อื่น", detail: "ช่วยครู" }] });
  await api(env, 4, "/api/merit/good", "POST", { records: [{ student_id: 13, deed_date: "2026-11-03", category: "ช่วยเหลือผู้อื่น" }] });
  let r = await api(env, 1, "/api/merit/good/points", "POST", { ids: [1, 1] });
  assert.equal(r.data.added, 1);
  r = await api(env, 1, "/api/merit/good/points", "POST", { ids: [1] }); assert.equal(r.data.added, 0); assert.match(r.data.skipped[0].reason, /ไปแล้ว/);
  r = await api(env, 4, "/api/merit/good/points", "POST", { ids: [2] }); assert.match(r.data.skipped[0].reason, /ป\.1–6/);
  const ps = env.db.prepare("SELECT * FROM ps_behavior_records").all();
  assert.equal(ps.length, 1); assert.equal(ps[0].points, 1); assert.equal(ps[0].term_number, 2); assert.equal(ps[0].academic_year_id, 5); assert.match(ps[0].reason, /ทำความดี: ช่วยเหลือผู้อื่น/);
  r = await api(env, 1, "/api/merit/good/1", "DELETE"); assert.equal(r.status, 409);
  env.db.exec("UPDATE ps_behavior_records SET cancelled_at=datetime('now')");
  r = await api(env, 1, "/api/merit/good"); assert.equal(r.data.records.find((x) => x.id === 1).points_used, 0, "cancelled points can be reused");
  // เจอเงิน (ผู้รับผิดชอบงาน = ทุกห้อง, ไม่มีภาพ)
  const fd = new FormData(); fd.append("student_id", "12"); fd.append("found_date", "2026-11-02"); fd.append("amount", "20"); fd.append("place", "โรงอาหาร");
  r = await api(env, 2, "/api/merit/money", "POST", fd); assert.equal(r.status, 200);
  const fd2 = new FormData(); fd2.append("student_id", "12"); fd2.append("found_date", "2026-11-02"); fd2.append("amount", "20");
  r = await api(env, 1, "/api/merit/money", "POST", fd2); assert.equal(r.status, 403, "homeroom of another room");
  r = await api(env, 2, "/api/merit/money/points", "POST", { ids: [r.data.id || 1] });
  assert.equal(r.data.added, 1);
  assert.match(env.db.prepare("SELECT reason FROM ps_behavior_records ORDER BY id DESC").get().reason, /เจอเงินส่งคืน 20 บาท \(โรงอาหาร\)/);
  r = await api(env, 3, "/api/merit/money"); assert.equal(r.data.records[0].amount, 20); assert.deepEqual(r.data.records[0].photos, []);
  r = await api(env, 1, "/api/merit/permissions"); assert.deepEqual([r.data.good.view, r.data.money.view, r.data.money.manage_all], [true, true, false]);
});
