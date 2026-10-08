import {mergeConfirmedPersonnel, personnelIdentity, keepPersonnelSeparate} from "./personnel-merge.js";
import { LICENSE_IMPORT_KEY, LICENSE_ROWS } from "../data/license-seed.js";

const initializationPromises = new WeakMap();

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
    personnel_type TEXT,
    position_number TEXT,
    position TEXT,
    academic_rank TEXT,
    subjects TEXT,
    phone TEXT,
    homeroom_classroom TEXT,
    departments TEXT,
    responsible_projects TEXT,
    teaching_periods INTEGER,
    appointment_date TEXT,
    service_start_date TEXT,
    education_level TEXT,
    major TEXT,
    institution TEXT,
    employment_status TEXT NOT NULL DEFAULT 'working',
    retirement_date TEXT,
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
  personnel_type: "TEXT",
  position_number: "TEXT",
  academic_rank: "TEXT",
  appointment_date: "TEXT",
  service_start_date: "TEXT",
  education_level: "TEXT",
  major: "TEXT",
  institution: "TEXT",
  employment_status: "TEXT NOT NULL DEFAULT 'working'",
  retirement_date: "TEXT",
  license_issue_date: "TEXT",
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
  return personnelIdentity(value);
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
  // บุคลากรที่ผู้ดูแลลบแล้ว (inactive แต่ยังผูกบัญชีไว้) — ห้ามสร้างทะเบียนใหม่ให้บัญชีนั้นซ้ำ
  const { results: removed } = await env.DB.prepare(
    "SELECT user_id FROM personnel_records WHERE status <> 'active' AND user_id IS NOT NULL"
  ).all();
  const removedUsers = new Set(removed.map((row) => row.user_id));
  const statements = [];

  // บัญชีที่ผูกกับทะเบียนบุคลากรอยู่แล้ว ไม่ต้องจับคู่ซ้ำ (ชื่อซ้ำ/สะกดต่างกันที่รอรวม ทำให้ผูกบัญชีเดียวซ้ำ 2 รายการ → user_id ชนกัน)
  const linkedUsers = new Set(people.filter((person) => person.user_id).map((person) => person.user_id));

  for (const user of users) {
    if (removedUsers.has(user.id) || linkedUsers.has(user.id)) continue;
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
  await mergeConfirmedPersonnel(env);
}

export function ensurePersonnelData(env) {
  if (!initializationPromises.has(env.DB)) {
    const initializationPromise = initialize(env).catch((error) => {
      initializationPromises.delete(env.DB);
      throw error;
    });
    initializationPromises.set(env.DB,initializationPromise);
  }
  return initializationPromises.get(env.DB);
}

export async function upsertSelfRegisteredPersonnel(env, profile) {
  await ensurePersonnelData(env);
  const email = String(profile.email || "").trim().toLowerCase();
  const fullName = String(profile.full_name || "").trim();
  const normalizedName = cleanName(fullName);

  const { results: people } = await env.DB.prepare(
    `SELECT p.id, p.user_id, p.email, p.full_name, p.phone, p.position,
            p.subjects, p.homeroom_classroom, p.departments, u.deleted_at AS account_deleted_at
     FROM personnel_records p LEFT JOIN users u ON u.id = p.user_id
     WHERE p.status = 'active'`
  ).all();
  const text = (value) => String(value || "").normalize("NFC").trim().replace(/\s+/g, " ").toLowerCase();
  const phone = (value) => String(value || "").replace(/\D/g, "");
  const departmentKey = (value) => String(value || "").split(",").map(text).filter(Boolean).sort().join(",");
  const emailMatches = people.filter((row) => text(row.email) === email);
  const nameMatches = keepPersonnelSeparate(fullName) ? [] : people.filter((row) => comparableName(row.full_name) === comparableName(fullName));
  // A phone number plus at least two independent profile fields can identify a renamed person.
  const detailMatches = people.filter((row) => {
    if (keepPersonnelSeparate(fullName)) return false;
    if (phone(profile.phone).length < 8 || phone(row.phone) !== phone(profile.phone)) return false;
    const fields = ["position", "subjects", "homeroom_classroom"];
    let matches = fields.filter((key) => text(profile[key]) && text(profile[key]) === text(row[key])).length;
    if (departmentKey(profile.departments) && departmentKey(profile.departments) === departmentKey(row.departments)) matches++;
    return matches >= 2;
  });
  const candidates = emailMatches.length ? emailMatches : nameMatches.length ? nameMatches : detailMatches;
  if (candidates.length > 1) throw new Error("PERSONNEL_AMBIGUOUS_MATCH");
  const person = candidates[0] || null;
  const otherMatches = [...nameMatches, ...detailMatches];
  if (person && otherMatches.some((row) => row.id !== person.id)) {
    throw new Error("PERSONNEL_AMBIGUOUS_MATCH");
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
    await env.DB.batch([env.DB.prepare(
      `UPDATE personnel_records SET
         user_id = ?, email = ?, full_name = ?, position = ?, subjects = COALESCE(?, subjects),
         phone = ?, homeroom_classroom = COALESCE(?, homeroom_classroom), departments = ?,
         responsible_projects = COALESCE(?, responsible_projects),
         teaching_periods = COALESCE(?, teaching_periods), updated_at = datetime('now')
       WHERE id = ? AND (user_id IS NULL OR user_id = ?)`
    ).bind(
      person.account_deleted_at ? profile.user_id : person.user_id || profile.user_id, email, fullName, values[0], values[1], values[2], values[3],
      values[4], values[5], values[6], person.id, person.user_id),
      env.DB.prepare(`INSERT INTO personnel_accounts(user_id,personnel_id) VALUES(?,?)
        ON CONFLICT(user_id) DO UPDATE SET personnel_id=excluded.personnel_id`).bind(profile.user_id,person.id),
    ]);
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
  await env.DB.prepare("INSERT INTO personnel_accounts(user_id,personnel_id) VALUES(?,?)")
    .bind(profile.user_id,result.meta.last_row_id).run();
  return result.meta.last_row_id;
}
