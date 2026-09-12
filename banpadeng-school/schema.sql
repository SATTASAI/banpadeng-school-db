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
