import { LICENSE_IMPORT_KEY, LICENSE_ROWS } from "../data/license-seed.js";

let initializationPromise;

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS personnel_records (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER UNIQUE REFERENCES users(id),
    prefix TEXT,
    first_name TEXT,
    last_name TEXT,
    full_name TEXT NOT NULL,
    normalized_name TEXT NOT NULL UNIQUE,
    email TEXT,
    position TEXT,
    subjects TEXT,
    phone TEXT,
    homeroom_classroom TEXT,
    departments TEXT,
    responsible_projects TEXT,
    teaching_periods INTEGER,
    license_issue_date TEXT,
    license_expiry_date TEXT,
    license_issue_raw TEXT,
    license_expiry_raw TEXT,
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','inactive')),
    source_file TEXT,
    source_sheet TEXT,
    source_row INTEGER,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`,
  `CREATE TABLE IF NOT EXISTS personnel_imports (
    import_key TEXT PRIMARY KEY,
    source_file TEXT NOT NULL,
    record_count INTEGER NOT NULL,
    imported_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`,
  "CREATE INDEX IF NOT EXISTS idx_personnel_status ON personnel_records(status)",
  "CREATE INDEX IF NOT EXISTS idx_personnel_license_expiry ON personnel_records(license_expiry_date)",
];

// Older D1 databases already have personnel_records; CREATE TABLE alone cannot add columns.
const PERSONNEL_ADDITIONAL_COLUMNS = {
  departments: "TEXT",
  responsible_projects: "TEXT",
  teaching_periods: "INTEGER",
};

export async function ensurePersonnelColumns(env) {
  const { results } = await env.DB.prepare("PRAGMA table_info(personnel_records)").all();
  const existing = new Set(results.map(({ name }) => name));
  for (const [name, type] of Object.entries(PERSONNEL_ADDITIONAL_COLUMNS)) {
    if (!existing.has(name)) {
      try {
        await env.DB.prepare(`ALTER TABLE personnel_records ADD COLUMN ${name} ${type}`).run();
      } catch (error) {
        // Another Worker instance may have applied the same migration concurrently.
        if (!/duplicate column name/i.test(String(error?.message || error))) throw error;
      }
    }
  }
}

function cleanName(value) {
  return String(value || "")
    .normalize("NFC")
    .replace(/[\u200b-\u200f\u2060\ufeff]/g, "")
    .replace(/[\s.]+/g, "")
    .toLowerCase();
}

function comparableName(value) {
  return cleanName(value).replace(
    /^(?:ว่าที่ร้อยตรีหญิง|ว่าที่รตหญิง|ว่าที่ร้อยตรี|ว่าที่รต|นางสาว|นาง|นาย)/,
    ""
  );
}

async function seedLicenseRows(env) {
  const imported = await env.DB.prepare("SELECT import_key FROM personnel_imports WHERE import_key = ?")
    .bind(LICENSE_IMPORT_KEY)
    .first();
  if (imported) return;

  const statements = LICENSE_ROWS.map((row) => {
    const [prefix, firstName, lastName, fullName, normalizedName, issueDate, expiryDate, issueRaw, expiryRaw, sourceRow] = row;
    return env.DB.prepare(
      `INSERT INTO personnel_records (
         prefix, first_name, last_name, full_name, normalized_name,
         license_issue_date, license_expiry_date, license_issue_raw, license_expiry_raw,
         source_file, source_sheet, source_row
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(normalized_name) DO UPDATE SET
         prefix = excluded.prefix,
         first_name = excluded.first_name,
         last_name = COALESCE(excluded.last_name, personnel_records.last_name),
         full_name = excluded.full_name,
         license_issue_date = COALESCE(excluded.license_issue_date, personnel_records.license_issue_date),
         license_expiry_date = COALESCE(excluded.license_expiry_date, personnel_records.license_expiry_date),
         license_issue_raw = COALESCE(excluded.license_issue_raw, personnel_records.license_issue_raw),
         license_expiry_raw = COALESCE(excluded.license_expiry_raw, personnel_records.license_expiry_raw),
         source_file = excluded.source_file,
         source_sheet = excluded.source_sheet,
         source_row = excluded.source_row,
         updated_at = datetime('now')`
    ).bind(
      prefix, firstName, lastName, fullName, normalizedName,
      issueDate, expiryDate, issueRaw, expiryRaw,
      "งานบุคคลรวม69 (1).xlsx", "ใบประกอบ(อ้อย)", sourceRow
    );
  });
  await env.DB.batch(statements);
  await env.DB.prepare(
    "INSERT OR IGNORE INTO personnel_imports (import_key, source_file, record_count) VALUES (?, ?, ?)"
  ).bind(LICENSE_IMPORT_KEY, "งานบุคคลรวม69 (1).xlsx", LICENSE_ROWS.length).run();
}

async function linkExistingAccounts(env) {
  const { results: users } = await env.DB.prepare(
    `SELECT u.id, u.full_name, u.email,
            sp.position, sp.subjects, sp.phone, sp.homeroom_classroom, sp.license_expiry_date
     FROM users u
     LEFT JOIN staff_profiles sp ON sp.user_id = u.id
     WHERE u.status = 'active' AND u.role IS NOT NULL`
  ).all();
  if (!users.length) return;

  const { results: people } = await env.DB.prepare(
    "SELECT id, user_id, full_name FROM personnel_records WHERE status = 'active'"
  ).all();
  const peopleByName = new Map(people.map((person) => [comparableName(person.full_name), person]));
  const statements = [];

  for (const user of users) {
    const person = peopleByName.get(comparableName(user.full_name));
    if (person && (!person.user_id || person.user_id === user.id)) {
      statements.push(env.DB.prepare(
        `UPDATE personnel_records SET
           user_id = ?, email = COALESCE(email, ?), position = COALESCE(position, ?),
           subjects = COALESCE(subjects, ?), phone = COALESCE(phone, ?),
           homeroom_classroom = COALESCE(homeroom_classroom, ?),
           license_expiry_date = COALESCE(license_expiry_date, ?), updated_at = datetime('now')
         WHERE id = ?`
      ).bind(
        user.id, user.email, user.position, user.subjects, user.phone,
        user.homeroom_classroom, user.license_expiry_date, person.id
      ));
    } else if (!person) {
      statements.push(env.DB.prepare(
        `INSERT OR IGNORE INTO personnel_records (
           user_id, full_name, normalized_name, email, position, subjects, phone,
           homeroom_classroom, license_expiry_date, source_file
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'บัญชีผู้ใช้เดิม')`
      ).bind(
        user.id, user.full_name, `user:${user.id}`, user.email, user.position,
        user.subjects, user.phone, user.homeroom_classroom, user.license_expiry_date
      ));
    }
  }
  if (statements.length) await env.DB.batch(statements);
}

async function initialize(env) {
  await env.DB.batch(SCHEMA.map((sql) => env.DB.prepare(sql)));
  await ensurePersonnelColumns(env);
  await seedLicenseRows(env);
  await linkExistingAccounts(env);
}

export function ensurePersonnelData(env) {
  if (!initializationPromise) {
    initializationPromise = initialize(env).catch((error) => {
      initializationPromise = null;
      throw error;
    });
  }
  return initializationPromise;
}

export async function upsertSelfRegisteredPersonnel(env, profile) {
  await ensurePersonnelData(env);
  const email = String(profile.email || "").trim().toLowerCase();
  const fullName = String(profile.full_name || "").trim();
  const normalizedName = cleanName(fullName);

  let person = await env.DB.prepare(
    "SELECT id, user_id, email, full_name FROM personnel_records WHERE lower(email) = ? AND status = 'active'"
  ).bind(email).first();
  let linkedAccountDeleted = false;
  if (person?.user_id && Number(person.user_id) !== Number(profile.user_id)) {
    const linkedAccount = await env.DB.prepare(
      "SELECT id, deleted_at FROM users WHERE id = ?"
    ).bind(person.user_id).first();
    linkedAccountDeleted = Boolean(linkedAccount?.deleted_at);
  }
  if (person && comparableName(person.full_name) !== comparableName(fullName) && !linkedAccountDeleted) {
    throw new Error("PERSONNEL_EMAIL_CONFLICT");
  }
  if (!person) {
    const sameName = await env.DB.prepare(
      "SELECT id, user_id, email, full_name FROM personnel_records WHERE normalized_name = ? AND status = 'active'"
    ).bind(normalizedName).first();
    // ใช้ทะเบียนเดิมเฉพาะรายการที่ยังไม่มีบัญชีและอีเมลเท่านั้น
    // บุคลากรคนละคนอาจมีชื่อ-นามสกุลซ้ำกันได้ จึงต้องแยกด้วยอีเมล/บัญชี
    if (sameName && !sameName.user_id && !String(sameName.email || "").trim()) person = sameName;
  }
  if (person && person.user_id && Number(person.user_id) !== Number(profile.user_id) && !linkedAccountDeleted) {
    throw new Error("PERSONNEL_ACCOUNT_CONFLICT");
  }

  const values = [
    profile.position || null,
    profile.subjects || null,
    profile.phone || null,
    profile.homeroom_classroom || null,
    profile.departments || null,
    profile.responsible_projects || null,
    profile.teaching_periods ?? null,
  ];
  if (person) {
    await env.DB.prepare(
      `UPDATE personnel_records SET
         user_id = ?, email = ?, full_name = ?, position = ?, subjects = COALESCE(?, subjects),
         phone = ?, homeroom_classroom = COALESCE(?, homeroom_classroom), departments = ?,
         responsible_projects = COALESCE(?, responsible_projects),
         teaching_periods = COALESCE(?, teaching_periods), updated_at = datetime('now')
       WHERE id = ?`
    ).bind(
      profile.user_id, email, fullName, values[0], values[1], values[2], values[3],
      values[4], values[5], values[6], person.id
    ).run();
    return person.id;
  }

  const normalizedKeyExists = await env.DB.prepare(
    "SELECT id FROM personnel_records WHERE normalized_name = ?"
  ).bind(normalizedName).first();
  const uniqueNormalizedName = normalizedKeyExists
    ? `${normalizedName}#user:${profile.user_id}`
    : normalizedName;
  const result = await env.DB.prepare(
    `INSERT INTO personnel_records
       (user_id, full_name, normalized_name, email, position, subjects, phone,
        homeroom_classroom, departments, responsible_projects, teaching_periods, source_file)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'สมัครสมาชิกด้วยตนเอง')`
  ).bind(
    profile.user_id, fullName, uniqueNormalizedName, email, values[0], values[1], values[2],
    values[3], values[4], values[5], values[6]
  ).run();
  return result.meta.last_row_id;
}
