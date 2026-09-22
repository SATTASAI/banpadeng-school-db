import { getCurrentUser, isAdmin, jsonResponse } from "../lib/auth.js";

const STATUSES = ["draft", "pending", "approved", "paid", "rejected", "cancelled"];
const CATEGORIES = ["materials", "equipment", "services", "compensation", "utilities", "travel", "food", "opening_balance", "other"];
const PAYMENT_METHODS = ["transfer", "cash", "cheque", "other"];
const SOURCE_TYPES = ["subsidy", "school_income", "donation", "other"];
const WORKFLOW_STEPS = [
  { key: "department_head", label: "หัวหน้าฝ่าย", scoped: true },
  { key: "deputy_director", label: "รองผู้อำนวยการผู้ดูแลฝ่าย", scoped: true },
  { key: "finance_review", label: "ฝ่ายการเงินตรวจสอบ", scoped: false },
  { key: "director_approval", label: "ผู้อำนวยการอนุมัติ", scoped: false },
];
const ROLE_KEYS = [...new Set(WORKFLOW_STEPS.map((step) => step.key))];
const readyDatabases = new WeakSet();

const clean = (value, max = 500) => String(value ?? "").trim().slice(0, max) || null;
const escapeHtml = (value) => String(value ?? "")
  .replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
  .replaceAll('"', "&quot;").replaceAll("'", "&#39;");

function validDate(value) {
  const text = String(value || "");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return false;
  const [year, month, day] = text.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

function fiscalYear(date = new Date().toISOString().slice(0, 10)) {
  const [year, month] = date.split("-").map(Number);
  return year + (month >= 10 ? 544 : 543);
}

async function addColumn(env, table, name, definition) {
  try {
    await env.DB.prepare(`ALTER TABLE ${table} ADD COLUMN ${name} ${definition}`).run();
  } catch (error) {
    if (!String(error?.message || error).toLowerCase().includes("duplicate column")) throw error;
  }
}

export async function ensureBudgetSchema(env) {
  if (readyDatabases.has(env.DB)) return;
  await env.DB.batch([
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS budget_income (
      id INTEGER PRIMARY KEY AUTOINCREMENT, fiscal_year INTEGER NOT NULL, received_date TEXT NOT NULL,
      document_no TEXT, source_name TEXT NOT NULL, source_type TEXT NOT NULL DEFAULT 'other',
      amount REAL NOT NULL CHECK(amount > 0), notes TEXT, created_by INTEGER NOT NULL REFERENCES users(id),
      created_at TEXT NOT NULL DEFAULT(datetime('now')), updated_at TEXT NOT NULL DEFAULT(datetime('now')))`),
    env.DB.prepare("CREATE TABLE IF NOT EXISTS budget_counters (fiscal_year INTEGER PRIMARY KEY, last_number INTEGER NOT NULL DEFAULT 0)"),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS budget_role_assignments (
      role_key TEXT NOT NULL, department TEXT NOT NULL DEFAULT '', user_id INTEGER NOT NULL REFERENCES users(id),
      assigned_by INTEGER REFERENCES users(id), assigned_at TEXT NOT NULL DEFAULT(datetime('now')),
      PRIMARY KEY(role_key, department))`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS budget_request_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT, expense_id INTEGER NOT NULL REFERENCES project_expenses(id) ON DELETE CASCADE,
      line_no INTEGER NOT NULL, category TEXT NOT NULL DEFAULT 'other', description TEXT NOT NULL,
      quantity REAL NOT NULL DEFAULT 1 CHECK(quantity > 0), unit TEXT, unit_price REAL NOT NULL CHECK(unit_price >= 0),
      amount REAL NOT NULL CHECK(amount >= 0), created_at TEXT NOT NULL DEFAULT(datetime('now')),
      UNIQUE(expense_id, line_no))`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS budget_request_approvals (
      id INTEGER PRIMARY KEY AUTOINCREMENT, expense_id INTEGER NOT NULL REFERENCES project_expenses(id) ON DELETE CASCADE,
      step_key TEXT NOT NULL, step_label TEXT NOT NULL, step_order INTEGER NOT NULL,
      assigned_user_id INTEGER NOT NULL REFERENCES users(id), status TEXT NOT NULL DEFAULT 'waiting',
      note TEXT, signed_name TEXT, signed_at TEXT, acted_by INTEGER REFERENCES users(id),
      created_at TEXT NOT NULL DEFAULT(datetime('now')), updated_at TEXT NOT NULL DEFAULT(datetime('now')),
      UNIQUE(expense_id, step_key))`),
    env.DB.prepare("CREATE INDEX IF NOT EXISTS idx_budget_income_year ON budget_income(fiscal_year, received_date DESC)"),
    env.DB.prepare("CREATE INDEX IF NOT EXISTS idx_budget_items_expense ON budget_request_items(expense_id, line_no)"),
    env.DB.prepare("CREATE INDEX IF NOT EXISTS idx_budget_approvals_expense ON budget_request_approvals(expense_id, step_order)"),
    env.DB.prepare("CREATE INDEX IF NOT EXISTS idx_budget_approvals_assignee ON budget_request_approvals(assigned_user_id, status)"),
  ]);

  await addColumn(env, "projects", "fiscal_year", "INTEGER");
  const columns = [
    ["request_no", "TEXT"], ["fiscal_year", "INTEGER"], ["submitted_at", "TEXT"],
    ["review_note", "TEXT"], ["payment_no", "TEXT"], ["payment_method", "TEXT"],
    ["payment_date", "TEXT"], ["request_purpose", "TEXT"], ["necessity", "TEXT"],
    ["source_type", "TEXT"], ["payment_preference", "TEXT"], ["needed_date", "TEXT"],
    ["current_step", "TEXT"], ["workflow_started_at", "TEXT"], ["workflow_completed_at", "TEXT"],
    ["returned_at", "TEXT"],
  ];
  for (const [name, definition] of columns) await addColumn(env, "project_expenses", name, definition);

  await env.DB.batch([
    env.DB.prepare("CREATE UNIQUE INDEX IF NOT EXISTS idx_project_expenses_request_no ON project_expenses(request_no) WHERE request_no IS NOT NULL"),
    env.DB.prepare("CREATE INDEX IF NOT EXISTS idx_project_expenses_fiscal_year ON project_expenses(fiscal_year, status, expense_date DESC)"),
    env.DB.prepare(`UPDATE project_expenses SET fiscal_year=CAST(strftime('%Y',expense_date) AS INTEGER)+CASE WHEN CAST(strftime('%m',expense_date) AS INTEGER)>=10 THEN 544 ELSE 543 END WHERE fiscal_year IS NULL`),
    env.DB.prepare("UPDATE project_expenses SET submitted_at=created_at WHERE status IN ('pending','approved','paid','rejected') AND submitted_at IS NULL"),
    env.DB.prepare("UPDATE project_expenses SET payment_date=substr(paid_at,1,10) WHERE status='paid' AND payment_date IS NULL"),
    env.DB.prepare(`UPDATE projects SET fiscal_year=CAST(strftime('%Y',COALESCE(created_at,datetime('now'))) AS INTEGER)+CASE WHEN CAST(strftime('%m',COALESCE(created_at,datetime('now'))) AS INTEGER)>=10 THEN 544 ELSE 543 END WHERE fiscal_year IS NULL`),
  ]);
  readyDatabases.add(env.DB);
}

