import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from scripts import import_exercises as ie

ROW = (
    '<div class="row key check"><div class="columns"><div class="question">'
    '<span class="translation"><span class="content">{de}</span></span><span>{fr}</span></div>'
    '<div class="deutsch sf-hidden"></div><div class="answer"><span>PC: {pre}<span class="secret">{sec}</span></span></div>'
    '<div class="answer key sf-hidden"></div></div><div class="ref"><span>{ref}</span></div></div>'
)


def page(*rows):
    return '<html><body><div class="app"><div class="rows">' + "".join(rows) + "</div></div></body></html>"


class ParseExerciseTests(unittest.TestCase):
    def test_reads_verb_translation_solution_and_reference(self):
        html = page(
            ROW.format(de="kommen", fr="venir", pre="j", sec="e suis venu(e)", ref="Déc-Kl-6"),
            ROW.format(de="schlafen", fr="dormir", pre="j", sec="'ai dormi", ref="Déc-Kl-7.3"),
            ROW.format(de="aufstehen", fr="se lever", pre="je ", sec="me suis levé(e)", ref="Déc-Kl-7.3"),
        )
        self.assertEqual(ie.parse_exercise_html(html), [
            {"french": "venir", "german": "kommen", "answer": "je suis venu(e)", "ref": "Déc-Kl-6"},
            {"french": "dormir", "german": "schlafen", "answer": "j'ai dormi", "ref": "Déc-Kl-7.3"},
            {"french": "se lever", "german": "aufstehen", "answer": "je me suis levé(e)", "ref": "Déc-Kl-7.3"},
        ])

    def test_skips_duplicates(self):
        row = ROW.format(de="sein", fr="être", pre="j", sec="'ai été", ref="x")
        self.assertEqual(len(ie.parse_exercise_html(page(row, row))), 1)

    def test_row_without_solution_is_an_error(self):
        broken = ROW.format(de="sein", fr="être", pre="j'ai été", sec="", ref="x").replace('<span class="secret"></span>', "")
        with self.assertRaises(ValueError):
            ie.parse_exercise_html(page(broken))

    def test_page_without_rows_is_an_error(self):
        with self.assertRaises(ValueError):
            ie.parse_exercise_html("<html><body>nichts</body></html>")

    def test_sources_file_is_validated(self):
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "s.csv"
            path.write_text("folder,url\npasse-compose,https://example.org/a.html\n", encoding="utf-8")
            self.assertEqual(ie.read_sources(path), [("passe-compose", "https://example.org/a.html")])
            path.write_text("folder,url\n../x,https://example.org/a.html\n", encoding="utf-8")
            with self.assertRaises(ValueError):
                ie.read_sources(path)
            path.write_text("folder,url\nx,http://example.org/a.html\n", encoding="utf-8")
            with self.assertRaises(ValueError):
                ie.read_sources(path)

    def test_writes_exercise_file_into_subfolder(self):
        with tempfile.TemporaryDirectory() as temporary:
            with patch.object(ie, "ROOT", Path(temporary)):
                target = ie.write_exercise("passe-compose", [{"french": "a", "german": "b", "answer": "c"}])
            self.assertEqual(target, Path(temporary) / "uebungen" / "passe-compose" / "uebung.json")
            self.assertEqual(json.loads(target.read_text(encoding="utf-8"))[0]["answer"], "c")


class CommittedExerciseDataTests(unittest.TestCase):
    def test_passe_compose_data_is_complete(self):
        root = Path(__file__).resolve().parents[1]
        data = json.loads((root / "uebungen" / "passe-compose" / "uebung.json").read_text(encoding="utf-8"))
        self.assertGreaterEqual(len(data), 50)
        for entry in data:
            self.assertTrue(entry["french"] and entry["german"] and entry["answer"], entry)
            self.assertFalse(entry["answer"].startswith("PC"), entry)
        self.assertEqual(len({e["french"] for e in data}), len(data))


if __name__ == "__main__":
    unittest.main()
