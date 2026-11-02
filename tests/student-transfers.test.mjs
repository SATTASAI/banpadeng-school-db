import test from "node:test";
import assert from "node:assert/strict";
import worker from "../src/index.js";
import { fixture, form } from "./student-transfers.fixture.mjs";
import { normalizeTransfer } from "../src/routes/student-transfers.js";
test("registration persists, is idempotent, rejects duplicates and updates overview from same ledger", async () => {
  const { env, call, revision } = await fixture();
  const before = await revision(),
    body = form();
  let response = await call("", "POST", body, 2);
  assert.equal(response.status, 201);
  const { id } = await response.json();
  assert.notEqual(await revision(), before);
  assert.equal((await call("", "POST", body, 2)).status, 200);
  assert.equal((await call("", "POST", form(), 2)).status, 409);
  let data = await (await call()).json();
  assert.equal(data.total, 1);
  assert.equal(data.summary.pending, 1);
  assert.equal((await call("?q=ณิชา")).status, 200);
  assert.equal((await (await call("?q=absent")).json()).total, 0);
  assert.equal((await call("", "GET", undefined, null)).status, 401);
  assert.equal((await call("", "GET", undefined, 3)).status, 403);
  assert.equal(
    (
      await call(
        "/" + id + "/note",
        "PATCH",
        { note: "ตรวจสอบ", version: 1 },
        2,
      )
    ).status,
    200,
  );
  assert.equal(
    (
      await call(
        "/" + id + "/note",
        "PATCH",
        { note: "ข้อความเก่า", version: 1 },
        2,
      )
    ).status,
    409,
  );
  data = await (await call("/" + id)).json();
  assert.equal(data.request.note, "ตรวจสอบ");
  assert.equal(data.events.length, 1);
  // Full production Worker also dispatches this module and includes its aggregate on dashboard.
  const token = (await import("../src/lib/crypto.js")).signJWT;
  const jwt = await token({ sub: 1 }, env.JWT_SECRET);
  response = await worker.fetch(
    new Request("https://school.test/api/overview", {
      headers: { Cookie: "bpd_session=" + jwt },
    }),
    env,
    {},
  );
  assert.equal(response.status, 200);
  data = await response.json();
  assert.equal(data.student_transfer_summary.total, 1);
  assert.equal(data.student_transfer_summary.pending, 1);
});
test("approval requires verified documents and elevated permission; terminal requests lock; replacements reset verification", async () => {
  const { call, env, files } = await fixture();
  const { id } = await (await call("", "POST", form(), 2)).json();
  assert.equal(
    (await call(`/${id}/decision`, "POST", { status: "approved", version: 1 }))
      .status,
    400,
  );
  let version = 1;
  for (const kind of ["referral", "transcript", "household"]) {
    const file = new FormData();
    file.set("version", String(version));
    file.set(
      "file",
      new File(["%PDF-1.4 test"], "test.pdf", { type: "application/pdf" }),
    );
    assert.equal(
      (await call(`/${id}/documents/${kind}`, "POST", file, 2)).status,
      201,
    );
    version++;
    assert.equal(
      (
        await call(
          `/${id}/documents/${kind}/verify`,
          "PATCH",
          { version, verified: true },
          2,
        )
      ).status,
      200,
    );
    version++;
  }
  assert.equal(files.size, 3);
  assert.equal((await call(`/${id}/documents/referral`)).status, 200);
  assert.equal(
    (await call(`/${id}/documents/referral`, "GET", undefined, 3)).status,
    403,
  );
  assert.equal(
    (await call(`/${id}/decision`, "POST", { status: "approved", version }, 2))
      .status,
    403,
  );
  const replace = new FormData();
  replace.set("version", String(version));
  replace.set(
    "file",
    new File(["%PDF-1.4 new"], "new.pdf", { type: "application/pdf" }),
  );
  assert.equal(
    (await call(`/${id}/documents/referral`, "POST", replace)).status,
    201,
  );
  version++;
  assert.equal(files.size, 3);
  assert.equal(
    (await call(`/${id}/decision`, "POST", { status: "approved", version }))
      .status,
    400,
  );
  assert.equal(
    (
      await call(`/${id}/documents/referral/verify`, "PATCH", {
        version,
        verified: true,
      })
    ).status,
    200,
  );
  version++;
  assert.equal(
    (await call(`/${id}/decision`, "POST", { status: "approved", version }))
      .status,
    200,
  );
  assert.equal(
    (
      await call(`/${id}/note`, "PATCH", {
        version: version + 1,
        note: "แก้หลังอนุมัติ",
      })
    ).status,
    409,
  );
  assert.equal((await (await call()).json()).summary.approved_in, 1);
  assert.equal(
    env.raw.prepare("SELECT COUNT(*) n FROM student_transfer_events").get().n,
    9,
  );
});
test("outgoing student identity and dates validated; request info needs a reason", async () => {
  const { call } = await fixture();
  assert.ok(normalizeTransfer(form({ move_date: "2026-02-30" })).error);
  assert.ok(normalizeTransfer(form({ academic_year: 2026 })).error);
  assert.equal(
    (await call("", "POST", form({ direction: "out" }))).status,
    400,
  );
  const { id } = await (
    await call(
      "",
      "POST",
      form({
        direction: "out",
        student_code: "1001",
        student_name: "เด็กชายทดสอบ ย้ายออก",
      }),
    )
  ).json();
  assert.equal(
    (
      await call(`/${id}/decision`, "POST", {
        status: "needs_documents",
        version: 1,
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await call(`/${id}/decision`, "POST", {
        status: "needs_documents",
        version: 1,
        note: "แนบหนังสือส่งตัว",
      })
    ).status,
    200,
  );
  const d = await (await call(`/${id}`)).json();
  assert.equal(d.request.status, "needs_documents");
});
test("concurrent writers cannot overwrite notes or add false audit events", async () => {
  const { call } = await fixture();
  const { id } = await (await call("", "POST", form())).json();
  const responses = await Promise.all([
    call(`/${id}/note`, "PATCH", { version: 1, note: "one" }),
    call(`/${id}/note`, "PATCH", { version: 1, note: "two" }),
  ]);
  assert.deepEqual(responses.map((r) => r.status).sort(), [200, 409]);
  const d = await (await call(`/${id}`)).json();
  assert.equal(d.request.version, 2);
  assert.equal(d.events.length, 1);
});
