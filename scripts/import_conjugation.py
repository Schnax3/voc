#!/usr/bin/env python3
"""Erzeugt verben.json: Konjugationen für alle Verb-Vokabeln der Lektionen.

Die App zeigt damit bei Verb-Karten in den vorhandenen Lektionen auf Wunsch Zeilen zum Konjugieren
(je ... / tu ... / il ... und dasselbe im Passé composé). Der Schlüssel ist die Vokabel exakt so, wie sie in
``lektionen/*/database*.json`` im Feld "vocabulary" steht (klein geschrieben)::

    "rêver de + inf.": {"inf": "rêver", "praesens": ["je rêve", ...], "passe_compose": ["j'ai rêvé", ...]}

Ein Eintrag ist ein Verb, wenn die Vokabel (ohne Zusätze wie "de + Inf.", "qn", "à") ein einzelnes Wort
auf -er/-ir/-re/-oir ist, das nicht in NOT_VERBS steht, und
das Verb regelmäßig ist oder in der Tabelle IRREGULAR steht. Unbekannte Verben werden nicht erraten,
sondern im Lauf gemeldet. Das Passé composé der Verben aus den Übungen (``uebungen/*/uebung.json``) wird
aus der dort angegebenen Form abgeleitet. Fehlt eine Person (falloir), steht ``null``.

Aufruf:  python scripts/import_conjugation.py
"""
from __future__ import annotations

import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / "verben.json"
PERSONS = ("je", "tu", "il", "nous", "vous", "ils")

# Unregelmäßiges Présent: sechs Formen ohne Pronomen; "-" = Person gibt es nicht
IRREGULAR = {
    "être": "suis es est sommes êtes sont",
    "avoir": "ai as a avons avez ont",
    "aller": "vais vas va allons allez vont",
    "faire": "fais fais fait faisons faites font",
    "dire": "dis dis dit disons dites disent",
    "pouvoir": "peux peux peut pouvons pouvez peuvent",
    "vouloir": "veux veux veut voulons voulez veulent",
    "devoir": "dois dois doit devons devez doivent",
    "savoir": "sais sais sait savons savez savent",
    "voir": "vois vois voit voyons voyez voient",
    "croire": "crois crois croit croyons croyez croient",
    "boire": "bois bois boit buvons buvez boivent",
    "prendre": "prends prends prend prenons prenez prennent",
    "apprendre": "apprends apprends apprend apprenons apprenez apprennent",
    "comprendre": "comprends comprends comprend comprenons comprenez comprennent",
    "mettre": "mets mets met mettons mettez mettent",
    "venir": "viens viens vient venons venez viennent",
    "devenir": "deviens deviens devient devenons devenez deviennent",
    "dormir": "dors dors dort dormons dormez dorment",
    "partir": "pars pars part partons partez partent",
    "sortir": "sors sors sort sortons sortez sortent",
    "mentir": "mens mens ment mentons mentez mentent",
    "servir": "sers sers sert servons servez servent",
    "courir": "cours cours court courons courez courent",
    "vivre": "vis vis vit vivons vivez vivent",
    "écrire": "écris écris écrit écrivons écrivez écrivent",
    "rire": "ris ris rit rions riez rient",
    "naître": "nais nais naît naissons naissez naissent",
    "connaître": "connais connais connaît connaissons connaissez connaissent",
    "disparaître": "disparais disparais disparaît disparaissons disparaissez disparaissent",
    "plaire": "plais plais plaît plaisons plaisez plaisent",
    "lever": "lève lèves lève levons levez lèvent",
    "tenir": "tiens tiens tient tenons tenez tiennent",
    "retenir": "retiens retiens retient retenons retenez retiennent",
    "revenir": "reviens reviens revient revenons revenez reviennent",
    "permettre": "permets permets permet permettons permettez permettent",
    "promettre": "promets promets promet promettons promettez promettent",
    "remettre": "remets remets remet remettons remettez remettent",
    "surprendre": "surprends surprends surprend surprenons surprenez surprennent",
    "reprendre": "reprends reprends reprend reprenons reprenez reprennent",
    "mourir": "meurs meurs meurt mourons mourez meurent",
    "inscrire": "inscris inscris inscrit inscrivons inscrivez inscrivent",
    "préférer": "préfère préfères préfère préférons préférez préfèrent",
    "rappeler": "rappelle rappelles rappelle rappelons rappelez rappellent",
    "ennuyer": "ennuie ennuies ennuie ennuyons ennuyez ennuient",
    "essayer": "essaie essaies essaie essayons essayez essaient",
    "envoyer": "envoie envoies envoie envoyons envoyez envoient",
    "falloir": "- - faut - - -",
    "pleuvoir": "- - pleut - - -",
    "offrir": "offre offres offre offrons offrez offrent",
    "ouvrir": "ouvre ouvres ouvre ouvrons ouvrez ouvrent",
    "découvrir": "découvre découvres découvre découvrons découvrez découvrent",
}
# Verben mit être im Passé composé (nur für Verben ohne Angabe in einer Übung)
ETRE_VERBS = {
    "aller", "venir", "devenir", "revenir", "arriver", "partir", "sortir", "entrer", "rentrer", "rester",
    "monter", "descendre", "tomber", "naître", "mourir", "retourner",
}
# Partizipien unregelmäßiger Verben (sonst aus der Übung oder nach Regel)
PARTICIPLES = {
    "inscrire": "inscrit", "tenir": "tenu", "retenir": "retenu", "revenir": "revenu", "permettre": "permis", "promettre": "promis",
    "remettre": "remis", "surprendre": "surpris", "reprendre": "repris", "mourir": "mort",
}
SECOND_GROUP = {"réfléchir", "réussir", "choisir", "finir", "grandir", "remplir", "obéir", "réagir", "agir", "réunir", "bâtir", "guérir", "punir", "rougir", "saisir", "applaudir", "établir", "grossir", "maigrir", "ralentir"}
# Wörter auf -er/-ir/-re, die keine Verben sind
NOT_VERBS = {"cher", "fier", "premier", "dernier", "léger", "étranger", "entier", "régulier", "hier", "cahier", "métier",
             "quartier", "fermier", "ouvrier", "pied", "hiver", "enfer", "mer", "ver", "amer", "super", "fer", "cuiller"}
