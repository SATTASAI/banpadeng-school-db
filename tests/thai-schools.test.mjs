import test from "node:test";
import assert from "node:assert/strict";
import { signJWT } from "../src/lib/crypto.js";
import { handleThaiSchools } from "../src/routes/thai-schools.js";
import { fixture, form } from "./student-transfers.fixture.mjs";

async function call(env, path, method = "GET", body, user = 1) {
  const token = await signJWT({ sub: user }, env.JWT_SECRET);
  const headers = { Cookie: `bpd_session=${token}` };
  if (body) headers["Content-Type"] = "application/json";
  const request = new Request("https://school.test" + path, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const res = await handleThaiSchools(request, env, new URL(request.url).pathname, method);
  return { status: res.status, data: await res.json() };
}

test("import is superadmin-only, upserts, and search finds by name or code", async () => {
  const { env, call: transfer } = await fixture();
  const rows = [
    { school_code: "1076300001", smis_code: "76010001", name: "โรงเรียนวัดช้างแทงกระจาด", district: "อำเภอเมืองเพชรบุรี", province: "จังหวัดเพชรบุรี" },
    { school_code: "12", name: "ผิด" },
  ];
  assert.equal((await call(env, "/api/thai-schools/import", "POST", { rows }, 3)).status, 403);
  const saved = await call(env, "/api/thai-schools/import", "POST", { rows });
  assert.equal(saved.data.saved, 1);
  assert.equal(saved.data.skipped.length, 1);
  await call(env, "/api/thai-schools/import", "POST", { rows: [rows[0]] });
  const byName = await call(env, "/api/thai-schools?q=" + encodeURIComponent("ช้างแทง"), "GET", null, 3);
  assert.deepEqual(byName.data.schools.map((s) => [s.school_code, s.name, s.district, s.province]), [
    ["1076300001", "วัดช้างแทงกระจาด", "เมืองเพชรบุรี", "เพชรบุรี"],
  ]);
  assert.equal((await call(env, "/api/thai-schools?q=107630", "GET", null, 3)).data.schools.length, 1);
  assert.equal((await call(env, "/api/thai-schools", "GET", null, 3)).data.total, 1);

  const ok = await transfer("", "POST", form({ client_ref: "code-ok", school_code: "1076300001" }));
  const created = await ok.json();
  assert.ok(ok.status < 300, JSON.stringify(created));
  const list = await (await transfer("", "GET")).json();
  assert.equal(list.requests.find((r) => r.id === created.id).school_code, "1076300001");
});
