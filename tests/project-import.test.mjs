import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { importProjectRows, upsertProjectRow } from "../src/lib/project-import.js";

function environment() {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE users(id INTEGER PRIMARY KEY,email TEXT,full_name TEXT,role TEXT,status TEXT);
    CREATE TABLE projects(id INTEGER PRIMARY KEY AUTOINCREMENT,department TEXT,management_area TEXT,name TEXT,budget_amount REAL,
      spent_amount REAL DEFAULT 0,fiscal_year INTEGER,status TEXT DEFAULT 'ongoing',description TEXT,created_by INTEGER,funding_type TEXT);
    CREATE TABLE project_owners(project_id INTEGER,user_id INTEGER,PRIMARY KEY(project_id,user_id));
    CREATE TABLE project_expenses(id INTEGER PRIMARY KEY,project_id INTEGER);
    CREATE TABLE documents(id INTEGER PRIMARY KEY,project_id INTEGER);
    INSERT INTO users VALUES
      (1,'admin@example.invalid','ผู้ดูแล','superadmin','active'),
      (2,'teacher@example.invalid','ครูผู้รับผิดชอบ','teacher','active');
  `);
  function prepare(sql) {
    let values = [];
    return {
      bind(...args) { values = args; return this; },
      async first() { return db.prepare(sql).get(...values) || null; },
      async all() { return { results: db.prepare(sql).all(...values) }; },
      async run() {
        const result = db.prepare(sql).run(...values);
        return { meta: { changes: Number(result.changes), last_row_id: Number(result.lastInsertRowid) } };
      },
    };
  }
  return { raw: db, DB: { prepare, async batch(statements) { return Promise.all(statements.map((statement) => statement.run())); } } };
}

test("project import preserves distinct same-name projects and never overwrites or removes them", async () => {
  const env = environment();
  env.raw.exec(`
    INSERT INTO projects(department,name,budget_amount,fiscal_year,description,created_by)
      VALUES('academic','โครงการอ่านคล่อง',1000,2570,'เดิม',1),
            ('academic','โครงการอ่านคล่อง',1000,2570,'รายการซ้ำ',1);
  `);
  const result = await importProjectRows(env, [
    { department: "academic", name: "โครงการอ่านคล่อง", fiscal_year: 2570, budget_amount: 2000, description: "กลาง", owner_emails: "" },
    { department: "academic", name: "โครงการอ่านคล่อง", fiscal_year: 2570, budget_amount: 3500, description: "ล่าสุด", owner_emails: "teacher@example.invalid" },
  ], 1);

  assert.deepEqual(result, { created: 2, updated: 0, duplicates_removed: 0, superseded: 0, skipped: [] });
  const projects = env.raw.prepare("SELECT * FROM projects").all();
  assert.equal(projects.length, 4);
  assert.equal(projects[3].budget_amount, 3500);
  assert.equal(projects[3].description, "ล่าสุด");
  assert.deepEqual(env.raw.prepare("SELECT user_id FROM project_owners WHERE project_id=?").all(projects[3].id).map((row) => Number(row.user_id)), [2]);
});

test("project import rejects an unknown responsible-person email without changing data", async () => {
  const env = environment();
  const result = await importProjectRows(env, [{
    department: "budget", name: "โครงการใหม่", fiscal_year: 2570, budget_amount: 100,
    owner_emails: "missing@example.invalid",
  }], 1);
  assert.equal(result.created, 0);
  assert.equal(result.skipped.length, 1);
  assert.match(result.skipped[0].reason, /missing@example\.invalid/);
  assert.equal(env.raw.prepare("SELECT COUNT(*) AS count FROM projects").get().count, 0);
});

test("project import stores kindergarten as a separate early-childhood area", async () => {
  const env = environment();
  const result = await importProjectRows(env, [{
    department: "early_childhood", name: "โครงการบ้านนักวิทยาศาสตร์น้อย", fiscal_year: 2570,
    budget_amount: 5000, owner_emails: "teacher@example.invalid",
  }], 1);
  assert.equal(result.created, 1);
  const project = env.raw.prepare("SELECT * FROM projects").get();
  assert.equal(project.department, "academic");
  assert.equal(project.management_area, "early_childhood");
});

test('exact duplicate requires explicit confirmation; different details and owners are independent',async()=>{
 const env=environment();
 const base={department:'academic',name:'ชื่อซ้ำ',fiscal_year:2570,budget_amount:1000,description:'รายละเอียด',funding_type:'subsidy'};
 const original=await upsertProjectRow(env,base,1,[2]);
 await assert.rejects(upsertProjectRow(env,base,1,[2]),e=>e.code==='duplicate_project');
 assert.equal(env.raw.prepare('SELECT COUNT(*) n FROM projects').get().n,1);
 for(const change of [{description:'อีกกิจกรรม'},{budget_amount:2000},{funding_type:'school_income'},{fiscal_year:2571},{department:'general'}]) {
  const result=await upsertProjectRow(env,{...base,...change},1,[2]);assert.notEqual(result.id,original.id);
 }
 await upsertProjectRow(env,base,1,[1]);
 const confirmed=await upsertProjectRow(env,{...base,confirm_duplicate:true},1,[2]);assert.notEqual(confirmed.id,original.id);
 assert.equal(env.raw.prepare('SELECT COUNT(*) n FROM projects').get().n,8);
 assert.equal(env.raw.prepare('SELECT description FROM projects WHERE id=?').get(original.id).description,base.description);
 const result=await importProjectRows(env,[{...base,owner_emails:'teacher@example.invalid'}],1);assert.equal(result.skipped[0].code,'duplicate_project');
});
