import { money } from './project-finance.js';
const DEPARTMENTS = new Set(["academic", "early_childhood", "budget", "personnel", "general"]);
const storedDepartment = (department) => department === "early_childhood" ? "academic" : department;
const managementArea = (department) => department === "early_childhood" ? "early_childhood" : null;

function text(value, maxLength = 1000) {
  const cleaned = String(value ?? "").trim();
  return cleaned ? cleaned.slice(0, maxLength) : null;
}

function parseOwnerEmails(value) {
  return [...new Set(String(value || "")
    .split(/[;,\n]+/)
    .map((email) => email.trim().toLowerCase())
    .filter(Boolean))];
}

async function resolveOwnerIds(env, ownerEmails) {
  if (!ownerEmails.length) return [];
  const placeholders = ownerEmails.map(() => "?").join(",");
  const { results } = await env.DB.prepare(
    `SELECT id, LOWER(email) AS email FROM users
     WHERE status = 'active' AND role IS NOT NULL AND LOWER(email) IN (${placeholders})`
  ).bind(...ownerEmails).all();
  const found = new Map(results.map((row) => [row.email, Number(row.id)]));
  const missing = ownerEmails.filter((email) => !found.has(email));
  if (missing.length) throw new Error(`ไม่พบบัญชีผู้รับผิดชอบที่ใช้งานอยู่: ${missing.join(", ")}`);
  return ownerEmails.map((email) => found.get(email));
}

// Name is a label, never a project identifier. Compare the actual details and owners.
export async function findDuplicateProject(env, row, ownerIds, excludeId = 0) {
  const { results } = await env.DB.prepare(`SELECT * FROM projects
    WHERE COALESCE(management_area,department)=? AND fiscal_year=?
      AND LOWER(TRIM(name))=LOWER(TRIM(?)) AND id<>? ORDER BY id`)
    .bind(row.department, Number(row.fiscal_year), text(row.name,300), excludeId).all();
  const owners = [...new Set(ownerIds.map(Number))].sort((a,b)=>a-b);
  for (const p of results) {
    if (Number(p.budget_amount) !== Number(row.budget_amount || 0)
      || text(p.description,3000) !== text(row.description,3000)
      || (p.funding_type || null) !== (row.funding_type || null)
      || (p.status || 'ongoing') !== (row.status || 'ongoing')
      || Number(p.progress_percent || 0) !== Number(row.progress_percent || 0)
      || Number(p.spent_amount || 0) !== Number(row.spent_amount || 0)) continue;
    const {results: assigned} = await env.DB.prepare('SELECT user_id FROM project_owners WHERE project_id=? ORDER BY user_id').bind(p.id).all();
    if (JSON.stringify(assigned.map(o=>Number(o.user_id))) === JSON.stringify(owners)) return p;
  }
  return null;
}

export async function upsertProjectRow(env, rawRow, createdBy, explicitOwnerIds = null) {
  const department = String(rawRow.department || "").trim().toLowerCase();
  const name = text(rawRow.name, 300);
  const fiscalYear = Number(rawRow.fiscal_year);
  const budgetAmount = rawRow.budget_amount === "" || rawRow.budget_amount == null ? 0 : money(rawRow.budget_amount);
  if (!DEPARTMENTS.has(department)) throw new Error("ฝ่ายงานไม่ถูกต้อง");
  if (!name) throw new Error("กรุณากรอกชื่อโครงการ");
  if (!Number.isInteger(fiscalYear) || fiscalYear < 2500 || fiscalYear > 3000) throw new Error("ปีงบประมาณไม่ถูกต้อง");
  if (!Number.isFinite(budgetAmount) || budgetAmount < 0) throw new Error("ยอดงบประมาณต้องเป็นตัวเลขตั้งแต่ 0 ขึ้นไป");

  const fundingType = ["subsidy","free_education","school_income"].includes(rawRow.funding_type) ? rawRow.funding_type : null;
  const ownerIds = explicitOwnerIds === null
    ? await resolveOwnerIds(env, parseOwnerEmails(rawRow.owner_emails))
    : [...new Set(explicitOwnerIds.map(Number).filter(Number.isInteger))];
  const row = { ...rawRow, department, name, fiscal_year:fiscalYear, budget_amount:budgetAmount, funding_type:fundingType };
  const duplicate = await findDuplicateProject(env,row,ownerIds);
  if (duplicate && rawRow.confirm_duplicate !== true) {
    const error = new Error('ชื่อโครงการและรายละเอียดตรงกับโครงการที่มีอยู่ แน่ใจใช่ไหมที่จะกดยืนยัน?');
    error.code = 'duplicate_project'; error.project_id = duplicate.id;
    throw error;
  }
  const result = await env.DB.prepare(
    `INSERT INTO projects (department, management_area, name, budget_amount, spent_amount, fiscal_year, description, created_by, funding_type)
     VALUES (?, ?, ?, ?, 0, ?, ?, ?, ?)`
  ).bind(storedDepartment(department), managementArea(department), name, budgetAmount, fiscalYear, text(rawRow.description, 3000), createdBy, fundingType).run();
  const projectId = Number(result.meta.last_row_id);

  await env.DB.prepare("DELETE FROM project_owners WHERE project_id = ?").bind(projectId).run();
  if (ownerIds.length) {
    await env.DB.batch(ownerIds.map((ownerId) =>
      env.DB.prepare("INSERT OR IGNORE INTO project_owners (project_id, user_id) VALUES (?, ?)").bind(projectId, ownerId)
    ));
  }
  return { id: projectId, created: true, updated: false, duplicates_removed: 0 };
}

export async function importProjectRows(env, rows, createdBy) {
  let created = 0;
  const skipped = [];
  for (let index=0; index<rows.length; index++) {
    try {
      await upsertProjectRow(env, rows[index], createdBy);
      created++;
    } catch (error) {
      skipped.push({ row:index+1, reason:error.message || 'นำเข้าข้อมูลไม่สำเร็จ', ...(error.code ? {code:error.code} : {}) });
    }
  }
  return { created, updated:0, duplicates_removed:0, superseded:0, skipped };
}
