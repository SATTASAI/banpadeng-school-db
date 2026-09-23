import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { ensurePersonnelColumns } from '../src/lib/personnel-data.js';
import { importStaffRows } from '../src/lib/staff-import.js';

function makeDb() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(`CREATE TABLE users (id INTEGER PRIMARY KEY, email TEXT, full_name TEXT, status TEXT, role TEXT);
    CREATE TABLE personnel_records (
      id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER UNIQUE,
      full_name TEXT NOT NULL, normalized_name TEXT NOT NULL UNIQUE, email TEXT,
      position TEXT, subjects TEXT, phone TEXT, homeroom_classroom TEXT,
      license_expiry_date TEXT, status TEXT DEFAULT 'active', source_file TEXT,
      updated_at TEXT
    );`);
  const DB = {
    prepare(sql) {
      const statement = sqlite.prepare(sql);
      let args = [];
      return {
        bind(...values) { args = values; return this; },
        first() { return statement.get(...args) || null; },
        run() { return statement.run(...args); },
        all() { return { results: statement.all(...args) }; },
      };
    },
  };
  return { sqlite, DB };
}

test('migrates existing personnel table and imports the expanded personnel template', async () => {
  const { sqlite, DB } = makeDb();
  await ensurePersonnelColumns({ DB });
  await ensurePersonnelColumns({ DB });
  sqlite.prepare('INSERT INTO users VALUES (1, ?, ?, ?, ?)')
    .run('teacher@example.ac.th', 'นางสาว วรรณมาศ จันทร์ชัง', 'active', 'teacher');
  sqlite.prepare('INSERT INTO personnel_records (full_name, normalized_name, license_expiry_date) VALUES (?, ?, ?)')
    .run('นางสาว วรรณมาศ จันทร์ชัง', 'นางสาววรรณมาศจันทร์ชัง', '2027-05-09');

  const row = {
    full_name: 'นางสาว วรรณมาศ จันทร์ชัง', email: 'Teacher@example.ac.th',
    phone: '0812345678', homeroom_classroom: 'ป.4/1', departments: 'วิชาการ; บุคคล',
    responsible_projects: 'โครงการอ่านออกเขียนได้; โครงการห้องสมุด',
    teaching_periods: '18', subjects: 'ภาษาไทย; สังคมศึกษา', personnel_type: 'teacher',
    position_number: '12345', academic_rank: 'ครูชำนาญการ', appointment_date: '2018-05-01',
    service_start_date: '2018-05-01', education_level: 'ปริญญาโท', major: 'ภาษาไทย',
    institution: 'มหาวิทยาลัยตัวอย่าง', employment_status: 'working', license_issue_date: '2022-05-10',
  };
  assert.deepEqual(await importStaffRows({ DB }, [row]), { created: 0, updated: 1, skipped: [] });
  const stored = sqlite.prepare('SELECT * FROM personnel_records WHERE user_id = 1').get();
  assert.equal(stored.email, 'teacher@example.ac.th');
  assert.equal(stored.phone, '0812345678');
  assert.equal(stored.homeroom_classroom, 'ป.4/1');
  assert.equal(stored.departments, 'วิชาการ; บุคคล');
  assert.equal(stored.responsible_projects, 'โครงการอ่านออกเขียนได้; โครงการห้องสมุด');
  assert.equal(stored.teaching_periods, 18);
  assert.equal(stored.subjects, 'ภาษาไทย; สังคมศึกษา');
  assert.equal(stored.personnel_type, 'teacher');
  assert.equal(stored.position_number, '12345');
  assert.equal(stored.academic_rank, 'ครูชำนาญการ');
  assert.equal(stored.education_level, 'ปริญญาโท');
  assert.equal(stored.license_issue_date, '2022-05-10');
  assert.equal(stored.license_expiry_date, '2027-05-09');

  const again = await importStaffRows({ DB }, [row]);
  assert.equal(again.updated, 1);
  assert.equal(sqlite.prepare('SELECT count(*) AS n FROM personnel_records').get().n, 1);
  sqlite.close();
});

test('creates directory-only teacher and rejects conflicting and duplicate identities', async () => {
  const { sqlite, DB } = makeDb();
  await ensurePersonnelColumns({ DB });
  const newTeacher = { full_name: 'นาย ตัวอย่าง ทดสอบ', email: 'new@example.ac.th', teaching_periods: 0 };
  const result = await importStaffRows({ DB }, [newTeacher, newTeacher]);
  assert.equal(result.created, 1);
  assert.match(result.skipped[0].reason, /ซ้ำ/);
  assert.equal(sqlite.prepare('SELECT user_id FROM personnel_records WHERE email = ?').get('new@example.ac.th').user_id, null);
  const changedName = await importStaffRows({ DB }, [{ ...newTeacher, full_name: 'นาย คนละคน' }]);
  assert.equal(changedName.updated, 0);
  assert.match(changedName.skipped[0].reason, /ขัด/);
  const invalid = await importStaffRows({ DB }, [{ ...newTeacher, email: 'bad' }, { ...newTeacher, teaching_periods: '1.5' }]);
  assert.equal(invalid.skipped.length, 2);
  sqlite.close();
});