VOWELS = "aeiouyéèêëâîïôûh"
# Regelmäßige -er-Verben mit Besonderheiten im Stamm werden nicht automatisch gebildet
STEM_CHANGE = re.compile(r"(yer|eler|eter|ener|eser|emer|ever|érer|écer|écher|éder|éter|éler|éner|éver|ébrer)$")


def with_pronoun(person: int, verb: str) -> str:
    if person == 0 and verb[0] in VOWELS:
        return "j'" + verb
    return f"{PERSONS[person]} {verb}"


def regular_present(infinitive: str) -> list[str] | None:
    """Présent regelmäßiger Verben auf -er, -ir (2. Gruppe) und -re. Sonst None."""
    if infinitive.endswith("er") and infinitive not in {"aller"} and not STEM_CHANGE.search(infinitive):
        stem = infinitive[:-2]
        nous_stem = stem + "e" if stem.endswith("g") else stem
        return [stem + "e", stem + "es", stem + "e", nous_stem + "ons", stem + "ez", stem + "ent"]
    return None


def regular_second_group(infinitive: str) -> list[str] | None:
    if infinitive in SECOND_GROUP:
        stem = infinitive[:-1]
        return [stem + "s", stem + "s", stem + "t", stem + "ssons", stem + "ssez", stem + "ssent"]
    return None


def regular_re(infinitive: str) -> list[str] | None:
    if infinitive in {"attendre", "perdre", "rendre", "répondre", "descendre", "vendre", "entendre", "répandre", "dépendre"}:
        stem = infinitive[:-2]
        return [stem + "s", stem + "s", stem, stem + "ons", stem + "ez", stem + "ent"]
    return None


def split_reflexive(verb: str) -> tuple[str, bool]:
    for prefix in ("se ", "s'", "s’"):
        if verb.startswith(prefix):
            return verb[len(prefix):], True
    return verb, False


