import unittest
import json
import tempfile
from pathlib import Path
from unittest.mock import patch

from scripts.import_vocabulary import _write_outputs, merge_records, parse_vocabulary_html


class ParseVocabularyHtmlTests(unittest.TestCase):
    def test_extracts_entry_and_expands_partial_word(self):
        html = """
        <div class="row key check">
          <div class="question">
            <span class="translation"><span class="content">ein Weg</span></span>
            <img src="data:image/png;base64,abc">
          </div>
          <div class="answer"><span>u<span class="secret">n chemin</span></span></div>
        </div>
        """

        result = parse_vocabulary_html(html, "https://example.test/lesson.html")

        self.assertEqual(result, [{
            "french": "un chemin",
            "german": "ein Weg",
            "vocabulary": "un chemin",
            "image": "data:image/png;base64,abc",
            "audio": None,
        }])

    def test_extracts_terms_marked_as_extra(self):
        html = """
        <div class="row key check">
          <div class="question">
            <span class="translation"><span class="content">Schlag</span></span>
          </div>
          <div class="answer"><span>Il fait u<span class="extra">n coup</span> sur la table.</span></div>
        </div>
        """

        result = parse_vocabulary_html(html, "https://example.test/lesson.html")

        self.assertEqual(result[0]["french"], "Il fait un coup sur la table.")
        self.assertEqual(result[0]["vocabulary"], "un coup")

    def test_rejects_pages_without_vocabulary_rows(self):
        with self.assertRaisesRegex(ValueError, "keine erkennbaren Vokabelzeilen"):
            parse_vocabulary_html("<html><body>Keine Einträge</body></html>", "https://example.test/")

    def test_merge_keeps_existing_record_and_adds_new_prompt(self):
        existing = [{"german": "ein Weg", "french": "un chemin"}]
        incoming = [
            {"german": "ein Weg", "french": "un chemin bis"},
            {"german": "ein Haus", "french": "une maison"},
        ]

        self.assertEqual(merge_records(existing, incoming), [
            existing[0],
            incoming[1],
        ])

    def test_merge_writes_back_to_existing_database_filename(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            module = root / "existing-module"
            module.mkdir()
            database = module / "database-7.json"
            database.write_text('[{"german":"ein Weg","french":"un chemin"}]\n', encoding="utf-8")
            outputs = {
                "existing-module": (
                    {"source.html": b"<html></html>"},
                    [{"german": "ein Haus", "french": "une maison"}],
                    ["https://example.test/source.html"],
                    True,
                )
            }

            with patch("scripts.import_vocabulary.ROOT", root):
                _write_outputs(outputs)

            records = json.loads(database.read_text(encoding="utf-8"))
            self.assertEqual([record["german"] for record in records], ["ein Weg", "ein Haus"])
            self.assertTrue((module / "source.html").is_file())
            self.assertFalse((module / "database.json").exists())


if __name__ == "__main__":
    unittest.main()
