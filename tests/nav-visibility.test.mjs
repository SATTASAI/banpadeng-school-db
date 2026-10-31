import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { visibleDepartments } from "../src/routes/nav-visibility.js";

function env() {
  const db = new DatabaseSync(":memory:");
  db.exec(`CREATE TABLE users(id INTEGER PRIMARY KEY,email TEXT,full_name TEXT,role TEXT,status TEXT,created_at TEXT,deleted_at TEXT);
    CREATE TABLE academic_years(id INTEGER PRIMARY KEY,year_be INTEGER,status TEXT);
    CREATE TABLE academic_terms(id INTEGER PRIMARY KEY,academic_year_id INTEGER,term_number INTEGER,name TEXT,status TEXT);
    CREATE TABLE gr_subjects(id INTEGER PRIMARY KEY,academic_year_id INTEGER,grade_level TEXT,code TEXT,name TEXT);
    CREATE TABLE gr_courses(id INTEGER PRIMARY KEY,subject_id INTEGER,classroom TEXT);
    CREATE TABLE gr_course_teachers(course_id INTEGER,user_id INTEGER);
    CREATE TABLE staff_profiles(user_id INTEGER,position TEXT,subjects TEXT,phone TEXT,homeroom_classroom TEXT,license_expiry_date TEXT);
    CREATE TABLE gr_homerooms(academic_year_id INTEGER,grade_level TEXT,classroom TEXT,user_id INTEGER);
    INSERT INTO users VALUES(1,'a','ครูวิชาการ','teacher','active','',NULL),(2,'b','ครูสอนอนุบาล','teacher','active','',NULL),(3,'c','ครูประจำชั้น อ.2','teacher','active','',NULL),(4,'d','รอง','executive','active','',NULL),(5,'e','ครูไม่มีฝ่าย','teacher','active','',NULL);
    INSERT INTO academic_years VALUES(1,2569,'active');
    INSERT INTO gr_subjects VALUES(1,1,'อ.1','K1','ประสบการณ์');
    INSERT INTO gr_courses VALUES(1,1,'1');
    INSERT INTO gr_course_teachers VALUES(1,2);
    INSERT INTO gr_homerooms VALUES(1,'อ.2','1',3);`);
  const prepare = (sql) => { let a = []; return { bind(...v) { a = v; return this; }, async first() { return db.prepare(sql).get(...a) || null; }, async all() { return { results: db.prepare(sql).all(...a) }; }, async run() { const r = db.prepare(sql).run(...a); return { meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) } }; } }; };
  return { db, env: { DB: { prepare, batch: async (s) => Promise.all(s.map((x) => x.run())) } } };
}

test("เห็นเฉพาะฝ่ายของตน + ครูอนุบาลเห็นปฐมวัย", async () => {
  const { db, env: e } = env();
  await visibleDepartments(e, { id: 5, role: "teacher" }); // ensure tables
  db.exec(`INSERT INTO personnel_records(full_name,status,user_id,departments) SELECT full_name,'active',id,'' FROM users WHERE id NOT IN (SELECT user_id FROM personnel_records WHERE user_id IS NOT NULL) AND id<>4;
    UPDATE personnel_records SET departments='งบประมาณ' WHERE user_id=2;
    INSERT INTO department_staff(department,personnel_id) SELECT 'academic',id FROM personnel_records WHERE user_id=1;`);
  assert.deepEqual((await visibleDepartments(e, { id: 1, role: "teacher" })).departments, ["academic"]);
  assert.deepEqual((await visibleDepartments(e, { id: 2, role: "teacher" })).departments, ["early_childhood", "budget"]);
  assert.deepEqual((await visibleDepartments(e, { id: 3, role: "teacher" })).departments, ["early_childhood"]);
  assert.deepEqual((await visibleDepartments(e, { id: 5, role: "teacher" })).departments, []);
  assert.equal((await visibleDepartments(e, { id: 4, role: "executive" })).all, true);
  assert.equal((await visibleDepartments(e, { id: 9, role: "superadmin" })).all, true);
});
