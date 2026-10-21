import test from "node:test";
import assert from "node:assert/strict";
import { fixture, call } from "./notifications.test.mjs";
import { dispatchLineNotifications, retryKeyFor, classifyPushFailure } from "../src/lib/line-feed.js";
import worker, { publicOrigin } from "../src/index.js";

// LINE ปลอม: กำหนดสถานะตอบกลับของ push ทีละครั้งได้
function mockLine(statuses = []) {
  const pushes = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    if (u.endsWith("/v2/bot/message/push")) {
      pushes.push({ body: JSON.parse(init.body), retryKey: init.headers?.["X-Line-Retry-Key"], signal: !!init.signal });
      const next = statuses.length ? statuses.shift() : 200;
      if (next === "timeout") { const e = new Error("timed out"); e.name = "TimeoutError"; throw e; }
      return new Response(next === 200 ? "{}" : '{"message":"error"}', { status: next });
    }
    if (u.endsWith("/v2/bot/message/quota")) return Response.json({ type: "none" });
    if (u.endsWith("/v2/bot/message/quota/consumption")) return Response.json({ totalUsage: 0 });
    return new Response("{}", { status: 404 });
  };
  return { pushes, restore: () => { globalThis.fetch = original; } };
}
async function setup() {
  const env = await fixture();
  env.LINE_CHANNEL_ACCESS_TOKEN = "token";
  env.PUBLIC_BASE_URL = "https://school.test";
  await call(env, "/api/overview");
  await call(env, "/api/notifications", "GET", undefined, 2);
  env.raw.exec(`CREATE TABLE IF NOT EXISTS line_user_links(user_id INTEGER PRIMARY KEY,line_user_id TEXT NOT NULL UNIQUE,display_name TEXT,
    status TEXT NOT NULL DEFAULT 'active',linked_at TEXT NOT NULL DEFAULT(datetime('now')),updated_at TEXT NOT NULL DEFAULT(datetime('now')));
    INSERT INTO line_user_links(user_id,line_user_id) VALUES(2,'U-teacher');`);
  const line = mockLine();
  try { await dispatchLineNotifications(env); } finally { line.restore(); } // baseline run
  return env;
}
const unlock = (env) => env.raw.exec("UPDATE line_feed_runs SET started_at=NULL");
const newTask = (env, id, title) => env.raw.exec(`INSERT INTO tasks(id,title,created_by) VALUES(${id},'${title}',1);INSERT INTO task_assignees(task_id,user_id) VALUES(${id},2);`);
const state = (env, key) => env.raw.prepare("SELECT status,error FROM line_feed_sent WHERE user_id=2 AND message_key=?").get(key);

