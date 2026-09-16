const PERIOD_TABLES = ["tasks", "projects", "work_topics", "leave_requests"];

let initializationPromise;

function isoDate(year, month, day) {
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

export function getDefaultAcademicCalendar(now = new Date()) {
  const gregorianYear = now.getUTCFullYear();
  const academicStartYear = now.getUTCMonth() >= 4 ? gregorianYear : gregorianYear - 1;
  const yearBe = academicStartYear + 543;
  return {
    year_be: yearBe,
    label: `ปีการศึกษา ${yearBe}`,
    start_date: isoDate(academicStartYear, 5, 1),
    end_date: isoDate(academicStartYear + 1, 3, 31),
    terms: [
      {
        term_number: 1,
        name: "ภาคเรียนที่ 1",
        start_date: isoDate(academicStartYear, 5, 1),
        end_date: isoDate(academicStartYear, 10, 31),
        status: now.getUTCMonth() >= 4 && now.getUTCMonth() <= 9 ? "active" : "closed",
      },
      {
        term_number: 2,
        name: "ภาคเรียนที่ 2",
        start_date: isoDate(academicStartYear, 11, 1),
        end_date: isoDate(academicStartYear + 1, 3, 31),
        status: now.getUTCMonth() >= 10 || now.getUTCMonth() <= 3 ? "active" : "planned",
      },
    ],
  };
}

export function getCalendarForYear(yearBe) {
  const gregorianYear = Number(yearBe) - 543;
  return {
    year_be: Number(yearBe),
    label: `ปีการศึกษา ${yearBe}`,
    start_date: isoDate(gregorianYear, 5, 1),
    end_date: isoDate(gregorianYear + 1, 3, 31),
    terms: [
      { term_number: 1, name: "ภาคเรียนที่ 1", start_date: isoDate(gregorianYear, 5, 1), end_date: isoDate(gregorianYear, 10, 31) },
      { term_number: 2, name: "ภาคเรียนที่ 2", start_date: isoDate(gregorianYear, 11, 1), end_date: isoDate(gregorianYear + 1, 3, 31) },
    ],
  };
}

async function hasColumn(db, table, column) {
  const { results } = await db.prepare(`PRAGMA table_info(${table})`).all();
  return results.some((row) => row.name === column);
}

async function addPeriodColumns(db) {
  for (const table of PERIOD_TABLES) {
    if (!(await hasColumn(db, table, "academic_year_id"))) {
      await db.prepare(`ALTER TABLE ${table} ADD COLUMN academic_year_id INTEGER REFERENCES academic_years(id)`).run();
    }
    if (!(await hasColumn(db, table, "academic_term_id"))) {
      await db.prepare(`ALTER TABLE ${table} ADD COLUMN academic_term_id INTEGER REFERENCES academic_terms(id)`).run();
    }
    await db.prepare(`CREATE INDEX IF NOT EXISTS idx_${table}_academic_period ON ${table}(academic_year_id, academic_term_id)`).run();
  }

  // โครงการเดิมต้องรองรับยอดใช้จริงเพื่อคำนวณงบคงเหลือบนแดชบอร์ด
  if (!(await hasColumn(db, "projects", "spent_amount"))) {
    await db.prepare("ALTER TABLE projects ADD COLUMN spent_amount REAL NOT NULL DEFAULT 0").run();
  }
}

async function createCoreTables(db) {
  const statements = [
    `CREATE TABLE IF NOT EXISTS academic_years (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      year_be INTEGER NOT NULL UNIQUE CHECK (year_be BETWEEN 2500 AND 2700),
      label TEXT NOT NULL,
      start_date TEXT NOT NULL,
      end_date TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','active','closed')),
      notes TEXT,
      created_by INTEGER REFERENCES users(id),
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      CHECK (start_date <= end_date)
    )`,
    `CREATE TABLE IF NOT EXISTS academic_terms (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      academic_year_id INTEGER NOT NULL REFERENCES academic_years(id) ON DELETE CASCADE,
      term_number INTEGER NOT NULL CHECK (term_number BETWEEN 1 AND 3),
      name TEXT NOT NULL,
      start_date TEXT NOT NULL,
      end_date TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'planned' CHECK (status IN ('planned','active','closed')),
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE (academic_year_id, term_number),
      CHECK (start_date <= end_date)
    )`,
    `CREATE TABLE IF NOT EXISTS student_enrollments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      student_id INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
      academic_year_id INTEGER NOT NULL REFERENCES academic_years(id) ON DELETE CASCADE,
      academic_term_id INTEGER NOT NULL REFERENCES academic_terms(id) ON DELETE CASCADE,
      grade_level TEXT,
      classroom TEXT,
      status TEXT NOT NULL DEFAULT 'enrolled' CHECK (status IN ('enrolled','transferred','graduated','withdrawn')),
      promoted_from_id INTEGER REFERENCES student_enrollments(id),
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE (student_id, academic_term_id)
    )`,
    `CREATE TABLE IF NOT EXISTS academic_period_audit (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      action TEXT NOT NULL,
      academic_year_id INTEGER REFERENCES academic_years(id),
      academic_term_id INTEGER REFERENCES academic_terms(id),
      actor_user_id INTEGER REFERENCES users(id),
      details TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`,
    "CREATE UNIQUE INDEX IF NOT EXISTS idx_academic_year_single_active ON academic_years(status) WHERE status = 'active'",
    "CREATE UNIQUE INDEX IF NOT EXISTS idx_academic_term_single_active ON academic_terms(status) WHERE status = 'active'",
    "CREATE INDEX IF NOT EXISTS idx_academic_terms_year ON academic_terms(academic_year_id, term_number)",
    "CREATE INDEX IF NOT EXISTS idx_student_enrollments_period ON student_enrollments(academic_year_id, academic_term_id, classroom)",
    "CREATE INDEX IF NOT EXISTS idx_student_enrollments_student ON student_enrollments(student_id)",
    "CREATE INDEX IF NOT EXISTS idx_academic_audit_created ON academic_period_audit(created_at DESC)",
  ];
  for (const statement of statements) await db.prepare(statement).run();
}

async function seedInitialCalendar(db) {
  const existing = await db.prepare("SELECT COUNT(*) AS count FROM academic_years").first();
  if (Number(existing?.count || 0) > 0) return;

  const calendar = getDefaultAcademicCalendar();
  const yearResult = await db.prepare(
    `INSERT INTO academic_years (year_be, label, start_date, end_date, status, notes)
     VALUES (?, ?, ?, ?, 'active', 'สร้างอัตโนมัติเมื่อเริ่มใช้ระบบปีการศึกษา')`
  ).bind(calendar.year_be, calendar.label, calendar.start_date, calendar.end_date).run();
  const yearId = yearResult.meta.last_row_id;

  for (const term of calendar.terms) {
    await db.prepare(
      `INSERT INTO academic_terms (academic_year_id, term_number, name, start_date, end_date, status)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).bind(yearId, term.term_number, term.name, term.start_date, term.end_date, term.status).run();
  }
  await db.prepare(
    `INSERT INTO academic_period_audit (action, academic_year_id, details)
     VALUES ('initial_seed', ?, ?)`
  ).bind(yearId, JSON.stringify({ year_be: calendar.year_be })).run();
}

async function installPeriodTriggers(db) {
  for (const table of PERIOD_TABLES) {
    await db.prepare(`DROP TRIGGER IF EXISTS trg_${table}_academic_period`).run();
    await db.prepare(
      `CREATE TRIGGER trg_${table}_academic_period
       AFTER INSERT ON ${table}
       WHEN NEW.academic_year_id IS NULL OR NEW.academic_term_id IS NULL
       BEGIN
         UPDATE ${table}
         SET academic_year_id = COALESCE(NEW.academic_year_id, (SELECT id FROM academic_years WHERE status = 'active' LIMIT 1)),
             academic_term_id = COALESCE(NEW.academic_term_id, (SELECT id FROM academic_terms WHERE status = 'active' LIMIT 1))
         WHERE id = NEW.id;
       END`
    ).run();
  }

  await db.prepare("DROP TRIGGER IF EXISTS trg_students_active_enrollment_insert").run();
  await db.prepare(
    `CREATE TRIGGER trg_students_active_enrollment_insert
     AFTER INSERT ON students
     BEGIN
       INSERT INTO student_enrollments
         (student_id, academic_year_id, academic_term_id, grade_level, classroom, status)
       SELECT NEW.id, y.id, t.id, NEW.grade_level, NEW.classroom, NEW.status
       FROM academic_years y JOIN academic_terms t ON t.academic_year_id = y.id
       WHERE y.status = 'active' AND t.status = 'active'
       ON CONFLICT(student_id, academic_term_id) DO UPDATE SET
         grade_level = excluded.grade_level,
         classroom = excluded.classroom,
         status = excluded.status,
         updated_at = datetime('now');
     END`
  ).run();

  await db.prepare("DROP TRIGGER IF EXISTS trg_students_active_enrollment_update").run();
  await db.prepare(
    `CREATE TRIGGER trg_students_active_enrollment_update
     AFTER UPDATE OF grade_level, classroom, status ON students
     BEGIN
       INSERT INTO student_enrollments
         (student_id, academic_year_id, academic_term_id, grade_level, classroom, status)
       SELECT NEW.id, y.id, t.id, NEW.grade_level, NEW.classroom, NEW.status
       FROM academic_years y JOIN academic_terms t ON t.academic_year_id = y.id
       WHERE y.status = 'active' AND t.status = 'active'
       ON CONFLICT(student_id, academic_term_id) DO UPDATE SET
         grade_level = excluded.grade_level,
         classroom = excluded.classroom,
         status = excluded.status,
         updated_at = datetime('now');
     END`
  ).run();
}

async function backfillCurrentPeriod(db) {
  const current = await db.prepare(
    `SELECT y.id AS academic_year_id, t.id AS academic_term_id
     FROM academic_years y JOIN academic_terms t ON t.academic_year_id = y.id
     WHERE y.status = 'active' AND t.status = 'active' LIMIT 1`
  ).first();
  if (!current) return;

  for (const table of PERIOD_TABLES) {
    await db.prepare(
      `UPDATE ${table} SET academic_year_id = ?, academic_term_id = ?
       WHERE academic_year_id IS NULL OR academic_term_id IS NULL`
    ).bind(current.academic_year_id, current.academic_term_id).run();
  }

  await db.prepare(
    `INSERT INTO student_enrollments
       (student_id, academic_year_id, academic_term_id, grade_level, classroom, status)
     SELECT id, ?, ?, grade_level, classroom, status FROM students
     WHERE 1 = 1
     ON CONFLICT(student_id, academic_term_id) DO NOTHING`
  ).bind(current.academic_year_id, current.academic_term_id).run();
}

export async function ensureAcademicData(env) {
  if (!initializationPromise) {
    initializationPromise = (async () => {
      await createCoreTables(env.DB);
      await addPeriodColumns(env.DB);
      await seedInitialCalendar(env.DB);
      await installPeriodTriggers(env.DB);
      await backfillCurrentPeriod(env.DB);
    })().catch((error) => {
      initializationPromise = undefined;
      throw error;
    });
  }
  return initializationPromise;
}

export async function getCurrentAcademicPeriod(env) {
  await ensureAcademicData(env);
  return env.DB.prepare(
    `SELECT y.id AS academic_year_id, y.year_be, y.label AS academic_year_label,
            y.start_date AS academic_year_start_date, y.end_date AS academic_year_end_date,
            t.id AS academic_term_id, t.term_number, t.name AS academic_term_name,
            t.start_date AS academic_term_start_date, t.end_date AS academic_term_end_date
     FROM academic_years y
     LEFT JOIN academic_terms t ON t.academic_year_id = y.id AND t.status = 'active'
     WHERE y.status = 'active' LIMIT 1`
  ).first();
}
