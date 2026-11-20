#!/usr/bin/env python3
"""Wendet scripts/korrekturen.json auf die Lektionen an (nach jedem Import).

Die Lektionen werden aus den Quellseiten importiert, dort stehen manche Tippfehler. Damit die Korrekturen
einen Import überleben, stehen sie in korrekturen.json und werden danach erneut angewendet. Alles ist
wiederholbar: Was schon korrigiert ist, bleibt unverändert.

Eintrag (Ersetzen):  {"lektion": "dec3-u2-a" | "*", "feld": "french|german|vocabulary|*", "alt": "…", "neu": "…",
                      "wo": {"vocabulary": "genau dieser Wert"}}      ("wo" ist optional und schränkt auf Karten ein)
Eintrag (Entfernen): {"lektion": "…", "entfernen": {"vocabulary": "genau dieser Wert"}}
Hinweis: In Lektionen mit merge_existing=true darf `german` nicht geändert werden, weil der Import danach
neue Karten über `german` erkennt und die Karte sonst doppelt anlegen würde.
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
FIELDS = ("french", "german", "vocabulary")


def _standard(raw: str, data) -> int | None:
    for indent in (2, 4):
        if json.dumps(data, ensure_ascii=False, indent=indent) + "\n" == raw:
            return indent
    return None


def _ps(value: str) -> str:
    """JSON-Text wie ihn PowerShell schreibt (' < > & als \\uXXXX)."""
    s = json.dumps(value, ensure_ascii=False)
    for ch, code in (("'", "\\u0027"), ("<", "\\u003c"), (">", "\\u003e"), ("&", "\\u0026")):
        s = s.replace(ch, code)
    return s


def _matches(card: dict, where: dict | None) -> bool:
    return all(str(card.get(k) or "") == v for k, v in (where or {}).items())


def _replace(value: str, alt: str, neu: str) -> str:
    if alt not in value or (alt in neu and neu in value):
        return value
    return value.replace(alt, neu)


def apply_to_file(path: Path, rules: list[dict]) -> int:
    raw = path.read_text(encoding="utf-8")
    data = json.loads(raw.lstrip("﻿"))
    indent = _standard(raw.lstrip("﻿"), data) if not raw.startswith("﻿") else None
    text_edits: list[tuple[str, str]] = []   # nur für nicht-standardformatierte Dateien
    changed = 0
    for rule in rules:
        if "entfernen" in rule:
            keep = [c for c in data if not _matches(c, rule["entfernen"])]
            if len(keep) != len(data):
                if indent is None:
                    raise ValueError(f"{path}: Entfernen wird bei nicht standardformatierten Dateien nicht unterstützt.")
                changed += len(data) - len(keep)
                data[:] = keep
            continue
        fields = FIELDS if rule["feld"] == "*" else (rule["feld"],)
        for card in data:
            if not _matches(card, rule.get("wo")):
                continue
            for f in fields:
                old = card.get(f)
                if not isinstance(old, str):
                    continue
                new = _replace(old, rule["alt"], rule["neu"])
                if new != old:
                    card[f] = new
                    changed += 1
                    text_edits.append((f'"{f}":  {_ps(old)}', f'"{f}":  {_ps(new)}'))
    if not changed:
        return 0
    if indent is not None:
        path.write_text(json.dumps(data, ensure_ascii=False, indent=indent) + "\n", encoding="utf-8")
    else:
        for old, new in text_edits:
            if old not in raw:
                raise ValueError(f"{path}: Zeile für die Korrektur nicht gefunden: {old[:60]}")
            raw = raw.replace(old, new)
        json.loads(raw.lstrip("﻿"))
        path.write_text(raw, encoding="utf-8")
    return changed


def main() -> None:
    rules = json.loads((ROOT / "scripts" / "korrekturen.json").read_text(encoding="utf-8"))
    total = 0
    for folder in sorted((ROOT / "lektionen").iterdir()):
        files = sorted(folder.glob("database*.json"))
        mine = [r for r in rules if r["lektion"] in ("*", folder.name)]
        for path in files:
            n = apply_to_file(path, mine) if mine else 0
            if n:
                print(f"{path.relative_to(ROOT)}: {n} Korrekturen")
                total += n
    print(f"{total} Korrekturen angewendet." if total else "Alle Korrekturen sind bereits angewendet.")


if __name__ == "__main__":
    sys.exit(main())