def present_forms(verb: str) -> list[str | None] | None:
    """Sechs Präsensformen mit Pronomen ("je viens" ...), None wenn das Verb unbekannt ist."""
    infinitive, reflexive = split_reflexive(verb.strip())
    if infinitive in IRREGULAR:
        parts = IRREGULAR[infinitive].split()
    else:
        parts = regular_present(infinitive) or regular_second_group(infinitive) or regular_re(infinitive)
        if parts is None:
            return None
        if infinitive.endswith("cer"):          # avancer -> nous avançons
            parts[3] = infinitive[:-3] + "çons"
    if reflexive:
        forms = []
        for i, (pronoun, part) in enumerate(zip(("me", "te", "se", "nous", "vous", "se"), parts)):
            if i in (0, 1, 2, 5) and part[0] in VOWELS:   # m'ennuie, t'ennuies ...
                pronoun = pronoun[0] + "'"
            joined = pronoun + part if pronoun.endswith("'") else f"{pronoun} {part}"
            forms.append(with_pronoun(i, joined))
        return forms
    return [None if part == "-" else with_pronoun(i, part) for i, part in enumerate(parts)]


def split_passe_compose(answer: str) -> tuple[str, str, bool] | None:
    """"je suis venu(e)" -> ("être", "venu", False); "je me suis levé(e)" -> ("être", "levé", True)."""
    words = answer.strip().replace("’", "'").split()
    if len(words) < 2:
        return None
    participle = re.sub(r"\(e\)(\(s\))?|\(s\)", "", words[-1])
    reflexive = " me " in f" {answer} "
    if re.search(r"\b(suis|est)\b", answer):
        return "être", participle, reflexive
    if re.match(r"^(j'ai|il a)\b|\bai\b|\ba\b", answer.replace("’", "'")):
        return "avoir", participle, reflexive
    return None


def passe_compose_forms(answer: str) -> list[str | None] | None:
    parsed = split_passe_compose(answer)
    if parsed is None:
        return None
    aux, participle, reflexive = parsed
    if answer.strip().startswith("il "):  # unpersönlich: nur "il a fallu"
        return [None, None, f"il a {participle}", None, None, None]
    if aux == "avoir":
        helpers = ["j'ai", "tu as", "il a", "nous avons", "vous avez", "ils ont"]
        return [f"{h} {participle}" for h in helpers]
    if reflexive:
        helpers = ["je me suis", "tu t'es", "il s'est", "nous nous sommes", "vous vous êtes", "ils se sont"]
    else:
        helpers = ["je suis", "tu es", "il est", "nous sommes", "vous êtes", "ils sont"]
    endings = ["(e)", "(e)", "", "(e)s", "(e)(s)", "s"]
    return [f"{h} {participle}{e}" for h, e in zip(helpers, endings)]


def regular_pc_answer(verb: str) -> str | None:
    """Passé composé regelmäßiger -er-Verben (avoir, außer die Verben in ETRE_VERBS)."""
    infinitive, reflexive = split_reflexive(verb)
    if reflexive or infinitive in ETRE_VERBS or not infinitive.endswith("er") or infinitive in IRREGULAR:
        return None
    participle = infinitive[:-2] + "é"
    return "j'ai " + participle



CUT = re.compile(r"\s+(?:de|d'|d’|à|au|aux|qn|qc|qch|jdn|pour|sur|avec|contre|\+|\(|/)(?=\W|$)|[,;(]|\s+ou\s+")


EXPRESSION = re.compile(r"^(?:au|aux|du|des|de la|de l'|de l’|la|le|les|l'|l’|un|une)(?:\s|$|')")


def candidate_infinitive(vocabulary: str) -> str | None:
    """Der Infinitiv hinter einer Vokabel ("rêver de + Inf." -> "rêver", "s'ennuyer" -> "s'ennuyer")."""
    text = vocabulary.strip().lower().replace("’", "'")
    first = CUT.split(text, maxsplit=1)[0].strip()
    rest = text[len(first):].strip()
    if EXPRESSION.match(rest):          # "jouer au foot", "jouer de la guitare": feste Wendung, keine Verbkarte
        return None
    text = first
    reflexive = re.match(r"^(se |s')(.+)$", text)
    base = reflexive.group(2) if reflexive else text
    if not re.fullmatch(r"[a-zàâçéèêëîïôûùüÿœæ-]+", base) or not re.search(r"(er|ir|re|oir)$", base) or len(base) < 4:
        return None
    if base in NOT_VERBS:
        return None
    return text


