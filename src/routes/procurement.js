// งานจัดซื้อจัดจ้าง (ฝ่ายงบประมาณ)
// ผูกกับคำขอเบิกจ่ายโครงการ (project_expenses workflow_version=2):
// คำขอเบิกจ่าย → รายงานขอซื้อ/ขอจ้าง → หัวหน้าเจ้าหน้าที่ (ถ้ากำหนด) → ผู้อำนวยการอนุมัติ
// → ใบสั่งซื้อ/สั่งจ้าง → ส่งมอบ → ผู้ตรวจรับครบทุกคน → เข้าทะเบียนพัสดุอัตโนมัติ → การเงินเบิกจ่ายต่อ
import { getCurrentUser, isAdmin, jsonResponse } from "../lib/auth.js";
import { FINANCE_ROLE_SQL } from "../lib/finance-roles.js";
import { money, sumMoney, multiplyMoney } from "../lib/project-finance.js";
import { bahtText } from "../lib/thai-baht.js";
import { budgetDirectorIds, canManageProjectFinance, PROJECT_FUNDING_TYPES } from "./project-workflow.js";

const ready = new WeakSet();
export const PROCUREMENT_ROLES = {
  procurement_officer: "เจ้าหน้าที่พัสดุ",
  procurement_officer_2: "เจ้าหน้าที่พัสดุ 2",
  procurement_head: "หัวหน้าเจ้าหน้าที่พัสดุ",
};
export const PROCUREMENT_METHODS = {
  specific: "วิธีเฉพาะเจาะจง",
  selection: "วิธีคัดเลือก",
  e_market: "วิธีตลาดอิเล็กทรอนิกส์ (e-market)",
  e_bidding: "วิธีประกวดราคาอิเล็กทรอนิกส์ (e-bidding)",
};
const STATUS_LABELS = {
  draft: "ร่าง", head_review: "รอหัวหน้าเจ้าหน้าที่เห็นชอบ", director_review: "รอผู้อำนวยการอนุมัติ",
  approved: "อนุมัติแล้ว รอออกใบสั่ง", ordered: "สั่งซื้อ/จ้างแล้ว รอตรวจรับ", accepted: "ตรวจรับแล้ว", cancelled: "ยกเลิก",
};
export const DEFAULT_SPECIFIC_REASON = "ตามมาตรา 56 วรรคหนึ่ง (2) (ข) แห่งพระราชบัญญัติการจัดซื้อจัดจ้างและการบริหารพัสดุภาครัฐ พ.ศ. 2560 เนื่องจากเป็นพัสดุที่มีการผลิต จำหน่าย หรือให้บริการทั่วไป และมีวงเงินไม่เกินวงเงินที่กำหนดในกฎกระทรวง";
const ITEM_TYPES = ["material", "equipment", "service"];
const COMMITTEE_THRESHOLD = 100000; // เกินวงเงินนี้ต้องแต่งตั้งคณะกรรมการตรวจรับอย่างน้อย 3 คน
const DEPARTMENTS = {
  academic: "ฝ่ายบริหารงานวิชาการ", early_childhood: "ฝ่ายปฐมวัย (งานอนุบาล)", budget: "ฝ่ายบริหารงานงบประมาณ",
  personnel: "ฝ่ายบริหารงานบุคคล", general: "ฝ่ายบริหารงานทั่วไป",
};
const SCHOOL = "โรงเรียนบ้านป่าเด็ง";

const clean = (value, max = 1000) => String(value ?? "").trim().slice(0, max) || null;
const validDate = (v) => /^\d{4}-\d{2}-\d{2}$/.test(v || "") && !Number.isNaN(Date.parse(v)) && new Date(v).toISOString().slice(0, 10) === v;
const escapeHtml = (value) => String(value ?? "")
  .replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;");
