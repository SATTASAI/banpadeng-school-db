import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { signJWT } from "../src/lib/crypto.js";
import { handleAdminUpdateUser } from "../src/index.js";

const secret = "admin-user-rename-test";
function environment() {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE users(id INTEGER PRIMARY KEY,email TEXT UNIQUE,full_name TEXT,role TEXT,status TEXT,created_at TEXT,approved_at TEXT,approved_by INTEGER,deleted_at TEXT);
    CREATE TABLE audit_logs(id INTEGER PRIMARY KEY AUTOINCREMENT,user_id INTEGER,action TEXT,resource TEXT,resource_id INTEGER,details TEXT,ip_address TEXT,created_at TEXT DEFAULT(datetime('now')));
    CREATE TABLE personnel_records(id INTEGER PRIMARY KEY,full_name TEXT);
    CREATE TABLE personnel_accounts(user_id INTEGER,personnel_id INTEGER);
    INSERT INTO users VALUES(1,'admin@x.invalid','ผู้ดูแล','superadmin','active','2026-01-01',NULL,NULL,NULL),(2,'t@x.invalid','สมชาย ใจดีี','teacher','active','2026-01-01',NULL,NULL,NULL),(3,'s@x.invalid','ครูสาม','teacher','active','2026-01-01',NULL,NULL,NULL);
    INSERT INTO personnel_records VALUES(10,'สมชาย ใจดีี'),(11,'นางสาวครูสาม');
    INSERT INTO personnel_accounts VALUES(2,10),(3,11);`);
  const prepare = (sql) => { let v = []; return { bind(...a) { v = a; return this; }, async first() { return db.prepare(sql).get(...v) || null; }, async all() { return { results: db.prepare(sql).all(...v) }; }, async run() { const r = db.prepare(sql).run(...v); return { meta: { changes: Number(r.changes) } }; } }; };
  return { raw: db, JWT_SECRET: secret, DB: { prepare } };
}
async function rename(env, actorId, targetId, full_name) {
  const token = await signJWT({ sub: actorId }, secret);
  return handleAdminUpdateUser(new Request(`https://school.example/api/admin/users/${targetId}`, { method: "PATCH", headers: { Cookie: `bpd_session=${token}` }, body: JSON.stringify({ full_name }) }), env, targetId);
}
test("admin can rename a user; linked personnel record with the same name follows", async () => {
  const env = environment();
  const r = await rename(env, 1, 2, "  สมชาย   ใจดี ");
  assert.equal(r.status, 200);
  assert.equal((await r.json()).user.full_name, "สมชาย ใจดี");
  assert.equal(env.raw.prepare("SELECT full_name FROM personnel_records WHERE id=10").get().full_name, "สมชาย ใจดี");
  const audit = JSON.parse(env.raw.prepare("SELECT details FROM audit_logs ORDER BY id DESC").get().details);
  assert.equal(audit.previous_full_name, "สมชาย ใจดีี");
});
test("personnel record named differently is left alone", async () => {
  const env = environment();
  assert.equal((await rename(env, 1, 3, "ครูสาม ดีมาก")).status, 200);
  assert.equal(env.raw.prepare("SELECT full_name FROM personnel_records WHERE id=11").get().full_name, "นางสาวครูสาม");
});
test("non-admin cannot rename and invalid names are rejected", async () => {
  const env = environment();
  assert.equal((await rename(env, 2, 3, "ชื่อใหม่")).status, 403);
  for (const bad of ["", "ก", "<b>x</b>", "x".repeat(121), 5]) assert.equal((await rename(env, 1, 2, bad)).status, 400, String(bad));
  assert.equal(env.raw.prepare("SELECT full_name FROM users WHERE id=2").get().full_name, "สมชาย ใจดีี");
});
