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
  assert.equal(r.status, 200); assert.equal(r.data.max_rounds, 3); assert.equal(r.data.academic_year, 2569);
  assert.deepEqual(r.data.types.filter((t) => t.fixed).map((t) => t.code), ["eef", "subsidy"]);
  const eef = r.data.types.find((t) => t.code === "eef").id;
  r = await api(env, 1, "/api/scholarships/awards", "PUT", { type_id: eef, academic_year: 2569, term: 2, records: [{ student_id: 10, amount: "1,600" }, { student_id: 12, amount: "1600" }] });
  assert.equal(r.status, 200);
  r = await api(env, 1, "/api/scholarships/awards", "PUT", { type_id: eef, academic_year: 2569, term: 2, mode: "replace", records: [{ student_id: 10, amount: "1500" }, { student_id: 11, amount: "1500" }] });
  assert.equal(r.status, 200);
  r = await api(env, 3, "/api/scholarships");
  assert.deepEqual(r.data.awards.map((a) => [a.student_id, a.amount, a.round]), [[10, 1500, 2], [11, 1500, 2]]);
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

test("reads the กสศ. eligible-student form: 2-line header, G ids, total row, title meta", () => {
  const ctx = vm.createContext({ window: {} }); vm.runInContext(fs.readFileSync("public/js/scholarship-pdf.js", "utf8"), ctx); const P = ctx.window.ScholarshipPdf;
  const w = (str, x0, y, x1) => ({ str, x: x0, y, w: x1 - x0, h: 12 });
  const header = [w("รายชื่อนักเรียนที่มีสิทธิ์ได้รับเงินอุดหนุนยากจนพิเศษ กสศ. ภาคเรียนที่ 1 ปีการศึกษา 2569", 225, 40, 617),
    w("ที่", 27, 70.6, 33), w("เลขประจำตัว", 61, 70.6, 102), w("ประชาชน", 66, 83.8, 97), w("ชื่อ - นามสกุล", 168, 70.6, 213), w("ชั้นปี", 275, 70.6, 289),
    w("วิธีการรับเงิน", 336, 70.6, 376), w("สถานะ", 453, 70.6, 476), w("โอนสำเร็จ", 422, 88.8, 453), w("โอนไม่สำเร็จ", 472, 88.8, 511),
    w("รอบ งบประมาณที่", 524, 70.6, 591), w("ที่ ได้รับจัดสรร", 528, 83.8, 589), w("สาเหตุ", 646, 70.6, 666), w("หมายเหตุ", 760, 70.6, 790)];
  const row = (n, id, name, cls, amt, y, fail) => [w(String(n), 33, y, 40), w(id, 53, y, 110), w(name, 123, y, 203), w(cls, 267, y, 288),
    w("รับเงินสดที่โรงเรียน", 306, y, 366), fail ? w("/", 490, y, 493) : w("/", 436, y, 439), w("1", 528, y, 533), w(amt, 573, y, 592), w(fail ? "บัญชีปิด" : "-", 650, y, 680), w("-", 774, y, 776)];
  const page1 = [...header, ...row(1, "1000000000001", "เด็กชายทดสอบ หนึ่ง", "อ. 3/1", "2,000", 107),
    ...row(2, "G660000000002", "เด็กหญิงทดสอบ สอง", "ป. 2/4", "2,100", 125, true)];
  const page2 = [...header.slice(1), ...row(3, "1000000000003", "เด็กหญิงทดสอบ -", "ป. 6/4", "2,100", 107),
    w("รวม", 230, 140, 245), w("2", 440, 140, 446), w("1", 495, 140, 500), w("6,200", 560, 140, 592)];
  const res = P.parsePages([{ items: page1 }, { items: page2 }]);
  assert.equal(res.meta.term, 1); assert.equal(res.meta.year, 2569); assert.equal(res.meta.kind, "eef"); assert.equal(res.meta.total, 6200);
  const map = P.guessMapping(res.columns, res.rows);
  const field = (k) => res.columns[map.indexOf(k)]?.label;
  assert.match(field("national_id"), /ประชาชน/); assert.match(field("amount"), /จัดสรร/); assert.match(field("name"), /ชื่อ/); assert.match(field("fail"), /ไม่สำเร็จ/);
  const recs = P.toRecords(res.rows, map);
  assert.deepEqual(JSON.parse(JSON.stringify(recs.map((r) => [r.name, r.national_id, r.amount]))), [["เด็กชายทดสอบ หนึ่ง", "1000000000001", 2000], ["เด็กหญิงทดสอบ สอง", "G660000000002", 2100], ["เด็กหญิงทดสอบ", "1000000000003", 2100]]);
  assert.match(recs[1].notes, /โอนไม่สำเร็จ.*บัญชีปิด/); assert.equal(recs[0].notes, "");
});

