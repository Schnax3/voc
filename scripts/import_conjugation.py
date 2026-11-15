#!/usr/bin/env python3
"""Erzeugt die Übung "Verben konjugieren" (uebungen/konjugation/uebung.json).

Quellen:
1. Alle Verben der Übungen mit Passé composé (``uebungen/*/uebung.json``, Felder french/german/answer).
   Das Passé composé wird aus der dort angegebenen Form für alle Personen abgeleitet.
2. Regelmäßige Verben auf -er aus den Lektionen (``lektionen/*/database*.json``): Ein Verb zählt, wenn
   ein Satz seinen Infinitiv nennt ("Inf.: rêver") und die Vokabel genau dieses Verb ist.

Jeder Eintrag::

    {"french": "venir", "german": "kommen", "ref": "Déc-Kl-6",
     "praesens": ["je viens", "tu viens", "il vient", "nous venons", "vous venez", "ils viennent"],
     "passe_compose": ["je suis venu(e)", ...]}

Fehlt eine Person (unpersönliche Verben wie "falloir"), steht an ihrer Stelle ``null``.
Unregelmäßige Verben außerhalb der Tabelle IRREGULAR werden nicht erraten, sondern im Lauf gemeldet.

Aufruf:  python scripts/import_conjugation.py
"""
from __future__ import annotations

import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / "uebungen" / "konjugation" / "uebung.json"
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
    if infinitive in {"réfléchir", "réussir", "choisir", "finir", "grandir", "remplir", "obéir", "réagir", "agir"}:
        stem = infinitive[:-1]
        return [stem + "s", stem + "s", stem + "t", stem + "ssons", stem + "ssez", stem + "ssent"]
    return None


def regular_re(infinitive: str) -> list[str] | None:
    if infinitive in {"attendre", "perdre", "rendre", "répondre", "descendre", "vendre", "entendre", "répandre"}:
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


def exercise_records(root: Path) -> list[dict]:
    records, seen = [], set()
    for path in sorted((root / "uebungen").glob("*/uebung.json")):
        if path.parent.name == "konjugation":
            continue
        for entry in json.loads(path.read_text(encoding="utf-8")):
            verb = str(entry.get("french", "")).strip()
            if not verb or verb in seen or "answer" not in entry:
                continue
            present = present_forms(verb)
            if present is None:
                print(f"  übersprungen (Präsens unbekannt): {verb}", file=sys.stderr)
                continue
            seen.add(verb)
            records.append({"french": verb, "german": entry.get("german", ""), "ref": entry.get("ref", ""),
                            "praesens": present, "passe_compose": passe_compose_forms(str(entry["answer"]))})
    return records


INF_MARK = re.compile(r"[Ii]nf(?:initif)?\.?\s*:\s*((?:s[e']\s?|s’)?[a-zàâçéèêëîïôûùüÿ]+)")


def lesson_records(root: Path, known: set[str]) -> list[dict]:
    """Regelmäßige -er-Verben, deren Infinitiv in einem Satz genannt wird und die selbst Vokabel sind."""
    found: dict[str, dict] = {}
    for path in sorted((root / "lektionen").glob("*/database*.json")):
        for entry in json.loads(path.read_text(encoding="utf-8")):
            vocabulary = str(entry.get("vocabulary") or "").strip().lower()
            match = INF_MARK.search(str(entry.get("french") or ""))
            if not match or not vocabulary:
                continue
            verb = re.sub(r"^s[e'’]\s?", lambda m: "se " if m.group(0).startswith("se") else "s'", match.group(1).lower())
            if verb != vocabulary or verb in known or verb in found:
                continue
            present = present_forms(verb)
            pc_answer = regular_pc_answer(verb)
            if present is None or pc_answer is None:
                continue
            found[verb] = {"french": verb, "german": entry.get("german", ""), "ref": "",
                           "praesens": present, "passe_compose": passe_compose_forms(pc_answer)}
    return list(found.values())


def build(root: Path = ROOT) -> list[dict]:
    records = exercise_records(root)
    records += lesson_records(root, {r["french"] for r in records})
    return records


def main() -> None:
    records = build()
    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    OUTPUT.write_text(json.dumps(records, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"{len(records)} Verben in {OUTPUT.relative_to(ROOT)} geschrieben.")


if __name__ == "__main__":
    main()
