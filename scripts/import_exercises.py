#!/usr/bin/env python3
"""Importiert Übungsseiten (Verb -> Passé composé) aus den Quellen in sources_uebungen.csv.

Jede Quelle ergibt eine Datei ``<ordner>/uebung.json`` mit Einträgen der Form::

    {"french": "venir", "german": "kommen", "answer": "je suis venu(e)", "ref": "Déc-Kl-6"}

``french`` ist das Verb im Infinitiv, ``german`` die Übersetzung (wird erst auf Wunsch aufgedeckt),
``answer`` die richtige Form. Es wird nur die Seite mit der Lösung ("tout") gebraucht: Die Varianten
tâche/incopiable/de und die Mischungen mix1/mix2 haben denselben Inhalt.

Aufruf:  python scripts/import_exercises.py [Datei.html Ordner]
Mit Argumenten wird eine lokal gespeicherte Seite statt der Quellen aus der CSV gelesen.
"""
from __future__ import annotations

import csv
import json
import re
import sys
from pathlib import Path
from urllib.error import URLError
from urllib.parse import urlparse

try:  # als Skript (python scripts/...) und als Paket (tests) lauffähig
    from import_vocabulary import PageParser, clean_text, descendants, download, text_content
except ImportError:  # pragma: no cover
    from scripts.import_vocabulary import PageParser, clean_text, descendants, download, text_content

ROOT = Path(__file__).resolve().parents[1]
SOURCES_FILE = ROOT / "sources_uebungen.csv"
EXERCISE_FILE = "uebung.json"
EXERCISE_ROOT = "uebungen"


def parse_exercise_html(html: str) -> list[dict[str, str]]:
    parser = PageParser()
    parser.feed(html)
    rows = list(descendants(parser.root, "row"))
    if not rows:
        raise ValueError("Die HTML-Seite enthält keine erkennbaren Übungszeilen (.row).")

    records: list[dict[str, str]] = []
    seen: set[tuple[str, str]] = set()
    for number, row in enumerate(rows, start=1):
        question = next(descendants(row, "question"), None)
        answer = next(descendants(row, "answer"), None)
        if question is None or answer is None:
            continue
        translation = next(descendants(question, "content"), None)
        german = clean_text(text_content(translation)) if translation else ""
        # Das Verb steht in einem Element neben der Übersetzung (class "translation").
        verb = clean_text(" ".join(
            text_content(child) for child in question.children
            if not isinstance(child, str) and "translation" not in child.classes
        ))
        solution = clean_text(text_content(answer))
        solution = re.sub(r"^PC\s*:\s*", "", solution)
        if not any("secret" in element.classes for element in descendants(answer)):
            raise ValueError(f"Zeile {number}: keine Lösung (.secret) gefunden.")
        if not (verb and german and solution):
            raise ValueError(f"Zeile {number}: Verb, Übersetzung oder Lösung fehlt.")
        if (verb, solution) in seen:
            continue
        seen.add((verb, solution))
        record = {"french": verb, "german": german, "answer": solution}
        ref = next(descendants(row, "ref"), None)
        if ref is not None and clean_text(text_content(ref)):
            record["ref"] = clean_text(text_content(ref))
        records.append(record)
    if not records:
        raise ValueError("Die HTML-Seite enthält keine auswertbaren Übungen.")
    return records


def read_sources(path: Path) -> list[tuple[str, str]]:
    if not path.is_file():
        return []
    lines = [line for line in path.read_text(encoding="utf-8-sig").splitlines()
             if line.strip() and not line.lstrip().startswith("#")]
    reader = csv.DictReader(lines)
    if reader.fieldnames != ["folder", "url"]:
        raise ValueError("sources_uebungen.csv muss die Kopfzeile 'folder,url' enthalten.")
    sources = []
    for number, row in enumerate(reader, start=2):
        folder = (row.get("folder") or "").strip()
        url = (row.get("url") or "").strip()
        if not folder or not url:
            raise ValueError(f"sources_uebungen.csv, Zeile {number}: folder und url sind erforderlich.")
        if not re.fullmatch(r"[a-z0-9][a-z0-9-]*", folder):
            raise ValueError(f"sources_uebungen.csv, Zeile {number}: folder nur aus a-z, 0-9 und -.")
        if urlparse(url).scheme.lower() != "https":
            raise ValueError(f"sources_uebungen.csv, Zeile {number}: nur HTTPS-URLs sind erlaubt.")
        sources.append((folder, url))
    return sources


def write_exercise(folder: str, records: list[dict[str, str]], url: str | None = None) -> Path:
    directory = ROOT / EXERCISE_ROOT / folder
    directory.mkdir(parents=True, exist_ok=True)
    target = directory / EXERCISE_FILE
    target.write_text(json.dumps(records, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    if url:
        (directory / ".exercise-import.json").write_text(
            json.dumps({"generated_by": "scripts/import_exercises.py", "source": url}, ensure_ascii=False, indent=2) + "\n",
            encoding="utf-8",
        )
    print(f"{EXERCISE_ROOT}/{folder}: {len(records)} Einträge")
    return target


def main(argv: list[str]) -> None:
    if len(argv) == 2:  # lokale Datei: import_exercises.py seite.html passe-compose
        html = Path(argv[0]).read_text(encoding="utf-8-sig")
        write_exercise(argv[1], parse_exercise_html(html))
        return
    sources = read_sources(SOURCES_FILE)
    if not sources:
        print("Keine Quellen in sources_uebungen.csv eingetragen.")
        return
    for folder, url in sources:
        write_exercise(folder, parse_exercise_html(download(url)), url)


if __name__ == "__main__":
    try:
        main(sys.argv[1:])
    except (OSError, URLError, ValueError) as error:
        sys.exit(f"Übungsimport fehlgeschlagen: {error}")
