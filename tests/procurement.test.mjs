import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { signJWT } from "../src/lib/crypto.js";
import { handleProcurementRoute } from "../src/routes/procurement.js";
import { handleProjectWorkflowRoute } from "../src/routes/project-workflow.js";
import { handleBudgetRoute } from "../src/routes/budget.js";
import { handleNotifications } from "../src/routes/notifications.js";
import { bahtText } from "../src/lib/thai-baht.js";

const secret = "procurement-test";

function fixture() {
  const db = new DatabaseSync(":memory:");
  db.exec(fs.readFileSync("schema.sql", "utf8"));
  db.exec(`
    INSERT INTO users(id,email,password_hash,password_salt,full_name,role,status) VALUES
      (1,'admin@x','x','x','ผู้ดูแลระบบ','superadmin','active'),
      (2,'owner@x','x','x','ครูเจ้าของโครงการ','teacher','active'),
      (3,'officer@x','x','x','นางพัสดุ ทดสอบ','staff','active'),
      (4,'head@x','x','x','นายหัวหน้า พัสดุ','teacher','active'),
      (5,'finance@x','x','x','นางการเงิน','staff','active'),
      (6,'director@x','x','x','นายผู้อำนวยการ','executive','active'),
      (7,'inspA@x','x','x','ครูตรวจรับ หนึ่ง','teacher','active'),
      (8,'inspB@x','x','x','ครูตรวจรับ สอง','teacher','active'),
      (9,'inspC@x','x','x','ครูตรวจรับ สาม','teacher','active'),
      (10,'other@x','x','x','ครูอื่น','teacher','active');
    INSERT INTO projects(id,department,name,budget_amount,fiscal_year,status,created_by,funding_type)
      VALUES(10,'academic','โครงการห้องสมุดมีชีวิต',300000,2570,'ongoing',1,'subsidy');
    INSERT INTO project_owners VALUES(10,2);
    INSERT INTO inventory_items(item_code,name,item_type,unit,current_quantity,created_by) VALUES('OLD-1','กระดาษ A4','material','รีม',3,1);
  `);
  const prepare = (sql) => {
    let args = [];
    return {
      bind(...values) { args = values; return this; },
      async first() { return db.prepare(sql).get(...args) || null; },
      async all() { return { results: db.prepare(sql).all(...args) }; },
      async run() { const r = db.prepare(sql).run(...args); return { meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) } }; },
    };
  };
  return {
    JWT_SECRET: secret, raw: db,
    DB: {
      prepare,
      async batch(items) {
        db.exec("BEGIN");
        try { const out = []; for (const item of items) out.push(await item.run()); db.exec("COMMIT"); return out; }
        catch (error) { db.exec("ROLLBACK"); throw error; }
      },
    },
  };
}

