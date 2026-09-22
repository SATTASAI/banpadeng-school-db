import {
  generateSalt,
  hashPassword,
  verifyPassword,
  signJWT,
  buildSessionCookie,
  buildClearCookie,
} from "./lib/crypto.js";
import { getCurrentUser, jsonResponse, isAdmin } from "./lib/auth.js";
import { ensurePersonnelData, upsertSelfRegisteredPersonnel } from "./lib/personnel-data.js";
import { importStaffRows } from "./lib/staff-import.js";
import { importProjectRows, upsertProjectRow } from "./lib/project-import.js";
import { ensureAcademicData, getCurrentAcademicPeriod } from "./lib/academic-data.js";
import {
  ACADEMIC_CENTERS,
  getAcademicCenter,
  getAcademicTopicKeys,
  resolveAcademicCenterKey,
} from "./lib/academic-registry.js";
import { handleAcademicPeriodRoute } from "./routes/academic-periods.js";
import { handleBackupExport, getBackupOverview } from "./routes/backup-export.js";
import { handleDriveAudit } from "./routes/drive-audit.js";
import { handleDriveBackupManifest, handleDriveBackupFile } from "./routes/drive-backup.js";
import { handleLearnerAnalysisRoute } from "./routes/learner-analysis.js";
import { handleTimetableSyncRoute } from "./routes/timetable-sync.js";
import { handleTimetableRoute } from "./routes/timetable.js";
import { handleSchoolBankRoute } from "./routes/school-bank.js";
import { ensureBudgetSchema, handleBudgetRoute } from "./routes/budget.js";

let extendedSchemaReady = false;
let lineSchemaReady = false;
async function ensureUserDeletionSchema(env) {
  const { results } = await env.DB.prepare("PRAGMA table_info(users)").all();
  const columns = new Set(results.map((column) => column.name));
  if (!columns.has("deleted_at")) await env.DB.prepare("ALTER TABLE users ADD COLUMN deleted_at TEXT").run();
  if (!columns.has("deleted_by")) await env.DB.prepare("ALTER TABLE users ADD COLUMN deleted_by INTEGER REFERENCES users(id)").run();
}
async function ensureProjectExpenseSchema(env) {
  await env.DB.batch([
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS project_expenses (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      expense_date TEXT NOT NULL, document_no TEXT, category TEXT NOT NULL DEFAULT 'other',
      description TEXT NOT NULL, payee TEXT, amount REAL NOT NULL CHECK (amount > 0),
      status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('draft','pending','approved','paid','rejected','cancelled')),
      attachment_url TEXT, notes TEXT, created_by INTEGER NOT NULL REFERENCES users(id),
      approved_by INTEGER REFERENCES users(id), approved_at TEXT, paid_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')))`),
    env.DB.prepare("CREATE INDEX IF NOT EXISTS idx_project_expenses_project ON project_expenses(project_id, expense_date DESC)"),
    env.DB.prepare("CREATE INDEX IF NOT EXISTS idx_project_expenses_status ON project_expenses(status, expense_date DESC)"),
    env.DB.prepare("CREATE UNIQUE INDEX IF NOT EXISTS idx_project_expenses_opening ON project_expenses(project_id) WHERE category = 'opening_balance'"),
    env.DB.prepare(`CREATE TRIGGER IF NOT EXISTS trg_project_expenses_insert AFTER INSERT ON project_expenses BEGIN
      UPDATE projects SET spent_amount = COALESCE((SELECT SUM(amount) FROM project_expenses WHERE project_id = NEW.project_id AND status = 'paid'), 0)
      WHERE id = NEW.project_id; END`),
    env.DB.prepare(`CREATE TRIGGER IF NOT EXISTS trg_project_expenses_update AFTER UPDATE ON project_expenses BEGIN
      UPDATE projects SET spent_amount = COALESCE((SELECT SUM(amount) FROM project_expenses WHERE project_id = OLD.project_id AND status = 'paid'), 0)
      WHERE id = OLD.project_id;
      UPDATE projects SET spent_amount = COALESCE((SELECT SUM(amount) FROM project_expenses WHERE project_id = NEW.project_id AND status = 'paid'), 0)
      WHERE id = NEW.project_id; END`),
    env.DB.prepare(`CREATE TRIGGER IF NOT EXISTS trg_project_expenses_delete AFTER DELETE ON project_expenses BEGIN
      UPDATE projects SET spent_amount = COALESCE((SELECT SUM(amount) FROM project_expenses WHERE project_id = OLD.project_id AND status = 'paid'), 0)
      WHERE id = OLD.project_id; END`),
  ]);

  // รักษายอดใช้จริงเดิม: แปลงเป็นรายการยกมาเพียงครั้งเดียวก่อนให้ trigger เป็นผู้คำนวณต่อ
  await env.DB.prepare(
    `INSERT OR IGNORE INTO project_expenses
       (project_id, expense_date, document_no, category, description, amount, status, notes, created_by, approved_by, approved_at, paid_at)
     SELECT p.id, date('now'), 'OPENING-' || p.id, 'opening_balance',
            'ยอดใช้จริงยกมาก่อนเปิดทะเบียนเบิกจ่าย', p.spent_amount, 'paid',
            'ระบบสร้างอัตโนมัติเพื่อรักษายอดเดิม', p.created_by, p.created_by, datetime('now'), datetime('now')
     FROM projects p
     WHERE COALESCE(p.spent_amount, 0) > 0
       AND NOT EXISTS (SELECT 1 FROM project_expenses e WHERE e.project_id = p.id)`
  ).run();

  await env.DB.prepare(
    `UPDATE projects
     SET spent_amount = COALESCE((
       SELECT SUM(e.amount) FROM project_expenses e
       WHERE e.project_id = projects.id AND e.status = 'paid'
     ), 0)`
  ).run();
}

async function ensureInventorySchema(env) {
  await env.DB.batch([
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS inventory_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT, item_code TEXT NOT NULL UNIQUE, name TEXT NOT NULL,
      item_type TEXT NOT NULL CHECK (item_type IN ('material','equipment')), category TEXT, unit TEXT NOT NULL DEFAULT 'ชิ้น',
      department TEXT NOT NULL DEFAULT 'budget', location TEXT, custodian TEXT,
      current_quantity REAL NOT NULL DEFAULT 0 CHECK (current_quantity >= 0),
      minimum_quantity REAL NOT NULL DEFAULT 0 CHECK (minimum_quantity >= 0), unit_price REAL NOT NULL DEFAULT 0 CHECK (unit_price >= 0),
      brand_model TEXT, serial_number TEXT, purchase_date TEXT, fiscal_year TEXT, budget_source TEXT, vendor TEXT, warranty_expiry TEXT,
      item_condition TEXT NOT NULL DEFAULT 'good', status TEXT NOT NULL DEFAULT 'active', notes TEXT,
      created_by INTEGER NOT NULL REFERENCES users(id), created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')))`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS inventory_transactions (
      id INTEGER PRIMARY KEY AUTOINCREMENT, item_id INTEGER NOT NULL REFERENCES inventory_items(id) ON DELETE CASCADE,
      transaction_type TEXT NOT NULL, transaction_date TEXT NOT NULL, document_no TEXT, quantity REAL NOT NULL CHECK (quantity > 0),
      quantity_change REAL NOT NULL, related_transaction_id INTEGER REFERENCES inventory_transactions(id), unit_price REAL,
      from_location TEXT, to_location TEXT, recipient TEXT, due_date TEXT, notes TEXT,
      created_by INTEGER NOT NULL REFERENCES users(id), created_at TEXT NOT NULL DEFAULT (datetime('now')))`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS inventory_inspections (
      id INTEGER PRIMARY KEY AUTOINCREMENT, item_id INTEGER NOT NULL REFERENCES inventory_items(id) ON DELETE CASCADE,
      inspection_date TEXT NOT NULL, quantity_found REAL NOT NULL CHECK (quantity_found >= 0), item_condition TEXT NOT NULL,
      result TEXT NOT NULL, location TEXT, inspector TEXT, notes TEXT, next_inspection_date TEXT,
      created_by INTEGER NOT NULL REFERENCES users(id), created_at TEXT NOT NULL DEFAULT (datetime('now')))`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS file_attachments (
      id INTEGER PRIMARY KEY AUTOINCREMENT, entity_type TEXT NOT NULL, entity_id INTEGER NOT NULL, object_key TEXT NOT NULL UNIQUE,
      file_name TEXT NOT NULL, mime_type TEXT NOT NULL, file_size INTEGER NOT NULL, uploaded_by INTEGER NOT NULL REFERENCES users(id),
      created_at TEXT NOT NULL DEFAULT (datetime('now')), UNIQUE(entity_type, entity_id))`),
    env.DB.prepare("CREATE INDEX IF NOT EXISTS idx_inventory_items_type ON inventory_items(item_type, status)"),
    env.DB.prepare("CREATE INDEX IF NOT EXISTS idx_inventory_items_department ON inventory_items(department, location)"),
    env.DB.prepare("CREATE INDEX IF NOT EXISTS idx_inventory_transactions_item ON inventory_transactions(item_id, transaction_date DESC)"),
    env.DB.prepare("CREATE INDEX IF NOT EXISTS idx_inventory_inspections_item ON inventory_inspections(item_id, inspection_date DESC)"),
    env.DB.prepare("CREATE INDEX IF NOT EXISTS idx_file_attachments_entity ON file_attachments(entity_type, entity_id)"),
    env.DB.prepare(`CREATE TRIGGER IF NOT EXISTS trg_inventory_transaction_before_insert
      BEFORE INSERT ON inventory_transactions WHEN NEW.quantity_change < 0
      AND COALESCE((SELECT current_quantity FROM inventory_items WHERE id = NEW.item_id), 0) + NEW.quantity_change < 0
      BEGIN SELECT RAISE(ABORT, 'INSUFFICIENT_INVENTORY'); END`),
    env.DB.prepare(`CREATE TRIGGER IF NOT EXISTS trg_inventory_transaction_after_insert
      AFTER INSERT ON inventory_transactions BEGIN
      UPDATE inventory_items SET current_quantity = current_quantity + NEW.quantity_change,
      unit_price = CASE WHEN NEW.unit_price IS NOT NULL AND NEW.unit_price >= 0 THEN NEW.unit_price ELSE unit_price END,
      updated_at = datetime('now') WHERE id = NEW.item_id; END`),
  ]);
}

// เพิ่มข้อมูลผู้ให้บริการจัดเก็บไฟล์โดยไม่ทำลายรายการแนบไฟล์ R2 เดิม
async function ensureAttachmentStorageSchema(env) {
  const columns = [
    ["storage_provider", "TEXT NOT NULL DEFAULT 'r2'"],
    ["drive_file_id", "TEXT"],
    ["drive_web_url", "TEXT"],
    ["storage_error", "TEXT"],
    ["file_hash", "TEXT"],
  ];
  for (const [name, definition] of columns) {
    try {
      await env.DB.prepare(`ALTER TABLE file_attachments ADD COLUMN ${name} ${definition}`).run();
    } catch (error) {
      // คอลัมน์มีอยู่แล้วจากการ deploy ก่อนหน้า ให้ทำงานต่อได้
      if (!String(error?.message || error).toLowerCase().includes("duplicate column")) throw error;
    }
  }
  await env.DB.prepare("CREATE INDEX IF NOT EXISTS idx_file_attachments_storage ON file_attachments(storage_provider, drive_file_id)").run();
  await env.DB.prepare("CREATE INDEX IF NOT EXISTS idx_file_attachments_hash ON file_attachments(file_hash)").run();
}

// เพิ่มสถานะการแนบไฟล์และการเก็บรายการซ้ำ โดยไม่ลบทะเบียนเอกสารเดิม
async function ensureDocumentWorkflowSchema(env) {
  const columns = [
    ["record_status", "TEXT NOT NULL DEFAULT 'active'"],
    ["duplicate_of_id", "INTEGER"],
    ["archived_at", "TEXT"],
    ["archive_reason", "TEXT"],
    ["upload_status", "TEXT NOT NULL DEFAULT 'none'"],
    ["upload_error", "TEXT"],
    ["attachment_updated_at", "TEXT"],
  ];
  for (const [name, definition] of columns) {
    try {
      await env.DB.prepare(`ALTER TABLE documents ADD COLUMN ${name} ${definition}`).run();
    } catch (error) {
      if (!String(error?.message || error).toLowerCase().includes("duplicate column")) throw error;
    }
  }
  await env.DB.prepare("CREATE INDEX IF NOT EXISTS idx_documents_record_status ON documents(record_status, updated_at DESC)").run();
  await env.DB.prepare("CREATE INDEX IF NOT EXISTS idx_documents_duplicate ON documents(duplicate_of_id)").run();
}

async function ensureMaintenanceSchema(env) {
  await env.DB.batch([
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS facilities (
      id INTEGER PRIMARY KEY AUTOINCREMENT, facility_code TEXT NOT NULL UNIQUE, name TEXT NOT NULL, facility_type TEXT NOT NULL,
      building_name TEXT, floor TEXT, location_detail TEXT, responsible_person TEXT, status TEXT NOT NULL DEFAULT 'active', notes TEXT,
      created_by INTEGER NOT NULL REFERENCES users(id), created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')))`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS maintenance_counters (
      buddhist_year INTEGER PRIMARY KEY, last_number INTEGER NOT NULL DEFAULT 0)`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS maintenance_requests (
      id INTEGER PRIMARY KEY AUTOINCREMENT, request_no TEXT NOT NULL UNIQUE, facility_id INTEGER REFERENCES facilities(id),
      inventory_item_id INTEGER REFERENCES inventory_items(id), custom_location TEXT, title TEXT NOT NULL, description TEXT NOT NULL, category TEXT NOT NULL,
      priority TEXT NOT NULL DEFAULT 'normal', status TEXT NOT NULL DEFAULT 'reported', reported_by INTEGER NOT NULL REFERENCES users(id),
      assigned_to INTEGER REFERENCES users(id), due_date TEXT, estimated_cost REAL NOT NULL DEFAULT 0, actual_cost REAL NOT NULL DEFAULT 0,
      resolution TEXT, started_at TEXT, completed_at TEXT, verified_by INTEGER REFERENCES users(id), verified_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')))`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS maintenance_updates (
      id INTEGER PRIMARY KEY AUTOINCREMENT, request_id INTEGER NOT NULL REFERENCES maintenance_requests(id) ON DELETE CASCADE,
      previous_status TEXT, new_status TEXT, comment TEXT, cost_amount REAL NOT NULL DEFAULT 0,
      created_by INTEGER NOT NULL REFERENCES users(id), created_at TEXT NOT NULL DEFAULT (datetime('now')))`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS maintenance_notifications (
      id INTEGER PRIMARY KEY AUTOINCREMENT, request_id INTEGER NOT NULL REFERENCES maintenance_requests(id) ON DELETE CASCADE,
      channel TEXT NOT NULL DEFAULT 'line', event_type TEXT NOT NULL, delivery_status TEXT NOT NULL,
      error_message TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')))`),
    env.DB.prepare("CREATE INDEX IF NOT EXISTS idx_facilities_status ON facilities(status, facility_type)"),
    env.DB.prepare("CREATE INDEX IF NOT EXISTS idx_maintenance_status ON maintenance_requests(status, priority, due_date)"),
    env.DB.prepare("CREATE INDEX IF NOT EXISTS idx_maintenance_facility ON maintenance_requests(facility_id, created_at DESC)"),
    env.DB.prepare("CREATE INDEX IF NOT EXISTS idx_maintenance_assigned ON maintenance_requests(assigned_to, status)"),
    env.DB.prepare("CREATE INDEX IF NOT EXISTS idx_maintenance_updates_request ON maintenance_updates(request_id, created_at DESC)"),
    env.DB.prepare("CREATE INDEX IF NOT EXISTS idx_maintenance_notifications_request ON maintenance_notifications(request_id, created_at DESC)"),
    env.DB.prepare("CREATE INDEX IF NOT EXISTS idx_maintenance_notifications_dedup ON maintenance_notifications(request_id, event_type, delivery_status, created_at DESC)"),
  ]);
  try {
    await env.DB.prepare("ALTER TABLE maintenance_requests ADD COLUMN custom_location TEXT").run();
  } catch (error) {
    if (!String(error?.message || error).toLowerCase().includes("duplicate column")) throw error;
  }
}

async function ensureLineSchema(env) {
  if (lineSchemaReady) return;
  await env.DB.batch([
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS line_targets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      target_type TEXT NOT NULL CHECK (target_type IN ('user','group','room')),
      target_id TEXT NOT NULL UNIQUE,
      display_name TEXT,
      source_user_id TEXT,
      status TEXT NOT NULL DEFAULT 'detected' CHECK (status IN ('detected','active','disabled')),
      is_default INTEGER NOT NULL DEFAULT 0 CHECK (is_default IN (0,1)),
      first_seen_at TEXT NOT NULL DEFAULT (datetime('now')),
      last_seen_at TEXT NOT NULL DEFAULT (datetime('now')),
      last_event_type TEXT,
      selected_by INTEGER REFERENCES users(id),
      selected_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')))`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS line_webhook_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      webhook_event_id TEXT UNIQUE,
      target_id TEXT,
      source_type TEXT,
      event_type TEXT NOT NULL,
      received_at TEXT NOT NULL DEFAULT (datetime('now')))`),
    env.DB.prepare("CREATE INDEX IF NOT EXISTS idx_line_targets_default ON line_targets(is_default, status)"),
    env.DB.prepare("CREATE INDEX IF NOT EXISTS idx_line_targets_last_seen ON line_targets(last_seen_at DESC)"),
    env.DB.prepare("CREATE INDEX IF NOT EXISTS idx_line_webhook_events_received ON line_webhook_events(received_at DESC)"),
  ]);
  lineSchemaReady = true;
}

async function ensureWorkRecordSchema(env) {
  await env.DB.batch([
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS work_records (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      area TEXT NOT NULL,
      topic_key TEXT NOT NULL,
      topic_label TEXT NOT NULL,
      title TEXT NOT NULL,
      description TEXT,
      academic_year_id INTEGER REFERENCES academic_years(id),
      academic_term_id INTEGER REFERENCES academic_terms(id),
      responsible_user_id INTEGER REFERENCES users(id),
      start_date TEXT,
      due_date TEXT,
      status TEXT NOT NULL DEFAULT 'planned' CHECK (status IN ('planned','in_progress','waiting','completed','cancelled')),
      priority TEXT NOT NULL DEFAULT 'normal' CHECK (priority IN ('low','normal','high','urgent')),
      progress_percent INTEGER NOT NULL DEFAULT 0 CHECK (progress_percent BETWEEN 0 AND 100),
      notes TEXT,
      created_by INTEGER NOT NULL REFERENCES users(id),
      updated_by INTEGER REFERENCES users(id),
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      CHECK (start_date IS NULL OR due_date IS NULL OR start_date <= due_date)
    )`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS work_record_updates (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      work_record_id INTEGER NOT NULL REFERENCES work_records(id) ON DELETE CASCADE,
      previous_status TEXT,
      new_status TEXT,
      progress_percent INTEGER,
      comment TEXT,
      created_by INTEGER NOT NULL REFERENCES users(id),
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`),
    env.DB.prepare("CREATE INDEX IF NOT EXISTS idx_work_records_area_topic ON work_records(area,topic_key,status,updated_at DESC)"),
    env.DB.prepare("CREATE INDEX IF NOT EXISTS idx_work_records_period ON work_records(academic_year_id,academic_term_id)"),
    env.DB.prepare("CREATE INDEX IF NOT EXISTS idx_work_records_responsible ON work_records(responsible_user_id,status,due_date)"),
    env.DB.prepare("CREATE INDEX IF NOT EXISTS idx_work_record_updates_record ON work_record_updates(work_record_id,created_at DESC)"),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS system_settings (
      setting_key TEXT PRIMARY KEY,
      setting_value TEXT,
      updated_by INTEGER REFERENCES users(id),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`),
  ]);
}

