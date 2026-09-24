import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { generateSalt, hashPassword, signJWT, verifyPassword } from "../src/lib/crypto.js";
import { getCurrentUser } from "../src/lib/auth.js";
import { handleChangePassword } from "../src/index.js";

const secret = "account-security-test";
function adapter(db) {
  function prepare(sql) {
    let values = [];
    return { bind(...args){ values=args; return this; }, async first(){ return db.prepare(sql).get(...values)||null; },
      async all(){ return {results:db.prepare(sql).all(...values)}; }, async run(){ const r=db.prepare(sql).run(...values); return {meta:{changes:Number(r.changes),last_row_id:Number(r.lastInsertRowid)}}; } };
  }
  return { prepare, async batch(statements){ const out=[]; for(const statement of statements) out.push(await statement.run()); return out; } };
}

test("changing password revokes the old session and records an audit event", async () => {
  const db=new DatabaseSync(":memory:");
  db.exec(`CREATE TABLE users(id INTEGER PRIMARY KEY,email TEXT,full_name TEXT,role TEXT,status TEXT,password_hash TEXT,password_salt TEXT,
    session_version INTEGER DEFAULT 1,password_changed_at TEXT,last_login_at TEXT,created_at TEXT DEFAULT(datetime('now')));
    CREATE TABLE audit_logs(id INTEGER PRIMARY KEY AUTOINCREMENT,user_id INTEGER,action TEXT,resource TEXT,resource_id INTEGER,details TEXT,ip_address TEXT,created_at TEXT DEFAULT(datetime('now')));`);
  const salt=generateSalt(),oldHash=await hashPassword("old-password",salt);
  db.prepare("INSERT INTO users(id,email,full_name,role,status,password_hash,password_salt) VALUES (1,'teacher@example.invalid','ครูทดสอบ','teacher','active',?,?)").run(oldHash,salt);
  const env={DB:adapter(db),JWT_SECRET:secret};
  const oldToken=await signJWT({sub:1,sv:1},secret);
  const response=await handleChangePassword(new Request("https://school.example/api/auth/change-password",{method:"POST",headers:{Cookie:`bpd_session=${oldToken}`,'content-type':'application/json'},body:JSON.stringify({current_password:"old-password",new_password:"new-password-2569"})}),env);
  assert.equal(response.status,200);
  assert.equal(db.prepare("SELECT session_version FROM users WHERE id=1").get().session_version,2);
  assert.equal(await getCurrentUser(new Request("https://school.example",{headers:{Cookie:`bpd_session=${oldToken}`}}),env),null);
  const changed=db.prepare("SELECT password_hash,password_salt FROM users WHERE id=1").get();
  assert.equal(await verifyPassword("new-password-2569",changed.password_salt,changed.password_hash),true);
  assert.equal(db.prepare("SELECT action FROM audit_logs").get().action,"change_password");
});
