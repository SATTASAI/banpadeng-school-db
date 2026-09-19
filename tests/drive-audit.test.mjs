import test from "node:test";
import assert from "node:assert/strict";
import { signJWT } from "../src/lib/crypto.js";
import { handleDriveAudit } from "../src/routes/drive-audit.js";

const secret = "test-secret-for-drive-audit";
function environment(role = "superadmin") {
  const rows = [
    { id: 1, file_name: "one.pdf", drive_file_id: "file1", file_size: 10 },
    { id: 2, file_name: "two.pdf", drive_file_id: "file2", file_size: 20 },
    { id: 3, file_name: "three.pdf", drive_file_id: null, file_size: 30 },
  ];
  return { JWT_SECRET: secret, DB: { prepare(sql) {
    let values = [];
    const statement = {
      bind(...args) { values = args; return statement; },
      async first() { return sql.includes("FROM users") ? { id: 1, role, status: "active" } : { count: rows.length }; },
      async all() { return { results: rows.slice(values[1], values[1] + values[0]) }; },
    };
    return statement;
  } } };
}
async function request(offset = 0) {
  const token = await signJWT({ sub: 1 }, secret);
  return new Request(`https://school.example/api/security/drive-audit?offset=${offset}`, { headers: { Cookie: `bpd_session=${token}` } });
}

test("drive audit checks files without returning Drive credentials", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async url => url.includes("file1")
    ? Response.json({ size: "10", trashed: false })
    : new Response("missing", { status: 404 });
  try {
    const response = await handleDriveAudit(await request(), environment(), async () => "private-token");
    const text = await response.text();
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("Cache-Control"), "private, no-store");
    assert.deepEqual(JSON.parse(text).checked.map(x => x.status), ["ok", "missing", "missing_reference"]);
    assert.equal(JSON.parse(text).next_offset, null);
    assert.ok(!text.includes("private-token"));
  } finally { globalThis.fetch = original; }
});

test("drive audit denies nonadmin and rejects malformed offsets", async () => {
  const denied = await handleDriveAudit(await request(), environment("executive"), async () => { throw Error("unexpected"); });
  assert.equal(denied.status, 403);
  const invalid = await handleDriveAudit(await request("-1"), environment(), async () => { throw Error("unexpected"); });
  assert.equal(invalid.status, 400);
});
