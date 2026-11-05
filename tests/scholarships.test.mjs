import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { DatabaseSync } from "node:sqlite";
import { signJWT } from "../src/lib/crypto.js";
import { handleScholarshipRoute, matchRows, normalizeName, parseAmount } from "../src/routes/scholarships.js";

const secret = "scholarship-test";
function environment() {
  const db = new DatabaseSync(":memory:");
  db.exec(`CREATE TABLE users(id INTEGER PRIMARY KEY,email TEXT,full_name TEXT,role TEXT,status TEXT,created_at TEXT,deleted_at TEXT);
    CREATE TABLE academic_years(id INTEGER PRIMARY KEY,year_be INTEGER,status TEXT);
    CREATE TABLE academic_terms(id INTEGER PRIMARY KEY,academic_year_id INTEGER,term_number INTEGER,status TEXT);
    CREATE TABLE gr_homerooms(academic_year_id INTEGER,grade_level TEXT,classroom TEXT,user_id INTEGER);
    CREATE TABLE budget_role_assignments(role_key TEXT,department TEXT,user_id INTEGER);
    CREATE TABLE students(id INTEGER PRIMARY KEY,student_code TEXT UNIQUE,full_name TEXT,grade_level TEXT,classroom TEXT,status TEXT,national_id TEXT);
    CREATE TABLE audit_logs(id INTEGER PRIMARY KEY,user_id INTEGER,action TEXT,resource TEXT,resource_id INTEGER,details TEXT,ip_address TEXT);
    INSERT INTO users VALUES (1,'o@x.invalid','ครูทุน','teacher','active','2026-01-01',NULL),(2,'t@x.invalid','ครูประจำชั้น','teacher','active','2026-01-01',NULL),
      (3,'e@x.invalid','ผอ.','executive','active','2026-01-01',NULL),(4,'n@x.invalid','ครูทั่วไป','teacher','active','2026-01-01',NULL);
    INSERT INTO academic_years VALUES (5,2569,'active'); INSERT INTO academic_terms VALUES (9,5,2,'active');
    INSERT INTO gr_homerooms VALUES (5,'ป.4','2',2);
    INSERT INTO budget_role_assignments VALUES ('scholarship_officer','',1);
    INSERT INTO students VALUES (10,'0010','เด็กชายสมชาย ใจดี','ป.4','2','enrolled','1234567890123'),(11,'0011','เด็กหญิงสมหญิง รักเรียน','ป.4','2','enrolled',NULL),(12,'0012','เด็กชายมานะ อดทน','ป.5','1','enrolled',NULL);`);
  const wrap = (sql) => { let values = []; const stmt = db.prepare(sql);
    return { bind(...a) { values = a; return this; }, async first() { return stmt.get(...values) || null; }, async all() { return { results: stmt.all(...values) }; },
      async run() { const r = stmt.run(...values); return { meta: { changes: r.changes, last_row_id: Number(r.lastInsertRowid) } }; }, _sync() { stmt.run(...values); } }; };
  return { db, JWT_SECRET: secret, DB: { prepare: wrap, async batch(list) { db.exec("BEGIN"); try { list.forEach((s) => s._sync()); db.exec("COMMIT"); } catch (e) { db.exec("ROLLBACK"); throw e; } } } };
}
async function api(env, userId, path, method = "GET", body) {
  const token = await signJWT({ sub: userId }, secret);
  const request = new Request(`https://school.example${path}`, { method, headers: { Cookie: `bpd_session=${token}`, "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  const response = await handleScholarshipRoute(request, env, new URL(request.url).pathname, method);
  return { status: response.status, data: await response.json() };
}

test("parses amounts and normalizes Thai names", () => {
  assert.equal(parseAmount("1,600.00 บาท"), 1600); assert.equal(parseAmount(""), null); assert.equal(parseAmount("abc"), undefined);
  assert.equal(normalizeName("ด.ช. สมชาย  ใจดี"), normalizeName("เด็กชายสมชาย ใจดี"));
  assert.equal(normalizeName("นางสาวน้ํา ใส"), normalizeName("น้ำ ใส"));
});

test("matches by national id, code, exact name and suggests close names", () => {
  const students = [{ id: 1, student_code: "0010", full_name: "เด็กชายสมชาย ใจดี", national_id: "1234567890123", status: "enrolled" },
    { id: 2, student_code: "0011", full_name: "เด็กหญิงสมหญิง รักเรียน", status: "enrolled" }];
  const m = matchRows([{ national_id: "1-2345-67890-12-3" }, { student_code: "11" }, { name: "ด.ญ.สมหญิง รักเรียน" }, { name: "สมชาย ใจดีย์" }, { name: "ไม่มี ในระบบเลย" }], students);
  assert.deepEqual(m.map((x) => [x.student_id, x.method]), [[1, "national_id"], [2, "student_code"], [2, "name"], [null, "suggest"], [null, "none"]]);
  assert.deepEqual(m[3].candidates, [1]);
});

test("fixed types exist; officer imports, replaces and edits; homeroom sees own room only", async () => {
  const env = environment();
  let r = await api(env, 1, "/api/scholarships");
  assert.equal(r.status, 200); assert.equal(r.data.term, 2); assert.equal(r.data.academic_year, 2569);
  assert.deepEqual(r.data.types.filter((t) => t.fixed).map((t) => t.code), ["eef", "subsidy"]);
  const eef = r.data.types.find((t) => t.code === "eef").id;
  r = await api(env, 1, "/api/scholarships/awards", "PUT", { type_id: eef, academic_year: 2569, term: 2, records: [{ student_id: 10, amount: "1,600" }, { student_id: 12, amount: "1600" }] });
  assert.equal(r.status, 200);
  r = await api(env, 1, "/api/scholarships/awards", "PUT", { type_id: eef, academic_year: 2569, term: 2, mode: "replace", records: [{ student_id: 10, amount: "1500" }, { student_id: 11, amount: "1500" }] });
  assert.equal(r.status, 200);
  r = await api(env, 3, "/api/scholarships");
  assert.deepEqual(r.data.awards.map((a) => [a.student_id, a.amount]), [[10, 1500], [11, 1500]]);
  r = await api(env, 2, "/api/scholarships");
  assert.equal(r.status, 200); assert.deepEqual(r.data.students.map((s) => s.id).sort(), [10, 11]); assert.equal(r.data.permissions.manage, false);
  r = await api(env, 2, "/api/scholarships/awards", "PUT", { type_id: eef, academic_year: 2569, term: 2, records: [{ student_id: 10, amount: 1 }] });
  assert.equal(r.status, 403);
  r = await api(env, 4, "/api/scholarships");
  assert.equal(r.status, 403);
  r = await api(env, 4, "/api/scholarships/permissions");
  assert.equal(r.data.view, false);
  r = await api(env, 3, "/api/scholarships/types", "POST", { name: "ทุนมูลนิธิ" });
  assert.equal(r.status, 403, "executive views but cannot manage");
});

test("custom types can be created, renamed and deleted; fixed ones cannot", async () => {
  const env = environment();
  let r = await api(env, 1, "/api/scholarships/types", "POST", { name: "ทุนมูลนิธิ ก" });
  assert.equal(r.status, 200); const id = r.data.id;
  r = await api(env, 1, "/api/scholarships/types", "POST", { name: "ทุนมูลนิธิ ก" });
  assert.equal(r.status, 409);
  r = await api(env, 1, `/api/scholarships/types/${id}`, "PATCH", { name: "ทุนมูลนิธิ ข" });
  assert.equal(r.status, 200);
  await api(env, 1, "/api/scholarships/awards", "PUT", { type_id: id, academic_year: 2569, term: 1, records: [{ student_id: 10, amount: 500 }] });
  r = await api(env, 1, `/api/scholarships/types/${id}`, "DELETE");
  assert.equal(r.status, 200);
  assert.equal(env.db.prepare("SELECT COUNT(*) n FROM scholarship_awards").get().n, 0);
  const fixed = env.db.prepare("SELECT id FROM scholarship_types WHERE code='eef'").get().id;
  r = await api(env, 1, `/api/scholarships/types/${fixed}`, "DELETE");
  assert.equal(r.status, 400);
});

test("pdf parser groups items into rows and maps columns to records", () => {
  const ctx = vm.createContext({ window: {} }); vm.runInContext(fs.readFileSync("public/js/scholarship-pdf.js", "utf8"), ctx); const P = ctx.window.ScholarshipPdf;
  const it = (str, x, y, w) => ({ str, x, y, w, h: 10 });
  const lines = P._linesOf([it("ที่", 10, 10, 10), it("ชื่อ - สกุล", 40, 10, 60), it("เลขประจำตัวประชาชน", 150, 10, 80), it("จำนวนเงิน", 260, 10, 40),
    it("1", 12, 25, 5), it("ด.ช.สมชาย", 40, 25, 40), it("ใจดี", 85, 25, 20), it("1-2345-67890-12-3", 150, 25, 70), it("1,600.00", 262, 25, 30)]);
  assert.equal(P._isHeader(lines[0]), true);
  const mapping = P.guessMapping(lines[0].map((c) => ({ label: c.str })));
  assert.deepEqual([...mapping], ["", "name", "national_id", "amount"]);
  const recs = P.toRecords([lines[1].map((c) => c.str)], mapping);
  assert.equal(recs[0].name, "ด.ช.สมชาย ใจดี"); assert.equal(recs[0].national_id, "1234567890123"); assert.equal(recs[0].amount, 1600);
});
