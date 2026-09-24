import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { signJWT } from "../src/lib/crypto.js";
import { handleCorrespondenceRoute } from "../src/routes/correspondence.js";

const secret="correspondence-test";
function environment(){
  const db=new DatabaseSync(":memory:");
  db.exec(`PRAGMA foreign_keys=ON;CREATE TABLE users(id INTEGER PRIMARY KEY,email TEXT,full_name TEXT,role TEXT,status TEXT,session_version INTEGER DEFAULT 1,password_changed_at TEXT,last_login_at TEXT,created_at TEXT DEFAULT(datetime('now')));
    CREATE TABLE documents(id INTEGER PRIMARY KEY,title TEXT);CREATE TABLE audit_logs(id INTEGER PRIMARY KEY AUTOINCREMENT,user_id INTEGER,action TEXT,resource TEXT,resource_id INTEGER,details TEXT,ip_address TEXT,created_at TEXT DEFAULT(datetime('now')));
    INSERT INTO users(id,email,full_name,role,status) VALUES (1,'staff@example.invalid','ธุรการ','staff','active'),(2,'a@example.invalid','ครู ก','teacher','active'),(3,'b@example.invalid','ครู ข','teacher','active');`);
  function prepare(sql){let values=[];return{bind(...args){values=args;return this},async first(){return db.prepare(sql).get(...values)||null},async all(){return{results:db.prepare(sql).all(...values)}},async run(){const r=db.prepare(sql).run(...values);return{meta:{changes:Number(r.changes),last_row_id:Number(r.lastInsertRowid)}}}}}
  return{raw:db,JWT_SECRET:secret,DB:{prepare,async batch(statements){const out=[];for(const s of statements)out.push(await s.run());return out}}};
}
async function call(env,userId,path,method="GET",body){const token=await signJWT({sub:userId,sv:1},secret);return handleCorrespondenceRoute(new Request(`https://school.example${path}`,{method,headers:{Cookie:`bpd_session=${token}`,'content-type':'application/json'},body:body?JSON.stringify(body):undefined}),env,new URL(`https://school.example${path}`).pathname,method)}

test("e-office issues register numbers and limits teacher visibility",async()=>{
  const env=environment();
  const created=await call(env,1,"/api/correspondence","POST",{register_type:"incoming",subject:"แจ้งกำหนดการประชุม",sender:"สำนักงานเขต",assigned_to:2,received_date:"2026-09-24"});
  assert.equal(created.status,201);const payload=await created.json();assert.match(payload.register_no,/^รับ-2569-0001$/);
  const assigned=await call(env,2,"/api/correspondence");assert.equal((await assigned.json()).records.length,1);
  const other=await call(env,3,"/api/correspondence");assert.equal((await other.json()).records.length,0);
  const denied=await call(env,2,"/api/correspondence/1","PATCH",{status:"completed"});assert.equal(denied.status,403);
  const updated=await call(env,1,"/api/correspondence/1","PATCH",{status:"routed",note:"เสนอผู้อำนวยการ"});assert.equal(updated.status,200);
  const saved=env.raw.prepare("SELECT status,assigned_to,received_date FROM correspondence_records WHERE id=1").get();
  assert.equal(saved.status,"routed");assert.equal(saved.assigned_to,2);assert.equal(saved.received_date,"2026-09-24");
  assert.equal(env.raw.prepare("SELECT action FROM audit_logs").get().action,"create");
});
