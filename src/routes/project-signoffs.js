// ขั้นลงนามตามแบบ "บันทึกข้อความ ขออนุมัติดำเนินโครงการและขออนุมัติใช้เงินโรงเรียน"
// ผู้รับผิดชอบ → หัวหน้าฝ่าย → รอง ผอ.ผู้ดูแลฝ่าย → การเงิน → หัวหน้าฝ่ายงบประมาณ → รอง ผอ.ฝ่ายงบประมาณ → ผู้อำนวยการ
// ชื่อผู้ลงนามมาจาก "ตั้งค่าผู้อนุมัติ" (budget_role_assignments) ตามฝ่ายของโครงการ
// ขั้นที่ยังไม่ได้ตั้งผู้รับผิดชอบ หรือผู้รับผิดชอบเป็นคนเดียวกับผู้ขอ ระบบข้ามขั้นนั้น
import { FINANCE_ROLE_SQL } from "../lib/finance-roles.js";
import { money } from "../lib/project-finance.js";
import { bahtText } from "../lib/thai-baht.js";

export const SIGNOFF_STEPS = [
  { key: "dept_head", step: "dept_head_review", role: "department_head", scope: "project", label: "หัวหน้าฝ่าย", phase: 1 },
  { key: "dept_deputy", step: "dept_deputy_review", role: "deputy_director", scope: "project", label: "รองผู้อำนวยการผู้ดูแลฝ่าย", phase: 1 },
  { key: "finance", step: "finance_processing", role: null, label: "เจ้าหน้าที่การเงิน", phase: 0 },
  { key: "budget_head", step: "budget_head_review", role: "department_head", scope: "budget", label: "หัวหน้าฝ่ายบริหารงานงบประมาณ", phase: 2 },
  { key: "budget_deputy", step: "budget_deputy_review", role: "deputy_director", scope: "budget", label: "รองผู้อำนวยการผู้ดูแลฝ่ายงบประมาณ", phase: 2 },
  { key: "director", step: "director_approval", role: "director_approval", scope: "", label: "ผู้อำนวยการ", phase: 0 },
];
export const REVIEW_STEPS = SIGNOFF_STEPS.filter((s) => s.phase);
const byStep = Object.fromEntries(REVIEW_STEPS.map((s) => [s.step, s]));
export const isReviewStep = (step) => Boolean(byStep[step]);

