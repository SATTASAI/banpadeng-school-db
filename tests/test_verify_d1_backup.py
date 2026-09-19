import importlib.util
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "scripts" / "verify-d1-backup.py"
spec = importlib.util.spec_from_file_location("verify_d1_backup", SCRIPT)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class BackupVerificationTests(unittest.TestCase):
    def test_valid_restore_and_counts(self):
        with tempfile.TemporaryDirectory() as directory:
            file = Path(directory) / "export.sql"
            file.write_text('CREATE TABLE students(id INTEGER PRIMARY KEY, name TEXT);\n'
                            "INSERT INTO students VALUES(1, 'secret');\n"
                            'CREATE TABLE "odd""name" (value TEXT);\n', encoding="utf-8")
            result = module.verify(file, {"students": 1})
            self.assertTrue(result["ok"])
            self.assertEqual(result["row_counts"], {"odd\"name": 0, "students": 1})
            self.assertNotIn("secret", json.dumps(result))
            self.assertFalse(module.verify(file, {"students": 2, "personnel_records": 1})["ok"])

    def test_reject_external_attachment_and_invalid_sql(self):
        with tempfile.TemporaryDirectory() as directory:
            file = Path(directory) / "export.sql"
            file.write_text("ATTACH DATABASE '/tmp/forbidden.sqlite' AS other;", encoding="utf-8")
            process = subprocess.run([sys.executable, str(SCRIPT), str(file)], capture_output=True, text=True)
            self.assertNotEqual(process.returncode, 0)
            self.assertNotIn("/tmp/forbidden", process.stdout)
            self.assertFalse(Path('/tmp/forbidden.sqlite').exists())
            file.write_text("CREATE TABLE broken(", encoding="utf-8")
            self.assertNotEqual(subprocess.run([sys.executable, str(SCRIPT), str(file)], capture_output=True).returncode, 0)


if __name__ == "__main__":
    unittest.main()
