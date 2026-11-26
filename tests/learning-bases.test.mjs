import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { DatabaseSync } from "node:sqlite";
import { signJWT } from "../src/lib/crypto.js";
import { assignLearningBases, ASSIGN_METHODS } from "../src/lib/learning-base-assign.js";
import { handleLearningBasesRoute, gradeNumber, genderOf, DEFAULT_BASES, matchImportRows, similarity } from "../src/routes/learning-bases.js";

// นักเรียนจำลอง 6 ชั้น × 2 ห้อง × 10 คน (ชาย/หญิงสลับ)
function fakeStudents() {
  const list = []; let id = 1;
  for (let g = 1; g <= 6; g++) for (const room of ["1", "2"]) for (let i = 0; i < 10; i++) list.push({ id: id++, grade: g, room, gender: i % 2 ? "F" : "M" });
  return list;
}
const bases = (n, extra = {}) => Array.from({ length: n }, (_, i) => ({ id: i + 1, name: `ฐาน${i + 1}`, capacity: null, grades: [1, 2, 3, 4, 5, 6], ...extra }));
const tally = (map) => { const c = new Map(); for (const b of map.values()) c.set(b, (c.get(b) || 0) + 1); return c; };

test("every method places all students within capacity and allowed grades", () => {
  const students = fakeStudents();
  const list = bases(6, { capacity: 20 });
  list[0].grades = [1, 2, 3]; list[1].grades = [4, 5, 6];
  for (const method of Object.keys(ASSIGN_METHODS)) {
    const { assignments, unplaced } = assignLearningBases({ students, bases: list, method, seed: 7 });
    assert.equal(assignments.size + unplaced.length, students.length, method);
    assert.equal(unplaced.length, 0, method);
    for (const [, n] of tally(assignments)) assert(n <= 20, method);
    const byId = new Map(students.map((s) => [s.id, s]));
    for (const [sid, bid] of assignments) assert(list.find((b) => b.id === bid).grades.includes(byId.get(sid).grade), method);
  }
});

test("balanced spreads grades and gender evenly; same seed gives the same result", () => {
  const students = fakeStudents();
  const a = assignLearningBases({ students, bases: bases(6), method: "balanced", seed: 3 });
  const b = assignLearningBases({ students, bases: bases(6), method: "balanced", seed: 3 });
  assert.deepEqual([...a.assignments], [...b.assignments]);
  for (const [, n] of tally(a.assignments)) assert.equal(n, 20);
  for (let g = 1; g <= 6; g++) {
    const per = [1, 2, 3, 4, 5, 6].map((base) => students.filter((s) => s.grade === g && a.assignments.get(s.id) === base).length);
    assert(Math.max(...per) - Math.min(...per) <= 1, `grade ${g} spread ${per}`);
  }
  for (let base = 1; base <= 6; base++) {
    const mine = students.filter((s) => a.assignments.get(s.id) === base);
    assert(Math.abs(mine.filter((s) => s.gender === "M").length - mine.filter((s) => s.gender === "F").length) <= 2);
  }
});

test("whole_room keeps rooms together; by_grade groups a grade", () => {
  const students = fakeStudents();
  const room = assignLearningBases({ students, bases: bases(12), method: "whole_room", seed: 1 });
  for (let g = 1; g <= 6; g++) for (const r of ["1", "2"]) assert.equal(new Set(students.filter((s) => s.grade === g && s.room === r).map((s) => room.assignments.get(s.id))).size, 1);
  const grade = assignLearningBases({ students, bases: bases(6, { capacity: 20 }), method: "by_grade", seed: 1 });
  for (let g = 1; g <= 6; g++) assert.equal(new Set(students.filter((s) => s.grade === g).map((s) => grade.assignments.get(s.id))).size, 1);
  assert(!("keep_previous" in ASSIGN_METHODS));
});

