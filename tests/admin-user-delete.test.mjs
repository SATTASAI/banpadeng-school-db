import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { signJWT } from "../src/lib/crypto.js";
import { handleAdminDeleteUser } from "../src/index.js";

const secret = "admin-user-delete-test";

function environment() {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE users(
      id INTEGER PRIMARY KEY,email TEXT UNIQUE,full_name TEXT,role TEXT,status TEXT,created_at TEXT,
      deleted_at TEXT,deleted_by INTEGER
    );
    CREATE TABLE audit_logs(
      id INTEGER PRIMARY KEY AUTOINCREMENT,user_id INTEGER,action TEXT,resource TEXT,
      resource_id INTEGER,details TEXT,ip_address TEXT,created_at TEXT DEFAULT(datetime('now'))
    );
    INSERT INTO users VALUES
      (1,'admin@example.invalid','ผู้ดูแลระบบ','superadmin','active','2026-01-01',NULL,NULL),
      (2,'teacher@example.invalid','ครูตัวอย่าง','teacher','active','2026-01-01',NULL,NULL),
      (3,'other@example.invalid','ผู้ใช้ทั่วไป','teacher','active','2026-01-01',NULL,NULL);
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
  return { raw: db, JWT_SECRET: secret, DB: { prepare } };
}

async function remove(env, actorId, targetId) {
  const token = await signJWT({ sub: actorId }, secret);
  return handleAdminDeleteUser(new Request(`https://school.example/api/admin/users/${targetId}`, {
    method: "DELETE", headers: { Cookie: `bpd_session=${token}` },
  }), env, targetId);
}

test("admin can remove another login while preserving its audit identity row", async () => {
  const env = environment();
  const response = await remove(env, 1, 2);
  assert.equal(response.status, 200);
  const removed = env.raw.prepare("SELECT * FROM users WHERE id=2").get();
  assert.equal(removed.status, "disabled");
  assert.equal(removed.role, null);
  assert.ok(removed.deleted_at);
  assert.equal(removed.deleted_by, 1);
  assert.match(removed.email, /^deleted-2-\d+@removed\.invalid$/);
  const audit = env.raw.prepare("SELECT action,resource,resource_id FROM audit_logs").get();
  assert.equal(audit.action, "delete");
  assert.equal(audit.resource, "user");
  assert.equal(audit.resource_id, 2);
});

test("admin cannot remove their own login and ordinary users cannot remove accounts", async () => {
  const env = environment();
  assert.equal((await remove(env, 1, 1)).status, 400);
  assert.equal((await remove(env, 3, 2)).status, 403);
  assert.equal(env.raw.prepare("SELECT deleted_at FROM users WHERE id=2").get().deleted_at, null);
});