async function currentUser(request, env) {
  const user = await getCurrentUser(request, env);
  return user?.role ? user : null;
}

async function owner(env, user, projectId) {
  if (isAdmin(user)) return true;
  return Boolean(await env.DB.prepare("SELECT 1 FROM project_owners WHERE project_id=? AND user_id=?")
    .bind(projectId, user.id).first());
}

async function requestNo(env, year) {
  const row = await env.DB.prepare(`INSERT INTO budget_counters(fiscal_year,last_number) VALUES(?,1)
    ON CONFLICT(fiscal_year) DO UPDATE SET last_number=last_number+1 RETURNING last_number`).bind(year).first();
  return `BUD-${year}-${String(row.last_number).padStart(4, "0")}`;
}

async function audit(env, user, action, id, details, request) {
  await env.DB.prepare(`INSERT INTO audit_logs(user_id,action,resource,resource_id,details,ip_address)
    VALUES(?,?,?,?,?,?)`).bind(user.id, action, "budget_request", id, JSON.stringify(details || {}), request.headers.get("CF-Connecting-IP") || null).run();
}

function normalizeItems(body) {
  if (!Array.isArray(body.items) || !body.items.length) return { error: "กรุณาเพิ่มรายการค่าใช้จ่ายอย่างน้อย 1 รายการ" };
  const items = [];
  for (let index = 0; index < body.items.length; index++) {
    const row = body.items[index] || {};
    const description = clean(row.description, 500), quantity = Number(row.quantity), unitPrice = Number(row.unit_price);
    if (!description) return { error: `กรุณาระบุรายละเอียดรายการที่ ${index + 1}` };
    if (!Number.isFinite(quantity) || quantity <= 0) return { error: `จำนวนรายการที่ ${index + 1} ต้องมากกว่า 0` };
    if (!Number.isFinite(unitPrice) || unitPrice < 0) return { error: `ราคาต่อหน่วยรายการที่ ${index + 1} ไม่ถูกต้อง` };
    items.push({
      line_no: index + 1,
      category: CATEGORIES.includes(row.category) && row.category !== "opening_balance" ? row.category : "other",
      description, quantity, unit: clean(row.unit, 100), unit_price: unitPrice,
      amount: Math.round(quantity * unitPrice * 100) / 100,
    });
  }
  return { items, total: Math.round(items.reduce((sum, item) => sum + item.amount, 0) * 100) / 100 };
}

async function workflowAssignments(env, department, requesterId) {
  const assignments = [], missing = [];
  for (const [index, step] of WORKFLOW_STEPS.entries()) {
    const scope = step.scoped ? department : "";
    const row = await env.DB.prepare(`SELECT a.user_id,u.full_name,u.status,u.deleted_at
      FROM budget_role_assignments a JOIN users u ON u.id=a.user_id WHERE a.role_key=? AND a.department=?`)
      .bind(step.key, scope).first();
    if (!row || row.status !== "active" || row.deleted_at) { missing.push(step.label); continue; }
    if (Number(row.user_id) === Number(requesterId)) { missing.push(`${step.label} (ต้องเป็นคนละคนกับผู้ขอ)`); continue; }
    assignments.push({ ...step, order: index + 1, user_id: row.user_id, user_name: row.full_name });
  }
  return { assignments, missing };
}

