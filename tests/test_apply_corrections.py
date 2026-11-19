import json
import tempfile
import unittest
from pathlib import Path

from scripts import apply_corrections as ac

ROOT = Path(__file__).resolve().parents[1]


class ApplyTests(unittest.TestCase):
    def run_rules(self, data, rules, raw=None):
        with tempfile.TemporaryDirectory() as d:
            p = Path(d) / "database.json"
            p.write_text(raw if raw is not None else json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
            n = ac.apply_to_file(p, rules)
            again = ac.apply_to_file(p, rules)
            return n, again, p.read_text(encoding="utf-8")

    def test_replace_is_idempotent_and_filtered(self):
        data = [{"french": "a plusieurs", "german": "x", "vocabulary": "v1"}, {"french": "a plusieurs", "german": "y", "vocabulary": "v2"}]
        rules = [{"lektion": "*", "feld": "french", "alt": "plusieurs", "neu": "plus", "wo": {"vocabulary": "v2"}}]
        n, again, text = self.run_rules(data, rules)
        self.assertEqual((n, again), (1, 0))
        out = json.loads(text)
        self.assertEqual([c["french"] for c in out], ["a plusieurs", "a plus"])

    def test_append_rule_does_not_double(self):
        data = [{"french": "qui est le criminel", "german": "x", "vocabulary": "v"}]
        rules = [{"lektion": "*", "feld": "french", "alt": "criminel", "neu": "criminel."}]
        n, again, text = self.run_rules(data, rules)
        self.assertEqual((n, again), (1, 0))
        self.assertEqual(json.loads(text)[0]["french"], "qui est le criminel.")

    def test_remove(self):
        data = [{"french": "a", "german": "x", "vocabulary": "doppelt"}, {"french": "b", "german": "y", "vocabulary": "ok"}]
        n, _, text = self.run_rules(data, [{"lektion": "*", "entfernen": {"vocabulary": "doppelt"}}])
        self.assertEqual(n, 1)
        self.assertEqual([c["vocabulary"] for c in json.loads(text)], ["ok"])

    def test_powershell_format_keeps_layout(self):
        raw = '[\n    {\n        "french":  "C\\u0027est\\u0027 un‿objet",\n        "german":  "Ding",\n        "vocabulary":  "un‿objet",\n        "image":  null\n    }\n]\n'
        rules = [{"lektion": "*", "feld": "vocabulary", "alt": "‿", "neu": " "}]
        n, again, text = self.run_rules(None, rules, raw=raw)
        self.assertEqual((n, again), (1, 0))
        self.assertEqual(text, raw.replace('"vocabulary":  "un‿objet"', '"vocabulary":  "un objet"'))

    def test_repository_data_is_already_corrected(self):
        """Wer die Lektionen neu importiert, muss danach apply_corrections.py laufen lassen (macht der Workflow)."""
        rules = json.loads((ROOT / "scripts" / "korrekturen.json").read_text(encoding="utf-8"))
        for folder in (ROOT / "lektionen").iterdir():
            mine = [r for r in rules if r["lektion"] in ("*", folder.name)]
            for path in folder.glob("database*.json"):
                with tempfile.TemporaryDirectory() as d:
                    copy = Path(d) / path.name
                    copy.write_bytes(path.read_bytes())
                    self.assertEqual(ac.apply_to_file(copy, mine), 0, f"{path} ist nicht vollständig korrigiert")


if __name__ == "__main__":
    unittest.main()
