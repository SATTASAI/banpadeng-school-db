"""Guard the instant-search behavior used throughout the web app."""

import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


class LiveSearchTest(unittest.TestCase):
    def test_every_search_box_updates_on_input(self):
        expectations = {
            "public/dashboard.html": ('id="globalSearchInput"', 'addEventListener("input"'),
            "public/students.html": ('id="searchInput"', 'eventName = id === "searchInput" ? "input"'),
            "public/documents.html": ('id="q" type="search"', '$("q").oninput'),
            "public/work-center.html": ('id="searchInput"', '$("searchInput").oninput'),
            "public/inventory.html": ('id="searchInput"', '$("searchInput").oninput'),
            "public/maintenance.html": ('id="searchInput"', '$("searchInput").oninput'),
            "public/budget.html": ('id="search" type="search"', '$("search").oninput'),
            "public/school-bank.html": ('type="search" id="search"', '$("search").oninput'),
        }
        for relative, markers in expectations.items():
            text = (ROOT / relative).read_text()
            with self.subTest(page=relative):
                for marker in markers:
                    self.assertIn(marker, text)

    def test_global_search_accepts_the_first_character(self):
        dashboard = (ROOT / "public/dashboard.html").read_text()
        worker = (ROOT / "src/index.js").read_text()
        self.assertNotIn("query.length<2", dashboard)
        self.assertNotIn("q.length < 2", worker)
        self.assertIn("if (!q) return jsonResponse", worker)

    def test_remote_searches_ignore_stale_results(self):
        for relative in (
            "public/dashboard.html",
            "public/documents.html",
            "public/work-center.html",
            "public/inventory.html",
            "public/maintenance.html",
        ):
            text = (ROOT / relative).read_text()
            with self.subTest(page=relative):
                self.assertTrue("searchVersion" in text or "SearchVersion" in text)
                self.assertIn("120", text)


if __name__ == "__main__":
    unittest.main()
