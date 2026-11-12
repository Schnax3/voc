import unittest
import json
import tempfile
from pathlib import Path
from unittest.mock import patch

from scripts.import_vocabulary import (
    _write_outputs,
    merge_records,
    parse_vocabulary_html,
    strip_inline_assets,
)


class ParseVocabularyHtmlTests(unittest.TestCase):
    def test_extracts_entry_and_expands_partial_word(self):
        html = """
        <div class="row key check">
          <div class="question">
            <span class="translation"><span class="content">ein Weg</span></span>
            <img src="https://example.test/weg.jpg">
          </div>
          <div class="answer"><span>u<span class="secret">n chemin</span></span></div>
        </div>
        """

        result = parse_vocabulary_html(html, "https://example.test/lesson.html")

        self.assertEqual(result, [{
            "french": "un chemin",
            "german": "ein Weg",
            "vocabulary": "un chemin",
            "image": "https://example.test/weg.jpg",
            "audio": None,
        }])

    def test_drops_embedded_base64_image(self):
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

        self.assertIsNone(result[0]["image"])

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

    def test_normalizes_liaison_mark(self):
        html = """
        <div class="row key check">
          <div class="question">
            <span class="translation"><span class="content">ein Stadion</span></span>
          </div>
          <div class="answer"><span>C'est⁔u<span class="secret">n stade.</span></span></div>
        </div>
        """

        result = parse_vocabulary_html(html, "https://example.test/lesson.html")

        self.assertNotIn("⁔", result[0]["french"])
        self.assertIn("‿", result[0]["french"])

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


class StripInlineAssetsTests(unittest.TestCase):
    def test_removes_data_uris_but_keeps_files_and_urls(self):
        records = [
            {"german": "a", "image": "data:image/jpeg;base64,xyz", "audio": "ton.mp3"},
            {"german": "b", "image": "bild.jpg", "audio": "data:audio/mpeg;base64,xyz"},
            {"german": "c", "image": ["data:image/png;base64,1", "zwei.png"], "audio": None},
            {"german": "d", "image": ["data:image/png;base64,1"]},
        ]

        result = strip_inline_assets(records)

        self.assertEqual(result[0]["image"], None)
        self.assertEqual(result[0]["audio"], "ton.mp3")
        self.assertEqual(result[1]["image"], "bild.jpg")
        self.assertEqual(result[1]["audio"], None)
        self.assertEqual(result[2]["image"], ["zwei.png"])
        self.assertEqual(result[3]["image"], None)
        # Eingabe bleibt unverändert
        self.assertTrue(records[0]["image"].startswith("data:"))


class WriteOutputsTests(unittest.TestCase):
    def test_merge_writes_back_to_existing_database_filename(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            module = root / "existing-module"
            module.mkdir()
            database = module / "database-7.json"
            database.write_text('[{"german":"ein Weg","french":"un chemin"}]\n', encoding="utf-8")
            outputs = {
                "existing-module": (
                    [{"german": "ein Haus", "french": "une maison"}],
                    ["https://example.test/source.html"],
                    True,
                )
            }

            with patch("scripts.import_vocabulary.ROOT", root):
                _write_outputs(outputs)

            records = json.loads(database.read_text(encoding="utf-8"))
            self.assertEqual([record["german"] for record in records], ["ein Weg", "ein Haus"])
            self.assertFalse((module / "database.json").exists())
            # Es werden keine HTML-Quelldateien mehr im Repository abgelegt.
            self.assertEqual(sorted(path.name for path in module.iterdir() if path.suffix == ".html"), [])

    def test_written_database_contains_no_embedded_images(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            outputs = {
                "new-module": (
                    [{"german": "ein Haus", "french": "une maison", "vocabulary": "une maison",
                      "image": "data:image/jpeg;base64,xyz", "audio": None}],
                    ["https://example.test/source.html"],
                    False,
                )
            }

            with patch("scripts.import_vocabulary.ROOT", root):
                _write_outputs(outputs)

            records = json.loads((root / "new-module" / "database.json").read_text(encoding="utf-8"))
            self.assertIsNone(records[0]["image"])


if __name__ == "__main__":
    unittest.main()
