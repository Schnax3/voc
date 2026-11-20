#!/usr/bin/env python3
"""Ordnet neue, noch nicht verknüpfte Audiodateien den richtigen Vokabeln zu (mit Google Gemini).

Der Audio-Schneider benennt Dateien nach dem erkannten französischen Teil ("La Natur.mp3", "T-M-E-N-A-G.mp3").
Das Feld "audio" in der Datenbank nennt aber den alten Namen ("nature.mp3"). Dieses Skript findet Dateien im
Lektionsordner, auf die keine Karte verweist, und trägt sie bei der passenden Karte ein.

  1. Exakte Treffer (gleicher Name ohne Akzente/Groß-/Kleinschreibung wie das Feld "audio" oder die Vokabel).
  2. Gemini ordnet den Rest anhand von Vokabel, Satz, Übersetzung und dem alten Dateinamen zu.
  3. Jede Zuordnung wird geprüft (Datei und Karte existieren, keine Doppelbelegung, Karte hatte noch keine
     funktionierende Audiodatei). Unsicheres bleibt unzugeordnet und wird nur gemeldet.

Aufruf:  python scripts/audio_zuordnen.py [Ordner ...] [--dry-run] [--no-ai]
Ohne Ordner: alle Ordner unter lektionen/. Benötigt GEMINI_API_KEY (ohne Schlüssel nur Schritt 1 und 3).
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import unicodedata
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))

AUDIO_EXT = (".mp3", ".ogg", ".m4a", ".wav")

SYSTEM = """Du ordnest Audiodateien einer Französisch-Vokabeltrainer-App den richtigen Vokabelkarten zu.
Die Dateinamen stammen aus automatischer Spracherkennung und enthalten oft Hör-Fehler, Tippfehler, Pluralformen
oder zusätzliche Wörter (z. B. "La Natur.mp3" gehört zu "la nature", "T-M-E-N-A-G.mp3" klingt wie "déménager").
Der Name beschreibt, was GESPROCHEN wird, meist die französische Vokabel (manchmal ein ganzer Satz).
Zu jeder Karte gibt es: nr, vokabel, satz, deutsch und "alter_dateiname" (so hieß die Datei früher, ein starker Hinweis).
Regeln:
- Jede Datei gehört zu höchstens einer Karte, jede Karte bekommt höchstens eine Datei.
- Nutze nur Dateien und Kartennummern aus den Listen.
- Wenn du dir nicht sicher bist, gib karte = null. Raten ist schlechter als weglassen.
Antworte NUR mit JSON: {"zuordnung":[{"datei":"<exakter Dateiname>","karte":<nr oder null>,"sicher":true|false}]}"""


def norm(value: str) -> str:
    text = unicodedata.normalize("NFKD", value.casefold())
    text = "".join(c for c in text if not unicodedata.combining(c))
    return "".join(c for c in text if c.isalnum())


ARTICLES = ("un", "une", "le", "la", "les", "l", "des", "du", "de", "d")


def bare(value: str) -> str:
    """Wie norm, aber ohne führenden Artikel ("la circulation" == "circulation")."""
    words = [w for w in value.replace("'", " ").replace("’", " ").split() if w]
    if len(words) > 1 and norm(words[0]) in ARTICLES:
        words = words[1:]
    return norm(" ".join(words))


def stem(name: str) -> str:
    return name.rsplit(".", 1)[0]


def load(path: Path) -> list[dict]:
    return json.loads(path.read_text(encoding="utf-8-sig"))


def save(path: Path, data: list[dict]) -> None:
    path.write_text(json.dumps(data, ensure_ascii=False, indent=4) + "\n", encoding="utf-8")


def find_database(folder: Path) -> Path | None:
    files = sorted(folder.glob("database*.json"))
    return files[0] if files else None


def audio_files(folder: Path) -> list[str]:
    return sorted(p.name for p in folder.iterdir() if p.suffix.lower() in AUDIO_EXT)


def free_files_and_cards(data: list[dict], files: list[str]) -> tuple[list[str], list[int]]:
    """Dateien, auf die keine Karte verweist, und Karten ohne funktionierende Audiodatei."""
    present = set(files)
    used = {c.get("audio") for c in data if c.get("audio") in present}
    free_files = [f for f in files if f not in used]
    free_cards = [i for i, c in enumerate(data) if c.get("audio") not in present]
    return free_files, free_cards


def exact_matches(data: list[dict], free_files: list[str], free_cards: list[int]) -> dict[str, int]:
    """Datei -> Karte, wenn der Name (normalisiert) dem alten Audio-Namen oder der Vokabel entspricht und eindeutig ist."""
    result: dict[str, int] = {}
    for file in free_files:
        keys = {norm(stem(file)), bare(stem(file))} - {""}
        hits = [i for i in free_cards
                if keys & {norm(stem(data[i].get("audio") or "")), norm(data[i].get("vocabulary") or ""),
                           bare(stem(data[i].get("audio") or "")), bare(data[i].get("vocabulary") or "")} - {""}]
        if len(hits) == 1:
            result[file] = hits[0]
    taken: dict[int, list[str]] = {}
    for file, card in result.items():
        taken.setdefault(card, []).append(file)
    return {f: c for f, c in result.items() if len(taken[c]) == 1}


def validate(proposal, free_files: list[str], free_cards: list[int]) -> dict[str, int]:
    """Prüft die Antwort der KI. Gibt nur gültige, eindeutige und sichere Zuordnungen zurück."""
    if not isinstance(proposal, dict) or not isinstance(proposal.get("zuordnung"), list):
        return {}
    files, cards = set(free_files), set(free_cards)
    result: dict[str, int] = {}
    for item in proposal["zuordnung"]:
        if not isinstance(item, dict):
            continue
        file, card = item.get("datei"), item.get("karte")
        if file not in files or isinstance(card, bool) or not isinstance(card, int) or card not in cards:
            continue
        if item.get("sicher") is False:
            continue
        result.setdefault(file, card)
    counts: dict[int, int] = {}
    for card in result.values():
        counts[card] = counts.get(card, 0) + 1
    return {f: c for f, c in result.items() if counts[c] == 1}


def build_prompt(data: list[dict], files: list[str], cards: list[int]) -> str:
    karten = [{"nr": i, "vokabel": data[i].get("vocabulary", ""), "satz": data[i].get("french", ""),
               "deutsch": data[i].get("german", ""), "alter_dateiname": data[i].get("audio", "")} for i in cards]
    return json.dumps({"dateien": files, "karten": karten}, ensure_ascii=False, indent=1)


def process(folder: Path, use_ai: bool = True, dry_run: bool = False, ask=None) -> dict:
    """Ordnet im Ordner zu und schreibt die Datenbank. Gibt eine Zusammenfassung zurück."""
    db = find_database(folder)
    if db is None:
        return {"folder": str(folder), "skipped": "keine database*.json"}
    data = load(db)
    files = audio_files(folder)
    free_files, free_cards = free_files_and_cards(data, files)
    summary = {"folder": str(folder), "free_files": len(free_files), "assigned": {}, "left": []}
    if not free_files:
        return summary
    assigned = exact_matches(data, free_files, free_cards)
    rest_files = [f for f in free_files if f not in assigned]
    rest_cards = [i for i in free_cards if i not in assigned.values()]
    if use_ai and rest_files and rest_cards:
        ask = ask or _gemini
        try:
            answer = ask(SYSTEM, build_prompt(data, rest_files, rest_cards))
            assigned.update(validate(answer, rest_files, rest_cards))
        except Exception as error:  # KI-Ausfall darf die exakten Treffer nicht verhindern
            summary["ki_fehler"] = str(error)
    for file, card in sorted(assigned.items(), key=lambda kv: kv[1]):
        summary["assigned"][file] = {"karte": card, "vokabel": data[card].get("vocabulary", ""), "vorher": data[card].get("audio", "")}
        if not dry_run:
            data[card]["audio"] = file
    summary["left"] = [f for f in free_files if f not in assigned]
    if assigned and not dry_run:
        save(db, data)
    return summary


def _gemini(system: str, user: str) -> dict:
    from ki_issue import ask_gemini

    if not os.environ.get("GEMINI_API_KEY"):
        raise RuntimeError("Kein GEMINI_API_KEY gesetzt")
    return ask_gemini(system, user)


def report(results: list[dict]) -> str:
    lines = ["## Audio-Zuordnung", ""]
    for r in results:
        lines.append(f"### {r['folder']}")
        if r.get("skipped"):
            lines += [f"Übersprungen: {r['skipped']}", ""]
            continue
        lines.append(f"Neue Dateien ohne Karte: {r['free_files']}")
        for file, info in r["assigned"].items():
            lines.append(f"- `{file}` → **{info['vokabel']}** (vorher: `{info['vorher']}`)")
        if r.get("ki_fehler"):
            lines.append(f"- ⚠️ KI nicht erreichbar: {r['ki_fehler']}")
        for file in r["left"]:
            lines.append(f"- ❓ nicht zugeordnet: `{file}`")
        lines.append("")
    return "\n".join(lines)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("folders", nargs="*", help="Lektionsordner (Standard: alle unter lektionen/)")
    parser.add_argument("--dry-run", action="store_true", help="nichts schreiben, nur anzeigen")
    parser.add_argument("--no-ai", action="store_true", help="nur exakte Namenstreffer, kein Gemini")
    args = parser.parse_args()
    folders = [Path(f) for f in args.folders] or sorted((ROOT / "lektionen").iterdir())
    results = [process(f, use_ai=not args.no_ai, dry_run=args.dry_run) for f in folders if f.is_dir()]
    text = report(results)
    print(text)
    summary_file = os.environ.get("GITHUB_STEP_SUMMARY")
    if summary_file:
        with open(summary_file, "a", encoding="utf-8") as handle:
            handle.write(text + "\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