async function startWorkflow(env, expenseId, department, requesterId) {
  const { assignments, missing } = await workflowAssignments(env, department, requesterId);
  if (missing.length) return { error: `ยังไม่ได้กำหนดผู้อนุมัติ: ${missing.join(", ")}` };
  await env.DB.batch(assignments.map((step, index) => env.DB.prepare(`INSERT INTO budget_request_approvals
    (expense_id,step_key,step_label,step_order,assigned_user_id,status) VALUES(?,?,?,?,?,?)`)
    .bind(expenseId, step.key, step.label, step.order, step.user_id, index === 0 ? "pending" : "waiting")));
  await env.DB.prepare(`UPDATE project_expenses SET status='pending',current_step=?,submitted_at=datetime('now'),
    workflow_started_at=datetime('now'),returned_at=NULL,updated_at=datetime('now') WHERE id=?`)
    .bind(assignments[0].key, expenseId).run();
  return { ok: true };
}

async function replaceItems(env, expenseId, items) {
  const statements = [env.DB.prepare("DELETE FROM budget_request_items WHERE expense_id=?").bind(expenseId)];
  for (const item of items) statements.push(env.DB.prepare(`INSERT INTO budget_request_items
    (expense_id,line_no,category,description,quantity,unit,unit_price,amount) VALUES(?,?,?,?,?,?,?,?)`)
    .bind(expenseId, item.line_no, item.category, item.description, item.quantity, item.unit, item.unit_price, item.amount));
  await env.DB.batch(statements);
}

async function overview(request, env) {
  const user = await currentUser(request, env);
  if (!user) return jsonResponse({ error: "กรุณาเข้าสู่ระบบ" }, 401);
  const year = Number(new URL(request.url).searchParams.get("fiscal_year")) || fiscalYear();
  const [summary, incomes, projects, requests, statusRows, audits, approvalRows, itemRows, roleRows, users] = await Promise.all([
    env.DB.prepare(`SELECT COALESCE((SELECT SUM(budget_amount) FROM projects WHERE status<>'cancelled' AND fiscal_year=?),0) total_budget,
      COALESCE((SELECT SUM(amount) FROM project_expenses WHERE fiscal_year=? AND status='pending'),0) pending_amount,
      COALESCE((SELECT SUM(amount) FROM project_expenses WHERE fiscal_year=? AND status='approved'),0) approved_amount,
      COALESCE((SELECT SUM(amount) FROM project_expenses WHERE fiscal_year=? AND status='paid'),0) paid_amount,
      COALESCE((SELECT SUM(amount) FROM budget_income WHERE fiscal_year=?),0) income_amount`).bind(year, year, year, year, year).first(),
    env.DB.prepare(`SELECT i.*,u.full_name creator_name FROM budget_income i LEFT JOIN users u ON u.id=i.created_by WHERE i.fiscal_year=? ORDER BY i.received_date DESC,i.id DESC`).bind(year).all(),
    env.DB.prepare(`SELECT p.id,p.department,p.name,p.budget_amount,p.spent_amount,p.status,p.description,
      COALESCE(SUM(CASE WHEN e.fiscal_year=? AND e.status='pending' THEN e.amount ELSE 0 END),0) pending_amount,
      COALESCE(SUM(CASE WHEN e.fiscal_year=? AND e.status='approved' THEN e.amount ELSE 0 END),0) approved_amount,
      GROUP_CONCAT(DISTINCT u.full_name) owner_names,MAX(CASE WHEN po.user_id=? THEN 1 ELSE 0 END) can_request
      FROM projects p LEFT JOIN project_expenses e ON e.project_id=p.id
      LEFT JOIN project_owners po ON po.project_id=p.id LEFT JOIN users u ON u.id=po.user_id
      WHERE p.status<>'cancelled' AND p.fiscal_year=? GROUP BY p.id ORDER BY p.department,p.name`).bind(year, year, user.id, year).all(),
    env.DB.prepare(`SELECT e.*,p.name project_name,p.department,creator.full_name requester_name,approver.full_name approver_name,
      (SELECT a.id FROM file_attachments a WHERE a.entity_type='project_expense' AND a.entity_id=e.id ORDER BY a.id DESC LIMIT 1) attachment_id,
      (SELECT a.file_name FROM file_attachments a WHERE a.entity_type='project_expense' AND a.entity_id=e.id ORDER BY a.id DESC LIMIT 1) attachment_name
      FROM project_expenses e JOIN projects p ON p.id=e.project_id LEFT JOIN users creator ON creator.id=e.created_by
      LEFT JOIN users approver ON approver.id=e.approved_by WHERE e.fiscal_year=?
      ORDER BY CASE e.status WHEN 'pending' THEN 0 WHEN 'approved' THEN 1 WHEN 'draft' THEN 2 ELSE 3 END,e.created_at DESC,e.id DESC`).bind(year).all(),
    env.DB.prepare("SELECT status,COUNT(*) item_count,COALESCE(SUM(amount),0) total_amount FROM project_expenses WHERE fiscal_year=? GROUP BY status").bind(year).all(),
    env.DB.prepare(`SELECT a.*,u.full_name user_name FROM audit_logs a LEFT JOIN users u ON u.id=a.user_id WHERE a.resource='budget_request' ORDER BY a.created_at DESC LIMIT 100`).all(),
    env.DB.prepare(`SELECT a.*,assignee.full_name assigned_name,actor.full_name acted_name FROM budget_request_approvals a
      JOIN project_expenses e ON e.id=a.expense_id LEFT JOIN users assignee ON assignee.id=a.assigned_user_id
      LEFT JOIN users actor ON actor.id=a.acted_by WHERE e.fiscal_year=? ORDER BY a.expense_id,a.step_order`).bind(year).all(),
    env.DB.prepare(`SELECT i.* FROM budget_request_items i JOIN project_expenses e ON e.id=i.expense_id WHERE e.fiscal_year=? ORDER BY i.expense_id,i.line_no`).bind(year).all(),
    isAdmin(user) ? env.DB.prepare(`SELECT a.role_key,a.department,a.user_id,u.full_name FROM budget_role_assignments a JOIN users u ON u.id=a.user_id ORDER BY a.role_key,a.department`).all() : Promise.resolve({ results: [] }),
    isAdmin(user) ? env.DB.prepare(`SELECT id,full_name,email,role FROM users WHERE status='active' AND role IS NOT NULL AND deleted_at IS NULL ORDER BY full_name`).all() : Promise.resolve({ results: [] }),
  ]);

  const approvalsByRequest = new Map(), itemsByRequest = new Map();
  for (const row of approvalRows.results) { if (!approvalsByRequest.has(row.expense_id)) approvalsByRequest.set(row.expense_id, []); approvalsByRequest.get(row.expense_id).push(row); }
  for (const row of itemRows.results) { if (!itemsByRequest.has(row.expense_id)) itemsByRequest.set(row.expense_id, []); itemsByRequest.get(row.expense_id).push(row); }
  const financeAssignment = await env.DB.prepare("SELECT user_id FROM budget_role_assignments WHERE role_key='finance_review' AND department='' ").first();
  const totals = Object.fromEntries(STATUSES.map((status) => [status, { item_count: 0, total_amount: 0 }]));
  for (const row of statusRows.results) totals[row.status] = { item_count: Number(row.item_count), total_amount: Number(row.total_amount) };
  const number = (value) => Number(value || 0), total = number(summary.total_budget), approved = number(summary.approved_amount), paid = number(summary.paid_amount);
  const requestData = requests.results.map((row) => {
    const approvals = approvalsByRequest.get(row.id) || [], activeApproval = approvals.find((step) => step.status === "pending");
    return { ...row, amount: number(row.amount), approvals, items: itemsByRequest.get(row.id) || [],
      can_edit: Number(row.created_by) === Number(user.id) && row.status === "draft",
      can_sign: Boolean(activeApproval && Number(activeApproval.assigned_user_id) === Number(user.id)),
      can_return: Boolean(activeApproval && Number(activeApproval.assigned_user_id) === Number(user.id)),
      can_pay: row.status === "approved" && row.current_step === "finance_completion" && Number(financeAssignment?.user_id) === Number(user.id),
      document_ready: Boolean(row.workflow_completed_at && ["approved", "paid"].includes(row.status)) };
  });
  return jsonResponse({ fiscal_year: year,
    summary: { ...summary, total_budget: total, pending_amount: number(summary.pending_amount), approved_amount: approved, paid_amount: paid, income_amount: number(summary.income_amount), available_amount: total - approved - paid },
    status_totals: totals,
    projects: projects.results.map((row) => ({ ...row, budget_amount: number(row.budget_amount), spent_amount: number(row.spent_amount), pending_amount: number(row.pending_amount), approved_amount: number(row.approved_amount), can_request: isAdmin(user) || Boolean(row.can_request) })),
    requests: requestData, incomes: incomes.results.map((row) => ({ ...row, amount: number(row.amount) })), audit: audits.results,
    role_assignments: roleRows.results, assignable_users: users.results, workflow_steps: WORKFLOW_STEPS,
    permissions: { can_manage_roles: isAdmin(user), can_manage_income: isAdmin(user), role: user.role } });
}