test("no method puts a student back into a base they attended before", () => {
  const students = fakeStudents().map((s) => ({ ...s, blocked: new Set(s.id % 3 ? [1, 2] : [3]) }));
  for (const method of Object.keys(ASSIGN_METHODS)) {
    const { assignments, unplaced } = assignLearningBases({ students, bases: bases(6, { capacity: 22 }), method, seed: 11 });
    assert.equal(unplaced.length, 0, method);
    for (const s of students) assert(!s.blocked.has(assignments.get(s.id)), `${method} student ${s.id}`);
  }
  // ทุกฐานเคยอยู่หมดแล้ว → ไม่จัด (รายงานเป็นคนที่ไม่มีที่)
  const r = assignLearningBases({ students: [{ id: 1, grade: 1, room: "1", gender: "M", blocked: new Set([1, 2]) }], bases: bases(2), method: "balanced", seed: 1 });
  assert.deepEqual(r.unplaced, [1]);
});

test("fixed students count toward capacity; full bases leave students unplaced", () => {
  const students = fakeStudents().slice(0, 10);
  const fixed = new Map([[1, 1], [2, 1]]);
  const r = assignLearningBases({ students, bases: bases(2, { capacity: 3 }), fixed, method: "balanced", seed: 1 });
  assert(!r.assignments.has(1));
  assert.equal(r.assignments.size, 4);
  assert.equal(r.unplaced.length, 4);
});

test("parses grade levels and gender from detail or name prefix", () => {
  assert.equal(gradeNumber("ป.4"), 4); assert.equal(gradeNumber("ประถมศึกษาปีที่ 6"), 6); assert.equal(gradeNumber("อ.2"), null); assert.equal(gradeNumber("ม.1"), null);
  assert.equal(genderOf("หญิง", "เด็กชายเอ"), "F"); assert.equal(genderOf(null, "เด็กชาย เอ"), "M"); assert.equal(genderOf(null, "ด.ญ.บี"), "F"); assert.equal(genderOf(null, "เอ"), "");
  assert.equal(DEFAULT_BASES.length, 18);
});

