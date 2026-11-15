import unittest

from scripts import import_conjugation as ic


class ConjugationTest(unittest.TestCase):
    def test_irregular_present(self):
        self.assertEqual(ic.present_forms("venir"), ["je viens", "tu viens", "il vient", "nous venons", "vous venez", "ils viennent"])
        self.assertEqual(ic.present_forms("être")[0], "je suis")

    def test_regular_verbs_and_spelling(self):
        self.assertEqual(ic.present_forms("aimer")[0], "j'aime")
        self.assertEqual(ic.present_forms("avancer")[3], "nous avançons")
        self.assertEqual(ic.present_forms("manger")[3], "nous mangeons")
        self.assertEqual(ic.present_forms("choisir")[5], "ils choisissent")
        self.assertEqual(ic.present_forms("attendre")[2], "il attend")

    def test_reflexive(self):
        self.assertEqual(ic.present_forms("se lever"), ["je me lève", "tu te lèves", "il se lève", "nous nous levons", "vous vous levez", "ils se lèvent"])

    def test_impersonal_has_only_il(self):
        self.assertEqual(ic.present_forms("falloir"), [None, None, "il faut", None, None, None])
        self.assertEqual(ic.passe_compose_forms("il a fallu"), [None, None, "il a fallu", None, None, None])

    def test_passe_compose(self):
        self.assertEqual(ic.passe_compose_forms("j'ai dormi")[3], "nous avons dormi")
        self.assertEqual(ic.passe_compose_forms("je suis venu(e)"), ["je suis venu(e)", "tu es venu(e)", "il est venu", "nous sommes venu(e)s", "vous êtes venu(e)(s)", "ils sont venus"])
        self.assertEqual(ic.passe_compose_forms("je me suis levé(e)")[1], "tu t'es levé(e)")

    def test_unknown_verb_is_not_guessed(self):
        self.assertIsNone(ic.present_forms("résoudre"))

    def test_generated_file_is_consistent(self):
        records = ic.build()
        self.assertGreater(len(records), 50)
        for record in records:
            self.assertEqual(len(record["praesens"]), 6, record["french"])
            self.assertEqual(len(record["passe_compose"]), 6, record["french"])


if __name__ == "__main__":
    unittest.main()