async function createRequest(request, env) {
  const user = await currentUser(request, env);
  if (!user) return jsonResponse({ error: "กรุณาเข้าสู่ระบบ" }, 401);
  const body = await request.json().catch(() => null);
  if (!body) return jsonResponse({ error: "รูปแบบข้อมูลไม่ถูกต้อง" }, 400);
  const projectId = Number(body.project_id);
  const project = await env.DB.prepare("SELECT id,department,budget_amount,fiscal_year FROM projects WHERE id=? AND status<>'cancelled'").bind(projectId).first();
  if (!project) return jsonResponse({ error: "ไม่พบโครงการที่เลือก" }, 404);
  if (!(await owner(env, user, projectId))) return jsonResponse({ error: "คุณไม่ได้เป็นผู้รับผิดชอบโครงการนี้" }, 403);
  const date = String(body.expense_date || ""), purpose = clean(body.request_purpose || body.description, 1000), necessity = clean(body.necessity, 1500);
  if (!validDate(date) || !purpose || !necessity) return jsonResponse({ error: "กรุณากรอกวันที่ วัตถุประสงค์ และเหตุผลความจำเป็นให้ครบ" }, 400);
  if (body.needed_date && !validDate(body.needed_date)) return jsonResponse({ error: "วันที่ต้องการใช้เงินไม่ถูกต้อง" }, 400);
  const parsed = normalizeItems(body);
  if (parsed.error) return jsonResponse({ error: parsed.error }, 400);
  const year = Number(body.fiscal_year) || Number(project.fiscal_year) || fiscalYear(date);
  if (!Number.isInteger(year) || year < 2500 || year > 3000) return jsonResponse({ error: "ปีงบประมาณไม่ถูกต้อง" }, 400);
  if (Number(project.fiscal_year) !== year) return jsonResponse({ error: `โครงการนี้อยู่ในปีงบประมาณ ${project.fiscal_year}` }, 409);
  const saveAsDraft = Boolean(body.save_as_draft);
  if (!saveAsDraft) { const readiness = await workflowAssignments(env, project.department, user.id); if (readiness.missing.length) return jsonResponse({ error: `ยังส่งคำขอไม่ได้ เพราะยังไม่ได้กำหนดผู้อนุมัติ: ${readiness.missing.join(", ")}` }, 409); }
  const number = await requestNo(env, year);
  const result = await env.DB.prepare(`INSERT INTO project_expenses
    (project_id,expense_date,document_no,category,description,payee,amount,status,notes,created_by,request_no,fiscal_year,
     request_purpose,necessity,source_type,payment_preference,needed_date,current_step)
    VALUES(?,?,?,?,?,?,?,'draft',?,?,?,?,?,?,?,?,?,?)`).bind(
    projectId, date, clean(body.document_no, 100), parsed.items.length === 1 ? parsed.items[0].category : "other", purpose,
    clean(body.payee, 250), parsed.total, clean(body.notes, 1000), user.id, number, year, purpose, necessity,
    SOURCE_TYPES.includes(body.source_type) ? body.source_type : "other",
    PAYMENT_METHODS.includes(body.payment_preference) ? body.payment_preference : "transfer", body.needed_date || null, "draft"
  ).run();
  const expenseId = result.meta.last_row_id;
  await replaceItems(env, expenseId, parsed.items);
  if (!saveAsDraft) { const started = await startWorkflow(env, expenseId, project.department, user.id); if (started.error) { await env.DB.prepare("DELETE FROM project_expenses WHERE id=?").bind(expenseId).run(); return jsonResponse({ error: started.error }, 409); } }
  await audit(env, user, saveAsDraft ? "draft" : "submit", expenseId, { request_no: number, project_id: projectId, amount: parsed.total }, request);
  return jsonResponse({ id: expenseId, request_no: number }, 201);
}

