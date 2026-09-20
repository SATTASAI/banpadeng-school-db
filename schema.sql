-- ระบบจัดการงานและข้อมูลโรงเรียนบ้านป่าเด็ง
-- Schema: ระบบพื้นฐาน (ผู้ใช้ / สิทธิ์การใช้งาน)
-- รันครั้งเดียวตอนสร้างฐานข้อมูลใหม่

CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  email         TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  password_salt TEXT NOT NULL,
  full_name     TEXT NOT NULL,
  -- role เป็น NULL จนกว่าแอดมินจะกำหนดสิทธิ์ให้
  role          TEXT CHECK (role IN ('teacher','executive','staff','superadmin') OR role IS NULL),
  status        TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','disabled')),
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  approved_at   TEXT,
  approved_by   INTEGER REFERENCES users(id)
);

CREATE INDEX IF NOT EXISTS idx_users_role ON users(role);

-- Schema: โมดูลจัดการงาน (มอบหมายงาน/ติดตามสถานะ)

CREATE TABLE IF NOT EXISTS tasks (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  title         TEXT NOT NULL,
  description   TEXT,
  priority      TEXT NOT NULL DEFAULT 'normal' CHECK (priority IN ('low','normal','high')),
  due_date      TEXT,
  status        TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','closed')),
  created_by    INTEGER NOT NULL REFERENCES users(id),
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS task_assignees (
  task_id  INTEGER NOT NULL REFERENCES tasks(id),
  user_id  INTEGER NOT NULL REFERENCES users(id),
  status   TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','in_progress','done')),
  PRIMARY KEY (task_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_task_assignees_user ON task_assignees(user_id);
CREATE INDEX IF NOT EXISTS idx_tasks_created_by ON tasks(created_by);

-- Schema: โมดูลข้อมูลนักเรียน (ไม่รวมเกรด/ปพ. และไม่รวมเช็คชื่อ — ใช้ Q-info)

CREATE TABLE IF NOT EXISTS students (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  student_code       TEXT NOT NULL UNIQUE,
  full_name          TEXT NOT NULL,
  classroom          TEXT,
  grade_level        TEXT,
  photo_url          TEXT,
  health_conditions  TEXT,
  allergies          TEXT,
  status             TEXT NOT NULL DEFAULT 'enrolled' CHECK (status IN ('enrolled','transferred','graduated','withdrawn')),
  created_at         TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS guardians (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  student_id            INTEGER NOT NULL REFERENCES students(id),
  full_name             TEXT NOT NULL,
  relationship          TEXT,
  phone                 TEXT,
  is_emergency_contact  INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_guardians_student ON guardians(student_id);
CREATE INDEX IF NOT EXISTS idx_students_classroom ON students(classroom);

-- งานวิเคราะห์ผู้เรียนรายบุคคล: ครูหนึ่งคนบันทึกหนึ่งฉบับต่อคนต่อภาคเรียน
-- สำหรับฐานข้อมูลเดิม route จะสร้างตารางนี้เมื่อเริ่มใช้งาน
CREATE TABLE IF NOT EXISTS learner_analyses (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  student_id INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  academic_year_id INTEGER NOT NULL REFERENCES academic_years(id),
  academic_term_id INTEGER NOT NULL REFERENCES academic_terms(id),
  teacher_user_id INTEGER NOT NULL REFERENCES users(id),
  assessment_date TEXT,
  reading_result TEXT, reading_evidence TEXT,
  writing_result TEXT, writing_evidence TEXT,
  thinking_result TEXT, thinking_evidence TEXT,
  participation_result TEXT, participation_evidence TEXT,
  strengths TEXT, needs TEXT, support_plan TEXT,
  followup_date TEXT, followup_result TEXT, followup_next TEXT,
  learner_interests TEXT, learner_learning_style TEXT, learner_expectations TEXT,
  learner_message TEXT, family_context TEXT, learner_group TEXT,
  knowledge_result TEXT, knowledge_evidence TEXT,
  intellectual_result TEXT, intellectual_evidence TEXT,
  behavior_result TEXT, behavior_evidence TEXT,
  physical_result TEXT, physical_evidence TEXT,
  social_result TEXT, social_evidence TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(student_id,academic_term_id,teacher_user_id)
);
CREATE INDEX IF NOT EXISTS idx_learner_analyses_period_teacher ON learner_analyses(academic_term_id,teacher_user_id,student_id);

-- มอบหมายครูผู้จัดทำงานวิเคราะห์ตามภาคเรียน ระดับชั้น และห้อง (รองรับหลายคนต่อห้อง)
CREATE TABLE IF NOT EXISTS learner_class_assignments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  academic_term_id INTEGER NOT NULL REFERENCES academic_terms(id) ON DELETE CASCADE,
  grade_level TEXT NOT NULL,
  classroom TEXT NOT NULL,
  teacher_user_id INTEGER NOT NULL REFERENCES users(id),
  assigned_by INTEGER NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (academic_term_id, grade_level, classroom, teacher_user_id)
);
CREATE INDEX IF NOT EXISTS idx_learner_class_assignments_teacher
  ON learner_class_assignments(teacher_user_id,academic_term_id,grade_level,classroom);

-- ข้อมูลนักเรียนเพิ่มเติมจาก DMC แยกตารางเพื่ออัปเดตระบบเดิมได้โดยไม่กระทบทะเบียนหลัก
CREATE TABLE IF NOT EXISTS student_details (
  student_id             INTEGER PRIMARY KEY REFERENCES students(id) ON DELETE CASCADE,
  weight_kg              REAL,
  height_cm              REAL,
  blood_type             TEXT,
  religion               TEXT,
  ethnicity              TEXT,
  nationality            TEXT,
  house_number           TEXT,
  village_no             TEXT,
  road_soi               TEXT,
  subdistrict            TEXT,
  district               TEXT,
  province               TEXT,
  guardian_prefix        TEXT,
  guardian_first_name    TEXT,
  guardian_last_name     TEXT,
  guardian_occupation    TEXT,
  guardian_relationship  TEXT,
  father_prefix          TEXT,
  father_first_name      TEXT,
  father_last_name       TEXT,
  father_occupation      TEXT,
  mother_prefix          TEXT,
  mother_first_name      TEXT,
  mother_last_name       TEXT,
  mother_occupation      TEXT,
  disadvantage           TEXT,
  updated_at             TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Schema: รื้อระบบข้อมูลนักเรียน — เพิ่มเลขบัตรประชาชน, แยกชื่อเป็นคำนำหน้า/ชื่อ/นามสกุล, วันเกิด

ALTER TABLE students ADD COLUMN national_id TEXT;
ALTER TABLE students ADD COLUMN name_prefix TEXT;
ALTER TABLE students ADD COLUMN first_name TEXT;
ALTER TABLE students ADD COLUMN last_name TEXT;
ALTER TABLE students ADD COLUMN birth_date TEXT;

-- Schema: โมดูลข้อมูลครู/บุคลากร (ต่อยอดจากบัญชีผู้ใช้ที่มีอยู่แล้ว)

CREATE TABLE IF NOT EXISTS staff_profiles (
  user_id             INTEGER PRIMARY KEY REFERENCES users(id),
  position            TEXT,
  subjects            TEXT,
  phone               TEXT,
  homeroom_classroom  TEXT
);

-- Schema: โมดูล 4 ฝ่ายงาน (โครงการ + งบประมาณ + หัวข้องาน)
-- ฝ่าย: academic (วิชาการ), budget (งบประมาณ), personnel (บุคคล), general (บริหารทั่วไป)

CREATE TABLE IF NOT EXISTS projects (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  department        TEXT NOT NULL CHECK (department IN ('academic','budget','personnel','general')),
  name              TEXT NOT NULL,
  budget_amount     REAL NOT NULL DEFAULT 0 CHECK (budget_amount >= 0),
  spent_amount      REAL NOT NULL DEFAULT 0 CHECK (spent_amount >= 0),
  progress_percent  INTEGER NOT NULL DEFAULT 0 CHECK (progress_percent BETWEEN 0 AND 100),
  status            TEXT NOT NULL DEFAULT 'ongoing' CHECK (status IN ('ongoing','completed','cancelled')),
  description       TEXT,
  created_by        INTEGER NOT NULL REFERENCES users(id),
  created_at        TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS project_owners (
  project_id  INTEGER NOT NULL REFERENCES projects(id),
  user_id     INTEGER NOT NULL REFERENCES users(id),
  PRIMARY KEY (project_id, user_id)
);

-- ทะเบียนขอเบิก/เบิกจ่ายรายโครงการ
-- ยอดใช้จริงบน projects จะรวมเฉพาะรายการสถานะ paid ผ่าน trigger ด้านล่าง
CREATE TABLE IF NOT EXISTS project_expenses (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id    INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  expense_date  TEXT NOT NULL,
  document_no   TEXT,
  category      TEXT NOT NULL DEFAULT 'other',
  description   TEXT NOT NULL,
  payee         TEXT,
  amount        REAL NOT NULL CHECK (amount > 0),
  status        TEXT NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('draft','pending','approved','paid','rejected','cancelled')),
  attachment_url TEXT,
  notes         TEXT,
  created_by    INTEGER NOT NULL REFERENCES users(id),
  approved_by   INTEGER REFERENCES users(id),
  approved_at   TEXT,
  paid_at       TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS work_topics (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  department    TEXT NOT NULL CHECK (department IN ('academic','budget','personnel','general')),
  title         TEXT NOT NULL,
  description   TEXT,
  created_by    INTEGER NOT NULL REFERENCES users(id),
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_projects_department ON projects(department);
CREATE INDEX IF NOT EXISTS idx_work_topics_department ON work_topics(department);
CREATE INDEX IF NOT EXISTS idx_project_owners_user ON project_owners(user_id);
CREATE INDEX IF NOT EXISTS idx_project_expenses_project ON project_expenses(project_id, expense_date DESC);
CREATE INDEX IF NOT EXISTS idx_project_expenses_status ON project_expenses(status, expense_date DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_project_expenses_opening
  ON project_expenses(project_id) WHERE category = 'opening_balance';

CREATE TRIGGER IF NOT EXISTS trg_project_expenses_insert
AFTER INSERT ON project_expenses
BEGIN
  UPDATE projects
  SET spent_amount = COALESCE((
    SELECT SUM(amount) FROM project_expenses
    WHERE project_id = NEW.project_id AND status = 'paid'
  ), 0)
  WHERE id = NEW.project_id;
END;

CREATE TRIGGER IF NOT EXISTS trg_project_expenses_update
AFTER UPDATE ON project_expenses
BEGIN
  UPDATE projects
  SET spent_amount = COALESCE((
    SELECT SUM(amount) FROM project_expenses
    WHERE project_id = OLD.project_id AND status = 'paid'
  ), 0)
  WHERE id = OLD.project_id;
  UPDATE projects
  SET spent_amount = COALESCE((
    SELECT SUM(amount) FROM project_expenses
    WHERE project_id = NEW.project_id AND status = 'paid'
  ), 0)
  WHERE id = NEW.project_id;
END;

CREATE TRIGGER IF NOT EXISTS trg_project_expenses_delete
AFTER DELETE ON project_expenses
BEGIN
  UPDATE projects
  SET spent_amount = COALESCE((
    SELECT SUM(amount) FROM project_expenses
    WHERE project_id = OLD.project_id AND status = 'paid'
  ), 0)
  WHERE id = OLD.project_id;
END;

-- Schema: โมดูลวันลา (ขอลา/อนุมัติ) + วันหมดอายุใบประกอบวิชาชีพ

ALTER TABLE staff_profiles ADD COLUMN license_expiry_date TEXT;

CREATE TABLE IF NOT EXISTS leave_requests (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id       INTEGER NOT NULL REFERENCES users(id),
  leave_type    TEXT NOT NULL CHECK (leave_type IN ('sick','personal','maternity','other')),
  reason        TEXT,
  start_date    TEXT NOT NULL,
  end_date      TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
  approved_by   INTEGER REFERENCES users(id),
  approved_at   TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_leave_requests_user ON leave_requests(user_id);
CREATE INDEX IF NOT EXISTS idx_leave_requests_status ON leave_requests(status);

-- Schema: ทะเบียนบุคลากรและใบประกอบวิชาชีพ แยกจากบัญชีเข้าสู่ระบบ

CREATE TABLE IF NOT EXISTS personnel_records (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id               INTEGER UNIQUE REFERENCES users(id),
  prefix                TEXT,
  first_name            TEXT,
  last_name             TEXT,
  full_name             TEXT NOT NULL,
  normalized_name       TEXT NOT NULL UNIQUE,
  email                 TEXT,
  position              TEXT,
  subjects              TEXT,
  phone                 TEXT,
  homeroom_classroom    TEXT,
  departments           TEXT,
  responsible_projects  TEXT,
  teaching_periods      INTEGER,
  license_issue_date    TEXT,
  license_expiry_date   TEXT,
  license_issue_raw     TEXT,
  license_expiry_raw    TEXT,
  status                TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','inactive')),
  source_file           TEXT,
  source_sheet          TEXT,
  source_row            INTEGER,
  created_at            TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at            TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS personnel_imports (
  import_key    TEXT PRIMARY KEY,
  source_file   TEXT NOT NULL,
  record_count  INTEGER NOT NULL,
  imported_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_personnel_status ON personnel_records(status);
CREATE INDEX IF NOT EXISTS idx_personnel_license_expiry ON personnel_records(license_expiry_date);

-- Schema: ระบบปีการศึกษา/ภาคเรียนกลาง

CREATE TABLE IF NOT EXISTS academic_years (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  year_be     INTEGER NOT NULL UNIQUE CHECK (year_be BETWEEN 2500 AND 2700),
  label       TEXT NOT NULL,
  start_date  TEXT NOT NULL,
  end_date    TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','active','closed')),
  notes       TEXT,
  created_by  INTEGER REFERENCES users(id),
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT NOT NULL DEFAULT (datetime('now')),
  CHECK (start_date <= end_date)
);

CREATE TABLE IF NOT EXISTS academic_terms (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  academic_year_id  INTEGER NOT NULL REFERENCES academic_years(id) ON DELETE CASCADE,
  term_number       INTEGER NOT NULL CHECK (term_number BETWEEN 1 AND 3),
  name              TEXT NOT NULL,
  start_date        TEXT NOT NULL,
  end_date          TEXT NOT NULL,
  status            TEXT NOT NULL DEFAULT 'planned' CHECK (status IN ('planned','active','closed')),
  created_at        TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at        TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (academic_year_id, term_number),
  CHECK (start_date <= end_date)
);

CREATE TABLE IF NOT EXISTS student_enrollments (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  student_id        INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  academic_year_id  INTEGER NOT NULL REFERENCES academic_years(id) ON DELETE CASCADE,
  academic_term_id  INTEGER NOT NULL REFERENCES academic_terms(id) ON DELETE CASCADE,
  grade_level       TEXT,
  classroom         TEXT,
  status            TEXT NOT NULL DEFAULT 'enrolled' CHECK (status IN ('enrolled','transferred','graduated','withdrawn')),
  promoted_from_id  INTEGER REFERENCES student_enrollments(id),
  created_at        TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at        TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (student_id, academic_term_id)
);

CREATE TABLE IF NOT EXISTS academic_period_audit (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  action            TEXT NOT NULL,
  academic_year_id  INTEGER REFERENCES academic_years(id),
  academic_term_id  INTEGER REFERENCES academic_terms(id),
  actor_user_id     INTEGER REFERENCES users(id),
  details           TEXT,
  created_at        TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_academic_year_single_active
  ON academic_years(status) WHERE status = 'active';
CREATE UNIQUE INDEX IF NOT EXISTS idx_academic_term_single_active
  ON academic_terms(status) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS idx_academic_terms_year ON academic_terms(academic_year_id, term_number);
CREATE INDEX IF NOT EXISTS idx_student_enrollments_period
  ON student_enrollments(academic_year_id, academic_term_id, classroom);
CREATE INDEX IF NOT EXISTS idx_academic_audit_created ON academic_period_audit(created_at DESC);

-- ระบบดูแลช่วยเหลือนักเรียน
CREATE TABLE IF NOT EXISTS student_support_cases (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  student_id INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  case_type TEXT NOT NULL CHECK (case_type IN ('screening','home_visit','scholarship','risk','behavior','assistance','referral')),
  risk_level TEXT NOT NULL DEFAULT 'normal' CHECK (risk_level IN ('normal','watch','high','urgent')),
  summary TEXT NOT NULL,
  action_taken TEXT,
  follow_up_date TEXT,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','monitoring','closed')),
  referred_to TEXT,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_support_student ON student_support_cases(student_id);
CREATE INDEX IF NOT EXISTS idx_support_status ON student_support_cases(status, risk_level);

-- ทะเบียนเอกสาร (ไฟล์จริงสามารถผูกกับ R2/Storage ภายหลัง)
CREATE TABLE IF NOT EXISTS documents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  department TEXT NOT NULL CHECK (department IN ('academic','budget','personnel','general','student-support','admin')),
  academic_year_id INTEGER REFERENCES academic_years(id),
  project_id INTEGER REFERENCES projects(id),
  document_type TEXT,
  keywords TEXT,
  file_name TEXT,
  file_url TEXT,
  mime_type TEXT,
  file_size INTEGER,
  version INTEGER NOT NULL DEFAULT 1,
  access_level TEXT NOT NULL DEFAULT 'staff' CHECK (access_level IN ('private','staff','admin')),
  uploaded_by INTEGER REFERENCES users(id),
  record_status TEXT NOT NULL DEFAULT 'active' CHECK (record_status IN ('active','archived','duplicate')),
  duplicate_of_id INTEGER REFERENCES documents(id),
  archived_at TEXT,
  archive_reason TEXT,
  upload_status TEXT NOT NULL DEFAULT 'none' CHECK (upload_status IN ('none','uploading','success','failed')),
  upload_error TEXT,
  attachment_updated_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_documents_department ON documents(department, academic_year_id);
CREATE INDEX IF NOT EXISTS idx_documents_search ON documents(title, keywords);
CREATE INDEX IF NOT EXISTS idx_documents_record_status ON documents(record_status, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_documents_duplicate ON documents(duplicate_of_id);

-- ระบบพัสดุและครุภัณฑ์
CREATE TABLE IF NOT EXISTS inventory_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  item_code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  item_type TEXT NOT NULL CHECK (item_type IN ('material','equipment')),
  category TEXT,
  unit TEXT NOT NULL DEFAULT 'ชิ้น',
  department TEXT NOT NULL DEFAULT 'budget'
    CHECK (department IN ('academic','budget','personnel','general')),
  location TEXT,
  custodian TEXT,
  current_quantity REAL NOT NULL DEFAULT 0 CHECK (current_quantity >= 0),
  minimum_quantity REAL NOT NULL DEFAULT 0 CHECK (minimum_quantity >= 0),
  unit_price REAL NOT NULL DEFAULT 0 CHECK (unit_price >= 0),
  brand_model TEXT,
  serial_number TEXT,
  purchase_date TEXT,
  fiscal_year TEXT,
  budget_source TEXT,
  vendor TEXT,
  warranty_expiry TEXT,
  item_condition TEXT NOT NULL DEFAULT 'good'
    CHECK (item_condition IN ('good','fair','damaged','lost')),
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active','repair','disposed','lost')),
  notes TEXT,
  created_by INTEGER NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS inventory_transactions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id INTEGER NOT NULL REFERENCES inventory_items(id) ON DELETE CASCADE,
  transaction_type TEXT NOT NULL
    CHECK (transaction_type IN ('opening','receive','issue','borrow','return','transfer','adjust_in','adjust_out','repair','dispose')),
  transaction_date TEXT NOT NULL,
  document_no TEXT,
  quantity REAL NOT NULL CHECK (quantity > 0),
  quantity_change REAL NOT NULL,
  related_transaction_id INTEGER REFERENCES inventory_transactions(id),
  unit_price REAL,
  from_location TEXT,
  to_location TEXT,
  recipient TEXT,
  due_date TEXT,
  notes TEXT,
  created_by INTEGER NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS inventory_inspections (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id INTEGER NOT NULL REFERENCES inventory_items(id) ON DELETE CASCADE,
  inspection_date TEXT NOT NULL,
  quantity_found REAL NOT NULL CHECK (quantity_found >= 0),
  item_condition TEXT NOT NULL CHECK (item_condition IN ('good','fair','damaged','lost')),
  result TEXT NOT NULL CHECK (result IN ('matched','shortage','surplus','damaged')),
  location TEXT,
  inspector TEXT,
  notes TEXT,
  next_inspection_date TEXT,
  created_by INTEGER NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ไฟล์แนบเก็บจริงใน Google Drive (รองรับ R2 เดิมเพื่อย้ายระบบแบบไม่สะดุด)
CREATE TABLE IF NOT EXISTS file_attachments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  entity_type TEXT NOT NULL CHECK (entity_type IN ('document','inventory_transaction','inventory_inspection','maintenance_request','maintenance_update','maintenance_before','maintenance_after')),
  entity_id INTEGER NOT NULL,
  object_key TEXT NOT NULL UNIQUE,
  file_name TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  file_size INTEGER NOT NULL,
  uploaded_by INTEGER NOT NULL REFERENCES users(id),
  storage_provider TEXT NOT NULL DEFAULT 'r2' CHECK (storage_provider IN ('r2','drive')),
  drive_file_id TEXT,
  drive_web_url TEXT,
  storage_error TEXT,
  file_hash TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(entity_type, entity_id)
);

CREATE INDEX IF NOT EXISTS idx_inventory_items_type ON inventory_items(item_type, status);
CREATE INDEX IF NOT EXISTS idx_inventory_items_department ON inventory_items(department, location);
CREATE INDEX IF NOT EXISTS idx_inventory_transactions_item ON inventory_transactions(item_id, transaction_date DESC);
CREATE INDEX IF NOT EXISTS idx_inventory_inspections_item ON inventory_inspections(item_id, inspection_date DESC);
CREATE INDEX IF NOT EXISTS idx_file_attachments_entity ON file_attachments(entity_type, entity_id);
CREATE INDEX IF NOT EXISTS idx_file_attachments_hash ON file_attachments(file_hash);

CREATE TRIGGER IF NOT EXISTS trg_inventory_transaction_before_insert
BEFORE INSERT ON inventory_transactions
WHEN NEW.quantity_change < 0
 AND COALESCE((SELECT current_quantity FROM inventory_items WHERE id = NEW.item_id), 0) + NEW.quantity_change < 0
BEGIN
  SELECT RAISE(ABORT, 'INSUFFICIENT_INVENTORY');
END;

CREATE TRIGGER IF NOT EXISTS trg_inventory_transaction_after_insert
AFTER INSERT ON inventory_transactions
BEGIN
  UPDATE inventory_items
  SET current_quantity = current_quantity + NEW.quantity_change,
      unit_price = CASE WHEN NEW.unit_price IS NOT NULL AND NEW.unit_price >= 0 THEN NEW.unit_price ELSE unit_price END,
      updated_at = datetime('now')
  WHERE id = NEW.item_id;
END;

-- อาคาร สถานที่ และระบบแจ้งซ่อม
CREATE TABLE IF NOT EXISTS facilities (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  facility_code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  facility_type TEXT NOT NULL
    CHECK (facility_type IN ('building','classroom','office','restroom','utility','grounds','other')),
  building_name TEXT,
  floor TEXT,
  location_detail TEXT,
  responsible_person TEXT,
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active','maintenance','closed')),
  notes TEXT,
  created_by INTEGER NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS maintenance_counters (
  buddhist_year INTEGER PRIMARY KEY,
  last_number INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS maintenance_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  request_no TEXT NOT NULL UNIQUE,
  facility_id INTEGER REFERENCES facilities(id),
  inventory_item_id INTEGER REFERENCES inventory_items(id),
  custom_location TEXT,
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  category TEXT NOT NULL
    CHECK (category IN ('electrical','plumbing','building','equipment','it','sanitation','grounds','other')),
  priority TEXT NOT NULL DEFAULT 'normal'
    CHECK (priority IN ('low','normal','high','urgent')),
  status TEXT NOT NULL DEFAULT 'reported'
    CHECK (status IN ('reported','assigned','in_progress','waiting_parts','completed','verified','cancelled')),
  reported_by INTEGER NOT NULL REFERENCES users(id),
  assigned_to INTEGER REFERENCES users(id),
  due_date TEXT,
  estimated_cost REAL NOT NULL DEFAULT 0 CHECK (estimated_cost >= 0),
  actual_cost REAL NOT NULL DEFAULT 0 CHECK (actual_cost >= 0),
  resolution TEXT,
  started_at TEXT,
  completed_at TEXT,
  verified_by INTEGER REFERENCES users(id),
  verified_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS maintenance_updates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  request_id INTEGER NOT NULL REFERENCES maintenance_requests(id) ON DELETE CASCADE,
  previous_status TEXT,
  new_status TEXT,
  comment TEXT,
  cost_amount REAL NOT NULL DEFAULT 0 CHECK (cost_amount >= 0),
  created_by INTEGER NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS maintenance_notifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  request_id INTEGER NOT NULL REFERENCES maintenance_requests(id) ON DELETE CASCADE,
  channel TEXT NOT NULL DEFAULT 'line',
  event_type TEXT NOT NULL,
  delivery_status TEXT NOT NULL,
  error_message TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_facilities_status ON facilities(status, facility_type);
CREATE INDEX IF NOT EXISTS idx_maintenance_status ON maintenance_requests(status, priority, due_date);
CREATE INDEX IF NOT EXISTS idx_maintenance_facility ON maintenance_requests(facility_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_maintenance_assigned ON maintenance_requests(assigned_to, status);
CREATE INDEX IF NOT EXISTS idx_maintenance_updates_request ON maintenance_updates(request_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_maintenance_notifications_request ON maintenance_notifications(request_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_maintenance_notifications_dedup ON maintenance_notifications(request_id, event_type, delivery_status, created_at DESC);

-- LINE Messaging API: ปลายทางที่ตรวจพบจาก Webhook และประวัติรับเหตุการณ์แบบไม่เก็บข้อความสนทนา
CREATE TABLE IF NOT EXISTS line_targets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  target_type TEXT NOT NULL CHECK (target_type IN ('user','group','room')),
  target_id TEXT NOT NULL UNIQUE,
  display_name TEXT,
  source_user_id TEXT,
  status TEXT NOT NULL DEFAULT 'detected'
    CHECK (status IN ('detected','active','disabled')),
  is_default INTEGER NOT NULL DEFAULT 0 CHECK (is_default IN (0,1)),
  first_seen_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_seen_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_event_type TEXT,
  selected_by INTEGER REFERENCES users(id),
  selected_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS line_webhook_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  webhook_event_id TEXT UNIQUE,
  target_id TEXT,
  source_type TEXT,
  event_type TEXT NOT NULL,
  received_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_line_targets_default ON line_targets(is_default, status);
CREATE INDEX IF NOT EXISTS idx_line_targets_last_seen ON line_targets(last_seen_at DESC);
CREATE INDEX IF NOT EXISTS idx_line_webhook_events_received ON line_webhook_events(received_at DESC);

-- ศูนย์ปฏิบัติงานกลางสำหรับหัวข้องานที่ยังไม่มีระบบเฉพาะ
CREATE TABLE IF NOT EXISTS work_records (
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
  status TEXT NOT NULL DEFAULT 'planned'
    CHECK (status IN ('planned','in_progress','waiting','completed','cancelled')),
  priority TEXT NOT NULL DEFAULT 'normal'
    CHECK (priority IN ('low','normal','high','urgent')),
  progress_percent INTEGER NOT NULL DEFAULT 0 CHECK (progress_percent BETWEEN 0 AND 100),
  notes TEXT,
  created_by INTEGER NOT NULL REFERENCES users(id),
  updated_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  CHECK (start_date IS NULL OR due_date IS NULL OR start_date <= due_date)
);

CREATE TABLE IF NOT EXISTS work_record_updates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  work_record_id INTEGER NOT NULL REFERENCES work_records(id) ON DELETE CASCADE,
  previous_status TEXT,
  new_status TEXT,
  progress_percent INTEGER,
  comment TEXT,
  created_by INTEGER NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_work_records_area_topic ON work_records(area, topic_key, status, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_work_records_period ON work_records(academic_year_id, academic_term_id);
CREATE INDEX IF NOT EXISTS idx_work_records_responsible ON work_records(responsible_user_id, status, due_date);
CREATE INDEX IF NOT EXISTS idx_work_record_updates_record ON work_record_updates(work_record_id, created_at DESC);

-- ประวัติการดำเนินการกลางและทะเบียนสำรองข้อมูล
CREATE TABLE IF NOT EXISTS audit_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER REFERENCES users(id),
  action TEXT NOT NULL,
  resource TEXT NOT NULL,
  resource_id INTEGER,
  details TEXT,
  ip_address TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_audit_logs_created ON audit_logs(created_at DESC);
CREATE TABLE IF NOT EXISTS backup_registry (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  backup_type TEXT NOT NULL DEFAULT 'export',
  file_name TEXT NOT NULL,
  table_count INTEGER,
  row_count INTEGER,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ฐานข้อมูลเดิมจะเพิ่ม 2 คอลัมน์นี้ด้วย runtime migration ใน src/lib/academic-data.js
-- เพื่อให้รันซ้ำได้อย่างปลอดภัย: tasks, projects, work_topics และ leave_requests
