import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { handleRegister } from "../src/index.js";

export function environment() {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE users(
      id INTEGER PRIMARY KEY AUTOINCREMENT,email TEXT NOT NULL UNIQUE,password_hash TEXT NOT NULL,
      password_salt TEXT NOT NULL,full_name TEXT NOT NULL,role TEXT,status TEXT NOT NULL DEFAULT 'active',
      created_at TEXT NOT NULL DEFAULT(datetime('now')),approved_at TEXT,approved_by INTEGER,
      deleted_at TEXT,deleted_by INTEGER
    );
    CREATE TABLE staff_profiles(
      user_id INTEGER PRIMARY KEY,position TEXT,subjects TEXT,phone TEXT,
      homeroom_classroom TEXT,license_expiry_date TEXT
    );
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
  return {
    raw: db,
    JWT_SECRET: "registration-profile-test",
    DB: {
      prepare,
      async batch(statements) {
        const results = [];
        for (const statement of statements) results.push(await statement.run());
        return results;
      },
    },
  };
}

function request(body) {
  return new Request("https://school.example/api/auth/register", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

test("registration requires personnel fields and creates a linked personnel record", async () => {
  const env = environment();
  const base = {
    full_name: "นาย ครู ทดสอบ",
    email: "teacher@example.invalid",
    password: "correct-horse-battery",
    position: "ครูชำนาญการ",
    phone: "081-234-5678",
    departments: ["academic", "budget"],
    homeroom_classroom: "ป.4/1",
    subjects: "ภาษาไทย",
    teaching_periods: 18,
    responsible_projects: "โครงการอ่านออกเขียนได้",
  };

  const missingDepartment = await handleRegister(request({ ...base, departments: [] }), env);
  assert.equal(missingDepartment.status, 400);

  const response = await handleRegister(request(base), env);
  assert.equal(response.status, 201);
  const payload = await response.json();
  const profile = env.raw.prepare("SELECT * FROM personnel_records WHERE user_id = ?").get(payload.user.id);
  assert.equal(profile.email, base.email);
  assert.equal(profile.position, base.position);
  assert.equal(profile.phone, base.phone);
  assert.equal(profile.departments, "academic,budget");
  assert.equal(profile.homeroom_classroom, "ป.4/1");
  assert.equal(profile.teaching_periods, 18);
  assert.equal(profile.source_file, "สมัครสมาชิกด้วยตนเอง");

  const duplicateNameResponse = await handleRegister(request({
    ...base,
    email: "another-teacher@example.invalid",
    phone: "089-999-9999",
  }), env);
  assert.equal(duplicateNameResponse.status, 201);
  const anotherUser = (await duplicateNameResponse.json()).user.id;
  const linked = env.raw.prepare("SELECT personnel_id FROM personnel_accounts WHERE user_id=?").get(anotherUser);
  assert.equal(linked.personnel_id, profile.id);
  assert.equal(env.raw.prepare("SELECT phone FROM personnel_records WHERE id=?").get(profile.id).phone, "089-999-9999");
  assert.equal(env.raw.prepare("SELECT count(*) AS count FROM personnel_records WHERE full_name=? AND status='active'").get(base.full_name).count, 1);

  const duplicateEmailResponse = await handleRegister(request(base), env);
  assert.equal(duplicateEmailResponse.status, 409);

  env.raw.prepare(
    "UPDATE users SET email = ?, status = 'disabled', role = NULL, deleted_at = datetime('now') WHERE id = ?"
  ).run(`deleted-${payload.user.id}@removed.invalid`, payload.user.id);
  const reRegisterResponse = await handleRegister(request({
    ...base,
    full_name: "นายครู ทดสอบ",
  }), env);
  assert.equal(reRegisterResponse.status, 201);
  const reRegistered = await reRegisterResponse.json();
  const transferredProfile = env.raw.prepare(
    "SELECT user_id, email, full_name FROM personnel_records WHERE lower(email) = ?"
  ).get(base.email);
  assert.equal(transferredProfile.user_id, reRegistered.user.id);
  assert.equal(transferredProfile.full_name, "นายครู ทดสอบ");

  const insertImported = (name, key, email, phone, position, classroom) => {
    return Number(env.raw.prepare(`INSERT INTO personnel_records
      (full_name, normalized_name, email, phone, position, homeroom_classroom, departments,
       license_expiry_date, source_file) VALUES (?, ?, ?, ?, ?, ?, 'academic', '2030-12-31', 'import.xlsx')`)
      .run(name, key, email, phone, position, classroom).lastInsertRowid);
  };
  const originalId = insertImported("นางสาวครู นำเข้า", "import-name", "old@example.invalid", "0811111111", "ครู", "ป.1/1");
  const importedSignup = await handleRegister(request({ ...base, full_name: "ครู นำเข้า",
    email: "new@example.invalid", phone: "0822222222", position: "ครูชำนาญการพิเศษ", subjects: "วิทยาศาสตร์" }), env);
  assert.equal(importedSignup.status, 201);
  const updated = env.raw.prepare("SELECT * FROM personnel_records WHERE id = ?").get(originalId);
  assert.equal(updated.email, "new@example.invalid");
  assert.equal(updated.position, "ครูชำนาญการพิเศษ");
  assert.equal(updated.phone, "0822222222");
  assert.equal(updated.subjects, "วิทยาศาสตร์");
  assert.equal(updated.license_expiry_date, "2030-12-31");
  assert.equal(updated.source_file, "import.xlsx");
  assert.equal(updated.user_id, (await importedSignup.json()).user.id);

  const renamedId = insertImported("ครูชื่อเดิม", "rename", "rename-old@example.invalid", "0833333333", "ครู", "ป.2/1");
  const renamedSignup = await handleRegister(request({ ...base, full_name: "ครูชื่อใหม่",
    email: "rename-new@example.invalid", phone: "083-333-3333", position: "ครู",
    homeroom_classroom: "ป.2/1", departments: ["academic"] }), env);
  assert.equal(renamedSignup.status, 201);
  assert.equal(env.raw.prepare("SELECT full_name FROM personnel_records WHERE id = ?").get(renamedId).full_name, "ครูชื่อใหม่");

  const unrelatedId = insertImported("ครูคนละคน", "unrelated", "unrelated@example.invalid", "0844444444", "ครู", "ป.2/1");
  const unrelatedSignup = await handleRegister(request({ ...base, full_name: "ครูอีกคน",
    email: "separate@example.invalid", phone: "0855555555", position: "ครู",
    homeroom_classroom: "ป.2/1", departments: ["academic"] }), env);
  assert.equal(unrelatedSignup.status, 201);
  assert.equal(env.raw.prepare("SELECT user_id FROM personnel_records WHERE id = ?").get(unrelatedId).user_id, null);

  const ambiguousId = insertImported("นายครูซ้ำ", "ambiguous-1", null, null, null, null);
  insertImported("ครูซ้ำ", "ambiguous-2", null, null, null, null);
  const countBefore = env.raw.prepare("SELECT count(*) AS count FROM users").get().count;
  const ambiguousSignup = await handleRegister(request({ ...base, full_name: "ครูซ้ำ", email: "ambiguous@example.invalid" }), env);
  assert.equal(ambiguousSignup.status, 409);
  assert.equal(env.raw.prepare("SELECT user_id FROM personnel_records WHERE id = ?").get(ambiguousId).user_id, null);
  assert.equal(env.raw.prepare("SELECT count(*) AS count FROM users").get().count, countBefore);

});