async function updateRequest(request, env, id) {
  const user = await currentUser(request, env);
  if (!user) return jsonResponse({ error: "กรุณาเข้าสู่ระบบ" }, 401);
  const row = await env.DB.prepare(`SELECT e.*,p.department FROM project_expenses e JOIN projects p ON p.id=e.project_id WHERE e.id=?`).bind(id).first();
  if (!row) return jsonResponse({ error: "ไม่พบคำขอ" }, 404);
  if (Number(row.created_by) !== Number(user.id)) return jsonResponse({ error: "เฉพาะผู้จัดทำคำขอเท่านั้นที่แก้ไขได้" }, 403);
  if (row.status !== "draft") return jsonResponse({ error: "คำขอที่ส่งเข้ากระบวนการแล้วแก้ไขไม่ได้ เว้นแต่ถูกส่งกลับ" }, 409);
  const body = await request.json().catch(() => null), purpose = clean(body?.request_purpose || body?.description, 1000), necessity = clean(body?.necessity, 1500);
  if (!body || !validDate(body.expense_date) || !purpose || !necessity) return jsonResponse({ error: "กรุณากรอกข้อมูลให้ครบ" }, 400);
  if (body.needed_date && !validDate(body.needed_date)) return jsonResponse({ error: "วันที่ต้องการใช้เงินไม่ถูกต้อง" }, 400);
  const parsed = normalizeItems(body);
  if (parsed.error) return jsonResponse({ error: parsed.error }, 400);
  await env.DB.prepare(`UPDATE project_expenses SET expense_date=?,category=?,description=?,payee=?,amount=?,notes=?,request_purpose=?,
    necessity=?,source_type=?,payment_preference=?,needed_date=?,updated_at=datetime('now') WHERE id=?`).bind(
    body.expense_date, parsed.items.length === 1 ? parsed.items[0].category : "other", purpose, clean(body.payee, 250), parsed.total,
    clean(body.notes, 1000), purpose, necessity, SOURCE_TYPES.includes(body.source_type) ? body.source_type : "other",
    PAYMENT_METHODS.includes(body.payment_preference) ? body.payment_preference : "transfer", body.needed_date || null, id).run();
  await replaceItems(env, id, parsed.items);
  if (!body.save_as_draft) {
    const readiness = await workflowAssignments(env, row.department, user.id);
    if (readiness.missing.length) return jsonResponse({ error: `ยังส่งคำขอไม่ได้ เพราะยังไม่ได้กำหนดผู้อนุมัติ: ${readiness.missing.join(", ")}` }, 409);
    await env.DB.prepare("DELETE FROM budget_request_approvals WHERE expense_id=?").bind(id).run();
    await startWorkflow(env, id, row.department, user.id);
  }
  await audit(env, user, body.save_as_draft ? "edit_draft" : "resubmit", id, { amount: parsed.total }, request);
  return jsonResponse({ ok: true });
}