async function ensureExtendedSchema(env) {
  if (extendedSchemaReady) return;
  await ensureUserDeletionSchema(env);
  await env.DB.batch([
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS student_support_cases (
      id INTEGER PRIMARY KEY AUTOINCREMENT, student_id INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
      case_type TEXT NOT NULL, risk_level TEXT NOT NULL DEFAULT 'normal', summary TEXT NOT NULL, action_taken TEXT,
      follow_up_date TEXT, status TEXT NOT NULL DEFAULT 'open', referred_to TEXT, created_by INTEGER REFERENCES users(id),
      created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')))`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS documents (
      id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, department TEXT NOT NULL, academic_year_id INTEGER,
      project_id INTEGER, document_type TEXT, keywords TEXT, file_name TEXT, file_url TEXT, mime_type TEXT, file_size INTEGER,
      version INTEGER NOT NULL DEFAULT 1, access_level TEXT NOT NULL DEFAULT 'staff', uploaded_by INTEGER REFERENCES users(id),
      record_status TEXT NOT NULL DEFAULT 'active', duplicate_of_id INTEGER, archived_at TEXT, archive_reason TEXT,
      upload_status TEXT NOT NULL DEFAULT 'none', upload_error TEXT, attachment_updated_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')))`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS audit_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER REFERENCES users(id), action TEXT NOT NULL, resource TEXT NOT NULL,
      resource_id INTEGER, details TEXT, ip_address TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')))`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS backup_registry (
      id INTEGER PRIMARY KEY AUTOINCREMENT, backup_type TEXT NOT NULL DEFAULT 'export', file_name TEXT NOT NULL,
      table_count INTEGER, row_count INTEGER, created_by INTEGER REFERENCES users(id), created_at TEXT NOT NULL DEFAULT (datetime('now')))`),
  ]);
  await ensureProjectExpenseSchema(env);
  await ensureBudgetSchema(env);
  await ensureInventorySchema(env);
  await ensureAttachmentStorageSchema(env);
  await ensureDocumentWorkflowSchema(env);
  await ensureMaintenanceSchema(env);
  await ensureLineSchema(env);
  await ensureWorkRecordSchema(env);
  extendedSchemaReady = true;
}

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

// ---------- /api/auth/register ----------
export async function handleRegister(request, env) {
  let body;
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ error: "รูปแบบข้อมูลไม่ถูกต้อง" }, 400);
  }

  const email = (body.email || "").trim().toLowerCase();
  const password = body.password || "";
  const fullName = (body.full_name || "").trim();
  const position = String(body.position || "").trim().slice(0, 200);
  const phone = String(body.phone || "").trim().slice(0, 50);
  const allowedDepartments = new Set(["academic", "budget", "personnel", "general"]);
  const departments = [...new Set(Array.isArray(body.departments) ? body.departments : [])]
    .filter((department) => allowedDepartments.has(department));
  const subjects = String(body.subjects || "").trim().slice(0, 500) || null;
  const homeroomClassroom = String(body.homeroom_classroom || "").trim().slice(0, 200) || null;
  const responsibleProjects = String(body.responsible_projects || "").trim().slice(0, 1500) || null;
  const rawTeachingPeriods = String(body.teaching_periods ?? "").trim();
  const teachingPeriods = rawTeachingPeriods === "" ? null : Number(rawTeachingPeriods);

  if (!email || !isValidEmail(email)) {
    return jsonResponse({ error: "กรุณากรอกอีเมลให้ถูกต้อง" }, 400);
  }
  if (!fullName) {
    return jsonResponse({ error: "กรุณากรอกชื่อ-นามสกุล" }, 400);
  }
  if (!password || password.length < 8) {
    return jsonResponse({ error: "รหัสผ่านต้องมีอย่างน้อย 8 ตัวอักษร" }, 400);
  }
  if (!position) {
    return jsonResponse({ error: "กรุณาระบุตำแหน่ง" }, 400);
  }
  if (!phone || !/^[0-9+()\-\s]{8,50}$/.test(phone) || phone.replace(/\D/g, "").length < 8) {
    return jsonResponse({ error: "กรุณากรอกเบอร์โทรศัพท์ให้ถูกต้อง" }, 400);
  }
  if (!Array.isArray(body.departments) || departments.length === 0 || departments.length !== new Set(body.departments).size) {
    return jsonResponse({ error: "กรุณาเลือกฝ่ายงานที่รับผิดชอบอย่างน้อย 1 ฝ่าย" }, 400);
  }
  if (rawTeachingPeriods && (!Number.isInteger(teachingPeriods) || teachingPeriods < 0 || teachingPeriods > 100)) {
    return jsonResponse({ error: "จำนวนคาบสอนต้องเป็นจำนวนเต็ม 0–100" }, 400);
  }

  // เตรียมทะเบียนบุคลากรก่อนสร้างบัญชี เพื่อให้บัญชีใหม่ไม่ถูกมองเป็นข้อมูลเดิมระหว่าง migration
  await ensurePersonnelData(env);

  const existing = await env.DB.prepare("SELECT id FROM users WHERE email = ?")
    .bind(email)
    .first();
  if (existing) {
    return jsonResponse({ error: "อีเมลนี้ถูกใช้สมัครสมาชิกไปแล้ว" }, 409);
  }

  const { count } = await env.DB.prepare("SELECT COUNT(*) as count FROM users").first();
  const isFirstUser = count === 0;

  const salt = generateSalt();
  const passwordHash = await hashPassword(password, salt);

  const result = await env.DB.prepare(
    `INSERT INTO users (email, password_hash, password_salt, full_name, role, status, approved_at)
     VALUES (?, ?, ?, ?, ?, 'active', ?)`
  )
    .bind(
      email,
      passwordHash,
      salt,
      fullName,
      isFirstUser ? "superadmin" : null,
      isFirstUser ? new Date().toISOString() : null
    )
    .run();

  const userId = result.meta.last_row_id;
  try {
    await upsertSelfRegisteredPersonnel(env, {
      user_id: userId,
      email,
      full_name: fullName,
      position,
      phone,
      departments: departments.join(","),
      subjects,
      homeroom_classroom: homeroomClassroom,
      responsible_projects: responsibleProjects,
      teaching_periods: teachingPeriods,
    });
  } catch (error) {
    await env.DB.prepare("DELETE FROM users WHERE id = ?").bind(userId).run().catch(() => null);
    const conflict = String(error?.message || "").startsWith("PERSONNEL_");
    return jsonResponse({
      error: conflict
        ? "ข้อมูลชื่อหรืออีเมลขัดกับทะเบียนบุคลากรเดิม กรุณาติดต่อผู้ดูแลระบบ"
        : "ไม่สามารถบันทึกข้อมูลบุคลากรได้ กรุณาลองใหม่อีกครั้ง",
    }, conflict ? 409 : 500);
  }
  const token = await signJWT({ sub: userId }, env.JWT_SECRET);

  return jsonResponse(
    {
      user: {
        id: userId,
        email,
        full_name: fullName,
        role: isFirstUser ? "superadmin" : null,
        status: "active",
      },
    },
    201,
    { "Set-Cookie": buildSessionCookie(token) }
  );
}

// ---------- /api/auth/login ----------
async function handleLogin(request, env) {
  let body;
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ error: "รูปแบบข้อมูลไม่ถูกต้อง" }, 400);
  }

  const email = (body.email || "").trim().toLowerCase();
  const password = body.password || "";

  if (!email || !password) {
    return jsonResponse({ error: "กรุณากรอกอีเมลและรหัสผ่าน" }, 400);
  }

  const user = await env.DB.prepare(
    "SELECT id, email, full_name, role, status, password_hash, password_salt FROM users WHERE email = ?"
  )
    .bind(email)
    .first();

  if (!user) {
    return jsonResponse({ error: "อีเมลหรือรหัสผ่านไม่ถูกต้อง" }, 401);
  }

  const ok = await verifyPassword(password, user.password_salt, user.password_hash);
  if (!ok) {
    return jsonResponse({ error: "อีเมลหรือรหัสผ่านไม่ถูกต้อง" }, 401);
  }

  if (user.status !== "active") {
    return jsonResponse({ error: "บัญชีนี้ถูกระงับการใช้งาน กรุณาติดต่อผู้ดูแลระบบ" }, 403);
  }

  const token = await signJWT({ sub: user.id }, env.JWT_SECRET);

  return jsonResponse(
    {
      user: {
        id: user.id,
        email: user.email,
        full_name: user.full_name,
        role: user.role,
        status: user.status,
      },
    },
    200,
    { "Set-Cookie": buildSessionCookie(token) }
  );
}

// ---------- /api/auth/logout ----------
async function handleLogout() {
  return jsonResponse({ ok: true }, 200, { "Set-Cookie": buildClearCookie() });
}

// ---------- /api/auth/me ----------
async function handleMe(request, env) {
  const user = await getCurrentUser(request, env);
  if (!user) return jsonResponse({ user: null }, 200);
  return jsonResponse({ user: { ...user, is_admin: isAdmin(user) } }, 200);
}

// ---------- /api/admin/users (GET) ----------
async function handleAdminListUsers(request, env) {
  const user = await getCurrentUser(request, env);
  if (!isAdmin(user)) {
    return jsonResponse({ error: "ไม่มีสิทธิ์เข้าถึงส่วนนี้" }, 403);
  }

  const { results } = await env.DB.prepare(
    `SELECT u.id, u.email, u.full_name, u.role, u.status, u.created_at, u.approved_at,
            p.position, p.phone, p.departments
     FROM users u
     LEFT JOIN personnel_records p ON p.user_id = u.id AND p.status = 'active'
     WHERE u.deleted_at IS NULL
     ORDER BY u.created_at DESC`
  ).all();

  return jsonResponse({ users: results });
}

// ---------- /api/admin/users/:id (PATCH) ----------
const VALID_ROLES = ["teacher", "executive", "staff", "superadmin"];
const VALID_STATUSES = ["active", "disabled"];

async function handleAdminUpdateUser(request, env, targetId) {
  const admin = await getCurrentUser(request, env);
  if (!isAdmin(admin)) {
    return jsonResponse({ error: "ไม่มีสิทธิ์เข้าถึงส่วนนี้" }, 403);
  }

  if (!targetId) {
    return jsonResponse({ error: "รหัสผู้ใช้ไม่ถูกต้อง" }, 400);
  }
  const target = await env.DB.prepare("SELECT id FROM users WHERE id = ? AND deleted_at IS NULL").bind(targetId).first();
  if (!target) return jsonResponse({ error: "ไม่พบบัญชีผู้ใช้นี้" }, 404);

  let body;
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ error: "รูปแบบข้อมูลไม่ถูกต้อง" }, 400);
  }

  const updates = [];
  const values = [];

  if (body.role !== undefined) {
    if (body.role !== null && !VALID_ROLES.includes(body.role)) {
      return jsonResponse({ error: "บทบาทไม่ถูกต้อง" }, 400);
    }
    updates.push("role = ?");
    values.push(body.role);
    if (body.role !== null) {
      updates.push("approved_at = ?", "approved_by = ?");
      values.push(new Date().toISOString(), admin.id);
    }
  }

  if (body.status !== undefined) {
    if (!VALID_STATUSES.includes(body.status)) {
      return jsonResponse({ error: "สถานะไม่ถูกต้อง" }, 400);
    }
    if (targetId === admin.id && body.status === "disabled") {
      return jsonResponse({ error: "ไม่สามารถระงับบัญชีของตัวเองได้" }, 400);
    }
    updates.push("status = ?");
    values.push(body.status);
  }

  if (updates.length === 0) {
    return jsonResponse({ error: "ไม่มีข้อมูลที่จะอัปเดต" }, 400);
  }

  values.push(targetId);
  await env.DB.prepare(`UPDATE users SET ${updates.join(", ")} WHERE id = ? AND deleted_at IS NULL`)
    .bind(...values)
    .run();

  const updated = await env.DB.prepare(
    "SELECT id, email, full_name, role, status, created_at, approved_at FROM users WHERE id = ?"
  )
    .bind(targetId)
    .first();

  return jsonResponse({ user: updated });
}

// ---------- /api/admin/users/:id (DELETE) ----------
// เก็บแถวผู้ใช้ไว้เพื่อรักษา foreign key และประวัติเอกสาร แต่เพิกถอนการเข้าสู่ระบบทันที
export async function handleAdminDeleteUser(request, env, targetId) {
  const admin = await getCurrentUser(request, env);
  if (!isAdmin(admin)) return jsonResponse({ error: "ไม่มีสิทธิ์เข้าถึงส่วนนี้" }, 403);
  if (!targetId) return jsonResponse({ error: "รหัสผู้ใช้ไม่ถูกต้อง" }, 400);
  if (targetId === Number(admin.id)) return jsonResponse({ error: "ไม่สามารถลบบัญชีของตัวเองได้" }, 400);

  await ensureUserDeletionSchema(env);
  const target = await env.DB.prepare(
    "SELECT id, email, full_name FROM users WHERE id = ? AND deleted_at IS NULL"
  ).bind(targetId).first();
  if (!target) return jsonResponse({ error: "ไม่พบบัญชีผู้ใช้นี้" }, 404);

  const replacementEmail = `deleted-${targetId}-${Date.now()}@removed.invalid`;
  await env.DB.prepare(
    `UPDATE users
     SET email = ?, role = NULL, status = 'disabled', deleted_at = datetime('now'), deleted_by = ?
     WHERE id = ? AND deleted_at IS NULL`
  ).bind(replacementEmail, admin.id, targetId).run();
  await writeAuditLog(env, admin, "delete", "user", targetId, {
    previous_email: target.email, full_name: target.full_name, deletion_mode: "soft_delete",
  }, request);
  return jsonResponse({ ok: true, deletion_mode: "soft_delete" });
}

// ---------- /api/users (GET) — รายชื่อผู้ใช้งานที่ active ไว้เลือกเป็นผู้รับมอบหมาย ----------
async function handleListUsers(request, env) {
  const user = await getCurrentUser(request, env);
  if (!user || !user.role) {
    return jsonResponse({ error: "กรุณาเข้าสู่ระบบ" }, 401);
  }

  const { results } = await env.DB.prepare(
    "SELECT id, full_name, role FROM users WHERE status = 'active' AND role IS NOT NULL ORDER BY full_name"
  ).all();

  return jsonResponse({ users: results });
}

// ---------- /api/search (GET) — ค้นหาทั่วทั้งระบบโดยคงสิทธิ์ของแต่ละโมดูล ----------
function escapeLikePattern(value) {
  return String(value || "").replace(/[\\%_]/g, "\\$&");
}

async function handleGlobalSearch(request, env) {
  const user = await getCurrentUser(request, env);
  if (!user || !user.role) return jsonResponse({ error: "กรุณาเข้าสู่ระบบ" }, 401);
  const q = cleanText(new URL(request.url).searchParams.get("q"), 100) || "";
  if (!q) return jsonResponse({ query: q, results: [] });
  await ensurePersonnelData(env);
  const like = `%${escapeLikePattern(q)}%`;
  const prefix = `${escapeLikePattern(q)}%`;
  const adminFlag = isAdmin(user) ? 1 : 0;
  const maintenanceVisibility = maintenanceVisibilitySql(user);
  const taskStatement = isAdmin(user)
    ? env.DB.prepare(`SELECT DISTINCT t.id,t.title,t.status,t.due_date
        FROM tasks t WHERE (t.title LIKE ? ESCAPE '\\' OR COALESCE(t.description,'') LIKE ? ESCAPE '\\')
        ORDER BY CASE WHEN t.title LIKE ? ESCAPE '\\' THEN 0 ELSE 1 END,t.created_at DESC LIMIT 5`).bind(like,like,prefix)
    : env.DB.prepare(`SELECT DISTINCT t.id,t.title,t.status,t.due_date
        FROM tasks t LEFT JOIN task_assignees ta ON ta.task_id=t.id
        WHERE (t.created_by=? OR ta.user_id=?)
          AND (t.title LIKE ? ESCAPE '\\' OR COALESCE(t.description,'') LIKE ? ESCAPE '\\')
        ORDER BY CASE WHEN t.title LIKE ? ESCAPE '\\' THEN 0 ELSE 1 END,t.created_at DESC LIMIT 5`)
        .bind(user.id,user.id,like,like,prefix);
  const statements = [
    env.DB.prepare(`SELECT id,student_code,full_name,grade_level,classroom
      FROM students WHERE full_name LIKE ? ESCAPE '\\' OR student_code LIKE ? ESCAPE '\\'
      ORDER BY CASE WHEN full_name LIKE ? ESCAPE '\\' THEN 0 ELSE 1 END,full_name LIMIT 5`).bind(like,like,prefix),
    env.DB.prepare(`SELECT id,full_name,position,homeroom_classroom
      FROM personnel_records WHERE status='active'
        AND (full_name LIKE ? ESCAPE '\\' OR COALESCE(position,'') LIKE ? ESCAPE '\\' OR COALESCE(homeroom_classroom,'') LIKE ? ESCAPE '\\')
      ORDER BY CASE WHEN full_name LIKE ? ESCAPE '\\' THEN 0 ELSE 1 END,full_name LIMIT 5`).bind(like,like,like,prefix),
    env.DB.prepare(`SELECT id,name,department,status FROM projects
      WHERE name LIKE ? ESCAPE '\\' OR COALESCE(description,'') LIKE ? ESCAPE '\\'
      ORDER BY CASE WHEN name LIKE ? ESCAPE '\\' THEN 0 ELSE 1 END,created_at DESC LIMIT 5`).bind(like,like,prefix),
    env.DB.prepare(`SELECT id,title,department,document_type FROM documents
      WHERE COALESCE(record_status,'active')='active'
        AND (title LIKE ? ESCAPE '\\' OR COALESCE(keywords,'') LIKE ? ESCAPE '\\')
        AND (access_level='staff' OR uploaded_by=? OR (?=1 AND access_level IN ('private','admin')))
      ORDER BY CASE WHEN title LIKE ? ESCAPE '\\' THEN 0 ELSE 1 END,updated_at DESC LIMIT 5`).bind(like,like,user.id,adminFlag,prefix),
    env.DB.prepare(`SELECT id,item_code,name,item_type,location FROM inventory_items
      WHERE item_code LIKE ? ESCAPE '\\' OR name LIKE ? ESCAPE '\\' OR COALESCE(serial_number,'') LIKE ? ESCAPE '\\'
      ORDER BY CASE WHEN name LIKE ? ESCAPE '\\' THEN 0 ELSE 1 END,name LIMIT 5`).bind(like,like,like,prefix),
    env.DB.prepare(`SELECT m.id,m.request_no,m.title,m.status,COALESCE(f.name,m.custom_location,i.name) AS location_name
      FROM maintenance_requests m
      LEFT JOIN facilities f ON f.id=m.facility_id LEFT JOIN inventory_items i ON i.id=m.inventory_item_id
      WHERE ${maintenanceVisibility.sql}
        AND (m.request_no LIKE ? ESCAPE '\\' OR m.title LIKE ? ESCAPE '\\' OR m.description LIKE ? ESCAPE '\\'
          OR COALESCE(f.name,'') LIKE ? ESCAPE '\\' OR COALESCE(m.custom_location,'') LIKE ? ESCAPE '\\')
      ORDER BY CASE WHEN m.title LIKE ? ESCAPE '\\' THEN 0 ELSE 1 END,m.created_at DESC LIMIT 5`)
      .bind(...maintenanceVisibility.binds,like,like,like,like,like,prefix),
    taskStatement,
    env.DB.prepare(`SELECT id,area,topic_key,topic_label,title,status,due_date FROM work_records
      WHERE title LIKE ? ESCAPE '\\' OR COALESCE(description,'') LIKE ? ESCAPE '\\'
        OR COALESCE(notes,'') LIKE ? ESCAPE '\\' OR topic_label LIKE ? ESCAPE '\\'
      ORDER BY CASE WHEN title LIKE ? ESCAPE '\\' THEN 0 ELSE 1 END,updated_at DESC LIMIT 8`)
      .bind(like,like,like,like,prefix),
  ];
  const [students,staff,projects,documents,inventory,maintenance,tasks,workRecords] = await env.DB.batch(statements);
  const departmentLabels = { academic:"วิชาการ",budget:"งบประมาณ",personnel:"บุคคล",general:"บริหารทั่วไป" };
  const results = [
    ...students.results.map((row) => ({ type:"student",title:row.full_name,subtitle:[row.student_code,row.classroom||row.grade_level].filter(Boolean).join(" · "),page_key:"students",url:`/students.html?student=${row.id}` })),
    ...staff.results.map((row) => ({ type:"staff",title:row.full_name,subtitle:[row.position,row.homeroom_classroom].filter(Boolean).join(" · ")||"ข้อมูลบุคลากร",page_key:"staff",url:`/staff.html?staff=${row.id}` })),
    ...projects.results.map((row) => ({ type:"project",title:row.name,subtitle:`โครงการฝ่าย${departmentLabels[row.department]||row.department}`,page_key:row.department,url:`/department.html?dept=${encodeURIComponent(row.department)}&project=${row.id}` })),
    ...documents.results.map((row) => ({ type:"document",title:row.title,subtitle:[row.document_type,departmentLabels[row.department]||row.department].filter(Boolean).join(" · "),page_key:"documents",url:`/documents.html?document=${row.id}` })),
    ...inventory.results.map((row) => ({ type:"inventory",title:`${row.item_code} · ${row.name}`,subtitle:row.location||"พัสดุและครุภัณฑ์",page_key:"budget",url:`/inventory.html?item=${row.id}` })),
    ...maintenance.results.map((row) => ({ type:"maintenance",title:`${row.request_no} · ${row.title}`,subtitle:row.location_name||"ใบแจ้งซ่อม",page_key:"maintenance",url:`/maintenance.html?request=${row.id}` })),
    ...tasks.results.map((row) => ({ type:"task",title:row.title,subtitle:row.due_date?`กำหนด ${row.due_date}`:"งานและการมอบหมาย",page_key:"tasks",url:`/tasks.html?task=${row.id}` })),
    ...workRecords.results.map((row) => ({ type:"work",title:row.title,subtitle:`${row.topic_label}${row.due_date?` · กำหนด ${row.due_date}`:""}`,page_key:row.area,url:`/work-center.html?area=${encodeURIComponent(row.area)}&topic=${encodeURIComponent(row.topic_key)}&record=${row.id}` })),
  ].slice(0, 30);
  return jsonResponse({ query:q, results });
}

// ---------- /api/tasks (GET) ----------
async function handleListTasks(request, env) {
  const user = await getCurrentUser(request, env);
  if (!user || !user.role) {
    return jsonResponse({ error: "กรุณาเข้าสู่ระบบ" }, 401);
  }

  let taskRows;
  if (isAdmin(user)) {
    taskRows = await env.DB.prepare(
      `SELECT t.*, u.full_name as creator_name FROM tasks t
       JOIN users u ON u.id = t.created_by
       ORDER BY t.status ASC, t.due_date IS NULL, t.due_date ASC, t.created_at DESC`
    ).all();
  } else {
    taskRows = await env.DB.prepare(
      `SELECT DISTINCT t.*, u.full_name as creator_name FROM tasks t
       JOIN users u ON u.id = t.created_by
       LEFT JOIN task_assignees ta ON ta.task_id = t.id
       WHERE t.created_by = ? OR ta.user_id = ?
       ORDER BY t.status ASC, t.due_date IS NULL, t.due_date ASC, t.created_at DESC`
    ).bind(user.id, user.id).all();
  }

  const tasks = taskRows.results;
  if (tasks.length === 0) return jsonResponse({ tasks: [] });

  const taskIds = tasks.map((t) => t.id);
  const placeholders = taskIds.map(() => "?").join(",");
  const { results: assigneeRows } = await env.DB.prepare(
    `SELECT ta.task_id, ta.user_id, ta.status, u.full_name
     FROM task_assignees ta JOIN users u ON u.id = ta.user_id
     WHERE ta.task_id IN (${placeholders})`
  )
    .bind(...taskIds)
    .all();

  const assigneesByTask = {};
  for (const row of assigneeRows) {
    if (!assigneesByTask[row.task_id]) assigneesByTask[row.task_id] = [];
    assigneesByTask[row.task_id].push({
      user_id: row.user_id,
      full_name: row.full_name,
      status: row.status,
    });
  }

  const enriched = tasks.map((t) => ({ ...t, assignees: assigneesByTask[t.id] || [] }));
  return jsonResponse({ tasks: enriched });
}

// ---------- /api/tasks (POST) ----------
async function handleCreateTask(request, env) {
  const user = await getCurrentUser(request, env);
  if (!user || !user.role) {
    return jsonResponse({ error: "กรุณาเข้าสู่ระบบ" }, 401);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ error: "รูปแบบข้อมูลไม่ถูกต้อง" }, 400);
  }

  const title = (body.title || "").trim();
  const description = (body.description || "").trim();
  const priority = ["low", "normal", "high"].includes(body.priority) ? body.priority : "normal";
  const dueDate = body.due_date || null;
  const assigneeIds = Array.isArray(body.assignee_ids) ? body.assignee_ids.map(Number) : [];

  if (!title) {
    return jsonResponse({ error: "กรุณากรอกชื่องาน" }, 400);
  }
  if (assigneeIds.length === 0) {
    return jsonResponse({ error: "กรุณาเลือกผู้รับผิดชอบอย่างน้อย 1 คน" }, 400);
  }

  const result = await env.DB.prepare(
    `INSERT INTO tasks (title, description, priority, due_date, created_by) VALUES (?, ?, ?, ?, ?)`
  )
    .bind(title, description || null, priority, dueDate, user.id)
    .run();

  const taskId = result.meta.last_row_id;

  const inserts = assigneeIds.map((uid) =>
    env.DB.prepare("INSERT INTO task_assignees (task_id, user_id) VALUES (?, ?)").bind(taskId, uid)
  );
  await env.DB.batch(inserts);

  return jsonResponse({ id: taskId }, 201);
}

// ---------- helpers ----------
async function canManageTask(env, user, taskId) {
  if (isAdmin(user)) return true;
  const task = await env.DB.prepare("SELECT created_by FROM tasks WHERE id = ?").bind(taskId).first();
  return !!task && task.created_by === user.id;
}

// ---------- /api/tasks/:id (PATCH) — แก้ไขงาน/ปิดงาน/เปลี่ยนผู้รับผิดชอบ (ผู้สร้างหรือแอดมิน) ----------
async function handleUpdateTask(request, env, taskId) {
  const user = await getCurrentUser(request, env);
  if (!user || !user.role) {
    return jsonResponse({ error: "กรุณาเข้าสู่ระบบ" }, 401);
  }
  if (!(await canManageTask(env, user, taskId))) {
    return jsonResponse({ error: "ไม่มีสิทธิ์แก้ไขงานนี้" }, 403);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ error: "รูปแบบข้อมูลไม่ถูกต้อง" }, 400);
  }

  const updates = [];
  const values = [];
  if (body.title !== undefined) {
    updates.push("title = ?");
    values.push(String(body.title).trim());
  }
  if (body.description !== undefined) {
    updates.push("description = ?");
    values.push(body.description ? String(body.description).trim() : null);
  }
  if (body.priority !== undefined && ["low", "normal", "high"].includes(body.priority)) {
    updates.push("priority = ?");
    values.push(body.priority);
  }
  if (body.due_date !== undefined) {
    updates.push("due_date = ?");
    values.push(body.due_date || null);
  }
  if (body.status !== undefined && ["open", "closed"].includes(body.status)) {
    updates.push("status = ?");
    values.push(body.status);
  }

  if (updates.length > 0) {
    values.push(taskId);
    await env.DB.prepare(`UPDATE tasks SET ${updates.join(", ")} WHERE id = ?`).bind(...values).run();
  }

  if (Array.isArray(body.assignee_ids)) {
    const assigneeIds = body.assignee_ids.map(Number);
    await env.DB.prepare("DELETE FROM task_assignees WHERE task_id = ?").bind(taskId).run();
    if (assigneeIds.length > 0) {
      const inserts = assigneeIds.map((uid) =>
        env.DB.prepare("INSERT INTO task_assignees (task_id, user_id) VALUES (?, ?)").bind(taskId, uid)
      );
      await env.DB.batch(inserts);
    }
  }

  return jsonResponse({ ok: true });
}

// ---------- /api/tasks/:id (DELETE) ----------
async function handleDeleteTask(request, env, taskId) {
  const user = await getCurrentUser(request, env);
  if (!user || !user.role) {
    return jsonResponse({ error: "กรุณาเข้าสู่ระบบ" }, 401);
  }
  if (!(await canManageTask(env, user, taskId))) {
    return jsonResponse({ error: "ไม่มีสิทธิ์ลบงานนี้" }, 403);
  }

  await env.DB.prepare("DELETE FROM task_assignees WHERE task_id = ?").bind(taskId).run();
  await env.DB.prepare("DELETE FROM tasks WHERE id = ?").bind(taskId).run();

  return jsonResponse({ ok: true });
}

// ---------- /api/tasks/:id/status (PATCH) — ผู้รับมอบหมายอัปเดตสถานะของตัวเอง ----------
async function handleUpdateMyTaskStatus(request, env, taskId) {
  const user = await getCurrentUser(request, env);
  if (!user || !user.role) {
    return jsonResponse({ error: "กรุณาเข้าสู่ระบบ" }, 401);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ error: "รูปแบบข้อมูลไม่ถูกต้อง" }, 400);
  }

  if (!["pending", "in_progress", "done"].includes(body.status)) {
    return jsonResponse({ error: "สถานะไม่ถูกต้อง" }, 400);
  }

  const result = await env.DB.prepare(
    "UPDATE task_assignees SET status = ? WHERE task_id = ? AND user_id = ?"
  )
    .bind(body.status, taskId, user.id)
    .run();

  if (result.meta.changes === 0) {
    return jsonResponse({ error: "คุณไม่ได้เป็นผู้รับผิดชอบงานนี้" }, 403);
  }

  return jsonResponse({ ok: true });
}

// ---------- ข้อมูลนักเรียน ----------
function canManageStudents(user) {
  return isAdmin(user) || user.role === "staff";
}

const STUDENT_DETAIL_FIELDS = [
  "gender", "weight_kg", "height_cm", "blood_type", "religion", "ethnicity", "nationality",
  "house_number", "village_no", "road_soi", "subdistrict", "district", "province",
  "guardian_prefix", "guardian_first_name", "guardian_last_name", "guardian_occupation",
  "guardian_relationship", "father_prefix", "father_first_name", "father_last_name",
  "father_occupation", "mother_prefix", "mother_first_name", "mother_last_name",
  "mother_occupation", "disadvantage",
];
const STUDENT_DETAIL_NUMBERS = new Set(["weight_kg", "height_cm"]);
let studentDetailsSchemaReady = false;

async function ensureStudentDetailsSchema(env) {
  if (studentDetailsSchemaReady) return;
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS student_details (
    student_id INTEGER PRIMARY KEY REFERENCES students(id) ON DELETE CASCADE,
    weight_kg REAL, height_cm REAL, blood_type TEXT, religion TEXT, ethnicity TEXT, nationality TEXT,
    house_number TEXT, village_no TEXT, road_soi TEXT, subdistrict TEXT, district TEXT, province TEXT,
    guardian_prefix TEXT, guardian_first_name TEXT, guardian_last_name TEXT, guardian_occupation TEXT,
    guardian_relationship TEXT, father_prefix TEXT, father_first_name TEXT, father_last_name TEXT,
    father_occupation TEXT, mother_prefix TEXT, mother_first_name TEXT, mother_last_name TEXT,
    mother_occupation TEXT, disadvantage TEXT,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`).run();
  const { results: detailColumns } = await env.DB.prepare("PRAGMA table_info(student_details)").all();
  if (!detailColumns.some((column) => column.name === "gender")) {
    await env.DB.prepare("ALTER TABLE student_details ADD COLUMN gender TEXT").run();
  }
  studentDetailsSchemaReady = true;
}

function normalizeStudentDetail(field, value) {
  const text = value == null ? "" : String(value).trim();
  if (!text || ["-", "–", "—"].includes(text)) return null;
  if (!STUDENT_DETAIL_NUMBERS.has(field)) return text;
  const number = Number(text.replace(",", "."));
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function getSubmittedStudentDetails(body) {
  return STUDENT_DETAIL_FIELDS
    .filter((field) => Object.prototype.hasOwnProperty.call(body || {}, field))
    .map((field) => ({ field, value: normalizeStudentDetail(field, body[field]) }));
}

function prepareStudentDetailsUpsert(env, studentIdOrCode, details, lookupByCode = false) {
  if (!details.length) return null;
  const fields = details.map((item) => item.field);
  const studentIdSql = lookupByCode ? "(SELECT id FROM students WHERE student_code = ?)" : "?";
  const conflictUpdates = fields.map((field) => `${field} = excluded.${field}`).join(", ");
  const statement = env.DB.prepare(`INSERT INTO student_details (student_id, ${fields.join(", ")}, updated_at)
    VALUES (${studentIdSql}, ${fields.map(() => "?").join(", ")}, datetime('now'))
    ON CONFLICT(student_id) DO UPDATE SET ${conflictUpdates}, updated_at = datetime('now')`);
  return statement.bind(studentIdOrCode, ...details.map((item) => item.value));
}

async function saveStudentDetails(env, studentId, body) {
  const details = getSubmittedStudentDetails(body);
  if (!details.length) return false;
  await ensureStudentDetailsSchema(env);
  await prepareStudentDetailsUpsert(env, studentId, details).run();
  return true;
}

// ---------- /api/students (GET) ----------
async function handleListStudents(request, env) {
  const user = await getCurrentUser(request, env);
  if (!user || !user.role) {
    return jsonResponse({ error: "กรุณาเข้าสู่ระบบ" }, 401);
  }

  const url = new URL(request.url);
  const termId = Number(url.searchParams.get("academic_term_id"));
  // รายการสำหรับค้นหาและกรองเท่านั้น; ข้อมูลสุขภาพ ครอบครัว และเลขบัตรประชาชน
  // จะถูกอ่านผ่าน /api/students/:id เมื่อเปิดข้อมูลรายคน
  let results;
  if (Number.isInteger(termId) && termId > 0) {
    ({ results } = await env.DB.prepare(
      `SELECT s.id, s.student_code, s.full_name,
              e.grade_level AS grade_level, e.classroom AS classroom, e.status AS status,
              e.academic_year_id, e.academic_term_id
       FROM student_enrollments e JOIN students s ON s.id = e.student_id
       WHERE e.academic_term_id = ? ORDER BY e.classroom, s.full_name`
    ).bind(termId).all());
  } else {
    ({ results } = await env.DB.prepare(
      `SELECT s.id, s.student_code, s.full_name, s.grade_level, s.classroom, s.status
       FROM students s ORDER BY s.classroom, s.full_name`
    ).all());
  }

  return jsonResponse({ students: results, current_academic_period: await getCurrentAcademicPeriod(env) });
}

// ---------- /api/students/:id (GET) — รวมผู้ปกครอง ----------
async function handleGetStudent(request, env, studentId) {
  const user = await getCurrentUser(request, env);
  if (!user || !user.role) {
    return jsonResponse({ error: "กรุณาเข้าสู่ระบบ" }, 401);
  }

  const student = await env.DB.prepare("SELECT * FROM students WHERE id = ?").bind(studentId).first();
  if (!student) return jsonResponse({ error: "ไม่พบนักเรียน" }, 404);

  await ensureStudentDetailsSchema(env);

  const [guardianResult, details] = await Promise.all([
    env.DB.prepare("SELECT * FROM guardians WHERE student_id = ? ORDER BY is_emergency_contact DESC, id")
      .bind(studentId).all(),
    env.DB.prepare("SELECT * FROM student_details WHERE student_id = ?").bind(studentId).first(),
  ]);

  return jsonResponse({ student: { ...student, ...(details || {}), guardians: guardianResult.results } });
}

// ---------- /api/students (POST) ----------
function composeFullName(prefix, first, last, fallback) {
  const parts = [prefix, first, last].map((v) => (v || "").toString().trim()).filter(Boolean);
  if (parts.length > 0) return parts.join(" ");
  return (fallback || "").toString().trim();
}

async function handleCreateStudent(request, env) {
  const user = await getCurrentUser(request, env);
  if (!user || !user.role) {
    return jsonResponse({ error: "กรุณาเข้าสู่ระบบ" }, 401);
  }
  if (!canManageStudents(user)) {
    return jsonResponse({ error: "ไม่มีสิทธิ์เพิ่มข้อมูลนักเรียน" }, 403);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ error: "รูปแบบข้อมูลไม่ถูกต้อง" }, 400);
  }

  const studentCode = (body.student_code || "").trim();
  const namePrefix = (body.name_prefix || "").trim();
  const firstName = (body.first_name || "").trim();
  const lastName = (body.last_name || "").trim();
  const fullName = composeFullName(namePrefix, firstName, lastName, body.full_name);

  if (!studentCode) return jsonResponse({ error: "กรุณากรอกเลขประจำตัวนักเรียน" }, 400);
  if (!fullName) return jsonResponse({ error: "กรุณากรอกชื่อ-นามสกุลนักเรียน" }, 400);

  const existing = await env.DB.prepare("SELECT id FROM students WHERE student_code = ?")
    .bind(studentCode)
    .first();
  if (existing) return jsonResponse({ error: "เลขประจำตัวนี้ถูกใช้แล้ว" }, 409);

  const result = await env.DB.prepare(
    `INSERT INTO students
       (student_code, full_name, national_id, name_prefix, first_name, last_name, birth_date,
        classroom, grade_level, photo_url, health_conditions, allergies, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'enrolled')`
  )
    .bind(
      studentCode,
      fullName,
      body.national_id || null,
      namePrefix || null,
      firstName || null,
      lastName || null,
      body.birth_date || null,
      body.classroom || null,
      body.grade_level || null,
      body.photo_url || null,
      body.health_conditions || null,
      body.allergies || null
    )
    .run();

  await saveStudentDetails(env, result.meta.last_row_id, body);

  return jsonResponse({ id: result.meta.last_row_id }, 201);
}

// ---------- /api/students/:id (PATCH) ----------
async function handleUpdateStudent(request, env, studentId) {
  const user = await getCurrentUser(request, env);
  if (!user || !user.role) {
    return jsonResponse({ error: "กรุณาเข้าสู่ระบบ" }, 401);
  }
  if (!canManageStudents(user)) {
    return jsonResponse({ error: "ไม่มีสิทธิ์แก้ไขข้อมูลนักเรียน" }, 403);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ error: "รูปแบบข้อมูลไม่ถูกต้อง" }, 400);
  }

  // ถ้ามีการส่งชื่อแบบแยกส่วนมา ให้คำนวณ full_name ใหม่จากส่วนนั้นเสมอ
  if (body.name_prefix !== undefined || body.first_name !== undefined || body.last_name !== undefined) {
    body.full_name = composeFullName(body.name_prefix, body.first_name, body.last_name, body.full_name);
  }

  const fields = [
    "full_name",
    "national_id",
    "name_prefix",
    "first_name",
    "last_name",
    "birth_date",
    "classroom",
    "grade_level",
    "photo_url",
    "health_conditions",
    "allergies",
    "status",
  ];
  const updates = [];
  const values = [];
  for (const f of fields) {
    if (body[f] !== undefined) {
      updates.push(`${f} = ?`);
      values.push(body[f] || null);
    }
  }

  const hasStudentDetails = getSubmittedStudentDetails(body).length > 0;
  if (updates.length === 0 && !hasStudentDetails) return jsonResponse({ error: "ไม่มีข้อมูลที่จะอัปเดต" }, 400);

  if (updates.length > 0) {
    values.push(studentId);
    await env.DB.prepare(`UPDATE students SET ${updates.join(", ")} WHERE id = ?`).bind(...values).run();
  }
  if (hasStudentDetails) await saveStudentDetails(env, studentId, body);

  return jsonResponse({ ok: true });
}

// ---------- /api/students/:id (DELETE) ----------
async function handleDeleteStudent(request, env, studentId) {
  const user = await getCurrentUser(request, env);
  if (!user || !user.role) {
    return jsonResponse({ error: "กรุณาเข้าสู่ระบบ" }, 401);
  }
  if (!isAdmin(user)) {
    return jsonResponse({ error: "ไม่มีสิทธิ์ลบข้อมูลนักเรียน" }, 403);
  }

  await ensureStudentDetailsSchema(env);
  await env.DB.prepare("DELETE FROM student_details WHERE student_id = ?").bind(studentId).run();
  await env.DB.prepare("DELETE FROM guardians WHERE student_id = ?").bind(studentId).run();
  await env.DB.prepare("DELETE FROM students WHERE id = ?").bind(studentId).run();

  return jsonResponse({ ok: true });
}

// ---------- /api/students/:id/guardians (POST) ----------
async function handleAddGuardian(request, env, studentId) {
  const user = await getCurrentUser(request, env);
  if (!user || !user.role) {
    return jsonResponse({ error: "กรุณาเข้าสู่ระบบ" }, 401);
  }
  if (!canManageStudents(user)) {
    return jsonResponse({ error: "ไม่มีสิทธิ์เพิ่มผู้ปกครอง" }, 403);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ error: "รูปแบบข้อมูลไม่ถูกต้อง" }, 400);
  }

  const fullName = (body.full_name || "").trim();
  if (!fullName) return jsonResponse({ error: "กรุณากรอกชื่อผู้ปกครอง" }, 400);

  const result = await env.DB.prepare(
    `INSERT INTO guardians (student_id, full_name, relationship, phone, is_emergency_contact)
     VALUES (?, ?, ?, ?, ?)`
  )
    .bind(studentId, fullName, body.relationship || null, body.phone || null, body.is_emergency_contact ? 1 : 0)
    .run();

  return jsonResponse({ id: result.meta.last_row_id }, 201);
}

// ---------- /api/guardians/:id (PATCH) ----------
async function handleUpdateGuardian(request, env, guardianId) {
  const user = await getCurrentUser(request, env);
  if (!user || !user.role) {
    return jsonResponse({ error: "กรุณาเข้าสู่ระบบ" }, 401);
  }
  if (!canManageStudents(user)) {
    return jsonResponse({ error: "ไม่มีสิทธิ์แก้ไขผู้ปกครอง" }, 403);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ error: "รูปแบบข้อมูลไม่ถูกต้อง" }, 400);
  }

  const fields = ["full_name", "relationship", "phone"];
  const updates = [];
  const values = [];
  for (const f of fields) {
    if (body[f] !== undefined) {
      updates.push(`${f} = ?`);
      values.push(body[f] || null);
    }
  }
  if (body.is_emergency_contact !== undefined) {
    updates.push("is_emergency_contact = ?");
    values.push(body.is_emergency_contact ? 1 : 0);
  }
  if (updates.length === 0) return jsonResponse({ error: "ไม่มีข้อมูลที่จะอัปเดต" }, 400);

  values.push(guardianId);
  await env.DB.prepare(`UPDATE guardians SET ${updates.join(", ")} WHERE id = ?`).bind(...values).run();

  return jsonResponse({ ok: true });
}

