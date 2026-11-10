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

test("search and verification use the official SMIS page when the import lacks a code", async (t) => {
  const { env } = await fixture();
  await ensureThaiSchools(env);
  env.raw.exec(`INSERT INTO thai_schools (school_code, name)
    VALUES ('1076370238', 'บ้านป่าเด็ง')`);
  const token = await signJWT({ sub: 1 }, env.JWT_SECRET);
  const fetchMock = t.mock.method(globalThis, "fetch", async (url) => {
    assert.match(url, /^https:\/\/info\.bopp\.go\.th\/school\/\d{8}$/);
    if (url.endsWith("/00000000")) return new Response(null, { status: 404 });
    if (url.endsWith("/99999999")) return new Response(null, { status: 503 });
    const smis = url.endsWith("/76020119") ? "76020119" : "12345678";
    return new Response(`
      <h1 class="school-title">สารสนเทศข้อมูลโรงเรียน</h1>
      <p class="school-subtitle">บ้านป่าเด็ง</p>
      <div class="kv"><strong>รหัสโรงเรียน (SMIS)</strong><div>${smis}</div></div>
      <div class="kv"><strong>รหัสกระทรวง (10 หลัก)</strong><div>1076370238</div></div>
      <div class="kv"><strong>จังหวัด</strong><div>เพชรบุรี</div></div>
      <div class="kv"><strong>อำเภอ</strong><div>แก่งกระจาน</div></div>
      <div class="kv"><strong>ตำบล</strong><div>ป่าเด็ง</div></div>`);
  });

  async function lookup(path, params) {
    const pathname = "/api/thai-schools" + path;
    const request = new Request("https://school.test" + pathname + "?" + new URLSearchParams(params), {
      headers: { Cookie: "bpd_session=" + token },
    });
    return handleThaiSchools(request, env, pathname, "GET");
  }

  const search = await lookup("", { q: "76020119" });
  assert.equal(search.status, 200);
  assert.deepEqual(await search.json(), {
    schools: [{
      smis_code: "76020119", school_code: "1076370238", name: "บ้านป่าเด็ง",
      district: "แก่งกระจาน", subdistrict: "ป่าเด็ง", province: "เพชรบุรี",
    }],
  });
  for (const [name, expected] of [
    ["", "code_match"],
    ["โรงเรียนบ้านป่าเด็ง", "match"],
    ["ชื่อโรงเรียนอื่น", "mismatch"],
  ]) {
    const response = await lookup("/verify", { name, code: "76020119" });
    assert.deepEqual(await response.json(), { status: expected });
  }
  const calls = fetchMock.mock.callCount();
  await lookup("", { q: "7602011" });
  await lookup("/verify", { code: "1076370238" });
  assert.equal(fetchMock.mock.callCount(), calls);
  assert.deepEqual(await (await lookup("/verify", { code: "00000000" })).json(), { status: "unknown" });
  assert.equal((await lookup("", { q: "99999999" })).status, 502);
  assert.equal((await lookup("/verify", { code: "22222222" })).status, 502);
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
