#!/usr/bin/env python3
"""Erzeugt index.json: die Liste aller Lektionen (Ordner mit einer Vokabel-JSON).

Die App liest diese Datei beim Start. Ohne sie müsste sie die GitHub-API fragen,
die nur 60 Anfragen pro Stunde und IP erlaubt.

Aufruf:
    python scripts/build_index.py           # schreibt index.json (nur bei Änderungen)
    python scripts/build_index.py --check   # Exit-Code 1, wenn index.json veraltet ist

Anzeigenamen stehen in titles.json ({"ordnername": "Anzeigename"}); fehlt ein Eintrag,
zeigt die App den Ordnernamen.
"""
from __future__ import annotations

import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
INDEX_FILE = "index.json"
TITLES_FILE = "titles.json"
IGNORED_FOLDERS = {"node_modules", "assets", "docs"}  # wie CFG.ignore in index.html
PREFERRED_FILE = re.compile(r"^database", re.IGNORECASE)  # wie CFG.prefer in index.html


def load_titles(root: Path) -> dict[str, str]:
    path = root / TITLES_FILE
    if not path.is_file():
        return {}
    data = json.loads(path.read_text(encoding="utf-8").lstrip("﻿"))
    if not isinstance(data, dict):
        raise ValueError(f"{TITLES_FILE} muss ein Objekt {{Ordner: Name}} sein.")
    return {str(folder): str(title) for folder, title in data.items() if str(title).strip()}


def discover_tables(root: Path) -> list[dict[str, str]]:
    titles = load_titles(root)
    tables: list[dict[str, str]] = []
    for directory in sorted((p for p in root.iterdir() if p.is_dir()), key=lambda p: p.name.casefold()):
        name = directory.name
        if name[0] in "._" or name in IGNORED_FOLDERS:
            continue
        files = sorted(
            f.name for f in directory.iterdir()
            if f.is_file() and f.suffix.lower() == ".json" and not f.name.startswith(".")
        )
        if not files:
            continue
        chosen = next((f for f in files if PREFERRED_FILE.match(f)), files[0])
        table = {"dir": name, "file": chosen}
        if name in titles:
            table["title"] = titles[name]
        tables.append(table)
    return tables


def render_index(root: Path) -> str:
    payload = {"version": 1, "tables": discover_tables(root)}
    return json.dumps(payload, ensure_ascii=False, indent=2) + "\n"


def main(argv: list[str]) -> int:
    check = "--check" in argv
    expected = render_index(ROOT)
    target = ROOT / INDEX_FILE
    current = target.read_text(encoding="utf-8") if target.is_file() else None
    if current == expected:
        print(f"{INDEX_FILE} ist aktuell ({len(json.loads(expected)['tables'])} Lektionen).")
        return 0
    if check:
        print(f"{INDEX_FILE} ist veraltet. Bitte 'python scripts/build_index.py' ausführen und committen.")
        return 1
    target.write_text(expected, encoding="utf-8")
    print(f"{INDEX_FILE} geschrieben ({len(json.loads(expected)['tables'])} Lektionen).")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