async function workflowAction(request, env, id) {
  const user = await currentUser(request, env);
  if (!user) return jsonResponse({ error: "กรุณาเข้าสู่ระบบ" }, 401);
  const body = await request.json().catch(() => null);
  if (!body) return jsonResponse({ error: "รูปแบบข้อมูลไม่ถูกต้อง" }, 400);
  const row = await env.DB.prepare(`SELECT e.*,p.department,p.budget_amount FROM project_expenses e JOIN projects p ON p.id=e.project_id WHERE e.id=?`).bind(id).first();
  if (!row) return jsonResponse({ error: "ไม่พบคำขอ" }, 404);
  if (body.action === "submit") {
    if (Number(row.created_by) !== Number(user.id) || row.status !== "draft") return jsonResponse({ error: "ส่งได้เฉพาะคำขอร่างของตนเอง" }, 409);
    const readiness = await workflowAssignments(env, row.department, user.id);
    if (readiness.missing.length) return jsonResponse({ error: `ยังส่งคำขอไม่ได้ เพราะยังไม่ได้กำหนดผู้อนุมัติ: ${readiness.missing.join(", ")}` }, 409);
    await env.DB.prepare("DELETE FROM budget_request_approvals WHERE expense_id=?").bind(id).run();
    await startWorkflow(env, id, row.department, user.id);
    await audit(env, user, "submit", id, {}, request);
    return jsonResponse({ ok: true });
  }
  if (["sign", "return", "reject"].includes(body.action)) {
    const approval = await env.DB.prepare("SELECT * FROM budget_request_approvals WHERE expense_id=? AND status='pending' ORDER BY step_order LIMIT 1").bind(id).first();
    if (!approval) return jsonResponse({ error: "รายการนี้ไม่มีขั้นอนุมัติที่รอดำเนินการ" }, 409);
    if (Number(approval.assigned_user_id) !== Number(user.id)) return jsonResponse({ error: "รายการนี้ไม่ได้อยู่ในคิวอนุมัติของคุณ" }, 403);
    const note = clean(body.review_note, 1000);
    if (["return", "reject"].includes(body.action) && !note) return jsonResponse({ error: "กรุณาระบุเหตุผล" }, 400);
    if (body.action === "return") {
      await env.DB.batch([
        env.DB.prepare("UPDATE budget_request_approvals SET status='returned',note=?,acted_by=?,signed_name=?,signed_at=datetime('now'),updated_at=datetime('now') WHERE id=?").bind(note, user.id, user.full_name, approval.id),
        env.DB.prepare("UPDATE project_expenses SET status='draft',current_step='returned',review_note=?,returned_at=datetime('now'),updated_at=datetime('now') WHERE id=?").bind(note, id),
      ]);
      await audit(env, user, "return", id, { step: approval.step_key, note }, request);
      return jsonResponse({ ok: true });
    }
    if (body.action === "reject") {
      await env.DB.batch([
        env.DB.prepare("UPDATE budget_request_approvals SET status='rejected',note=?,acted_by=?,signed_name=?,signed_at=datetime('now'),updated_at=datetime('now') WHERE id=?").bind(note, user.id, user.full_name, approval.id),
        env.DB.prepare("UPDATE project_expenses SET status='rejected',current_step='rejected',review_note=?,approved_by=?,approved_at=datetime('now'),updated_at=datetime('now') WHERE id=?").bind(note, user.id, id),
      ]);
      await audit(env, user, "reject", id, { step: approval.step_key, note }, request);
      return jsonResponse({ ok: true });
    }
    if (approval.step_key === "director_approval") {
      const committed = await env.DB.prepare("SELECT COALESCE(SUM(amount),0) total FROM project_expenses WHERE project_id=? AND id<>? AND status IN('approved','paid')").bind(row.project_id, id).first();
      const available = Number(row.budget_amount || 0) - Number(committed.total || 0);
      if (Number(row.amount) > available) return jsonResponse({ error: `วงเงินโครงการไม่พอ คงเหลือ ${available.toLocaleString("th-TH")} บาท` }, 409);
    }
    await env.DB.prepare("UPDATE budget_request_approvals SET status='approved',note=?,acted_by=?,signed_name=?,signed_at=datetime('now'),updated_at=datetime('now') WHERE id=?").bind(note, user.id, user.full_name, approval.id).run();
    const next = await env.DB.prepare("SELECT * FROM budget_request_approvals WHERE expense_id=? AND status='waiting' ORDER BY step_order LIMIT 1").bind(id).first();
    if (next) await env.DB.batch([
      env.DB.prepare("UPDATE budget_request_approvals SET status='pending',updated_at=datetime('now') WHERE id=?").bind(next.id),
      env.DB.prepare("UPDATE project_expenses SET current_step=?,updated_at=datetime('now') WHERE id=?").bind(next.step_key, id),
    ]);
    else await env.DB.prepare("UPDATE project_expenses SET status='approved',current_step='finance_completion',approved_by=?,approved_at=datetime('now'),workflow_completed_at=datetime('now'),updated_at=datetime('now') WHERE id=?").bind(user.id, id).run();
    await audit(env, user, "sign", id, { step: approval.step_key, note }, request);
    return jsonResponse({ ok: true });
  }
  if (body.action === "pay") {
    const finance = await env.DB.prepare("SELECT user_id FROM budget_role_assignments WHERE role_key='finance_review' AND department='' ").first();
    if (!finance || Number(finance.user_id) !== Number(user.id)) return jsonResponse({ error: "เฉพาะผู้รับผิดชอบฝ่ายการเงินเท่านั้น" }, 403);
    if (row.status !== "approved" || row.current_step !== "finance_completion") return jsonResponse({ error: "คำขอยังผ่านการลงนามไม่ครบ" }, 409);
    const paymentNo = clean(body.payment_no, 100), paymentDate = String(body.payment_date || ""), method = PAYMENT_METHODS.includes(body.payment_method) ? body.payment_method : null;
    if (!paymentNo || !validDate(paymentDate) || !method) return jsonResponse({ error: "กรุณาระบุเลขที่จ่าย วันที่ และวิธีจ่าย" }, 400);
    await env.DB.prepare("UPDATE project_expenses SET status='paid',current_step='completed',payment_no=?,payment_date=?,payment_method=?,paid_at=datetime('now'),updated_at=datetime('now') WHERE id=?").bind(paymentNo, paymentDate, method, id).run();
    await audit(env, user, "pay", id, { payment_no: paymentNo }, request);
    return jsonResponse({ ok: true });
  }
  return jsonResponse({ error: "คำสั่งไม่ถูกต้อง" }, 400);
}