// ---------- /api/guardians/:id (DELETE) ----------
async function handleDeleteGuardian(request, env, guardianId) {
  const user = await getCurrentUser(request, env);
  if (!user || !user.role) {
    return jsonResponse({ error: "กรุณาเข้าสู่ระบบ" }, 401);
  }
  if (!canManageStudents(user)) {
    return jsonResponse({ error: "ไม่มีสิทธิ์ลบผู้ปกครอง" }, 403);
  }

  await env.DB.prepare("DELETE FROM guardians WHERE id = ?").bind(guardianId).run();
  return jsonResponse({ ok: true });
}

// ---------- ข้อมูลครู/บุคลากร ----------

// ---------- /api/staff (GET) — ทำเนียบบุคลากร ----------
async function handleListStaff(request, env) {
  const user = await getCurrentUser(request, env);
  if (!user || !user.role) {
    return jsonResponse({ error: "กรุณาเข้าสู่ระบบ" }, 401);
  }

  await ensurePersonnelData(env);

  const { results } = await env.DB.prepare(
    `SELECT p.id, p.user_id, p.full_name, u.role,
            p.position, p.subjects, p.phone, p.homeroom_classroom,
            p.email, p.departments, p.responsible_projects, p.teaching_periods,
            p.license_issue_date, p.license_expiry_date
     FROM personnel_records p
     LEFT JOIN users u ON u.id = p.user_id
     WHERE p.status = 'active'
     ORDER BY p.first_name, p.full_name`
  ).all();

  return jsonResponse({ staff: results });
}

// ---------- /api/staff/:id (PATCH) — แก้ไขข้อมูลตำแหน่ง/วิชา/ติดต่อ ----------
async function handleUpdateStaff(request, env, targetId) {
  const user = await getCurrentUser(request, env);
  if (!user || !user.role) {
    return jsonResponse({ error: "กรุณาเข้าสู่ระบบ" }, 401);
  }
  await ensurePersonnelData(env);

  const target = await env.DB.prepare("SELECT id, user_id FROM personnel_records WHERE id = ? AND status = 'active'")
    .bind(targetId)
    .first();
  if (!target) return jsonResponse({ error: "ไม่พบบุคลากรนี้" }, 404);
  if (!isAdmin(user) && user.id !== target.user_id) {
    return jsonResponse({ error: "แก้ไขได้เฉพาะข้อมูลของตัวเอง หรือต้องเป็นผู้ดูแลระบบ/ผู้บริหาร" }, 403);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ error: "รูปแบบข้อมูลไม่ถูกต้อง" }, 400);
  }

  const position = body.position || null;
  const subjects = body.subjects || null;
  const phone = body.phone || null;
  const homeroom_classroom = body.homeroom_classroom || null;
  const departments = body.departments || null;
  const responsible_projects = body.responsible_projects || null;
  const rawPeriods = String(body.teaching_periods ?? "").trim();
  const teaching_periods = rawPeriods === "" ? null : Number(rawPeriods);
  if (rawPeriods && (!Number.isInteger(teaching_periods) || teaching_periods < 0 || teaching_periods > 100)) {
    return jsonResponse({ error: "จำนวนคาบต้องเป็นจำนวนเต็ม 0–100" }, 400);
  }
  const license_issue_date = body.license_issue_date || null;
  const license_expiry_date = body.license_expiry_date || null;

  await env.DB.prepare(
    `UPDATE personnel_records SET
       position = ?, subjects = ?, phone = ?, homeroom_classroom = ?,
       departments = ?, responsible_projects = ?, teaching_periods = ?,
       license_issue_date = ?, license_expiry_date = ?, updated_at = datetime('now')
     WHERE id = ?`
  )
    .bind(position, subjects, phone, homeroom_classroom, departments, responsible_projects,
      teaching_periods, license_issue_date, license_expiry_date, targetId)
    .run();

  return jsonResponse({ ok: true });
}

// ---------- รายงาน ----------

// ---------- /api/reports/summary (GET) ----------
async function handleReportsSummary(request, env) {
  const user = await getCurrentUser(request, env);
  if (!user || !user.role) {
    return jsonResponse({ error: "กรุณาเข้าสู่ระบบ" }, 401);
  }

  const openTasks = await env.DB.prepare("SELECT COUNT(*) as count FROM tasks WHERE status = 'open'").first();
  const overdueTasks = await env.DB.prepare(
    "SELECT COUNT(*) as count FROM tasks WHERE status = 'open' AND due_date IS NOT NULL AND due_date < date('now')"
  ).first();

  const { results: tasksByAssignee } = await env.DB.prepare(
    `SELECT u.full_name,
            SUM(CASE WHEN ta.status != 'done' THEN 1 ELSE 0 END) as pending_count,
            SUM(CASE WHEN ta.status != 'done' AND t.due_date IS NOT NULL AND t.due_date < date('now') THEN 1 ELSE 0 END) as overdue_count
     FROM task_assignees ta
     JOIN users u ON u.id = ta.user_id
     JOIN tasks t ON t.id = ta.task_id
     WHERE t.status = 'open'
     GROUP BY u.id
     HAVING pending_count > 0
     ORDER BY pending_count DESC`
  ).all();

  const { results: studentsByStatus } = await env.DB.prepare(
    "SELECT status, COUNT(*) as count FROM students GROUP BY status"
  ).all();

  const { results: studentsByClassroom } = await env.DB.prepare(
    `SELECT COALESCE(classroom, 'ไม่ระบุห้อง') as classroom, COUNT(*) as count
     FROM students WHERE status = 'enrolled'
     GROUP BY classroom ORDER BY classroom`
  ).all();

  const staffCount = await env.DB.prepare(
    "SELECT COUNT(*) as count FROM users WHERE status = 'active' AND role IS NOT NULL"
  ).first();

  return jsonResponse({
    open_tasks: openTasks.count,
    overdue_tasks: overdueTasks.count,
    tasks_by_assignee: tasksByAssignee,
    students_by_status: studentsByStatus,
    students_by_classroom: studentsByClassroom,
    staff_count: staffCount.count,
  });
}

// ---------- 4 ฝ่ายงาน ----------
const DEPARTMENTS = ["academic", "budget", "personnel", "general"];

async function isProjectOwner(env, user, projectId) {
  if (isAdmin(user)) return true;
  const row = await env.DB.prepare("SELECT 1 FROM project_owners WHERE project_id = ? AND user_id = ?")
    .bind(projectId, user.id)
    .first();
  return !!row;
}

// ---------- /api/departments/:dept/projects (GET) ----------
async function handleListProjects(request, env, department) {
  const user = await getCurrentUser(request, env);
  if (!user || !user.role) return jsonResponse({ error: "กรุณาเข้าสู่ระบบ" }, 401);
  if (!DEPARTMENTS.includes(department)) return jsonResponse({ error: "ไม่พบฝ่ายงานนี้" }, 404);

  const { results: projects } = await env.DB.prepare(
    "SELECT * FROM projects WHERE department = ? ORDER BY status ASC, created_at DESC"
  )
    .bind(department)
    .all();

  if (projects.length === 0) return jsonResponse({ projects: [] });

  const ids = projects.map((p) => p.id);
  const placeholders = ids.map(() => "?").join(",");
  const { results: ownerRows } = await env.DB.prepare(
    `SELECT po.project_id, u.id as user_id, u.full_name
     FROM project_owners po JOIN users u ON u.id = po.user_id
     WHERE po.project_id IN (${placeholders})`
  )
    .bind(...ids)
    .all();

  const ownersByProject = {};
  for (const row of ownerRows) {
    if (!ownersByProject[row.project_id]) ownersByProject[row.project_id] = [];
    ownersByProject[row.project_id].push({ user_id: row.user_id, full_name: row.full_name });
  }

  const enriched = projects.map((p) => ({ ...p, owners: ownersByProject[p.id] || [] }));
  return jsonResponse({ projects: enriched });
}

// ---------- /api/departments/:dept/projects (POST) ----------
async function handleCreateProject(request, env, department) {
  const user = await getCurrentUser(request, env);
  if (!user || !user.role) return jsonResponse({ error: "กรุณาเข้าสู่ระบบ" }, 401);
  if (!DEPARTMENTS.includes(department)) return jsonResponse({ error: "ไม่พบฝ่ายงานนี้" }, 404);
  if (!isAdmin(user)) return jsonResponse({ error: "เฉพาะผู้บริหาร/ผู้ดูแลระบบเท่านั้นที่สร้างโครงการได้" }, 403);

  let body;
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ error: "รูปแบบข้อมูลไม่ถูกต้อง" }, 400);
  }

  const name = (body.name || "").trim();
  if (!name) return jsonResponse({ error: "กรุณากรอกชื่อโครงการ" }, 400);

  const ownerIds = Array.isArray(body.owner_ids) ? body.owner_ids.map(Number) : [];
  const budgetAmount = body.budget_amount === "" || body.budget_amount == null ? 0 : Number(body.budget_amount);
  if (!Number.isFinite(budgetAmount) || budgetAmount < 0) {
    return jsonResponse({ error: "ยอดงบประมาณต้องเป็นตัวเลขตั้งแต่ 0 ขึ้นไป" }, 400);
  }
  const now = new Date();
  const defaultFiscalYear = now.getUTCFullYear() + (now.getUTCMonth() + 1 >= 10 ? 544 : 543);
  const fiscalYear = body.fiscal_year === "" || body.fiscal_year == null ? defaultFiscalYear : Number(body.fiscal_year);
  if (!Number.isInteger(fiscalYear) || fiscalYear < 2500 || fiscalYear > 3000) return jsonResponse({ error: "ปีงบประมาณไม่ถูกต้อง" }, 400);

  try {
    const result = await upsertProjectRow(env, {
      department, name, budget_amount: budgetAmount, fiscal_year: fiscalYear, description: body.description,
    }, user.id, ownerIds);
    return jsonResponse(result, result.created ? 201 : 200);
  } catch (error) {
    return jsonResponse({ error: error.message || "บันทึกโครงการไม่สำเร็จ" }, 400);
  }
}

async function handleImportProjects(request, env) {
  const user = await getCurrentUser(request, env);
  if (!user || !user.role) return jsonResponse({ error: "กรุณาเข้าสู่ระบบ" }, 401);
  if (!isAdmin(user)) return jsonResponse({ error: "เฉพาะผู้บริหาร/ผู้ดูแลระบบเท่านั้นที่นำเข้าโครงการได้" }, 403);
  const body = await request.json().catch(() => null);
  if (!Array.isArray(body?.rows) || !body.rows.length || body.rows.length > 500) {
    return jsonResponse({ error: "กรุณาส่งข้อมูลโครงการ 1–500 รายการ" }, 400);
  }
  return jsonResponse(await importProjectRows(env, body.rows, user.id));
}

// ---------- /api/projects/:id (PATCH) ----------
async function handleUpdateProject(request, env, projectId) {
  const user = await getCurrentUser(request, env);
  if (!user || !user.role) return jsonResponse({ error: "กรุณาเข้าสู่ระบบ" }, 401);
  if (!(await isProjectOwner(env, user, projectId))) {
    return jsonResponse({ error: "เฉพาะผู้ดูแลโครงการเท่านั้นที่แก้ไขได้" }, 403);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ error: "รูปแบบข้อมูลไม่ถูกต้อง" }, 400);
  }

  const updates = [];
  const values = [];
  if (body.name !== undefined) {
    updates.push("name = ?");
    values.push(String(body.name).trim());
  }
  if (body.budget_amount !== undefined) {
    const amount = body.budget_amount === "" || body.budget_amount == null ? 0 : Number(body.budget_amount);
    if (!Number.isFinite(amount) || amount < 0) return jsonResponse({ error: "ยอดงบประมาณต้องเป็นตัวเลขตั้งแต่ 0 ขึ้นไป" }, 400);
    updates.push("budget_amount = ?");
    values.push(amount);
  }
  if (body.fiscal_year !== undefined) {
    const fiscalYear = Number(body.fiscal_year);
    if (!Number.isInteger(fiscalYear) || fiscalYear < 2500 || fiscalYear > 3000) return jsonResponse({ error: "ปีงบประมาณไม่ถูกต้อง" }, 400);
    updates.push("fiscal_year = ?"); values.push(fiscalYear);
  }
  if (body.progress_percent !== undefined) {
    const p = Number(body.progress_percent);
    if (!(p >= 0 && p <= 100)) return jsonResponse({ error: "% ความคืบหน้าต้องอยู่ระหว่าง 0-100" }, 400);
    updates.push("progress_percent = ?");
    values.push(p);
  }
  if (body.status !== undefined && ["ongoing", "completed", "cancelled"].includes(body.status)) {
    updates.push("status = ?");
    values.push(body.status);
  }
  if (body.description !== undefined) {
    updates.push("description = ?");
    values.push(body.description || null);
  }

  if (updates.length > 0) {
    values.push(projectId);
    await env.DB.prepare(`UPDATE projects SET ${updates.join(", ")} WHERE id = ?`).bind(...values).run();
  }

  if (isAdmin(user) && Array.isArray(body.owner_ids)) {
    const ownerIds = body.owner_ids.map(Number);
    await env.DB.prepare("DELETE FROM project_owners WHERE project_id = ?").bind(projectId).run();
    if (ownerIds.length > 0) {
      const inserts = ownerIds.map((uid) =>
        env.DB.prepare("INSERT INTO project_owners (project_id, user_id) VALUES (?, ?)").bind(projectId, uid)
      );
      await env.DB.batch(inserts);
    }
  }

  return jsonResponse({ ok: true });
}

// ---------- /api/projects/:id (DELETE) ----------
async function handleDeleteProject(request, env, projectId) {
  const user = await getCurrentUser(request, env);
  if (!user || !user.role) return jsonResponse({ error: "กรุณาเข้าสู่ระบบ" }, 401);
  if (!isAdmin(user)) return jsonResponse({ error: "เฉพาะผู้บริหาร/ผู้ดูแลระบบเท่านั้นที่ลบโครงการได้" }, 403);

  await env.DB.prepare("DELETE FROM project_expenses WHERE project_id = ?").bind(projectId).run();
  await env.DB.prepare("DELETE FROM project_owners WHERE project_id = ?").bind(projectId).run();
  await env.DB.prepare("DELETE FROM projects WHERE id = ?").bind(projectId).run();
  return jsonResponse({ ok: true });
}

// ---------- ทะเบียนเบิกจ่ายรายโครงการ ----------
const PROJECT_EXPENSE_STATUSES = ["draft", "pending", "approved", "paid", "rejected", "cancelled"];
const PROJECT_EXPENSE_CATEGORIES = [
  "materials", "equipment", "services", "compensation", "utilities", "travel", "food", "opening_balance", "other",
];

function isIsoDate(value) {
  const text = String(value || "");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return false;
  const [year, month, day] = text.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

function normalizeHttpUrl(value) {
  const text = String(value || "").trim();
  if (!text) return null;
  try {
    const url = new URL(text);
    return ["http:", "https:"].includes(url.protocol) ? url.href : false;
  } catch {
    return false;
  }
}

async function getProjectExpense(env, expenseId) {
  return env.DB.prepare(
    `SELECT e.*, p.department, p.name AS project_name
     FROM project_expenses e JOIN projects p ON p.id = e.project_id
     WHERE e.id = ?`
  ).bind(expenseId).first();
}

async function writeAuditLog(env, user, action, resource, resourceId, details, request) {
  await env.DB.prepare(
    `INSERT INTO audit_logs (user_id, action, resource, resource_id, details, ip_address)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).bind(
    user.id,
    action,
    resource,
    resourceId || null,
    details ? JSON.stringify(details) : null,
    request.headers.get("CF-Connecting-IP") || null
  ).run();
}

async function handleListProjectExpenses(request, env, projectId) {
  const user = await getCurrentUser(request, env);
  if (!user || !user.role) return jsonResponse({ error: "กรุณาเข้าสู่ระบบ" }, 401);
  const project = await env.DB.prepare(
    `SELECT id, department, name, budget_amount, spent_amount, progress_percent, status,
            COALESCE(budget_amount, 0) - COALESCE(spent_amount, 0) AS remaining_amount
     FROM projects WHERE id = ?`
  ).bind(projectId).first();
  if (!project) return jsonResponse({ error: "ไม่พบโครงการ" }, 404);

  const { results: expenses } = await env.DB.prepare(
    `SELECT e.*, creator.full_name AS creator_name, approver.full_name AS approver_name
     FROM project_expenses e
     LEFT JOIN users creator ON creator.id = e.created_by
     LEFT JOIN users approver ON approver.id = e.approved_by
     WHERE e.project_id = ?
     ORDER BY e.expense_date DESC, e.created_at DESC, e.id DESC`
  ).bind(projectId).all();
  const { results: statusRows } = await env.DB.prepare(
    `SELECT status, COUNT(*) AS item_count, COALESCE(SUM(amount), 0) AS total_amount
     FROM project_expenses WHERE project_id = ? GROUP BY status`
  ).bind(projectId).all();

  const statusTotals = Object.fromEntries(PROJECT_EXPENSE_STATUSES.map((status) => [status, { item_count: 0, total_amount: 0 }]));
  for (const row of statusRows) {
    statusTotals[row.status] = { item_count: Number(row.item_count || 0), total_amount: Number(row.total_amount || 0) };
  }
  const canManage = await isProjectOwner(env, user, projectId);
  return jsonResponse({
    project: {
      ...project,
      budget_amount: Number(project.budget_amount || 0),
      spent_amount: Number(project.spent_amount || 0),
      remaining_amount: Number(project.remaining_amount || 0),
    },
    expenses: expenses.map((expense) => ({ ...expense, amount: Number(expense.amount || 0) })),
    status_totals: statusTotals,
    permissions: { can_manage: canManage, can_approve: isAdmin(user) },
  });
}

async function handleCreateProjectExpense(request, env, projectId) {
  const user = await getCurrentUser(request, env);
  if (!user || !user.role) return jsonResponse({ error: "กรุณาเข้าสู่ระบบ" }, 401);
  if (!(await isProjectOwner(env, user, projectId))) return jsonResponse({ error: "ไม่มีสิทธิ์บันทึกรายการของโครงการนี้" }, 403);
  const project = await env.DB.prepare("SELECT id FROM projects WHERE id = ?").bind(projectId).first();
  if (!project) return jsonResponse({ error: "ไม่พบโครงการ" }, 404);

  const body = await request.json().catch(() => null);
  if (!body) return jsonResponse({ error: "รูปแบบข้อมูลไม่ถูกต้อง" }, 400);
  const description = String(body.description || "").trim();
  const amount = Number(body.amount);
  if (!isIsoDate(body.expense_date)) return jsonResponse({ error: "กรุณาระบุวันที่รายการให้ถูกต้อง" }, 400);
  if (!description) return jsonResponse({ error: "กรุณาระบุรายละเอียดรายการ" }, 400);
  if (!Number.isFinite(amount) || amount <= 0) return jsonResponse({ error: "จำนวนเงินต้องมากกว่า 0 บาท" }, 400);
  const status = isAdmin(user) && PROJECT_EXPENSE_STATUSES.includes(body.status) ? body.status : "pending";
  const category = PROJECT_EXPENSE_CATEGORIES.includes(body.category) ? body.category : "other";
  const attachmentUrl = normalizeHttpUrl(body.attachment_url);
  if (attachmentUrl === false) return jsonResponse({ error: "ลิงก์หลักฐานต้องขึ้นต้นด้วย http:// หรือ https://" }, 400);
  const approved = ["approved", "paid"].includes(status);

  const result = await env.DB.prepare(
    `INSERT INTO project_expenses
       (project_id, expense_date, document_no, category, description, payee, amount, status,
        attachment_url, notes, created_by, approved_by, approved_at, paid_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(
    projectId, body.expense_date, String(body.document_no || "").trim() || null, category, description,
    String(body.payee || "").trim() || null, amount, status, attachmentUrl,
    String(body.notes || "").trim() || null, user.id, approved ? user.id : null,
    approved ? new Date().toISOString() : null, status === "paid" ? new Date().toISOString() : null
  ).run();
  const expenseId = result.meta.last_row_id;
  await writeAuditLog(env, user, "create", "project_expense", expenseId, { project_id: projectId, amount, status }, request);
  return jsonResponse({ id: expenseId }, 201);
}

async function handleUpdateProjectExpense(request, env, expenseId) {
  const user = await getCurrentUser(request, env);
  if (!user || !user.role) return jsonResponse({ error: "กรุณาเข้าสู่ระบบ" }, 401);
  const expense = await getProjectExpense(env, expenseId);
  if (!expense) return jsonResponse({ error: "ไม่พบรายการเบิกจ่าย" }, 404);
  const canManage = await isProjectOwner(env, user, expense.project_id);
  if (!canManage) return jsonResponse({ error: "ไม่มีสิทธิ์แก้ไขรายการนี้" }, 403);
  if (!isAdmin(user) && !["draft", "pending"].includes(expense.status)) {
    return jsonResponse({ error: "รายการที่ผ่านการพิจารณาแล้วแก้ไขได้เฉพาะผู้บริหาร" }, 403);
  }

  const body = await request.json().catch(() => null);
  if (!body) return jsonResponse({ error: "รูปแบบข้อมูลไม่ถูกต้อง" }, 400);
  const updates = [];
  const values = [];
  if (body.expense_date !== undefined) {
    if (!isIsoDate(body.expense_date)) return jsonResponse({ error: "วันที่รายการไม่ถูกต้อง" }, 400);
    updates.push("expense_date = ?"); values.push(body.expense_date);
  }
  if (body.document_no !== undefined) { updates.push("document_no = ?"); values.push(String(body.document_no || "").trim() || null); }
  if (body.category !== undefined) {
    if (!PROJECT_EXPENSE_CATEGORIES.includes(body.category)) return jsonResponse({ error: "หมวดรายจ่ายไม่ถูกต้อง" }, 400);
    updates.push("category = ?"); values.push(body.category);
  }
  if (body.description !== undefined) {
    const description = String(body.description || "").trim();
    if (!description) return jsonResponse({ error: "กรุณาระบุรายละเอียดรายการ" }, 400);
    updates.push("description = ?"); values.push(description);
  }
  if (body.payee !== undefined) { updates.push("payee = ?"); values.push(String(body.payee || "").trim() || null); }
  if (body.amount !== undefined) {
    const amount = Number(body.amount);
    if (!Number.isFinite(amount) || amount <= 0) return jsonResponse({ error: "จำนวนเงินต้องมากกว่า 0 บาท" }, 400);
    updates.push("amount = ?"); values.push(amount);
  }
  if (body.attachment_url !== undefined) {
    const attachmentUrl = normalizeHttpUrl(body.attachment_url);
    if (attachmentUrl === false) return jsonResponse({ error: "ลิงก์หลักฐานต้องขึ้นต้นด้วย http:// หรือ https://" }, 400);
    updates.push("attachment_url = ?"); values.push(attachmentUrl);
  }
  if (body.notes !== undefined) { updates.push("notes = ?"); values.push(String(body.notes || "").trim() || null); }
  if (body.status !== undefined) {
    if (!PROJECT_EXPENSE_STATUSES.includes(body.status)) return jsonResponse({ error: "สถานะรายการไม่ถูกต้อง" }, 400);
    if (!isAdmin(user) && !["draft", "pending"].includes(body.status)) {
      return jsonResponse({ error: "เฉพาะผู้บริหารเท่านั้นที่อนุมัติหรือยืนยันการจ่ายได้" }, 403);
    }
    updates.push("status = ?"); values.push(body.status);
    if (["approved", "paid"].includes(body.status)) {
      updates.push("approved_by = ?", "approved_at = COALESCE(approved_at, datetime('now'))"); values.push(user.id);
    } else if (["draft", "pending"].includes(body.status)) {
      updates.push("approved_by = NULL", "approved_at = NULL");
    }
    updates.push(body.status === "paid" ? "paid_at = COALESCE(paid_at, datetime('now'))" : "paid_at = NULL");
  }
  if (!updates.length) return jsonResponse({ error: "ไม่มีข้อมูลที่ต้องอัปเดต" }, 400);
  updates.push("updated_at = datetime('now')");
  values.push(expenseId);
  await env.DB.prepare(`UPDATE project_expenses SET ${updates.join(", ")} WHERE id = ?`).bind(...values).run();
  await writeAuditLog(env, user, "update", "project_expense", expenseId, { project_id: expense.project_id, fields: Object.keys(body) }, request);
  return jsonResponse({ ok: true });
}

async function handleDeleteProjectExpense(request, env, expenseId) {
  const user = await getCurrentUser(request, env);
  if (!user || !user.role) return jsonResponse({ error: "กรุณาเข้าสู่ระบบ" }, 401);
  const expense = await getProjectExpense(env, expenseId);
  if (!expense) return jsonResponse({ error: "ไม่พบรายการเบิกจ่าย" }, 404);
  const canManage = await isProjectOwner(env, user, expense.project_id);
  if (!canManage) return jsonResponse({ error: "ไม่มีสิทธิ์ลบรายการนี้" }, 403);
  if (!isAdmin(user) && !["draft", "pending"].includes(expense.status)) {
    return jsonResponse({ error: "ลบได้เฉพาะรายการร่างหรือรอตรวจสอบ" }, 403);
  }
  if (expense.status === "paid") {
    return jsonResponse({ error: "รายการที่จ่ายแล้วห้ามลบ กรุณาเปลี่ยนสถานะเป็นยกเลิกเพื่อเก็บประวัติ" }, 409);
  }
  await env.DB.prepare("DELETE FROM project_expenses WHERE id = ?").bind(expenseId).run();
  await writeAuditLog(env, user, "delete", "project_expense", expenseId, { project_id: expense.project_id, amount: expense.amount }, request);
  return jsonResponse({ ok: true });
}

// ---------- /api/departments/:dept/topics (GET) ----------
async function handleListTopics(request, env, department) {
  const user = await getCurrentUser(request, env);
  if (!user || !user.role) return jsonResponse({ error: "กรุณาเข้าสู่ระบบ" }, 401);
  if (!DEPARTMENTS.includes(department)) return jsonResponse({ error: "ไม่พบฝ่ายงานนี้" }, 404);

  const { results } = await env.DB.prepare(
    "SELECT * FROM work_topics WHERE department = ? ORDER BY title"
  )
    .bind(department)
    .all();

  return jsonResponse({ topics: results });
}

// ---------- /api/departments/:dept/topics (POST) ----------
async function handleCreateTopic(request, env, department) {
  const user = await getCurrentUser(request, env);
  if (!user || !user.role) return jsonResponse({ error: "กรุณาเข้าสู่ระบบ" }, 401);
  if (!DEPARTMENTS.includes(department)) return jsonResponse({ error: "ไม่พบฝ่ายงานนี้" }, 404);
  if (!isAdmin(user)) return jsonResponse({ error: "เฉพาะผู้บริหาร/ผู้ดูแลระบบเท่านั้นที่เพิ่มหัวข้องานได้" }, 403);

  let body;
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ error: "รูปแบบข้อมูลไม่ถูกต้อง" }, 400);
  }

  const title = (body.title || "").trim();
  if (!title) return jsonResponse({ error: "กรุณากรอกชื่อหัวข้องาน" }, 400);

  const result = await env.DB.prepare(
    "INSERT INTO work_topics (department, title, description, created_by) VALUES (?, ?, ?, ?)"
  )
    .bind(department, title, body.description || null, user.id)
    .run();

  return jsonResponse({ id: result.meta.last_row_id }, 201);
}

// ---------- /api/topics/:id (PATCH) ----------
async function handleUpdateTopic(request, env, topicId) {
  const user = await getCurrentUser(request, env);
  if (!user || !user.role) return jsonResponse({ error: "กรุณาเข้าสู่ระบบ" }, 401);
  if (!isAdmin(user)) return jsonResponse({ error: "เฉพาะผู้บริหาร/ผู้ดูแลระบบเท่านั้นที่แก้ไขได้" }, 403);

  let body;
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ error: "รูปแบบข้อมูลไม่ถูกต้อง" }, 400);
  }

  const updates = [];
  const values = [];
  if (body.title !== undefined) {
    updates.push("title = ?");
    values.push(String(body.title).trim());
  }
  if (body.description !== undefined) {
    updates.push("description = ?");
    values.push(body.description || null);
  }
  if (updates.length === 0) return jsonResponse({ error: "ไม่มีข้อมูลที่จะอัปเดต" }, 400);

  values.push(topicId);
  await env.DB.prepare(`UPDATE work_topics SET ${updates.join(", ")} WHERE id = ?`).bind(...values).run();
  return jsonResponse({ ok: true });
}

// ---------- /api/topics/:id (DELETE) ----------
async function handleDeleteTopic(request, env, topicId) {
  const user = await getCurrentUser(request, env);
  if (!user || !user.role) return jsonResponse({ error: "กรุณาเข้าสู่ระบบ" }, 401);
  if (!isAdmin(user)) return jsonResponse({ error: "เฉพาะผู้บริหาร/ผู้ดูแลระบบเท่านั้นที่ลบได้" }, 403);

  await env.DB.prepare("DELETE FROM work_topics WHERE id = ?").bind(topicId).run();
  return jsonResponse({ ok: true });
}

// ---------- วันลา ----------
const LEAVE_TYPES = ["sick", "personal", "maternity", "other"];

// ---------- /api/leave-requests (GET) ----------
async function handleListLeaveRequests(request, env) {
  const user = await getCurrentUser(request, env);
  if (!user || !user.role) return jsonResponse({ error: "กรุณาเข้าสู่ระบบ" }, 401);

  let query, binds;
  if (isAdmin(user)) {
    query = `SELECT lr.*, u.full_name, ap.full_name as approver_name
              FROM leave_requests lr
              JOIN users u ON u.id = lr.user_id
              LEFT JOIN users ap ON ap.id = lr.approved_by
              ORDER BY lr.status ASC, lr.created_at DESC`;
    binds = [];
  } else {
    query = `SELECT lr.*, u.full_name, ap.full_name as approver_name
              FROM leave_requests lr
              JOIN users u ON u.id = lr.user_id
              LEFT JOIN users ap ON ap.id = lr.approved_by
              WHERE lr.user_id = ?
              ORDER BY lr.created_at DESC`;
    binds = [user.id];
  }

  const { results } = await env.DB.prepare(query).bind(...binds).all();
  return jsonResponse({ leave_requests: results });
}

// ---------- /api/leave-requests (POST) ----------
async function handleCreateLeaveRequest(request, env) {
  const user = await getCurrentUser(request, env);
  if (!user || !user.role) return jsonResponse({ error: "กรุณาเข้าสู่ระบบ" }, 401);

  let body;
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ error: "รูปแบบข้อมูลไม่ถูกต้อง" }, 400);
  }

  const leaveType = body.leave_type;
  if (!LEAVE_TYPES.includes(leaveType)) return jsonResponse({ error: "กรุณาเลือกประเภทการลา" }, 400);

  const reason = (body.reason || "").trim();
  if (leaveType === "other" && !reason) {
    return jsonResponse({ error: "กรุณาระบุเหตุผลเมื่อเลือกประเภท 'อื่นๆ'" }, 400);
  }

  if (!body.start_date || !body.end_date) {
    return jsonResponse({ error: "กรุณาระบุวันที่เริ่มและสิ้นสุดการลา" }, 400);
  }
  if (body.end_date < body.start_date) {
    return jsonResponse({ error: "วันที่สิ้นสุดต้องไม่ก่อนวันที่เริ่ม" }, 400);
  }

  const result = await env.DB.prepare(
    `INSERT INTO leave_requests (user_id, leave_type, reason, start_date, end_date)
     VALUES (?, ?, ?, ?, ?)`
  )
    .bind(user.id, leaveType, reason || null, body.start_date, body.end_date)
    .run();

  return jsonResponse({ id: result.meta.last_row_id }, 201);
}

