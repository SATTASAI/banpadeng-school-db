import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { DatabaseSync } from "node:sqlite";
import { signJWT } from "../src/lib/crypto.js";
import { assignLearningBases, ASSIGN_METHODS } from "../src/lib/learning-base-assign.js";
import { handleLearningBasesRoute, gradeNumber, genderOf, DEFAULT_BASES } from "../src/routes/learning-bases.js";

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

test("whole_room keeps rooms together; by_grade groups a grade; keep_previous keeps last year's base", () => {
  const students = fakeStudents();
  const room = assignLearningBases({ students, bases: bases(12), method: "whole_room", seed: 1 });
  for (let g = 1; g <= 6; g++) for (const r of ["1", "2"]) assert.equal(new Set(students.filter((s) => s.grade === g && s.room === r).map((s) => room.assignments.get(s.id))).size, 1);
  const grade = assignLearningBases({ students, bases: bases(6, { capacity: 20 }), method: "by_grade", seed: 1 });
  for (let g = 1; g <= 6; g++) assert.equal(new Set(students.filter((s) => s.grade === g).map((s) => grade.assignments.get(s.id))).size, 1);
  const prev = students.map((s) => ({ ...s, prev_base_name: s.id <= 5 ? "ฐาน3" : "" }));
  const keep = assignLearningBases({ students: prev, bases: bases(6), method: "keep_previous", seed: 1 });
  for (let id = 1; id <= 5; id++) assert.equal(keep.assignments.get(id), 3);
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
    CREATE TABLE audit_logs(id INTEGER PRIMARY KEY,user_id INTEGER,action TEXT,resource TEXT,resource_id INTEGER,details TEXT,ip_address TEXT);
    INSERT INTO users VALUES (1,'a@example.invalid','ผู้ดูแล','superadmin','active','2026-01-01',NULL),(2,'v@example.invalid','ภายนอก','viewer','active','2026-01-01',NULL);
    INSERT INTO academic_years VALUES (5,2569,'active');
    INSERT INTO students VALUES (10,'0010','เด็กชายหนึ่ง','ป.1','1','enrolled'),(11,'0011','เด็กหญิงสอง','ป.1','1','enrolled'),
      (12,'0012','เด็กชายสาม','ป.6','2','enrolled'),(13,'0013','เด็กหญิงย้าย','ป.6','2','transferred'),(14,'0014','อนุบาล','อ.2','1','enrolled');`);
  const wrap = (sql) => { let values = []; const stmt = db.prepare(sql);
    return { bind(...a) { values = a; return this; }, async first() { return stmt.get(...values) || null; }, async all() { return { results: stmt.all(...values) }; },
      async run() { const r = stmt.run(...values); return { meta: { changes: r.changes } }; }, _sync() { stmt.run(...values); } }; };
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
