import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { signJWT } from "../src/lib/crypto.js";
import { LICENSE_IMPORT_KEY } from "../src/data/license-seed.js";
import { handlePersonnelRoute } from "../src/routes/personnel.js";

const secret = "personnel-center-test";

function fixture() {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE users(id INTEGER PRIMARY KEY,email TEXT,full_name TEXT,role TEXT,status TEXT,deleted_at TEXT,created_at TEXT);
    CREATE TABLE staff_profiles(user_id INTEGER PRIMARY KEY,position TEXT,subjects TEXT,phone TEXT,homeroom_classroom TEXT,license_expiry_date TEXT);
    CREATE TABLE personnel_records(
      id INTEGER PRIMARY KEY AUTOINCREMENT,user_id INTEGER UNIQUE,prefix TEXT,first_name TEXT,last_name TEXT,
      full_name TEXT NOT NULL,normalized_name TEXT NOT NULL UNIQUE,email TEXT,personnel_type TEXT,position_number TEXT,
      position TEXT,academic_rank TEXT,subjects TEXT,phone TEXT,homeroom_classroom TEXT,departments TEXT,
      responsible_projects TEXT,teaching_periods INTEGER,appointment_date TEXT,service_start_date TEXT,
      education_level TEXT,major TEXT,institution TEXT,employment_status TEXT DEFAULT 'working',retirement_date TEXT,
      license_issue_date TEXT,license_expiry_date TEXT,license_issue_raw TEXT,license_expiry_raw TEXT,
      status TEXT DEFAULT 'active',source_file TEXT,source_sheet TEXT,source_row INTEGER,
      created_at TEXT DEFAULT(datetime('now')),updated_at TEXT DEFAULT(datetime('now'))
    );
    CREATE TABLE personnel_imports(import_key TEXT PRIMARY KEY,source_file TEXT,record_count INTEGER,imported_at TEXT DEFAULT(datetime('now')));
    CREATE TABLE leave_requests(id INTEGER PRIMARY KEY,user_id INTEGER,leave_type TEXT,start_date TEXT,end_date TEXT,status TEXT,created_at TEXT);
    CREATE TABLE tasks(id INTEGER PRIMARY KEY,status TEXT,due_date TEXT);
    CREATE TABLE work_records(id INTEGER PRIMARY KEY,area TEXT,topic_key TEXT,status TEXT,due_date TEXT);
    CREATE TABLE projects(id INTEGER PRIMARY KEY,department TEXT,management_area TEXT,name TEXT,status TEXT);
    INSERT INTO users VALUES(1,'admin@example.test','ผู้ดูแล','superadmin','active',NULL,'2026-01-01'),(2,'teacher@example.test','ครูสมบูรณ์','teacher','active',NULL,'2026-01-01');
    INSERT INTO personnel_records(user_id,full_name,normalized_name,email,personnel_type,position,phone,departments,service_start_date,education_level,major,institution,license_expiry_date,status)
      VALUES(2,'ครูสมบูรณ์','ครูสมบูรณ์','teacher@example.test','teacher','ครู','0800000000','academic','2020-05-01','ปริญญาตรี','ภาษาไทย','มหาวิทยาลัยตัวอย่าง','2030-01-01','active'),
            (NULL,'ครูข้อมูลไม่ครบ','ครูข้อมูลไม่ครบ','second@example.test',NULL,'ครู',NULL,NULL,NULL,NULL,NULL,NULL,NULL,'active');
    INSERT INTO personnel_imports(import_key,source_file,record_count) VALUES('${LICENSE_IMPORT_KEY}','seed',0);
    INSERT INTO leave_requests VALUES(1,2,'sick',date('now'),date('now'),'approved',datetime('now')),(2,2,'personal',date('now','+7 day'),date('now','+7 day'),'pending',datetime('now'));
    INSERT INTO tasks VALUES(1,'open',date('now','-1 day')),(2,'open',date('now','+3 day'));
    INSERT INTO work_records VALUES(1,'personnel','5','completed',date('now','-1 day')),(2,'personnel','5','open',date('now','-1 day'));
    INSERT INTO projects VALUES(1,'personnel',NULL,'พัฒนาครู','ongoing'),(2,'personnel',NULL,'ศึกษาดูงาน','completed');
  `);
  function prepare(sql) {
    let args = [];
    return {
      bind(...values) { args = values; return this; },
      async first() { return db.prepare(sql).get(...args) || null; },
      async all() { return { results: db.prepare(sql).all(...args) }; },
      async run() { const result = db.prepare(sql).run(...args); return { meta: { changes: Number(result.changes), last_row_id: Number(result.lastInsertRowid) } }; },
    };
  }
  return { JWT_SECRET: secret, DB: { prepare, async batch(items) { const output = []; for (const item of items) output.push(await item.run()); return output; } } };
}

test("personnel overview summarizes profile readiness and existing workflows", async () => {
  const env = fixture();
  const token = await signJWT({ sub: 1 }, secret);
  const request = new Request("https://school.example/api/personnel/overview", { headers: { Cookie: `bpd_session=${token}` } });
  const response = await handlePersonnelRoute(request, env, "/api/personnel/overview", "GET");
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.summary.staff_count, 3);
  assert.equal(body.summary.complete_profiles, 1);
  assert.equal(body.summary.incomplete_profiles, 2);
  assert.equal(body.summary.pending_leave, 1);
  assert.equal(body.summary.absent_today, 1);
  assert.equal(body.summary.overdue_tasks, 1);
  assert.deepEqual(body.work_by_topic.project, { total: 2, completed: 1, overdue: 0 });
  assert.deepEqual(body.work_by_topic["5"], { total: 2, completed: 1, overdue: 1 });
  assert.equal(body.permissions.can_manage, true);
});