async function saveRoleAssignment(request, env) {
  const user = await currentUser(request, env);
  if (!isAdmin(user)) return jsonResponse({ error: "เฉพาะผู้บริหารหรือผู้ดูแลระบบเท่านั้น" }, 403);
  const body = await request.json().catch(() => null), roleKey = String(body?.role_key || ""), department = String(body?.department || ""), userId = Number(body?.user_id);
  const definition = WORKFLOW_STEPS.find((step) => step.key === roleKey);
  if (!definition || !ROLE_KEYS.includes(roleKey)) return jsonResponse({ error: "หน้าที่อนุมัติไม่ถูกต้อง" }, 400);
  if (definition.scoped && !["academic", "budget", "personnel", "general"].includes(department)) return jsonResponse({ error: "กรุณาเลือกฝ่ายงาน" }, 400);
  if (!definition.scoped && department) return jsonResponse({ error: "หน้าที่นี้ไม่ต้องระบุฝ่าย" }, 400);
  const target = await env.DB.prepare("SELECT id FROM users WHERE id=? AND status='active' AND role IS NOT NULL AND deleted_at IS NULL").bind(userId).first();
  if (!target) return jsonResponse({ error: "ไม่พบบัญชีผู้ใช้งานที่เลือก" }, 404);
  await env.DB.prepare(`INSERT INTO budget_role_assignments(role_key,department,user_id,assigned_by,assigned_at) VALUES(?,?,?,?,datetime('now'))
    ON CONFLICT(role_key,department) DO UPDATE SET user_id=excluded.user_id,assigned_by=excluded.assigned_by,assigned_at=datetime('now')`)
    .bind(roleKey, definition.scoped ? department : "", userId, user.id).run();
  await audit(env, user, "assign_role", null, { role_key: roleKey, department, user_id: userId }, request);
  return jsonResponse({ ok: true });
}

async function createIncome(request, env) {
  const user = await currentUser(request, env);
  if (!user) return jsonResponse({ error: "กรุณาเข้าสู่ระบบ" }, 401);
  if (!isAdmin(user)) return jsonResponse({ error: "เฉพาะผู้บริหารหรือผู้ดูแลระบบเท่านั้น" }, 403);
  const body = await request.json().catch(() => null), amount = Number(body?.amount);
  if (!body || !validDate(body.received_date) || !clean(body.source_name, 300) || !Number.isFinite(amount) || amount <= 0) return jsonResponse({ error: "กรุณากรอกวันที่ แหล่งเงิน และจำนวนเงิน" }, 400);
  const year = Number(body.fiscal_year) || fiscalYear(body.received_date);
  const result = await env.DB.prepare("INSERT INTO budget_income(fiscal_year,received_date,document_no,source_name,source_type,amount,notes,created_by) VALUES(?,?,?,?,?,?,?,?)")
    .bind(year, body.received_date, clean(body.document_no, 100), clean(body.source_name, 300), SOURCE_TYPES.includes(body.source_type) ? body.source_type : "other", amount, clean(body.notes, 1000), user.id).run();
  return jsonResponse({ id: result.meta.last_row_id }, 201);
}

