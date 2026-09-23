import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { signJWT } from "../src/lib/crypto.js";
import { handleBudgetRoute } from "../src/routes/budget.js";

const secret = "budget-workflow-test";

function fixture() {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE users(
      id INTEGER PRIMARY KEY,email TEXT,full_name TEXT,role TEXT,status TEXT,created_at TEXT,
      deleted_at TEXT
    );
    CREATE TABLE projects(
      id INTEGER PRIMARY KEY,department TEXT,name TEXT,budget_amount REAL,spent_amount REAL DEFAULT 0,
      status TEXT,description TEXT,created_by INTEGER,created_at TEXT
    );
    CREATE TABLE project_owners(project_id INTEGER,user_id INTEGER,PRIMARY KEY(project_id,user_id));
    CREATE TABLE project_expenses(
      id INTEGER PRIMARY KEY AUTOINCREMENT,project_id INTEGER,expense_date TEXT,document_no TEXT,
      category TEXT,description TEXT,payee TEXT,amount REAL,status TEXT,attachment_url TEXT,notes TEXT,
      created_by INTEGER,approved_by INTEGER,approved_at TEXT,paid_at TEXT,
      created_at TEXT DEFAULT(datetime('now')),updated_at TEXT DEFAULT(datetime('now'))
    );
    CREATE TABLE audit_logs(
      id INTEGER PRIMARY KEY AUTOINCREMENT,user_id INTEGER,action TEXT,resource TEXT,resource_id INTEGER,
      details TEXT,ip_address TEXT,created_at TEXT DEFAULT(datetime('now'))
    );
    CREATE TABLE file_attachments(id INTEGER PRIMARY KEY,entity_type TEXT,entity_id INTEGER,file_name TEXT);
    CREATE TRIGGER paid_update AFTER UPDATE ON project_expenses BEGIN
      UPDATE projects SET spent_amount=COALESCE((SELECT SUM(amount) FROM project_expenses
      WHERE project_id=NEW.project_id AND status='paid'),0) WHERE id=NEW.project_id;
    END;
    INSERT INTO users VALUES
      (1,'admin@x','ผู้ดูแลระบบ','superadmin','active','2026-01-01',NULL),
      (2,'owner@x','เจ้าของโครงการ','teacher','active','2026-01-01',NULL),
      (3,'other@x','ครูอื่น','teacher','active','2026-01-01',NULL),
      (4,'head@x','หัวหน้าวิชาการ','teacher','active','2026-01-01',NULL),
      (5,'deputy@x','รองผู้อำนวยการ','executive','active','2026-01-01',NULL),
      (6,'finance@x','เจ้าหน้าที่การเงิน','staff','active','2026-01-01',NULL),
      (7,'director@x','ผู้อำนวยการ','executive','active','2026-01-01',NULL);
    INSERT INTO projects VALUES(10,'academic','โครงการอ่านออกเขียนได้',1000,0,'ongoing','',1,'2026-10-01');
    INSERT INTO project_owners VALUES(10,2);
  `);
  function prepare(sql) {
    let args = [];
    return {
      bind(...values) { args = values; return this; },
      async first() { return db.prepare(sql).get(...args) || null; },
      async all() { return { results: db.prepare(sql).all(...args) }; },
      async run() {
        const result = db.prepare(sql).run(...args);
        return { meta: { changes: Number(result.changes), last_row_id: Number(result.lastInsertRowid) } };
      },
    };
  }
  return {
    JWT_SECRET: secret,
    raw: db,
    DB: {
      prepare,
      async batch(items) {
        db.exec("BEGIN");
        try {
          const output = [];
          for (const item of items) output.push(await item.run());
          db.exec("COMMIT");
          return output;
        } catch (error) {
          db.exec("ROLLBACK");
          throw error;
        }
      },
    },
  };
}

async function call(env, userId, path, method = "GET", body) {
  const token = await signJWT({ sub: userId }, secret);
  const request = new Request(`https://school.example/api/budget/${path}`, {
    method,
    headers: { Cookie: `bpd_session=${token}`, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const response = await handleBudgetRoute(request, env, new URL(request.url).pathname, method);
  const contentType = response.headers.get("content-type") || "";
  return { status: response.status, body: contentType.includes("json") ? await response.json() : await response.text() };
}

async function assign(env, roleKey, department, userId) {
  const result = await call(env, 1, "roles", "PUT", { role_key: roleKey, department, user_id: userId });
  assert.equal(result.status, 200);
}

const requestPayload = (amount = 900) => ({
  project_id: 10,
  expense_date: "2026-10-01",
  needed_date: "2026-10-10",
  fiscal_year: 2570,
  source_type: "subsidy",
  payment_preference: "transfer",
  request_purpose: "จัดซื้อสื่อสำหรับดำเนินโครงการ",
  necessity: "ใช้ในการจัดกิจกรรมตามแผนโครงการที่ได้รับอนุมัติ",
  payee: "ร้านตัวอย่าง",
  items: [{ category: "materials", description: "สื่อการเรียนรู้", quantity: 1, unit: "ชุด", unit_price: amount }],
});

test("digital budget request follows every assigned signature before printing and payment", async () => {
  const env = fixture();
  await assign(env, "department_head", "academic", 4);
  await assign(env, "deputy_director", "academic", 5);
  await assign(env, "finance_review", "", 6);
  await assign(env, "director_approval", "", 7);

  assert.equal((await call(env, 3, "requests", "POST", requestPayload())).status, 403);
  const created = await call(env, 2, "requests", "POST", requestPayload());
  assert.equal(created.status, 201);
  const id = created.body.id;

  assert.equal((await call(env, 2, `requests/${id}/document`)).status, 409);
  assert.equal((await call(env, 5, `requests/${id}/action`, "POST", { action: "sign" })).status, 403);
  assert.equal((await call(env, 4, `requests/${id}/action`, "POST", { action: "sign", review_note: "เห็นชอบ" })).status, 200);
  assert.equal((await call(env, 5, `requests/${id}/action`, "POST", { action: "sign" })).status, 200);
  assert.equal((await call(env, 6, `requests/${id}/action`, "POST", { action: "sign", review_note: "ตรวจสอบแล้ว" })).status, 200);
  assert.equal((await call(env, 7, `requests/${id}/action`, "POST", { action: "sign" })).status, 200);

  const document = await call(env, 6, `requests/${id}/document`);
  assert.equal(document.status, 200);
  assert.match(document.body, /แบบขอใช้งบประมาณเพื่อดำเนินโครงการ/);
  assert.match(document.body, /หัวหน้าวิชาการ/);
  assert.match(document.body, /ผู้อำนวยการ/);

  assert.equal((await call(env, 6, `requests/${id}/payment-document`)).status, 409);
  assert.equal((await call(env, 6, `requests/${id}/action`, "POST", {
    action: "pay", payment_no: "PAY-BAD", payment_date: "2026-10-03", payment_method: "transfer",
    payment_recipient: "ร้านตัวอย่าง",
  })).status, 400);

  const paid = await call(env, 6, `requests/${id}/action`, "POST", {
    action: "pay", payment_no: "PAY-1", payment_date: "2026-10-03", payment_method: "transfer",
    payment_recipient: "ร้านตัวอย่าง", payment_reference: "TXN-123", withholding_tax: 9,
    payment_note: "จ่ายตามใบแจ้งหนี้",
  });
  assert.equal(paid.status, 200);
  assert.equal(env.raw.prepare("SELECT spent_amount FROM projects WHERE id=10").get().spent_amount, 900);
  const payment = env.raw.prepare("SELECT net_paid,withholding_tax,payment_reference,payment_recipient FROM project_expenses WHERE id=?").get(id);
  assert.equal(payment.net_paid, 891);
  assert.equal(payment.withholding_tax, 9);
  assert.equal(payment.payment_reference, "TXN-123");
  assert.equal(payment.payment_recipient, "ร้านตัวอย่าง");
  const voucher = await call(env, 6, `requests/${id}/payment-document`);
  assert.equal(voucher.status, 200);
  assert.match(voucher.body, /ใบสำคัญจ่าย/);
  assert.match(voucher.body, /TXN-123/);
  assert.match(voucher.body, /891\.00/);

  const report = await call(env, 6, "reports?fiscal_year=2570&department=academic&category=materials");
  assert.equal(report.status, 200);
  assert.equal(report.body.summary.request_count, 1);
  assert.equal(report.body.summary.paid_amount, 900);
  assert.equal(report.body.summary.withholding_tax, 9);
  assert.equal(report.body.rows[0].payment_reference, "TXN-123");
  const csv = await call(env, 6, "reports/export?fiscal_year=2570&status=paid");
  assert.equal(csv.status, 200);
  assert.match(csv.body, /PAY-1/);
  assert.match(csv.body, /ยอดจ่ายสุทธิ/);
  const printableReport = await call(env, 6, "reports/print?fiscal_year=2570&status=paid");
  assert.equal(printableReport.status, 200);
  assert.match(printableReport.body, /รายงานการใช้จ่ายงบประมาณ/);

  const second = await call(env, 2, "requests", "POST", requestPayload(200));
  assert.equal(second.status, 201);
  for (const userId of [4, 5, 6]) assert.equal((await call(env, userId, `requests/${second.body.id}/action`, "POST", { action: "sign" })).status, 200);
  assert.equal((await call(env, 7, `requests/${second.body.id}/action`, "POST", { action: "sign" })).status, 409);
});

test("a signer can return a request for editing and the owner can resubmit it", async () => {
  const env = fixture();
  await assign(env, "department_head", "academic", 4);
  await assign(env, "deputy_director", "academic", 5);
  await assign(env, "finance_review", "", 6);
  await assign(env, "director_approval", "", 7);
  const created = await call(env, 2, "requests", "POST", requestPayload());
  assert.equal((await call(env, 4, `requests/${created.body.id}/action`, "POST", { action: "return", review_note: "แก้รายละเอียดรายการ" })).status, 200);
  const row = env.raw.prepare("SELECT status,current_step FROM project_expenses WHERE id=?").get(created.body.id);
  assert.equal(row.status, "draft");
  assert.equal(row.current_step, "returned");
  assert.equal((await call(env, 2, `requests/${created.body.id}`, "PATCH", { ...requestPayload(850), save_as_draft: false })).status, 200);
  assert.equal(env.raw.prepare("SELECT status FROM project_expenses WHERE id=?").get(created.body.id).status, "pending");
});

test("kindergarten projects use their own approval assignments", async () => {
  const env = fixture();
  await call(env, 1, "overview?fiscal_year=2570"); // applies compatibility columns
  env.raw.prepare(`INSERT INTO projects(id,department,management_area,name,budget_amount,spent_amount,status,description,created_by,created_at,fiscal_year)
    VALUES(11,'academic','early_childhood','โครงการอนุบาล',2000,0,'ongoing','',1,'2026-10-01',2570)`).run();
  env.raw.prepare("INSERT INTO project_owners VALUES(11,2)").run();
  await assign(env, "department_head", "early_childhood", 4);
  await assign(env, "deputy_director", "early_childhood", 5);
  await assign(env, "finance_review", "", 6);
  await assign(env, "director_approval", "", 7);
  const created = await call(env, 2, "requests", "POST", { ...requestPayload(), project_id: 11 });
  assert.equal(created.status, 201);
  const overview = await call(env, 2, "overview?fiscal_year=2570");
  assert.equal(overview.body.projects.find((project) => project.id === 11).department, "early_childhood");
});