const ready = new WeakSet();
export async function ensureSignoffSchema(env) {
  if (ready.has(env.DB)) return;
  try { await env.DB.prepare("ALTER TABLE project_expenses ADD COLUMN budget_snapshot TEXT").run(); }
  catch (e) { if (!String(e.message).toLowerCase().includes("duplicate column")) throw e; }
  await env.DB.batch([
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS project_expense_signoffs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,expense_id INTEGER NOT NULL REFERENCES project_expenses(id) ON DELETE CASCADE,
      step_key TEXT NOT NULL,step_order INTEGER NOT NULL,assigned_user_id INTEGER REFERENCES users(id),
      status TEXT NOT NULL DEFAULT 'waiting',decision TEXT,note TEXT,acted_by INTEGER REFERENCES users(id),acted_at TEXT,
      UNIQUE(expense_id,step_key))`),
    env.DB.prepare("CREATE INDEX IF NOT EXISTS idx_expense_signoffs_assignee ON project_expense_signoffs(assigned_user_id,status)"),
  ]);
  ready.add(env.DB);
}

async function assignee(env, role, department) {
  return env.DB.prepare(`SELECT a.user_id,u.full_name FROM budget_role_assignments a JOIN users u ON u.id=a.user_id
    WHERE a.role_key=? AND a.department=? AND u.status='active' AND u.deleted_at IS NULL`).bind(role, department).first().catch(() => null);
}

// สร้างลำดับผู้ลงนามตอนส่งเอกสาร คืน statements + ขั้นแรก
export async function buildSignoffChain(env, row, department, token) {
  const rows = [];
  for (const [index, s] of SIGNOFF_STEPS.entries()) {
    let user = null;
    if (s.role) user = await assignee(env, s.role, s.scope === "project" ? department : s.scope);
    const skip = s.phase && (!user || Number(user.user_id) === Number(row.created_by));
    rows.push({ ...s, order: index + 1, user_id: user ? Number(user.user_id) : null, status: skip ? "skipped" : "waiting" });
  }
  const first = rows.find((r) => r.phase === 1 && r.status === "waiting");
  if (first) first.status = "pending";
  const guard = " AND EXISTS(SELECT 1 FROM project_workflow_events WHERE token=?)";
  const statements = [env.DB.prepare(`DELETE FROM project_expense_signoffs WHERE expense_id=?${guard}`).bind(row.id, token),
    ...rows.map((r) => env.DB.prepare(`INSERT INTO project_expense_signoffs(expense_id,step_key,step_order,assigned_user_id,status)
      SELECT ?,?,?,?,? WHERE EXISTS(SELECT 1 FROM project_workflow_events WHERE token=?)`).bind(row.id, r.key, r.order, r.user_id, r.status, token))];
  return { statements, first };
}

export async function budgetSnapshot(env, row) {
  const p = await env.DB.prepare(`SELECT p.budget_amount,COALESCE((SELECT SUM(e.amount) FROM project_expenses e WHERE e.project_id=p.id AND e.id<>? AND e.status IN ('pending','approved','paid')),0) used
    FROM projects p WHERE p.id=?`).bind(row.id, row.project_id).first();
  return JSON.stringify({ allocated: money(p?.budget_amount || 0), used_before: money(p?.used || 0) });
}

export async function signoffsFor(env, expenseId) {
  const { results } = await env.DB.prepare(`SELECT s.*,a.full_name assigned_name,b.full_name acted_name FROM project_expense_signoffs s
    LEFT JOIN users a ON a.id=s.assigned_user_id LEFT JOIN users b ON b.id=s.acted_by WHERE s.expense_id=? ORDER BY s.step_order`).bind(expenseId).all();
  return results;
}

// ขั้นถัดไปหลังขั้นพิจารณาปัจจุบัน (ภายในช่วงเดียวกัน) ถ้าไม่มีแล้วไปคิวการเงิน/ผู้อำนวยการ
export function nextAfter(signoffs, phase, afterOrder = 0) {
  const next = signoffs.find((s) => {
    const def = SIGNOFF_STEPS.find((d) => d.key === s.step_key);
    return def?.phase === phase && s.step_order > afterOrder && s.status === "waiting";
  });
  if (next) return { step: SIGNOFF_STEPS.find((d) => d.key === next.step_key).step, signoff: next };
  return { step: phase === 1 ? "finance_queue" : "director_approval", signoff: null };
}

// statements บันทึกผลขั้น (ใช้ร่วมกับ event token เดียวกับการเปลี่ยนสถานะคำขอ)
export function markSignoff(env, token, expenseId, stepKey, status, user, decision = null, note = null) {
  return env.DB.prepare(`UPDATE project_expense_signoffs SET status=?,decision=?,note=?,acted_by=?,acted_at=datetime('now')
    WHERE expense_id=? AND step_key=? AND EXISTS(SELECT 1 FROM project_workflow_events WHERE token=?)`).bind(status, decision, note, user.id, expenseId, stepKey, token);
}
export function activateSignoff(env, token, signoff) {
  return env.DB.prepare(`UPDATE project_expense_signoffs SET status='pending' WHERE id=? AND EXISTS(SELECT 1 FROM project_workflow_events WHERE token=?)`).bind(signoff.id, token);
}

// ---------------- แบบพิมพ์ ----------------
const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const baht = (v) => Number(v || 0).toLocaleString("th-TH", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const MONTHS = ["มกราคม", "กุมภาพันธ์", "มีนาคม", "เมษายน", "พฤษภาคม", "มิถุนายน", "กรกฎาคม", "สิงหาคม", "กันยายน", "ตุลาคม", "พฤศจิกายน", "ธันวาคม"];
function dateParts(value) {
  if (!value) return null;
  const iso = String(value).includes("T") || String(value).includes(" ") ? new Date(String(value).replace(" ", "T") + (String(value).endsWith("Z") ? "" : "Z")) : new Date(`${value}T00:00:00+07:00`);
  if (Number.isNaN(iso.getTime())) return null;
  const [y, m, d] = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Bangkok", year: "numeric", month: "2-digit", day: "2-digit" }).format(iso).split("-").map(Number);
  return { d, m: MONTHS[m - 1], y: y + 543 };
}
const fullDate = (v) => { const p = dateParts(v); return p ? `${p.d} ${p.m} ${p.y}` : ""; };
const dateLine = (v) => { const p = dateParts(v); return `วันที่ <u>&nbsp;${p ? p.d : "&nbsp;".repeat(6)}&nbsp;</u> เดือน <u>&nbsp;${p ? p.m : "&nbsp;".repeat(16)}&nbsp;</u> พ.ศ. <u>&nbsp;${p ? p.y : "&nbsp;".repeat(8)}&nbsp;</u>`; };
const box = (on) => `<span class="ck">${on ? "&#10003;" : ""}</span>`;
const fill = (v, min = 10) => `<span class="fill" style="min-width:${min}em">${v === "" || v == null ? "&nbsp;" : esc(v)}</span>`;
const DEPT_TITLE = { academic: "วิชาการ", early_childhood: "ปฐมวัย (งานอนุบาล)", budget: "งบประมาณ", personnel: "บุคคล", general: "บริหารทั่วไป" };
const FUNDING = { subsidy: "เงินอุดหนุน", free_education: "เงินเรียนฟรี 15 ปี", school_income: "เงินรายได้สถานศึกษา", donation: "เงินบริจาค", other: "อื่น ๆ" };

function signBlock(name, role, at, signed) {
  return `<div class="sign"><div>ลงชื่อ ${signed ? `<span class="esign">${esc(name)}</span>` : fill("", 7)}${role ? ` ${esc(role)}` : ""}</div>
    <div>( ${name ? esc(name) : fill("", 7)} )</div><div>${dateLine(signed ? at : null)}</div></div>`;
}

export async function memoDocument(env, id) {
  const row = await env.DB.prepare(`SELECT e.*,p.name project_name,p.funding_type,COALESCE(p.management_area,p.department) department,u.full_name requester_name
    FROM project_expenses e JOIN projects p ON p.id=e.project_id LEFT JOIN users u ON u.id=e.created_by WHERE e.id=? AND e.workflow_version=2`).bind(id).first();
  if (!row) return null;
  const [{ results: items }, signoffs] = await Promise.all([
    env.DB.prepare("SELECT * FROM budget_request_items WHERE expense_id=? ORDER BY line_no").bind(id).all(),
    signoffsFor(env, id),
  ]);
  const so = Object.fromEntries(signoffs.map((s) => [s.step_key, s]));
  const roleName = async (role, department) => (await assignee(env, role, department))?.full_name || "";
  // ชื่อตามสิทธิ์: ใช้ผู้ที่ลงนามจริง ถ้ายังไม่ลงนามใช้ผู้ที่ได้รับมอบหมายในขั้นนั้น ถ้ายังไม่มีขั้น (คำขอเดิม) ใช้ตั้งค่าผู้อนุมัติปัจจุบัน
  const nameOf = async (key, role, department) => so[key]?.acted_name || so[key]?.assigned_name || (role ? await roleName(role, department) : "");
  const signed = (key) => so[key]?.status === "approved";
  const at = (key) => so[key]?.acted_at;
  const financeRow = so.finance;
  const financeName = financeRow?.acted_name || (row.finance_received_by ? (await env.DB.prepare("SELECT full_name FROM users WHERE id=?").bind(row.finance_received_by).first())?.full_name : "")
    || (await env.DB.prepare(`SELECT u.full_name FROM budget_role_assignments a JOIN users u ON u.id=a.user_id WHERE a.role_key IN ${FINANCE_ROLE_SQL} AND a.department='' ORDER BY CASE a.role_key WHEN 'finance_review' THEN 0 ELSE 1 END LIMIT 1`).first().catch(() => null))?.full_name || "";
  const directorSigned = so.director ? signed("director") : Boolean(row.approved_by);
  const directorName = so.director?.acted_name || (row.approved_by ? (await env.DB.prepare("SELECT full_name FROM users WHERE id=?").bind(row.approved_by).first())?.full_name : "") || so.director?.assigned_name || await roleName("director_approval", "");
  const procurementName = await roleName("procurement_officer", "");
  const names = {
    head: await nameOf("dept_head", "department_head", row.department), deputy: await nameOf("dept_deputy", "deputy_director", row.department),
    budgetHead: await nameOf("budget_head", "department_head", "budget"), budgetDeputy: await nameOf("budget_deputy", "deputy_director", "budget"),
  };
  let snap = {};
  try { snap = JSON.parse(row.budget_snapshot || "{}"); } catch { snap = {}; }
  if (snap.allocated == null) {
    const p = await env.DB.prepare(`SELECT p.budget_amount,COALESCE((SELECT SUM(x.amount) FROM project_expenses x WHERE x.project_id=p.id AND x.id<>? AND x.status IN ('pending','approved','paid')),0) used FROM projects p WHERE p.id=?`).bind(id, row.project_id).first();
    snap = { allocated: money(p?.budget_amount || 0), used_before: money(p?.used || 0) };
  }
  const remaining = money(snap.allocated - snap.used_before - row.amount);
  const remainingBefore = money(snap.allocated - snap.used_before);
  const plan = so.dept_head?.decision;
  const sufficient = remaining >= 0;
  const financeDone = Boolean(financeRow?.status === "approved" || ["director_approval", "budget_head_review", "budget_deputy_review", "finance_ready", "completed"].includes(row.current_step) || row.status === "paid");
  const decided = (key) => so[key]?.status === "approved" ? "approve" : so[key]?.status === "rejected" ? "reject" : null;
  const kind = { purchase: "จัดซื้อ", hire: "จัดจ้าง", both: "จัดซื้อ/จัดจ้าง" }[row.procurement_kind]
    || (items.some((i) => i.category === "services") && !items.some((i) => ["materials", "equipment"].includes(i.category)) ? "จัดจ้าง" : "จัดซื้อ");
  const position = (await env.DB.prepare(`SELECT p.position FROM personnel_accounts a JOIN personnel_records p ON p.id=a.personnel_id WHERE a.user_id=? LIMIT 1`).bind(row.created_by).first().catch(() => null))?.position || "";
  const itemRows = items.map((i) => `<tr><td class="c">${i.line_no}</td><td>${esc(i.description)}</td><td class="c">${Number(i.quantity).toLocaleString("th-TH")} ${esc(i.unit || "")}</td><td class="r">${baht(i.unit_price)}</td><td class="r">${baht(i.amount)}</td><td>${esc(i.note || "")}</td></tr>`).join("");
  const blank = Math.max(0, 12 - items.length);
  const html = `<!doctype html><html lang="th"><head><meta charset="utf-8"><title>บันทึกขออนุมัติ ${esc(row.request_no)}</title>
<link rel="preconnect" href="https://fonts.googleapis.com"><link href="https://fonts.googleapis.com/css2?family=Sarabun:wght@400;700&display=swap" rel="stylesheet">
<style>@page{size:A4;margin:12mm 15mm 10mm 20mm}*{box-sizing:border-box}body{margin:0;font-family:"Sarabun","Loma",sans-serif;font-size:11pt;line-height:1.55;color:#000}
.page{page-break-after:always;position:relative}.page:last-child{page-break-after:auto}.toolbar{position:fixed;top:8px;right:8px}.toolbar button{font:inherit;padding:4px 14px;cursor:pointer}
@media print{.toolbar{display:none}}h1{font-size:20pt;text-align:center;margin:14px 0 10px}.reg{position:absolute;right:0;top:0;border:1px solid #000;padding:2px 6px;font-size:9pt;line-height:1.5;width:44mm}
.fill{display:inline-block;border-bottom:1px dotted #000;padding:0 4px;text-align:center}.indent{text-indent:2.5cm;text-align:justify}p{margin:0}.row{display:flex;justify-content:space-between;gap:10px}
.sign{text-align:center;margin-top:4px}.sign div{margin:1px 0}.esign{font-weight:700;color:#123c8c;border-bottom:1px dotted #000;padding:0 8px}
.ck{display:inline-block;width:10pt;height:10pt;border:1px solid #000;border-radius:50%;text-align:center;line-height:9pt;font-size:9pt;vertical-align:middle;margin-right:4px}
.grid2{display:grid;grid-template-columns:1fr 1fr;gap:6px 18px;margin-top:6px}.sec{margin-top:6px}.b{font-weight:700}
table{width:100%;border-collapse:collapse;margin-top:8px;font-size:11pt}th,td{border:1px solid #000;padding:2px 6px;height:1.45em}th{font-weight:700;text-align:center}.c{text-align:center}.r{text-align:right}
.ref{margin-top:8px;font-size:8pt;color:#666}</style></head><body>
<div class="toolbar"><button onclick="print()">พิมพ์ / บันทึก PDF</button></div>
<section class="page">
<div class="reg">ที่ ${fill("", 4)}<br>ลว. ${fill("", 4)}<br>เลขที่ (ซ./จ.) ${fill("", 3)}<br>${fill("", 6)}</div>
<div style="min-height:24mm;padding-top:5mm;position:relative"><img src="/img/garuda.jpg" alt="ตราครุฑ" style="position:absolute;left:0;top:0;width:15mm;height:auto"><h1 style="margin:0">บันทึกข้อความ</h1></div>
<p><b>ส่วนราชการ</b> โรงเรียนบ้านป่าเด็ง ตำบลป่าเด็ง อำเภอแก่งกระจาน จังหวัดเพชรบุรี</p>
<div class="row"><p><b>ที่</b> ${fill("", 8)}</p><p><b>วันที่</b> ${fill(fullDate(row.expense_date), 8)}</p></div>
<p><b>เรื่อง</b> ขออนุมัติดำเนินโครงการและขออนุมัติใช้เงินโรงเรียน</p>
<p><b>เรียน</b> ผู้อำนวยการโรงเรียนบ้านป่าเด็ง</p>
<p class="indent">ด้วยข้าพเจ้า ${fill(row.requester_name, 9)} มีความประสงค์ใช้เงินสำหรับการ (${kind}) งาน/โครงการ ${fill(row.project_name, 10)} ฝ่าย/งาน ${fill(DEPT_TITLE[row.department] || row.department, 4)}
เพื่อ ${fill(row.request_purpose, 12)} ภายในวันที่ ${fill(fullDate(row.needed_date), 5)} โดยใช้เงิน ${fill(FUNDING[row.funding_type || row.source_type] || "", 6)} จึงเสนอมาเพื่อขออนุมัติใช้เงิน
และดำเนินการจัดซื้อจัดจ้างตามระเบียบกระทรวงการคลังว่าด้วยการจัดซื้อจัดจ้างและการบริหารพัสดุภาครัฐ พ.ศ.2560
รายการจัดซื้อจัดจ้างทั้งหมด ${fill(items.length, 2)} รายการ รายละเอียดแนบท้ายบันทึก เป็นจำนวนเงิน ${fill(baht(row.amount), 4)} บาท (${fill(bahtText(row.amount), 9)})</p>
<div style="margin-left:45%">${signBlock(row.requester_name, "ผู้รับผิดชอบงาน/โครงการ", row.submitted_at, Boolean(row.submitted_at))}</div>
<div class="grid2">
<div><p class="b">ความเห็นของหัวหน้าฝ่ายบริหารงาน${esc(DEPT_TITLE[row.department] || "")}</p>
<p>${box(signed("dept_head") && plan !== "out_of_plan")} เป็นไปตามแผน ได้รับจัดสรร ${fill(signed("dept_head") ? baht(snap.allocated) : "", 3)} บาท</p>
<p>ขอใช้ไปแล้ว ${fill(signed("dept_head") ? baht(snap.used_before) : "", 3)} บาท คงเหลือ ${fill(signed("dept_head") ? baht(remainingBefore) : "", 3)} บาท</p>
<p>${box(signed("dept_head") && plan === "out_of_plan")} นอกแผน</p>
${signBlock(names.head, "", at("dept_head"), signed("dept_head"))}</div>
<div><p class="b" style="text-align:center">รองผู้อำนวยการโรงเรียนบ้านป่าเด็ง</p>
<p style="text-align:center">${box(decided("dept_deputy") === "approve")} เห็นชอบ &nbsp;&nbsp;&nbsp; ${box(decided("dept_deputy") === "reject")} ไม่เห็นชอบ</p>
<p>${so.dept_deputy?.note ? esc(so.dept_deputy.note) : "&nbsp;"}</p>
${signBlock(names.deputy, "", at("dept_deputy"), signed("dept_deputy"))}</div></div>
<div class="sec"><p class="b">ความเห็นของฝ่ายบริหารงบประมาณ (งานการเงิน)</p>
<p>งาน/โครงการนี้ได้รับเงินจัดสรรตามแผนปฏิบัติการใช้เงินของโรงเรียนจำนวนทั้งสิ้น ${fill(financeDone ? baht(snap.allocated) : "", 4)} บาท</p>
<p>เบิกครั้งนี้แล้วคงเหลือ ${fill(financeDone ? baht(remaining) : "", 4)} บาท (${fill(financeDone ? bahtText(Math.max(0, remaining)) : "", 18)})</p></div>
<div class="grid2">
<div><p>${box(financeDone && sufficient)} มีงบประมาณเพียงพอต่อการขอเบิก</p><p>${box(financeDone && !sufficient)} มีงบประมาณไม่เพียงพอต่อการขอเบิก</p>
<p>&nbsp;&nbsp;&nbsp;&nbsp;ใช้งบประมาณจาก ${fill(financeDone && !sufficient ? financeRow?.note || "" : "", 6)}</p>
${signBlock(financeName, "เจ้าหน้าที่การเงิน", financeRow?.acted_at, financeDone && Boolean(financeRow?.acted_at))}</div>
<div><p class="b" style="text-align:center">ความเห็นของหัวหน้าฝ่ายบริหารงานงบประมาณ</p>
<p style="text-align:center">${box(signed("budget_head"))} รับทราบ</p><p>${so.budget_head?.note ? esc(so.budget_head.note) : "&nbsp;"}</p>
${signBlock(names.budgetHead, "", at("budget_head"), signed("budget_head"))}</div></div>
<div style="width:55%;margin:4px auto 0"><p class="b" style="text-align:center">รองผู้อำนวยการโรงเรียนบ้านป่าเด็ง</p>
<p style="text-align:center">${box(decided("budget_deputy") === "approve")} เห็นชอบ &nbsp;&nbsp;&nbsp; ${box(decided("budget_deputy") === "reject")} ไม่เห็นชอบ</p>
${signBlock(names.budgetDeputy, "", at("budget_deputy"), signed("budget_deputy"))}</div>
<div class="ref">อ้างอิงคำขอ ${esc(row.request_no)} · พิมพ์จากระบบโรงเรียนบ้านป่าเด็ง</div>
</section>
<section class="page">
<div class="sec"><p class="b">ความเห็นของผู้อำนวยการโรงเรียนบ้านป่าเด็ง</p>
<div class="row"><div><p>${box(directorSigned)} อนุมัติ &nbsp;&nbsp;&nbsp; ${box(so.director?.status === "rejected")} ไม่อนุมัติ</p>
<p>${fill(so.director?.note || "", 9)}</p></div>
<div style="width:52%">${signBlock(directorName, "", so.director?.acted_at || row.approved_at, directorSigned)}<div class="sign">ผู้อำนวยการโรงเรียนบ้านป่าเด็ง</div></div></div></div>
<div style="width:50%;margin-top:18px"><p class="b">ทราบ</p>${signBlock(procurementName, "", null, false)}<div class="sign">ตำแหน่ง เจ้าหน้าที่พัสดุ</div></div>
<div class="ref">อ้างอิงคำขอ ${esc(row.request_no)}</div>
</section>
<section class="page">
<h1 style="font-size:18pt;margin-top:4px">รายละเอียดของพัสดุที่ต้องการใช้</h1>
<p class="c">งาน/โครงการ ${esc(row.project_name)}</p>
<table><thead><tr><th style="width:8%">ที่</th><th>รายการ</th><th style="width:14%">จำนวน</th><th style="width:15%">ราคาต่อหน่วย</th><th style="width:15%">ราคารวม</th><th style="width:12%">หมายเหตุ</th></tr></thead>
<tbody>${itemRows}${"<tr><td></td><td></td><td></td><td></td><td></td><td></td></tr>".repeat(blank)}
<tr><td colspan="4" class="c b">รวมเงินทั้งสิ้น (${esc(bahtText(row.amount))})</td><td class="r b">${baht(row.amount)}</td><td></td></tr></tbody></table>
<div style="margin-left:45%;margin-top:18px">${signBlock(row.requester_name, "ผู้รับผิดชอบงาน/โครงการ", row.submitted_at, Boolean(row.submitted_at))}<div class="sign">ตำแหน่ง ${fill(position, 7)}</div></div>
<div class="ref">อ้างอิงคำขอ ${esc(row.request_no)}</div>
</section></body></html>`;
  return { row, html };
}
