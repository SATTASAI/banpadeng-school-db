import { money, sumMoney, multiplyMoney, financialTotals, projectFinancialRows } from '../lib/project-finance.js';
import { getCurrentUser, isAdmin, jsonResponse } from "../lib/auth.js";

const ready = new WeakSet();
const clean = (v, max = 1500) => String(v ?? "").trim().slice(0, max) || null;
const round = money;
const validDate = (v) => /^\d{4}-\d{2}-\d{2}$/.test(v || "") && !Number.isNaN(Date.parse(v)) && new Date(v).toISOString().slice(0, 10) === v;
const categories = ["materials", "equipment", "services", "compensation", "utilities", "travel", "food", "other"];
export const PROJECT_FUNDING_TYPES = { subsidy: "งบอุดหนุน", free_education: "งบเรียนฟรี 15 ปี", school_income: "งบรายได้สถานศึกษา" };
export function currentProjectFiscalYear() {
  const date = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Bangkok', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  const [year, month] = date.split('-').map(Number);
  return year + (month >= 10 ? 544 : 543);
}

export async function projectFundingSummary(env, fiscalYear = currentProjectFiscalYear(), financialRows = null) {
  const projects=financialRows || await projectFinancialRows(env,fiscalYear);
  return {fiscal_year:fiscalYear,budgets:Object.entries(PROJECT_FUNDING_TYPES).map(([key,label])=>({key,label,...financialTotals(projects.filter(p=>p.funding_type===key))})),
    unclassified:financialTotals(projects.filter(p=>!PROJECT_FUNDING_TYPES[p.funding_type]))};
}