async function call(env, userId, path, method = "GET", body) {
  const token = await signJWT({ sub: userId }, secret);
  const request = new Request(`https://school.example${path}`, {
    method, headers: { Cookie: `bpd_session=${token}`, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const pathname = new URL(request.url).pathname;
  const response = await handleProcurementRoute(request, env, pathname, method)
    || await handleProjectWorkflowRoute(request, env, pathname, method)
    || await handleBudgetRoute(request, env, pathname, method)
    || await handleNotifications(request, env, pathname, method);
  const type = response.headers.get("content-type") || "";
  return { status: response.status, body: type.includes("json") ? await response.json() : await response.text() };
}

async function setup(amountPerItem = 450) {
  const env = fixture();
  for (const [role_key, user_id] of [["finance_review", 5], ["director_approval", 6], ["procurement_officer", 3], ["procurement_head", 4]])
    assert.equal((await call(env, 1, "/api/budget/roles", "PUT", { role_key, department: "", user_id })).status, 200, role_key);
  const draft = await call(env, 2, "/api/project-documents/requests", "POST", {
    project_id: 10, expense_date: "2026-11-02", needed_date: "2026-11-20", request_purpose: "จัดซื้อวัสดุและครุภัณฑ์ห้องสมุด",
    necessity: "ใช้ในกิจกรรมห้องสมุด", payee: "ร้านทดสอบ",
    items: [{ category: "materials", description: "กระดาษ A4", quantity: 10, unit: "รีม", unit_price: 120 },
      { category: "equipment", description: "ชั้นวางหนังสือ", quantity: 2, unit: "ตัว", unit_price: amountPerItem }],
  });
  assert.equal(draft.status, 201);
  const expenseId = draft.body.id;
  assert.equal((await call(env, 2, `/api/project-documents/requests/${expenseId}/action`, "POST", { action: "submit" })).status, 200);
  assert.equal((await call(env, 5, `/api/project-documents/requests/${expenseId}/action`, "POST", { action: "receive" })).status, 200);
  return { env, expenseId };
}

const casePayload = (expenseId, overrides = {}) => ({
  expense_id: expenseId, procurement_type: "purchase", method: "specific", subject: "วัสดุและครุภัณฑ์ห้องสมุด",
  necessity: "เพื่อใช้ในโครงการห้องสมุดมีชีวิต", reference_price: 2100, reference_source: "สืบราคาจากท้องตลาด",
  delivery_days: 7, delivery_place: "ห้องสมุดโรงเรียน", vendor_name: "ร้านทดสอบ", vendor_tax_id: "0123456789012",
  items: [{ description: "กระดาษ A4", item_type: "material", quantity: 10, unit: "รีม", unit_price: 120 },
    { description: "ชั้นวางหนังสือ", item_type: "equipment", category: "ครุภัณฑ์สำนักงาน", quantity: 2, unit: "ตัว", unit_price: 450 }],
  inspectors: [7], ...overrides,
});

test("Thai baht text follows BAHTTEXT conventions", () => {
  assert.equal(bahtText(0), "ศูนย์บาทถ้วน");
  assert.equal(bahtText(21), "ยี่สิบเอ็ดบาทถ้วน");
  assert.equal(bahtText(101), "หนึ่งร้อยเอ็ดบาทถ้วน");
  assert.equal(bahtText(2100), "สองพันหนึ่งร้อยบาทถ้วน");
  assert.equal(bahtText(1000001), "หนึ่งล้านเอ็ดบาทถ้วน");
  assert.equal(bahtText(11500000.5), "สิบเอ็ดล้านห้าแสนบาทห้าสิบสตางค์");
  assert.equal(bahtText(0.25), "ยี่สิบห้าสตางค์");
});

test("procurement runs from budget request to director approval, inspection, inventory and disbursement", async () => {
  const { env, expenseId } = await setup();
  // ผู้ไม่ใช่เจ้าหน้าที่พัสดุสร้างไม่ได้ และยอดเกินคำขอไม่ได้
  assert.equal((await call(env, 10, "/api/procurement/cases", "POST", casePayload(expenseId))).status, 403);
  const over = await call(env, 3, "/api/procurement/cases", "POST", casePayload(expenseId, { items: [{ description: "ชั้นวาง", item_type: "equipment", quantity: 10, unit: "ตัว", unit_price: 9999 }] }));
  assert.equal(over.status, 409);

  const overview = await call(env, 3, "/api/procurement/overview?fiscal_year=2570");
  assert.equal(overview.body.eligible_expenses.length, 1);
  const created = await call(env, 3, "/api/procurement/cases", "POST", casePayload(expenseId));
  assert.equal(created.status, 201);
  assert.match(created.body.case_no, /^PRC-2570-0001$/);
  const id = created.body.id;
  assert.equal((await call(env, 3, "/api/procurement/cases", "POST", casePayload(expenseId))).status, 409, "one active case per request");

  // การเงินยังเสนอ ผอ. อนุมัติเบิกจ่ายไม่ได้จนกว่าตรวจรับ
  const blocked = await call(env, 5, `/api/project-documents/requests/${expenseId}/action`, "POST", { action: "complete" });
  assert.equal(blocked.status, 409);
  assert.equal(blocked.body.code, "procurement_pending");

  assert.equal((await call(env, 3, `/api/procurement/cases/${id}/action`, "POST", { action: "submit" })).status, 200);
  assert.equal((await call(env, 6, `/api/procurement/cases/${id}/action`, "POST", { action: "approve" })).status, 409, "head review first");
  assert.equal((await call(env, 4, `/api/procurement/cases/${id}/action`, "POST", { action: "return" })).status, 400, "return needs note");
  assert.equal((await call(env, 4, `/api/procurement/cases/${id}/action`, "POST", { action: "head_approve" })).status, 200);
  assert.equal((await call(env, 10, `/api/procurement/cases/${id}/action`, "POST", { action: "approve" })).status, 403);

  const report = await call(env, 6, `/api/procurement/cases/${id}/documents/report`);
  assert.equal(report.status, 200);
  assert.match(report.body, /รายงานขอซื้อ/);
  assert.match(report.body, /ร่าง - ยังไม่อนุมัติ/);
  assert.match(report.body, /สองพันหนึ่งร้อยบาทถ้วน/);
  assert.equal((await call(env, 6, `/api/procurement/cases/${id}/documents/committee`)).status, 409);

  assert.equal((await call(env, 6, `/api/procurement/cases/${id}/action`, "POST", { action: "approve" })).status, 200);
  const committee = await call(env, 6, `/api/procurement/cases/${id}/documents/committee`);
  assert.match(committee.body, /แต่งตั้งผู้ตรวจรับพัสดุ/);
  assert.match(committee.body, /ครูตรวจรับ หนึ่ง/);

  // ผู้ตรวจรับเปิดดูได้ ครูอื่นดูไม่ได้
  assert.equal((await call(env, 7, `/api/procurement/cases/${id}`)).status, 200);
  assert.equal((await call(env, 10, `/api/procurement/cases/${id}`)).status, 403);

  assert.equal((await call(env, 3, `/api/procurement/cases/${id}/action`, "POST", { action: "order", order_date: "2026-11-05" })).status, 200);
  const detail = await call(env, 3, `/api/procurement/cases/${id}`);
  assert.equal(detail.body.case.order_no, "PO-2570-0001");
  assert.equal(detail.body.case.delivery_due_date, "2026-11-12");
  assert.match((await call(env, 3, `/api/procurement/cases/${id}/documents/order`)).body, /ใบสั่งซื้อ/);

  assert.equal((await call(env, 7, `/api/procurement/cases/${id}/action`, "POST", { action: "inspect", decision: "accept" })).status, 409, "delivery must be recorded");
  assert.equal((await call(env, 3, `/api/procurement/cases/${id}/action`, "POST", { action: "record_delivery", delivered_date: "2026-11-10", delivery_document_no: "INV-77" })).status, 200);
  assert.equal((await call(env, 8, `/api/procurement/cases/${id}/action`, "POST", { action: "inspect", decision: "accept" })).status, 403);

  // ไม่รับพัสดุ → ต้องบันทึกส่งมอบใหม่
  assert.equal((await call(env, 7, `/api/procurement/cases/${id}/action`, "POST", { action: "inspect", decision: "reject", note: "ชั้นวางมีรอยแตก" })).status, 200);
  assert.equal((await call(env, 7, `/api/procurement/cases/${id}/action`, "POST", { action: "inspect", decision: "accept" })).status, 409);
  assert.equal((await call(env, 3, `/api/procurement/cases/${id}/action`, "POST", { action: "record_delivery", delivered_date: "2026-11-11" })).status, 200);

  const notifications = await call(env, 7, "/api/notifications");
  assert(notifications.body.notifications.some((n) => n.message_key.startsWith("procurement:") && n.url === `/procurement.html?case=${id}`));

  const accepted = await call(env, 7, `/api/procurement/cases/${id}/action`, "POST", { action: "inspect", decision: "accept" });
  assert.equal(accepted.status, 200);
  assert.equal(accepted.body.accepted, true);

  const paper = env.raw.prepare("SELECT current_quantity FROM inventory_items WHERE item_code='OLD-1'").get();
  assert.equal(paper.current_quantity, 13, "material merged into existing register");
  const shelves = env.raw.prepare("SELECT item_code,current_quantity,vendor,budget_source FROM inventory_items WHERE item_type='equipment' ORDER BY item_code").all();
  assert.deepEqual(shelves.map((s) => s.item_code), ["EQP-2570-0001", "EQP-2570-0002"]);
  assert(shelves.every((s) => s.current_quantity === 1 && s.vendor === "ร้านทดสอบ" && s.budget_source === "งบอุดหนุน"));

  // ทำซ้ำไม่นำเข้าซ้ำ
  assert.equal((await call(env, 3, `/api/procurement/cases/${id}/action`, "POST", { action: "post_inventory" })).status, 409);
  assert.equal(env.raw.prepare("SELECT COUNT(*) n FROM inventory_transactions WHERE transaction_type='receive'").get().n, 3);
  assert.match((await call(env, 7, `/api/procurement/cases/${id}/documents/inspection`)).body, /ใบตรวจรับพัสดุ/);

  // ตรวจรับครบแล้ว การเงินเดินต่อได้
  assert.equal((await call(env, 5, `/api/project-documents/requests/${expenseId}/action`, "POST", { action: "complete" })).status, 200);
  assert.equal((await call(env, 6, `/api/project-documents/requests/${expenseId}/action`, "POST", { action: "approve" })).status, 200);
});

test("committee of three is required above 100,000 baht and every member must accept", async () => {
  const { env, expenseId } = await setup(60000);
  const items = [{ description: "ชั้นวางหนังสือ", item_type: "equipment", quantity: 2, unit: "ตัว", unit_price: 60000 }];
  const created = await call(env, 3, "/api/procurement/cases", "POST", casePayload(expenseId, { items, inspectors: [7] }));
  assert.equal(created.status, 201);
  const id = created.body.id;
  const submit = await call(env, 3, `/api/procurement/cases/${id}/action`, "POST", { action: "submit" });
  assert.equal(submit.status, 409);
  assert.match(submit.body.error, /อย่างน้อย 3 คน/);
  assert.equal((await call(env, 3, `/api/procurement/cases/${id}`, "PATCH", casePayload(expenseId, { items, inspectors: [7, 8, 9] }))).status, 200);
  assert.equal((await call(env, 3, `/api/procurement/cases/${id}/action`, "POST", { action: "submit" })).status, 200);
  assert.equal((await call(env, 4, `/api/procurement/cases/${id}/action`, "POST", { action: "head_approve" })).status, 200);
  assert.equal((await call(env, 6, `/api/procurement/cases/${id}/action`, "POST", { action: "return", note: "แก้ราคากลาง" })).status, 200);
  assert.equal((await call(env, 3, `/api/procurement/cases/${id}`)).body.case.status, "draft");
  assert.equal((await call(env, 3, `/api/procurement/cases/${id}/action`, "POST", { action: "submit" })).status, 200);
  assert.equal((await call(env, 4, `/api/procurement/cases/${id}/action`, "POST", { action: "head_approve" })).status, 200);
  assert.equal((await call(env, 6, `/api/procurement/cases/${id}/action`, "POST", { action: "approve" })).status, 200);
  assert.equal((await call(env, 3, `/api/procurement/cases/${id}/action`, "POST", { action: "order" })).status, 200);
  assert.equal((await call(env, 3, `/api/procurement/cases/${id}/action`, "POST", { action: "record_delivery", delivered_date: "2099-01-01" })).status, 200);
  const first = await call(env, 7, `/api/procurement/cases/${id}/action`, "POST", { action: "inspect", decision: "accept" });
  assert.equal(first.body.waiting_for, 2);
  await call(env, 8, `/api/procurement/cases/${id}/action`, "POST", { action: "inspect", decision: "accept" });
  const last = await call(env, 9, `/api/procurement/cases/${id}/action`, "POST", { action: "inspect", decision: "accept" });
  assert.equal(last.body.accepted, true);
  const detail = (await call(env, 3, `/api/procurement/cases/${id}`)).body.case;
  assert.equal(detail.status, "accepted");
  assert.deepEqual(detail.inspectors.map((i) => i.position), ["chair", "member", "member"]);
  assert.equal(detail.inventory_links.length, 2);
  assert.match((await call(env, 3, `/api/procurement/cases/${id}/documents/inspection`)).body, /คณะกรรมการตรวจรับพัสดุ|ประธานกรรมการ/);
});

test("director cannot approve a report they prepared and cancelled cases free the request", async () => {
  const { env, expenseId } = await setup();
  const created = await call(env, 6, "/api/procurement/cases", "POST", casePayload(expenseId));
  assert.equal(created.status, 201, "executives may prepare");
  const id = created.body.id;
  // หัวหน้าเจ้าหน้าที่ถูกข้ามได้เฉพาะเมื่อเป็นคนเดียวกับผู้จัดทำ — ที่นี่ต้องผ่านหัวหน้าก่อน
  assert.equal((await call(env, 6, `/api/procurement/cases/${id}/action`, "POST", { action: "submit" })).status, 200);
  assert.equal((await call(env, 4, `/api/procurement/cases/${id}/action`, "POST", { action: "head_approve" })).status, 200);
  assert.equal((await call(env, 6, `/api/procurement/cases/${id}/action`, "POST", { action: "approve" })).status, 403);
  assert.equal((await call(env, 3, `/api/procurement/cases/${id}/action`, "POST", { action: "cancel" })).status, 400);
  assert.equal((await call(env, 3, `/api/procurement/cases/${id}/action`, "POST", { action: "cancel", note: "ซื้อผิดรายการ" })).status, 200);
  assert.equal((await call(env, 3, "/api/procurement/overview")).body.eligible_expenses.length, 1);
  assert.equal((await call(env, 5, `/api/project-documents/requests/${expenseId}/action`, "POST", { action: "complete" })).status, 200);
});
