"""Exercise the production directory SELECTs against sample records, without school data."""

import re
import sqlite3
import unittest
from pathlib import Path


SOURCE = (Path(__file__).resolve().parents[1] / "src" / "index.js").read_text()


def query_between(start, end):
    section = SOURCE.split(start, 1)[1].split(end, 1)[0]
    match = re.search(r"`(SELECT [\s\S]*?)`", section)
    if not match:
        raise AssertionError(f"No SQL SELECT after {start}")
    return match.group(1)


class DirectoryQueriesTest(unittest.TestCase):
    def setUp(self):
        self.db = sqlite3.connect(":memory:")
        self.db.row_factory = sqlite3.Row
        self.db.executescript("""
            CREATE TABLE students (id INTEGER, student_code TEXT, full_name TEXT,
                grade_level TEXT, classroom TEXT, status TEXT, national_id TEXT,
                health_conditions TEXT, allergies TEXT);
            CREATE TABLE student_enrollments (student_id INTEGER, academic_term_id INTEGER,
                academic_year_id INTEGER, grade_level TEXT, classroom TEXT, status TEXT);
            CREATE TABLE users (id INTEGER, email TEXT, role TEXT);
            CREATE TABLE personnel_records (id INTEGER, user_id INTEGER, full_name TEXT, first_name TEXT,
                position TEXT, subjects TEXT, phone TEXT, homeroom_classroom TEXT,
                license_issue_date TEXT, license_expiry_date TEXT, status TEXT,
                email TEXT, source_file TEXT, source_sheet TEXT, source_row INTEGER);
            INSERT INTO students VALUES (1, 'S01', 'ตัวอย่าง นักเรียน', 'ป.1', '1/1',
                'enrolled', '0000000000000', 'ข้อมูลสุขภาพ', 'แพ้อาหาร');
            INSERT INTO student_enrollments VALUES (1, 5, 3, 'ป.2', '2/1', 'enrolled');
            INSERT INTO users VALUES (2, 'private@example.invalid', 'teacher');
            INSERT INTO personnel_records VALUES (1, 2, 'ตัวอย่าง บุคลากร', 'ตัวอย่าง', 'ครู',
                'ภาษาไทย', '0000000000', '2/1', '2020-01-01', '2030-01-01',
                'active', 'private@example.invalid', 'import.xlsx', 'sheet', 12);
        """)

    def test_student_directory_returns_only_navigation_fields(self):
        query = query_between('} else {\n    ({ results } = await env.DB.prepare(', '\n    ).all());')
        row = self.db.execute(query).fetchone()
        self.assertEqual(set(row.keys()), {
            "id", "student_code", "full_name", "grade_level", "classroom", "status"
        })

    def test_term_directory_uses_term_class_and_excludes_private_details(self):
        query = query_between('if (Number.isInteger(termId) && termId > 0) {', '\n    ).bind(termId).all());')
        row = self.db.execute(query, (5,)).fetchone()
        self.assertEqual(row["grade_level"], "ป.2")
        self.assertEqual(row["classroom"], "2/1")
        self.assertEqual(set(row.keys()), {
            "id", "student_code", "full_name", "grade_level", "classroom", "status",
            "academic_year_id", "academic_term_id"
        })

    def test_staff_directory_excludes_import_provenance_and_email(self):
        query = query_between('async function handleListStaff(request, env)', '\n  ).all();')
        row = self.db.execute(query).fetchone()
        self.assertEqual(set(row.keys()), {
            "id", "user_id", "full_name", "role", "position", "subjects", "phone",
            "homeroom_classroom", "license_issue_date", "license_expiry_date"
        })


if __name__ == "__main__":
    unittest.main()
