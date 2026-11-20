#!/usr/bin/env python3
"""Erzeugt schulaufgabe.json für den Bereich „Schulaufgabe“ der App.

Quelle ist scripts/schulaufgabe_themen.json (von Hand gepflegt). Bei Themen vom Typ "konjugieren" werden die
Formen aus scripts/import_conjugation.py berechnet (Présent, Passé composé, Imparfait). Alle anderen Themen
werden unverändert übernommen, vorher aber auf Fehler in der Struktur geprüft.

Aufruf:  python scripts/build_schulaufgabe.py
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

try:
    import tests.scripts.import_conjugation as ic
except ImportError:  # pragma: no cover  (als Paket, z. B. in Tests)
    from tests.scripts import import_conjugation as ic

ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / "scripts" / "schulaufgabe_themen.json"
OUTPUT = ROOT / "schulaufgabe.json"
TENSES = {"praesens": "Présent", "passe_compose": "Passé composé", "imparfait": "Imparfait"}


def conjugation_items(topic: dict, answers: dict[str, str]) -> list[dict]:
    items = []
    for verb in topic["verben"]:
        forms = {
            "praesens": ic.present_forms(verb),
            "passe_compose": ic.passe_compose_for(verb, answers),
            "imparfait": ic.imparfait_forms(verb),
        }
        for tense in topic["zeiten"]:
            if forms[tense] is None:
                raise ValueError(f"Keine Formen für {verb} ({tense}): in IRREGULAR ergänzen.")
            items.append({"verb": verb, "deutsch": topic.get("deutsch", {}).get(verb, ""),
                          "zeit": tense, "zeitname": TENSES[tense], "formen": forms[tense]})
    return items


def validate(topic: dict) -> None:
    kind, name = topic["typ"], topic["id"]
    if kind == "luecke":
        for item in topic["items"]:
            if item["q"].count("___") != len(item["blanks"]):
                raise ValueError(f"{name}: Anzahl der Lücken passt nicht in: {item['q']}")
    elif kind == "verneinung":
        for item in topic["items"]:
            if not item["antworten"]:
                raise ValueError(f"{name}: keine Antwort bei {item['q']}")
    elif kind == "schreiben":
        for task in topic["aufgaben"]:
            if not task["bausteine"] or not task["checkliste"]:
                raise ValueError(f"{name}: Aufgabe {task['id']} braucht Bausteine und Checkliste")
    elif kind != "konjugieren":
        raise ValueError(f"Unbekannter Typ {kind} bei {name}")
    if kind in ("luecke", "verneinung"):
        for item in topic["items"]:
            if not item.get("erkl"):
                raise ValueError(f"{name}: Erklärung fehlt bei {item['q']}")


def build(source: Path = SOURCE, root: Path = ROOT) -> dict:
    data = json.loads(source.read_text(encoding="utf-8"))
    answers = ic.exercise_answers(root)
    ids = set()
    for topic in data["themen"]:
        if topic["id"] in ids:
            raise ValueError(f"Doppelte Themen-ID {topic['id']}")
        ids.add(topic["id"])
        validate(topic)
        if topic["typ"] == "konjugieren":
            topic["items"] = conjugation_items(topic, answers)
            for key in ("verben", "zeiten", "deutsch"):
                topic.pop(key, None)
    return data


def main() -> None:
    try:
        data = build()
    except (ValueError, KeyError) as error:
        sys.exit(f"Fehler: {error}")
    OUTPUT.write_text(json.dumps(data, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
    print(f"{len(data['themen'])} Themen in {OUTPUT.name} geschrieben.")


if __name__ == "__main__":
    main()