// ---------- /api/leave-requests/:id (PATCH) — อนุมัติ/ไม่อนุมัติ (admin เท่านั้น) ----------
async function handleUpdateLeaveRequest(request, env, leaveId) {
  const user = await getCurrentUser(request, env);
  if (!user || !user.role) return jsonResponse({ error: "กรุณาเข้าสู่ระบบ" }, 401);
  if (!isAdmin(user)) return jsonResponse({ error: "เฉพาะผู้บริหาร/ผู้ดูแลระบบเท่านั้นที่อนุมัติได้" }, 403);

  let body;
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ error: "รูปแบบข้อมูลไม่ถูกต้อง" }, 400);
  }

  if (!["approved", "rejected"].includes(body.status)) {
    return jsonResponse({ error: "สถานะไม่ถูกต้อง" }, 400);
  }

  await env.DB.prepare(
    "UPDATE leave_requests SET status = ?, approved_by = ?, approved_at = ? WHERE id = ?"
  )
    .bind(body.status, user.id, new Date().toISOString(), leaveId)
    .run();

  return jsonResponse({ ok: true });
}

// ---------- /api/leave-requests/:id (DELETE) — ผู้ยื่นยกเลิกคำขอที่ยังรอดำเนินการ ----------
async function handleDeleteLeaveRequest(request, env, leaveId) {
  const user = await getCurrentUser(request, env);
  if (!user || !user.role) return jsonResponse({ error: "กรุณาเข้าสู่ระบบ" }, 401);

  const row = await env.DB.prepare("SELECT user_id, status FROM leave_requests WHERE id = ?")
    .bind(leaveId)
    .first();
  if (!row) return jsonResponse({ error: "ไม่พบคำขอลานี้" }, 404);
  if (row.user_id !== user.id && !isAdmin(user)) {
    return jsonResponse({ error: "ไม่มีสิทธิ์ยกเลิกคำขอนี้" }, 403);
  }
  if (row.status !== "pending" && !isAdmin(user)) {
    return jsonResponse({ error: "ยกเลิกได้เฉพาะคำขอที่ยังรอดำเนินการ" }, 400);
  }

  await env.DB.prepare("DELETE FROM leave_requests WHERE id = ?").bind(leaveId).run();
  return jsonResponse({ ok: true });
}

// ---------- ระบบดูแลช่วยเหลือนักเรียน ----------
const SUPPORT_TYPES = ["screening", "home_visit", "scholarship", "risk", "behavior", "assistance", "referral"];
const SUPPORT_LEVELS = ["normal", "watch", "high", "urgent"];
const SUPPORT_STATUS = ["open", "monitoring", "closed"];
async function handleListSupportCases(request, env) {
  const user = await getCurrentUser(request, env);
  if (!user || !user.role) return jsonResponse({ error: "กรุณาเข้าสู่ระบบ" }, 401);
  await ensureExtendedSchema(env);
  const url = new URL(request.url);
  const studentId = Number(url.searchParams.get("student_id"));
  const query = `SELECT c.*, s.student_code, s.full_name AS student_name, u.full_name AS creator_name
    FROM student_support_cases c JOIN students s ON s.id=c.student_id LEFT JOIN users u ON u.id=c.created_by
    ${studentId > 0 ? "WHERE c.student_id = ?" : ""} ORDER BY c.risk_level DESC, c.updated_at DESC`;
  const result = studentId > 0 ? await env.DB.prepare(query).bind(studentId).all() : await env.DB.prepare(query).all();
  return jsonResponse({ cases: result.results });
}
async function handleCreateSupportCase(request, env) {
  const user = await getCurrentUser(request, env);
  if (!user || !user.role) return jsonResponse({ error: "กรุณาเข้าสู่ระบบ" }, 401);
  if (!(isAdmin(user) || user.role === "staff" || user.role === "teacher")) return jsonResponse({ error: "ไม่มีสิทธิ์บันทึกข้อมูล" }, 403);
  await ensureExtendedSchema(env);
  const body = await request.json().catch(() => null);
  if (!body || !body.student_id || !SUPPORT_TYPES.includes(body.case_type) || !body.summary) return jsonResponse({ error: "กรุณากรอกข้อมูลกรณีช่วยเหลือให้ครบถ้วน" }, 400);
  const level = SUPPORT_LEVELS.includes(body.risk_level) ? body.risk_level : "normal";
  const result = await env.DB.prepare(`INSERT INTO student_support_cases
    (student_id, case_type, risk_level, summary, action_taken, follow_up_date, status, referred_to, created_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(body.student_id, body.case_type, level, body.summary.trim(), body.action_taken || null,
      body.follow_up_date || null, SUPPORT_STATUS.includes(body.status) ? body.status : "open", body.referred_to || null, user.id).run();
  return jsonResponse({ id: result.meta.last_row_id }, 201);
}
async function handleUpdateSupportCase(request, env, caseId) {
  const user = await getCurrentUser(request, env);
  if (!user || !user.role) return jsonResponse({ error: "กรุณาเข้าสู่ระบบ" }, 401);
  if (!isAdmin(user) && user.role !== "staff" && user.role !== "teacher") return jsonResponse({ error: "ไม่มีสิทธิ์แก้ไขข้อมูล" }, 403);
  await ensureExtendedSchema(env);
  const body = await request.json().catch(() => null);
  if (!body) return jsonResponse({ error: "รูปแบบข้อมูลไม่ถูกต้อง" }, 400);
  const allowed = ["risk_level", "summary", "action_taken", "follow_up_date", "status", "referred_to"];
  const updates = [], values = [];
  for (const field of allowed) if (body[field] !== undefined) { updates.push(`${field} = ?`); values.push(body[field] || null); }
  if (!updates.length) return jsonResponse({ error: "ไม่มีข้อมูลที่จะอัปเดต" }, 400);
  updates.push("updated_at = datetime('now')"); values.push(caseId);
  await env.DB.prepare(`UPDATE student_support_cases SET ${updates.join(", ")} WHERE id = ?`).bind(...values).run();
  return jsonResponse({ ok: true });
}

// ---------- ระบบพัสดุและครุภัณฑ์ ----------
const INVENTORY_TYPES = ["material", "equipment"];
const INVENTORY_CONDITIONS = ["good", "fair", "damaged", "lost"];
const INVENTORY_STATUSES = ["active", "repair", "disposed", "lost"];
const INVENTORY_TRANSACTION_EFFECT = {
  opening: 1, receive: 1, return: 1, adjust_in: 1,
  issue: -1, borrow: -1, adjust_out: -1, dispose: -1,
  transfer: 0, repair: 0,
};

function canManageInventory(user) {
  return isAdmin(user) || user?.role === "staff";
}

function cleanText(value, maxLength = 500) {
  const text = String(value || "").trim();
  return text ? text.slice(0, maxLength) : null;
}

// ---------- ศูนย์ปฏิบัติงานของหัวข้อที่ยังไม่มีระบบเฉพาะ ----------
const WORK_RECORD_AREAS = new Set(["staff", "academic", "budget", "personnel", "general"]);
const WORK_RECORD_STATUSES = ["planned", "in_progress", "waiting", "completed", "cancelled"];
const WORK_RECORD_PRIORITIES = ["low", "normal", "high", "urgent"];

function validIsoDateOrEmpty(value) {
  return !value || /^\d{4}-\d{2}-\d{2}$/.test(String(value));
}

function canManageWorkRecord(user, record) {
  return !!user && (isAdmin(user) || user.role === "staff" || record.created_by === user.id || record.responsible_user_id === user.id);
}

async function handleListWorkRecords(request, env) {
  const user = await getCurrentUser(request, env);
  if (!user || !user.role) return jsonResponse({ error: "กรุณาเข้าสู่ระบบ" }, 401);
  const params = new URL(request.url).searchParams;
  const area = cleanText(params.get("area"), 40);
  const topicKey = cleanText(params.get("topic"), 80);
  const topicKeys = topicKey ? topicKey.split(",").map((key) => cleanText(key, 80)).filter(Boolean) : [];
  const status = cleanText(params.get("status"), 30);
  const q = cleanText(params.get("q"), 100);
  const academicYearId = Number(params.get("academic_year_id")) || null;
  if (area && !WORK_RECORD_AREAS.has(area)) return jsonResponse({ error: "หมวดงานไม่ถูกต้อง" }, 400);
  if (status && !WORK_RECORD_STATUSES.includes(status)) return jsonResponse({ error: "สถานะไม่ถูกต้อง" }, 400);

  const baseConditions = ["1=1"];
  const baseBinds = [];
  if (area) { baseConditions.push("w.area=?"); baseBinds.push(area); }
  if (topicKeys.length) {
    baseConditions.push(`w.topic_key IN (${topicKeys.map(() => "?").join(",")})`);
    baseBinds.push(...topicKeys);
  }
  if (academicYearId) { baseConditions.push("w.academic_year_id=?"); baseBinds.push(academicYearId); }
  if (q) {
    baseConditions.push("(w.title LIKE ? OR COALESCE(w.description,'') LIKE ? OR COALESCE(w.notes,'') LIKE ? OR w.topic_label LIKE ?)");
    const like = `%${q}%`;
    baseBinds.push(like, like, like, like);
  }
  const listConditions = [...baseConditions];
  const listBinds = [...baseBinds];
  if (status) { listConditions.push("w.status=?"); listBinds.push(status); }

  const [listResult, summaryResult, currentPeriod] = await Promise.all([
    env.DB.prepare(`SELECT w.*, creator.full_name AS creator_name, responsible.full_name AS responsible_name,
        y.year_be, t.name AS term_name, a.id AS attachment_id, a.file_name AS attachment_name
      FROM work_records w
      LEFT JOIN users creator ON creator.id=w.created_by
      LEFT JOIN users responsible ON responsible.id=w.responsible_user_id
      LEFT JOIN academic_years y ON y.id=w.academic_year_id
      LEFT JOIN academic_terms t ON t.id=w.academic_term_id
      LEFT JOIN file_attachments a ON a.entity_type='work_record' AND a.entity_id=w.id
      WHERE ${listConditions.join(" AND ")}
      ORDER BY CASE w.priority WHEN 'urgent' THEN 1 WHEN 'high' THEN 2 WHEN 'normal' THEN 3 ELSE 4 END,
        CASE WHEN w.due_date IS NULL THEN 1 ELSE 0 END,w.due_date,w.updated_at DESC,w.id DESC LIMIT 250`).bind(...listBinds).all(),
    env.DB.prepare(`SELECT COUNT(*) AS total,
        SUM(CASE WHEN w.status='planned' THEN 1 ELSE 0 END) AS planned,
        SUM(CASE WHEN w.status='in_progress' THEN 1 ELSE 0 END) AS in_progress,
        SUM(CASE WHEN w.status='waiting' THEN 1 ELSE 0 END) AS waiting,
        SUM(CASE WHEN w.status='completed' THEN 1 ELSE 0 END) AS completed,
        SUM(CASE WHEN w.status NOT IN ('completed','cancelled') AND w.due_date < date('now') THEN 1 ELSE 0 END) AS overdue
      FROM work_records w WHERE ${baseConditions.join(" AND ")}`).bind(...baseBinds).first(),
    getCurrentAcademicPeriod(env),
  ]);
  return jsonResponse({
    records: listResult.results.map((record) => ({ ...record, can_manage: canManageWorkRecord(user, record) })),
    summary: summaryResult,
    current_academic_period: currentPeriod,
    permissions: { can_create: true, can_manage_all: isAdmin(user) || user.role === "staff" },
  });
}

async function handleGetWorkRecord(request, env, recordId) {
  const user = await getCurrentUser(request, env);
  if (!user || !user.role) return jsonResponse({ error: "กรุณาเข้าสู่ระบบ" }, 401);
  const record = await env.DB.prepare(`SELECT w.*, creator.full_name AS creator_name, responsible.full_name AS responsible_name,
      y.year_be,t.name AS term_name,a.id AS attachment_id,a.file_name AS attachment_name
    FROM work_records w
    LEFT JOIN users creator ON creator.id=w.created_by LEFT JOIN users responsible ON responsible.id=w.responsible_user_id
    LEFT JOIN academic_years y ON y.id=w.academic_year_id LEFT JOIN academic_terms t ON t.id=w.academic_term_id
    LEFT JOIN file_attachments a ON a.entity_type='work_record' AND a.entity_id=w.id WHERE w.id=?`).bind(recordId).first();
  if (!record) return jsonResponse({ error: "ไม่พบรายการงาน" }, 404);
  const { results: updates } = await env.DB.prepare(`SELECT x.*,u.full_name AS created_by_name
    FROM work_record_updates x LEFT JOIN users u ON u.id=x.created_by
    WHERE x.work_record_id=? ORDER BY x.created_at DESC,x.id DESC`).bind(recordId).all();
  return jsonResponse({ record: { ...record, can_manage: canManageWorkRecord(user, record) }, updates });
}

async function handleCreateWorkRecord(request, env) {
  const user = await getCurrentUser(request, env);
  if (!user || !user.role) return jsonResponse({ error: "กรุณาเข้าสู่ระบบ" }, 401);
  const body = await request.json().catch(() => null);
  if (!body) return jsonResponse({ error: "รูปแบบข้อมูลไม่ถูกต้อง" }, 400);
  const area = cleanText(body.area, 40);
  const topicKey = cleanText(body.topic_key, 80);
  const topicLabel = cleanText(body.topic_label, 200);
  const title = cleanText(body.title, 240);
  const status = WORK_RECORD_STATUSES.includes(body.status) ? body.status : "planned";
  const priority = WORK_RECORD_PRIORITIES.includes(body.priority) ? body.priority : "normal";
  const startDate = cleanText(body.start_date, 10);
  const dueDate = cleanText(body.due_date, 10);
  if (!WORK_RECORD_AREAS.has(area)) return jsonResponse({ error: "หมวดงานไม่ถูกต้อง" }, 400);
  if (!topicKey || !topicLabel || !title) return jsonResponse({ error: "กรุณาระบุหัวข้องานและชื่อรายการ" }, 400);
  if (!validIsoDateOrEmpty(startDate) || !validIsoDateOrEmpty(dueDate) || (startDate && dueDate && startDate > dueDate)) {
    return jsonResponse({ error: "ช่วงวันที่ไม่ถูกต้อง" }, 400);
  }
  const responsibleId = Number(body.responsible_user_id) || user.id;
  const responsible = await env.DB.prepare("SELECT id FROM users WHERE id=? AND status='active' AND role IS NOT NULL").bind(responsibleId).first();
  if (!responsible) return jsonResponse({ error: "ไม่พบผู้รับผิดชอบที่เลือก" }, 400);
  const current = await getCurrentAcademicPeriod(env);
  const progress = status === "completed" ? 100 : Math.max(0, Math.min(100, Number(body.progress_percent) || 0));
  const result = await env.DB.prepare(`INSERT INTO work_records
      (area,topic_key,topic_label,title,description,academic_year_id,academic_term_id,responsible_user_id,
       start_date,due_date,status,priority,progress_percent,notes,created_by,updated_by)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(
      area,topicKey,topicLabel,title,cleanText(body.description,3000),Number(body.academic_year_id)||current?.academic_year_id||null,
      Number(body.academic_term_id)||current?.academic_term_id||null,responsibleId,startDate,dueDate,status,priority,progress,
      cleanText(body.notes,2000),user.id,user.id).run();
  const recordId = result.meta.last_row_id;
  await env.DB.prepare(`INSERT INTO work_record_updates(work_record_id,new_status,progress_percent,comment,created_by)
    VALUES (?,?,?,?,?)`).bind(recordId,status,progress,"สร้างรายการงาน",user.id).run();
  await writeAuditLog(env,user,"create","work_record",recordId,{ area,topic_key:topicKey,status },request);
  return jsonResponse({ id: recordId }, 201);
}

async function handleUpdateWorkRecord(request, env, recordId) {
  const user = await getCurrentUser(request, env);
  if (!user || !user.role) return jsonResponse({ error: "กรุณาเข้าสู่ระบบ" }, 401);
  const existing = await env.DB.prepare("SELECT * FROM work_records WHERE id=?").bind(recordId).first();
  if (!existing) return jsonResponse({ error: "ไม่พบรายการงาน" }, 404);
  if (!canManageWorkRecord(user, existing)) return jsonResponse({ error: "ไม่มีสิทธิ์แก้ไขรายการนี้" }, 403);
  const body = await request.json().catch(() => null);
  if (!body) return jsonResponse({ error: "รูปแบบข้อมูลไม่ถูกต้อง" }, 400);
  const title = body.title === undefined ? existing.title : cleanText(body.title,240);
  if (!title) return jsonResponse({ error: "กรุณาระบุชื่อรายการ" }, 400);
  const status = body.status === undefined ? existing.status : body.status;
  const priority = body.priority === undefined ? existing.priority : body.priority;
  if (!WORK_RECORD_STATUSES.includes(status) || !WORK_RECORD_PRIORITIES.includes(priority)) return jsonResponse({ error: "สถานะหรือความสำคัญไม่ถูกต้อง" },400);
  const startDate = body.start_date === undefined ? existing.start_date : cleanText(body.start_date,10);
  const dueDate = body.due_date === undefined ? existing.due_date : cleanText(body.due_date,10);
  if (!validIsoDateOrEmpty(startDate) || !validIsoDateOrEmpty(dueDate) || (startDate && dueDate && startDate > dueDate)) return jsonResponse({ error:"ช่วงวันที่ไม่ถูกต้อง" },400);
  const responsibleId = body.responsible_user_id === undefined ? existing.responsible_user_id : Number(body.responsible_user_id)||user.id;
  const responsible = await env.DB.prepare("SELECT id FROM users WHERE id=? AND status='active' AND role IS NOT NULL").bind(responsibleId).first();
  if (!responsible) return jsonResponse({ error:"ไม่พบผู้รับผิดชอบที่เลือก" },400);
  const progress = status === "completed" ? 100 : Math.max(0,Math.min(100,body.progress_percent===undefined?Number(existing.progress_percent):Number(body.progress_percent)||0));
  await env.DB.prepare(`UPDATE work_records SET title=?,description=?,responsible_user_id=?,start_date=?,due_date=?,status=?,priority=?,
      progress_percent=?,notes=?,updated_by=?,updated_at=datetime('now') WHERE id=?`).bind(
      title,body.description===undefined?existing.description:cleanText(body.description,3000),responsibleId,startDate,dueDate,status,priority,progress,
      body.notes===undefined?existing.notes:cleanText(body.notes,2000),user.id,recordId).run();
  const comment = cleanText(body.comment,1000);
  if (status !== existing.status || progress !== Number(existing.progress_percent) || comment) {
    await env.DB.prepare(`INSERT INTO work_record_updates(work_record_id,previous_status,new_status,progress_percent,comment,created_by)
      VALUES (?,?,?,?,?,?)`).bind(recordId,existing.status,status,progress,comment,user.id).run();
  }
  await writeAuditLog(env,user,"update","work_record",recordId,{ fields:Object.keys(body),status,progress_percent:progress },request);
  return jsonResponse({ ok:true });
}

async function handleInventorySummary(request, env) {
  const user = await getCurrentUser(request, env);
  if (!user || !user.role) return jsonResponse({ error: "กรุณาเข้าสู่ระบบ" }, 401);
  const totals = await env.DB.prepare(`SELECT COUNT(*) AS item_count,
      SUM(CASE WHEN item_type='material' THEN 1 ELSE 0 END) AS material_count,
      SUM(CASE WHEN item_type='equipment' THEN 1 ELSE 0 END) AS equipment_count,
      COALESCE(SUM(current_quantity * unit_price), 0) AS total_value,
      SUM(CASE WHEN status='active' AND minimum_quantity > 0 AND current_quantity <= minimum_quantity THEN 1 ELSE 0 END) AS low_stock_count,
      SUM(CASE WHEN status IN ('repair','lost') OR item_condition IN ('damaged','lost') THEN 1 ELSE 0 END) AS attention_count
    FROM inventory_items`).first();
  const overdue = await env.DB.prepare(`SELECT COUNT(*) AS count FROM inventory_transactions b
    WHERE b.transaction_type='borrow' AND b.due_date IS NOT NULL AND b.due_date < date('now')
      AND b.quantity > COALESCE((SELECT SUM(r.quantity) FROM inventory_transactions r
        WHERE r.transaction_type='return' AND r.related_transaction_id=b.id), 0)`).first();
  const inspectionsDue = await env.DB.prepare(`SELECT COUNT(*) AS count FROM inventory_inspections i
    WHERE i.next_inspection_date IS NOT NULL AND i.next_inspection_date <= date('now', '+30 day')
      AND i.id = (SELECT i2.id FROM inventory_inspections i2 WHERE i2.item_id=i.item_id ORDER BY i2.inspection_date DESC, i2.id DESC LIMIT 1)`).first();
  return jsonResponse({
    item_count: Number(totals?.item_count || 0),
    material_count: Number(totals?.material_count || 0),
    equipment_count: Number(totals?.equipment_count || 0),
    total_value: Number(totals?.total_value || 0),
    low_stock_count: Number(totals?.low_stock_count || 0),
    attention_count: Number(totals?.attention_count || 0),
    overdue_borrow_count: Number(overdue?.count || 0),
    inspections_due_count: Number(inspectionsDue?.count || 0),
    can_manage: canManageInventory(user),
  });
}

async function handleListInventoryItems(request, env) {
  const user = await getCurrentUser(request, env);
  if (!user || !user.role) return jsonResponse({ error: "กรุณาเข้าสู่ระบบ" }, 401);
  const params = new URL(request.url).searchParams;
  const q = cleanText(params.get("q"), 100) || "";
  const itemType = INVENTORY_TYPES.includes(params.get("type")) ? params.get("type") : "";
  const status = INVENTORY_STATUSES.includes(params.get("status")) ? params.get("status") : "";
  const department = DEPARTMENTS.includes(params.get("department")) ? params.get("department") : "";
  const lowStock = params.get("low_stock") === "1" ? 1 : 0;
  const { results } = await env.DB.prepare(`SELECT i.*,
      (i.current_quantity * i.unit_price) AS total_value,
      (SELECT MAX(inspection_date) FROM inventory_inspections x WHERE x.item_id=i.id) AS last_inspection_date,
      (SELECT next_inspection_date FROM inventory_inspections x WHERE x.item_id=i.id ORDER BY inspection_date DESC, id DESC LIMIT 1) AS next_inspection_date
    FROM inventory_items i
    WHERE (?='' OR i.item_code LIKE '%'||?||'%' OR i.name LIKE '%'||?||'%' OR i.category LIKE '%'||?||'%' OR i.serial_number LIKE '%'||?||'%')
      AND (?='' OR i.item_type=?) AND (?='' OR i.status=?) AND (?='' OR i.department=?)
      AND (?=0 OR (i.minimum_quantity > 0 AND i.current_quantity <= i.minimum_quantity))
    ORDER BY CASE i.status WHEN 'active' THEN 1 WHEN 'repair' THEN 2 ELSE 3 END, i.name, i.item_code`)
    .bind(q, q, q, q, q, itemType, itemType, status, status, department, department, lowStock).all();
  return jsonResponse({ items: results.map((row) => ({
    ...row,
    current_quantity: Number(row.current_quantity || 0), minimum_quantity: Number(row.minimum_quantity || 0),
    unit_price: Number(row.unit_price || 0), total_value: Number(row.total_value || 0),
  })), can_manage: canManageInventory(user) });
}

async function handleCreateInventoryItem(request, env) {
  const user = await getCurrentUser(request, env);
  if (!user || !user.role) return jsonResponse({ error: "กรุณาเข้าสู่ระบบ" }, 401);
  if (!canManageInventory(user)) return jsonResponse({ error: "เฉพาะผู้บริหารหรือเจ้าหน้าที่เท่านั้นที่เพิ่มทะเบียนพัสดุได้" }, 403);
  const body = await request.json().catch(() => null);
  const itemCode = cleanText(body?.item_code, 80);
  const name = cleanText(body?.name, 200);
  if (!body || !itemCode || !name || !INVENTORY_TYPES.includes(body.item_type)) {
    return jsonResponse({ error: "กรุณาระบุรหัส ชื่อ และประเภทพัสดุให้ครบถ้วน" }, 400);
  }
  const department = DEPARTMENTS.includes(body.department) ? body.department : "budget";
  const openingQuantity = Number(body.opening_quantity || 0);
  const minimumQuantity = Number(body.minimum_quantity || 0);
  const unitPrice = Number(body.unit_price || 0);
  if (![openingQuantity, minimumQuantity, unitPrice].every(Number.isFinite) || openingQuantity < 0 || minimumQuantity < 0 || unitPrice < 0) {
    return jsonResponse({ error: "จำนวนและมูลค่าต้องเป็นตัวเลขตั้งแต่ 0 ขึ้นไป" }, 400);
  }
  for (const field of ["purchase_date", "warranty_expiry"]) {
    if (body[field] && !isIsoDate(body[field])) return jsonResponse({ error: `วันที่ ${field} ไม่ถูกต้อง` }, 400);
  }
  try {
    const result = await env.DB.prepare(`INSERT INTO inventory_items
      (item_code,name,item_type,category,unit,department,location,custodian,minimum_quantity,unit_price,brand_model,serial_number,
       purchase_date,fiscal_year,budget_source,vendor,warranty_expiry,item_condition,status,notes,created_by)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(
        itemCode, name, body.item_type, cleanText(body.category, 120), cleanText(body.unit, 40) || "ชิ้น", department,
        cleanText(body.location, 160), cleanText(body.custodian, 160), minimumQuantity, unitPrice,
        cleanText(body.brand_model, 160), cleanText(body.serial_number, 120), body.purchase_date || null,
        cleanText(body.fiscal_year, 20), cleanText(body.budget_source, 160), cleanText(body.vendor, 160), body.warranty_expiry || null,
        INVENTORY_CONDITIONS.includes(body.item_condition) ? body.item_condition : "good",
        INVENTORY_STATUSES.includes(body.status) ? body.status : "active", cleanText(body.notes, 1000), user.id
      ).run();
    const itemId = result.meta.last_row_id;
    if (openingQuantity > 0) {
      await env.DB.prepare(`INSERT INTO inventory_transactions
        (item_id,transaction_type,transaction_date,document_no,quantity,quantity_change,unit_price,to_location,notes,created_by)
        VALUES (?, 'opening', date('now'), ?, ?, ?, ?, ?, ?, ?)`)
        .bind(itemId, `OPENING-${itemCode}`, openingQuantity, openingQuantity, unitPrice, cleanText(body.location, 160), "ยอดยกมาเมื่อสร้างทะเบียน", user.id).run();
    }
    await writeAuditLog(env, user, "create", "inventory_item", itemId, { item_code: itemCode, opening_quantity: openingQuantity }, request);
    return jsonResponse({ id: itemId }, 201);
  } catch (error) {
    if (String(error).includes("UNIQUE")) return jsonResponse({ error: "รหัสพัสดุนี้มีอยู่ในระบบแล้ว" }, 409);
    throw error;
  }
}

async function handleGetInventoryItem(request, env, itemId) {
  const user = await getCurrentUser(request, env);
  if (!user || !user.role) return jsonResponse({ error: "กรุณาเข้าสู่ระบบ" }, 401);
  const item = await env.DB.prepare("SELECT *, current_quantity * unit_price AS total_value FROM inventory_items WHERE id=?").bind(itemId).first();
  if (!item) return jsonResponse({ error: "ไม่พบรายการพัสดุ" }, 404);
  const { results: transactions } = await env.DB.prepare(`SELECT t.*, u.full_name AS creator_name, a.id AS attachment_id, a.file_name AS attachment_name,
      COALESCE((SELECT SUM(r.quantity) FROM inventory_transactions r WHERE r.transaction_type='return' AND r.related_transaction_id=t.id),0) AS returned_quantity
    FROM inventory_transactions t LEFT JOIN users u ON u.id=t.created_by
    LEFT JOIN file_attachments a ON a.entity_type='inventory_transaction' AND a.entity_id=t.id
    WHERE t.item_id=? ORDER BY t.transaction_date DESC,t.id DESC`).bind(itemId).all();
  const { results: inspections } = await env.DB.prepare(`SELECT i.*,u.full_name AS creator_name,a.id AS attachment_id,a.file_name AS attachment_name
    FROM inventory_inspections i LEFT JOIN users u ON u.id=i.created_by
    LEFT JOIN file_attachments a ON a.entity_type='inventory_inspection' AND a.entity_id=i.id
    WHERE i.item_id=? ORDER BY i.inspection_date DESC,i.id DESC`).bind(itemId).all();
  return jsonResponse({
    item: { ...item, current_quantity: Number(item.current_quantity || 0), minimum_quantity: Number(item.minimum_quantity || 0), unit_price: Number(item.unit_price || 0), total_value: Number(item.total_value || 0) },
    transactions: transactions.map((row) => ({ ...row, quantity: Number(row.quantity || 0), quantity_change: Number(row.quantity_change || 0), returned_quantity: Number(row.returned_quantity || 0) })),
    inspections: inspections.map((row) => ({ ...row, quantity_found: Number(row.quantity_found || 0) })),
    can_manage: canManageInventory(user),
  });
}

async function handleUpdateInventoryItem(request, env, itemId) {
  const user = await getCurrentUser(request, env);
  if (!user || !user.role) return jsonResponse({ error: "กรุณาเข้าสู่ระบบ" }, 401);
  if (!canManageInventory(user)) return jsonResponse({ error: "ไม่มีสิทธิ์แก้ไขทะเบียนพัสดุ" }, 403);
  const exists = await env.DB.prepare("SELECT id FROM inventory_items WHERE id=?").bind(itemId).first();
  if (!exists) return jsonResponse({ error: "ไม่พบรายการพัสดุ" }, 404);
  const body = await request.json().catch(() => null);
  if (!body) return jsonResponse({ error: "รูปแบบข้อมูลไม่ถูกต้อง" }, 400);
  const textFields = ["name","category","unit","location","custodian","brand_model","serial_number","fiscal_year","budget_source","vendor","notes"];
  const updates = [], values = [];
  for (const field of textFields) if (body[field] !== undefined) { updates.push(`${field}=?`); values.push(cleanText(body[field], field === "notes" ? 1000 : 200)); }
  for (const field of ["minimum_quantity","unit_price"]) if (body[field] !== undefined) {
    const value = Number(body[field]);
    if (!Number.isFinite(value) || value < 0) return jsonResponse({ error: "จำนวนและมูลค่าต้องไม่น้อยกว่า 0" }, 400);
    updates.push(`${field}=?`); values.push(value);
  }
  if (body.department !== undefined) { if (!DEPARTMENTS.includes(body.department)) return jsonResponse({ error: "ฝ่ายงานไม่ถูกต้อง" }, 400); updates.push("department=?"); values.push(body.department); }
  if (body.item_condition !== undefined) { if (!INVENTORY_CONDITIONS.includes(body.item_condition)) return jsonResponse({ error: "สภาพพัสดุไม่ถูกต้อง" }, 400); updates.push("item_condition=?"); values.push(body.item_condition); }
  if (body.status !== undefined) { if (!INVENTORY_STATUSES.includes(body.status)) return jsonResponse({ error: "สถานะพัสดุไม่ถูกต้อง" }, 400); updates.push("status=?"); values.push(body.status); }
  for (const field of ["purchase_date","warranty_expiry"]) if (body[field] !== undefined) {
    if (body[field] && !isIsoDate(body[field])) return jsonResponse({ error: "วันที่ไม่ถูกต้อง" }, 400);
    updates.push(`${field}=?`); values.push(body[field] || null);
  }
  if (!updates.length) return jsonResponse({ error: "ไม่มีข้อมูลที่จะอัปเดต" }, 400);
  updates.push("updated_at=datetime('now')"); values.push(itemId);
  await env.DB.prepare(`UPDATE inventory_items SET ${updates.join(",")} WHERE id=?`).bind(...values).run();
  await writeAuditLog(env, user, "update", "inventory_item", itemId, { fields: Object.keys(body) }, request);
  return jsonResponse({ ok: true });
}

async function handleCreateInventoryTransaction(request, env, itemId) {
  const user = await getCurrentUser(request, env);
  if (!user || !user.role) return jsonResponse({ error: "กรุณาเข้าสู่ระบบ" }, 401);
  if (!canManageInventory(user)) return jsonResponse({ error: "ไม่มีสิทธิ์บันทึกการเคลื่อนไหวพัสดุ" }, 403);
  const item = await env.DB.prepare("SELECT * FROM inventory_items WHERE id=?").bind(itemId).first();
  if (!item) return jsonResponse({ error: "ไม่พบรายการพัสดุ" }, 404);
  const body = await request.json().catch(() => null);
  const type = body?.transaction_type;
  const quantity = Number(body?.quantity);
  if (!body || !(type in INVENTORY_TRANSACTION_EFFECT) || type === "opening" || !isIsoDate(body.transaction_date) || !Number.isFinite(quantity) || quantity <= 0) {
    return jsonResponse({ error: "กรุณาระบุประเภทรายการ วันที่ และจำนวนให้ถูกต้อง" }, 400);
  }
  const effect = INVENTORY_TRANSACTION_EFFECT[type];
  const quantityChange = effect * quantity;
  let relatedTransactionId = null;
  if (type === "return") {
    relatedTransactionId = Number(body.related_transaction_id);
    const borrow = await env.DB.prepare(`SELECT b.id,b.quantity,
      COALESCE((SELECT SUM(r.quantity) FROM inventory_transactions r WHERE r.transaction_type='return' AND r.related_transaction_id=b.id),0) AS returned
      FROM inventory_transactions b WHERE b.id=? AND b.item_id=? AND b.transaction_type='borrow'`).bind(relatedTransactionId, itemId).first();
    if (!borrow || Number(borrow.returned || 0) + quantity > Number(borrow.quantity)) return jsonResponse({ error: "รายการยืมหรือจำนวนที่คืนไม่ถูกต้อง" }, 400);
  }
  if (quantityChange < 0 && Number(item.current_quantity) < quantity) return jsonResponse({ error: `ยอดคงเหลือไม่พอ ปัจจุบันมี ${item.current_quantity} ${item.unit}` }, 409);
  const unitPrice = body.unit_price === "" || body.unit_price == null ? null : Number(body.unit_price);
  if (unitPrice !== null && (!Number.isFinite(unitPrice) || unitPrice < 0)) return jsonResponse({ error: "ราคาต่อหน่วยไม่ถูกต้อง" }, 400);
  try {
    const result = await env.DB.prepare(`INSERT INTO inventory_transactions
      (item_id,transaction_type,transaction_date,document_no,quantity,quantity_change,related_transaction_id,unit_price,
       from_location,to_location,recipient,due_date,notes,created_by) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(
      itemId,type,body.transaction_date,cleanText(body.document_no,100),quantity,quantityChange,relatedTransactionId,unitPrice,
      cleanText(body.from_location,160),cleanText(body.to_location,160),cleanText(body.recipient,160),body.due_date || null,cleanText(body.notes,1000),user.id
    ).run();
    if (type === "transfer" && cleanText(body.to_location,160)) await env.DB.prepare("UPDATE inventory_items SET location=?,updated_at=datetime('now') WHERE id=?").bind(cleanText(body.to_location,160),itemId).run();
    if (type === "repair") await env.DB.prepare("UPDATE inventory_items SET status='repair',updated_at=datetime('now') WHERE id=?").bind(itemId).run();
    if (type === "dispose" && Number(item.current_quantity) === quantity) await env.DB.prepare("UPDATE inventory_items SET status='disposed',updated_at=datetime('now') WHERE id=?").bind(itemId).run();
    await writeAuditLog(env,user,"create","inventory_transaction",result.meta.last_row_id,{item_id:itemId,type,quantity,quantity_change:quantityChange},request);
    return jsonResponse({ id: result.meta.last_row_id },201);
  } catch (error) {
    if (String(error).includes("INSUFFICIENT_INVENTORY")) return jsonResponse({ error: "ยอดพัสดุคงเหลือไม่เพียงพอ" },409);
    throw error;
  }
}

async function handleCreateInventoryInspection(request, env, itemId) {
  const user = await getCurrentUser(request, env);
  if (!user || !user.role) return jsonResponse({ error: "กรุณาเข้าสู่ระบบ" },401);
  if (!canManageInventory(user)) return jsonResponse({ error: "ไม่มีสิทธิ์บันทึกการตรวจนับ" },403);
  const item = await env.DB.prepare("SELECT * FROM inventory_items WHERE id=?").bind(itemId).first();
  if (!item) return jsonResponse({ error: "ไม่พบรายการพัสดุ" },404);
  const body = await request.json().catch(()=>null);
  const quantityFound = Number(body?.quantity_found);
  if (!body || !isIsoDate(body.inspection_date) || !Number.isFinite(quantityFound) || quantityFound < 0 || !INVENTORY_CONDITIONS.includes(body.item_condition)) {
    return jsonResponse({ error: "กรุณาระบุวันที่ จำนวนที่พบ และสภาพพัสดุให้ถูกต้อง" },400);
  }
  if (body.next_inspection_date && !isIsoDate(body.next_inspection_date)) return jsonResponse({ error: "วันตรวจครั้งถัดไปไม่ถูกต้อง" },400);
  let result = "matched";
  if (["damaged","lost"].includes(body.item_condition)) result = "damaged";
  else if (quantityFound < Number(item.current_quantity)) result = "shortage";
  else if (quantityFound > Number(item.current_quantity)) result = "surplus";
  const inserted = await env.DB.prepare(`INSERT INTO inventory_inspections
    (item_id,inspection_date,quantity_found,item_condition,result,location,inspector,notes,next_inspection_date,created_by)
    VALUES (?,?,?,?,?,?,?,?,?,?)`).bind(itemId,body.inspection_date,quantityFound,body.item_condition,result,
      cleanText(body.location,160) || item.location,cleanText(body.inspector,160) || user.full_name,cleanText(body.notes,1000),body.next_inspection_date || null,user.id).run();
  await env.DB.prepare("UPDATE inventory_items SET item_condition=?,location=COALESCE(?,location),updated_at=datetime('now') WHERE id=?")
    .bind(body.item_condition,cleanText(body.location,160),itemId).run();
  await writeAuditLog(env,user,"create","inventory_inspection",inserted.meta.last_row_id,{item_id:itemId,result,quantity_found:quantityFound},request);
  return jsonResponse({ id: inserted.meta.last_row_id, result },201);
}

// ---------- LINE Messaging API / Webhook ----------
function decodeBase64(value) {
  try {
    return Uint8Array.from(atob(String(value || "")), (character) => character.charCodeAt(0));
  } catch {
    return null;
  }
}

async function verifyLineWebhookSignature(rawBody, signature, channelSecret) {
  const signatureBytes = decodeBase64(signature);
  if (!signatureBytes?.length || !channelSecret) return false;
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(String(channelSecret)),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"]
  );
  return crypto.subtle.verify("HMAC", key, signatureBytes, new TextEncoder().encode(rawBody));
}

function getLineSourceTarget(source) {
  if (!source || typeof source !== "object") return null;
  if (source.type === "group" && source.groupId) return { targetType: "group", targetId: String(source.groupId) };
  if (source.type === "room" && source.roomId) return { targetType: "room", targetId: String(source.roomId) };
  if (source.type === "user" && source.userId) return { targetType: "user", targetId: String(source.userId) };
  return null;
}

async function fetchLineTargetDisplayName(env, targetType, targetId) {
  if (!env.LINE_CHANNEL_ACCESS_TOKEN || targetType === "room") return null;
  const path = targetType === "group"
    ? `/v2/bot/group/${encodeURIComponent(targetId)}/summary`
    : `/v2/bot/profile/${encodeURIComponent(targetId)}`;
  try {
    const response = await fetch(`https://api.line.me${path}`, {
      headers: { Authorization: `Bearer ${env.LINE_CHANNEL_ACCESS_TOKEN}` },
    });
    if (!response.ok) return null;
    const data = await response.json();
    return cleanText(targetType === "group" ? data.groupName : data.displayName, 160);
  } catch {
    return null;
  }
}

async function processLineWebhookEvents(env, events) {
  if (!Array.isArray(events) || events.length === 0) return;
  await ensureLineSchema(env);
  for (const event of events.slice(0, 100)) {
    const source = getLineSourceTarget(event?.source);
    const eventType = cleanText(event?.type, 50) || "unknown";
    const webhookEventId = cleanText(event?.webhookEventId, 160);
    if (source) {
      await env.DB.prepare(`INSERT INTO line_targets
        (target_type,target_id,source_user_id,last_event_type)
        VALUES (?,?,?,?)
        ON CONFLICT(target_id) DO UPDATE SET
          target_type=excluded.target_type,
          source_user_id=COALESCE(excluded.source_user_id,line_targets.source_user_id),
          last_event_type=excluded.last_event_type,
          last_seen_at=datetime('now'),
          updated_at=datetime('now')`)
        .bind(source.targetType, source.targetId, cleanText(event?.source?.userId, 160), eventType).run();

      const target = await env.DB.prepare("SELECT id,display_name FROM line_targets WHERE target_id=?")
        .bind(source.targetId).first();
      if (target && !target.display_name) {
        const displayName = await fetchLineTargetDisplayName(env, source.targetType, source.targetId);
        if (displayName) {
          await env.DB.prepare("UPDATE line_targets SET display_name=?,updated_at=datetime('now') WHERE id=?")
            .bind(displayName, target.id).run();
        }
      }
    }
    if (webhookEventId) {
      await env.DB.prepare(`INSERT OR IGNORE INTO line_webhook_events
        (webhook_event_id,target_id,source_type,event_type) VALUES (?,?,?,?)`)
        .bind(webhookEventId, source?.targetId || null, source?.targetType || null, eventType).run();
    }
  }
}

async function handleLineWebhook(request, env, context) {
  if (!env.LINE_CHANNEL_SECRET) return jsonResponse({ error: "ยังไม่ได้ตั้งค่า LINE_CHANNEL_SECRET" }, 503);
  const contentLength = Number(request.headers.get("content-length") || 0);
  if (contentLength > 1024 * 1024) return jsonResponse({ error: "ข้อมูล Webhook มีขนาดใหญ่เกินกำหนด" }, 413);
  const rawBody = await request.text();
  const signature = request.headers.get("x-line-signature") || "";
  if (!(await verifyLineWebhookSignature(rawBody, signature, env.LINE_CHANNEL_SECRET))) {
    return jsonResponse({ error: "ลายเซ็น Webhook ไม่ถูกต้อง" }, 401);
  }
  let payload;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return jsonResponse({ error: "รูปแบบข้อมูล Webhook ไม่ถูกต้อง" }, 400);
  }
  const events = Array.isArray(payload?.events) ? payload.events : [];
  if (events.length && context?.waitUntil) {
    context.waitUntil(processLineWebhookEvents(env, events).catch((error) => {
      console.error("LINE webhook processing failed", String(error?.message || error).slice(0, 300));
    }));
  } else if (events.length) {
    await processLineWebhookEvents(env, events);
  }
  return jsonResponse({ ok: true });
}

