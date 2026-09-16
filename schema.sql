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

-- ระบบจัดการงานและข้อมูลโรงเรียนบ้านป่าเด็ง
-- Schema: โมดูลจัดการงาน (มอบหมายงาน / ติดตามสถานะ)
-- ไฟล์นี้เขียนแบบ IF NOT EXISTS ทั้งหมด รันซ้ำกับฐานข้อมูลเดิมได้อย่างปลอดภัย
-- (ตารางที่มีอยู่แล้วจะไม่ถูกแตะต้อง มีแค่ตารางใหม่ที่จะถูกสร้างเพิ่ม)

CREATE TABLE IF NOT EXISTS tasks (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  title         TEXT NOT NULL,
  description   TEXT NOT NULL DEFAULT '',
  priority      TEXT NOT NULL DEFAULT 'normal' CHECK (priority IN ('low','normal','high','urgent')),
  due_date      TEXT,                                   -- รูปแบบ YYYY-MM-DD, ไม่บังคับ
  status        TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','closed')),
  created_by    INTEGER NOT NULL REFERENCES users(id),
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_tasks_created_by ON tasks(created_by);
CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);

-- ผู้รับผิดชอบของแต่ละงาน (งานหนึ่งมอบหมายได้หลายคน แต่ละคนมีสถานะของตัวเอง)
CREATE TABLE IF NOT EXISTS task_assignees (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id       INTEGER NOT NULL REFERENCES tasks(id),
  user_id       INTEGER NOT NULL REFERENCES users(id),
  status        TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','in_progress','done')),
  completed_at  TEXT,
  UNIQUE (task_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_task_assignees_task ON task_assignees(task_id);
CREATE INDEX IF NOT EXISTS idx_task_assignees_user ON task_assignees(user_id);