const secret = "learning-bases-test";
function environment() {
  const db = new DatabaseSync(":memory:");
  db.exec(`CREATE TABLE users(id INTEGER PRIMARY KEY,email TEXT,full_name TEXT,role TEXT,status TEXT,created_at TEXT,deleted_at TEXT);
    CREATE TABLE academic_years(id INTEGER PRIMARY KEY,year_be INTEGER,status TEXT);
    CREATE TABLE students(id INTEGER PRIMARY KEY,student_code TEXT UNIQUE,full_name TEXT,grade_level TEXT,classroom TEXT,status TEXT);
    CREATE TABLE staff_profiles(user_id INTEGER PRIMARY KEY,position TEXT,subjects TEXT,phone TEXT,homeroom_classroom TEXT,license_expiry_date TEXT);
    CREATE TABLE audit_logs(id INTEGER PRIMARY KEY,user_id INTEGER,action TEXT,resource TEXT,resource_id INTEGER,details TEXT,ip_address TEXT);
    INSERT INTO users VALUES (1,'a@example.invalid','ผู้ดูแล','superadmin','active','2026-01-01',NULL),(2,'v@example.invalid','ภายนอก','viewer','active','2026-01-01',NULL),(3,'t@example.invalid','ครู','teacher','active','2026-01-01',NULL);
    INSERT INTO academic_years VALUES (5,2569,'active');
    INSERT INTO students VALUES (10,'0010','เด็กชายหนึ่ง','ป.1','1','enrolled'),(11,'0011','เด็กหญิงสอง','ป.1','1','enrolled'),
      (12,'0012','เด็กชายสาม','ป.6','2','enrolled'),(13,'0013','เด็กหญิงย้าย','ป.6','2','transferred'),(14,'0014','อนุบาล','อ.2','1','enrolled');`);
  // prepare ตอนรันจริง (เหมือน D1) — batch สร้างตารางแล้วสร้าง index ต่อได้
  const wrap = (sql) => { let values = []; const stmt = () => db.prepare(sql);
    return { bind(...a) { values = a; return this; }, async first() { return stmt().get(...values) || null; }, async all() { return { results: stmt().all(...values) }; },
      async run() { const r = stmt().run(...values); return { meta: { changes: r.changes } }; }, _sync() { stmt().run(...values); } }; };
  return { db, JWT_SECRET: secret, DB: { prepare: wrap, async batch(list) { db.exec("BEGIN"); try { list.forEach((s) => s._sync()); db.exec("COMMIT"); } catch (e) { db.exec("ROLLBACK"); throw e; } } } };
}
async function api(env, userId, path, method = "GET", body) {
  const token = await signJWT({ sub: userId }, secret);
  const request = new Request(`https://school.example${path}`, { method, headers: { Cookie: `bpd_session=${token}`, "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  const response = await handleLearningBasesRoute(request, env, new URL(request.url).pathname, method);
  return { status: response.status, data: await response.json() };
}

test("API seeds default bases, auto-assigns ป.1–6 enrolled students, edits bases and members", async () => {
  const env = environment();
  let r = await api(env, 1, "/api/learning-bases");
  assert.equal(r.status, 200);
  assert.equal(r.data.bases.length, 18);
  assert.deepEqual(r.data.students.map((s) => s.id).sort(), [10, 11, 12]);
  assert.equal(r.data.permissions.manage, true);
  const preview = await api(env, 1, "/api/learning-bases/auto", "POST", { academic_year: 2569, method: "balanced", seed: 5 });
  assert.equal(preview.data.preview, true);
  assert.equal(env.db.prepare("SELECT COUNT(*) n FROM learning_base_members").get().n, 0);
  const applied = await api(env, 1, "/api/learning-bases/auto", "POST", { academic_year: 2569, method: "balanced", seed: 5, apply: true });
  assert.deepEqual(applied.data.assignments, preview.data.assignments);
  assert.equal(env.db.prepare("SELECT COUNT(*) n FROM learning_base_members").get().n, 3);

  const baseId = r.data.bases[0].id;
  r = await api(env, 1, "/api/learning-bases/members", "PUT", { academic_year: 2569, student_id: 12, base_id: baseId });
  assert.equal(r.status, 200);
  assert.equal(env.db.prepare("SELECT locked FROM learning_base_members WHERE student_id=12").get().locked, 1);
  // จัดใหม่ทั้งหมดแต่คงคนที่จัดเอง
  await api(env, 1, "/api/learning-bases/auto", "POST", { academic_year: 2569, method: "random", apply: true });
  assert.equal(env.db.prepare("SELECT base_id FROM learning_base_members WHERE student_id=12").get().base_id, baseId);

  // เปลี่ยนชื่อ + จำนวนรับ + ให้ฐานแรกรับเฉพาะ ป.1 → นักเรียน ป.6 ที่อยู่ฐานนั้นกลับเป็นยังไม่มีฐาน
  const list = (await api(env, 1, "/api/learning-bases")).data.bases;
  r = await api(env, 1, "/api/learning-bases/bases", "PUT", { academic_year: 2569, bases: [{ ...list[0], name: "ดนตรีไทยใหม่", capacity: 30, grades: [1] }, ...list.slice(1, 3)] });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.bases.length, 3);
  assert.equal(r.data.bases[0].name, "ดนตรีไทยใหม่");
  assert.equal(env.db.prepare("SELECT COUNT(*) n FROM learning_base_members WHERE student_id=12").get().n, 0);
  assert.equal(env.db.prepare("SELECT COUNT(*) n FROM learning_bases WHERE active=0").get().n, 15);
  r = await api(env, 1, "/api/learning-bases/members", "PUT", { academic_year: 2569, student_id: 12, base_id: r.data.bases[0].id });
  assert.equal(r.status, 400);
  r = await api(env, 1, "/api/learning-bases/bases", "PUT", { academic_year: 2569, bases: [{ name: "ซ้ำ" }, { name: "ซ้ำ", grades: [1] }] });
  assert.equal(r.status, 400);
  r = await api(env, 1, "/api/learning-bases/auto", "POST", { academic_year: 2568, method: "balanced" });
  assert.equal(r.status, 400);
});

test("external viewer has no access; page and menu are wired", async () => {
  const env = environment();
  assert.equal((await api(env, 2, "/api/learning-bases")).status, 403);
  const ctx = vm.createContext({ URL }); vm.runInContext(fs.readFileSync("public/js/navigation-catalog.js", "utf8"), ctx);
  const n = ctx.SchoolNavigation;
  assert(n.groups.general.some((i) => i.url === "/learning-bases.html" && i.label === "จัดฐานการเรียนรู้"));
  assert.equal(n.parentFor("learning-bases", "/learning-bases.html"), "general");
  assert(fs.existsSync("public/learning-bases.html"));
  assert(fs.readFileSync("src/index.js", "utf8").includes("handleLearningBasesRoute(request, env, pathname, method)"));
});

test("every teacher can view the list but only general department/admin can edit", async () => {
  const env = environment();
  await api(env, 1, "/api/learning-bases");
  const r = await api(env, 3, "/api/learning-bases");
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.permissions.manage, false);
  assert.equal(r.data.bases.length, 18);
  assert.equal((await api(env, 3, "/api/learning-bases/auto", "POST", { academic_year: 2569, method: "balanced" })).status, 403);
  // ครูในฝ่ายบริหารทั่วไปแก้ไขได้
  env.db.prepare("UPDATE personnel_records SET departments = 'ฝ่ายบริหารทั่วไป' WHERE user_id = 3").run();
  assert.equal((await api(env, 3, "/api/learning-bases")).data.permissions.manage, true);
});

test("export builds base, room and summary sections; menu is under support", () => {
  const ctx = vm.createContext({ URL }); vm.runInContext(fs.readFileSync("public/js/learning-base-export.js", "utf8"), ctx);
  const X = ctx.LearningBaseExport;
  const data = { academic_year: 2569, bases: [{ id: 1, name: "ดนตรีไทย", capacity: 2 }, { id: 2, name: "Barber", capacity: null }],
    students: [{ id: 1, student_code: "1", full_name: "เด็กชายเอ", grade_level: "ป.2", classroom: "1", gender: "M" },
      { id: 2, student_code: "2", full_name: "เด็กหญิงบี", grade_level: "ป.1", classroom: "2", gender: "F" },
      { id: 3, student_code: "3", full_name: "เด็กหญิงซี", grade_level: "ป.1", classroom: "2", gender: "F" }],
    members: [{ student_id: 1, base_id: 1 }, { student_id: 2, base_id: 1 }] };
  const base = X.buildSections("base", data);
  assert.deepEqual([...base.map((s) => s.sheet)], ["ดนตรีไทย", "Barber", "ยังไม่มีฐาน"]);
  assert.equal(base[0].table.length, 3);
  assert.equal(base[0].table[1][3], "เด็กหญิงบี"); // เรียง ป.1 ก่อน ป.2
  const room = X.buildSections("room", data);
  assert.deepEqual([...room.map((s) => s.sheet)], ["ป.1/2", "ป.2/1"]);
  assert.equal(room[0].table[2][3], "ยังไม่มีฐาน");
  const sum = X.buildSections("summary", data)[0].table;
  assert.deepEqual([...sum[1]], ["ดนตรีไทย", "1", "1", "0", "0", "0", "0", "1", "1", "2", "2"]);
  assert.equal(sum.at(-1)[9], "3");
  assert.equal(X.pdfDefinition(base).content.length, 12);
  const n = (() => { const c = vm.createContext({ URL }); vm.runInContext(fs.readFileSync("public/js/navigation-catalog.js", "utf8"), c); return c.SchoolNavigation; })();
  assert.equal(n.routes["learning-base-list"], "/learning-base-list.html");
  const html = fs.readFileSync("public/dashboard.html", "utf8");
  assert(html.split("ระบบสนับสนุน</div>")[1].split("บริหารระบบ</div>")[0].includes('data-page="learning-base-list"'));
  for (const page of ["public/learning-base-list.html", "public/learning-bases.html"]) assert(fs.readFileSync(page, "utf8").includes("/js/learning-base-export.js"));
});

test("API blocks repeating a past base (by lineage even after rename, or by same name)", async () => {
  const env = environment();
  await api(env, 1, "/api/learning-bases?academic_year=2568"); // สร้างตาราง
  env.db.exec(`INSERT INTO learning_bases (id, academic_year, name, grades, sort_order) VALUES (900, 2568, 'ดนตรีไทย', '1,2,3,4,5,6', 1), (901, 2568, 'Barber', '1,2,3,4,5,6', 2);
    INSERT INTO learning_base_members (student_id, academic_year, base_id, grade_level, classroom) VALUES (12, 2568, 900, 'ป.5', '2'), (10, 2568, 901, 'อ.3', '1');`);
  let r = await api(env, 1, "/api/learning-bases");
  assert.deepEqual(r.data.bases.map((b) => b.name), ["ดนตรีไทย", "Barber"]); // ปีใหม่คัดลอกฐานจากปีก่อน
  const [thai, barber] = r.data.bases;
  assert.deepEqual(r.data.history["12"].blocked, [thai.id]);
  // เปลี่ยนชื่อฐานปีนี้ ก็ยังนับว่าเป็นฐานเดิม
  await api(env, 1, "/api/learning-bases/bases", "PUT", { academic_year: 2569, bases: [{ ...thai, name: "ดนตรีไทยสร้างสรรค์" }, barber] });
  r = await api(env, 1, "/api/learning-bases/members", "PUT", { academic_year: 2569, student_id: 12, base_id: thai.id });
  assert.equal(r.status, 400);
  assert.match(r.data.error, /ห้ามซ้ำฐานเดิม/);
  r = await api(env, 1, "/api/learning-bases/members", "PUT", { academic_year: 2569, student_id: 12, base_id: barber.id });
  assert.equal(r.status, 200);
  // จัดอัตโนมัติไม่ใส่ซ้ำ
  for (const method of ["balanced", "random", "by_grade", "whole_room"]) {
    const a = await api(env, 1, "/api/learning-bases/auto", "POST", { academic_year: 2569, method, keep_locked: false, seed: 3 });
    const got = new Map(a.data.assignments.map((x) => [x.student_id, x.base_id]));
    assert.notEqual(got.get(12), thai.id, method);
    assert.notEqual(got.get(10), barber.id, method);
  }
  assert.equal((await api(env, 1, "/api/learning-bases/auto", "POST", { academic_year: 2569, method: "keep_previous" })).status, 400);
});

test("import matching checks several fields: ≥3 match, no conflicts, and code or name must match", () => {
  const students = [
    { id: 1, student_code: "100", full_name: "เด็กชายสมชาย ใจดี", grade_level: "ป.2", classroom: "1" },
    { id: 2, student_code: "101", full_name: "เด็กหญิงมาลี ศรีสุข", grade_level: "ป.2", classroom: "1" },
    { id: 3, student_code: "102", full_name: "เด็กหญิงมาลี ศรีสุข", grade_level: "ป.3", classroom: "2" },
    { id: 4, student_code: "103", full_name: "เด็กชายธนพล วงศ์ดี", grade_level: "ป.4", classroom: "1" },
  ];
  const r = matchImportRows([
    { row: 2, grade_level: "ป.2", classroom: "1", title: "เด็กชาย", first_name: "สมชาย", last_name: "ใจดี", base: "ดนตรีไทย" },
    { row: 3, grade_level: "ป.3", classroom: "2", title: "เด็กหญิง", first_name: "มาลี", last_name: "ศรีสุข", base: "Barber" },
    { row: 4, grade_level: "ป.4", classroom: "1", title: "ด.ช.", first_name: "ธนพน", last_name: "วงศ์ดี", base: "Barber" },
    { row: 5, grade_level: "ป.2", classroom: "1", first_name: "ธนพน", last_name: "วงศ์ดี", base: "Barber" },
    { row: 6, grade_level: "ป.2", classroom: "1", first_name: "ใครก็ได้", base: "" },
    { row: 7, grade_level: "ป.9", classroom: "9", first_name: "x", base: "y", student_code: "101" },
  ], students);
  assert.equal(r[0].status, "exact"); assert.equal(r[0].student.id, 1);
  assert.equal(r[1].status, "exact"); assert.equal(r[1].student.id, 3);
  assert.equal(r[2].status, "fuzzy"); assert.equal(r[2].candidates[0].id, 4);
  assert.equal(r[3].status, "none"); // คนชื่อคล้ายอยู่คนละห้อง — ไม่เสนอ
  assert.equal(r[4].status, "no_base");
  // เลขประจำตัวตรงอย่างเดียว แต่ชื่อ/ชั้นขัดกัน → ไม่จับคู่อัตโนมัติ ให้ผู้นำเข้าเลือก
  assert.equal(r[5].status, "fuzzy"); assert.equal(r[5].candidates[0].id, 2);
  assert.ok(r[5].candidates[0].conflicts.includes("name"));
  // ชื่อใกล้เคียง + เพศ + ชั้น + ห้องตรง ก็ยังไม่อัตโนมัติ (ต้องมีเลขประจำตัวหรือชื่อตรง)
  assert.deepEqual([...r[2].candidates[0].matched].sort(), ["gender", "grade", "room"]);
  assert(similarity("ธนพล", "ธนพน") > 0.7);
});

test("import saves locked members for the year, creates missing bases, feeds the no-repeat rule", async () => {
  const env = environment();
  await api(env, 1, "/api/learning-bases");
  let r = await api(env, 1, "/api/learning-bases/import", "POST", { academic_year: 2568, mode: "match", rows: [
    { row: 2, grade_level: "ป.5", classroom: "2", title: "เด็กชาย", first_name: "สาม", base: "ฐานเก่า" }] });
  assert.equal(r.data.rows[0].status, "exact");
  r = await api(env, 1, "/api/learning-bases/import", "POST", { academic_year: 2568, mode: "save", rows: [{ student_id: 12, base: "ฐานเก่า", grade_level: "ป.5", classroom: "2" }, { student_id: 10, base: "ดนตรีไทย", grade_level: "ป.0", classroom: "1" }] });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.deepEqual(r.data.new_bases, ["ฐานเก่า", "ดนตรีไทย"]);
  // ปี 2569: นักเรียน 10 ห้ามเข้า ดนตรีไทย (ชื่อเดียวกัน)
  const list = (await api(env, 1, "/api/learning-bases")).data;
  const thai = list.bases.find((b) => b.name === "ดนตรีไทย");
  assert.deepEqual(list.history["10"].blocked, [thai.id]);
  // นำเข้าปีปัจจุบัน → ล็อกไว้
  r = await api(env, 1, "/api/learning-bases/import", "POST", { academic_year: 2569, mode: "save", rows: [{ student_id: 11, base: "ดนตรีไทย", grade_level: "ป.1", classroom: "1" }] });
  assert.equal(r.data.saved, 1);
  const m = env.db.prepare("SELECT locked, method FROM learning_base_members WHERE student_id = 11 AND academic_year = 2569").get();
  assert.equal(m.locked, 1); assert.equal(m.method, "import");
  assert.equal((await api(env, 1, "/api/learning-bases/import", "POST", { academic_year: 2571, mode: "match", rows: [{ row: 1 }] })).status, 400);
  assert.equal((await api(env, 3, "/api/learning-bases/import", "POST", { academic_year: 2569, mode: "match", rows: [{ row: 1 }] })).status, 403);
});

test("import center offers the learning-base template with the file's column names", () => {
  const html = fs.readFileSync("public/import-center.html", "utf8");
  for (const label of ["ชั้น", "ห้อง", "คำนำหน้าชื่อ", "ชื่อ", "นามสกุล", "ฐานการเรียนรู้"]) assert(html.includes(`"${label}"`));
  assert(html.includes('endpoint:"learning_bases"'));
});