const moneyText = (value) => Number(value || 0).toLocaleString("th-TH", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const thaiDate = (value) => value ? new Date(`${String(value).slice(0, 10)}T00:00:00`).toLocaleDateString("th-TH", { day: "numeric", month: "long", year: "numeric" }) : "";
function today() {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Bangkok", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
}
function addDays(date, days) {
  const d = new Date(`${date}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + days); return d.toISOString().slice(0, 10);
}

export async function ensureProcurementSchema(env) {
  if (ready.has(env.DB)) return;
  await env.DB.batch([
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS procurement_cases (
      id INTEGER PRIMARY KEY AUTOINCREMENT, case_no TEXT NOT NULL UNIQUE, fiscal_year INTEGER NOT NULL,
      expense_id INTEGER NOT NULL REFERENCES project_expenses(id), project_id INTEGER NOT NULL REFERENCES projects(id),
      procurement_type TEXT NOT NULL CHECK (procurement_type IN ('purchase','hire')),
      method TEXT NOT NULL DEFAULT 'specific', method_reason TEXT, subject TEXT NOT NULL, necessity TEXT,
      reference_price REAL, reference_source TEXT, delivery_days INTEGER, delivery_place TEXT,
      vendor_name TEXT, vendor_tax_id TEXT, vendor_address TEXT, vendor_phone TEXT, egp_project_no TEXT,
      total_amount REAL NOT NULL DEFAULT 0 CHECK (total_amount >= 0),
      status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','head_review','director_review','approved','ordered','accepted','cancelled')),
      review_note TEXT, report_no TEXT, report_date TEXT, committee_order_no TEXT,
      head_user_id INTEGER REFERENCES users(id), head_signed_at TEXT,
      director_user_id INTEGER REFERENCES users(id), approved_at TEXT,
      order_no TEXT, order_date TEXT, delivery_due_date TEXT, ordered_by INTEGER REFERENCES users(id),
      delivered_date TEXT, delivery_document_no TEXT, accepted_at TEXT,
      created_by INTEGER NOT NULL REFERENCES users(id),
      created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')))`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS procurement_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT, case_id INTEGER NOT NULL REFERENCES procurement_cases(id) ON DELETE CASCADE,
      line_no INTEGER NOT NULL, description TEXT NOT NULL,
      item_type TEXT NOT NULL DEFAULT 'material' CHECK (item_type IN ('material','equipment','service')),
      category TEXT, quantity REAL NOT NULL CHECK (quantity > 0), unit TEXT,
      unit_price REAL NOT NULL CHECK (unit_price >= 0), amount REAL NOT NULL CHECK (amount >= 0),
      UNIQUE(case_id, line_no))`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS procurement_inspectors (
      case_id INTEGER NOT NULL REFERENCES procurement_cases(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL REFERENCES users(id), sort_order INTEGER NOT NULL DEFAULT 0,
      position TEXT NOT NULL DEFAULT 'inspector' CHECK (position IN ('inspector','chair','member')),
      decision TEXT CHECK (decision IN ('accept','reject') OR decision IS NULL), decided_at TEXT, note TEXT,
      PRIMARY KEY(case_id, user_id))`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS procurement_postings (
      case_id INTEGER PRIMARY KEY REFERENCES procurement_cases(id), posted_by INTEGER NOT NULL REFERENCES users(id),
      posted_at TEXT NOT NULL DEFAULT (datetime('now')))`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS procurement_inventory_links (
      case_id INTEGER NOT NULL REFERENCES procurement_cases(id) ON DELETE CASCADE, line_no INTEGER NOT NULL,
      inventory_item_id INTEGER NOT NULL REFERENCES inventory_items(id), quantity REAL NOT NULL,
      PRIMARY KEY(case_id, line_no, inventory_item_id))`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS procurement_counters (
      kind TEXT NOT NULL, fiscal_year INTEGER NOT NULL, last_number INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(kind, fiscal_year))`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS procurement_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT, case_id INTEGER NOT NULL REFERENCES procurement_cases(id) ON DELETE CASCADE,
      action TEXT NOT NULL, note TEXT, actor_id INTEGER REFERENCES users(id), created_at TEXT NOT NULL DEFAULT (datetime('now')))`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS procurement_notifications (
      id INTEGER PRIMARY KEY AUTOINCREMENT, case_id INTEGER NOT NULL REFERENCES procurement_cases(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL REFERENCES users(id), message TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')), read_at TEXT)`),
    env.DB.prepare("CREATE UNIQUE INDEX IF NOT EXISTS idx_procurement_active_expense ON procurement_cases(expense_id) WHERE status<>'cancelled'"),
    env.DB.prepare("CREATE INDEX IF NOT EXISTS idx_procurement_cases_year ON procurement_cases(fiscal_year, status)"),
    env.DB.prepare("CREATE INDEX IF NOT EXISTS idx_procurement_items_case ON procurement_items(case_id, line_no)"),
    env.DB.prepare("CREATE INDEX IF NOT EXISTS idx_procurement_inspectors_user ON procurement_inspectors(user_id, decision)"),
    env.DB.prepare("CREATE INDEX IF NOT EXISTS idx_procurement_events_case ON procurement_events(case_id, id)"),
    env.DB.prepare("CREATE INDEX IF NOT EXISTS idx_procurement_notifications_user ON procurement_notifications(user_id, read_at)"),
  ]);
  // เลือกว่ารายการวัสดุนี้เข้าทะเบียนเดิมใด หรือสร้างใหม่ (auto = ชื่อและหน่วยตรงกันเป๊ะจึงรวมยอด)
  for (const [name, type] of [["inventory_match", "TEXT NOT NULL DEFAULT 'auto'"], ["inventory_item_id", "INTEGER REFERENCES inventory_items(id)"]]) {
    try { await env.DB.prepare(`ALTER TABLE procurement_items ADD COLUMN ${name} ${type}`).run(); }
    catch (error) { if (!String(error?.message || error).toLowerCase().includes("duplicate column")) throw error; }
  }
  ready.add(env.DB);
}

// ---------- ตรวจชื่อคล้ายกันในทะเบียนพัสดุ ----------
export function normalizeName(text) {
  return String(text || "").toLowerCase().normalize("NFC").replace(/[\s\-_.,/()\[\]"'`*+:;!?×x]+/g, "");
}
function bigrams(text) {
  const out = new Map();
  for (let i = 0; i < text.length - 1; i++) { const g = text.slice(i, i + 2); out.set(g, (out.get(g) || 0) + 1); }
  return out;
}
export function nameSimilarity(a, b) {
  const x = normalizeName(a), y = normalizeName(b);
  if (!x || !y) return 0;
  if (x === y) return 1;
  if (x.length < 2 || y.length < 2) return 0;
  const gx = bigrams(x), gy = bigrams(y);
  let overlap = 0;
  for (const [g, n] of gx) overlap += Math.min(n, gy.get(g) || 0);
  const dice = (2 * overlap) / (x.length - 1 + y.length - 1);
  const [short, long] = x.length <= y.length ? [x, y] : [y, x];
  const contained = long.includes(short) ? 0.55 + 0.45 * (short.length / long.length) : 0;
  return Math.round(Math.max(dice, contained) * 100) / 100;
}
const SIMILAR_THRESHOLD = 0.4;
async function materialRegister(env) {
  const { results } = await env.DB.prepare("SELECT id,item_code,name,unit,current_quantity FROM inventory_items WHERE item_type='material' AND status='active'").all().catch(() => ({ results: [] }));
  return results;
}
export function similarMaterials(register, description, unit) {
  const target = normalizeName(description);
  return register.map((r) => ({ ...r, score: nameSimilarity(description, r.name), exact: normalizeName(r.name) === target && String(r.unit || "") === String(unit || "") }))
    .filter((r) => r.score >= SIMILAR_THRESHOLD).sort((a, b) => Number(b.exact) - Number(a.exact) || b.score - a.score).slice(0, 5);
}

// รอง ผอ. (ตามตำแหน่งในทะเบียนบุคลากร หรือที่ตั้งในหน้าผู้อนุมัติ) ใช้เป็นผู้ตรวจรับเริ่มต้นร่วมกับเจ้าหน้าที่พัสดุ
async function deputyDirectorIds(env) {
  const byPosition = await env.DB.prepare(`SELECT DISTINCT a.user_id FROM personnel_records p JOIN personnel_accounts a ON a.personnel_id=p.id
    JOIN users u ON u.id=a.user_id WHERE p.status='active' AND u.status='active' AND u.deleted_at IS NULL AND REPLACE(COALESCE(p.position,''),' ','') LIKE '%รองผู้อำนวยการ%'`).all().catch(() => ({ results: [] }));
  if (byPosition.results.length) return byPosition.results.map((r) => Number(r.user_id));
  const { results } = await env.DB.prepare(`SELECT DISTINCT a.user_id FROM budget_role_assignments a JOIN users u ON u.id=a.user_id
    WHERE a.role_key='deputy_director' AND u.status='active'`).all().catch(() => ({ results: [] }));
  return results.map((r) => Number(r.user_id));
}

async function roleUser(env, roleKey) {
  const row = await env.DB.prepare(`SELECT a.user_id,u.full_name FROM budget_role_assignments a JOIN users u ON u.id=a.user_id
    WHERE a.role_key=? AND a.department='' AND u.status='active' AND u.deleted_at IS NULL`).bind(roleKey).first().catch(() => null);
  return row ? { id: Number(row.user_id), name: row.full_name } : null;
}

export async function isProcurementOfficer(env, user) {
  if (!user) return false;
  if (isAdmin(user)) return true;
  // เจ้าหน้าที่พัสดุ 1 และ 2 มีสิทธิ์เท่ากัน ทำแทนกันได้
  const officers = await Promise.all([roleUser(env, "procurement_officer"), roleUser(env, "procurement_officer_2")]);
  return officers.some((o) => Number(o?.id) === Number(user.id));
}

async function nextNumber(env, kind, year) {
  const row = await env.DB.prepare(`INSERT INTO procurement_counters(kind,fiscal_year,last_number) VALUES(?,?,1)
    ON CONFLICT(kind,fiscal_year) DO UPDATE SET last_number=last_number+1 RETURNING last_number`).bind(kind, year).first();
  return Number(row.last_number);
}

function notifyStatements(env, caseId, userIds, message, actorId) {
  const ids = [...new Set(userIds.map(Number).filter((id) => id && id !== Number(actorId)))];
  return ids.map((id) => env.DB.prepare("INSERT INTO procurement_notifications(case_id,user_id,message) VALUES(?,?,?)").bind(caseId, id, message));
}

function eventStatement(env, caseId, action, note, user) {
  return env.DB.prepare("INSERT INTO procurement_events(case_id,action,note,actor_id) VALUES(?,?,?,?)").bind(caseId, action, note || null, user.id);
}

function auditStatement(env, user, action, caseId, details, request) {
  return env.DB.prepare(`INSERT INTO audit_logs(user_id,action,resource,resource_id,details,ip_address) VALUES(?,?,?,?,?,?)`)
    .bind(user.id, action, "procurement_case", caseId, JSON.stringify(details || {}), request?.headers?.get("CF-Connecting-IP") || null);
}

async function financeUserIds(env) {
  const { results } = await env.DB.prepare(`SELECT DISTINCT user_id FROM budget_role_assignments WHERE role_key IN ${FINANCE_ROLE_SQL} AND department=''`).all();
  return results.map((r) => Number(r.user_id));
}

async function ownerIds(env, projectId) {
  const { results } = await env.DB.prepare("SELECT user_id FROM project_owners WHERE project_id=?").bind(projectId).all();
  return results.map((r) => Number(r.user_id));
}

function normalizeItems(items) {
  if (!Array.isArray(items) || !items.length || items.length > 100) return { error: "กรุณาระบุรายการพัสดุ 1–100 รายการ" };
  const rows = [];
  for (const [index, raw] of items.entries()) {
    const description = clean(raw?.description, 500), quantity = Number(raw?.quantity), unitPrice = Number(raw?.unit_price);
    const amount = multiplyMoney(quantity, unitPrice);
    if (!description) return { error: `กรุณาระบุรายละเอียดรายการที่ ${index + 1}` };
    if (!Number.isFinite(quantity) || quantity <= 0) return { error: `จำนวนรายการที่ ${index + 1} ต้องมากกว่า 0` };
    if (!Number.isFinite(unitPrice) || unitPrice < 0 || !Number.isFinite(amount)) return { error: `ราคาต่อหน่วยรายการที่ ${index + 1} ไม่ถูกต้อง` };
    const itemType = ITEM_TYPES.includes(raw.item_type) ? raw.item_type : "material";
    const match = itemType === "material" && ["new", "item"].includes(raw.inventory_match) ? raw.inventory_match : "auto";
    const matchId = match === "item" ? Number(raw.inventory_item_id) : null;
    if (match === "item" && !(Number.isInteger(matchId) && matchId > 0)) return { error: `กรุณาเลือกทะเบียนพัสดุของรายการที่ ${index + 1}` };
    rows.push({ line_no: index + 1, description, item_type: itemType, category: clean(raw.category, 120), quantity,
      unit: clean(raw.unit, 60) || "ชิ้น", unit_price: money(unitPrice), amount, inventory_match: match, inventory_item_id: matchId });
  }
  const total = sumMoney(rows.map((r) => r.amount));
  if (!(total > 0)) return { error: "ยอดรวมต้องมากกว่า 0 บาท" };
  return { items: rows, total };
}

function normalizeInspectors(list) {
  if (!Array.isArray(list)) return [];
  const seen = new Set(), rows = [];
  for (const raw of list) {
    const id = Number(raw?.user_id ?? raw);
    if (!Number.isInteger(id) || id <= 0 || seen.has(id)) continue;
    seen.add(id); rows.push(id);
  }
  return rows.slice(0, 9);
}

function inspectorRuleError(total, count) {
  if (!count) return "กรุณาเลือกผู้ตรวจรับพัสดุอย่างน้อย 1 คน";
  if (total > COMMITTEE_THRESHOLD && count < 3) return `วงเงินเกิน ${COMMITTEE_THRESHOLD.toLocaleString("th-TH")} บาท ต้องแต่งตั้งคณะกรรมการตรวจรับพัสดุอย่างน้อย 3 คน`;
  return null;
}

async function loadExpense(env, expenseId) {
  return env.DB.prepare(`SELECT e.*,p.name project_name,p.department project_department,p.management_area,
      COALESCE(p.management_area,p.department) department,p.funding_type,u.full_name requester_name
    FROM project_expenses e JOIN projects p ON p.id=e.project_id LEFT JOIN users u ON u.id=e.created_by
    WHERE e.id=?`).bind(expenseId).first();
}

const expenseOpen = (e) => e && e.workflow_version === 2 && e.status === "pending" && ["finance_queue", "finance_processing"].includes(e.current_step);

async function loadCase(env, id) {
  return env.DB.prepare(`SELECT c.*,p.name project_name,COALESCE(p.management_area,p.department) department,p.funding_type,
      e.request_no,e.amount expense_amount,e.status expense_status,e.current_step expense_step,e.created_by expense_created_by,
      creator.full_name creator_name,head.full_name head_name,director.full_name director_name
    FROM procurement_cases c JOIN projects p ON p.id=c.project_id JOIN project_expenses e ON e.id=c.expense_id
    LEFT JOIN users creator ON creator.id=c.created_by LEFT JOIN users head ON head.id=c.head_user_id
    LEFT JOIN users director ON director.id=c.director_user_id WHERE c.id=?`).bind(id).first();
}

async function caseDetail(env, row) {
  const [{ results: items }, { results: inspectors }, { results: events }, { results: links }] = await Promise.all([
    env.DB.prepare(`SELECT p.*,i.item_code match_code,i.name match_name,i.unit match_unit FROM procurement_items p
      LEFT JOIN inventory_items i ON i.id=p.inventory_item_id WHERE p.case_id=? ORDER BY p.line_no`).bind(row.id).all(),
    env.DB.prepare(`SELECT i.*,u.full_name FROM procurement_inspectors i JOIN users u ON u.id=i.user_id WHERE i.case_id=? ORDER BY i.sort_order,i.user_id`).bind(row.id).all(),
    env.DB.prepare(`SELECT v.*,u.full_name actor_name FROM procurement_events v LEFT JOIN users u ON u.id=v.actor_id WHERE v.case_id=? ORDER BY v.id`).bind(row.id).all(),
    env.DB.prepare(`SELECT l.*,i.item_code,i.name FROM procurement_inventory_links l JOIN inventory_items i ON i.id=l.inventory_item_id WHERE l.case_id=? ORDER BY l.line_no,i.item_code`).bind(row.id).all().catch(() => ({ results: [] })),
  ]);
  return { ...row, items, inspectors, events, inventory_links: links };
}

async function canViewCase(env, user, row) {
  if (await isProcurementOfficer(env, user) || await canManageProjectFinance(env, user)) return true;
  if ((await budgetDirectorIds(env)).includes(Number(user.id))) return true;
  if ([row.created_by, row.head_user_id, row.expense_created_by].map(Number).includes(Number(user.id))) return true;
  if (await env.DB.prepare("SELECT 1 FROM procurement_inspectors WHERE case_id=? AND user_id=?").bind(row.id, user.id).first()) return true;
  return Boolean(await env.DB.prepare("SELECT 1 FROM project_owners WHERE project_id=? AND user_id=?").bind(row.project_id, user.id).first());
}

async function permissionsFor(env, user, row, ctx) {
  const officer = ctx.officer, director = ctx.director, head = ctx.head;
  const isCreator = Number(row.created_by) === Number(user.id);
  const myInspection = row.inspectors?.find((i) => Number(i.user_id) === Number(user.id));
  const allAccepted = row.inspectors?.length && row.inspectors.every((i) => i.decision === "accept");
  return {
    can_edit: officer && row.status === "draft",
    can_submit: officer && row.status === "draft",
    can_head_approve: row.status === "head_review" && Number(row.head_user_id) === Number(user.id),
    can_director_approve: row.status === "director_review" && director && !isCreator,
    can_return: (row.status === "head_review" && Number(row.head_user_id) === Number(user.id)) || (row.status === "director_review" && director && !isCreator),
    can_order: officer && row.status === "approved",
    can_record_delivery: officer && row.status === "ordered",
    can_inspect: row.status === "ordered" && Boolean(row.delivered_date) && Boolean(myInspection) && myInspection.decision !== "accept",
    can_post_inventory: officer && row.status === "ordered" && Boolean(allAccepted),
    can_set_numbers: officer && !["accepted", "cancelled"].includes(row.status),
    can_cancel: officer && !["accepted", "cancelled"].includes(row.status),
    is_head: Boolean(head && Number(head.id) === Number(user.id)),
  };
}

async function context(env, user) {
  const [officer, finance, directors, head] = await Promise.all([
    isProcurementOfficer(env, user), canManageProjectFinance(env, user), budgetDirectorIds(env), roleUser(env, "procurement_head"),
  ]);
  return { officer, finance, director: directors.includes(Number(user.id)), directors, head };
}

async function overview(request, env, user) {
  const url = new URL(request.url), year = Number(url.searchParams.get("fiscal_year")) || null;
  const ctx = await context(env, user);
  // mine=1: หน้าติดตามของผู้ขอ (ระบบสนับสนุน) — แสดงเฉพาะงานที่เกี่ยวข้องกับตนเอง แม้เป็นเจ้าหน้าที่
  const wide = (ctx.officer || ctx.finance || ctx.director) && url.searchParams.get("mine") !== "1";
  const filters = [], values = [];
  if (year) { filters.push("c.fiscal_year=?"); values.push(year); }
  if (!wide) {
    filters.push(`(c.created_by=? OR c.head_user_id=? OR e.created_by=? OR EXISTS(SELECT 1 FROM procurement_inspectors i WHERE i.case_id=c.id AND i.user_id=?)
      OR EXISTS(SELECT 1 FROM project_owners o WHERE o.project_id=c.project_id AND o.user_id=?))`);
    values.push(user.id, user.id, user.id, user.id, user.id);
  }
  const { results: cases } = await env.DB.prepare(`SELECT c.id,c.case_no,c.fiscal_year,c.expense_id,c.project_id,c.procurement_type,c.method,c.subject,
      c.vendor_name,c.total_amount,c.status,c.review_note,c.order_no,c.delivery_due_date,c.delivered_date,c.created_at,c.updated_at,c.created_by,c.head_user_id,
      p.name project_name,COALESCE(p.management_area,p.department) department,e.request_no,
      (SELECT COUNT(*) FROM procurement_inspectors i WHERE i.case_id=c.id) inspector_count,
      (SELECT COUNT(*) FROM procurement_inspectors i WHERE i.case_id=c.id AND i.decision='accept') accepted_count,
      EXISTS(SELECT 1 FROM procurement_inspectors i WHERE i.case_id=c.id AND i.user_id=? AND (i.decision IS NULL OR i.decision='reject')) my_inspection_pending
    FROM procurement_cases c JOIN projects p ON p.id=c.project_id JOIN project_expenses e ON e.id=c.expense_id
    ${filters.length ? "WHERE " + filters.join(" AND ") : ""}
    ORDER BY CASE c.status WHEN 'director_review' THEN 0 WHEN 'head_review' THEN 1 WHEN 'ordered' THEN 2 WHEN 'approved' THEN 3 WHEN 'draft' THEN 4 ELSE 5 END,
      c.updated_at DESC,c.id DESC`).bind(user.id, ...values).all();
  let eligible = [];
  if (ctx.officer && wide) {
    const { results } = await env.DB.prepare(`SELECT e.id,e.request_no,e.amount,e.request_purpose,e.needed_date,e.current_step,e.priority,e.fiscal_year,
        p.id project_id,p.name project_name,COALESCE(p.management_area,p.department) department,u.full_name requester_name
      FROM project_expenses e JOIN projects p ON p.id=e.project_id LEFT JOIN users u ON u.id=e.created_by
      WHERE e.workflow_version=2 AND e.status='pending' AND e.current_step IN ('finance_queue','finance_processing')
        AND NOT EXISTS(SELECT 1 FROM procurement_cases c WHERE c.expense_id=e.id AND c.status<>'cancelled')
      ORDER BY CASE e.priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 ELSE 2 END,COALESCE(e.needed_date,'9999-12-31'),e.id`).all();
    eligible = results;
  }
  const officerUser = await roleUser(env, "procurement_officer");
  const officerUser2 = await roleUser(env, "procurement_officer_2");
  const { results: people } = ctx.officer ? await env.DB.prepare(`SELECT id,full_name FROM users WHERE status='active' AND role IS NOT NULL AND deleted_at IS NULL ORDER BY full_name`).all() : { results: [] };
  return jsonResponse({
    cases: cases.map((c) => ({ ...c, total_amount: money(c.total_amount), my_inspection_pending: Boolean(c.my_inspection_pending) && c.status === "ordered" && Boolean(c.delivered_date) })),
    eligible_expenses: eligible.map((e) => ({ ...e, amount: money(e.amount) })),
    users: people,
    roles: { procurement_officer: officerUser || officerUser2, procurement_officer_2: officerUser2, procurement_head: ctx.head },
    default_inspectors: [...new Set([officerUser?.id, officerUser2?.id, ...(await deputyDirectorIds(env))].filter(Boolean).map(Number))],
    methods: PROCUREMENT_METHODS, statuses: STATUS_LABELS, committee_threshold: COMMITTEE_THRESHOLD,
    permissions: { can_create: ctx.officer, is_officer: ctx.officer, is_director: ctx.director, is_finance: ctx.finance },
  });
}

async function expenseForCreate(request, env, user) {
  if (!await isProcurementOfficer(env, user)) return jsonResponse({ error: "เฉพาะเจ้าหน้าที่พัสดุหรือผู้บริหาร" }, 403);
  const id = Number(new URL(request.url).searchParams.get("expense_id"));
  const expense = await loadExpense(env, id);
  if (!expense) return jsonResponse({ error: "ไม่พบคำขอเบิกจ่าย" }, 404);
  const { results: items } = await env.DB.prepare("SELECT * FROM budget_request_items WHERE expense_id=? ORDER BY line_no").bind(id).all();
  return jsonResponse({ expense: { ...expense, amount: money(expense.amount), open: expenseOpen(expense) }, items });
}

function parseCaseBody(body) {
  if (!body) return { error: "รูปแบบข้อมูลไม่ถูกต้อง" };
  const subject = clean(body.subject, 300);
  if (!subject) return { error: "กรุณาระบุเรื่องที่จัดซื้อ/จัดจ้าง" };
  if (body.report_date && !validDate(body.report_date)) return { error: "วันที่รายงานไม่ถูกต้อง" };
  const parsed = normalizeItems(body.items);
  if (parsed.error) return parsed;
  const reference = body.reference_price === "" || body.reference_price == null ? null : money(body.reference_price);
  if (reference != null && (!Number.isFinite(reference) || reference < 0)) return { error: "ราคากลาง/ราคาอ้างอิงไม่ถูกต้อง" };
  const days = body.delivery_days === "" || body.delivery_days == null ? null : Number(body.delivery_days);
  if (days != null && (!Number.isInteger(days) || days < 0 || days > 3650)) return { error: "กำหนดส่งมอบ (วัน) ไม่ถูกต้อง" };
  return {
    fields: {
      procurement_type: body.procurement_type === "hire" ? "hire" : "purchase",
      method: PROCUREMENT_METHODS[body.method] ? body.method : "specific",
      method_reason: clean(body.method_reason, 1500) || (!PROCUREMENT_METHODS[body.method] || body.method === "specific" ? DEFAULT_SPECIFIC_REASON : null), subject, necessity: clean(body.necessity, 2000),
      reference_price: reference, reference_source: clean(body.reference_source, 500),
      delivery_days: days, delivery_place: clean(body.delivery_place, 300),
      vendor_name: clean(body.vendor_name, 250), vendor_tax_id: clean(body.vendor_tax_id, 20),
      vendor_address: clean(body.vendor_address, 500), vendor_phone: clean(body.vendor_phone, 60),
      egp_project_no: clean(body.egp_project_no, 60), report_no: clean(body.report_no, 60),
      report_date: body.report_date || null, committee_order_no: clean(body.committee_order_no, 60),
    },
    items: parsed.items, total: parsed.total, inspectors: normalizeInspectors(body.inspectors),
  };
}

async function matchError(env, items) {
  const ids = [...new Set(items.filter((i) => i.inventory_match === "item").map((i) => i.inventory_item_id))];
  if (!ids.length) return null;
  const { results } = await env.DB.prepare(`SELECT id FROM inventory_items WHERE item_type='material' AND status='active' AND id IN (${ids.map(() => "?").join(",")})`).bind(...ids).all();
  return results.length === ids.length ? null : "ทะเบียนพัสดุที่เลือกจับคู่ไม่มีแล้วหรือไม่ใช่วัสดุที่ใช้งานอยู่ กรุณาเลือกใหม่";
}

async function validInspectors(env, ids) {
  if (!ids.length) return true;
  const { results } = await env.DB.prepare(`SELECT id FROM users WHERE status='active' AND role IS NOT NULL AND deleted_at IS NULL AND id IN (${ids.map(() => "?").join(",")})`).bind(...ids).all();
  return results.length === ids.length;
}

function inspectorStatements(env, caseId, ids) {
  const committee = ids.length >= 3;
  return [env.DB.prepare("DELETE FROM procurement_inspectors WHERE case_id=?").bind(caseId),
    ...ids.map((id, index) => env.DB.prepare("INSERT INTO procurement_inspectors(case_id,user_id,sort_order,position) VALUES(?,?,?,?)")
      .bind(caseId, id, index, committee ? (index === 0 ? "chair" : "member") : "inspector"))];
}

function itemStatements(env, caseId, items) {
  return [env.DB.prepare("DELETE FROM procurement_items WHERE case_id=?").bind(caseId),
    ...items.map((i) => env.DB.prepare(`INSERT INTO procurement_items(case_id,line_no,description,item_type,category,quantity,unit,unit_price,amount,inventory_match,inventory_item_id)
      VALUES(?,?,?,?,?,?,?,?,?,?,?)`).bind(caseId, i.line_no, i.description, i.item_type, i.category, i.quantity, i.unit, i.unit_price, i.amount, i.inventory_match, i.inventory_item_id))];
}

async function createCase(request, env, user) {
  if (!await isProcurementOfficer(env, user)) return jsonResponse({ error: "เฉพาะเจ้าหน้าที่พัสดุหรือผู้บริหาร" }, 403);
  const body = await request.json().catch(() => null), parsed = parseCaseBody(body);
  if (parsed.error) return jsonResponse({ error: parsed.error }, 400);
  const expense = await loadExpense(env, Number(body.expense_id));
  if (!expense) return jsonResponse({ error: "ไม่พบคำขอเบิกจ่าย" }, 404);
  if (!expenseOpen(expense)) return jsonResponse({ error: "เริ่มจัดซื้อจัดจ้างได้เฉพาะคำขอที่ส่งถึงฝ่ายงบประมาณแล้วและยังไม่เสนออนุมัติเบิกจ่าย" }, 409);
  if (parsed.total > money(expense.amount) + 0.000001) return jsonResponse({ error: `ยอดจัดซื้อ ${moneyText(parsed.total)} บาท เกินยอดคำขอเบิก ${moneyText(expense.amount)} บาท` }, 409);
  if (!await validInspectors(env, parsed.inspectors)) return jsonResponse({ error: "พบผู้ตรวจรับที่ไม่ใช่บัญชีที่ใช้งานอยู่" }, 400);
  const badMatch = await matchError(env, parsed.items);
  if (badMatch) return jsonResponse({ error: badMatch }, 400);
  const year = Number(expense.fiscal_year);
  const caseNo = `PRC-${year}-${String(await nextNumber(env, "case", year)).padStart(4, "0")}`;
  const f = parsed.fields;
  let result;
  try {
    result = await env.DB.prepare(`INSERT INTO procurement_cases(case_no,fiscal_year,expense_id,project_id,procurement_type,method,method_reason,subject,necessity,
      reference_price,reference_source,delivery_days,delivery_place,vendor_name,vendor_tax_id,vendor_address,vendor_phone,egp_project_no,
      report_no,report_date,committee_order_no,total_amount,created_by) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .bind(caseNo, year, expense.id, expense.project_id, f.procurement_type, f.method, f.method_reason, f.subject, f.necessity,
        f.reference_price, f.reference_source, f.delivery_days, f.delivery_place, f.vendor_name, f.vendor_tax_id, f.vendor_address,
        f.vendor_phone, f.egp_project_no, f.report_no, f.report_date || today(), f.committee_order_no, parsed.total, user.id).run();
  } catch (error) {
    if (String(error?.message || error).includes("UNIQUE")) return jsonResponse({ error: "คำขอนี้มีงานจัดซื้อจัดจ้างอยู่แล้ว" }, 409);
    throw error;
  }
  const caseId = result.meta.last_row_id;
  await env.DB.batch([...itemStatements(env, caseId, parsed.items), ...inspectorStatements(env, caseId, parsed.inspectors),
    eventStatement(env, caseId, "create", `เริ่มงานจัดซื้อจัดจ้างจากคำขอ ${expense.request_no || ""}`, user),
    auditStatement(env, user, "create", caseId, { case_no: caseNo, expense_id: expense.id, total: parsed.total }, request)]);
  return jsonResponse({ id: caseId, case_no: caseNo }, 201);
}

async function updateCase(request, env, user, id) {
  if (!await isProcurementOfficer(env, user)) return jsonResponse({ error: "เฉพาะเจ้าหน้าที่พัสดุหรือผู้บริหาร" }, 403);
  const row = await loadCase(env, id);
  if (!row) return jsonResponse({ error: "ไม่พบงานจัดซื้อจัดจ้าง" }, 404);
  if (row.status !== "draft") return jsonResponse({ error: "แก้ไขได้เฉพาะร่างหรือรายการที่ถูกส่งกลับ" }, 409);
  const body = await request.json().catch(() => null), parsed = parseCaseBody(body);
  if (parsed.error) return jsonResponse({ error: parsed.error }, 400);
  if (parsed.total > money(row.expense_amount) + 0.000001) return jsonResponse({ error: `ยอดจัดซื้อ ${moneyText(parsed.total)} บาท เกินยอดคำขอเบิก ${moneyText(row.expense_amount)} บาท` }, 409);
  if (!await validInspectors(env, parsed.inspectors)) return jsonResponse({ error: "พบผู้ตรวจรับที่ไม่ใช่บัญชีที่ใช้งานอยู่" }, 400);
  const badMatch = await matchError(env, parsed.items);
  if (badMatch) return jsonResponse({ error: badMatch }, 400);
  const f = parsed.fields;
  const results = await env.DB.batch([
    env.DB.prepare(`UPDATE procurement_cases SET procurement_type=?,method=?,method_reason=?,subject=?,necessity=?,reference_price=?,reference_source=?,
      delivery_days=?,delivery_place=?,vendor_name=?,vendor_tax_id=?,vendor_address=?,vendor_phone=?,egp_project_no=?,report_no=?,report_date=COALESCE(?,report_date),
      committee_order_no=?,total_amount=?,updated_at=datetime('now') WHERE id=? AND status='draft'`)
      .bind(f.procurement_type, f.method, f.method_reason, f.subject, f.necessity, f.reference_price, f.reference_source, f.delivery_days,
        f.delivery_place, f.vendor_name, f.vendor_tax_id, f.vendor_address, f.vendor_phone, f.egp_project_no, f.report_no, f.report_date,
        f.committee_order_no, parsed.total, id),
    ...itemStatements(env, id, parsed.items), ...inspectorStatements(env, id, parsed.inspectors),
    eventStatement(env, id, "update", "แก้ไขรายละเอียด", user),
  ]);
  if (!results[0].meta.changes) return jsonResponse({ error: "สถานะเปลี่ยนแล้ว กรุณาโหลดใหม่" }, 409);
  return jsonResponse({ ok: true });
}

async function submitReadiness(env, row) {
  const items = await env.DB.prepare("SELECT COUNT(*) n,ROUND(SUM(amount),2) total FROM procurement_items WHERE case_id=?").bind(row.id).first();
  if (!Number(items?.n)) return "กรุณาเพิ่มรายการพัสดุ";
  if (money(items.total) !== money(row.total_amount)) return "ยอดรวมรายการไม่ตรงกับยอดจัดซื้อ กรุณาบันทึกใหม่";
  if (money(row.total_amount) > money(row.expense_amount) + 0.000001) return "ยอดจัดซื้อเกินยอดคำขอเบิก";
  if (!row.vendor_name) return "กรุณาระบุผู้ขาย/ผู้รับจ้าง";
  if (!row.necessity) return "กรุณาระบุเหตุผลและความจำเป็น";
  const count = await env.DB.prepare("SELECT COUNT(*) n FROM procurement_inspectors WHERE case_id=?").bind(row.id).first();
  const rule = inspectorRuleError(money(row.total_amount), Number(count?.n || 0));
  if (rule) return rule;
  const { results: auto } = await env.DB.prepare("SELECT line_no,description,unit FROM procurement_items WHERE case_id=? AND item_type='material' AND COALESCE(inventory_match,'auto')='auto' ORDER BY line_no").bind(row.id).all();
  if (auto.length) {
    const register = await materialRegister(env);
    for (const item of auto) {
      const similar = similarMaterials(register, item.description, item.unit);
      if (similar.length && !similar.some((r) => r.exact)) return `รายการที่ ${item.line_no} "${item.description}" คล้ายกับทะเบียนพัสดุเดิม กรุณาเลือกว่าเป็นรายการเดียวกันหรือสร้างทะเบียนใหม่`;
    }
  }
  return null;
}

const ORDER_PREFIX = { purchase: "PO", hire: "WO" };

// สร้างทะเบียนพัสดุจากรายการที่ตรวจรับแล้ว (วัสดุรวมยอดกับรายการเดิมที่ชื่อ/หน่วยตรงกัน ครุภัณฑ์แยกทีละหน่วย)
async function inventoryStatements(env, user, row, items) {
  const statements = [], funding = PROJECT_FUNDING_TYPES[row.funding_type] || null;
  const project = await env.DB.prepare("SELECT department,management_area FROM projects WHERE id=?").bind(row.project_id).first();
  const date = row.delivered_date || today(), note = `รับจากการจัดซื้อจัดจ้าง ${row.case_no}`;
  const newItem = (code, item, quantity) => {
    statements.push(env.DB.prepare(`INSERT INTO inventory_items(item_code,name,item_type,category,unit,department,management_area,location,
        unit_price,purchase_date,fiscal_year,budget_source,vendor,item_condition,status,notes,created_by)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,'good','active',?,?)`).bind(code, item.description, item.item_type, item.category, item.unit,
      project?.department || "budget", project?.management_area || null, row.delivery_place, item.unit_price, date, String(row.fiscal_year),
      funding, row.vendor_name, note, user.id));
    statements.push(receive(`(SELECT id FROM inventory_items WHERE item_code=?)`, [code], item, quantity));
    statements.push(env.DB.prepare(`INSERT INTO procurement_inventory_links(case_id,line_no,inventory_item_id,quantity)
      SELECT ?,?,id,? FROM inventory_items WHERE item_code=?`).bind(row.id, item.line_no, quantity, code));
  };
  const receive = (idSql, idArgs, item, quantity) => env.DB.prepare(`INSERT INTO inventory_transactions(item_id,transaction_type,transaction_date,document_no,
      quantity,quantity_change,unit_price,to_location,notes,created_by) VALUES(${idSql},'receive',?,?,?,?,?,?,?,?)`)
    .bind(...idArgs, date, row.order_no || row.case_no, quantity, quantity, item.unit_price, row.delivery_place, note, user.id);
  const used = new Set();
  const code = async (kind) => {
    for (;;) {
      const value = `${kind === "equipment" ? "EQP" : "MAT"}-${row.fiscal_year}-${String(await nextNumber(env, kind === "equipment" ? "equipment" : "material", row.fiscal_year)).padStart(4, "0")}`;
      if (used.has(value)) continue;
      if (!await env.DB.prepare("SELECT 1 FROM inventory_items WHERE item_code=?").bind(value).first()) { used.add(value); return value; }
    }
  };
  for (const item of items) {
    if (item.item_type === "service") continue;
    if (item.item_type === "material") {
      const chosen = item.inventory_match === "item" && item.inventory_item_id
        ? await env.DB.prepare("SELECT id FROM inventory_items WHERE id=? AND item_type='material' AND status='active'").bind(item.inventory_item_id).first() : null;
      const existing = chosen || (item.inventory_match === "new" ? null : await env.DB.prepare(`SELECT id FROM inventory_items WHERE item_type='material' AND status='active' AND TRIM(name)=? AND COALESCE(unit,'')=? ORDER BY id LIMIT 1`)
        .bind(item.description.trim(), item.unit || "").first());
      if (existing) {
        statements.push(receive("?", [existing.id], item, item.quantity));
        statements.push(env.DB.prepare("INSERT OR IGNORE INTO procurement_inventory_links(case_id,line_no,inventory_item_id,quantity) VALUES(?,?,?,?)").bind(row.id, item.line_no, existing.id, item.quantity));
      } else newItem(await code("material"), item, item.quantity);
    } else if (Number.isInteger(item.quantity) && item.quantity <= 100) {
      for (let n = 0; n < item.quantity; n++) newItem(await code("equipment"), item, 1);
    } else newItem(await code("equipment"), item, item.quantity);
  }
  return statements;
}

async function postInventory(env, user, row, request) {
  const { results: items } = await env.DB.prepare("SELECT * FROM procurement_items WHERE case_id=? ORDER BY line_no").bind(row.id).all();
  const stock = await inventoryStatements(env, user, row, items);
  const recipients = [row.created_by, ...(await financeUserIds(env)), ...(await ownerIds(env, row.project_id)), row.expense_created_by];
  try {
    await env.DB.batch([
      // posted_by เป็น NULL (ล้มทั้งชุด) เมื่อรายการไม่ได้อยู่ในสถานะรอตรวจรับ; case_id ซ้ำ = นำเข้าไปแล้ว
      env.DB.prepare(`INSERT INTO procurement_postings(case_id,posted_by)
        VALUES(?,(SELECT ? WHERE EXISTS(SELECT 1 FROM procurement_cases WHERE id=? AND status='ordered')))`).bind(row.id, user.id, row.id),
      env.DB.prepare("UPDATE procurement_cases SET status='accepted',accepted_at=datetime('now'),updated_at=datetime('now') WHERE id=? AND status='ordered'").bind(row.id),
      ...stock,
      eventStatement(env, row.id, "accepted", stock.length ? "ตรวจรับครบแล้ว นำเข้าทะเบียนพัสดุเรียบร้อย" : "ตรวจรับครบแล้ว (งานจ้าง/บริการ ไม่มีพัสดุเข้าทะเบียน)", user),
      auditStatement(env, user, "accepted", row.id, { case_no: row.case_no }, request),
      ...notifyStatements(env, row.id, recipients, money(row.total_amount) < money(row.expense_amount)
        ? `ตรวจรับพัสดุครบแล้ว (${row.case_no}) ยอดจริง ${moneyText(row.total_amount)} บาท น้อยกว่ายอดขอ ${moneyText(row.expense_amount)} บาท เจ้าของโครงการกรุณาปิดยอดในหน้าเอกสารโครงการ`
        : `ตรวจรับพัสดุครบแล้ว (${row.case_no}) ฝ่ายการเงินดำเนินการเบิกจ่ายต่อได้`, 0),
    ]);
    return { ok: true };
  } catch (error) {
    const message = String(error?.message || error);
    if (message.includes("UNIQUE") || message.includes("NOT NULL")) return { ok: true, already: true };
    throw error;
  }
}

async function action(request, env, user, id) {
  const body = await request.json().catch(() => null), kind = body?.action;
  const row = await loadCase(env, id);
  if (!row) return jsonResponse({ error: "ไม่พบงานจัดซื้อจัดจ้าง" }, 404);
  const ctx = await context(env, user);
  const note = clean(body?.note, 1500);
  const change = async (sql, args, eventAction, eventNote, recipients = [], message = "") => {
    const results = await env.DB.batch([env.DB.prepare(sql).bind(...args), eventStatement(env, id, eventAction, eventNote, user),
      auditStatement(env, user, eventAction, id, { case_no: row.case_no, note: eventNote }, request),
      ...notifyStatements(env, id, recipients, message || eventNote, user.id)]);
    if (!results[0].meta.changes) return jsonResponse({ error: "สถานะเปลี่ยนแล้ว กรุณาโหลดใหม่" }, 409);
    return jsonResponse({ ok: true });
  };
  if (kind === "submit") {
    if (!ctx.officer) return jsonResponse({ error: "เฉพาะเจ้าหน้าที่พัสดุ" }, 403);
    if (row.status !== "draft") return jsonResponse({ error: "รายการนี้ส่งแล้ว" }, 409);
    const expense = await loadExpense(env, row.expense_id);
    if (!expenseOpen(expense)) return jsonResponse({ error: "คำขอเบิกจ่ายที่ผูกไว้ไม่อยู่ในขั้นดำเนินการของฝ่ายงบประมาณแล้ว" }, 409);
    const problem = await submitReadiness(env, row);
    if (problem) return jsonResponse({ error: problem }, 409);
    const head = ctx.head && Number(ctx.head.id) !== Number(user.id) ? ctx.head : null;
    if (!head && !ctx.directors.length) return jsonResponse({ error: "ยังไม่มีบัญชีผู้อำนวยการสำหรับอนุมัติ กรุณาตั้งหน้าที่ \"ผู้อำนวยการ\" ในหน้าตั้งค่าผู้อนุมัติ" }, 409);
    const next = head ? "head_review" : "director_review";
    return change(`UPDATE procurement_cases SET status=?,head_user_id=?,head_signed_at=NULL,review_note=NULL,updated_at=datetime('now') WHERE id=? AND status='draft'`,
      [next, head ? head.id : null, id], "submit", head ? "ส่งรายงานขอซื้อ/ขอจ้าง ให้หัวหน้าเจ้าหน้าที่เห็นชอบ" : "ส่งรายงานขอซื้อ/ขอจ้าง เสนอผู้อำนวยการ",
      head ? [head.id] : ctx.directors, `มีรายงานขอซื้อ/ขอจ้างรอพิจารณา: ${row.subject}`);
  }
  if (kind === "head_approve") {
    if (row.status !== "head_review" || Number(row.head_user_id) !== Number(user.id)) return jsonResponse({ error: "เฉพาะหัวหน้าเจ้าหน้าที่ที่ได้รับมอบหมาย" }, 403);
    if (!ctx.directors.length) return jsonResponse({ error: "ยังไม่มีบัญชีผู้อำนวยการสำหรับอนุมัติ" }, 409);
    return change("UPDATE procurement_cases SET status='director_review',head_signed_at=datetime('now'),updated_at=datetime('now') WHERE id=? AND status='head_review'",
      [id], "head_approve", note ? `หัวหน้าเจ้าหน้าที่เห็นชอบ: ${note}` : "หัวหน้าเจ้าหน้าที่เห็นชอบ เสนอผู้อำนวยการ", ctx.directors, `มีรายงานขอซื้อ/ขอจ้างรออนุมัติ: ${row.subject}`);
  }
  if (kind === "approve") {
    if (row.status !== "director_review") return jsonResponse({ error: "รายการนี้ไม่ได้รอผู้อำนวยการอนุมัติ" }, 409);
    if (!ctx.director) return jsonResponse({ error: "เฉพาะผู้อำนวยการเท่านั้นที่อนุมัติได้" }, 403);
    if (Number(row.created_by) === Number(user.id)) return jsonResponse({ error: "อนุมัติรายงานที่ตนเองจัดทำไม่ได้" }, 403);
    const expense = await loadExpense(env, row.expense_id);
    if (!expenseOpen(expense)) return jsonResponse({ error: "คำขอเบิกจ่ายที่ผูกไว้ถูกส่งกลับหรือยกเลิกแล้ว" }, 409);
    const { results: inspectors } = await env.DB.prepare("SELECT user_id FROM procurement_inspectors WHERE case_id=?").bind(id).all();
    return change("UPDATE procurement_cases SET status='approved',director_user_id=?,approved_at=datetime('now'),updated_at=datetime('now') WHERE id=? AND status='director_review'",
      [user.id, id], "approve", note ? `ผู้อำนวยการอนุมัติและแต่งตั้งผู้ตรวจรับ: ${note}` : "ผู้อำนวยการอนุมัติและแต่งตั้งผู้ตรวจรับพัสดุ",
      [row.created_by, ...inspectors.map((i) => i.user_id)], `ผู้อำนวยการอนุมัติจัดซื้อ/จัดจ้าง ${row.case_no} และแต่งตั้งท่านเป็นผู้ตรวจรับ`);
  }
  if (kind === "return") {
    const allowed = (row.status === "head_review" && Number(row.head_user_id) === Number(user.id)) || (row.status === "director_review" && ctx.director && Number(row.created_by) !== Number(user.id));
    if (!allowed) return jsonResponse({ error: "ไม่มีสิทธิ์ส่งกลับรายการนี้" }, 403);
    if (!note) return jsonResponse({ error: "กรุณาระบุเหตุผลที่ส่งกลับ" }, 400);
    return change("UPDATE procurement_cases SET status='draft',review_note=?,updated_at=datetime('now') WHERE id=? AND status=?",
      [note, id, row.status], "return", `ส่งกลับให้แก้ไข: ${note}`, [row.created_by]);
  }
  if (kind === "set_numbers") {
    if (!ctx.officer) return jsonResponse({ error: "เฉพาะเจ้าหน้าที่พัสดุ" }, 403);
    if (["accepted", "cancelled"].includes(row.status)) return jsonResponse({ error: "รายการนี้ปิดแล้ว" }, 409);
    return change(`UPDATE procurement_cases SET report_no=?,committee_order_no=?,egp_project_no=?,updated_at=datetime('now') WHERE id=? AND status NOT IN ('accepted','cancelled')`,
      [clean(body.report_no, 60), clean(body.committee_order_no, 60), clean(body.egp_project_no, 60), id], "set_numbers", "บันทึกเลขที่เอกสาร");
  }
  if (kind === "order") {
    if (!ctx.officer) return jsonResponse({ error: "เฉพาะเจ้าหน้าที่พัสดุ" }, 403);
    if (row.status !== "approved") return jsonResponse({ error: "ออกใบสั่งได้หลังผู้อำนวยการอนุมัติ" }, 409);
    const orderDate = body.order_date || today();
    if (!validDate(orderDate)) return jsonResponse({ error: "วันที่ใบสั่งไม่ถูกต้อง" }, 400);
    if (body.delivery_due_date && !validDate(body.delivery_due_date)) return jsonResponse({ error: "วันที่กำหนดส่งมอบไม่ถูกต้อง" }, 400);
    const due = body.delivery_due_date || (row.delivery_days != null ? addDays(orderDate, Number(row.delivery_days)) : null);
    const orderNo = clean(body.order_no, 60) || `${ORDER_PREFIX[row.procurement_type]}-${row.fiscal_year}-${String(await nextNumber(env, row.procurement_type, row.fiscal_year)).padStart(4, "0")}`;
    return change(`UPDATE procurement_cases SET status='ordered',order_no=?,order_date=?,delivery_due_date=?,ordered_by=?,updated_at=datetime('now') WHERE id=? AND status='approved'`,
      [orderNo, orderDate, due, user.id, id], "order", `ออก${row.procurement_type === "hire" ? "ใบสั่งจ้าง" : "ใบสั่งซื้อ"} ${orderNo}`);
  }
  if (kind === "record_delivery") {
    if (!ctx.officer) return jsonResponse({ error: "เฉพาะเจ้าหน้าที่พัสดุ" }, 403);
    if (row.status !== "ordered") return jsonResponse({ error: "บันทึกการส่งมอบได้หลังออกใบสั่งแล้ว" }, 409);
    if (!validDate(body.delivered_date)) return jsonResponse({ error: "กรุณาระบุวันที่ส่งมอบ" }, 400);
    if (row.order_date && body.delivered_date < row.order_date) return jsonResponse({ error: "วันที่ส่งมอบต้องไม่ก่อนวันที่ใบสั่ง" }, 400);
    const { results: inspectors } = await env.DB.prepare("SELECT user_id FROM procurement_inspectors WHERE case_id=?").bind(id).all();
    return change(`UPDATE procurement_cases SET delivered_date=?,delivery_document_no=?,updated_at=datetime('now') WHERE id=? AND status='ordered'`,
      [body.delivered_date, clean(body.delivery_document_no, 100), id], "delivery", `ผู้ขายส่งมอบพัสดุแล้ว${body.delivery_document_no ? ` (ใบส่งของ ${clean(body.delivery_document_no, 100)})` : ""}`,
      inspectors.map((i) => i.user_id), `พัสดุ ${row.case_no} ส่งมอบแล้ว รอท่านตรวจรับ`);
  }
  if (kind === "inspect") {
    if (row.status !== "ordered" || !row.delivered_date) return jsonResponse({ error: "ตรวจรับได้หลังบันทึกการส่งมอบพัสดุ" }, 409);
    const mine = await env.DB.prepare("SELECT * FROM procurement_inspectors WHERE case_id=? AND user_id=?").bind(id, user.id).first();
    if (!mine) return jsonResponse({ error: "เฉพาะผู้ตรวจรับพัสดุที่ได้รับแต่งตั้ง" }, 403);
    const decision = body.decision === "reject" ? "reject" : body.decision === "accept" ? "accept" : null;
    if (!decision) return jsonResponse({ error: "กรุณาเลือกผลการตรวจรับ" }, 400);
    if (decision === "reject") {
      if (!note) return jsonResponse({ error: "กรุณาระบุเหตุผลที่ไม่รับพัสดุ" }, 400);
      const results = await env.DB.batch([
        env.DB.prepare("UPDATE procurement_cases SET delivered_date=NULL,review_note=?,updated_at=datetime('now') WHERE id=? AND status='ordered'").bind(`ผู้ตรวจรับไม่รับพัสดุ: ${note}`, id),
        env.DB.prepare("UPDATE procurement_inspectors SET decision=NULL,decided_at=NULL,note=NULL WHERE case_id=?").bind(id),
        env.DB.prepare("UPDATE procurement_inspectors SET decision='reject',decided_at=datetime('now'),note=? WHERE case_id=? AND user_id=?").bind(note, id, user.id),
        eventStatement(env, id, "inspect_reject", `ไม่รับพัสดุ: ${note}`, user),
        auditStatement(env, user, "inspect_reject", id, { note }, request),
        ...notifyStatements(env, id, [row.created_by], `ผู้ตรวจรับไม่รับพัสดุ ${row.case_no}: ${note}`, user.id),
      ]);
      if (!results[0].meta.changes) return jsonResponse({ error: "สถานะเปลี่ยนแล้ว กรุณาโหลดใหม่" }, 409);
      return jsonResponse({ ok: true });
    }
    const results = await env.DB.batch([
      env.DB.prepare(`UPDATE procurement_inspectors SET decision='accept',decided_at=datetime('now'),note=? WHERE case_id=? AND user_id=?
        AND EXISTS(SELECT 1 FROM procurement_cases WHERE id=? AND status='ordered' AND delivered_date IS NOT NULL)`).bind(note, id, user.id, id),
      eventStatement(env, id, "inspect_accept", note ? `ตรวจรับถูกต้อง: ${note}` : "ตรวจรับถูกต้องครบถ้วน", user),
    ]);
    if (!results[0].meta.changes) return jsonResponse({ error: "สถานะเปลี่ยนแล้ว กรุณาโหลดใหม่" }, 409);
    const pending = await env.DB.prepare("SELECT COUNT(*) n FROM procurement_inspectors WHERE case_id=? AND (decision IS NULL OR decision<>'accept')").bind(id).first();
    if (Number(pending.n)) return jsonResponse({ ok: true, waiting_for: Number(pending.n) });
    const posted = await postInventory(env, user, row, request);
    return jsonResponse({ ok: true, accepted: true, ...posted });
  }
  if (kind === "post_inventory") {
    if (!ctx.officer) return jsonResponse({ error: "เฉพาะเจ้าหน้าที่พัสดุ" }, 403);
    if (row.status !== "ordered") return jsonResponse({ error: "รายการนี้ไม่ได้รอตรวจรับ" }, 409);
    const pending = await env.DB.prepare("SELECT COUNT(*) n,(SELECT COUNT(*) FROM procurement_inspectors WHERE case_id=?) total FROM procurement_inspectors WHERE case_id=? AND (decision IS NULL OR decision<>'accept')").bind(id, id).first();
    if (Number(pending.n) || !Number(pending.total)) return jsonResponse({ error: "ผู้ตรวจรับยังตรวจรับไม่ครบทุกคน" }, 409);
    return jsonResponse({ ok: true, accepted: true, ...(await postInventory(env, user, row, request)) });
  }
  if (kind === "cancel") {
    if (!ctx.officer) return jsonResponse({ error: "เฉพาะเจ้าหน้าที่พัสดุหรือผู้บริหาร" }, 403);
    if (["accepted", "cancelled"].includes(row.status)) return jsonResponse({ error: "รายการนี้ยกเลิกไม่ได้" }, 409);
    if (!note) return jsonResponse({ error: "กรุณาระบุเหตุผลที่ยกเลิก" }, 400);
    return change("UPDATE procurement_cases SET status='cancelled',review_note=?,updated_at=datetime('now') WHERE id=? AND status NOT IN ('accepted','cancelled')",
      [note, id], "cancel", `ยกเลิก: ${note}`, [row.created_by, ...(await financeUserIds(env))]);
  }
  return jsonResponse({ error: "คำสั่งไม่ถูกต้อง" }, 400);
}

// ---------- เอกสาร ----------
const DOC_STYLE = `@page{size:A4;margin:18mm 16mm}*{box-sizing:border-box}body{font-family:"TH Sarabun New","TH SarabunPSK","Sarabun",sans-serif;color:#111;font-size:16pt;line-height:1.35;margin:0}
.toolbar{position:sticky;top:0;background:#eef3f8;padding:8px;text-align:right;border-bottom:1px solid #ccd}.toolbar button{font:inherit;font-size:14pt;padding:2px 14px}
.page{max-width:180mm;margin:0 auto;padding:6mm 0}h1{text-align:center;font-size:24pt;margin:0 0 6px}h2{text-align:center;font-size:18pt;margin:4px 0}.memo-head{display:grid;grid-template-columns:auto 1fr;gap:0 10px}
.memo-head b{font-size:17pt}.line{border-bottom:1px dotted #555;min-height:1.3em}.indent{text-indent:2.5cm;text-align:justify;margin:4px 0}
table{width:100%;border-collapse:collapse;margin:6px 0;font-size:15pt}th,td{border:1px solid #333;padding:2px 6px;vertical-align:top}th{background:#f1f1f1}.num{text-align:right;white-space:nowrap}.center{text-align:center}
.signs{display:grid;grid-template-columns:1fr 1fr;gap:18px 30px;margin-top:22px}.sign{text-align:center;break-inside:avoid}.sign .esig{font-size:12pt;color:#1d6b3a}.sign .dots{margin-top:26px}
.wide{grid-column:1/-1}.watermark{position:fixed;inset:40% 0 auto;text-align:center;font-size:64pt;color:rgba(200,0,0,.12);transform:rotate(-20deg);pointer-events:none}
.box{border:1px solid #333;padding:6px 10px;margin:6px 0}@media print{.toolbar{display:none}}`;

function page(title, body, draft) {
  return new Response(`<!doctype html><html lang="th"><head><meta charset="utf-8"><title>${escapeHtml(title)}</title><style>${DOC_STYLE}</style></head><body>
<div class="toolbar"><button onclick="print()">พิมพ์ / บันทึกเป็น PDF</button></div>${draft ? `<div class="watermark">${escapeHtml(draft)}</div>` : ""}<div class="page">${body}</div></body></html>`,
  { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } });
}

function sign(name, role, signedAt, label = "") {
  return `<div class="sign">${signedAt ? `<div class="esig">ลงนามอิเล็กทรอนิกส์ ${escapeHtml(thaiDate(signedAt))}</div>` : `<div class="dots">ลงชื่อ.......................................................</div>`}
    <div>(${escapeHtml(name || "......................................................")})</div><div>${escapeHtml(role)}</div>${label ? `<div>${escapeHtml(label)}</div>` : ""}</div>`;
}

function itemTable(items, withType = false) {
  const types = { material: "วัสดุ", equipment: "ครุภัณฑ์", service: "งานจ้าง/บริการ" };
  const total = sumMoney(items.map((i) => i.amount));
  return `<table><thead><tr><th>ที่</th><th>รายการ</th>${withType ? "<th>ประเภท</th>" : ""}<th>จำนวน</th><th>หน่วย</th><th>ราคาต่อหน่วย (บาท)</th><th>จำนวนเงิน (บาท)</th></tr></thead><tbody>
    ${items.map((i) => `<tr><td class="center">${i.line_no}</td><td>${escapeHtml(i.description)}</td>${withType ? `<td>${types[i.item_type] || ""}</td>` : ""}<td class="num">${Number(i.quantity).toLocaleString("th-TH")}</td><td>${escapeHtml(i.unit || "")}</td><td class="num">${moneyText(i.unit_price)}</td><td class="num">${moneyText(i.amount)}</td></tr>`).join("")}
    <tr><td colspan="${withType ? 6 : 5}" class="center"><b>รวมเป็นเงินทั้งสิ้น</b> (${escapeHtml(bahtText(total))})</td><td class="num"><b>${moneyText(total)}</b></td></tr></tbody></table>`;
}

function inspectorTitle(inspectors) {
  return inspectors.length >= 3 ? "คณะกรรมการตรวจรับพัสดุ" : "ผู้ตรวจรับพัสดุ";
}
const positionLabel = (i, all) => all.length >= 3 ? (i.position === "chair" ? "ประธานกรรมการ" : "กรรมการ") : "ผู้ตรวจรับพัสดุ";

async function documentRoute(request, env, user, id, kind) {
  const base = await loadCase(env, id);
  if (!base) return new Response("ไม่พบงานจัดซื้อจัดจ้าง", { status: 404 });
  if (!await canViewCase(env, user, base)) return new Response("ไม่มีสิทธิ์เปิดเอกสารนี้", { status: 403 });
  const row = await caseDetail(env, base);
  const verb = row.procurement_type === "hire" ? "จ้าง" : "ซื้อ";
  const dept = DEPARTMENTS[row.department] || "";
  const officerRole = "เจ้าหน้าที่", headRole = "หัวหน้าเจ้าหน้าที่", directorRole = `ผู้อำนวยการ${SCHOOL}`;
  const director = row.director_name || (await env.DB.prepare(`SELECT u.full_name FROM budget_role_assignments a JOIN users u ON u.id=a.user_id WHERE a.role_key='director_approval' AND a.department=''`).first().catch(() => null))?.full_name;
  const headName = row.head_name || (await roleUser(env, "procurement_head"))?.name;
  const items = row.items, inspectors = row.inspectors;
  if (kind === "report") {
    const draft = ["draft", "head_review", "director_review"].includes(row.status) ? "ร่าง - ยังไม่อนุมัติ" : row.status === "cancelled" ? "ยกเลิก" : "";
    const body = `<h1>บันทึกข้อความ</h1><div class="memo-head"><b>ส่วนราชการ</b><div class="line">${SCHOOL} ${escapeHtml(dept)}</div>
      <b>ที่</b><div class="line">${escapeHtml(row.report_no || "")} &nbsp;&nbsp;&nbsp; <b>วันที่</b> ${escapeHtml(thaiDate(row.report_date))}</div>
      <b>เรื่อง</b><div class="line">รายงานขอ${verb}${escapeHtml(row.subject)}</div></div>
      <p><b>เรียน</b> ผู้อำนวยการ${SCHOOL}</p>
      <p class="indent">ด้วย${escapeHtml(dept)} ${SCHOOL} มีความประสงค์จะ${verb}${escapeHtml(row.subject)} เพื่อใช้ในการดำเนินโครงการ${escapeHtml(String(row.project_name || "").replace(/^โครงการ\s*/, ""))} (คำขอเลขที่ ${escapeHtml(row.request_no || "-")}) ซึ่งได้รับอนุมัติเงินจาก${escapeHtml(PROJECT_FUNDING_TYPES[row.funding_type] || "งบประมาณโครงการ")} ประจำปีงบประมาณ ${row.fiscal_year} เจ้าหน้าที่ได้ตรวจสอบแล้ว ขอรายงานขอ${verb} ดังนี้</p>
      <p class="indent">1. เหตุผลความจำเป็นที่ต้อง${verb} : ${escapeHtml(row.necessity || "")}</p>
      <p class="indent">2. รายละเอียดของพัสดุที่จะ${verb} :</p>${itemTable(items, true)}
      <p class="indent">3. ราคากลางหรือราคาอ้างอิง : ${row.reference_price != null ? `${moneyText(row.reference_price)} บาท (${escapeHtml(bahtText(row.reference_price))})` : "-"}${row.reference_source ? ` ที่มา: ${escapeHtml(row.reference_source)}` : ""}</p>
      <p class="indent">4. วงเงินที่จะ${verb} : ${moneyText(row.total_amount)} บาท (${escapeHtml(bahtText(row.total_amount))})</p>
      <p class="indent">5. กำหนดเวลาที่ต้องการใช้พัสดุ : ${row.delivery_days != null ? `ภายใน ${row.delivery_days} วัน นับถัดจากวันที่ลงนามใน${row.procurement_type === "hire" ? "ใบสั่งจ้าง" : "ใบสั่งซื้อ"}` : "ตามที่ระบุในใบสั่ง"}${row.delivery_place ? ` ส่งมอบ ณ ${escapeHtml(row.delivery_place)}` : ""}</p>
      <p class="indent">6. วิธีที่จะ${verb}และเหตุผล : ${escapeHtml(PROCUREMENT_METHODS[row.method] || row.method)} ${escapeHtml(row.method_reason || "")}</p>
      <p class="indent">7. หลักเกณฑ์การพิจารณาคัดเลือกข้อเสนอ : ใช้เกณฑ์ราคา</p>
      <p class="indent">8. ผู้ขาย/ผู้รับจ้างที่เสนอ : ${escapeHtml(row.vendor_name || "")}${row.vendor_tax_id ? ` เลขประจำตัวผู้เสียภาษี ${escapeHtml(row.vendor_tax_id)}` : ""}</p>
      <p class="indent">9. ขอแต่งตั้ง${inspectorTitle(inspectors)} ดังนี้</p>
      <table><tbody>${inspectors.map((i, n) => `<tr><td class="center" style="width:2em">${n + 1}</td><td>${escapeHtml(i.full_name)}</td><td>${positionLabel(i, inspectors)}</td></tr>`).join("") || '<tr><td colspan="3">-</td></tr>'}</tbody></table>
      <p class="indent">จึงเรียนมาเพื่อโปรดพิจารณา หากเห็นชอบขอได้โปรดอนุมัติให้ดำเนินการตามรายละเอียดข้างต้น และลงนามในคำสั่งแต่งตั้ง${inspectorTitle(inspectors)}</p>
      <div class="signs">${sign(row.creator_name, officerRole, ["head_review", "director_review", "approved", "ordered", "accepted"].includes(row.status) ? row.created_at : null)}
      ${sign(headName, headRole, row.head_signed_at, row.head_signed_at ? "เห็นชอบ" : "")}
      <div class="box wide"><b>ความเห็น/คำสั่งผู้อำนวยการ</b> ${row.approved_at ? "☑ อนุมัติ" : "☐ อนุมัติ &nbsp; ☐ ไม่อนุมัติ"}
      <div class="signs" style="margin-top:6px">${sign(director, directorRole, row.approved_at)}</div></div></div>`;
    return page(`รายงานขอ${verb} ${row.case_no}`, body, draft);
  }
  if (!row.approved_at || row.status === "cancelled") return new Response("เอกสารนี้ออกได้หลังผู้อำนวยการอนุมัติ", { status: 409 });
  if (kind === "committee") {
    const title = inspectorTitle(inspectors);
    const body = `<div class="center" style="font-size:18pt"><b>คำสั่ง${SCHOOL}</b></div><div class="center">ที่ ${escapeHtml(row.committee_order_no || "........../..........")}</div>
      <div class="center">เรื่อง แต่งตั้ง${title} สำหรับการ${verb}${escapeHtml(row.subject)}</div><div class="center">--------------------------------</div>
      <p class="indent">ด้วย${SCHOOL} มีความประสงค์จะ${verb}${escapeHtml(row.subject)} โดย${escapeHtml(PROCUREMENT_METHODS[row.method] || "")} วงเงิน ${moneyText(row.total_amount)} บาท (${escapeHtml(bahtText(row.total_amount))}) และเพื่อให้เป็นไปตามระเบียบกระทรวงการคลังว่าด้วยการจัดซื้อจัดจ้างและการบริหารพัสดุภาครัฐ พ.ศ. 2560 จึงขอแต่งตั้งบุคคลต่อไปนี้เป็น${title}</p>
      <table><tbody>${inspectors.map((i, n) => `<tr><td class="center" style="width:2em">${n + 1}</td><td>${escapeHtml(i.full_name)}</td><td>${positionLabel(i, inspectors)}</td></tr>`).join("")}</tbody></table>
      <p class="indent">อำนาจและหน้าที่ ตรวจรับพัสดุให้ถูกต้องครบถ้วนตามสัญญาหรือข้อตกลง ณ ที่ทำการของผู้ใช้พัสดุหรือสถานที่ซึ่งกำหนดไว้ และรายงานผลต่อผู้อำนวยการโดยเร็ว</p>
      <p class="indent">สั่ง ณ วันที่ ${escapeHtml(thaiDate(row.approved_at))}</p>
      <div class="signs"><div></div>${sign(director, directorRole, row.approved_at)}</div>`;
    return page(`คำสั่งแต่งตั้ง${title} ${row.case_no}`, body);
  }
  if (kind === "order") {
    if (!row.order_no) return new Response(`ใบสั่ง${verb}จะออกได้หลังเจ้าหน้าที่บันทึกการสั่ง${verb}`, { status: 409 });
    const body = `<h2>ใบสั่ง${verb}</h2><table><tbody><tr><td style="width:50%"><b>ผู้${row.procurement_type === "hire" ? "รับจ้าง" : "ขาย"}</b> ${escapeHtml(row.vendor_name || "")}<br>ที่อยู่ ${escapeHtml(row.vendor_address || "-")}<br>โทรศัพท์ ${escapeHtml(row.vendor_phone || "-")}<br>เลขประจำตัวผู้เสียภาษี ${escapeHtml(row.vendor_tax_id || "-")}</td>
      <td><b>ใบสั่ง${verb}เลขที่</b> ${escapeHtml(row.order_no)}<br><b>วันที่</b> ${escapeHtml(thaiDate(row.order_date))}<br><b>ส่วนราชการ</b> ${SCHOOL}<br>${row.egp_project_no ? `<b>เลขที่โครงการ e-GP</b> ${escapeHtml(row.egp_project_no)}` : ""}</td></tr></tbody></table>
      <p class="indent">ตามที่ท่านได้เสนอราคาไว้ ${SCHOOL} ตกลง${verb} ตามรายการดังต่อไปนี้</p>${itemTable(items)}
      <p><b>เงื่อนไข</b> กำหนดส่งมอบ${row.delivery_due_date ? `ภายในวันที่ ${escapeHtml(thaiDate(row.delivery_due_date))}` : row.delivery_days != null ? `ภายใน ${row.delivery_days} วัน` : "ตามที่ตกลง"}${row.delivery_place ? ` ณ ${escapeHtml(row.delivery_place)}` : ""} หากส่งมอบล่าช้า ผู้${row.procurement_type === "hire" ? "รับจ้าง" : "ขาย"}ยอมให้ปรับตามระเบียบที่เกี่ยวข้อง</p>
      <div class="signs">${sign(director, `ผู้สั่ง${verb} · ${directorRole}`, null)}${sign("", `ผู้รับใบสั่ง${verb}`, null, `วันที่ ........................................`)}</div>`;
    return page(`ใบสั่ง${verb} ${row.order_no}`, body);
  }
  if (kind === "inspection") {
    if (row.status !== "accepted") return new Response("ใบตรวจรับจะออกได้หลังผู้ตรวจรับตรวจรับครบทุกคน", { status: 409 });
    const title = inspectorTitle(inspectors);
    const body = `<h2>ใบตรวจรับพัสดุ</h2><p style="text-align:right">${SCHOOL}<br>วันที่ ${escapeHtml(thaiDate(inspectors.map((i) => i.decided_at).filter(Boolean).sort().pop()))}</p>
      <p class="indent">ตามที่${SCHOOL} ได้${verb}${escapeHtml(row.subject)} จาก ${escapeHtml(row.vendor_name || "")} ตาม${row.procurement_type === "hire" ? "ใบสั่งจ้าง" : "ใบสั่งซื้อ"}เลขที่ ${escapeHtml(row.order_no || "")} ลงวันที่ ${escapeHtml(thaiDate(row.order_date))} นั้น</p>
      <p class="indent">ผู้${row.procurement_type === "hire" ? "รับจ้าง" : "ขาย"}ได้ส่งมอบพัสดุเมื่อวันที่ ${escapeHtml(thaiDate(row.delivered_date))}${row.delivery_document_no ? ` ตามใบส่งของเลขที่ ${escapeHtml(row.delivery_document_no)}` : ""} ${title}ได้ตรวจรับแล้ว ผลปรากฏว่าถูกต้องครบถ้วนตามรายการดังนี้</p>
      ${itemTable(items)}<p class="indent">จึงได้ลงลายมือชื่อไว้เป็นหลักฐาน และรายงานให้ผู้อำนวยการทราบ</p>
      <div class="signs">${inspectors.map((i) => sign(i.full_name, positionLabel(i, inspectors), i.decided_at)).join("")}</div>
      <div class="box" style="margin-top:18px"><b>ทราบ</b><div class="signs" style="margin-top:4px"><div></div>${sign(director, directorRole, null)}</div></div>`;
    return page(`ใบตรวจรับพัสดุ ${row.case_no}`, body);
  }
  return new Response("ไม่พบเอกสาร", { status: 404 });
}

// ยอดที่ต้องปิดตามใบตรวจรับ (null = ไม่มีงานจัดซื้อที่ตรวจรับแล้ว หรือยอดเท่ากันแล้ว)
export async function procurementClosing(env, expenseId) {
  const row = await env.DB.prepare(`SELECT c.case_no,c.total_amount,e.amount FROM procurement_cases c JOIN project_expenses e ON e.id=c.expense_id
    WHERE c.expense_id=? AND c.status='accepted'`).bind(expenseId).first().catch(() => null);
  if (!row || money(row.total_amount) >= money(row.amount)) return null;
  return { case_no: row.case_no, actual: money(row.total_amount), requested: money(row.amount) };
}

// ใช้ในระบบเบิกจ่าย: ห้ามเสนอผู้อำนวยการอนุมัติเบิกจ่ายจนกว่าตรวจรับพัสดุครบ
export async function procurementBlocksDisbursement(env, expenseId) {
  const row = await env.DB.prepare("SELECT case_no,status FROM procurement_cases WHERE expense_id=? AND status<>'cancelled'").bind(expenseId).first().catch(() => null);
  if (!row || row.status === "accepted") return null;
  return `คำขอนี้มีงานจัดซื้อจัดจ้าง ${row.case_no} (${STATUS_LABELS[row.status] || row.status}) ต้องตรวจรับพัสดุให้เสร็จก่อนเสนอผู้อำนวยการอนุมัติเบิกจ่าย`;
}

export async function handleProcurementRoute(request, env, pathname, method) {
  if (!pathname.startsWith("/api/procurement")) return null;
  const user = await getCurrentUser(request, env);
  const wantsHtml = pathname.includes("/documents/");
  if (!user?.role) return wantsHtml ? new Response("กรุณาเข้าสู่ระบบ", { status: 401 }) : jsonResponse({ error: "กรุณาเข้าสู่ระบบ" }, 401);
  await ensureProcurementSchema(env);
  if (pathname === "/api/procurement/overview" && method === "GET") return overview(request, env, user);
  if (pathname === "/api/procurement/expense" && method === "GET") return expenseForCreate(request, env, user);
  if (pathname === "/api/procurement/cases" && method === "POST") return createCase(request, env, user);
  if (pathname === "/api/procurement/inventory-matches" && method === "POST") {
    if (!await isProcurementOfficer(env, user)) return jsonResponse({ error: "เฉพาะเจ้าหน้าที่พัสดุหรือผู้บริหาร" }, 403);
    const body = await request.json().catch(() => null);
    const items = Array.isArray(body?.items) ? body.items.slice(0, 100) : [];
    const register = await materialRegister(env);
    return jsonResponse({ matches: items.map((i) => similarMaterials(register, i?.description, i?.unit)) });
  }
  if (pathname === "/api/procurement/notifications/read" && method === "POST") {
    const body = await request.json().catch(() => null);
    await env.DB.prepare("UPDATE procurement_notifications SET read_at=datetime('now') WHERE user_id=? AND read_at IS NULL AND case_id=?").bind(user.id, Number(body?.case_id)).run();
    return jsonResponse({ ok: true });
  }
  let match = pathname.match(/^\/api\/procurement\/cases\/(\d+)$/);
  if (match && method === "GET") {
    const row = await loadCase(env, Number(match[1]));
    if (!row) return jsonResponse({ error: "ไม่พบงานจัดซื้อจัดจ้าง" }, 404);
    if (!await canViewCase(env, user, row)) return jsonResponse({ error: "ไม่มีสิทธิ์ดูรายการนี้" }, 403);
    const detail = await caseDetail(env, row), ctx = await context(env, user);
    await env.DB.prepare("UPDATE procurement_notifications SET read_at=datetime('now') WHERE user_id=? AND read_at IS NULL AND case_id=?").bind(user.id, row.id).run();
    return jsonResponse({ case: { ...detail, total_amount: money(detail.total_amount), expense_amount: money(detail.expense_amount),
      expense_open: expenseOpen({ workflow_version: 2, status: detail.expense_status, current_step: detail.expense_step }) },
      permissions: await permissionsFor(env, user, detail, ctx), statuses: STATUS_LABELS, methods: PROCUREMENT_METHODS });
  }
  if (match && method === "PATCH") return updateCase(request, env, user, Number(match[1]));
  match = pathname.match(/^\/api\/procurement\/cases\/(\d+)\/action$/);
  if (match && method === "POST") return action(request, env, user, Number(match[1]));
  match = pathname.match(/^\/api\/procurement\/cases\/(\d+)\/documents\/(report|committee|order|inspection)$/);
  if (match && method === "GET") return documentRoute(request, env, user, Number(match[1]), match[2]);
  return jsonResponse({ error: "ไม่พบ endpoint จัดซื้อจัดจ้างนี้" }, 404);
}
