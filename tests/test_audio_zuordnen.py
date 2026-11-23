import json
import tempfile
import unittest
from pathlib import Path

from scripts import audio_zuordnen as az


def make_lesson(cards, files):
    tmp = tempfile.TemporaryDirectory()
    folder = Path(tmp.name)
    (folder / "database-1.json").write_text(json.dumps(cards, ensure_ascii=False, indent=4) + "\n", encoding="utf-8")
    for name in files:
        (folder / name).write_bytes(b"x")
    return tmp, folder


CARDS = [
    {"french": "Il aime la nature.", "german": "Natur", "vocabulary": "la nature", "audio": "nature.mp3"},
    {"french": "On déménage.", "german": "umziehen", "vocabulary": "déménager", "audio": "déménager.mp3"},
    {"french": "Une grande ferme.", "german": "Bauernhof", "vocabulary": "une ferme", "audio": "ferme.mp3"},
    {"french": "Il y a de la circulation.", "german": "Verkehr", "vocabulary": "circulation", "audio": "circulation.mp3"},
]


class ZuordnenTests(unittest.TestCase):
    def test_norm_and_bare(self):
        self.assertEqual(az.norm("Déménager!"), "demenager")
        self.assertEqual(az.bare("la circulation"), "circulation")
        self.assertEqual(az.bare("l'espace"), "espace")
        self.assertEqual(az.bare("un"), "un")

    def test_exact_matches_without_ai(self):
        tmp, folder = make_lesson(CARDS, ["une ferme.mp3", "la circulation.mp3", "T-M-E-N-A-G.mp3"])
        with tmp:
            result = az.process(folder, use_ai=False)
            data = json.loads((folder / "database-1.json").read_text(encoding="utf-8"))
        self.assertEqual(data[2]["audio"], "une ferme.mp3")
        self.assertEqual(data[3]["audio"], "la circulation.mp3")
        self.assertEqual(data[1]["audio"], "déménager.mp3")
        self.assertEqual(result["left"], ["T-M-E-N-A-G.mp3"])

    def test_ai_assignment_is_validated(self):
        tmp, folder = make_lesson(CARDS, ["T-M-E-N-A-G.mp3", "La Natur.mp3", "Quatsch.mp3"])
        answer = {"zuordnung": [
            {"datei": "T-M-E-N-A-G.mp3", "karte": 1, "sicher": True},
            {"datei": "La Natur.mp3", "karte": 0, "sicher": True},
            {"datei": "Quatsch.mp3", "karte": 99, "sicher": True},
            {"datei": "gibt-es-nicht.mp3", "karte": 2, "sicher": True},
        ]}
        with tmp:
            result = az.process(folder, ask=lambda s, u: answer)
            data = json.loads((folder / "database-1.json").read_text(encoding="utf-8"))
        self.assertEqual((data[0]["audio"], data[1]["audio"]), ("La Natur.mp3", "T-M-E-N-A-G.mp3"))
        self.assertEqual(data[2]["audio"], "ferme.mp3")
        self.assertEqual(result["left"], ["Quatsch.mp3"])

    def test_validate_rejects_duplicates_unsure_and_used_cards(self):
        free_files, free_cards = ["a.mp3", "b.mp3", "c.mp3"], [0, 1]
        answer = {"zuordnung": [
            {"datei": "a.mp3", "karte": 0, "sicher": True},
            {"datei": "b.mp3", "karte": 0, "sicher": True},
            {"datei": "c.mp3", "karte": 1, "sicher": False},
            {"datei": "c.mp3", "karte": 5, "sicher": True},
        ]}
        self.assertEqual(az.validate(answer, free_files, free_cards), {})
        self.assertEqual(az.validate({"zuordnung": [{"datei": "a.mp3", "karte": True}]}, free_files, free_cards), {})
        self.assertEqual(az.validate("kaputt", free_files, free_cards), {})

    def test_working_audio_is_never_replaced(self):
        cards = [dict(CARDS[0], audio="nature.mp3"), dict(CARDS[1])]
        tmp, folder = make_lesson(cards, ["nature.mp3", "T-M-E-N-A-G.mp3"])
        answer = {"zuordnung": [{"datei": "T-M-E-N-A-G.mp3", "karte": 0, "sicher": True}]}
        with tmp:
            az.process(folder, ask=lambda s, u: answer)
            data = json.loads((folder / "database-1.json").read_text(encoding="utf-8"))
        self.assertEqual(data[0]["audio"], "nature.mp3")

    def test_ai_failure_keeps_exact_matches_and_dry_run_writes_nothing(self):
        def boom(s, u):
            raise RuntimeError("Gemini 503")

        tmp, folder = make_lesson(CARDS, ["une ferme.mp3", "T-M-E-N-A-G.mp3"])
        with tmp:
            dry = az.process(folder, dry_run=True, ask=boom)
            self.assertEqual(json.loads((folder / "database-1.json").read_text(encoding="utf-8"))[2]["audio"], "ferme.mp3")
            real = az.process(folder, ask=boom)
            data = json.loads((folder / "database-1.json").read_text(encoding="utf-8"))
        self.assertIn("une ferme.mp3", dry["assigned"])
        self.assertEqual(data[2]["audio"], "une ferme.mp3")
        self.assertIn("Gemini 503", real["ki_fehler"])


if __name__ == "__main__":
    unittest.main()
