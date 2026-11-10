import test from "node:test";
import assert from "node:assert/strict";
import { signJWT } from "../src/lib/crypto.js";
import { ensureThaiSchools, handleThaiSchools } from "../src/routes/thai-schools.js";
import { fixture, form } from "./student-transfers.fixture.mjs";

test("school code verification checks exact SMIS and ministry codes against the school name", async () => {
  const { env } = await fixture();
  await ensureThaiSchools(env);
  env.raw.exec(`INSERT INTO thai_schools (school_code, smis_code, name) VALUES
    ('1076370238', '76020119', 'บ้านป่าเด็ง'),
    ('1076370240', '076020120', 'บ้านป่าเด็ง'),
    ('1076370239', '', 'โรงเรียนทดสอบอื่น')`);
  const token = await signJWT({ sub: 1 }, env.JWT_SECRET);

  async function verify(name, code, signedIn = true) {
    const pathname = "/api/thai-schools/verify";
    const params = new URLSearchParams({ name, code });
    const request = new Request("https://school.test" + pathname + "?" + params, {
      headers: signedIn ? { Cookie: "bpd_session=" + token } : {},
    });
    return handleThaiSchools(request, env, pathname, "GET");
  }

  for (const [name, code, expected] of [
    ["", "76020119", "code_match"],
    ["", "1076370238", "code_match"],
    ["", "7602011", "unknown"],
    [" โรงเรียนบ้านป่าเด็ง ", "76020119", "match"],
    ["ร.ร. บ้านป่าเด็ง", "1076370238", "match"],
    ["บ้านป่าเด็ง", "076020120", "match"],
    ["บ้านป่าเด็ง", "7602011", "mismatch"],
    ["บ้านป่าเด็ง", "1076370239", "mismatch"],
    ["ชื่อโรงเรียนอื่น", "76020119", "mismatch"],
    ["โรงเรียนที่ไม่อยู่ในทะเบียน", "LOCAL-07", "unknown"],
  ]) {
    const response = await verify(name, code);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { status: expected });
  }
  assert.equal((await verify("บ้านป่าเด็ง", "")).status, 400);
  assert.equal((await verify("บ้านป่าเด็ง", "76020119", false)).status, 401);
});

test("code search prioritizes exact matches over a full page of prefix matches", async () => {
  const { env } = await fixture();
  await ensureThaiSchools(env);
  const add = env.raw.prepare(
    "INSERT INTO thai_schools (school_code, smis_code, name) VALUES (?, ?, ?)",
  );
  for (let n = 0; n < 21; n++) {
    add.run("76020119" + String(n).padStart(2, "0"), "", "โรงเรียนทดสอบ " + n);
  }
  add.run("9999999999", "76020119", "โรงเรียนที่ค้นหา");
  const token = await signJWT({ sub: 1 }, env.JWT_SECRET);
  const pathname = "/api/thai-schools";
  const request = new Request("https://school.test" + pathname + "?q=76020119", {
    headers: { Cookie: "bpd_session=" + token },
  });
  const response = await handleThaiSchools(request, env, pathname, "GET");
  const { schools } = await response.json();
  assert.equal(schools.length, 20);
  assert.equal(schools[0].smis_code, "76020119");
});

test("transfer registration and edits accept optional codes without a fixed format", async () => {
  const { call } = await fixture();
  const body = form({ school_code: "76020119" });
  const create = await call("", "POST", body, 2);
  assert.equal(create.status, 201);
  const { id } = await create.json();
  assert.equal((await (await call("/" + id)).json()).request.school_code, "76020119");

  const response = await call("/" + id + "/details", "PATCH", {
    ...body,
    version: 1,
    school_code: " LOCAL-07 ",
  }, 2);
  assert.equal(response.status, 200);
  assert.equal((await (await call("/" + id)).json()).request.school_code, "LOCAL-07");

  const cleared = await call("/" + id + "/details", "PATCH", {
    ...body,
    version: 2,
    school_code: "",
  }, 2);
  assert.equal(cleared.status, 200);
  assert.equal((await (await call("/" + id)).json()).request.school_code, "");
});