function maskLineTargetId(targetId) {
  const value = String(targetId || "");
  if (value.length <= 10) return value;
  return `${value.slice(0, 5)}••••${value.slice(-5)}`;
}

async function getSelectedLineTarget(env) {
  await ensureLineSchema(env);
  const selected = await env.DB.prepare(`SELECT id,target_type,target_id,display_name
    FROM line_targets WHERE is_default=1 AND status='active' ORDER BY selected_at DESC,id DESC LIMIT 1`).first();
  if (selected) return selected;
  const legacyTarget = cleanText(env.LINE_TARGET_ID, 255);
  const inferredType = legacyTarget?.startsWith("C") ? "group" : legacyTarget?.startsWith("R") ? "room" : "user";
  return legacyTarget ? { id: null, target_type: inferredType, target_id: legacyTarget, display_name: "ปลายทางจาก Environment" } : null;
}

async function fetchLineApiJson(env, path) {
  if (!env.LINE_CHANNEL_ACCESS_TOKEN) return null;
  const response = await fetch(`https://api.line.me${path}`, {
    headers: { Authorization: `Bearer ${env.LINE_CHANNEL_ACCESS_TOKEN}` },
  });
  if (!response.ok) return null;
  return response.json().catch(() => null);
}

async function getLineDeliveryMetrics(env, target) {
  if (!target) return { recipient_count: null, monthly_usage: null, monthly_limit:null, remaining:null };
  let recipientCount = target.target_type === "user" ? 1 : null;
  if (target.target_type === "group" || target.target_type === "room") {
    const scope = target.target_type === "group" ? "group" : "room";
    const memberData = await fetchLineApiJson(env, `/v2/bot/${scope}/${encodeURIComponent(target.target_id)}/members/count`);
    if (Number.isFinite(Number(memberData?.count))) recipientCount = Number(memberData.count);
  }
  const [usageData,quotaData] = await Promise.all([
    fetchLineApiJson(env, "/v2/bot/message/quota/consumption"),
    fetchLineApiJson(env, "/v2/bot/message/quota"),
  ]);
  const monthlyUsage = Number.isFinite(Number(usageData?.totalUsage)) ? Number(usageData.totalUsage) : null;
  const monthlyLimit = quotaData?.type === "limited" && Number.isFinite(Number(quotaData?.value)) ? Number(quotaData.value) : null;
  return {
    recipient_count: recipientCount,
    monthly_usage: monthlyUsage,
    monthly_limit: monthlyLimit,
    remaining: monthlyLimit !== null && monthlyUsage !== null ? Math.max(0,monthlyLimit-monthlyUsage) : null,
  };
}

async function pushLineMessages(env, targetId, messages) {
  if (!env.LINE_CHANNEL_ACCESS_TOKEN) throw new Error("ยังไม่ได้ตั้งค่า LINE_CHANNEL_ACCESS_TOKEN");
  if (!targetId) throw new Error("ยังไม่ได้เลือกกลุ่มรับการแจ้งเตือน");
  const response = await fetch("https://api.line.me/v2/bot/message/push", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.LINE_CHANNEL_ACCESS_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ to: String(targetId), messages }),
  });
  if (!response.ok) throw new Error(`LINE API ${response.status}: ${(await response.text()).slice(0, 300)}`);
}

async function handleLineStatus(request, env) {
  const user = await getCurrentUser(request, env);
  if (user?.role !== "superadmin") return jsonResponse({ error: "เฉพาะผู้ดูแลระบบเท่านั้นที่ตั้งค่า LINE ได้" }, 403);
  await ensureLineSchema(env);
  const { results } = await env.DB.prepare(`SELECT id,target_type,display_name,status,is_default,
      first_seen_at,last_seen_at,last_event_type,target_id
    FROM line_targets ORDER BY is_default DESC,last_seen_at DESC,id DESC`).all();
  const selectedTarget = await getSelectedLineTarget(env);
  return jsonResponse({
    webhook_url: `${new URL(request.url).origin}/api/line/webhook`,
    credentials: {
      channel_secret: !!env.LINE_CHANNEL_SECRET,
      access_token: !!env.LINE_CHANNEL_ACCESS_TOKEN,
    },
    configured: !!(env.LINE_CHANNEL_SECRET && env.LINE_CHANNEL_ACCESS_TOKEN && selectedTarget),
    legacy_target: !!env.LINE_TARGET_ID,
    targets: results.map((target) => ({
      id: target.id,
      target_type: target.target_type,
      display_name: target.display_name,
      masked_id: maskLineTargetId(target.target_id),
      status: target.status,
      is_default: !!target.is_default,
      first_seen_at: target.first_seen_at,
      last_seen_at: target.last_seen_at,
      last_event_type: target.last_event_type,
    })),
  });
}

async function handleUpdateLineTarget(request, env, targetId) {
  const user = await getCurrentUser(request, env);
  if (user?.role !== "superadmin") return jsonResponse({ error: "เฉพาะผู้ดูแลระบบเท่านั้นที่ตั้งค่า LINE ได้" }, 403);
  const body = await request.json().catch(() => null);
  const action = body?.action;
  await ensureLineSchema(env);
  const target = await env.DB.prepare("SELECT id FROM line_targets WHERE id=?").bind(targetId).first();
  if (!target) return jsonResponse({ error: "ไม่พบปลายทาง LINE ที่เลือก" }, 404);
  if (action === "select") {
    await env.DB.batch([
      env.DB.prepare("UPDATE line_targets SET is_default=0,status=CASE WHEN status='active' THEN 'detected' ELSE status END,updated_at=datetime('now') WHERE is_default=1"),
      env.DB.prepare("UPDATE line_targets SET is_default=1,status='active',selected_by=?,selected_at=datetime('now'),updated_at=datetime('now') WHERE id=?").bind(user.id, targetId),
    ]);
  } else if (action === "disable") {
    await env.DB.prepare("UPDATE line_targets SET status='disabled',is_default=0,updated_at=datetime('now') WHERE id=?").bind(targetId).run();
  } else if (action === "enable") {
    await env.DB.prepare("UPDATE line_targets SET status='detected',updated_at=datetime('now') WHERE id=?").bind(targetId).run();
  } else if (action === "rename") {
    const displayName = cleanText(body?.display_name, 160);
    if (!displayName) return jsonResponse({ error: "กรุณาระบุชื่อปลายทาง" }, 400);
    await env.DB.prepare("UPDATE line_targets SET display_name=?,updated_at=datetime('now') WHERE id=?").bind(displayName, targetId).run();
  } else {
    return jsonResponse({ error: "คำสั่งไม่ถูกต้อง" }, 400);
  }
  await writeAuditLog(env, user, "update", "line_target", targetId, { action }, request);
  return jsonResponse({ ok: true });
}

async function handleLineTest(request, env) {
  const user = await getCurrentUser(request, env);
  if (user?.role !== "superadmin") return jsonResponse({ error: "เฉพาะผู้ดูแลระบบเท่านั้นที่ส่งข้อความทดสอบได้" }, 403);
  const target = await getSelectedLineTarget(env);
  if (!target) return jsonResponse({ error: "ยังไม่พบหรือยังไม่ได้เลือกกลุ่ม LINE ปลายทาง" }, 409);
  try {
    await pushLineMessages(env, target.target_id, [{
      type: "text",
      text: "ทดสอบสำเร็จ ✅\nระบบจัดการข้อมูลโรงเรียนบ้านป่าเด็งเชื่อมต่อ LINE พร้อมใช้งานแล้ว",
    }]);
    await writeAuditLog(env, user, "test", "line_notification", target.id, { target_type: target.target_type }, request);
    return jsonResponse({ ok: true });
  } catch (error) {
    return jsonResponse({ error: cleanText(error?.message || error, 500) || "ส่งข้อความทดสอบไม่สำเร็จ" }, 502);
  }
}

// ---------- อาคาร สถานที่ และระบบแจ้งซ่อม ----------
const FACILITY_TYPES = ["building", "classroom", "office", "restroom", "utility", "grounds", "other"];
const FACILITY_STATUSES = ["active", "maintenance", "closed"];
const MAINTENANCE_CATEGORIES = ["electrical", "plumbing", "building", "equipment", "it", "sanitation", "grounds", "other"];
const MAINTENANCE_PRIORITIES = ["low", "normal", "high", "urgent"];
const MAINTENANCE_STATUSES = ["reported", "assigned", "in_progress", "waiting_parts", "completed", "verified", "cancelled"];
const MAINTENANCE_TRANSITIONS = {
  reported: ["assigned", "cancelled"],
  assigned: ["reported", "in_progress", "cancelled"],
  in_progress: ["waiting_parts", "completed", "cancelled"],
  waiting_parts: ["in_progress", "completed", "cancelled"],
  completed: ["in_progress", "verified"],
  verified: [],
  cancelled: ["reported"],
};

function canManageMaintenance(user) {
  return isAdmin(user) || user?.role === "staff";
}

function maintenanceVisibilitySql(user, alias = "m") {
  return canManageMaintenance(user) ? { sql: "1=1", binds: [] }
    : { sql: `(${alias}.reported_by=? OR ${alias}.assigned_to=?)`, binds: [user.id, user.id] };
}

async function getMaintenanceRequest(env, requestId) {
  return env.DB.prepare(`SELECT m.*, f.facility_code, f.name AS facility_name, f.facility_type,
      f.building_name, f.floor, f.location_detail, i.item_code, i.name AS inventory_name,
      reporter.full_name AS reporter_name, assignee.full_name AS assignee_name,
      verifier.full_name AS verifier_name,
      before_file.id AS before_attachment_id, before_file.file_name AS before_attachment_name,
      after_file.id AS after_attachment_id, after_file.file_name AS after_attachment_name
    FROM maintenance_requests m
    LEFT JOIN facilities f ON f.id=m.facility_id
    LEFT JOIN inventory_items i ON i.id=m.inventory_item_id
    LEFT JOIN users reporter ON reporter.id=m.reported_by
    LEFT JOIN users assignee ON assignee.id=m.assigned_to
    LEFT JOIN users verifier ON verifier.id=m.verified_by
    LEFT JOIN file_attachments before_file ON before_file.entity_type='maintenance_before' AND before_file.entity_id=m.id
    LEFT JOIN file_attachments after_file ON after_file.entity_type='maintenance_after' AND after_file.entity_id=m.id
    WHERE m.id=?`).bind(requestId).first();
}

async function nextMaintenanceNumber(env) {
  const yearBe = new Date().getUTCFullYear() + 543;
  const row = await env.DB.prepare(`INSERT INTO maintenance_counters (buddhist_year,last_number) VALUES (?,1)
    ON CONFLICT(buddhist_year) DO UPDATE SET last_number=last_number+1 RETURNING last_number`)
    .bind(yearBe).first();
  return `MR-${yearBe}-${String(Number(row?.last_number || 1)).padStart(4, "0")}`;
}

async function handleListFacilities(request, env) {
  const user = await getCurrentUser(request, env);
  if (!user || !user.role) return jsonResponse({ error: "กรุณาเข้าสู่ระบบ" }, 401);
  const params = new URL(request.url).searchParams;
  const q = cleanText(params.get("q"), 100) || "";
  const type = FACILITY_TYPES.includes(params.get("type")) ? params.get("type") : "";
  const status = FACILITY_STATUSES.includes(params.get("status")) ? params.get("status") : "";
  const { results } = await env.DB.prepare(`SELECT f.*,
      COUNT(m.id) AS request_count,
      SUM(CASE WHEN m.status NOT IN ('verified','cancelled') THEN 1 ELSE 0 END) AS open_request_count
    FROM facilities f LEFT JOIN maintenance_requests m ON m.facility_id=f.id
    WHERE (?='' OR f.facility_code LIKE '%'||?||'%' OR f.name LIKE '%'||?||'%' OR f.building_name LIKE '%'||?||'%')
      AND (?='' OR f.facility_type=?) AND (?='' OR f.status=?)
    GROUP BY f.id ORDER BY CASE f.status WHEN 'active' THEN 1 WHEN 'maintenance' THEN 2 ELSE 3 END, f.name`)
    .bind(q,q,q,q,type,type,status,status).all();
  return jsonResponse({ facilities: results.map((row) => ({
    ...row, request_count: Number(row.request_count || 0), open_request_count: Number(row.open_request_count || 0),
  })), can_manage: canManageMaintenance(user) });
}

async function handleCreateFacility(request, env) {
  const user = await getCurrentUser(request, env);
  if (!user || !user.role) return jsonResponse({ error: "กรุณาเข้าสู่ระบบ" }, 401);
  if (!canManageMaintenance(user)) return jsonResponse({ error: "เฉพาะผู้บริหารหรือเจ้าหน้าที่เท่านั้นที่เพิ่มสถานที่ได้" }, 403);
  const body = await request.json().catch(() => null);
  const code = cleanText(body?.facility_code, 60);
  const name = cleanText(body?.name, 200);
  if (!body || !code || !name || !FACILITY_TYPES.includes(body.facility_type)) {
    return jsonResponse({ error: "กรุณาระบุรหัส ชื่อ และประเภทสถานที่ให้ครบถ้วน" }, 400);
  }
  try {
    const result = await env.DB.prepare(`INSERT INTO facilities
      (facility_code,name,facility_type,building_name,floor,location_detail,responsible_person,status,notes,created_by)
      VALUES (?,?,?,?,?,?,?,?,?,?)`).bind(code,name,body.facility_type,cleanText(body.building_name,160),cleanText(body.floor,40),
        cleanText(body.location_detail,300),cleanText(body.responsible_person,160),
        FACILITY_STATUSES.includes(body.status) ? body.status : "active",cleanText(body.notes,1000),user.id).run();
    await writeAuditLog(env,user,"create","facility",result.meta.last_row_id,{ facility_code: code },request);
    return jsonResponse({ id: result.meta.last_row_id }, 201);
  } catch (error) {
    if (String(error).includes("UNIQUE")) return jsonResponse({ error: "รหัสสถานที่นี้มีอยู่แล้ว" }, 409);
    throw error;
  }
}

async function handleUpdateFacility(request, env, facilityId) {
  const user = await getCurrentUser(request, env);
  if (!user || !user.role) return jsonResponse({ error: "กรุณาเข้าสู่ระบบ" }, 401);
  if (!canManageMaintenance(user)) return jsonResponse({ error: "ไม่มีสิทธิ์แก้ไขสถานที่" }, 403);
  const existing = await env.DB.prepare("SELECT id FROM facilities WHERE id=?").bind(facilityId).first();
  if (!existing) return jsonResponse({ error: "ไม่พบสถานที่" }, 404);
  const body = await request.json().catch(() => null);
  if (!body) return jsonResponse({ error: "รูปแบบข้อมูลไม่ถูกต้อง" }, 400);
  const fields = {
    facility_code: [60, null], name: [200, null], building_name: [160, null], floor: [40, null],
    location_detail: [300, null], responsible_person: [160, null], notes: [1000, null],
  };
  const updates = [], values = [];
  for (const [field, [max]] of Object.entries(fields)) if (body[field] !== undefined) {
    const value = cleanText(body[field], max);
    if (["facility_code", "name"].includes(field) && !value) return jsonResponse({ error: "รหัสและชื่อสถานที่ห้ามว่าง" },400);
    updates.push(`${field}=?`); values.push(value);
  }
  if (body.facility_type !== undefined) {
    if (!FACILITY_TYPES.includes(body.facility_type)) return jsonResponse({ error: "ประเภทสถานที่ไม่ถูกต้อง" },400);
    updates.push("facility_type=?"); values.push(body.facility_type);
  }
  if (body.status !== undefined) {
    if (!FACILITY_STATUSES.includes(body.status)) return jsonResponse({ error: "สถานะสถานที่ไม่ถูกต้อง" },400);
    updates.push("status=?"); values.push(body.status);
  }
  if (!updates.length) return jsonResponse({ error: "ไม่มีข้อมูลที่จะอัปเดต" },400);
  updates.push("updated_at=datetime('now')"); values.push(facilityId);
  try {
    await env.DB.prepare(`UPDATE facilities SET ${updates.join(",")} WHERE id=?`).bind(...values).run();
  } catch (error) {
    if (String(error).includes("UNIQUE")) return jsonResponse({ error: "รหัสสถานที่นี้มีอยู่แล้ว" },409);
    throw error;
  }
  await writeAuditLog(env,user,"update","facility",facilityId,{ fields: Object.keys(body) },request);
  return jsonResponse({ ok: true });
}

async function handleMaintenanceSummary(request, env) {
  const user = await getCurrentUser(request, env);
  if (!user || !user.role) return jsonResponse({ error: "กรุณาเข้าสู่ระบบ" },401);
  const visibility = maintenanceVisibilitySql(user);
  const row = await env.DB.prepare(`SELECT COUNT(*) AS total_count,
      SUM(CASE WHEN status NOT IN ('verified','cancelled') THEN 1 ELSE 0 END) AS open_count,
      SUM(CASE WHEN status='in_progress' THEN 1 ELSE 0 END) AS in_progress_count,
      SUM(CASE WHEN status='waiting_parts' THEN 1 ELSE 0 END) AS waiting_parts_count,
      SUM(CASE WHEN status='completed' THEN 1 ELSE 0 END) AS awaiting_verification_count,
      SUM(CASE WHEN status NOT IN ('verified','cancelled') AND due_date IS NOT NULL AND due_date < date('now') THEN 1 ELSE 0 END) AS overdue_count,
      SUM(CASE WHEN priority='urgent' AND status NOT IN ('verified','cancelled') THEN 1 ELSE 0 END) AS urgent_count,
      COALESCE(SUM(CASE WHEN strftime('%Y-%m',completed_at)=strftime('%Y-%m','now') THEN actual_cost ELSE 0 END),0) AS month_cost
    FROM maintenance_requests m WHERE ${visibility.sql}`).bind(...visibility.binds).first();
  const lineTarget = env.LINE_CHANNEL_ACCESS_TOKEN ? await getSelectedLineTarget(env) : null;
  const lineMetrics = lineTarget ? await getLineDeliveryMetrics(env,lineTarget) : { recipient_count:null,monthly_usage:null,monthly_limit:null,remaining:null };
  return jsonResponse({
    total_count:Number(row?.total_count||0), open_count:Number(row?.open_count||0), in_progress_count:Number(row?.in_progress_count||0),
    waiting_parts_count:Number(row?.waiting_parts_count||0), awaiting_verification_count:Number(row?.awaiting_verification_count||0),
    overdue_count:Number(row?.overdue_count||0), urgent_count:Number(row?.urgent_count||0), month_cost:Number(row?.month_cost||0),
    can_manage:canManageMaintenance(user), line_configured:!!(env.LINE_CHANNEL_ACCESS_TOKEN && lineTarget),
    line_recipient_count:lineMetrics.recipient_count, line_monthly_usage:lineMetrics.monthly_usage,
    line_monthly_limit:lineMetrics.monthly_limit, line_remaining:lineMetrics.remaining,
  });
}

