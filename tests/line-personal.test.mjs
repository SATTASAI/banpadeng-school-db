import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import worker from "../src/index.js";
import { signJWT } from "../src/lib/crypto.js";
import { maintenancePersonalRecipients, generateLinkCode, LINK_CODE_PATTERN } from "../src/lib/line-personal.js";

const SECRET = "line-personal-test";
const CHANNEL_SECRET = "channel-secret";

function fixture() {
  const raw = new DatabaseSync(":memory:");
  raw.exec(readFileSync(new URL("../schema.sql", import.meta.url), "utf8"));
  raw.exec(`INSERT INTO users(id,email,password_hash,password_salt,full_name,role) VALUES
    (1,'admin@test','x','x','ผู้ดูแล','superadmin'),(2,'reporter@test','x','x','ครูผู้แจ้ง','teacher'),
    (3,'tech@test','x','x','ช่างสมชาย','staff'),(4,'other@test','x','x','ครูอื่น','teacher');
    INSERT INTO line_targets(target_type,target_id,display_name,status,is_default) VALUES('group','Cgroup000000001','กลุ่มบริหารทั่วไป','active',1);`);
  function prepare(sql) { let values = []; return {
    bind(...v) { values = v; return this; },
    async first() { return raw.prepare(sql).get(...values) || null; },
    async all() { return { results: raw.prepare(sql).all(...values) }; },
    async run() { const r = raw.prepare(sql).run(...values); return { meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) } }; },
  }; }
  let tail = Promise.resolve();
  return { raw, JWT_SECRET: SECRET, LINE_CHANNEL_SECRET: CHANNEL_SECRET, LINE_CHANNEL_ACCESS_TOKEN: "token", DB: { prepare, batch(statements) {
    const next = tail.then(async () => { raw.exec("BEGIN"); try { const out = []; for (const s of statements) out.push(await s.run()); raw.exec("COMMIT"); return out; } catch (e) { raw.exec("ROLLBACK"); throw e; } });
    tail = next.catch(() => {}); return next;
  } } };
}

const lineCalls = [];
const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init = {}) => {
  const url = String(input?.url || input);
  if (!url.startsWith("https://api.line.me")) return realFetch(input, init);
  const path = new URL(url).pathname;
  lineCalls.push({ path, body: init.body ? JSON.parse(init.body) : null });
  const json = (data) => new Response(JSON.stringify(data), { status: 200, headers: { "Content-Type": "application/json" } });
  if (path === "/v2/bot/info") return json({ basicId: "@bpdschool", displayName: "โรงเรียนบ้านป่าเด็ง" });
  if (path.startsWith("/v2/bot/profile/")) return json({ displayName: "Somchai LINE" });
  if (path.endsWith("/members/count")) return json({ count: 5 });
  if (path === "/v2/bot/message/quota") return json({ type: "none" });
  if (path === "/v2/bot/message/quota/consumption") return json({ totalUsage: 0 });
  return json({});
};