export async function ensureProjectWorkflowSchema(env) {
  if (ready.has(env.DB)) return;
  try { await env.DB.prepare("ALTER TABLE projects ADD COLUMN funding_type TEXT").run(); }
  catch (e) { if (!String(e.message).toLowerCase().includes("duplicate column")) throw e; }
  for (const [name, type] of [["workflow_version", "INTEGER NOT NULL DEFAULT 1"], ["priority", "TEXT NOT NULL DEFAULT 'normal'"], ["finance_received_by", "INTEGER"], ["finance_received_at", "TEXT"]]) {
    try { await env.DB.prepare(`ALTER TABLE project_expenses ADD COLUMN ${name} ${type}`).run(); }
    catch (e) { if (!String(e.message).toLowerCase().includes("duplicate column")) throw e; }
  }
  await env.DB.batch([
    env.DB.prepare("CREATE TABLE IF NOT EXISTS admin_cleanup_expense_guard(expense_id INTEGER PRIMARY KEY)"),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS project_workflow_events (
      token TEXT PRIMARY KEY,expense_id INTEGER NOT NULL REFERENCES project_expenses(id) ON DELETE CASCADE,
      project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,event_type TEXT NOT NULL,
      message TEXT NOT NULL,actor_id INTEGER REFERENCES users(id),created_at TEXT NOT NULL DEFAULT(datetime('now')))`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS project_notifications (
      id INTEGER PRIMARY KEY AUTOINCREMENT,event_token TEXT NOT NULL REFERENCES project_workflow_events(token) ON DELETE CASCADE,
      user_id INTEGER NOT NULL REFERENCES users(id),audience TEXT NOT NULL,read_at TEXT,
      UNIQUE(event_token,user_id))`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS budget_supporting_documents (
      id INTEGER PRIMARY KEY AUTOINCREMENT,expense_id INTEGER NOT NULL REFERENCES project_expenses(id) ON DELETE CASCADE,
      title TEXT NOT NULL,native_document_id INTEGER NOT NULL UNIQUE REFERENCES documents(id),created_by INTEGER NOT NULL REFERENCES users(id),notification_sent INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT(datetime('now')))`),
    env.DB.prepare("DROP TRIGGER IF EXISTS trg_project_workflow_paid_delete"),
    env.DB.prepare(`CREATE TRIGGER IF NOT EXISTS trg_project_workflow_paid_delete BEFORE DELETE ON project_expenses
      WHEN OLD.workflow_version=2 AND OLD.status='paid' AND NOT EXISTS(SELECT 1 FROM admin_cleanup_expense_guard WHERE expense_id=OLD.id) BEGIN SELECT RAISE(ABORT,'confirmed_payment_locked'); END`),
    env.DB.prepare(`CREATE TRIGGER IF NOT EXISTS trg_project_workflow_items_insert BEFORE INSERT ON budget_request_items
      WHEN EXISTS(SELECT 1 FROM project_expenses WHERE id=NEW.expense_id AND workflow_version=2 AND status<>'draft')
      BEGIN SELECT RAISE(ABORT,'request_not_draft'); END`),
    env.DB.prepare("DROP TRIGGER IF EXISTS trg_project_workflow_items_delete"),
    env.DB.prepare(`CREATE TRIGGER IF NOT EXISTS trg_project_workflow_items_delete BEFORE DELETE ON budget_request_items
      WHEN EXISTS(SELECT 1 FROM project_expenses WHERE id=OLD.expense_id AND workflow_version=2 AND status<>'draft') AND NOT EXISTS(SELECT 1 FROM admin_cleanup_expense_guard WHERE expense_id=OLD.expense_id)
      BEGIN SELECT RAISE(ABORT,'request_not_draft'); END`),
    env.DB.prepare("CREATE INDEX IF NOT EXISTS idx_project_notifications_unread ON project_notifications(user_id,read_at)"),
    env.DB.prepare("CREATE INDEX IF NOT EXISTS idx_supporting_documents_expense ON budget_supporting_documents(expense_id)"),
    env.DB.prepare(`CREATE TRIGGER IF NOT EXISTS trg_project_workflow_funding_lock BEFORE UPDATE OF funding_type ON projects
      WHEN OLD.funding_type IS NOT NULL AND NEW.funding_type IS NOT OLD.funding_type
        AND EXISTS(SELECT 1 FROM project_expenses WHERE project_id=OLD.id AND status IN ('pending','approved','paid'))
      BEGIN SELECT RAISE(ABORT,'project_funding_locked'); END`),
    env.DB.prepare("DROP TRIGGER IF EXISTS trg_project_workflow_budget_insert"),
    env.DB.prepare(`CREATE TRIGGER IF NOT EXISTS trg_project_workflow_budget_insert BEFORE INSERT ON project_expenses
      WHEN NEW.workflow_version=2 AND NEW.status IN ('pending','approved','paid') BEGIN
      SELECT CASE WHEN CAST(ROUND(NEW.amount*100+0.000001) AS INTEGER)+COALESCE((SELECT SUM(CAST(ROUND(amount*100+0.000001) AS INTEGER)) FROM project_expenses WHERE project_id=NEW.project_id AND status IN ('pending','approved','paid')),0)
        > CAST(ROUND((SELECT budget_amount FROM projects WHERE id=NEW.project_id)*100+0.000001) AS INTEGER)
      THEN RAISE(ABORT,'project_budget_exceeded') END; END`),
    env.DB.prepare("DROP TRIGGER IF EXISTS trg_project_workflow_budget_update"),
    env.DB.prepare(`CREATE TRIGGER IF NOT EXISTS trg_project_workflow_budget_update BEFORE UPDATE ON project_expenses
      WHEN NEW.workflow_version=2 AND NEW.status IN ('pending','approved','paid')
        AND (OLD.status NOT IN ('pending','approved','paid') OR NEW.amount>OLD.amount OR NEW.project_id<>OLD.project_id) BEGIN
      SELECT CASE WHEN CAST(ROUND(NEW.amount*100+0.000001) AS INTEGER)+COALESCE((SELECT SUM(CAST(ROUND(amount*100+0.000001) AS INTEGER)) FROM project_expenses WHERE project_id=NEW.project_id AND id<>NEW.id AND status IN ('pending','approved','paid')),0)
        > CAST(ROUND((SELECT budget_amount FROM projects WHERE id=NEW.project_id)*100+0.000001) AS INTEGER)
      THEN RAISE(ABORT,'project_budget_exceeded') END; END`),
    env.DB.prepare(`CREATE TRIGGER IF NOT EXISTS trg_project_workflow_paid_lock BEFORE UPDATE ON project_expenses
      WHEN OLD.workflow_version=2 AND OLD.status='paid' AND (NEW.amount<>OLD.amount OR NEW.project_id<>OLD.project_id OR NEW.status<>OLD.status)
      BEGIN SELECT RAISE(ABORT,'confirmed_payment_locked'); END`),
    env.DB.prepare("DROP TRIGGER IF EXISTS trg_project_workflow_budget_reduction"),
    env.DB.prepare(`CREATE TRIGGER IF NOT EXISTS trg_project_workflow_budget_reduction BEFORE UPDATE OF budget_amount ON projects
      WHEN NEW.budget_amount<OLD.budget_amount AND CAST(ROUND(NEW.budget_amount*100+0.000001) AS INTEGER)<COALESCE((SELECT SUM(CAST(ROUND(amount*100+0.000001) AS INTEGER)) FROM project_expenses WHERE project_id=NEW.id AND status IN ('pending','approved','paid')),0)
      BEGIN SELECT RAISE(ABORT,'project_budget_exceeded'); END`),
  ]);
  ready.add(env.DB);
}

export async function canManageProjectFinance(env, user) {
  if (isAdmin(user)) return true;
  if (!user) return false;
  return Boolean(await env.DB.prepare("SELECT 1 FROM budget_role_assignments WHERE role_key='finance_review' AND department='' AND user_id=?").bind(user.id).first());
}

async function ownsProject(env, user, id) {
  return isAdmin(user) || Boolean(await env.DB.prepare("SELECT 1 FROM project_owners WHERE project_id=? AND user_id=?").bind(id, user.id).first());
}

// Recover unnotified queue entries and include staff assigned after submission.
// Existing read receipts are preserved by the unique event/user constraint.
export async function ensureFinanceQueueNotifications(env,user) {
  if(!await canManageProjectFinance(env,user))return;
  await env.DB.batch([
    env.DB.prepare(`INSERT OR IGNORE INTO project_workflow_events(token,expense_id,project_id,event_type,message,actor_id,created_at)
      SELECT 'queue-recovery:'||e.id||':'||COALESCE(e.submitted_at,e.created_at),e.id,e.project_id,'submit_recovered',
      'มีคำขอเบิกจ่ายรอเจ้าหน้าที่รับเรื่อง',e.created_by,COALESCE(e.submitted_at,e.created_at)
      FROM project_expenses e WHERE e.workflow_version=2 AND e.status='pending' AND e.current_step='finance_queue'
      AND NOT EXISTS(SELECT 1 FROM project_workflow_events v WHERE v.expense_id=e.id
        AND v.event_type IN ('submit','submit_recovered') AND v.created_at>=COALESCE(e.submitted_at,e.created_at))`),
    env.DB.prepare(`INSERT OR IGNORE INTO project_notifications(event_token,user_id,audience)
      SELECT v.token,?,'finance' FROM project_workflow_events v JOIN project_expenses e ON e.id=v.expense_id
      WHERE e.workflow_version=2 AND e.status='pending' AND e.current_step='finance_queue'
      AND v.event_type IN ('submit','submit_recovered') AND v.created_at>=COALESCE(e.submitted_at,e.created_at)`)
      .bind(user.id),
  ]);
}

export async function canAccessBudgetSupportingDocument(env, user, documentId) {
  const row = await env.DB.prepare(`SELECT e.project_id,e.created_by FROM budget_supporting_documents d JOIN project_expenses e ON e.id=d.expense_id WHERE d.id=?`).bind(documentId).first();
  return Boolean(row && (Number(row.created_by) === Number(user.id) || await ownsProject(env, user, row.project_id) || await canManageProjectFinance(env, user)));
}

function eventStatements(env, token, expenseId, eventType, message, user, audience, condition = "1", conditionValues = []) {
  const statements = [env.DB.prepare(`INSERT INTO project_workflow_events(token,expense_id,project_id,event_type,message,actor_id)
    SELECT ?,e.id,e.project_id,?,?,? FROM project_expenses e WHERE e.id=? AND (${condition})`)
    .bind(token, eventType, message, user.id, expenseId,...conditionValues)];
  const recipients = audience === "finance"
    ? `SELECT u.id FROM users u WHERE u.status='active' AND (u.role IN ('superadmin','executive') OR EXISTS(SELECT 1 FROM budget_role_assignments a WHERE a.user_id=u.id AND a.role_key='finance_review' AND a.department=''))`
    : `SELECT u.id FROM users u WHERE u.status='active' AND (u.id=e.actor_id OR u.id=(SELECT created_by FROM project_expenses WHERE id=e.expense_id) OR EXISTS(SELECT 1 FROM project_owners o WHERE o.project_id=e.project_id AND o.user_id=u.id))`;
  statements.push(env.DB.prepare(`INSERT OR IGNORE INTO project_notifications(event_token,user_id,audience)
    SELECT e.token,u.id,? FROM project_workflow_events e JOIN users u ON u.id IN (${recipients}) WHERE e.token=?`).bind(audience, token));
  statements.push(env.DB.prepare(`INSERT INTO audit_logs(user_id,action,resource,resource_id,details)
    SELECT actor_id,event_type,'budget_request',expense_id,message FROM project_workflow_events WHERE token=?`).bind(token));
  return statements;
}

export async function notifyBudgetSupportingDocument(env, user, documentId) {
  const row = await env.DB.prepare("SELECT expense_id,title FROM budget_supporting_documents WHERE id=?").bind(documentId).first();
  if (!row) return;
  const token = crypto.randomUUID();
  const events=eventStatements(env,token,row.expense_id,"attachment_added",`เพิ่มเอกสาร: ${row.title}`,user,"finance",
    'EXISTS(SELECT 1 FROM budget_supporting_documents WHERE id=? AND notification_sent=0)',[documentId]);
  await env.DB.batch([events[0],
    env.DB.prepare("UPDATE budget_supporting_documents SET notification_sent=1 WHERE id=? AND EXISTS(SELECT 1 FROM project_workflow_events WHERE token=?)").bind(documentId,token),
    ...events.slice(1)]);
}

export async function projectWorkflowSnapshots(env, user, department = null, fiscalYear = null, financialRows = null) {
  const filters = [], values = [user.id, user.id, user.id];
  if (department) { filters.push("COALESCE(p.management_area,p.department)=?"); values.push(department); }
  if (fiscalYear) { filters.push("p.fiscal_year=?"); values.push(fiscalYear); }
  const { results } = await env.DB.prepare(`SELECT p.*,COALESCE(p.management_area,p.department) AS department,
    COALESCE((SELECT SUM(e.amount) FROM project_expenses e WHERE e.project_id=p.id AND e.status='paid' AND e.category='opening_balance'),0) AS opening_spent_amount,
    COALESCE((SELECT SUM(e.amount) FROM project_expenses e WHERE e.project_id=p.id AND e.status='paid' AND e.category<>'opening_balance'),0) AS confirmed_spent_amount,
    COALESCE((SELECT SUM(e.amount) FROM project_expenses e WHERE e.project_id=p.id AND e.status='paid'),0) AS spent_amount,
    COALESCE((SELECT SUM(e.amount) FROM project_expenses e WHERE e.project_id=p.id AND e.status IN ('pending','approved')),0) AS reserved_amount,
    (SELECT COUNT(*) FROM project_expenses e WHERE e.project_id=p.id AND e.status='pending' AND e.workflow_version=2 AND e.current_step='finance_queue') AS new_request_count,
    (SELECT COUNT(*) FROM project_expenses e WHERE e.project_id=p.id AND e.workflow_version=2 AND e.status IN ('pending','approved')) AS active_request_count,
    (SELECT COUNT(*) FROM project_notifications n JOIN project_workflow_events v ON v.token=n.event_token WHERE v.project_id=p.id AND n.user_id=? AND n.read_at IS NULL) AS unread_count,
    EXISTS(SELECT 1 FROM project_owners o WHERE o.project_id=p.id AND o.user_id=?) AS can_request,
    (SELECT v.message FROM project_notifications n JOIN project_workflow_events v ON v.token=n.event_token WHERE v.project_id=p.id AND n.user_id=CAST(? AS INTEGER) AND n.read_at IS NULL ORDER BY n.id DESC LIMIT 1) AS notification_message,
    COALESCE((SELECT MIN(CASE e.priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 ELSE 2 END) FROM project_expenses e WHERE e.project_id=p.id AND e.status IN ('pending','approved') AND e.workflow_version=2),3) AS priority_rank,
    (SELECT MIN(e.needed_date) FROM project_expenses e WHERE e.project_id=p.id AND e.status IN ('pending','approved') AND e.workflow_version=2) AS next_needed_date,
    (SELECT GROUP_CONCAT(u.full_name,', ') FROM project_owners o JOIN users u ON u.id=o.user_id WHERE o.project_id=p.id) AS owner_names
    FROM projects p ${filters.length ? "WHERE " + filters.join(" AND ") : ""}
    ORDER BY CASE WHEN new_request_count>0 THEN 0 WHEN unread_count>0 THEN 1 WHEN active_request_count>0 THEN 2 ELSE 3 END,
      priority_rank,COALESCE(next_needed_date,'9999-12-31'),p.name`).bind(...values).all();
  const financials=new Map((financialRows || await projectFinancialRows(env,fiscalYear,department)).map(p=>[p.id,p]));
  return results.map(p=>({...p,...financials.get(p.id),can_request:isAdmin(user)||Boolean(p.can_request)}));
}

async function overview(request, env, user) {
  const url = new URL(request.url), year = Number(url.searchParams.get("fiscal_year")) || null, department = url.searchParams.get("department") || null;
  const finance = await canManageProjectFinance(env, user);
  await ensureFinanceQueueNotifications(env,user);
  const financialRows=await projectFinancialRows(env,year);
  const fundingSummary = await projectFundingSummary(env,year,financialRows);
  const projects = await projectWorkflowSnapshots(env, user, department, year,financialRows);
  const ids = projects.map(p => p.id);
  if (!ids.length) return jsonResponse({ projects: [], requests: [], notifications: [], funding_summary: fundingSummary, permissions: { can_finance: finance, can_balance_edit: isAdmin(user) } });
  const placeholders = ids.map(() => "?").join(",");
  const { results: requests } = await env.DB.prepare(`SELECT e.*,p.name AS project_name,COALESCE(p.management_area,p.department) AS department,u.full_name AS requester_name
    FROM project_expenses e JOIN projects p ON p.id=e.project_id LEFT JOIN users u ON u.id=e.created_by
    WHERE e.workflow_version=2 AND e.project_id IN (${placeholders}) ${finance ? "" : "AND (e.created_by=? OR EXISTS(SELECT 1 FROM project_owners o WHERE o.project_id=e.project_id AND o.user_id=?))"}
    ORDER BY CASE e.current_step WHEN 'finance_queue' THEN 0 WHEN 'finance_processing' THEN 1 WHEN 'finance_ready' THEN 2 ELSE 3 END,
      CASE e.priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 ELSE 2 END,COALESCE(e.needed_date,'9999-12-31'),e.submitted_at,e.id`).bind(...ids, ...(finance ? [] : [user.id, user.id])).all();
  const { results: items } = await env.DB.prepare(`SELECT i.* FROM budget_request_items i JOIN project_expenses e ON e.id=i.expense_id WHERE e.project_id IN (${placeholders}) ORDER BY i.line_no`).bind(...ids).all();
  const { results: docs } = await env.DB.prepare(`SELECT d.*,a.id AS attachment_id,a.file_name,a.file_size FROM budget_supporting_documents d
    JOIN project_expenses e ON e.id=d.expense_id LEFT JOIN file_attachments a ON a.entity_type='document' AND a.entity_id=d.native_document_id
    WHERE e.project_id IN (${placeholders}) ORDER BY d.id`).bind(...ids).all();
  for (const doc of docs) {
    if (doc.attachment_id && !doc.notification_sent) await notifyBudgetSupportingDocument(env,{ id: doc.created_by },doc.id);
  }
  const { results: notifications } = await env.DB.prepare(`SELECT n.id,n.read_at,v.*,p.name AS project_name FROM project_notifications n
    JOIN project_workflow_events v ON v.token=n.event_token JOIN projects p ON p.id=v.project_id
    WHERE n.user_id=? AND v.project_id IN (${placeholders}) ORDER BY v.created_at DESC,n.id DESC LIMIT 100`).bind(user.id,...ids).all();
  return jsonResponse({ projects, notifications, funding_summary: fundingSummary, permissions: { can_finance: finance, can_balance_edit: isAdmin(user) }, requests: requests.map(e => ({ ...e,
    items: items.filter(i => i.expense_id === e.id), documents: docs.filter(d => d.expense_id === e.id), can_edit: e.status === "draft" && Number(e.created_by) === Number(user.id),
    can_attach: finance || projects.find(p => p.id === e.project_id)?.can_request || Number(e.created_by) === Number(user.id) })) });
}

function parseBody(body) {
  if (!body || !validDate(body.expense_date) || !clean(body.request_purpose) || !clean(body.necessity)) return { error: "กรุณาระบุวันที่ วัตถุประสงค์ และเหตุผลความจำเป็น" };
  if (body.needed_date && !validDate(body.needed_date)) return { error: "วันที่ต้องการใช้เงินไม่ถูกต้อง" };
  if (!Array.isArray(body.items) || !body.items.length || body.items.length > 100) return { error: "กรุณาเพิ่มรายการค่าใช้จ่าย 1–100 รายการ" };
  const items = [];
  for (const [index, r] of body.items.entries()) {
    const quantity = Number(r.quantity), price = Number(r.unit_price), amount = multiplyMoney(quantity,price);
    if (!clean(r.description,500) || !Number.isFinite(quantity) || quantity <= 0 || !Number.isFinite(price) || price < 0 || !Number.isSafeInteger(Math.round(amount * 100))) return { error: `รายการที่ ${index+1} ไม่ถูกต้อง` };
    items.push({ description: clean(r.description,500), category: categories.includes(r.category) ? r.category : "other", quantity, unit: clean(r.unit,100), price, amount });
  }
  const total = sumMoney(items.map(r=>r.amount));
  if (!(total > 0)) return { error: "ยอดเบิกต้องมากกว่า 0 บาท" };
  return { items, total };
}

async function saveDraft(request, env, user, id = null) {
  const body = await request.json().catch(() => null), parsed = parseBody(body);
  if (parsed.error) return jsonResponse({ error: parsed.error },400);
  const old = id ? await env.DB.prepare("SELECT * FROM project_expenses WHERE id=? AND workflow_version=2").bind(id).first() : null;
  if (id && (!old || old.status !== "draft" || Number(old.created_by) !== Number(user.id))) return jsonResponse({ error: "แก้ไขได้เฉพาะร่างของตนเอง" },409);
  const projectId = old ? old.project_id : Number(body.project_id);
  const project = await env.DB.prepare("SELECT * FROM projects WHERE id=? AND status<>'cancelled'").bind(projectId).first();
  if (!project) return jsonResponse({ error: "ไม่พบโครงการ" },404);
  if (!await ownsProject(env,user,projectId)) return jsonResponse({ error: "คุณไม่ได้รับผิดชอบโครงการนี้" },403);
  if (!PROJECT_FUNDING_TYPES[project.funding_type]) return jsonResponse({ error: "กรุณาระบุประเภทเงินในรายละเอียดโครงการก่อนจัดทำคำขอ" },409);
  const source = project.funding_type;
  const method = ["transfer","cash","cheque","other"].includes(body.payment_preference) ? body.payment_preference : "transfer";
  const priority = ["normal","high","urgent"].includes(body.priority) ? body.priority : "normal";
  const values = [body.expense_date,clean(body.request_purpose),clean(body.payee,250),parsed.total,clean(body.notes),clean(body.request_purpose),clean(body.necessity),source,method,body.needed_date || null,priority];
  let requestId = id;
  if (!id) {
    const counter = await env.DB.prepare(`INSERT INTO budget_counters(fiscal_year,last_number) VALUES(?,1) ON CONFLICT(fiscal_year) DO UPDATE SET last_number=last_number+1 RETURNING last_number`).bind(project.fiscal_year).first();
    const number = `BUD-${project.fiscal_year}-${String(counter.last_number).padStart(4,"0")}`;
    const result = await env.DB.prepare(`INSERT INTO project_expenses(project_id,expense_date,description,payee,amount,notes,request_purpose,necessity,source_type,payment_preference,needed_date,priority,
      status,category,current_step,created_by,request_no,fiscal_year,workflow_version) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,'draft','other','draft',?,?,?,2)`)
      .bind(projectId,...values,user.id,number,project.fiscal_year).run();
    requestId = result.meta.last_row_id;
  }
  const statements = [];
  if (id) statements.push(env.DB.prepare(`UPDATE project_expenses SET expense_date=?,description=?,payee=?,amount=?,notes=?,request_purpose=?,necessity=?,source_type=?,payment_preference=?,needed_date=?,priority=?,updated_at=datetime('now') WHERE id=? AND status='draft'`).bind(...values,id));
  statements.push(env.DB.prepare("DELETE FROM budget_request_items WHERE expense_id=?").bind(requestId));
  parsed.items.forEach((r,i) => statements.push(env.DB.prepare(`INSERT INTO budget_request_items(expense_id,line_no,category,description,quantity,unit,unit_price,amount) VALUES(?,?,?,?,?,?,?,?)`).bind(requestId,i+1,r.category,r.description,r.quantity,r.unit,r.price,r.amount)));
  await env.DB.batch(statements);
  return jsonResponse({ id: requestId, saved_as_draft: true }, id ? 200 : 201);
}

async function action(request, env, user, id) {
  const body = await request.json().catch(() => null), kind = body?.action;
  const row = await env.DB.prepare("SELECT * FROM project_expenses WHERE id=? AND workflow_version=2").bind(id).first();
  if (!row) return jsonResponse({ error: "ไม่พบคำขอ" },404);
  let sql, args, audience = "owners", message;
  if (kind === "submit") {
    if (Number(row.created_by) !== Number(user.id) || !await ownsProject(env,user,row.project_id)) return jsonResponse({ error: "ไม่มีสิทธิ์ส่งคำขอนี้" },403);
    const item = await env.DB.prepare("SELECT COUNT(*) AS n,ROUND(SUM(amount),2) AS total FROM budget_request_items WHERE expense_id=?").bind(id).first();
    if (!item.n || round(item.total) !== round(row.amount)) return jsonResponse({ error: "รายการค่าใช้จ่ายไม่ครบ กรุณาบันทึกใหม่" },409);
    sql = "UPDATE project_expenses SET status='pending',current_step='finance_queue',submitted_at=datetime('now'),updated_at=datetime('now') WHERE id=? AND status='draft'";
    args = [id]; audience = "finance"; message = "มีคำขอเบิกจ่ายใหม่ รอเจ้าหน้าที่รับเรื่อง";
  } else {
    if (!await canManageProjectFinance(env,user)) return jsonResponse({ error: "เฉพาะเจ้าหน้าที่การเงินที่ได้รับมอบหมายหรือผู้บริหาร" },403);
    if (kind === "receive") {
      sql = "UPDATE project_expenses SET current_step='finance_processing',finance_received_by=?,finance_received_at=datetime('now'),updated_at=datetime('now') WHERE id=? AND status='pending' AND current_step='finance_queue'";
      args = [user.id,id]; message = "เจ้าหน้าที่การเงินรับเรื่องแล้ว";
    } else if (kind === "complete") {
      sql = "UPDATE project_expenses SET status='approved',current_step='finance_ready',approved_by=?,approved_at=datetime('now'),workflow_completed_at=datetime('now'),updated_at=datetime('now') WHERE id=? AND status='pending' AND current_step='finance_processing'";
      args = [user.id,id]; message = "ดำเนินการเอกสารเสร็จสิ้น รอยืนยันการเบิกจ่าย";
    } else if (["return","reject"].includes(kind)) {
      const note = clean(body.review_note);
      if (!note) return jsonResponse({ error: "กรุณาระบุเหตุผล" },400);
      sql = "UPDATE project_expenses SET status=?,current_step=?,review_note=?,returned_at=datetime('now'),updated_at=datetime('now') WHERE id=? AND status IN ('pending','approved')";
      args = [kind === "return" ? "draft" : "rejected",kind === "return" ? "returned" : "rejected",note,id]; message = `${kind === "return" ? "ส่งกลับให้แก้ไข" : "ไม่อนุมัติ"}: ${note}`;
    } else if (kind === "pay") {
      const date = body.payment_date, method = body.payment_method, recipient = clean(body.payment_recipient,250), number = clean(body.payment_no,100), reference = clean(body.payment_reference,150), tax = round(body.withholding_tax || 0);
      if (!validDate(date) || !["cash","transfer","cheque","other"].includes(method) || !recipient || !number || !Number.isFinite(tax) || tax<0 || tax>Number(row.amount)) return jsonResponse({ error: "กรุณาระบุเลขที่ใบสำคัญ วันที่ วิธีจ่าย ผู้รับเงิน และภาษีให้ถูกต้อง" },400);
      if (["transfer","cheque"].includes(method) && !reference) return jsonResponse({ error: "กรุณาระบุเลขอ้างอิงการโอนหรือเช็ค" },400);
      sql = `UPDATE project_expenses SET status='paid',current_step='completed',payment_no=?,payment_date=?,payment_method=?,payment_reference=?,payment_recipient=?,withholding_tax=?,net_paid=?,payment_note=?,payment_recorded_by=?,paid_at=datetime('now'),updated_at=datetime('now') WHERE id=? AND status='approved' AND current_step='finance_ready'`;
      args = [number,date,method,reference,recipient,tax,sumMoney([row.amount,-tax]),clean(body.payment_note),user.id,id]; message = "ยืนยันการเบิกจ่ายแล้ว สามารถเบิกจ่ายได้ ยอดเงินคงเหลือปรับแล้ว";
    } else return jsonResponse({ error: "คำสั่งไม่ถูกต้อง" },400);
  }
  const token = crypto.randomUUID();
  const conditions={submit:"e.status='draft'",receive:"e.status='pending' AND e.current_step='finance_queue'",
    complete:"e.status='pending' AND e.current_step='finance_processing'",return:"e.status IN ('pending','approved')",
    reject:"e.status IN ('pending','approved')",pay:"e.status='approved' AND e.current_step='finance_ready'"};
  const events=eventStatements(env,token,id,kind,message,user,audience,conditions[kind]);
  // The event is the transaction marker. Do not depend on changes() across D1 statements.
  const results=await env.DB.batch([events[0],env.DB.prepare(sql+' AND EXISTS(SELECT 1 FROM project_workflow_events WHERE token=?)').bind(...args,token),...events.slice(1)]);
  if (!results[1].meta.changes) return jsonResponse({ error: "สถานะเปลี่ยนแล้ว กรุณาโหลดใหม่" },409);
  return jsonResponse({ ok: true });
}

export async function handleProjectWorkflowRoute(request, env, pathname, method) {
  if (!pathname.startsWith("/api/project-documents")) return null;
  const user = await getCurrentUser(request,env);
  if (!user?.role) return jsonResponse({ error: "กรุณาเข้าสู่ระบบ" },401);
  await ensureProjectWorkflowSchema(env);
  try {
    if (pathname === "/api/project-documents/overview" && method === "GET") return await overview(request,env,user);
    if (pathname === "/api/project-documents/requests" && method === "POST") return await saveDraft(request,env,user);
    let match = pathname.match(/^\/api\/project-documents\/requests\/(\d+)$/);
    if (match && method === "PATCH") return await saveDraft(request,env,user,Number(match[1]));
    match = pathname.match(/^\/api\/project-documents\/requests\/(\d+)\/action$/);
    if (match && method === "POST") return await action(request,env,user,Number(match[1]));
    match = pathname.match(/^\/api\/project-documents\/requests\/(\d+)\/supporting-documents$/);
    if (match && method === "POST") {
      const id = Number(match[1]), row = await env.DB.prepare("SELECT e.project_id,e.created_by,p.department,p.management_area FROM project_expenses e JOIN projects p ON p.id=e.project_id WHERE e.id=?").bind(id).first();
      if (!row) return jsonResponse({ error: "ไม่พบคำขอ" },404);
      if (Number(row.created_by)!==Number(user.id) && !await ownsProject(env,user,row.project_id) && !await canManageProjectFinance(env,user)) return jsonResponse({ error: "ไม่มีสิทธิ์แนบเอกสาร" },403);
      const body = await request.json().catch(() => null), title = clean(body?.title,300);
      if (!title) return jsonResponse({ error: "กรุณาระบุชื่อเอกสาร" },400);
      const results = await env.DB.batch([
        env.DB.prepare("INSERT INTO documents(title,department,management_area,project_id,document_type,access_level,uploaded_by) VALUES(?,?,?,?,'หลักฐานเบิกจ่าย','private',?)").bind(title,row.department,row.management_area||null,row.project_id,user.id),
        env.DB.prepare("INSERT INTO budget_supporting_documents(expense_id,title,native_document_id,created_by) VALUES(?,?,last_insert_rowid(),?)").bind(id,title,user.id),
      ]);
      const document = await env.DB.prepare("SELECT native_document_id FROM budget_supporting_documents WHERE id=?").bind(results[1].meta.last_row_id).first();
      return jsonResponse({ id: results[1].meta.last_row_id, entity_type: "document", entity_id: document.native_document_id },201);
    }
    if (pathname === "/api/project-documents/notifications/read" && method === "POST") {
      const body = await request.json().catch(() => null), id = Number(body?.project_id);
      await env.DB.prepare(`UPDATE project_notifications SET read_at=datetime('now') WHERE user_id=? AND read_at IS NULL AND event_token IN (SELECT token FROM project_workflow_events WHERE project_id=?)`).bind(user.id,id).run();
      return jsonResponse({ ok: true });
    }
    return jsonResponse({ error: "ไม่พบรายการ" },404);
  } catch (e) {
    if (String(e.message).includes("request_not_draft")) return jsonResponse({ error: "คำขอถูกส่งแล้ว กรุณาโหลดสถานะใหม่" },409);
    if (String(e.message).includes("project_budget_exceeded")) return jsonResponse({ error: "ยอดเบิกเกินวงเงินคงเหลือที่ขอได้ กรุณาตรวจยอดโครงการ", code: "project_budget_exceeded" },409);
    throw e;
  }
}