const money = (value) => Number(value || 0).toLocaleString("th-TH", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const thaiDate = (value) => value ? new Date(String(value).includes("T") ? value : `${value}T00:00:00`).toLocaleDateString("th-TH", { day: "numeric", month: "long", year: "numeric" }) : "";

async function printableDocument(request, env, id) {
  const user = await currentUser(request, env);
  if (!user) return new Response("กรุณาเข้าสู่ระบบ", { status: 401 });
  const row = await env.DB.prepare(`SELECT e.*,p.name project_name,p.department,u.full_name requester_name FROM project_expenses e
    JOIN projects p ON p.id=e.project_id LEFT JOIN users u ON u.id=e.created_by WHERE e.id=?`).bind(id).first();
  if (!row) return new Response("ไม่พบคำขอ", { status: 404 });
  if (!row.workflow_completed_at || !["approved", "paid"].includes(row.status)) return new Response("เอกสารจะสร้างได้หลังลงนามครบทุกขั้น", { status: 409 });
  const [{ results: items }, { results: approvals }] = await Promise.all([
    env.DB.prepare("SELECT * FROM budget_request_items WHERE expense_id=? ORDER BY line_no").bind(id).all(),
    env.DB.prepare("SELECT a.*,u.full_name assigned_name FROM budget_request_approvals a LEFT JOIN users u ON u.id=a.assigned_user_id WHERE a.expense_id=? ORDER BY a.step_order").bind(id).all(),
  ]);
  const departments = { academic: "ฝ่ายบริหารงานวิชาการ", budget: "ฝ่ายบริหารงานงบประมาณ", personnel: "ฝ่ายบริหารงานบุคคล", general: "ฝ่ายบริหารงานทั่วไป" };
  const categories = { materials: "วัสดุ", equipment: "ครุภัณฑ์", services: "ค่าใช้สอย/จ้างบริการ", compensation: "ค่าตอบแทน", utilities: "สาธารณูปโภค", travel: "ค่าเดินทาง", food: "อาหาร/อาหารว่าง", other: "อื่น ๆ" };
  const itemHtml = items.length ? items.map((item) => `<tr><td>${item.line_no}</td><td>${escapeHtml(categories[item.category] || item.category)}</td><td>${escapeHtml(item.description)}</td><td class="num">${money(item.quantity)} ${escapeHtml(item.unit || "")}</td><td class="num">${money(item.unit_price)}</td><td class="num">${money(item.amount)}</td></tr>`).join("") : `<tr><td>1</td><td>${escapeHtml(categories[row.category] || row.category)}</td><td>${escapeHtml(row.description)}</td><td class="num">1</td><td class="num">${money(row.amount)}</td><td class="num">${money(row.amount)}</td></tr>`;
  const signatureHtml = approvals.map((step) => `<div class="signature"><div class="signed">ลงนามอิเล็กทรอนิกส์แล้ว</div><strong>${escapeHtml(step.signed_name || step.assigned_name)}</strong><span>${escapeHtml(step.step_label)}</span><small>${thaiDate(step.signed_at)}</small></div>`).join("");
  const html = `<!doctype html><html lang="th"><head><meta charset="utf-8"><title>${escapeHtml(row.request_no)}</title><style>@page{size:A4;margin:14mm}*{box-sizing:border-box}body{font-family:"TH Sarabun New","Sarabun",sans-serif;color:#111;font-size:16pt;line-height:1.28;margin:0}h1{text-align:center;font-size:20pt;margin:0}h2{text-align:center;font-size:17pt;margin:2px 0 14px}.meta{display:grid;grid-template-columns:1fr 1fr;gap:5px 20px;margin-bottom:12px}.line{border-bottom:1px dotted #555;padding:2px 4px}table{width:100%;border-collapse:collapse;font-size:14pt}th,td{border:1px solid #555;padding:5px 6px;vertical-align:top}th{background:#eef3f7}.num{text-align:right;white-space:nowrap}.total{font-weight:bold;text-align:right}.section{margin:12px 0}.section strong{display:block}.box{min-height:48px;border:1px solid #777;padding:7px;margin-top:3px}.signatures{display:grid;grid-template-columns:1fr 1fr;gap:14px;margin-top:18px}.signature{text-align:center;min-height:105px;padding-top:8px;border-top:1px solid #999}.signature span,.signature small{display:block}.signed{display:inline-block;padding:2px 7px;border:1px solid #25845f;border-radius:12px;color:#187054;font-size:10pt;margin-bottom:5px}.actions{position:fixed;right:16px;top:12px}@media print{.actions{display:none}}button{font:14px sans-serif;padding:8px 14px;border:0;border-radius:8px;background:#0879e5;color:white;cursor:pointer}</style></head><body><div class="actions"><button onclick="window.print()">พิมพ์ / บันทึกเป็น PDF</button></div><h1>แบบขอใช้งบประมาณเพื่อดำเนินโครงการ</h1><h2>โรงเรียนบ้านป่าเด็ง</h2><div class="meta"><div class="line"><strong>เลขที่คำขอ:</strong> ${escapeHtml(row.request_no)}</div><div class="line"><strong>วันที่:</strong> ${thaiDate(row.expense_date)}</div><div class="line"><strong>ผู้ขอ:</strong> ${escapeHtml(row.requester_name)}</div><div class="line"><strong>ฝ่ายงาน:</strong> ${escapeHtml(departments[row.department])}</div><div class="line"><strong>โครงการ:</strong> ${escapeHtml(row.project_name)}</div><div class="line"><strong>ปีงบประมาณ:</strong> ${escapeHtml(row.fiscal_year)}</div></div><div class="section"><strong>วัตถุประสงค์</strong><div class="box">${escapeHtml(row.request_purpose || row.description)}</div></div><div class="section"><strong>เหตุผลและความจำเป็น</strong><div class="box">${escapeHtml(row.necessity || "")}</div></div><table><thead><tr><th style="width:7%">ลำดับ</th><th style="width:16%">หมวด</th><th>รายการ</th><th style="width:15%">จำนวน</th><th style="width:15%">ราคาต่อหน่วย</th><th style="width:15%">รวม</th></tr></thead><tbody>${itemHtml}<tr><td colspan="5" class="total">รวมทั้งสิ้น</td><td class="num"><strong>${money(row.amount)}</strong></td></tr></tbody></table><div class="section"><strong>ผู้รับเงิน/ร้านค้า:</strong> ${escapeHtml(row.payee || "")}&nbsp;&nbsp; <strong>วันที่ต้องการใช้เงิน:</strong> ${thaiDate(row.needed_date)}</div><div class="signatures">${signatureHtml}</div><div class="section"><small>เอกสารนี้สร้างจากระบบบริหารงานโรงเรียนบ้านป่าเด็ง การลงนามอ้างอิงบัญชีผู้ใช้และวันเวลาที่บันทึกในระบบ</small></div></body></html>`;
  return new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } });
}

export async function handleBudgetRoute(request, env, pathname, method) {
  if (!pathname.startsWith("/api/budget")) return null;
  await ensureBudgetSchema(env);
  if (pathname === "/api/budget/overview" && method === "GET") return overview(request, env);
  if (pathname === "/api/budget/requests" && method === "POST") return createRequest(request, env);
  if (pathname === "/api/budget/income" && method === "POST") return createIncome(request, env);
  if (pathname === "/api/budget/roles" && method === "PUT") return saveRoleAssignment(request, env);
  let match = pathname.match(/^\/api\/budget\/requests\/(\d+)\/document$/);
  if (match && method === "GET") return printableDocument(request, env, Number(match[1]));
  match = pathname.match(/^\/api\/budget\/requests\/(\d+)$/);
  if (match && method === "PATCH") return updateRequest(request, env, Number(match[1]));
  match = pathname.match(/^\/api\/budget\/requests\/(\d+)\/action$/);
  if (match && method === "POST") return workflowAction(request, env, Number(match[1]));
  return jsonResponse({ error: "ไม่พบ endpoint งบประมาณนี้" }, 404);
}