test("server matches G-prefixed ids", () => {
  const m = matchRows([{ national_id: "g660000000002" }], [{ id: 7, student_code: "1", full_name: "x", national_id: "G660000000002", status: "enrolled" }]);
  assert.deepEqual([m[0].student_id, m[0].method], [7, "national_id"]);
});

test("export builds PDF table with totals and xlsx sheets", () => {
  const ctx = vm.createContext({ window: {} }); vm.runInContext(fs.readFileSync("public/js/scholarship-export.js", "utf8"), ctx); const E = ctx.window.ScholarshipExport;
  const rep = { title: "รายชื่อนักเรียนที่ได้รับทุน", subtitle: "ภาคเรียนที่ 1 ปีการศึกษา 2569", rows: [{ student_code: "1", full_name: "ก", room: "ป.1 / 1", amount: 2000 }, { student_code: "2", full_name: "ข", room: "ป.1 / 1", amount: 2100 }], rooms: [{ room: "ป.1 / 1", count: 2, sum: 4100 }] };
  const doc = E.pdfDoc(rep); const body = doc.content[3].table.body;
  assert.equal(body.length, 4); assert.equal(body[3][4].text, (4100).toLocaleString("th-TH", { minimumFractionDigits: 2 }));
  const s = E.sheets(rep); assert.equal(s.list.at(-1)[4], 4100); assert.deepEqual(JSON.parse(JSON.stringify(s.rooms.at(-1))), ["รวม", 2, 4100]);
});

test("reads the สพฐ. subsidy allocation form (ปัจจัยพื้นฐานนักเรียนยากจน) as ทุนอุดหนุน, not กสศ.", () => {
  const ctx = vm.createContext({ window: {} }); vm.runInContext(fs.readFileSync("public/js/scholarship-pdf.js", "utf8"), ctx); const P = ctx.window.ScholarshipPdf;
  const w = (str, x0, y, x1) => ({ str, x: x0, y, w: x1 - x0, h: 12 });
  const items = [w("บัญชีจัดสรรงบประมาณปี 2569 แผนงานพื้นฐานด้านการพัฒนาและเสริมสร้างศักยภาพคน", 102, 40, 493),
    w("โครงการสนับสนุนค่าใช้จ่ายในการจัดการศึกษา งบเงินอุดหนุน เงินอุดหนุนทั่วไป", 28, 57.6, 567),
    w("รายการค่าจัดการเรียนการสอน (ปัจจัยพื้นฐานสำหรับนักเรียนยากจน ภาคเรียนที่ 1 ปีการศึกษา 2569 )", 75, 75.2, 520),
    w("ที่", 40, 123.4, 45), w("เลขประจำตัว", 78, 123.4, 120), w("ประชาชน", 83, 136.6, 115), w("ชื่อ - นามสกุล", 186, 123.4, 230), w("ชั้นปี", 307, 123.4, 322), w("ห้อง", 359, 123.4, 373),
    w("ผลการตัดเกณฑ์ PMT", 400, 123.4, 469), w("งบ.นร.ยากจนที่ได้", 520, 123.4, 575), w("ผ่านเกณฑ์", 392, 140, 425), w("ผ่านเกณฑ์", 440, 140, 473), w("รับจัดสรร", 527, 140, 567),
    w("ยากจน", 396, 153, 420), w("ยากจนพิเศษ", 440, 153, 475),
    ...[[1, "1000000000001", "/", 412], [2, "G660000000002", "/", 460]].flatMap(([n, id, m, mx], i) => { const y = 173 + i * 18;
      return [w(String(n), 51, y, 55), w(id, 71, y, 127), w("เด็กชายทดสอบ " + n, 143, y, 229), w("ประถมศึกษาปีที่ 1", 282, y, 340), w("4", 372, y, 376), w(m, mx, y, mx + 3), w("500", 540, y, 553)]; }),
    w("รวม", 230, 220, 245), w("1", 410, 220, 415), w("1", 458, 220, 463), w("1,000", 540, 220, 562)];
  const res = P.parsePages([{ items }]);
  assert.equal(res.meta.kind, "subsidy"); assert.equal(res.meta.total, 1000);
  const map = P.guessMapping(res.columns, res.rows);
  const recs = JSON.parse(JSON.stringify(P.toRecords(res.rows, map, res.columns)));
  assert.deepEqual(recs.map((r) => [r.national_id, r.room, r.amount, r.notes]), [["1000000000001", "ป.1/4", 500, "ผ่านเกณฑ์ ยากจน"], ["G660000000002", "ป.1/4", 500, "ผ่านเกณฑ์ ยากจนพิเศษ"]]);
});