async function call(env, path, method = "GET", body, user = 1) {
  const token = await signJWT({ sub: user }, SECRET);
  const response = await worker.fetch(new Request(`https://school.test${path}`, { method,
    headers: { Cookie: `bpd_session=${token}`, "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined }), env, {});
  return { status: response.status, body: await response.json() };
}

async function webhook(env, events) {
  const body = JSON.stringify({ events });
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(CHANNEL_SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signature = btoa(String.fromCharCode(...new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body)))));
  const response = await worker.fetch(new Request("https://school.test/api/line/webhook", { method: "POST", headers: { "x-line-signature": signature, "Content-Type": "application/json" }, body }), env, {});
  assert.equal(response.status, 200);
}

const textEvent = (userId, text, n = 1) => ({ type: "message", webhookEventId: `ev-${userId}-${text}-${n}`, replyToken: `reply-${n}`, source: { type: "user", userId }, message: { type: "text", text } });

test("link codes match the documented format", () => {
  const code = generateLinkCode();
  assert.match(code, /^[A-Z0-9]{6}$/);
  assert.ok(LINK_CODE_PATTERN.test(`BPD-${code}`));
  assert.ok(LINK_CODE_PATTERN.test(` bpd${code.toLowerCase()} `));
  assert.ok(!LINK_CODE_PATTERN.test("สวัสดีครับ"));
});

test("personal recipients follow the repair workflow and never include the actor", () => {
  const item = { reported_by: 2, assigned_to: 3 };
  assert.deepEqual(maintenancePersonalRecipients(item, "assigned", 1), [{ user_id: 3, role: "assignee" }]);
  assert.deepEqual(maintenancePersonalRecipients(item, "completed", 3), [{ user_id: 2, role: "reporter" }]);
  assert.deepEqual(maintenancePersonalRecipients(item, "verified", 2), [{ user_id: 3, role: "assignee" }]);
  assert.deepEqual(maintenancePersonalRecipients(item, "reported", 2), []);
  assert.deepEqual(maintenancePersonalRecipients({ reported_by: 3, assigned_to: 3 }, "completed", 3), []);
});

test("teacher links LINE with a one-time code and receives repair assignments personally", async () => {
  const env = fixture();
  lineCalls.length = 0;

  const before = await call(env, "/api/line/link", "GET", null, 3);
  assert.equal(before.status, 200);
  assert.equal(before.body.linked, false);
  assert.equal(before.body.official_account.add_friend_url, "https://line.me/R/ti/p/%40bpdschool");

  const codeResponse = await call(env, "/api/line/link/code", "POST", {}, 3);
  assert.equal(codeResponse.status, 200, JSON.stringify(codeResponse.body));
  const code = codeResponse.body.code;
  assert.match(code, /^BPD-[A-Z0-9]{6}$/);
  assert.equal(env.raw.prepare("SELECT COUNT(*) n FROM line_link_codes WHERE code_hash=?").get(code).n, 0, "code is stored hashed");

  await webhook(env, [textEvent("Utech0000000001", code)]);
  const link = env.raw.prepare("SELECT * FROM line_user_links WHERE user_id=3").get();
  assert.equal(link.line_user_id, "Utech0000000001");
  assert.equal(link.display_name, "Somchai LINE");
  assert.ok(lineCalls.some((c) => c.path === "/v2/bot/message/reply" && c.body.messages[0].text.includes("เชื่อมต่อสำเร็จ")));
  assert.equal((await call(env, "/api/line/link", "GET", null, 3)).body.linked, true);

  // รหัสใช้ซ้ำไม่ได้ และบัญชี LINE เดียวกันผูกกับผู้ใช้อื่นไม่ได้
  const second = await call(env, "/api/line/link/code", "POST", {}, 4);
  await webhook(env, [textEvent("Utech0000000001", second.body.code, 2)]);
  assert.equal(env.raw.prepare("SELECT COUNT(*) n FROM line_user_links WHERE user_id=4").get().n, 0);

  const users = await call(env, "/api/users", "GET", null, 1);
  assert.equal(users.body.users.find((u) => u.id === 3).line_linked, true);
  assert.equal(users.body.users.find((u) => u.id === 2).line_linked, false);

  // ครูแจ้งซ่อม → ผู้ดูแลมอบหมายให้ช่าง
  const created = await call(env, "/api/maintenance/requests", "POST",
    { title: "ไฟห้อง ป.4/2 ไม่ติด", description: "หลอดไฟดับ 2 ดวง", category: "electrical", custom_location: "ห้อง ป.4/2", defer_notification: true }, 2);
  assert.equal(created.status, 201, JSON.stringify(created.body));
  lineCalls.length = 0;
  const assigned = await call(env, `/api/maintenance/requests/${created.body.id}`, "PATCH", { status: "assigned", assigned_to: 3 }, 1);
  assert.equal(assigned.status, 200, JSON.stringify(assigned.body));
  const pushes = lineCalls.filter((c) => c.path === "/v2/bot/message/push");
  assert.deepEqual(pushes.map((p) => p.body.to).sort(), ["Cgroup000000001", "Utech0000000001"]);
  const personal = pushes.find((p) => p.body.to === "Utech0000000001");
  assert.equal(personal.body.messages[0].contents.body.contents[0].text, "คุณได้รับมอบหมายงานซ่อม");
  assert.ok(assigned.body.line_notification.results.some((r) => r.recipient_type === "user" && r.delivery_status === "sent" && r.recipient_label === "ช่างสมชาย"));

  // ช่างเริ่มซ่อม → ผู้แจ้งยังไม่เชื่อม LINE จึงบันทึกเป็น not_linked และไม่ส่งเข้ากลุ่มเอง
  lineCalls.length = 0;
  const started = await call(env, `/api/maintenance/requests/${created.body.id}`, "PATCH", { status: "in_progress" }, 3);
  assert.equal(started.status, 200, JSON.stringify(started.body));
  assert.equal(lineCalls.filter((c) => c.path === "/v2/bot/message/push").length, 0);
  assert.equal(started.body.line_notification.delivery_status, "not_linked");
  const log = env.raw.prepare("SELECT recipient_type,recipient_user_id,delivery_status FROM maintenance_notifications WHERE request_id=? ORDER BY id").all(created.body.id);
  assert.deepEqual(log.map((row) => `${row.recipient_type}:${row.recipient_user_id ?? "-"}:${row.delivery_status}`),
    ["user:3:sent", "group:-:sent", "user:2:not_linked"]);

  // ช่างบล็อก OA → หยุดส่งรายบุคคล
  await webhook(env, [{ type: "unfollow", webhookEventId: "unfollow-1", source: { type: "user", userId: "Utech0000000001" } }]);
  assert.equal(env.raw.prepare("SELECT status FROM line_user_links WHERE user_id=3").get().status, "blocked");
  assert.equal((await call(env, "/api/users", "GET", null, 1)).body.users.find((u) => u.id === 3).line_linked, false);

  const unlinked = await call(env, "/api/line/link", "DELETE", null, 3);
  assert.equal(unlinked.status, 200);
  assert.equal(env.raw.prepare("SELECT COUNT(*) n FROM line_user_links WHERE user_id=3").get().n, 0);
});

test("wrong codes are rate limited per LINE account", async () => {
  const env = fixture();
  for (let i = 0; i < 6; i += 1) await webhook(env, [textEvent("Uguess000000001", "BPD-ZZZZZZ", i)]);
  const replies = lineCalls.filter((c) => c.path === "/v2/bot/message/reply").slice(-1);
  assert.ok(replies[0].body.messages[0].text.includes("หลายครั้ง"));
  assert.equal(env.raw.prepare("SELECT COUNT(*) n FROM line_link_failures").get().n, 5);
});

test("linked users list is superadmin only", async () => {
  const env = fixture();
  assert.equal((await call(env, "/api/line/linked-users", "GET", null, 2)).status, 403);
  const admin = await call(env, "/api/line/linked-users", "GET", null, 1);
  assert.equal(admin.status, 200);
  assert.equal(admin.body.active_user_count, 4);
});

test("admin matches a LINE friend to a teacher and the teacher gets a confirmation", async () => {
  const env = fixture();
  await webhook(env, [{ type: "follow", webhookEventId: "follow-1", replyToken: "r", source: { type: "user", userId: "Uanne0000000001" } },
    textEvent("Uanne0000000001", "สวัสดีค่ะ", 9)]);
  assert.equal((await call(env, "/api/line/match", "GET", null, 2)).status, 403);
  const list = await call(env, "/api/line/match", "GET", null, 1);
  assert.equal(list.status, 200);
  const account = list.body.accounts.find((a) => !a.linked_user_id);
  assert.equal(account.display_name, "Somchai LINE");
  lineCalls.length = 0;
  const matched = await call(env, "/api/line/match", "POST", { account_id: account.id, user_id: 2 }, 1);
  assert.equal(matched.status, 200, JSON.stringify(matched.body));
  assert.equal(matched.body.notified, true);
  const confirmPush = lineCalls.find((c) => c.path === "/v2/bot/message/push");
  assert.equal(confirmPush.body.to, "Uanne0000000001");
  assert.ok(confirmPush.body.messages[0].text.includes("ครูผู้แจ้ง"));
  assert.equal(env.raw.prepare("SELECT line_user_id FROM line_user_links WHERE user_id=2").get().line_user_id, "Uanne0000000001");
  // บัญชีเดียวจับคู่ซ้ำกับครูอีกคนไม่ได้
  assert.equal((await call(env, "/api/line/match", "POST", { account_id: account.id, user_id: 4 }, 1)).status, 409);
  const after = await call(env, "/api/line/match", "GET", null, 1);
  assert.equal(after.body.accounts.find((a) => a.id === account.id).linked_user_name, "ครูผู้แจ้ง");
  assert.equal((await call(env, "/api/line/match/2", "DELETE", null, 1)).status, 200);
  assert.equal(env.raw.prepare("SELECT COUNT(*) n FROM line_user_links").get().n, 0);
});

test("repair requests go to the general-administration head instead of the school LINE group", async () => {
  const env = fixture();
  await call(env, "/api/overview");
  const head = env.raw.prepare("SELECT id FROM personnel_records WHERE user_id=4").get();
  assert.ok(head, "personnel record exists for the head");
  assert.equal((await call(env, "/api/department-staff/general", "POST", { personnel_id: head.id, is_head: true })).status, 200);
  env.raw.exec("INSERT INTO line_user_links(user_id,line_user_id,display_name) VALUES(4,'Uhead0000000001','หัวหน้าทั่วไป'),(3,'Utech0000000002','ช่าง')");
  lineCalls.length = 0;
  const created = await call(env, "/api/maintenance/requests", "POST",
    { title: "ก๊อกน้ำรั่ว", description: "ห้องน้ำชาย", category: "plumbing", custom_location: "ห้องน้ำ" }, 2);
  assert.equal(created.status, 201, JSON.stringify(created.body));
  let pushes = lineCalls.filter((c) => c.path === "/v2/bot/message/push").map((c) => c.body);
  assert.deepEqual(pushes.map((p) => p.to), ["Uhead0000000001"], "only the head, not the group");
  assert.equal(pushes[0].messages[0].contents.body.contents[0].text, "มีแจ้งซ่อมใหม่ รอมอบหมายช่าง");

  // หัวหน้าฝ่าย (บทบาทครู) จัดการงานซ่อมได้ และไม่ได้รับแจ้งเรื่องที่ตัวเองมอบหมาย
  const summary = await call(env, "/api/maintenance/summary", "GET", null, 4);
  assert.equal(summary.body.can_manage, true);
  assert.equal(summary.body.line_to_head, true);
  lineCalls.length = 0;
  const assigned = await call(env, `/api/maintenance/requests/${created.body.id}`, "PATCH", { status: "assigned", assigned_to: 3 }, 4);
  assert.equal(assigned.status, 200, JSON.stringify(assigned.body));
  pushes = lineCalls.filter((c) => c.path === "/v2/bot/message/push").map((c) => c.body.to);
  assert.deepEqual(pushes, ["Utech0000000002"]);
  // ช่างซ่อมเสร็จ → หัวหน้าฝ่ายและผู้แจ้งได้รับ (ผู้แจ้งยังไม่เชื่อม LINE)
  await call(env, `/api/maintenance/requests/${created.body.id}`, "PATCH", { status: "in_progress" }, 3);
  lineCalls.length = 0;
  const done = await call(env, `/api/maintenance/requests/${created.body.id}`, "PATCH", { status: "completed", resolution: "เปลี่ยนก๊อก" }, 3);
  assert.equal(done.status, 200, JSON.stringify(done.body));
  assert.deepEqual(lineCalls.filter((c) => c.path === "/v2/bot/message/push").map((c) => c.body.to), ["Uhead0000000001"]);
  assert.equal((await call(env, "/api/maintenance/summary", "GET", null, 2)).body.can_manage, false, "ordinary teachers still cannot manage");
});

test("repair photos are stored in R2 even when the main file store is Google Drive", async () => {
  const env = fixture();
  const objects = new Map();
  env.FILE_STORAGE_PROVIDER = "drive";
  env.FILES = {
    async put(key, body) { objects.set(key, new Uint8Array(await new Response(body).arrayBuffer())); },
    async get(key) { const data = objects.get(key); return data ? { body: new Blob([data]).stream(), httpMetadata: { contentType: "image/png" }, size: data.length } : null; },
    async delete(key) { objects.delete(key); },
  };
  const created = await call(env, "/api/maintenance/requests", "POST",
    { title: "กระจกแตก", description: "หน้าต่างห้องสมุด", category: "building", custom_location: "ห้องสมุด", defer_notification: true }, 2);
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const png = Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="), (c) => c.charCodeAt(0));
  const form = new FormData();
  form.set("file", new File([png], "before.png", { type: "image/png" }));
  const token = await signJWT({ sub: 2 }, SECRET);
  const response = await worker.fetch(new Request(`https://school.test/api/attachments/maintenance_before/${created.body.id}`, { method: "POST", headers: { Cookie: `bpd_session=${token}` }, body: form }), env, {});
  const body = await response.json();
  assert.equal(response.status, 201, JSON.stringify(body));
  assert.equal(body.storage_provider, "r2");
  assert.equal(objects.size, 1);
  const download = await worker.fetch(new Request(`https://school.test/api/attachments/${body.id}`, { headers: { Cookie: `bpd_session=${token}` } }), env, {});
  assert.equal(download.status, 200);
  assert.equal((await download.arrayBuffer()).byteLength, png.length);
});
