import test from "node:test";
import assert from "node:assert/strict";
import { fixture, form } from "./student-transfers.fixture.mjs";
import worker from "../src/index.js";
import { signJWT } from "../src/lib/crypto.js";
test("200-row import stays within bounded statement sizes and commits every row", async () => {
  const { call, env } = await fixture();
  const original = env.DB.prepare;
  let queries = 0;
  env.DB.prepare = (sql) => {
    queries++;
    const statement = original(sql),
      bind = statement.bind;
    statement.bind = function (...values) {
      assert.ok(values.length <= 100);
      return bind.apply(this, values);
    };
    return statement;
  };
  const rows = Array.from({ length: 200 }, (_, i) =>
    form({ student_code: "BULK-" + i }),
  );
  const response = await call("/import", "POST", {
    rows,
    batch_ref: crypto.randomUUID(),
  });
  assert.equal(response.status, 201);
  assert.equal((await response.json()).imported, 200);
  assert.ok(queries < 50);
  assert.equal(
    env.raw.prepare("SELECT COUNT(*) n FROM student_transfer_requests").get().n,
    200,
  );
});
test("database conflict during confirmation rolls back the whole import and its batch marker", async () => {
  const { call, env } = await fixture();
  const batch = env.DB.batch;
  env.DB.batch = (statements) => {
    env.DB.batch = batch;
    env.raw
      .exec(`INSERT INTO student_transfer_requests(client_ref,direction,student_code,student_name,grade_level,school_name,academic_year,term,move_date,reason,created_by)
   VALUES('concurrent','in','R002','นักเรียนทดสอบ','ป.1','โรงเรียนทดสอบ',2569,2,'2026-11-10','เหตุผล',1)`);
    return batch(statements);
  };
  const response = await call("/import", "POST", {
    rows: [form({ student_code: "R001" }), form({ student_code: "R002" })],
    batch_ref: crypto.randomUUID(),
  });
  assert.equal(response.status, 409);
  assert.equal(
    env.raw
      .prepare(
        "SELECT COUNT(*) n FROM student_transfer_requests WHERE student_code='R001'",
      )
      .get().n,
    0,
  );
  assert.equal(
    env.raw
      .prepare("SELECT COUNT(*) n FROM student_transfer_import_batches")
      .get().n,
    0,
  );
});
test("only explicit grants allow non-admin accounts; revocation applies to every transfer resource", async () => {
  const { call, env } = await fixture();
  assert.deepEqual(await (await call("/access", "GET", undefined, 3)).json(), {
    allowed: false,
    manage_permissions: false,
  });
  assert.equal((await call("/permissions", "GET", undefined, 3)).status, 403);
  assert.equal(
    (await call("/permissions/3", "PUT", { allowed: true }, 3)).status,
    403,
  );
  assert.equal(
    (await call("/permissions/1", "PUT", { allowed: false })).status,
    400,
  );
  assert.equal(
    (await call("/permissions/3", "PUT", { allowed: true })).status,
    200,
  );
  assert.equal(
    (await (await call("/access", "GET", undefined, 3)).json()).allowed,
    true,
  );
  assert.equal((await call("/students", "GET", undefined, 3)).status, 200);
  const { id } = await (await call("", "POST", form(), 3)).json();
  assert.equal((await call("/" + id, "GET", undefined, 3)).status, 200);
  assert.equal(
    (await call("/permissions/3", "PUT", { allowed: false })).status,
    200,
  );
  for (const path of ["", "/students", "/" + id, `/${id}/documents/referral`])
    assert.equal((await call(path, "GET", undefined, 3)).status, 403);
  const token = await signJWT({ sub: 3 }, env.JWT_SECRET);
  const response = await worker.fetch(
    new Request("https://school.test/api/student-transfers/students", {
      headers: { Cookie: "bpd_session=" + token },
    }),
    env,
    {},
  );
  assert.equal(response.status, 403);
  assert.equal(
    env.raw
      .prepare(
        "SELECT COUNT(*) n FROM audit_logs WHERE resource='student_transfer_access' AND resource_id=3",
      )
      .get().n,
    2,
  );
});
test("iframe student API reads shared roster with pagination and excludes private fields", async () => {
  const { call, env } = await fixture();
  env.raw.exec(
    "UPDATE students SET health_conditions='private',allergies='private',classroom='1' WHERE student_code='1001'",
  );
  const d = await (await call("/students?q=1001&status=enrolled")).json();
  assert.equal(d.total, 1);
  assert.deepEqual(Object.keys(d.students[0]).sort(), [
    "classroom",
    "full_name",
    "grade_level",
    "id",
    "status",
    "student_code",
  ]);
  assert.equal(
    (await (await call("/students?offset=100")).json()).students.length,
    0,
  );
  assert.equal((await call("/students?status=invalid")).status, 400);
});
test("import preview never writes; confirmation is atomic and retries are idempotent", async () => {
  const { call, env, revision } = await fixture();
  const rows = [form({ student_code: "A001" }), form({ student_code: "A002" })];
  const body = { rows, batch_ref: crypto.randomUUID() };
  const before = await revision();
  let response = await call("/import/preview", "POST", body, 2);
  assert.equal(response.status, 200);
  let d = await response.json();
  assert.equal(d.valid, 2);
  assert.deepEqual(d.errors, []);
  assert.equal(
    env.raw.prepare("SELECT COUNT(*) n FROM student_transfer_requests").get().n,
    0,
  );
  response = await call("/import", "POST", body, 2);
  assert.equal(response.status, 201);
  assert.equal((await response.json()).imported, 2);
  assert.notEqual(await revision(), before);
  response = await call("/import", "POST", body, 2);
  assert.equal(response.status, 200);
  assert.equal((await response.json()).already_imported, true);
  assert.equal(
    env.raw.prepare("SELECT COUNT(*) n FROM student_transfer_requests").get().n,
    2,
  );
  assert.equal(
    (
      await call(
        "/import",
        "POST",
        { ...body, rows: [form({ student_code: "A003" })] },
        2,
      )
    ).status,
    409,
  );
  const invalid = {
    rows: [form({ student_code: "A004" }), form({ student_code: "A001" })],
    batch_ref: crypto.randomUUID(),
  };
  d = await (await call("/import/preview", "POST", invalid, 2)).json();
  assert.equal(d.errors[0].row, 2);
  assert.equal((await call("/import", "POST", invalid, 2)).status, 400);
  assert.equal(
    env.raw
      .prepare(
        "SELECT COUNT(*) n FROM student_transfer_requests WHERE student_code='A004'",
      )
      .get().n,
    0,
  );
  assert.equal(
    (
      await call(
        "/import",
        "POST",
        { ...body, batch_ref: crypto.randomUUID() },
        3,
      )
    ).status,
    403,
  );
});
test("import validates outgoing identity, duplicate rows, malformed input and row limits", async () => {
  const { call } = await fixture();
  const payload = (rows) => ({ rows, batch_ref: crypto.randomUUID() });
  let d = await (
    await call("/import/preview", "POST", payload([form(), form()]))
  ).json();
  assert.equal(d.errors[0].row, 2);
  d = await (
    await call(
      "/import/preview",
      "POST",
      payload([form({ direction: "out", student_code: "not-found" })]),
    )
  ).json();
  assert.equal(d.valid, 0);
  assert.equal((await call("/import", "POST", payload([]))).status, 400);
  assert.equal(
    (
      await call(
        "/import",
        "POST",
        payload(
          Array.from({ length: 201 }, (_, i) =>
            form({ student_code: String(i) }),
          ),
        ),
      )
    ).status,
    400,
  );
  assert.equal(
    (
      await call("/import", "POST", {
        rows: [null],
        batch_ref: crypto.randomUUID(),
      })
    ).status,
    400,
  );
});