def participle_for(infinitive: str, exercise_answers: dict[str, str]) -> tuple[str, str, bool] | None:
    """(Hilfsverb, Partizip, reflexiv) eines Verbs oder None, wenn unbekannt."""
    if infinitive in exercise_answers:
        return split_passe_compose(exercise_answers[infinitive])
    base, reflexive = split_reflexive(infinitive)
    aux = "être" if reflexive or base in ETRE_VERBS else "avoir"
    if base in PARTICIPLES:
        return aux, PARTICIPLES[base], reflexive
    if base in IRREGULAR and not (base.endswith("er") and base != "aller"):
        return None
    if base.endswith("er"):
        return aux, base[:-2] + "é", reflexive
    if base in SECOND_GROUP:
        return aux, base[:-1], reflexive
    if base.endswith("re"):
        return aux, base[:-2] + "u", reflexive
    return None


def passe_compose_for(infinitive: str, exercise_answers: dict[str, str]) -> list[str | None] | None:
    if infinitive in exercise_answers:
        return passe_compose_forms(exercise_answers[infinitive])
    parsed = participle_for(infinitive, exercise_answers)
    if parsed is None:
        return None
    aux, participle, reflexive = parsed
    base = split_reflexive(infinitive)[0]
    if base in {"falloir", "pleuvoir"}:
        return [None, None, f"il a {participle}", None, None, None]
    if aux == "avoir":
        helpers = ["j'ai", "tu as", "il a", "nous avons", "vous avez", "ils ont"]
        return [f"{h} {participle}" for h in helpers]
    helpers = (["je me suis", "tu t'es", "il s'est", "nous nous sommes", "vous vous êtes", "ils se sont"] if reflexive
               else ["je suis", "tu es", "il est", "nous sommes", "vous êtes", "ils sont"])
    return [f"{h} {participle}{e}" for h, e in zip(helpers, ["(e)", "(e)", "", "(e)s", "(e)(s)", "s"])]


def exercise_answers(root: Path) -> dict[str, str]:
    answers: dict[str, str] = {}
    for path in sorted((root / "uebungen").glob("*/uebung.json")):
        for entry in json.loads(path.read_text(encoding="utf-8")):
            if entry.get("french") and entry.get("answer"):
                answers.setdefault(str(entry["french"]).strip().lower(), str(entry["answer"]))
    return answers


def build(root: Path = ROOT) -> tuple[dict[str, dict], list[str]]:
    """Gibt (verben, unbekannte Verben) zurück."""
    answers = exercise_answers(root)
    verbs: dict[str, dict] = {}
    unknown: set[str] = set()
    for path in sorted((root / "lektionen").glob("*/database*.json")):
        for entry in json.loads(path.read_text(encoding="utf-8")):
            vocabulary = str(entry.get("vocabulary") or "").strip().lower()
            infinitive = candidate_infinitive(vocabulary) if vocabulary else None
            if infinitive is None or vocabulary in verbs:
                continue
            present = present_forms(infinitive)
            if present is None:
                unknown.add(infinitive)
                continue
            verbs[vocabulary] = {"inf": infinitive, "praesens": present,
                                 "passe_compose": passe_compose_for(infinitive, answers) or [None] * 6}
    return dict(sorted(verbs.items())), sorted(unknown)


def main() -> None:
    verbs, unknown = build()
    OUTPUT.write_text(json.dumps(verbs, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
    print(f"{len(verbs)} Verb-Vokabeln in {OUTPUT.name} geschrieben.")
    if unknown:
        print("Unbekannte Verben (bitte in IRREGULAR ergänzen): " + ", ".join(unknown), file=sys.stderr)


if __name__ == "__main__":
    main()