test("retry key is a stable UUID per recipient and item set; 409 counts as already delivered", async () => {
  const a = await retryKeyFor("U1", ["task:2", "task:1"]), b = await retryKeyFor("U1", ["task:1", "task:2"]);
  assert.equal(a, b); assert.match(a, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.notEqual(a, await retryKeyFor("U2", ["task:1", "task:2"]));
  assert.deepEqual(classifyPushFailure(409), { ok: true });
  assert.equal(classifyPushFailure(400).permanent, true);
  assert.equal(classifyPushFailure(429).permanent, false);
  assert.equal(classifyPushFailure(500).permanent, false);
});

test("timeouts and server errors retry with the same key; permanent errors stop retrying", async () => {
  const env = await setup();
  newTask(env, 10, "ส่งแผน");
  let line = mockLine(["timeout"]);
  try { unlock(env); await dispatchLineNotifications(env); } finally { line.restore(); }
  assert.equal(state(env, "task:10").status, "failed");
  assert.match(state(env, "task:10").error, /10 วินาที/);
  const firstKey = line.pushes[0].retryKey; assert.ok(firstKey); assert.ok(line.pushes[0].signal, "push uses a timeout");
  env.raw.exec("UPDATE line_feed_sent SET updated_at=datetime('now','-2 minutes') WHERE message_key='task:10'");
  line = mockLine([409]); // LINE had accepted the first attempt
  try { unlock(env); await dispatchLineNotifications(env); } finally { line.restore(); }
  assert.equal(line.pushes[0].retryKey, firstKey, "same key → LINE de-duplicates");
  assert.equal(state(env, "task:10").status, "sent");

  newTask(env, 11, "งานผิดปลายทาง");
  line = mockLine([400]);
  try { unlock(env); await dispatchLineNotifications(env); } finally { line.restore(); }
  assert.equal(state(env, "task:11").status, "skipped");
  env.raw.exec("UPDATE line_feed_sent SET updated_at=datetime('now','-2 minutes') WHERE message_key='task:11'");
  line = mockLine();
  try { unlock(env); await dispatchLineNotifications(env); } finally { line.restore(); }
  assert.equal(line.pushes.length, 0, "permanent failure is not retried");
});

test("lock is held while a run is active, released when it finishes, and recovered when stale", async () => {
  const env = await setup();
  newTask(env, 20, "งานใหม่");
  env.raw.exec("UPDATE line_feed_runs SET started_at=datetime('now','-1 minute'),finished_at=NULL");
  let line = mockLine();
  try { assert.equal((await dispatchLineNotifications(env)).skipped, "locked"); } finally { line.restore(); }
  env.raw.exec("UPDATE line_feed_runs SET started_at=datetime('now','-6 minutes'),finished_at=NULL");
  line = mockLine();
  try { assert.equal((await dispatchLineNotifications(env)).messages_sent, 1); } finally { line.restore(); }
  const run = env.raw.prepare("SELECT started_at,finished_at FROM line_feed_runs WHERE id=1").get();
  assert.ok(run.finished_at >= run.started_at, "finished run releases the lock");
});

test("event runs stop at their time budget and leave the rest for cron; cron cleans old LINE data", async () => {
  const env = await setup();
  newTask(env, 30, "งานหมดเวลา");
  let line = mockLine();
  try {
    unlock(env);
    const run = await dispatchLineNotifications(env, { trigger: "event", budgetMs: -1 });
    assert.equal(run.messages_sent, 0); assert.equal(run.deferred, 1); assert.match(run.note, /เลื่อน 1 คน/);
  } finally { line.restore(); }
  env.raw.exec(`CREATE TABLE IF NOT EXISTS line_webhook_events(id INTEGER PRIMARY KEY,webhook_event_id TEXT UNIQUE,target_id TEXT,source_type TEXT,event_type TEXT,received_at TEXT NOT NULL DEFAULT(datetime('now')));
    INSERT INTO line_webhook_events(webhook_event_id,event_type,received_at) VALUES('old','message',datetime('now','-40 days')),('new','message',datetime('now'));`);
  line = mockLine();
  try { unlock(env); assert.equal((await dispatchLineNotifications(env)).messages_sent, 1); } finally { line.restore(); }
  assert.deepEqual(env.raw.prepare("SELECT webhook_event_id FROM line_webhook_events").all().map((r) => r.webhook_event_id), ["new"]);
});

async function signed(env, body) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(env.LINE_CHANNEL_SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = Buffer.from(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body))).toString("base64");
  const pending = [];
  const res = await worker.fetch(new Request("https://school.test/api/line/webhook", { method: "POST", headers: { "x-line-signature": sig, "Content-Type": "application/json" }, body }), env, { waitUntil: (p) => pending.push(p) });
  await Promise.all(pending);
  return res;
}

test("webhook: redelivered events are processed once and ordinary group chatter does not write to the database", async () => {
  const env = await fixture();
  env.LINE_CHANNEL_SECRET = "secret";
  const line = mockLine();
  try {
    const group = { type: "group", groupId: "C-school", userId: "U-someone" };
    await signed(env, JSON.stringify({ events: [{ type: "join", webhookEventId: "e1", source: group }] }));
    const before = env.raw.prepare("SELECT COUNT(*) n FROM line_webhook_events").get().n;
    for (let i = 0; i < 5; i++) await signed(env, JSON.stringify({ events: [{ type: "message", webhookEventId: `g${i}`, source: group, message: { type: "text", text: "สวัสดี" } }] }));
    assert.equal(env.raw.prepare("SELECT COUNT(*) n FROM line_webhook_events").get().n, before, "group messages are not logged");
    assert.equal(env.raw.prepare("SELECT COUNT(*) n FROM line_targets WHERE target_id='C-school'").get().n, 1);

    const dm = { type: "message", webhookEventId: "d1", source: { type: "user", userId: "U-new" }, message: { type: "text", text: "BPD-ZZZZZZ" }, replyToken: "r" };
    await signed(env, JSON.stringify({ events: [dm] }));
    await signed(env, JSON.stringify({ events: [{ ...dm, deliveryContext: { isRedelivery: true } }] }));
    assert.equal(env.raw.prepare("SELECT COUNT(*) n FROM line_link_failures WHERE line_user_id='U-new'").get().n, 1, "a redelivered wrong code counts once");
    assert.equal((await worker.fetch(new Request("https://school.test/api/line/webhook", { method: "POST", headers: { "x-line-signature": "bad" }, body: "{}" }), env, {})).status, 401);
  } finally { line.restore(); }
});

test("LINE links always point at the school domain", () => {
  assert.equal(publicOrigin({}, new Request("https://banpadeng-school-db.example.workers.dev/api/x")), "https://system.banpadengschool.ac.th");
  assert.equal(publicOrigin({}, new Request("https://system.banpadengschool.ac.th/api/x")), "https://system.banpadengschool.ac.th");
  assert.equal(publicOrigin({ PUBLIC_BASE_URL: "https://school.test/" }, new Request("https://x.test/")), "https://school.test");
});