test("rounds 1–3 per year, rejects round 4 and past years, purges old years when a new year is active", async () => {
  const env = environment();
  let r = await api(env, 1, "/api/scholarships");
  const eef = r.data.types.find((t) => t.code === "eef").id;
  for (const round of [1, 2, 3]) {
    r = await api(env, 1, "/api/scholarships/awards", "PUT", { type_id: eef, academic_year: 2569, round, records: [{ student_id: 10, amount: 1000 * round }] });
    assert.equal(r.status, 200);
  }
  r = await api(env, 1, "/api/scholarships/awards", "PUT", { type_id: eef, academic_year: 2569, round: 4, records: [{ student_id: 10, amount: 1 }] });
  assert.equal(r.status, 400);
  r = await api(env, 1, "/api/scholarships/awards", "PUT", { type_id: eef, academic_year: 2568, round: 1, records: [{ student_id: 10, amount: 1 }] });
  assert.equal(r.status, 400);
  r = await api(env, 1, "/api/scholarships/awards", "PUT", { type_id: eef, academic_year: 2570, round: 1, records: [{ student_id: 11, amount: 700 }] });
  assert.equal(r.status, 200, "next year can be prepared early");
  r = await api(env, 1, "/api/scholarships?academic_year=2569");
  assert.deepEqual(r.data.awards.map((a) => [a.round, a.amount]), [[1, 1000], [2, 2000], [3, 3000]]);
  env.db.exec("UPDATE academic_years SET status='closed'; INSERT INTO academic_years VALUES (6,2570,'active');");
  r = await api(env, 1, "/api/scholarships?academic_year=2569");
  assert.equal(r.data.awards.length, 0);
  assert.deepEqual(env.db.prepare("SELECT academic_year, amount FROM scholarship_awards").all().map((x) => [x.academic_year, x.amount]), [[2570, 700]]);
});

test("migrates the first table version (term IN (1,2)) to allow round 3", async () => {
  const env = environment();
  env.db.exec(`CREATE TABLE scholarship_types (id INTEGER PRIMARY KEY AUTOINCREMENT, code TEXT UNIQUE, name TEXT NOT NULL, sort_order INTEGER NOT NULL DEFAULT 100, created_by INTEGER, created_at TEXT NOT NULL DEFAULT (datetime('now')));
    INSERT INTO scholarship_types (code,name,sort_order) VALUES ('eef','กสศ',1);
    CREATE TABLE scholarship_awards (id INTEGER PRIMARY KEY AUTOINCREMENT, type_id INTEGER NOT NULL, student_id INTEGER NOT NULL, academic_year INTEGER NOT NULL, term INTEGER NOT NULL CHECK (term IN (1,2)), amount REAL, notes TEXT, source TEXT, updated_by INTEGER, updated_at TEXT NOT NULL DEFAULT (datetime('now')), UNIQUE (type_id, student_id, academic_year, term));
    INSERT INTO scholarship_awards (type_id,student_id,academic_year,term,amount) VALUES (1,10,2569,2,500);`);
  let r = await api(env, 1, "/api/scholarships/awards", "PUT", { type_id: 1, academic_year: 2569, round: 3, records: [{ student_id: 10, amount: 900 }] });
  assert.equal(r.status, 200);
  r = await api(env, 1, "/api/scholarships");
  assert.deepEqual(r.data.awards.map((a) => [a.round, a.amount]), [[2, 500], [3, 900]]);
});

test("export supports whole-year view with per-round columns", () => {
  const ctx = vm.createContext({ window: {} }); vm.runInContext(fs.readFileSync("public/js/scholarship-export.js", "utf8"), ctx); const E = ctx.window.ScholarshipExport;
  const rep = { title: "t", subtitle: "รวมทั้งปี", roundCols: [1, 2, 3], rows: [{ full_name: "ก", amount: 3000, by: { 1: 1000, 2: 2000 } }], rooms: [] };
  const body = E.pdfDoc(rep).content[3].table.body;
  assert.equal(body[0].length, 8); assert.equal(body[1][6].text, "-");
  const s = E.sheets(rep); assert.deepEqual(JSON.parse(JSON.stringify(s.list.at(-1).slice(4, 8))), [1000, 2000, 0, 3000]);
});