async function handleListMaintenanceRequests(request, env) {
  const user = await getCurrentUser(request, env);
  if (!user || !user.role) return jsonResponse({ error: "กรุณาเข้าสู่ระบบ" },401);
  const params = new URL(request.url).searchParams;
  const q = cleanText(params.get("q"),100) || "";
  const status = MAINTENANCE_STATUSES.includes(params.get("status")) ? params.get("status") : "";
  const priority = MAINTENANCE_PRIORITIES.includes(params.get("priority")) ? params.get("priority") : "";
  const category = MAINTENANCE_CATEGORIES.includes(params.get("category")) ? params.get("category") : "";
  const facilityId = Number(params.get("facility_id") || 0);
  const visibility = maintenanceVisibilitySql(user);
  const { results } = await env.DB.prepare(`SELECT m.*,f.facility_code,f.name AS facility_name,f.building_name,f.floor,
      i.item_code,i.name AS inventory_name,reporter.full_name AS reporter_name,assignee.full_name AS assignee_name,
      before_file.id AS before_attachment_id,after_file.id AS after_attachment_id,
      (SELECT delivery_status FROM maintenance_notifications n WHERE n.request_id=m.id ORDER BY n.id DESC LIMIT 1) AS notification_status
    FROM maintenance_requests m
    LEFT JOIN facilities f ON f.id=m.facility_id LEFT JOIN inventory_items i ON i.id=m.inventory_item_id
    LEFT JOIN users reporter ON reporter.id=m.reported_by LEFT JOIN users assignee ON assignee.id=m.assigned_to
    LEFT JOIN file_attachments before_file ON before_file.entity_type='maintenance_before' AND before_file.entity_id=m.id
    LEFT JOIN file_attachments after_file ON after_file.entity_type='maintenance_after' AND after_file.entity_id=m.id
    WHERE ${visibility.sql}
      AND (?='' OR m.request_no LIKE '%'||?||'%' OR m.title LIKE '%'||?||'%' OR m.description LIKE '%'||?||'%' OR f.name LIKE '%'||?||'%' OR m.custom_location LIKE '%'||?||'%')
      AND (?='' OR m.status=?) AND (?='' OR m.priority=?) AND (?='' OR m.category=?) AND (?=0 OR m.facility_id=?)
    ORDER BY CASE m.priority WHEN 'urgent' THEN 1 WHEN 'high' THEN 2 WHEN 'normal' THEN 3 ELSE 4 END,
      CASE WHEN m.status IN ('verified','cancelled') THEN 2 ELSE 1 END,m.created_at DESC`)
    .bind(...visibility.binds,q,q,q,q,q,q,status,status,priority,priority,category,category,facilityId,facilityId).all();
  return jsonResponse({ requests: results.map((row)=>({
    ...row,estimated_cost:Number(row.estimated_cost||0),actual_cost:Number(row.actual_cost||0),
    before_url:row.before_attachment_id ? `/api/attachments/${row.before_attachment_id}` : null,
    after_url:row.after_attachment_id ? `/api/attachments/${row.after_attachment_id}` : null,
  })), can_manage:canManageMaintenance(user), current_user_id:user.id });
}

async function handleGetMaintenanceRequest(request, env, requestId) {
  const user = await getCurrentUser(request, env);
  if (!user || !user.role) return jsonResponse({ error: "กรุณาเข้าสู่ระบบ" },401);
  const item = await getMaintenanceRequest(env,requestId);
  if (!item) return jsonResponse({ error: "ไม่พบใบแจ้งซ่อม" },404);
  if (!canManageMaintenance(user) && item.reported_by !== user.id && item.assigned_to !== user.id) return jsonResponse({ error: "ไม่มีสิทธิ์ดูใบแจ้งซ่อมนี้" },403);
  const { results: updates } = await env.DB.prepare(`SELECT x.*,u.full_name AS creator_name,a.id AS attachment_id,a.file_name AS attachment_name
    FROM maintenance_updates x LEFT JOIN users u ON u.id=x.created_by
    LEFT JOIN file_attachments a ON a.entity_type='maintenance_update' AND a.entity_id=x.id
    WHERE x.request_id=? ORDER BY x.created_at,x.id`).bind(requestId).all();
  const { results: notifications } = await env.DB.prepare(`SELECT * FROM maintenance_notifications WHERE request_id=? ORDER BY id DESC LIMIT 20`).bind(requestId).all();
  return jsonResponse({
    request:{...item,estimated_cost:Number(item.estimated_cost||0),actual_cost:Number(item.actual_cost||0),
      before_url:item.before_attachment_id?`/api/attachments/${item.before_attachment_id}`:null,
      after_url:item.after_attachment_id?`/api/attachments/${item.after_attachment_id}`:null},
    updates:updates.map((row)=>({...row,cost_amount:Number(row.cost_amount||0)})), notifications,
    permissions:{ can_manage:canManageMaintenance(user), can_operate:canManageMaintenance(user)||item.assigned_to===user.id,
      can_verify:canManageMaintenance(user)||item.reported_by===user.id, can_upload:item.reported_by===user.id||item.assigned_to===user.id||canManageMaintenance(user) },
  });
}

async function handleCreateMaintenanceRequest(request, env) {
  const user = await getCurrentUser(request, env);
  if (!user || !user.role) return jsonResponse({ error: "กรุณาเข้าสู่ระบบ" },401);
  const body = await request.json().catch(()=>null);
  const title = cleanText(body?.title,200), description = cleanText(body?.description,2000);
  if (!body || !title || !description || !MAINTENANCE_CATEGORIES.includes(body.category)) return jsonResponse({ error: "กรุณาระบุเรื่อง รายละเอียด และหมวดงานซ่อมให้ครบถ้วน" },400);
  const facilityId = Number(body.facility_id||0) || null;
  const inventoryItemId = Number(body.inventory_item_id||0) || null;
  const customLocation = cleanText(body.custom_location, 300);
  if (!facilityId && !inventoryItemId && !customLocation) return jsonResponse({ error: "กรุณาเลือกสถานที่หรือระบุจุดที่เสียหาย" },400);
  if (facilityId && !(await env.DB.prepare("SELECT id FROM facilities WHERE id=? AND status<>'closed'").bind(facilityId).first())) return jsonResponse({ error: "ไม่พบสถานที่หรือสถานที่ปิดใช้งานแล้ว" },400);
  if (inventoryItemId && !(await env.DB.prepare("SELECT id FROM inventory_items WHERE id=?").bind(inventoryItemId).first())) return jsonResponse({ error: "ไม่พบครุภัณฑ์ที่เลือก" },400);
  const requestNo = await nextMaintenanceNumber(env);
  const result = await env.DB.prepare(`INSERT INTO maintenance_requests
    (request_no,facility_id,inventory_item_id,custom_location,title,description,category,priority,reported_by)
    VALUES (?,?,?,?,?,?,?,?,?)`).bind(requestNo,facilityId,inventoryItemId,customLocation,title,description,body.category,
      MAINTENANCE_PRIORITIES.includes(body.priority)?body.priority:"normal",user.id).run();
  const requestId = result.meta.last_row_id;
  await env.DB.prepare(`INSERT INTO maintenance_updates(request_id,previous_status,new_status,comment,created_by)
    VALUES (?,NULL,'reported',?,?)`).bind(requestId,"สร้างใบแจ้งซ่อม",user.id).run();
  await writeAuditLog(env,user,"create","maintenance_request",requestId,{ request_no:requestNo,facility_id:facilityId,inventory_item_id:inventoryItemId,custom_location:customLocation },request);
  if (!body.defer_notification) await sendMaintenanceLineNotification(request,env,requestId,"reported").catch(()=>{});
  return jsonResponse({ id:requestId,request_no:requestNo },201);
}

async function handleUpdateMaintenanceRequest(request, env, requestId) {
  const user = await getCurrentUser(request, env);
  if (!user || !user.role) return jsonResponse({ error: "กรุณาเข้าสู่ระบบ" },401);
  const item = await getMaintenanceRequest(env,requestId);
  if (!item) return jsonResponse({ error: "ไม่พบใบแจ้งซ่อม" },404);
  const body = await request.json().catch(()=>null);
  if (!body) return jsonResponse({ error: "รูปแบบข้อมูลไม่ถูกต้อง" },400);
  const manager = canManageMaintenance(user), assigned = item.assigned_to===user.id, reporter = item.reported_by===user.id;
  const nextStatus = body.status === undefined ? item.status : body.status;
  if (!MAINTENANCE_STATUSES.includes(nextStatus)) return jsonResponse({ error: "สถานะไม่ถูกต้อง" },400);
  const statusChanged = nextStatus !== item.status;
  if (statusChanged && !MAINTENANCE_TRANSITIONS[item.status]?.includes(nextStatus)) return jsonResponse({ error: `ไม่สามารถเปลี่ยนจาก ${item.status} เป็น ${nextStatus} ได้` },409);
  if (statusChanged) {
    if (["assigned","cancelled","reported"].includes(nextStatus) && !manager) return jsonResponse({ error: "เฉพาะผู้บริหารหรือเจ้าหน้าที่เท่านั้นที่เปลี่ยนสถานะนี้ได้" },403);
    if (["in_progress","waiting_parts","completed"].includes(nextStatus) && !manager && !assigned) return jsonResponse({ error: "เฉพาะผู้รับผิดชอบหรือเจ้าหน้าที่เท่านั้นที่อัปเดตงานซ่อมได้" },403);
    if (nextStatus === "verified" && !manager && !reporter) return jsonResponse({ error: "เฉพาะผู้แจ้งหรือเจ้าหน้าที่เท่านั้นที่ตรวจรับงานได้" },403);
  }
  if (!statusChanged && !manager && !assigned) return jsonResponse({ error: "ไม่มีสิทธิ์แก้ไขใบแจ้งซ่อมนี้" },403);
  let assignedTo = item.assigned_to;
  if (body.assigned_to !== undefined) {
    if (!manager) return jsonResponse({ error: "เฉพาะผู้บริหารหรือเจ้าหน้าที่เท่านั้นที่มอบหมายงานได้" },403);
    assignedTo = Number(body.assigned_to||0)||null;
    if (assignedTo && !(await env.DB.prepare("SELECT id FROM users WHERE id=? AND status='active' AND role IS NOT NULL").bind(assignedTo).first())) return jsonResponse({ error: "ไม่พบผู้รับผิดชอบที่เลือก" },400);
  }
  const estimatedCost = body.estimated_cost===undefined ? Number(item.estimated_cost||0) : Number(body.estimated_cost);
  const actualCost = body.actual_cost===undefined ? Number(item.actual_cost||0) : Number(body.actual_cost);
  if (![estimatedCost,actualCost].every(Number.isFinite) || estimatedCost<0 || actualCost<0) return jsonResponse({ error: "ค่าใช้จ่ายต้องเป็นตัวเลขตั้งแต่ 0 ขึ้นไป" },400);
  if ((body.estimated_cost!==undefined || body.due_date!==undefined || body.assigned_to!==undefined) && !manager) return jsonResponse({ error: "ไม่มีสิทธิ์แก้ไขการมอบหมายและประมาณการ" },403);
  if (body.due_date && !isIsoDate(body.due_date)) return jsonResponse({ error: "กำหนดเสร็จไม่ถูกต้อง" },400);
  if (nextStatus === "assigned" && !assignedTo) return jsonResponse({ error: "กรุณาเลือกผู้รับผิดชอบก่อนมอบหมายงาน" },400);
  const resolution = body.resolution===undefined ? item.resolution : cleanText(body.resolution,2000);
  if (nextStatus === "completed" && !resolution) return jsonResponse({ error: "กรุณาระบุวิธีแก้ไขก่อนปิดงานซ่อม" },400);
  const comment = cleanText(body.comment,1500);
  if (statusChanged && !comment && ["cancelled","waiting_parts"].includes(nextStatus)) return jsonResponse({ error: "กรุณาระบุเหตุผลประกอบการเปลี่ยนสถานะ" },400);
  await env.DB.prepare(`UPDATE maintenance_requests SET assigned_to=?,due_date=?,estimated_cost=?,actual_cost=?,resolution=?,status=?,
      started_at=CASE WHEN ?='in_progress' AND started_at IS NULL THEN datetime('now') ELSE started_at END,
      completed_at=CASE WHEN ?='completed' THEN datetime('now') WHEN ?='in_progress' THEN NULL ELSE completed_at END,
      verified_by=CASE WHEN ?='verified' THEN ? WHEN ?='in_progress' THEN NULL ELSE verified_by END,
      verified_at=CASE WHEN ?='verified' THEN datetime('now') WHEN ?='in_progress' THEN NULL ELSE verified_at END,
      updated_at=datetime('now') WHERE id=?`).bind(assignedTo,body.due_date===undefined?item.due_date:(body.due_date||null),estimatedCost,actualCost,resolution,nextStatus,
        nextStatus,nextStatus,nextStatus,nextStatus,user.id,nextStatus,nextStatus,nextStatus,requestId).run();
  if (statusChanged || comment || actualCost!==Number(item.actual_cost||0) || assignedTo!==item.assigned_to) {
    await env.DB.prepare(`INSERT INTO maintenance_updates(request_id,previous_status,new_status,comment,cost_amount,created_by)
      VALUES (?,?,?,?,?,?)`).bind(requestId,item.status,nextStatus,comment || (assignedTo!==item.assigned_to?"มอบหมายผู้รับผิดชอบ":"อัปเดตใบแจ้งซ่อม"),actualCost,user.id).run();
  }
  await writeAuditLog(env,user,"update","maintenance_request",requestId,{ previous_status:item.status,new_status:nextStatus,assigned_to:assignedTo,actual_cost:actualCost },request);
  const notificationEvent = assignedTo!==item.assigned_to ? "assigned" : statusChanged ? nextStatus : null;
  const automaticEvents = new Set(["reported","assigned","completed"]);
  const shouldNotify = notificationEvent && (automaticEvents.has(notificationEvent) || body.notify_line === true);
  const lineNotification = shouldNotify
    ? await sendMaintenanceLineNotification(request,env,requestId,notificationEvent).catch((error)=>({delivery_status:"failed",error:cleanText(error?.message||error,500)}))
    : notificationEvent ? { delivery_status:"not_requested" } : null;
  return jsonResponse({ ok:true, line_notification:lineNotification });
}

function bytesToHex(bytes) {
  return [...new Uint8Array(bytes)].map((byte)=>byte.toString(16).padStart(2,"0")).join("");
}

async function maintenanceImageSignature(env, attachmentId, expires) {
  const key = await crypto.subtle.importKey("raw",new TextEncoder().encode(String(env.JWT_SECRET||"")),{name:"HMAC",hash:"SHA-256"},false,["sign"]);
  return bytesToHex(await crypto.subtle.sign("HMAC",key,new TextEncoder().encode(`${attachmentId}:${expires}`)));
}

async function sendMaintenanceLineNotification(request, env, requestId, eventType) {
  let deliveryStatus = "not_configured", errorMessage = null;
  const recentDuplicate = await env.DB.prepare(`SELECT id FROM maintenance_notifications
    WHERE request_id=? AND event_type=? AND delivery_status='sent'
      AND datetime(created_at)>=datetime('now','-10 minutes')
    ORDER BY id DESC LIMIT 1`).bind(requestId,eventType).first();
  if (recentDuplicate) {
    deliveryStatus="skipped_duplicate";
    errorMessage="ป้องกันการส่งเหตุการณ์เดิมซ้ำภายใน 10 นาที";
    await env.DB.prepare(`INSERT INTO maintenance_notifications(request_id,event_type,delivery_status,error_message) VALUES (?,?,?,?)`)
      .bind(requestId,eventType,deliveryStatus,errorMessage).run();
    return { delivery_status:deliveryStatus,error:errorMessage };
  }
  const lineTarget = env.LINE_CHANNEL_ACCESS_TOKEN ? await getSelectedLineTarget(env) : null;
  if (env.LINE_CHANNEL_ACCESS_TOKEN && lineTarget) {
    try {
      const lineMetrics = await getLineDeliveryMetrics(env,lineTarget);
      if (lineMetrics.remaining !== null && lineMetrics.remaining <= 0) {
        deliveryStatus="quota_exhausted";
        errorMessage="โควตา LINE ประจำเดือนหมดแล้ว";
      } else if (lineMetrics.remaining !== null && lineMetrics.recipient_count !== null && lineMetrics.recipient_count > lineMetrics.remaining) {
        deliveryStatus="quota_exhausted";
        errorMessage=`โควตา LINE คงเหลือ ${lineMetrics.remaining} ข้อความ ไม่พอสำหรับผู้รับประมาณ ${lineMetrics.recipient_count} คน`;
      }
      if (deliveryStatus === "quota_exhausted") {
        await env.DB.prepare(`INSERT INTO maintenance_notifications(request_id,event_type,delivery_status,error_message) VALUES (?,?,?,?)`)
          .bind(requestId,eventType,deliveryStatus,errorMessage).run();
        return { delivery_status:deliveryStatus,error:errorMessage };
      }
      const item = await getMaintenanceRequest(env,requestId);
      if (!item) throw new Error("ไม่พบใบแจ้งซ่อม");
      const origin = new URL(request.url).origin;
      const eventLabels = {reported:"แจ้งซ่อมใหม่",assigned:"มอบหมายงาน",in_progress:"เริ่มดำเนินการ",waiting_parts:"รออะไหล่",completed:"ซ่อมเสร็จ รอตรวจรับ",verified:"ตรวจรับแล้ว",cancelled:"ยกเลิก"};
      const priorityLabels = {low:"ต่ำ",normal:"ปกติ",high:"สูง",urgent:"เร่งด่วน"};
      const registeredLocation = [item.facility_name,item.building_name,item.floor?`ชั้น ${item.floor}`:null].filter(Boolean).join(" · ");
      const location = [registeredLocation,item.custom_location].filter(Boolean).join(" · ") || item.inventory_name || "ไม่ระบุจุด";
      const contents = {
        type:"bubble", body:{type:"box",layout:"vertical",spacing:"md",contents:[
          {type:"text",text:eventLabels[eventType]||"อัปเดตงานซ่อม",weight:"bold",size:"sm",color:"#2563EB"},
          {type:"text",text:item.title,weight:"bold",size:"xl",wrap:true,color:"#102A43"},
          {type:"text",text:`${item.request_no} · ความสำคัญ ${priorityLabels[item.priority]||item.priority}`,size:"sm",color:item.priority==="urgent"?"#DC2626":"#52667A",wrap:true},
          {type:"separator",margin:"md"},
          {type:"text",text:`สถานที่: ${location}`,size:"sm",color:"#334E68",wrap:true},
          {type:"text",text:`ผู้แจ้ง: ${item.reporter_name||"-"}`,size:"sm",color:"#334E68",wrap:true},
          {type:"text",text:item.assignee_name?`ผู้รับผิดชอบ: ${item.assignee_name}`:"ยังไม่ได้มอบหมาย",size:"sm",color:"#334E68",wrap:true},
        ]}, footer:{type:"box",layout:"vertical",contents:[{type:"button",style:"primary",color:"#2563EB",action:{type:"uri",label:"เปิดใบแจ้งซ่อม",uri:`${origin}/maintenance.html?request=${requestId}`}}]},
      };
      const previewId = eventType === "completed" || eventType === "verified" ? item.after_attachment_id : item.before_attachment_id;
      if (previewId && env.JWT_SECRET) {
        const expires = Math.floor(Date.now()/1000)+(7*24*60*60);
        const sig = await maintenanceImageSignature(env,previewId,expires);
        contents.hero={type:"image",url:`${origin}/api/public/maintenance-image/${previewId}?expires=${expires}&sig=${sig}`,size:"full",aspectRatio:"20:13",aspectMode:"cover"};
      }
      await pushLineMessages(env, lineTarget.target_id, [{type:"flex",altText:`${eventLabels[eventType]||"อัปเดตงานซ่อม"}: ${item.title}`,contents}]);
      deliveryStatus="sent";
    } catch (error) {
      deliveryStatus="failed"; errorMessage=cleanText(error?.message||error,500);
    }
  }
  await env.DB.prepare(`INSERT INTO maintenance_notifications(request_id,event_type,delivery_status,error_message) VALUES (?,?,?,?)`)
    .bind(requestId,eventType,deliveryStatus,errorMessage).run();
  return { delivery_status:deliveryStatus,error:errorMessage };
}

async function handleNotifyMaintenanceRequest(request, env, requestId) {
  const user = await getCurrentUser(request,env);
  if (!user || !user.role) return jsonResponse({ error:"กรุณาเข้าสู่ระบบ" },401);
  const item = await getMaintenanceRequest(env,requestId);
  if (!item) return jsonResponse({ error:"ไม่พบใบแจ้งซ่อม" },404);
  if (!canManageMaintenance(user) && item.reported_by!==user.id && item.assigned_to!==user.id) return jsonResponse({ error:"ไม่มีสิทธิ์ส่งการแจ้งเตือน" },403);
  const result = await sendMaintenanceLineNotification(request,env,requestId,item.status);
  return jsonResponse(result,result.delivery_status==="failed"?502:200);
}

// PDF ไม่เกิน 1 MiB, รูปภาพไม่เกิน 2 MiB; ตรวจทั้ง MIME และลายเซ็นไฟล์จริง
const MANAGED_FILE_LIMITS = {
  "application/pdf": 1024 * 1024,
  "image/jpeg": 2 * 1024 * 1024,
  "image/png": 2 * 1024 * 1024,
  "image/webp": 2 * 1024 * 1024,
  "image/gif": 2 * 1024 * 1024,
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": 25 * 1024 * 1024,
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": 25 * 1024 * 1024,
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": 25 * 1024 * 1024,
};

const OFFICE_FILE_MIMES = {
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
};

async function validateManagedFile(file, entityType = "") {
  if (!file || typeof file.arrayBuffer !== "function") return { error: "กรุณาเลือกไฟล์" };
  const fileName = String(file.name || "").toLowerCase();
  const extension = Object.keys(OFFICE_FILE_MIMES).find((ext) => fileName.endsWith(ext));
  const declaredMime = String(file.type || "").toLowerCase();
  const mimeType = OFFICE_FILE_MIMES[extension] || declaredMime;
  const officeAllowed = ["document", "work_record", "inventory_transaction", "inventory_inspection", "project_expense"].includes(entityType);
  if (extension && !officeAllowed) return { error: "หัวข้อนี้ไม่รองรับไฟล์เอกสาร Office" };
  const limit = MANAGED_FILE_LIMITS[mimeType];
  if (!limit) return { error: "รองรับ PDF, JPG, PNG, WEBP, GIF และไฟล์ DOCX/XLSX/PPTX ในหัวข้องานเอกสาร" };
  if (file.size <= 0) return { error: "ไฟล์ว่างหรือไม่สมบูรณ์" };
  if (file.size > limit) {
    const label = mimeType === "application/pdf" ? "PDF ต้องไม่เกิน 1 MB"
      : mimeType.startsWith("image/") ? "รูปภาพต้องไม่เกิน 2 MB" : "ไฟล์เอกสารต้องไม่เกิน 25 MB";
    return { error: `${label} กรุณาสแกนที่ 150 DPI ใช้ขาวดำ/Grayscale หรือบีบอัดไฟล์ก่อนอัปโหลด` };
  }
  const bytes = new Uint8Array(await file.slice(0, 16).arrayBuffer());
  const ascii = String.fromCharCode(...bytes);
  const valid = mimeType === "application/pdf" ? ascii.startsWith("%PDF-")
    : mimeType === "image/jpeg" ? bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff
    : mimeType === "image/png" ? bytes.slice(0,8).every((value,index)=>value===[0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a][index])
    : mimeType === "image/webp" ? ascii.startsWith("RIFF") && ascii.slice(8,12) === "WEBP"
    : mimeType === "image/gif" ? ascii.startsWith("GIF87a") || ascii.startsWith("GIF89a")
    : bytes[0] === 0x50 && bytes[1] === 0x4b;
  if (!valid) return { error: "ชนิดไฟล์ไม่ตรงกับเนื้อหาไฟล์ กรุณาเลือกไฟล์ต้นฉบับที่ถูกต้อง" };
  return { mimeType, limit };
}

// เลือก Drive เมื่อผู้ดูแลตั้งค่าครบแล้ว; รองรับ R2 เดิมเพื่อไม่ให้ไฟล์เก่าหยุดทำงาน
function getFileStorageProvider(env) {
  const explicit = String(env.FILE_STORAGE_PROVIDER || "").trim().toLowerCase();
  if (explicit === "drive" || explicit === "r2") return explicit;
  if (env.GOOGLE_DRIVE_FOLDER_ID && env.GOOGLE_DRIVE_REFRESH_TOKEN) return "drive";
  return "r2";
}

function requireDriveConfig(env) {
  const missing = [
    ["GOOGLE_DRIVE_CLIENT_ID", env.GOOGLE_DRIVE_CLIENT_ID],
    ["GOOGLE_DRIVE_CLIENT_SECRET", env.GOOGLE_DRIVE_CLIENT_SECRET],
    ["GOOGLE_DRIVE_REFRESH_TOKEN", env.GOOGLE_DRIVE_REFRESH_TOKEN],
    ["GOOGLE_DRIVE_FOLDER_ID", env.GOOGLE_DRIVE_FOLDER_ID],
  ].filter(([, value]) => !String(value || "").trim()).map(([name]) => name);
  return missing.length ? `ยังไม่ได้ตั้งค่า Google Drive: ${missing.join(", ")}` : null;
}

async function getGoogleDriveAccessToken(env) {
  const configError = requireDriveConfig(env);
  if (configError) throw new Error(configError);
  const body = new URLSearchParams({
    client_id: String(env.GOOGLE_DRIVE_CLIENT_ID),
    client_secret: String(env.GOOGLE_DRIVE_CLIENT_SECRET),
    refresh_token: String(env.GOOGLE_DRIVE_REFRESH_TOKEN),
    grant_type: "refresh_token",
  });
  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.access_token) {
    throw new Error(`เชื่อมต่อ Google Drive ไม่สำเร็จ (${response.status})`);
  }
  return data.access_token;
}

async function googleDriveRequest(accessToken, path, options = {}) {
  const headers = new Headers(options.headers || {});
  headers.set("Authorization", `Bearer ${accessToken}`);
  const url = path.startsWith("http") ? path
    : path.startsWith("/upload/") ? `https://www.googleapis.com${path}`
      : `https://www.googleapis.com/drive/v3${path}`;
  const response = await fetch(url, { ...options, headers });
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(`Google Drive API ตอบกลับ ${response.status}${detail ? `: ${detail.slice(0, 300)}` : ""}`);
  }
  return response;
}

function escapeDriveQuery(value) {
  return String(value).replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

async function findOrCreateDriveFolder(accessToken, parentId, name) {
  const query = encodeURIComponent(`'${escapeDriveQuery(parentId)}' in parents and name = '${escapeDriveQuery(name)}' and mimeType = 'application/vnd.google-apps.folder' and trashed = false`);
  const existing = await googleDriveRequest(accessToken, `/files?q=${query}&pageSize=1&fields=files(id,name)`).then((res) => res.json());
  if (existing.files?.[0]?.id) return existing.files[0].id;
  const created = await googleDriveRequest(accessToken, "/files?fields=id,name", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, mimeType: "application/vnd.google-apps.folder", parents: [parentId] }),
  }).then((res) => res.json());
  return created.id;
}

function departmentDriveLabel(department) {
  return {
    academic: "ฝ่ายวิชาการ",
    budget: "ฝ่ายงบประมาณ",
    personnel: "ฝ่ายบุคคล",
    general: "ฝ่ายบริหารทั่วไป",
    "student-support": "ระบบดูแลช่วยเหลือนักเรียน",
    admin: "ผู้ดูแลระบบ",
  }[department] || "ไม่ระบุฝ่าย";
}

async function getDriveFolderSegments(env, entityType, entityId) {
  if (entityType === "document") {
    const row = await env.DB.prepare(`SELECT d.department, y.year_be
      FROM documents d LEFT JOIN academic_years y ON y.id = d.academic_year_id WHERE d.id = ?`).bind(entityId).first();
    return ["เอกสารและคลังไฟล์", String(row?.year_be || "ไม่ระบุปีการศึกษา"), departmentDriveLabel(row?.department)];
  }
  if (entityType.startsWith("inventory_")) return ["พัสดุและครุภัณฑ์", entityType === "inventory_transaction" ? "รายการเคลื่อนไหว" : "การตรวจสอบ"];
  if (entityType === "project_expense") {
    const row = await env.DB.prepare(`SELECT e.fiscal_year,p.name FROM project_expenses e JOIN projects p ON p.id=e.project_id WHERE e.id=?`).bind(entityId).first();
    return ["งบประมาณ", String(row?.fiscal_year || "ไม่ระบุปีงบประมาณ"), row?.name || "ไม่ระบุโครงการ"];
  }
  if (entityType.startsWith("maintenance_")) return ["อาคารสถานที่และแจ้งซ่อม", entityType.replace("maintenance_", "")];
  if (entityType === "work_record") {
    const row = await env.DB.prepare("SELECT area,topic_label FROM work_records WHERE id=?").bind(entityId).first();
    return ["ศูนย์ปฏิบัติงาน", departmentDriveLabel(row?.area), row?.topic_label || "ไม่ระบุหัวข้องาน"];
  }
  return ["ไฟล์แนบ", entityType];
}

async function resolveDriveFolder(env, accessToken, entityType, entityId) {
  let parentId = String(env.GOOGLE_DRIVE_FOLDER_ID);
  for (const segment of await getDriveFolderSegments(env, entityType, entityId)) {
    parentId = await findOrCreateDriveFolder(accessToken, parentId, segment);
  }
  return parentId;
}

