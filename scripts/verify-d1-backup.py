#!/usr/bin/env python3
"""Restore a D1 SQL export into a disposable SQLite database and validate it.

Usage: python3 scripts/verify-d1-backup.py backup.sql [--expected-counts counts.json]
The report includes table names and counts only; it never prints row contents.
"""

import argparse
import json
import sqlite3
import sys
import tempfile
from pathlib import Path


def quote_identifier(name):
    return '"' + name.replace('"', '""') + '"'


def verify(sql_path, expected_counts=None):
    if not sql_path.is_file() or sql_path.stat().st_size == 0:
        raise ValueError("ไฟล์ SQL ไม่มีข้อมูลหรือไม่พบไฟล์")
    with tempfile.TemporaryDirectory(prefix="banpadeng-d1-check-") as directory:
        database = Path(directory) / "restore.sqlite"
        connection = sqlite3.connect(database)
        try:
            # A backup must never attach or write into an existing database.
            def authorize(action, arg1, arg2, database_name, source):
                if action in (sqlite3.SQLITE_ATTACH, sqlite3.SQLITE_DETACH):
                    return sqlite3.SQLITE_DENY
                if action == sqlite3.SQLITE_PRAGMA and arg1 and arg1.lower() in ("writable_schema", "trusted_schema"):
                    return sqlite3.SQLITE_DENY
                return sqlite3.SQLITE_OK

            connection.set_authorizer(authorize)
            with sql_path.open("r", encoding="utf-8-sig") as file:
                # executescript requires a string; cap input to avoid accidental huge memory allocations.
                if sql_path.stat().st_size > 1024 * 1024 * 1024:
                    raise ValueError("ไฟล์ใหญ่เกิน 1 GB สำหรับตัวตรวจบนเครื่อง")
                connection.executescript(file.read())
            integrity = connection.execute("PRAGMA integrity_check").fetchone()[0]
            if integrity != "ok":
                raise ValueError("การตรวจโครงสร้าง SQLite ไม่ผ่าน")
            tables = [row[0] for row in connection.execute(
                "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
            )]
            if not tables:
                raise ValueError("ไม่พบตารางข้อมูลในไฟล์สำรอง")
            counts = {name: connection.execute(f"SELECT count(*) FROM {quote_identifier(name)}").fetchone()[0] for name in tables}
            missing = sorted(set(expected_counts or {}) - set(counts))
            differing = {name: {"expected": expected_counts[name], "actual": counts[name]}
                         for name in expected_counts or {} if name in counts and expected_counts[name] != counts[name]}
            return {"ok": not missing and not differing, "table_count": len(tables),
                    "row_counts": counts, "missing_tables": missing, "count_mismatches": differing}
        finally:
            connection.close()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("sql_file", type=Path)
    parser.add_argument("--expected-counts", type=Path, help="JSON object mapping table names to expected row counts")
    args = parser.parse_args()
    try:
        expected = json.loads(args.expected_counts.read_text(encoding="utf-8")) if args.expected_counts else None
        if expected is not None and (not isinstance(expected, dict) or
                                     any(not isinstance(k, str) or type(v) is not int or v < 0 for k, v in expected.items())):
            raise ValueError("expected-counts ต้องเป็น JSON ของชื่อตารางกับจำนวนเต็มที่ไม่ติดลบ")
        result = verify(args.sql_file, expected)
        print(json.dumps(result, ensure_ascii=False, indent=2))
        return 0 if result["ok"] else 1
    except (OSError, UnicodeError, sqlite3.Error, ValueError) as error:
        # SQLite errors can contain SQL values: do not echo raw exception text.
        print(json.dumps({"ok": False, "error": "ไม่สามารถนำเข้าและตรวจไฟล์ SQL ได้", "type": type(error).__name__}, ensure_ascii=False))
        return 1


if __name__ == "__main__":
    sys.exit(main())
