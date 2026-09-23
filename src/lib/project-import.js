const DEPARTMENTS = new Set(["academic", "early_childhood", "budget", "personnel", "general"]);
const storedDepartment = (department) => department === "early_childhood" ? "academic" : department;
const managementArea = (department) => department === "early_childhood" ? "early_childhood" : null;

function text(value, maxLength = 1000) {
  const cleaned = String(value ?? "").trim();
  return cleaned ? cleaned.slice(0, maxLength) : null;
}

function projectKey(row) {
  return `${String(row.department || "").trim().toLowerCase()}|${Number(row.fiscal_year)}|${String(row.name || "").trim().toLocaleLowerCase("th")}`;
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

async function removeEmptyDuplicateProjects(env, canonicalId, duplicateIds) {
  let removed = 0;
  for (const duplicateId of duplicateIds) {
    const dependencies = await env.DB.prepare(
      `SELECT
        (SELECT COUNT(*) FROM project_expenses WHERE project_id = ?) AS expense_count,
        (SELECT COUNT(*) FROM documents WHERE project_id = ?) AS document_count`
    ).bind(duplicateId, duplicateId).first();
    if (Number(dependencies?.expense_count || 0) || Number(dependencies?.document_count || 0)) continue;
    await env.DB.prepare("DELETE FROM project_owners WHERE project_id = ?").bind(duplicateId).run();
    await env.DB.prepare("DELETE FROM projects WHERE id = ?").bind(duplicateId).run();
    removed += 1;
  }
  return removed;
}

export async function upsertProjectRow(env, rawRow, createdBy, explicitOwnerIds = null) {
  const department = String(rawRow.department || "").trim().toLowerCase();
  const name = text(rawRow.name, 300);
  const fiscalYear = Number(rawRow.fiscal_year);
  const budgetAmount = rawRow.budget_amount === "" || rawRow.budget_amount == null ? 0 : Number(rawRow.budget_amount);
  if (!DEPARTMENTS.has(department)) throw new Error("ฝ่ายงานไม่ถูกต้อง");
  if (!name) throw new Error("กรุณากรอกชื่อโครงการ");
  if (!Number.isInteger(fiscalYear) || fiscalYear < 2500 || fiscalYear > 3000) throw new Error("ปีงบประมาณไม่ถูกต้อง");
  if (!Number.isFinite(budgetAmount) || budgetAmount < 0) throw new Error("ยอดงบประมาณต้องเป็นตัวเลขตั้งแต่ 0 ขึ้นไป");

  const ownerIds = explicitOwnerIds === null
    ? await resolveOwnerIds(env, parseOwnerEmails(rawRow.owner_emails))
    : [...new Set(explicitOwnerIds.map(Number).filter(Number.isInteger))];
  const { results: matches } = await env.DB.prepare(
    `SELECT id FROM projects
     WHERE COALESCE(management_area,department) = ? AND fiscal_year = ? AND LOWER(TRIM(name)) = LOWER(TRIM(?))
     ORDER BY id ASC`
  ).bind(department, fiscalYear, name).all();

  let projectId;
  let created;
  let duplicatesRemoved = 0;
  if (matches.length) {
    projectId = Number(matches[0].id);
    created = false;
    await env.DB.prepare(
      `UPDATE projects SET department = ?, management_area = ?, name = ?, budget_amount = ?, description = ? WHERE id = ?`
    ).bind(storedDepartment(department), managementArea(department), name, budgetAmount, text(rawRow.description, 3000), projectId).run();
    duplicatesRemoved = await removeEmptyDuplicateProjects(env, projectId, matches.slice(1).map((row) => Number(row.id)));
  } else {
    const result = await env.DB.prepare(
      `INSERT INTO projects (department, management_area, name, budget_amount, spent_amount, fiscal_year, description, created_by)
       VALUES (?, ?, ?, ?, 0, ?, ?, ?)`
    ).bind(storedDepartment(department), managementArea(department), name, budgetAmount, fiscalYear, text(rawRow.description, 3000), createdBy).run();
    projectId = Number(result.meta.last_row_id);
    created = true;
  }

  await env.DB.prepare("DELETE FROM project_owners WHERE project_id = ?").bind(projectId).run();
  if (ownerIds.length) {
    await env.DB.batch(ownerIds.map((ownerId) =>
      env.DB.prepare("INSERT OR IGNORE INTO project_owners (project_id, user_id) VALUES (?, ?)").bind(projectId, ownerId)
    ));
  }
  return { id: projectId, created, updated: !created, duplicates_removed: duplicatesRemoved };
}

export async function importProjectRows(env, rows, createdBy) {
  const latestRows = new Map();
  rows.forEach((row, index) => latestRows.set(projectKey(row), { row, index }));
  let created = 0;
  let updated = 0;
  let duplicates_removed = 0;
  const skipped = [];
  for (const { row, index } of latestRows.values()) {
    try {
      const result = await upsertProjectRow(env, row, createdBy);
      created += result.created ? 1 : 0;
      updated += result.updated ? 1 : 0;
      duplicates_removed += result.duplicates_removed;
    } catch (error) {
      skipped.push({ row: index + 1, reason: error.message || "นำเข้าข้อมูลไม่สำเร็จ" });
    }
  }
  return { created, updated, duplicates_removed, superseded: rows.length - latestRows.size, skipped };
}
