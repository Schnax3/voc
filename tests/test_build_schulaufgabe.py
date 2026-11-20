import json
import unittest

from scripts import build_schulaufgabe as bs
from scripts import import_conjugation as ic


class ImparfaitTest(unittest.TestCase):
    def test_regular_and_spelling(self):
        self.assertEqual(ic.imparfait_forms("changer"), ["je changeais", "tu changeais", "il changeait", "nous changions", "vous changiez", "ils changeaient"])
        self.assertEqual(ic.imparfait_forms("avancer")[0], "j'avançais")
        self.assertEqual(ic.imparfait_forms("avancer")[3], "nous avancions")
        self.assertEqual(ic.imparfait_forms("finir")[3], "nous finissions")

    def test_irregular(self):
        self.assertEqual(ic.imparfait_forms("être")[0], "j'étais")
        self.assertEqual(ic.imparfait_forms("faire")[4], "vous faisiez")
        self.assertEqual(ic.imparfait_forms("croire")[3], "nous croyions")
        self.assertEqual(ic.imparfait_forms("se lever")[1], "tu te levais")
        self.assertEqual(ic.imparfait_forms("falloir"), [None, None, "il fallait", None, None, None])


class SchulaufgabeTest(unittest.TestCase):
    def test_generated_file_is_up_to_date(self):
        current = json.loads(bs.OUTPUT.read_text(encoding="utf-8"))
        self.assertEqual(current, bs.build(), "schulaufgabe.json veraltet: python scripts/build_schulaufgabe.py ausführen")

    def test_every_topic_has_content(self):
        data = bs.build()
        self.assertGreaterEqual(len(data["themen"]), 5)
        for topic in data["themen"]:
            self.assertTrue(topic.get("items") or topic.get("aufgaben"), topic["id"])

    def test_conjugation_items_have_three_tenses(self):
        topic = next(t for t in bs.build()["themen"] if t["typ"] == "konjugieren")
        self.assertEqual({item["zeit"] for item in topic["items"]}, {"praesens", "passe_compose", "imparfait"})
        self.assertEqual(len(topic["items"]), 36)

    def test_wrong_number_of_blanks_is_rejected(self):
        with self.assertRaises(ValueError):
            bs.validate({"id": "x", "typ": "luecke", "items": [{"q": "a ___ b ___", "blanks": [["x"]]}]})


if __name__ == "__main__":
    unittest.main()
