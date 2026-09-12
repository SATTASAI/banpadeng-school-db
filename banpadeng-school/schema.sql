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
  budget_amount     REAL,
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
