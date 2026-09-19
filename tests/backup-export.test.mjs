import test from "node:test";
import assert from "node:assert/strict";
import { signJWT } from "../src/lib/crypto.js";
import { handleBackupExport } from "../src/routes/backup-export.js";

const secret = "test-secret-for-export";
function environment(role = "superadmin") {
  const queries = [];
  return {
    JWT_SECRET: secret,
    CLOUDFLARE_ACCOUNT_ID: "account-test",
    CLOUDFLARE_D1_BACKUP_TOKEN: "token-test",
    queries,
    DB: {
      prepare(sql) {
        const stmt = {
          bind(...values) { queries.push({ sql, values }); return stmt; },
          async first() { return { id: 1, role, status: "active", full_name: "ผู้ทดสอบ" }; },
          async run() { return { success: true }; },
        };
        return stmt;
      },
    },
  };
}
async function request(path, token, body = {}) {
  return new Request(`https://school.example/api/security/backup/${path}`, {
    method: "POST",
    headers: { Origin: "https://school.example", Cookie: `bpd_session=${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

test("only superadmin can start an export", async () => {
  const env = environment("executive");
  const token = await signJWT({ sub: 1 }, secret);
  const response = await handleBackupExport(await request("start", token), env, "/api/security/backup/start");
  assert.equal(response.status, 403);
});

test("polling uses a short-lived signed ticket without querying blocked D1", async () => {
  const env = environment();
  const token = await signJWT({ sub: 1 }, secret);
  let calls = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_url, options) => {
    calls++;
    const body = JSON.parse(options.body);
    if (calls === 1) assert.equal(body.current_bookmark, undefined);
    else assert.equal(body.current_bookmark, "bookmark-123");
    return Response.json({ success: true, result: { at_bookmark: "bookmark-123", success: true } });
  };
  try {
    const start = await handleBackupExport(await request("start", token), env, "/api/security/backup/start");
    const { ticket } = await start.json();
    assert.equal(start.status, 200);
    const queriesBeforePoll = env.queries.length;
    const poll = await handleBackupExport(await request("poll", token, { ticket }), env, "/api/security/backup/poll");
    assert.equal(poll.status, 200);
    assert.equal(env.queries.length, queriesBeforePoll);
    assert.equal(calls, 2);
  } finally { globalThis.fetch = originalFetch; }
});

test("download proxies SQL without exposing signed URL and records audit", async () => {
  const env = environment();
  const token = await signJWT({ sub: 1 }, secret);
  const ticket = await signJWT({ purpose: "d1_backup_export", sub: 1, bookmark: "bookmark-123" }, secret, 600);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async url => String(url).includes("api.cloudflare.com")
    ? Response.json({ success: true, result: { status: "complete", at_bookmark: "bookmark-123", result: { signed_url: "https://download.example/file.sql" } } })
    : new Response("CREATE TABLE example (id INTEGER);");
  try {
    const response = await handleBackupExport(await request("download", token, { ticket }), env, "/api/security/backup/download");
    assert.equal(response.status, 200);
    assert.match(response.headers.get("Content-Disposition"), /attachment/);
    assert.equal(await response.text(), "CREATE TABLE example (id INTEGER);");
    assert.equal(env.queries.filter(row => row.sql.includes("INSERT INTO backup_registry")).length, 1);
    assert.equal(env.queries.filter(row => row.sql.includes("INSERT INTO audit_logs")).length, 1);
    assert.ok(!JSON.stringify(env.queries).includes("download.example"));
  } finally { globalThis.fetch = originalFetch; }
});
