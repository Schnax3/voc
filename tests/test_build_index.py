import json
import tempfile
import unittest
from pathlib import Path

from scripts.build_index import discover_tables, render_index


def make_repo(root: Path, layout: dict[str, list[str]]) -> None:
    for folder, files in layout.items():
        directory = root / folder
        directory.mkdir(parents=True)
        for name in files:
            (directory / name).write_text("[]", encoding="utf-8")


class BuildIndexTests(unittest.TestCase):
    def test_lists_folders_with_json_and_prefers_database_file(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            make_repo(root, {
                "lektion-a": ["notizen.json", "database-3.json"],
                "lektion-b": ["Database_x.json"],
                "nur-bilder": ["bild.jpg"],
                ".versteckt": ["database.json"],
                "_privat": ["database.json"],
                "docs": ["database.json"],
                "nur-dotfile": [".vocabulary-import.json"],
            })

            tables = discover_tables(root)

            self.assertEqual(tables, [
                {"dir": "lektion-a", "file": "database-3.json"},
                {"dir": "lektion-b", "file": "Database_x.json"},
            ])

    def test_uses_titles_when_present(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            make_repo(root, {"dec3-u1a": ["database-5.json"], "ohne-titel": ["database.json"]})
            (root / "titles.json").write_text(json.dumps({"dec3-u1a": "Dec3 · U1 A", "leer": " "}), encoding="utf-8")

            tables = discover_tables(root)

            self.assertEqual(tables[0], {"dir": "dec3-u1a", "file": "database-5.json", "title": "Dec3 · U1 A"})
            self.assertNotIn("title", tables[1])

    def test_output_is_stable_json_with_version(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            make_repo(root, {"b": ["database.json"], "a": ["database.json"]})

            first = render_index(root)

            self.assertEqual(first, render_index(root))
            data = json.loads(first)
            self.assertEqual(data["version"], 1)
            self.assertEqual([t["dir"] for t in data["tables"]], ["a", "b"])
            self.assertTrue(first.endswith("\n"))

    def test_repository_index_is_up_to_date(self):
        root = Path(__file__).resolve().parents[1]
        current = (root / "index.json").read_text(encoding="utf-8")
        self.assertEqual(current, render_index(root), "index.json veraltet: python scripts/build_index.py ausführen")

    def test_every_listed_table_is_valid_json_list(self):
        root = Path(__file__).resolve().parents[1]
        for table in discover_tables(root):
            data = json.loads((root / table["dir"] / table["file"]).read_text(encoding="utf-8").lstrip("﻿"))
            self.assertIsInstance(data, list, table["dir"])
            self.assertTrue(all("french" in e and "german" in e for e in data if isinstance(e, dict)), table["dir"])


if __name__ == "__main__":
    unittest.main()
