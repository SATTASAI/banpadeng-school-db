import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { DatabaseSync } from "node:sqlite";
import { signJWT } from "../src/lib/crypto.js";
import { handleStudentInsuranceRoute, parseInsured, parseDate, parseYear, normalizeInsuranceInput } from "../src/routes/student-insurance.js";

const secret = "student-insurance-test";
function environment() {
  const db = new DatabaseSync(":memory:");
  db.exec(`CREATE TABLE users(id INTEGER PRIMARY KEY,email TEXT,full_name TEXT,role TEXT,status TEXT,created_at TEXT);
    CREATE TABLE academic_years(id INTEGER PRIMARY KEY,year_be INTEGER,status TEXT);
    CREATE TABLE gr_homerooms(academic_year_id INTEGER,grade_level TEXT,classroom TEXT,user_id INTEGER);
    CREATE TABLE students(id INTEGER PRIMARY KEY,student_code TEXT UNIQUE,full_name TEXT,grade_level TEXT,classroom TEXT,status TEXT);
    CREATE TABLE audit_logs(id INTEGER PRIMARY KEY,user_id INTEGER,action TEXT,resource TEXT,resource_id INTEGER,details TEXT,ip_address TEXT);
    INSERT INTO users VALUES (1,'staff@example.invalid','เจ้าหน้าที่','staff','active','2026-01-01'),(2,'t@example.invalid','ครูประจำชั้น','teacher','active','2026-01-01');
    INSERT INTO academic_years VALUES (5,2569,'active');
    INSERT INTO gr_homerooms VALUES (5,'ป.4','2',2);
    INSERT INTO students VALUES (10,'0010','นักเรียน ก','ป.4','2','enrolled'),(11,'0011','นักเรียน ข','ป.4','2','enrolled'),(12,'0012','ห้องอื่น','ป.5','1','enrolled');`);
  const wrap = (sql) => { let values = []; const stmt = db.prepare(sql);
    return { bind(...a) { values = a; return this; }, async first() { return stmt.get(...values) || null; }, async all() { return { results: stmt.all(...values) }; },
      async run() { const r = stmt.run(...values); return { meta: { changes: r.changes } }; }, _sync() { stmt.run(...values); } }; };
  return { db, JWT_SECRET: secret, DB: { prepare: wrap, async batch(list) { db.exec("BEGIN"); try { list.forEach((s) => s._sync()); db.exec("COMMIT"); } catch (e) { db.exec("ROLLBACK"); throw e; } } } };
}
async function api(env, userId, path, method = "GET", body) {
  const token = await signJWT({ sub: userId }, secret);
  const request = new Request(`https://school.example${path}`, { method, headers: { Cookie: `bpd_session=${token}`, "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  const response = await handleStudentInsuranceRoute(request, env, new URL(request.url).pathname, method);
  return { status: response.status, data: await response.json() };
}

test("parses Thai yes/no words, BE/CE years and dates", () => {
  assert.equal(parseInsured("ทำ"), 1); assert.equal(parseInsured("ไม่ทำ"), 0); assert.equal(parseInsured("maybe"), null);
  assert.equal(parseYear("2026"), 2569); assert.equal(parseYear("2569"), 2569); assert.equal(parseYear("abc"), null);
  assert.equal(parseDate("16/05/2569"), "2026-05-16"); assert.equal(parseDate("2026-05-16"), "2026-05-16"); assert.equal(parseDate("31/02/2026"), undefined); assert.equal(parseDate(""), null);
  assert.match(normalizeInsuranceInput({ insured: "ทำ", start_date: "2026-06-01", end_date: "2026-05-01" }).error, /วันสิ้นสุด/);
  assert.equal(normalizeInsuranceInput({ insured: "ทำ", premium: "1,250" }).record.premium, 1250);
});

test("staff saves a whole room and an individual update keeps one row per student per year", async () => {
  const env = environment();
  let r = await api(env, 1, "/api/student-insurance", "PUT", { academic_year: 2569, records: [
    { student_id: 10, insured: "1", company: "บริษัท ก", premium: "250" }, { student_id: 11, insured: "0" }] });
  assert.equal(r.status, 200); assert.equal(r.data.saved, 2);
  r = await api(env, 1, "/api/student-insurance", "PUT", { academic_year: 2569, records: [{ student_id: 11, insured: "1", policy_no: "PA-11" }] });
  assert.equal(r.status, 200);
  r = await api(env, 1, "/api/student-insurance?academic_year=2569");
  assert.equal(r.data.records.length, 2);
  assert.equal(r.data.records.find((x) => x.student_id === 11).policy_no, "PA-11");
  assert.equal(r.data.current_year, 2569);
  r = await api(env, 1, "/api/student-insurance/student/11?academic_year=2569", "DELETE");
  assert.equal(r.status, 200);
  r = await api(env, 1, "/api/student-insurance/student/11");
  assert.equal(r.data.records.length, 0); assert.equal(r.data.can_edit, true);
});

test("homeroom teacher can save only their own classroom and cannot import", async () => {
  const env = environment();
  let r = await api(env, 2, "/api/student-insurance", "PUT", { academic_year: 2569, records: [{ student_id: 10, insured: "ทำ" }] });
  assert.equal(r.status, 200);
  r = await api(env, 2, "/api/student-insurance", "PUT", { academic_year: 2569, records: [{ student_id: 10, insured: "ทำ" }, { student_id: 12, insured: "ทำ" }] });
  assert.equal(r.status, 403);
  r = await api(env, 2, "/api/student-insurance/student/12");
  assert.equal(r.data.can_edit, false);
  r = await api(env, 2, "/api/student-insurance");
  assert.deepEqual(r.data.permissions.homerooms, ["ป.4|2"]);
  r = await api(env, 2, "/api/student-insurance/import", "POST", { rows: [] });
  assert.equal(r.status, 403);
});

test("import matches student codes, defaults to the active year and reports bad rows", async () => {
  const env = environment();
  const r = await api(env, 1, "/api/student-insurance/import", "POST", { rows: [
    { student_code: "0010", insured: "ทำ", premium: "300" },
    { student_code: "0011", academic_year: "2568", insured: "ไม่ทำ" },
    { student_code: "9999", insured: "ทำ" },
    { student_code: "0012", insured: "อาจจะ" },
    { student_code: "0010", insured: "ไม่ทำ" }] });
  assert.equal(r.status, 200); assert.equal(r.data.saved, 2);
  assert.deepEqual(r.data.skipped.map((x) => x.row), [3, 4, 5]);
  const list = await api(env, 1, "/api/student-insurance?all_years=1");
  assert.deepEqual(list.data.records.map((x) => [x.student_id, x.academic_year, x.insured]).sort(), [[10, 2569, 1], [11, 2568, 0]]);
  assert.deepEqual(list.data.years, [2569, 2568]);
});

test("export filters by insurance status for the chosen year", () => {
  const ctx = vm.createContext({}); vm.runInContext(fs.readFileSync("public/js/student-export.js", "utf8"), ctx); const e = ctx.StudentExport;
  const rows = [{ id: 1, full_name: "ก", status: "enrolled" }, { id: 2, full_name: "ข", status: "enrolled" }, { id: 3, full_name: "ค", status: "enrolled" }];
  const records = [{ student_id: 1, academic_year: 2569, insured: 1, company: "บริษัท ก", premium: 250 }, { student_id: 2, academic_year: 2569, insured: 0 }, { student_id: 3, academic_year: 2568, insured: 1 }];
  const list = e.withInsurance(rows, records, 2569);
  assert.deepEqual(e.select(list, { insurance: "insured" }).map((s) => s.id), [1]);
  assert.deepEqual(e.select(list, { insurance: "not_insured" }).map((s) => s.id), [2]);
  assert.deepEqual(e.select(list, { insurance: "none" }).map((s) => s.id), [3]);
  assert.equal(e.select(list, { insurance: "recorded" }).length, 2);
  const table = e.table(list, ["full_name", "insurance_status", "insurance_company", "insurance_premium"]);
  assert.deepEqual(table[0], ["ชื่อ–นามสกุล", "การทำประกันอุบัติเหตุ", "บริษัทประกัน", "เบี้ยประกัน (บาท)"]);
  assert.deepEqual([...table[1]], ["ก", "ทำประกัน", "บริษัท ก", "250"]);
  assert.equal(table[3][1], "ยังไม่บันทึก");
  assert.equal(e.groups(list, "insurance_status").length, 3);
});