async function uploadToGoogleDrive(env, file, entityType, entityId, safeName, mimeType) {
  const accessToken = await getGoogleDriveAccessToken(env);
  const parentId = await resolveDriveFolder(env, accessToken, entityType, entityId);
  const boundary = `school_${crypto.randomUUID()}`;
  const metadata = JSON.stringify({ name: safeName, mimeType, parents: [parentId] });
  const content = new Uint8Array(await file.arrayBuffer());
  const multipart = new Blob([
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${metadata}\r\n`,
    `--${boundary}\r\nContent-Type: ${mimeType}\r\n\r\n`,
    content,
    `\r\n--${boundary}--`,
  ]);
  return googleDriveRequest(accessToken, `/upload/drive/v3/files?uploadType=multipart&fields=id,name,mimeType,size,webViewLink`, {
    method: "POST",
    headers: { "Content-Type": `multipart/related; boundary=${boundary}` },
    body: multipart,
  }).then(async (response) => response.json());
}

async function deleteGoogleDriveFile(env, fileId) {
  if (!fileId || requireDriveConfig(env)) return;
  const accessToken = await getGoogleDriveAccessToken(env);
  await googleDriveRequest(accessToken, `/files/${encodeURIComponent(fileId)}`, { method: "DELETE" });
}

async function hashManagedFile(file) {
  const digest = await crypto.subtle.digest("SHA-256", await file.arrayBuffer());
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function recordDocumentUploadFailure(env, user, documentId, message, request) {
  const safeMessage = cleanText(message || "จัดเก็บไฟล์ไม่สำเร็จ", 500) || "จัดเก็บไฟล์ไม่สำเร็จ";
  await env.DB.prepare(`UPDATE documents SET upload_status='failed', upload_error=?, updated_at=datetime('now') WHERE id=?`)
    .bind(safeMessage, documentId).run();
  await writeAuditLog(env, user, "upload_failed", "document", documentId, { error: safeMessage }, request).catch(() => {});
}

const ATTACHMENT_ENTITY_TABLES = {
  document: { table: "documents", owner: "uploaded_by" },
  inventory_transaction: { table: "inventory_transactions", owner: "created_by" },
  inventory_inspection: { table: "inventory_inspections", owner: "created_by" },
  maintenance_request: { table: "maintenance_requests", owner: "reported_by" },
  maintenance_before: { table: "maintenance_requests", owner: "reported_by" },
  maintenance_after: { table: "maintenance_requests", owner: "reported_by" },
  maintenance_update: { table: "maintenance_updates", owner: "created_by" },
  work_record: { table: "work_records", owner: "created_by" },
  project_expense: { table: "project_expenses", owner: "created_by" },
};

async function handleUploadAttachment(request, env, entityType, entityId) {
  const user = await getCurrentUser(request, env);
  if (!user || !user.role) return jsonResponse({ error: "กรุณาเข้าสู่ระบบ" },401);
  const config = ATTACHMENT_ENTITY_TABLES[entityType];
  if (!config) return jsonResponse({ error: "ประเภทไฟล์แนบไม่ถูกต้อง" },400);
  const entity = await env.DB.prepare(`SELECT id,${config.owner} AS owner_id FROM ${config.table} WHERE id=?`).bind(entityId).first();
  if (!entity) return jsonResponse({ error: "ไม่พบรายการที่ต้องการแนบไฟล์" },404);
  const inventoryEntity = entityType.startsWith("inventory_");
  let canUpload = inventoryEntity ? canManageInventory(user) : entity.owner_id === user.id || isAdmin(user) || user.role === "staff";
  if (entityType.startsWith("maintenance_")) {
    const maintenance = entityType === "maintenance_update"
      ? await env.DB.prepare(`SELECT m.reported_by,m.assigned_to FROM maintenance_updates x JOIN maintenance_requests m ON m.id=x.request_id WHERE x.id=?`).bind(entityId).first()
      : await env.DB.prepare("SELECT reported_by,assigned_to FROM maintenance_requests WHERE id=?").bind(entityId).first();
    canUpload = !!maintenance && (canManageMaintenance(user) || maintenance.reported_by===user.id || maintenance.assigned_to===user.id);
  }
  if (entityType === "work_record") {
    const workRecord = await env.DB.prepare("SELECT created_by,responsible_user_id FROM work_records WHERE id=?").bind(entityId).first();
    canUpload = !!workRecord && canManageWorkRecord(user, workRecord);
  }
  if (!canUpload) {
    return jsonResponse({ error: "ไม่มีสิทธิ์แนบไฟล์ในรายการนี้" },403);
  }
  const form = await request.formData().catch(()=>null);
  const file = form?.get("file");
  const validation = await validateManagedFile(file, entityType);
  if (validation.error) return jsonResponse({ error: validation.error },400);
  const safeName = String(file.name || "attachment").replace(/[^\p{L}\p{N}._ -]/gu,"_").slice(0,180);
  const officeDocument = Object.values(OFFICE_FILE_MIMES).includes(validation.mimeType);
  const provider = ["document", "work_record"].includes(entityType) || officeDocument
    ? "drive"
    : getFileStorageProvider(env);
  const allowDuplicate = String(form?.get("allow_duplicate") || "") === "1";
  const fileHash = await hashManagedFile(file);
  const existing = await env.DB.prepare("SELECT id,object_key,file_name,file_size,storage_provider,drive_file_id,file_hash FROM file_attachments WHERE entity_type=? AND entity_id=?").bind(entityType,entityId).first();
  if (entityType === "document") {
    const duplicateFile = await env.DB.prepare(`SELECT a.entity_id AS document_id, d.title, a.file_name
      FROM file_attachments a JOIN documents d ON d.id=a.entity_id
      WHERE a.entity_type='document' AND a.file_hash=? AND a.entity_id<>?
        AND COALESCE(d.record_status,'active')='active' LIMIT 1`).bind(fileHash,entityId).first();
    if (duplicateFile && !allowDuplicate) {
      return jsonResponse({
        error: `พบไฟล์เดียวกันในเอกสาร “${duplicateFile.title}”`,
        code: "duplicate_file",
        duplicate: duplicateFile,
      },409);
    }
    await env.DB.prepare("UPDATE documents SET upload_status='uploading',upload_error=NULL,updated_at=datetime('now') WHERE id=?").bind(entityId).run();
  }
  let objectKey = null;
  let driveFile = null;
  try {
    if (provider === "drive") {
      const driveError = requireDriveConfig(env);
      if (driveError) return jsonResponse({ error: driveError }, 503);
      driveFile = await uploadToGoogleDrive(env, file, entityType, entityId, safeName, validation.mimeType);
      objectKey = `drive/${crypto.randomUUID()}`;
    } else {
      if (!env.FILES) return jsonResponse({ error: "ยังไม่ได้เชื่อม R2 Storage กรุณาสร้าง R2 bucket และผูก binding ชื่อ FILES" },503);
      objectKey = `${entityType}/${entityId}/${crypto.randomUUID()}-${safeName}`;
      await env.FILES.put(objectKey,file.stream(),{httpMetadata:{contentType:validation.mimeType},customMetadata:{uploadedBy:String(user.id),originalName:safeName}});
    }
  } catch (error) {
    if (entityType === "document") await recordDocumentUploadFailure(env,user,entityId,error.message,request);
    return jsonResponse({ error: error.message || "จัดเก็บไฟล์ไม่สำเร็จ" }, 502);
  }
  let attachmentId;
  try {
    if (existing) {
      await env.DB.prepare(`UPDATE file_attachments SET object_key=?,file_name=?,mime_type=?,file_size=?,uploaded_by=?,storage_provider=?,drive_file_id=?,drive_web_url=?,storage_error=NULL,file_hash=?,created_at=datetime('now') WHERE id=?`)
        .bind(objectKey,safeName,validation.mimeType,file.size,user.id,provider,driveFile?.id || null,driveFile?.webViewLink || null,fileHash,existing.id).run();
      attachmentId = existing.id;
      if (existing.storage_provider === "drive" && existing.drive_file_id && existing.drive_file_id !== driveFile?.id) await deleteGoogleDriveFile(env, existing.drive_file_id).catch(()=>{});
      if ((existing.storage_provider || "r2") === "r2" && existing.object_key && provider !== "r2" && env.FILES) await env.FILES.delete(existing.object_key).catch(()=>{});
      if ((existing.storage_provider || "r2") === "r2" && existing.object_key && provider === "r2" && existing.object_key !== objectKey && env.FILES) await env.FILES.delete(existing.object_key).catch(()=>{});
    } else {
      const inserted = await env.DB.prepare(`INSERT INTO file_attachments(entity_type,entity_id,object_key,file_name,mime_type,file_size,uploaded_by,storage_provider,drive_file_id,drive_web_url,file_hash)
        VALUES (?,?,?,?,?,?,?,?,?,?,?)`).bind(entityType,entityId,objectKey,safeName,validation.mimeType,file.size,user.id,provider,driveFile?.id || null,driveFile?.webViewLink || null,fileHash).run();
      attachmentId = inserted.meta.last_row_id;
    }
  } catch (error) {
    if (provider === "drive" && driveFile?.id) await deleteGoogleDriveFile(env, driveFile.id).catch(()=>{});
    if (provider === "r2" && env.FILES && objectKey) await env.FILES.delete(objectKey).catch(()=>{});
    if (entityType === "document") await recordDocumentUploadFailure(env,user,entityId,"บันทึกข้อมูลไฟล์ไม่สำเร็จ กรุณาลองใหม่",request);
    return jsonResponse({ error: "บันทึกข้อมูลไฟล์ไม่สำเร็จ กรุณาลองใหม่" }, 500);
  }
  if (entityType === "document") await env.DB.prepare(`UPDATE documents SET file_name=?,mime_type=?,file_size=?,file_url=?,
      upload_status='success',upload_error=NULL,attachment_updated_at=datetime('now'),
      version=CASE WHEN ?=1 THEN version+1 ELSE version END,updated_at=datetime('now') WHERE id=?`)
    .bind(safeName,validation.mimeType,file.size,`/api/attachments/${attachmentId}`,existing ? 1 : 0,entityId).run();
  await writeAuditLog(env,user,existing ? "replace" : "upload","file_attachment",attachmentId,{
    entity_type:entityType,entity_id:entityId,file_name:safeName,file_size:file.size,file_hash:fileHash,
    previous_file_name:existing?.file_name || null,previous_file_size:existing?.file_size || null,
    storage_provider:provider,drive_file_id:driveFile?.id || null
  },request);
  return jsonResponse({ id:attachmentId,file_name:safeName,file_size:file.size,storage_provider:provider,url:`/api/attachments/${attachmentId}` },201);
}

async function readStoredAttachment(env, attachment) {
  const storageProvider = attachment.storage_provider || "r2";
  if (storageProvider === "drive") {
    if (!attachment.drive_file_id) throw new Error("ไม่พบรหัสไฟล์ Google Drive");
    const accessToken = await getGoogleDriveAccessToken(env);
    const response = await googleDriveRequest(accessToken, `/files/${encodeURIComponent(attachment.drive_file_id)}?alt=media`);
    return response.body;
  }
  if (!env.FILES) throw new Error("ยังไม่ได้เชื่อม R2 Storage");
  const object = await env.FILES.get(attachment.object_key);
  if (!object) throw new Error("ไม่พบไฟล์ในพื้นที่จัดเก็บ");
  return object.body;
}

async function handlePublicMaintenanceImage(request, env, attachmentId) {
  const url = new URL(request.url);
  const expires = Number(url.searchParams.get("expires"));
  const signature = String(url.searchParams.get("sig") || "");
  if (!env.JWT_SECRET || !Number.isInteger(expires) || expires < Math.floor(Date.now()/1000) || expires > Math.floor(Date.now()/1000)+(8*24*60*60)) {
    return jsonResponse({ error:"ลิงก์รูปภาพหมดอายุหรือไม่ถูกต้อง" },403);
  }
  const expected = await maintenanceImageSignature(env,attachmentId,expires);
  if (signature.length!==expected.length || signature!==expected) return jsonResponse({ error:"ลายเซ็นลิงก์ไม่ถูกต้อง" },403);
  const attachment = await env.DB.prepare("SELECT * FROM file_attachments WHERE id=?").bind(attachmentId).first();
  if (!attachment || !["maintenance_before","maintenance_after"].includes(attachment.entity_type) || !String(attachment.mime_type||"").startsWith("image/")) {
    return jsonResponse({ error:"ไม่พบรูปภาพ" },404);
  }
  try {
    const body = await readStoredAttachment(env,attachment);
    return new Response(body,{headers:{"Content-Type":attachment.mime_type,"Content-Length":String(attachment.file_size),"Cache-Control":"public, max-age=3600","X-Content-Type-Options":"nosniff"}});
  } catch (error) {
    return jsonResponse({ error:error.message||"เปิดรูปภาพไม่สำเร็จ" },502);
  }
}

async function handleDownloadAttachment(request, env, attachmentId) {
  const user = await getCurrentUser(request, env);
  if (!user || !user.role) return jsonResponse({ error: "กรุณาเข้าสู่ระบบ" },401);
  const attachment = await env.DB.prepare("SELECT * FROM file_attachments WHERE id=?").bind(attachmentId).first();
  if (!attachment) return jsonResponse({ error: "ไม่พบไฟล์แนบ" },404);
  if (attachment.entity_type === "document") {
    const document = await env.DB.prepare("SELECT uploaded_by,access_level FROM documents WHERE id=?").bind(attachment.entity_id).first();
    if (!document) return jsonResponse({ error: "ไม่พบทะเบียนเอกสาร" },404);
    const deniedPrivate = document.access_level === "private" && document.uploaded_by !== user.id && !isAdmin(user);
    const deniedAdmin = document.access_level === "admin" && !isAdmin(user);
    if (deniedPrivate || deniedAdmin) return jsonResponse({ error: "ไม่มีสิทธิ์เปิดไฟล์นี้" },403);
  }
  if (attachment.entity_type.startsWith("maintenance_")) {
    const maintenance = attachment.entity_type === "maintenance_update"
      ? await env.DB.prepare(`SELECT m.reported_by,m.assigned_to FROM maintenance_updates x JOIN maintenance_requests m ON m.id=x.request_id WHERE x.id=?`).bind(attachment.entity_id).first()
      : await env.DB.prepare("SELECT reported_by,assigned_to FROM maintenance_requests WHERE id=?").bind(attachment.entity_id).first();
    if (!maintenance) return jsonResponse({ error:"ไม่พบใบแจ้งซ่อม" },404);
    if (!canManageMaintenance(user) && maintenance.reported_by!==user.id && maintenance.assigned_to!==user.id) return jsonResponse({ error:"ไม่มีสิทธิ์เปิดไฟล์นี้" },403);
  }
  let body;
  try { body = await readStoredAttachment(env,attachment); }
  catch (error) { return jsonResponse({ error:error.message||"เปิดไฟล์ไม่สำเร็จ" },502); }
  const asciiName = attachment.file_name.replace(/[^A-Za-z0-9._-]/g,"_");
  return new Response(body,{headers:{
    "Content-Type":attachment.mime_type,
    "Content-Length":String(attachment.file_size),
    "Content-Disposition":`inline; filename="${asciiName}"; filename*=UTF-8''${encodeURIComponent(attachment.file_name)}`,
    "Cache-Control":"private, max-age=300",
    "X-Content-Type-Options":"nosniff",
  }});
}

async function handleStorageStatus(request, env) {
  const user = await getCurrentUser(request, env);
  if (!isAdmin(user)) return jsonResponse({ error: "ไม่มีสิทธิ์ตรวจสอบการจัดเก็บไฟล์" }, 403);
  const provider = getFileStorageProvider(env);
  const driveError = provider === "drive" ? requireDriveConfig(env) : null;
  return jsonResponse({
    provider,
    configured: provider === "drive" ? !driveError : !!env.FILES,
    drive_account: provider === "drive" ? "bbdschool2016@gmail.com" : null,
    missing: driveError ? driveError.replace("ยังไม่ได้ตั้งค่า Google Drive: ", "").split(", ") : [],
  });
}

// ---------- สถานะระบบสำหรับผู้บริหาร/ผู้ดูแลระบบ ----------
const DEFAULT_D1_DATABASE_LIMIT_BYTES = 500 * 1024 * 1024;
const DEFAULT_R2_FREE_LIMIT_BYTES = 10 * 1024 * 1024 * 1024;

function numericEnv(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

function usagePercent(used, limit) {
  if (used == null || limit == null) return null;
  if (!Number.isFinite(Number(used)) || !Number.isFinite(Number(limit)) || Number(limit) <= 0) return null;
  return Math.max(0, Math.min(100, (Number(used) / Number(limit)) * 100));
}

function usageLevel(percent) {
  if (!Number.isFinite(percent)) return "unknown";
  if (percent >= 95) return "critical";
  if (percent >= 85) return "danger";
  if (percent >= 70) return "warning";
  return "healthy";
}

async function inspectGoogleDrive(env) {
  const configError = requireDriveConfig(env);
  if (configError) {
    return {
      configured: false,
      reachable: false,
      status: "critical",
      missing: configError.replace("ยังไม่ได้ตั้งค่า Google Drive: ", "").split(", "),
    };
  }
  try {
    const accessToken = await getGoogleDriveAccessToken(env);
    const folder = await googleDriveRequest(accessToken, `/files/${encodeURIComponent(String(env.GOOGLE_DRIVE_FOLDER_ID))}?fields=id,name,trashed`)
      .then((response) => response.json());
    // OAuth แบบ drive.file บางชุดอ่านโควตารวมไม่ได้ แต่ยังอัปโหลด/เปิดไฟล์ในโฟลเดอร์ที่อนุญาตได้
    const about = await googleDriveRequest(accessToken, "/about?fields=storageQuota,user(displayName,emailAddress)")
      .then((response) => response.json()).catch(() => null);
    const used = about?.storageQuota?.usage == null ? null : Number(about.storageQuota.usage);
    const limit = about?.storageQuota?.limit == null ? null : Number(about.storageQuota.limit);
    const percent = usagePercent(used, limit);
    return {
      configured: true,
      reachable: !folder?.trashed,
      status: folder?.trashed ? "critical" : usageLevel(percent) === "unknown" ? "healthy" : usageLevel(percent),
      account: about?.user?.emailAddress || "bbdschool2016@gmail.com",
      folder_name: folder?.name || null,
      folder_trashed: !!folder?.trashed,
      used_bytes: Number.isFinite(used) ? used : null,
      limit_bytes: Number.isFinite(limit) && limit > 0 ? limit : null,
      percent,
      quota_available: !!about?.storageQuota,
    };
  } catch (error) {
    return {
      configured: true,
      reachable: false,
      status: "critical",
      error: cleanText(error?.message || error, 300) || "ตรวจสอบ Google Drive ไม่สำเร็จ",
    };
  }
}

async function handleSystemStatus(request, env) {
  const user = await getCurrentUser(request, env);
  if (!isAdmin(user)) return jsonResponse({ error: "ไม่มีสิทธิ์เข้าถึงสถานะระบบ" }, 403);

  const startedAt = Date.now();
  await ensureLineSchema(env);
  const d1Limit = numericEnv(env.D1_DATABASE_LIMIT_BYTES, DEFAULT_D1_DATABASE_LIMIT_BYTES);
  const r2Limit = numericEnv(env.R2_STORAGE_LIMIT_BYTES, DEFAULT_R2_FREE_LIMIT_BYTES);

  const [d1Probe, countsResult, attachmentResult, selectedTarget, lineDeliveryResult, googleDrive] = await Promise.all([
    env.DB.prepare("SELECT datetime('now') AS database_time").all(),
    env.DB.prepare(`SELECT
      (SELECT COUNT(*) FROM users) AS users,
      (SELECT COUNT(*) FROM students) AS students,
      (SELECT COUNT(*) FROM projects) AS projects,
      (SELECT COUNT(*) FROM documents) AS documents,
      (SELECT COUNT(*) FROM audit_logs) AS audit_logs`).first(),
    env.DB.prepare(`SELECT
      COUNT(*) AS total_files,
      COALESCE(SUM(file_size),0) AS total_bytes,
      COALESCE(SUM(CASE WHEN storage_provider='drive' THEN 1 ELSE 0 END),0) AS drive_files,
      COALESCE(SUM(CASE WHEN storage_provider='drive' THEN file_size ELSE 0 END),0) AS drive_bytes,
      COALESCE(SUM(CASE WHEN COALESCE(storage_provider,'r2')='r2' THEN 1 ELSE 0 END),0) AS r2_files,
      COALESCE(SUM(CASE WHEN COALESCE(storage_provider,'r2')='r2' THEN file_size ELSE 0 END),0) AS r2_bytes
      FROM file_attachments`).first(),
    getSelectedLineTarget(env),
    env.DB.prepare(`SELECT
      COALESCE(SUM(CASE WHEN delivery_status='sent' THEN 1 ELSE 0 END),0) AS sent,
      COALESCE(SUM(CASE WHEN delivery_status IN ('failed','quota_exhausted') THEN 1 ELSE 0 END),0) AS failed,
      MAX(CASE WHEN delivery_status IN ('failed','quota_exhausted') THEN created_at END) AS last_failed_at
      FROM maintenance_notifications WHERE created_at >= datetime('now','-30 days')`).first(),
    inspectGoogleDrive(env),
  ]);

  const d1BytesRaw = d1Probe?.meta?.size_after == null ? null : Number(d1Probe.meta.size_after);
  const d1Bytes = Number.isFinite(d1BytesRaw) && d1BytesRaw >= 0 ? d1BytesRaw : null;
  const d1Percent = usagePercent(d1Bytes, d1Limit);
  const r2Bytes = Number(attachmentResult?.r2_bytes || 0);
  const r2Percent = usagePercent(r2Bytes, r2Limit);
  const lineConfigured = !!(env.LINE_CHANNEL_SECRET && env.LINE_CHANNEL_ACCESS_TOKEN && selectedTarget);
  const lineMetrics = lineConfigured
    ? await getLineDeliveryMetrics(env, selectedTarget).catch(() => ({ recipient_count:null,monthly_usage:null,monthly_limit:null,remaining:null }))
    : { recipient_count:null,monthly_usage:null,monthly_limit:null,remaining:null };
  const linePercent = usagePercent(lineMetrics.monthly_usage, lineMetrics.monthly_limit);

  const services = {
    worker: {
      status: "healthy",
      reachable: true,
      request_usage_available: false,
      request_daily_limit: numericEnv(env.WORKERS_DAILY_REQUEST_LIMIT, 100000),
      note: "จำนวน Request และข้อผิดพลาดจริงตรวจสอบจาก Cloudflare Dashboard",
    },
    d1: {
      status: usageLevel(d1Percent) === "unknown" ? "healthy" : usageLevel(d1Percent),
      reachable: true,
      database_time: d1Probe?.results?.[0]?.database_time || null,
      used_bytes: d1Bytes,
      limit_bytes: d1Limit,
      percent: d1Percent,
      usage_available: d1Bytes !== null,
      counts: countsResult || {},
    },
    storage: {
      provider: getFileStorageProvider(env),
      total_files: Number(attachmentResult?.total_files || 0),
      total_bytes: Number(attachmentResult?.total_bytes || 0),
    },
    drive: {
      ...googleDrive,
      registered_files: Number(attachmentResult?.drive_files || 0),
      registered_bytes: Number(attachmentResult?.drive_bytes || 0),
    },
    r2: {
      configured: !!env.FILES,
      reachable: !!env.FILES,
      status: "unknown",
      registered_files: Number(attachmentResult?.r2_files || 0),
      registered_bytes: r2Bytes,
      limit_bytes: r2Limit,
      percent: r2Percent,
      note: "ยอดใช้เป็นขนาดไฟล์ในทะเบียนเท่านั้น ตรวจปริมาณจริงและจำนวนคำขอจาก Cloudflare Dashboard",
    },
    line: {
      configured: lineConfigured,
      reachable: lineConfigured && lineMetrics.monthly_usage !== null,
      status: !lineConfigured ? "critical" : usageLevel(linePercent) === "unknown" ? "warning" : usageLevel(linePercent),
      target_name: selectedTarget?.display_name || null,
      target_type: selectedTarget?.target_type || null,
      recipient_count: lineMetrics.recipient_count,
      monthly_usage: lineMetrics.monthly_usage,
      monthly_limit: lineMetrics.monthly_limit,
      remaining: lineMetrics.remaining,
      percent: linePercent,
      sent_30d: Number(lineDeliveryResult?.sent || 0),
      failed_30d: Number(lineDeliveryResult?.failed || 0),
      last_failed_at: lineDeliveryResult?.last_failed_at || null,
    },
  };

  const states = [services.d1.status, services.drive.status, services.line.status];
  const overall = states.includes("critical") ? "critical"
    : states.some((state) => state === "danger" || state === "warning") ? "warning" : "healthy";

  return jsonResponse({
    generated_at: new Date().toISOString(),
    response_time_ms: Date.now() - startedAt,
    overall,
    thresholds: { warning: 70, danger: 85, critical: 95 },
    services,
  }, 200, { "Cache-Control": "no-store" });
}

// ---------- เอกสารและการสำรองข้อมูล (ทะเบียนเมทาดาทา/ส่งออกข้อมูล) ----------
async function findDocumentDuplicates(env, user, { title, department, documentType, excludeId = 0 }) {
  const normalizedTitle = cleanText(title, 200);
  if (!normalizedTitle || !department) return [];
  const { results } = await env.DB.prepare(`SELECT d.id,d.title,d.department,d.document_type,d.file_name,d.updated_at,u.full_name AS uploader_name
    FROM documents d LEFT JOIN users u ON u.id=d.uploaded_by
    WHERE d.id<>? AND lower(trim(d.title))=lower(trim(?)) AND d.department=?
      AND lower(trim(COALESCE(d.document_type,'')))=lower(trim(COALESCE(?,'')))
      AND COALESCE(d.record_status,'active')='active'
      AND (d.access_level='staff' OR d.uploaded_by=? OR (?=1 AND d.access_level IN ('private','admin')))
    ORDER BY d.updated_at DESC LIMIT 10`)
    .bind(excludeId,normalizedTitle,department,cleanText(documentType,120) || "",user.id,isAdmin(user) ? 1 : 0).all();
  return results;
}

async function handleFindDocumentDuplicates(request, env) {
  const user = await getCurrentUser(request, env);
  if (!user || !user.role) return jsonResponse({ error: "กรุณาเข้าสู่ระบบ" },401);
  const params = new URL(request.url).searchParams;
  const department = params.get("department") || "";
  const documentDepartments = [...DEPARTMENTS,"student-support","admin"];
  if (!documentDepartments.includes(department)) return jsonResponse({ duplicates: [] });
  const duplicates = await findDocumentDuplicates(env,user,{
    title:params.get("title"),department,documentType:params.get("document_type"),excludeId:Number(params.get("exclude_id")) || 0,
  });
  return jsonResponse({ duplicates });
}

async function handleListDocuments(request, env) {
  const user = await getCurrentUser(request, env);
  if (!user || !user.role) return jsonResponse({ error: "กรุณาเข้าสู่ระบบ" }, 401);
  await ensureExtendedSchema(env);
  const params = new URL(request.url).searchParams;
  const q = cleanText(params.get("q"),100) || "";
  const view = params.get("view") === "archive" ? "archive" : "active";
  const { results } = await env.DB.prepare(`SELECT d.*,u.full_name AS uploader_name,
      a.id AS attachment_id,a.storage_provider,a.created_at AS attachment_created_at,a.storage_error,a.file_hash,
      (SELECT d2.id FROM documents d2
       WHERE d2.id<d.id AND lower(trim(d2.title))=lower(trim(d.title)) AND d2.department=d.department
         AND lower(trim(COALESCE(d2.document_type,'')))=lower(trim(COALESCE(d.document_type,'')))
         AND COALESCE(d2.record_status,'active')='active' ORDER BY d2.id LIMIT 1) AS duplicate_candidate_id
    FROM documents d
    LEFT JOIN users u ON u.id=d.uploaded_by
    LEFT JOIN file_attachments a ON a.entity_type='document' AND a.entity_id=d.id
    WHERE (? = '' OR d.title LIKE '%'||?||'%' OR d.keywords LIKE '%'||?||'%')
      AND (d.access_level='staff' OR d.uploaded_by=? OR (?=1 AND d.access_level IN ('private','admin')))
      AND ((?='active' AND COALESCE(d.record_status,'active')='active')
        OR (?='archive' AND COALESCE(d.record_status,'active') IN ('archived','duplicate')))
    ORDER BY d.updated_at DESC`).bind(q,q,q,user.id,isAdmin(user) ? 1 : 0,view,view).all();
  const canArchive = isAdmin(user) || user.role === "staff";
  const documents = results.map((row) => ({
    ...row,
    can_manage_file: row.uploaded_by === user.id || isAdmin(user) || user.role === "staff",
    can_archive: canArchive,
  }));
  const counts = await env.DB.prepare(`SELECT
      SUM(CASE WHEN COALESCE(record_status,'active')='active' THEN 1 ELSE 0 END) AS active,
      SUM(CASE WHEN COALESCE(record_status,'active')='active' AND file_url IS NOT NULL THEN 1 ELSE 0 END) AS with_file,
      SUM(CASE WHEN COALESCE(record_status,'active')='active' AND file_url IS NULL THEN 1 ELSE 0 END) AS without_file,
      SUM(CASE WHEN COALESCE(record_status,'active') IN ('archived','duplicate') THEN 1 ELSE 0 END) AS archive
    FROM documents WHERE access_level='staff' OR uploaded_by=? OR (?=1 AND access_level IN ('private','admin'))`)
    .bind(user.id,isAdmin(user) ? 1 : 0).first();
  return jsonResponse({ documents, counts, view });
}
async function handleCreateDocument(request, env) {
  const user = await getCurrentUser(request, env);
  if (!user || !user.role) return jsonResponse({ error: "กรุณาเข้าสู่ระบบ" }, 401);
  await ensureExtendedSchema(env);
  const body = await request.json().catch(() => null);
  const documentDepartments = [...DEPARTMENTS, "student-support", "admin"];
  if (!body || !cleanText(body.title, 200) || !documentDepartments.includes(body.department)) return jsonResponse({ error: "กรุณาระบุชื่อเอกสารและฝ่ายงานให้ถูกต้อง" }, 400);
  const accessLevel = ["private", "staff", "admin"].includes(body.access_level) ? body.access_level : "staff";
  const duplicates = await findDocumentDuplicates(env,user,{
    title:body.title,department:body.department,documentType:body.document_type,
  });
  if (duplicates.length && body.allow_duplicate !== true) {
    return jsonResponse({ error:"พบทะเบียนเอกสารที่มีชื่อ ฝ่ายงาน และประเภทเดียวกัน",code:"duplicate_document",duplicates },409);
  }
  const result = await env.DB.prepare(`INSERT INTO documents
    (title, department, academic_year_id, project_id, document_type, keywords, file_name, file_url, mime_type, file_size, access_level, uploaded_by,record_status,upload_status)
    VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, ?, ?,'active','none')`).bind(cleanText(body.title, 200), body.department, body.academic_year_id || null, body.project_id || null,
      cleanText(body.document_type, 120), cleanText(body.keywords, 500), accessLevel, user.id).run();
  await writeAuditLog(env,user,"create","document",result.meta.last_row_id,{ title:cleanText(body.title,200),department:body.department,duplicate_warning_acknowledged:duplicates.length>0 },request);
  return jsonResponse({ id: result.meta.last_row_id, duplicate_warning_acknowledged:duplicates.length>0 }, 201);
}

async function handleUpdateDocumentWorkflow(request, env, documentId) {
  const user = await getCurrentUser(request, env);
  if (!user || !user.role) return jsonResponse({ error:"กรุณาเข้าสู่ระบบ" },401);
  if (!(isAdmin(user) || user.role === "staff")) return jsonResponse({ error:"ไม่มีสิทธิ์จัดเก็บหรือกู้คืนทะเบียนเอกสาร" },403);
  const document = await env.DB.prepare("SELECT * FROM documents WHERE id=?").bind(documentId).first();
  if (!document) return jsonResponse({ error:"ไม่พบทะเบียนเอกสาร" },404);
  const body = await request.json().catch(()=>null);
  const action = body?.action;
  if (action === "restore") {
    await env.DB.prepare(`UPDATE documents SET record_status='active',duplicate_of_id=NULL,archived_at=NULL,archive_reason=NULL,updated_at=datetime('now') WHERE id=?`).bind(documentId).run();
  } else if (action === "archive") {
    await env.DB.prepare(`UPDATE documents SET record_status='archived',duplicate_of_id=NULL,archived_at=datetime('now'),archive_reason=?,updated_at=datetime('now') WHERE id=?`)
      .bind(cleanText(body.reason,300) || "จัดเก็บจากหน้าคลังเอกสาร",documentId).run();
  } else if (action === "mark_duplicate") {
    const duplicateOfId = Number(body.duplicate_of_id);
    if (!Number.isInteger(duplicateOfId) || duplicateOfId <= 0 || duplicateOfId === documentId) return jsonResponse({ error:"กรุณาระบุรายการต้นฉบับให้ถูกต้อง" },400);
    const original = await env.DB.prepare("SELECT id FROM documents WHERE id=? AND COALESCE(record_status,'active')='active'").bind(duplicateOfId).first();
    if (!original) return jsonResponse({ error:"ไม่พบรายการต้นฉบับที่ใช้งานอยู่" },404);
    await env.DB.prepare(`UPDATE documents SET record_status='duplicate',duplicate_of_id=?,archived_at=datetime('now'),archive_reason=?,updated_at=datetime('now') WHERE id=?`)
      .bind(duplicateOfId,cleanText(body.reason,300) || `รายการซ้ำกับทะเบียนเลขที่ ${duplicateOfId}`,documentId).run();
  } else {
    return jsonResponse({ error:"คำสั่งจัดการทะเบียนเอกสารไม่ถูกต้อง" },400);
  }
  await writeAuditLog(env,user,action,"document",documentId,{ duplicate_of_id:Number(body?.duplicate_of_id) || null,reason:cleanText(body?.reason,300) },request);
  return jsonResponse({ ok:true });
}
async function handleSecurityOverview(request, env) {
  const user = await getCurrentUser(request, env);
  if (!isAdmin(user)) return jsonResponse({ error: "ไม่มีสิทธิ์เข้าถึงข้อมูลความปลอดภัย" }, 403);
  await ensureExtendedSchema(env);
  const tables = ["users", "students", "personnel_records", "projects", "project_expenses", "inventory_items", "inventory_transactions", "student_support_cases", "work_records", "documents", "file_attachments", "audit_logs"];
  const counts = {};
  for (const table of tables) counts[table] = (await env.DB.prepare(`SELECT COUNT(*) AS count FROM ${table}`).first()).count;
  const { results: logs } = await env.DB.prepare(`SELECT a.*, u.full_name FROM audit_logs a LEFT JOIN users u ON u.id=a.user_id ORDER BY a.created_at DESC LIMIT 50`).all();
  return jsonResponse({ counts, logs, backup: user.role === "superadmin" ? await getBackupOverview(env) : null }, 200, { "Cache-Control": "private, no-store" });
}

// ---------- /api/overview (GET) — ภาพรวมสำหรับหน้าแดชบอร์ด ----------
async function handleOverview(request, env) {
  const user = await getCurrentUser(request, env);
  if (!user || !user.role) return jsonResponse({ error: "กรุณาเข้าสู่ระบบ" }, 401);

  await Promise.all([ensurePersonnelData(env), ensureAcademicData(env)]);
  const currentAcademicPeriod = await getCurrentAcademicPeriod(env);

  const studentsEnrolled = await env.DB.prepare(
    "SELECT COUNT(*) as count FROM students WHERE status = 'enrolled'"
  ).first();
  const staffCount = await env.DB.prepare(
    "SELECT COUNT(*) as count FROM personnel_records WHERE status = 'active'"
  ).first();
  const openTasks = await env.DB.prepare("SELECT COUNT(*) as count FROM tasks WHERE status = 'open'").first();
  const overdueTasks = await env.DB.prepare(
    "SELECT COUNT(*) as count FROM tasks WHERE status = 'open' AND due_date IS NOT NULL AND due_date < date('now')"
  ).first();
  const ongoingProjects = await env.DB.prepare(
    "SELECT COUNT(*) as count FROM projects WHERE status = 'ongoing'"
  ).first();
  const pendingLeave = await env.DB.prepare(
    "SELECT COUNT(*) as count FROM leave_requests WHERE status = 'pending'"
  ).first();
  const pendingProjectExpenses = await env.DB.prepare(
    `SELECT COUNT(*) AS count, COALESCE(SUM(amount), 0) AS total_amount
     FROM project_expenses WHERE status IN ('pending','approved')`
  ).first();
  const inventoryAlerts = await env.DB.prepare(`SELECT
    SUM(CASE WHEN status='active' AND minimum_quantity > 0 AND current_quantity <= minimum_quantity THEN 1 ELSE 0 END) AS low_stock_count,
    SUM(CASE WHEN status IN ('repair','lost') OR item_condition IN ('damaged','lost') THEN 1 ELSE 0 END) AS attention_count
    FROM inventory_items`).first();
  const overdueInventoryBorrows = await env.DB.prepare(`SELECT COUNT(*) AS count FROM inventory_transactions b
    WHERE b.transaction_type='borrow' AND b.due_date IS NOT NULL AND b.due_date < date('now')
      AND b.quantity > COALESCE((SELECT SUM(r.quantity) FROM inventory_transactions r
        WHERE r.transaction_type='return' AND r.related_transaction_id=b.id),0)`).first();
  const { results: departmentRows } = await env.DB.prepare(
    `SELECT department,
            COUNT(*) AS project_count,
            ROUND(AVG(progress_percent), 0) AS average_progress,
            COALESCE(SUM(budget_amount), 0) AS total_budget,
            COALESCE(SUM(spent_amount), 0) AS spent_budget
     FROM projects
     GROUP BY department`
  ).all();

  const { results: projectBudgetRows } = await env.DB.prepare(
    `SELECT p.id, p.department, p.name, p.status, p.progress_percent,
            COALESCE(p.budget_amount, 0) AS budget_amount,
            COALESCE(p.spent_amount, 0) AS spent_amount,
            COALESCE(p.budget_amount, 0) - COALESCE(p.spent_amount, 0) AS remaining_amount,
            y.label AS academic_year_label,
            GROUP_CONCAT(u.full_name, ', ') AS owner_names
     FROM projects p
     LEFT JOIN academic_years y ON y.id = p.academic_year_id
     LEFT JOIN project_owners po ON po.project_id = p.id
     LEFT JOIN users u ON u.id = po.user_id
     GROUP BY p.id
     ORDER BY CASE p.department
                WHEN 'academic' THEN 1 WHEN 'budget' THEN 2
                WHEN 'personnel' THEN 3 WHEN 'general' THEN 4 ELSE 5 END,
              CASE p.status WHEN 'ongoing' THEN 1 WHEN 'completed' THEN 2 ELSE 3 END,
              p.name`
  ).all();

  const { results: licensesExpiring } = await env.DB.prepare(
    `SELECT full_name, license_expiry_date,
            CAST(julianday(license_expiry_date) - julianday(date('now')) AS INTEGER) AS days_remaining
     FROM personnel_records
     WHERE status = 'active'
       AND license_expiry_date IS NOT NULL
     ORDER BY days_remaining ASC, full_name ASC`
  ).all();

  const departmentMap = Object.fromEntries(departmentRows.map((row) => [row.department, row]));
  const departmentSummary = DEPARTMENTS.map((department) => {
    const row = departmentMap[department];
    return {
      department,
      project_count: Number(row?.project_count || 0),
      average_progress: Number(row?.average_progress || 0),
      total_budget: Number(row?.total_budget || 0),
      spent_budget: Number(row?.spent_budget || 0),
      remaining_budget: Number(row?.total_budget || 0) - Number(row?.spent_budget || 0),
      projects: projectBudgetRows
        .filter((project) => project.department === department)
        .map((project) => ({
          ...project,
          budget_amount: Number(project.budget_amount || 0),
          spent_amount: Number(project.spent_amount || 0),
          remaining_amount: Number(project.remaining_amount || 0),
          progress_percent: Number(project.progress_percent || 0),
        })),
    };
  });

  const totalProjectBudget = departmentSummary.reduce((sum, row) => sum + row.total_budget, 0);
  const totalProjectSpent = departmentSummary.reduce((sum, row) => sum + row.spent_budget, 0);

  return jsonResponse({
    students_enrolled: studentsEnrolled.count,
    staff_count: staffCount.count,
    open_tasks: openTasks.count,
    overdue_tasks: overdueTasks.count,
    ongoing_projects: ongoingProjects.count,
    pending_leave_requests: pendingLeave.count,
    pending_project_expenses: Number(pendingProjectExpenses?.count || 0),
    pending_project_expense_amount: Number(pendingProjectExpenses?.total_amount || 0),
    inventory_low_stock_count: Number(inventoryAlerts?.low_stock_count || 0),
    inventory_attention_count: Number(inventoryAlerts?.attention_count || 0),
    inventory_overdue_borrow_count: Number(overdueInventoryBorrows?.count || 0),
    total_project_budget: totalProjectBudget,
    total_project_spent: totalProjectSpent,
    total_project_remaining: totalProjectBudget - totalProjectSpent,
    department_summary: departmentSummary,
    licenses_expiring: licensesExpiring,
    current_academic_period: currentAcademicPeriod,
  });
}

// ---------- /api/students/import (POST) — นำเข้าจาก Excel/CSV แบบ upsert ตามเลขประจำตัว ----------
async function handleImportStudents(request, env) {
  const user = await getCurrentUser(request, env);
  if (!user || !user.role) return jsonResponse({ error: "กรุณาเข้าสู่ระบบ" }, 401);
  if (!canManageStudents(user)) return jsonResponse({ error: "ไม่มีสิทธิ์นำเข้าข้อมูลนักเรียน" }, 403);

  let body;
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ error: "รูปแบบข้อมูลไม่ถูกต้อง" }, 400);
  }
  if (!body || !Array.isArray(body.rows) || body.rows.length === 0) {
    return jsonResponse({ error: "ไม่พบรายการนักเรียนสำหรับนำเข้า" }, 400);
  }
  if (body.rows.length > 20) {
    return jsonResponse({ error: "รับข้อมูลได้ครั้งละไม่เกิน 20 รายการ กรุณารีเฟรชหน้าเว็บเพื่อใช้ระบบแบ่งชุดอัตโนมัติ" }, 400);
  }

  const skipped = [];
  const validRows = [];
  const seenCodes = new Map();
  const asText = (value) => {
    const text = value == null ? "" : String(value).trim();
    return ["-", "–", "—"].includes(text) ? "" : text;
  };
  const importDate = (value) => {
    const text = asText(value);
    if (!text) return "";
    let match = text.match(/^(\d{1,2})[\/-](\d{1,2})[\/-](\d{4})$/);
    if (match) {
      let year = Number(match[3]);
      if (year > 2400) year -= 543;
      const month = Number(match[2]);
      const day = Number(match[1]);
      if (year >= 1900 && month >= 1 && month <= 12 && day >= 1 && day <= 31) {
        return `${year.toString().padStart(4, "0")}-${month.toString().padStart(2, "0")}-${day.toString().padStart(2, "0")}`;
      }
    }
    match = text.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (match) {
      let year = Number(match[1]);
      if (year > 2400) year -= 543;
      return `${year.toString().padStart(4, "0")}-${match[2]}-${match[3]}`;
    }
    return text;
  };
  body.rows.forEach((row, index) => {
    if (!row || typeof row !== "object" || Array.isArray(row)) {
      skipped.push({ row: index + 1, reason: "รูปแบบข้อมูลไม่ถูกต้อง" });
      return;
    }
    const studentCode = asText(row.student_code);
    const prefix = asText(row.name_prefix);
    const first = asText(row.first_name);
    const last = asText(row.last_name);
    const fullName = composeFullName(prefix, first, last, row.full_name);
    if (!studentCode || !fullName) {
      skipped.push({ row: index + 1, reason: "ไม่มีเลขประจำตัวหรือชื่อ-นามสกุล" });
      return;
    }
    if (seenCodes.has(studentCode)) {
      skipped.push({ row: index + 1, reason: `เลขประจำตัว ${studentCode} ซ้ำกับรายการที่ ${seenCodes.get(studentCode)} ในชุดเดียวกัน` });
      return;
    }
    seenCodes.set(studentCode, index + 1);
    validRows.push({
      rowNumber: index + 1,
      baseValues: [
        studentCode, fullName, asText(row.national_id) || null,
        prefix || null, first || null, last || null, importDate(row.birth_date) || null,
        asText(row.classroom) || null, asText(row.grade_level) || null,
        asText(row.health_conditions) || null, asText(row.allergies) || null,
        asText(row.photo_url) || null,
      ],
      details: getSubmittedStudentDetails(row),
    });
  });
  if (!validRows.length) return jsonResponse({ created: 0, updated: 0, skipped });

  try {
    await ensureStudentDetailsSchema(env);
    // One lookup plus at most two writes per student (ทะเบียนหลัก + ข้อมูลเพิ่มเติม).
    const codes = [...new Set(validRows.map((row) => row.baseValues[0]))];
    const { results } = await env.DB.prepare(
      `SELECT student_code, full_name FROM students WHERE student_code IN (${codes.map(() => "?").join(",")})`
    ).bind(...codes).all();
    const existingByCode = new Map(results.map((row) => [String(row.student_code), row]));
    const normalizeNameForMatch = (value) => String(value || "")
      .normalize("NFKC")
      .replace(/(?:^|\s)[\-–—](?=\s|$)/g, " ")
      .replace(/[\s.]+/g, "")
      .toLocaleLowerCase("th");
    const rowsToWrite = validRows.filter(({ rowNumber, baseValues }) => {
      const existing = existingByCode.get(String(baseValues[0]));
      if (!existing || normalizeNameForMatch(existing.full_name) === normalizeNameForMatch(baseValues[1])) return true;
      skipped.push({
        row: rowNumber,
        reason: `เลขประจำตัว ${baseValues[0]} มีอยู่แล้ว แต่ชื่อไม่ตรงกับ “${existing.full_name}” ระบบจึงไม่เขียนทับ`,
      });
      return false;
    });
    if (!rowsToWrite.length) return jsonResponse({ created: 0, updated: 0, skipped });
    const knownCodes = new Set(existingByCode.keys());
    let created = 0;
    let updated = 0;
    const statements = [];
    rowsToWrite.forEach(({ baseValues: values, details }) => {
      if (knownCodes.has(values[0])) updated++;
      else { created++; knownCodes.add(values[0]); }
      // Retrying a committed batch updates the same student codes, without duplicates.
      statements.push(env.DB.prepare(`INSERT INTO students
        (student_code, full_name, national_id, name_prefix, first_name, last_name, birth_date,
         classroom, grade_level, health_conditions, allergies, photo_url, status)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'enrolled')
        ON CONFLICT(student_code) DO UPDATE SET
          full_name = excluded.full_name,
          national_id = COALESCE(excluded.national_id, students.national_id),
          name_prefix = COALESCE(excluded.name_prefix, students.name_prefix),
          first_name = COALESCE(excluded.first_name, students.first_name),
          last_name = COALESCE(excluded.last_name, students.last_name),
          birth_date = COALESCE(excluded.birth_date, students.birth_date),
          classroom = COALESCE(excluded.classroom, students.classroom),
          grade_level = COALESCE(excluded.grade_level, students.grade_level),
          health_conditions = COALESCE(excluded.health_conditions, students.health_conditions),
          allergies = COALESCE(excluded.allergies, students.allergies),
          photo_url = COALESCE(excluded.photo_url, students.photo_url)`).bind(...values));
      const detailStatement = prepareStudentDetailsUpsert(env, values[0], details, true);
      if (detailStatement) statements.push(detailStatement);
    });
    // D1 batch is transactional: an error rolls back every write in this batch.
    await env.DB.batch(statements);
    return jsonResponse({ created, updated, skipped });
  } catch (err) {
    const message = String(err && err.message || "");
    if (/no such column|has no column named/i.test(message)) {
      return jsonResponse({ error: "ฐานข้อมูลนักเรียนยังขาดคอลัมน์ที่ระบบต้องใช้ กรุณาให้ผู้ดูแลตรวจและเพิ่มคอลัมน์ตามคู่มือก่อนนำเข้าต่อ" }, 500);
    }
    return jsonResponse({ error: "บันทึกชุดนี้ไม่สำเร็จ กรุณาลองนำเข้าต่อจากชุดที่ค้าง หากยังไม่สำเร็จให้ผู้ดูแลตรวจฐานข้อมูลและข้อจำกัดการใช้งาน" }, 500);
  }
}

// ---------- /api/staff/import (POST) — นำเข้าโปรไฟล์บุคลากรจาก Excel/CSV โดยจับคู่ด้วยอีเมล ----------
async function handleImportStaff(request, env) {
  const user = await getCurrentUser(request, env);
  if (!user || !user.role) return jsonResponse({ error: "กรุณาเข้าสู่ระบบ" }, 401);
  if (!isAdmin(user)) return jsonResponse({ error: "เฉพาะผู้บริหาร/ผู้ดูแลระบบเท่านั้นที่นำเข้าข้อมูลบุคลากรได้" }, 403);

  let body;
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ error: "รูปแบบข้อมูลไม่ถูกต้อง" }, 400);
  }

  if (!Array.isArray(body.rows) || body.rows.length > 1000) {
    return jsonResponse({ error: "กรุณาส่งข้อมูลครูไม่เกิน 1,000 แถวต่อครั้ง" }, 400);
  }
  await ensurePersonnelData(env);
  return jsonResponse(await importStaffRows(env, body.rows));
}

// ---------- Router ----------
export default {
  async fetch(request, env, context) {
    const url = new URL(request.url);
    const { pathname } = url;
    const method = request.method;

    try {
      // LINE ต้องได้รับ HTTP 200 อย่างรวดเร็ว: ตรวจลายเซ็นและตอบก่อน migration/auth ของ API ภายใน
      if (pathname === "/api/line/webhook" && method === "POST") return await handleLineWebhook(request, env, context);
      if (pathname === "/api/line/webhook") return jsonResponse({ error: "Method not allowed" }, 405, { Allow: "POST" });

      if (pathname === "/api/auth/register" && method === "POST") return await handleRegister(request, env);
      if (pathname === "/api/auth/login" && method === "POST") return await handleLogin(request, env);
      if (pathname === "/api/auth/logout" && method === "POST") return await handleLogout();
      if (pathname === "/api/auth/me" && method === "GET") return await handleMe(request, env);

      // หน้าตั้งค่า LINE เป็นส่วนบริหารระบบ: ป้องกันตั้งแต่ก่อนเสิร์ฟไฟล์หน้าเว็บ
      if ((pathname === "/line-settings.html" || pathname === "/line-settings") && method === "GET") {
        const user = await getCurrentUser(request, env);
        if (!user) return Response.redirect(new URL("/login.html", url.origin), 302);
        if (user.role !== "superadmin") return Response.redirect(new URL("/dashboard.html", url.origin), 302);
      }

      if ((pathname === "/system-status.html" || pathname === "/system-status") && method === "GET") {
        const user = await getCurrentUser(request, env);
        if (!user) return Response.redirect(new URL("/login.html", url.origin), 302);
        if (!isAdmin(user)) return Response.redirect(new URL("/dashboard.html", url.origin), 302);
      }

      if ((pathname === "/security.html" || pathname === "/security") && method === "GET") {
        const user = await getCurrentUser(request, env);
        if (!user) return Response.redirect(new URL("/login.html", url.origin), 302);
        if (!isAdmin(user)) return Response.redirect(new URL("/dashboard.html", url.origin), 302);
      }

      // การส่งออก D1 จะพักคำสั่ง SQL อื่นชั่วคราว จึงให้การ poll ใช้ตั๋วอายุสั้นแทนการอ่าน D1
      if (pathname.startsWith("/api/security/backup/")) return await handleBackupExport(request, env, pathname);

      if (pathname === "/api/system/status" && method === "GET") {
        const user = await getCurrentUser(request, env);
        if (!isAdmin(user)) return jsonResponse({ error: "ไม่มีสิทธิ์เข้าถึงสถานะระบบ" }, 403);
        await ensureAcademicData(env);
        await ensureExtendedSchema(env);
        return await handleSystemStatus(request, env);
      }

      // ติดตั้ง/อัปเกรดโครงสร้างปีการศึกษาก่อนใช้ API ภายในระบบ
      if (pathname.startsWith("/api/")) {
        await ensureAcademicData(env);
        await ensureExtendedSchema(env);
      }

      const publicMaintenanceImageMatch = pathname.match(/^\/api\/public\/maintenance-image\/(\d+)$/);
      if (publicMaintenanceImageMatch && method === "GET") return await handlePublicMaintenanceImage(request,env,Number(publicMaintenanceImageMatch[1]));

      const timetableSyncResponse = await handleTimetableSyncRoute(request, env, pathname, method);
      if (timetableSyncResponse) return timetableSyncResponse;

      const academicPeriodResponse = await handleAcademicPeriodRoute(request, env, pathname, method);
      if (academicPeriodResponse) return academicPeriodResponse;
      const learnerAnalysisResponse = await handleLearnerAnalysisRoute(request, env, pathname, method);
      if (learnerAnalysisResponse) return learnerAnalysisResponse;
      const timetableResponse = await handleTimetableRoute(request, env, pathname, method);
      if (timetableResponse) return timetableResponse;
      const schoolBankResponse = await handleSchoolBankRoute(request, env, pathname, method);
      if (schoolBankResponse) return schoolBankResponse;
      const budgetResponse = await handleBudgetRoute(request, env, pathname, method);
      if (budgetResponse) return budgetResponse;

      if (pathname === "/api/line/status" && method === "GET") return await handleLineStatus(request, env);
      if (pathname === "/api/line/test" && method === "POST") return await handleLineTest(request, env);
      const lineTargetMatch = pathname.match(/^\/api\/line\/targets\/(\d+)$/);
      if (lineTargetMatch && method === "PATCH") return await handleUpdateLineTarget(request, env, Number(lineTargetMatch[1]));

      if (pathname === "/api/admin/users" && method === "GET") return await handleAdminListUsers(request, env);

      const adminUserMatch = pathname.match(/^\/api\/admin\/users\/(\d+)$/);
      if (adminUserMatch && method === "PATCH") {
        return await handleAdminUpdateUser(request, env, Number(adminUserMatch[1]));
      }
      if (adminUserMatch && method === "DELETE") {
        return await handleAdminDeleteUser(request, env, Number(adminUserMatch[1]));
      }

      if (pathname === "/api/users" && method === "GET") return await handleListUsers(request, env);
      if (pathname === "/api/search" && method === "GET") return await handleGlobalSearch(request, env);
      if (pathname === "/api/work-records" && method === "GET") return await handleListWorkRecords(request, env);
      if (pathname === "/api/work-records" && method === "POST") return await handleCreateWorkRecord(request, env);
      const workRecordMatch = pathname.match(/^\/api\/work-records\/(\d+)$/);
      if (workRecordMatch && method === "GET") return await handleGetWorkRecord(request, env, Number(workRecordMatch[1]));
      if (workRecordMatch && method === "PATCH") return await handleUpdateWorkRecord(request, env, Number(workRecordMatch[1]));
      if (pathname === "/api/tasks" && method === "GET") return await handleListTasks(request, env);
      if (pathname === "/api/tasks" && method === "POST") return await handleCreateTask(request, env);

      const taskStatusMatch = pathname.match(/^\/api\/tasks\/(\d+)\/status$/);
      if (taskStatusMatch && method === "PATCH") {
        return await handleUpdateMyTaskStatus(request, env, Number(taskStatusMatch[1]));
      }

      const taskMatch = pathname.match(/^\/api\/tasks\/(\d+)$/);
      if (taskMatch && method === "PATCH") return await handleUpdateTask(request, env, Number(taskMatch[1]));
      if (taskMatch && method === "DELETE") return await handleDeleteTask(request, env, Number(taskMatch[1]));

      if (pathname === "/api/students" && method === "GET") return await handleListStudents(request, env);
      if (pathname === "/api/students" && method === "POST") return await handleCreateStudent(request, env);
      if (pathname === "/api/students/import" && method === "POST") return await handleImportStudents(request, env);

      const studentGuardiansMatch = pathname.match(/^\/api\/students\/(\d+)\/guardians$/);
      if (studentGuardiansMatch && method === "POST") {
        return await handleAddGuardian(request, env, Number(studentGuardiansMatch[1]));
      }

      const studentMatch = pathname.match(/^\/api\/students\/(\d+)$/);
      if (studentMatch && method === "GET") return await handleGetStudent(request, env, Number(studentMatch[1]));
      if (studentMatch && method === "PATCH") return await handleUpdateStudent(request, env, Number(studentMatch[1]));
      if (studentMatch && method === "DELETE") return await handleDeleteStudent(request, env, Number(studentMatch[1]));

      const guardianMatch = pathname.match(/^\/api\/guardians\/(\d+)$/);
      if (guardianMatch && method === "PATCH") return await handleUpdateGuardian(request, env, Number(guardianMatch[1]));
      if (guardianMatch && method === "DELETE") return await handleDeleteGuardian(request, env, Number(guardianMatch[1]));

      if (pathname === "/api/staff" && method === "GET") return await handleListStaff(request, env);
      if (pathname === "/api/staff/import" && method === "POST") return await handleImportStaff(request, env);
      if (pathname === "/api/projects/import" && method === "POST") return await handleImportProjects(request, env);

      const staffMatch = pathname.match(/^\/api\/staff\/(\d+)$/);
      if (staffMatch && method === "PATCH") return await handleUpdateStaff(request, env, Number(staffMatch[1]));

      if (pathname === "/api/reports/summary" && method === "GET") return await handleReportsSummary(request, env);

      const deptProjectsMatch = pathname.match(/^\/api\/departments\/([a-z]+)\/projects$/);
      if (deptProjectsMatch && method === "GET") return await handleListProjects(request, env, deptProjectsMatch[1]);
      if (deptProjectsMatch && method === "POST") return await handleCreateProject(request, env, deptProjectsMatch[1]);

      const projectExpensesMatch = pathname.match(/^\/api\/projects\/(\d+)\/expenses$/);
      if (projectExpensesMatch && method === "GET") return await handleListProjectExpenses(request, env, Number(projectExpensesMatch[1]));
      if (projectExpensesMatch && method === "POST") return await handleCreateProjectExpense(request, env, Number(projectExpensesMatch[1]));

      const expenseMatch = pathname.match(/^\/api\/project-expenses\/(\d+)$/);
      if (expenseMatch && method === "PATCH") return await handleUpdateProjectExpense(request, env, Number(expenseMatch[1]));
      if (expenseMatch && method === "DELETE") return await handleDeleteProjectExpense(request, env, Number(expenseMatch[1]));

      const projectMatch = pathname.match(/^\/api\/projects\/(\d+)$/);
      if (projectMatch && method === "PATCH") return await handleUpdateProject(request, env, Number(projectMatch[1]));
      if (projectMatch && method === "DELETE") return await handleDeleteProject(request, env, Number(projectMatch[1]));

      const deptTopicsMatch = pathname.match(/^\/api\/departments\/([a-z]+)\/topics$/);
      if (deptTopicsMatch && method === "GET") return await handleListTopics(request, env, deptTopicsMatch[1]);
      if (deptTopicsMatch && method === "POST") return await handleCreateTopic(request, env, deptTopicsMatch[1]);

      const topicMatch = pathname.match(/^\/api\/topics\/(\d+)$/);
      if (topicMatch && method === "PATCH") return await handleUpdateTopic(request, env, Number(topicMatch[1]));
      if (topicMatch && method === "DELETE") return await handleDeleteTopic(request, env, Number(topicMatch[1]));

      if (pathname === "/api/leave-requests" && method === "GET") return await handleListLeaveRequests(request, env);
      if (pathname === "/api/leave-requests" && method === "POST") return await handleCreateLeaveRequest(request, env);

      const leaveMatch = pathname.match(/^\/api\/leave-requests\/(\d+)$/);
      if (leaveMatch && method === "PATCH") return await handleUpdateLeaveRequest(request, env, Number(leaveMatch[1]));
      if (leaveMatch && method === "DELETE") return await handleDeleteLeaveRequest(request, env, Number(leaveMatch[1]));

      if (pathname === "/api/student-support" && method === "GET") return await handleListSupportCases(request, env);
      if (pathname === "/api/student-support" && method === "POST") return await handleCreateSupportCase(request, env);
      const supportMatch = pathname.match(/^\/api\/student-support\/(\d+)$/);
      if (supportMatch && method === "PATCH") return await handleUpdateSupportCase(request, env, Number(supportMatch[1]));

      if (pathname === "/api/inventory/summary" && method === "GET") return await handleInventorySummary(request, env);
      if (pathname === "/api/inventory/items" && method === "GET") return await handleListInventoryItems(request, env);
      if (pathname === "/api/inventory/items" && method === "POST") return await handleCreateInventoryItem(request, env);
      const inventoryTransactionsMatch = pathname.match(/^\/api\/inventory\/items\/(\d+)\/transactions$/);
      if (inventoryTransactionsMatch && method === "POST") return await handleCreateInventoryTransaction(request, env, Number(inventoryTransactionsMatch[1]));
      const inventoryInspectionsMatch = pathname.match(/^\/api\/inventory\/items\/(\d+)\/inspections$/);
      if (inventoryInspectionsMatch && method === "POST") return await handleCreateInventoryInspection(request, env, Number(inventoryInspectionsMatch[1]));
      const inventoryItemMatch = pathname.match(/^\/api\/inventory\/items\/(\d+)$/);
      if (inventoryItemMatch && method === "GET") return await handleGetInventoryItem(request, env, Number(inventoryItemMatch[1]));
      if (inventoryItemMatch && method === "PATCH") return await handleUpdateInventoryItem(request, env, Number(inventoryItemMatch[1]));

      if (pathname === "/api/facilities" && method === "GET") return await handleListFacilities(request,env);
      if (pathname === "/api/facilities" && method === "POST") return await handleCreateFacility(request,env);
      const facilityMatch = pathname.match(/^\/api\/facilities\/(\d+)$/);
      if (facilityMatch && method === "PATCH") return await handleUpdateFacility(request,env,Number(facilityMatch[1]));

      if (pathname === "/api/maintenance/summary" && method === "GET") return await handleMaintenanceSummary(request,env);
      if (pathname === "/api/maintenance/requests" && method === "GET") return await handleListMaintenanceRequests(request,env);
      if (pathname === "/api/maintenance/requests" && method === "POST") return await handleCreateMaintenanceRequest(request,env);
      const maintenanceNotifyMatch = pathname.match(/^\/api\/maintenance\/requests\/(\d+)\/notify$/);
      if (maintenanceNotifyMatch && method === "POST") return await handleNotifyMaintenanceRequest(request,env,Number(maintenanceNotifyMatch[1]));
      const maintenanceRequestMatch = pathname.match(/^\/api\/maintenance\/requests\/(\d+)$/);
      if (maintenanceRequestMatch && method === "GET") return await handleGetMaintenanceRequest(request,env,Number(maintenanceRequestMatch[1]));
      if (maintenanceRequestMatch && method === "PATCH") return await handleUpdateMaintenanceRequest(request,env,Number(maintenanceRequestMatch[1]));

      const uploadAttachmentMatch = pathname.match(/^\/api\/attachments\/(document|inventory_transaction|inventory_inspection|maintenance_request|maintenance_before|maintenance_after|maintenance_update|work_record|project_expense)\/(\d+)$/);
      if (uploadAttachmentMatch && method === "POST") return await handleUploadAttachment(request, env, uploadAttachmentMatch[1], Number(uploadAttachmentMatch[2]));
      const downloadAttachmentMatch = pathname.match(/^\/api\/attachments\/(\d+)$/);
      if (downloadAttachmentMatch && method === "GET") return await handleDownloadAttachment(request, env, Number(downloadAttachmentMatch[1]));
      if (pathname === "/api/storage/status" && method === "GET") return await handleStorageStatus(request, env);

      if (pathname === "/api/documents/duplicates" && method === "GET") return await handleFindDocumentDuplicates(request, env);
      if (pathname === "/api/documents" && method === "GET") return await handleListDocuments(request, env);
      if (pathname === "/api/documents" && method === "POST") return await handleCreateDocument(request, env);
      const documentMatch = pathname.match(/^\/api\/documents\/(\d+)$/);
      if (documentMatch && method === "PATCH") return await handleUpdateDocumentWorkflow(request, env, Number(documentMatch[1]));
      if (pathname === "/api/security/overview" && method === "GET") return await handleSecurityOverview(request, env);
      if (pathname === "/api/security/drive-audit" && method === "GET") return await handleDriveAudit(request, env, getGoogleDriveAccessToken);
      if (pathname === "/api/security/drive-backup/manifest" && method === "GET") return await handleDriveBackupManifest(request, env);
      const driveBackupFileMatch = pathname.match(/^\/api\/security\/drive-backup\/files\/(\d+)$/);
      if (driveBackupFileMatch && method === "GET") return await handleDriveBackupFile(request, env, driveBackupFileMatch[1], getGoogleDriveAccessToken);

      if (pathname === "/api/overview" && method === "GET") return await handleOverview(request, env);

      if (pathname.startsWith("/api/")) {
        return jsonResponse({ error: "ไม่พบ endpoint นี้" }, 404);
      }
    } catch (err) {
      return jsonResponse({ error: "เกิดข้อผิดพลาดภายในระบบ" }, 500);
    }

    // ทุก path อื่นๆ ให้เสิร์ฟไฟล์หน้าเว็บจากโฟลเดอร์ public/ ตามปกติ
    return env.ASSETS.fetch(request);
  },
};
