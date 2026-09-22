import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { handleRegister } from "../src/index.js";

function environment() {
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
  const duplicatePayload = await duplicateNameResponse.json();
  const duplicateProfile = env.raw.prepare("SELECT * FROM personnel_records WHERE user_id = ?")
    .get(duplicatePayload.user.id);
  assert.equal(duplicateProfile.full_name, base.full_name);
  assert.equal(duplicateProfile.email, "another-teacher@example.invalid");
  assert.match(duplicateProfile.normalized_name, /#user:\d+$/);

  const duplicateEmailResponse = await handleRegister(request(base), env);
  assert.equal(duplicateEmailResponse.status, 409);
});
