#!/usr/bin/env python3
"""Download vocabulary pages listed in sources.csv and create app-compatible JSON."""

from __future__ import annotations

import csv
import hashlib
import json
import re
import sys
from dataclasses import dataclass, field
from html.parser import HTMLParser
from pathlib import Path
from typing import Iterator
from urllib.error import URLError
from urllib.parse import unquote, urljoin, urlparse
from urllib.request import Request, urlopen

ROOT = Path(__file__).resolve().parents[1]
SOURCES_FILE = ROOT / "sources.csv"
MAX_RESPONSE_BYTES = 20 * 1024 * 1024
REQUEST_TIMEOUT_SECONDS = 30
VOID_TAGS = {"area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr"}


@dataclass
class Element:
    tag: str
    attrs: dict[str, str]
    children: list[Element | str] = field(default_factory=list)

    @property
    def classes(self) -> set[str]:
        return set(self.attrs.get("class", "").split())


class PageParser(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.root = Element("document", {})
        self.stack = [self.root]

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        element = Element(tag, {key: value or "" for key, value in attrs})
        self.stack[-1].children.append(element)
        if tag not in VOID_TAGS:
            self.stack.append(element)

    def handle_startendtag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        element = Element(tag, {key: value or "" for key, value in attrs})
        self.stack[-1].children.append(element)

    def handle_endtag(self, tag: str) -> None:
        for index in range(len(self.stack) - 1, 0, -1):
            if self.stack[index].tag == tag:
                del self.stack[index:]
                return

    def handle_data(self, data: str) -> None:
        self.stack[-1].children.append(data)


def descendants(element: Element, class_name: str | None = None, tag: str | None = None) -> Iterator[Element]:
    for child in element.children:
        if not isinstance(child, Element):
            continue
        if (class_name is None or class_name in child.classes) and (tag is None or child.tag == tag):
            yield child
        yield from descendants(child, class_name, tag)


def text_content(element: Element) -> str:
    return "".join(
        child if isinstance(child, str) else text_content(child)
        for child in element.children
    )


def clean_text(value: str) -> str:
    value = re.sub(r"\s+", " ", value).strip()
    return re.sub(r"\s+([,.;:!?])", r"\1", value)


def _is_word_character(character: str) -> bool:
    return character.isalnum() or character in {"'", "’"}


def vocabulary_text(answer: str, secrets: list[Element]) -> str:
    full_answer = clean_text(text_content(answer))
    terms = []
    search_from = 0

    for secret in secrets:
        term = clean_text(text_content(secret))
        start = full_answer.find(term, search_from)
        if not term or start < 0:
            raise ValueError(f"Vokabel konnte nicht im Antworttext gefunden werden: {term!r}")

        end = start + len(term)
        while start > 0 and _is_word_character(full_answer[start - 1]) and _is_word_character(full_answer[start]):
            start -= 1
        while end < len(full_answer) and _is_word_character(full_answer[end - 1]) and _is_word_character(full_answer[end]):
            end += 1
        terms.append(full_answer[start:end])
        search_from = end

    if not terms:
        raise ValueError("Keine markierte Vokabel (.secret) in der Antwort gefunden.")
    return clean_text(" ".join(terms))


def _resolve_asset(value: str, source_url: str) -> str | None:
    if not value:
        return None
    return urljoin(source_url, value)


def parse_vocabulary_html(html: str, source_url: str) -> list[dict[str, str | None]]:
    parser = PageParser()
    parser.feed(html)

    rows = list(descendants(parser.root, "row"))
    if not rows:
        raise ValueError("Die HTML-Seite enthält keine erkennbaren Vokabelzeilen (.row).")

    vocabulary = []
    for row_number, row in enumerate(rows, start=1):
        question = next(descendants(row, "question"), None)
        answer = next(descendants(row, "answer"), None)
        translation = next(descendants(question, "content"), None) if question else None
        german = clean_text(text_content(translation)) if translation else ""
        french = clean_text(text_content(answer)) if answer else ""
        marked_terms = [
            element for element in descendants(answer)
            if element.classes & {"secret", "extra"}
        ] if answer else []

        if not german and not french:
            continue
        if not german or not french:
            raise ValueError(f"Vokabelzeile {row_number}: deutsche Übersetzung oder französische Antwort fehlt.")

        image_element = next(descendants(question, tag="img"), None) if question else None
        image = _resolve_asset(
            (image_element.attrs.get("src") or image_element.attrs.get("data-src", "")) if image_element else "",
            source_url,
        )
        audio_element = next(descendants(row, tag="audio"), None)
        audio_source = audio_element.attrs.get("src", "") if audio_element else ""
        if not audio_source:
            source_element = next(descendants(row, tag="source"), None)
            audio_source = source_element.attrs.get("src", "") if source_element else ""
        audio = _resolve_asset(audio_source, source_url)

        try:
            term = vocabulary_text(answer, marked_terms)
        except ValueError as error:
            raise ValueError(f"Vokabelzeile {row_number}: {error}") from error

        vocabulary.append({
            "french": french,
            "german": german,
            "vocabulary": term,
            "image": image,
            "audio": audio,
        })

    if not vocabulary:
        raise ValueError("Die HTML-Seite enthält keine auswertbaren Vokabeleinträge.")
    return vocabulary


def read_sources(path: Path) -> list[tuple[str, str, bool]]:
    lines = [
        line for line in path.read_text(encoding="utf-8-sig").splitlines()
        if line.strip() and not line.lstrip().startswith("#")
    ]
    reader = csv.DictReader(lines)
    if reader.fieldnames != ["folder", "url", "merge_existing"]:
        raise ValueError("sources.csv muss die Kopfzeile 'folder,url,merge_existing' enthalten.")

    sources = []
    for line_number, row in enumerate(reader, start=2):
        folder = (row.get("folder") or "").strip()
        url = (row.get("url") or "").strip()
        merge_existing = (row.get("merge_existing") or "").strip().lower()
        if not folder or not url:
            raise ValueError(f"sources.csv, Zeile {line_number}: folder und url sind erforderlich.")
        if folder.startswith(".") or folder in {".", ".."} or "/" in folder or "\\" in folder:
            raise ValueError(f"sources.csv, Zeile {line_number}: folder muss ein einfacher Ordnername sein.")
        if urlparse(url).scheme.lower() != "https":
            raise ValueError(f"sources.csv, Zeile {line_number}: nur HTTPS-URLs sind erlaubt.")
        if merge_existing not in {"true", "false"}:
            raise ValueError(f"sources.csv, Zeile {line_number}: merge_existing muss true oder false sein.")
        sources.append((folder, url, merge_existing == "true"))
    return sources


def _decode_response(body: bytes, content_type: str) -> str:
    charset_match = re.search(r"charset\s*=\s*[\"']?([\w.-]+)", content_type, re.IGNORECASE)
    charset = charset_match.group(1) if charset_match else "utf-8"
    try:
        return body.decode(charset)
    except (LookupError, UnicodeDecodeError):
        try:
            return body.decode("utf-8-sig")
        except UnicodeDecodeError:
            # Legacy lesson pages can contain stray bytes outside the Windows-1252 table.
            return body.decode("cp1252", errors="replace")


def download(url: str) -> tuple[bytes, str]:
    request = Request(url, headers={"User-Agent": "voc-vocabulary-import/1.0"})
    with urlopen(request, timeout=REQUEST_TIMEOUT_SECONDS) as response:
        body = response.read(MAX_RESPONSE_BYTES + 1)
        if len(body) > MAX_RESPONSE_BYTES:
            raise ValueError(f"HTML-Datei ist größer als {MAX_RESPONSE_BYTES // (1024 * 1024)} MB: {url}")
        return body, _decode_response(body, response.headers.get("Content-Type", ""))


def html_filename(url: str) -> str:
    candidate = unquote(Path(urlparse(url).path).name)
    candidate = re.sub(r"[^\w.-]", "-", candidate, flags=re.UNICODE).strip(".-")
    if not candidate:
        candidate = "source.html"
    if not candidate.lower().endswith(".html"):
        candidate += ".html"
    return candidate


def _prepare_outputs(
    sources: list[tuple[str, str, bool]],
) -> dict[str, tuple[dict[str, bytes], list[dict[str, str | None]], list[str], bool]]:
    grouped: dict[str, tuple[bool, list[str]]] = {}
    for folder, url, merge_existing in sources:
        if folder in grouped and grouped[folder][0] != merge_existing:
            raise ValueError(f"{folder}: merge_existing muss für alle Quellen im Ordner gleich sein.")
        urls = grouped.setdefault(folder, (merge_existing, []))[1]
        urls.append(url)

    outputs = {}
    for folder, (merge_existing, urls) in grouped.items():
        html_files: dict[str, bytes] = {}
        records: list[dict[str, str | None]] = []
        seen_records = set()
        seen_urls = set()
        for url in urls:
            if url in seen_urls:
                continue
            seen_urls.add(url)
            body, html = download(url)
            name = html_filename(url)
            if name in html_files:
                suffix = hashlib.sha256(url.encode("utf-8")).hexdigest()[:8]
                stem, extension = name.rsplit(".", 1)
                name = f"{stem}-{suffix}.{extension}"
            html_files[name] = body
            for record in parse_vocabulary_html(html, url):
                key = (record["french"], record["german"], record["vocabulary"])
                if key not in seen_records:
                    records.append(record)
                    seen_records.add(key)
        outputs[folder] = (html_files, records, sorted(seen_urls), merge_existing)
    return outputs


def merge_records(
    existing: list[dict[str, str | None]],
    incoming: list[dict[str, str | None]],
) -> list[dict[str, str | None]]:
    merged = list(existing)
    existing_prompts = {
        clean_text(str(record.get("german") or "")).casefold()
        for record in existing
        if record.get("german")
    }
    for record in incoming:
        prompt = clean_text(str(record.get("german") or "")).casefold()
        if prompt and prompt not in existing_prompts:
            merged.append(record)
            existing_prompts.add(prompt)
    return merged


def _write_outputs(
    outputs: dict[str, tuple[dict[str, bytes], list[dict[str, str | None]], list[str], bool]],
) -> None:
    merge_targets: dict[str, tuple[Path, list[dict[str, str | None]]]] = {}
    for folder, (html_files, records, urls, merge_existing) in outputs.items():
        directory = ROOT / folder
        manifest_path = directory / ".vocabulary-import.json"
        existing_databases = sorted(directory.glob("database*.json")) if directory.exists() else []
        if merge_existing:
            if len(existing_databases) != 1:
                raise ValueError(
                    f"{directory.relative_to(ROOT)} muss genau eine vorhandene database*.json-Datei "
                    "für das Zusammenführen enthalten."
                )
            database_path = existing_databases[0]
            try:
                existing_records = json.loads(database_path.read_text(encoding="utf-8-sig"))
            except json.JSONDecodeError as error:
                raise ValueError(f"{database_path.relative_to(ROOT)} enthält kein gültiges JSON.") from error
            if not isinstance(existing_records, list) or not all(isinstance(record, dict) for record in existing_records):
                raise ValueError(f"{database_path.relative_to(ROOT)} muss eine JSON-Liste von Vokabeleinträgen enthalten.")
            merge_targets[folder] = (database_path, existing_records)
        elif existing_databases and not manifest_path.exists():
            raise ValueError(
                f"{directory.relative_to(ROOT)} enthält bereits JSON-Dateien. "
                "Setze merge_existing nur für passende Vokabelmodule auf true."
            )
        elif any(path.name != "database.json" for path in existing_databases):
            raise ValueError(f"{directory.relative_to(ROOT)} enthält eine nicht verwaltete database*.json-Datei.")

    for folder, (html_files, records, urls, merge_existing) in outputs.items():
        directory = ROOT / folder
        directory.mkdir(parents=True, exist_ok=True)
        for name, body in html_files.items():
            (directory / name).write_bytes(body)
        if merge_existing:
            database_path, existing_records = merge_targets[folder]
            records = merge_records(existing_records, records)
        else:
            database_path = directory / "database.json"
        database_path.write_text(json.dumps(records, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        (directory / ".vocabulary-import.json").write_text(
            json.dumps({"generated_by": "scripts/import_vocabulary.py", "sources": urls}, ensure_ascii=False, indent=2) + "\n",
            encoding="utf-8",
        )
        print(f"{folder}: {len(records)} Vokabeln, {len(html_files)} HTML-Datei(en)")


def main() -> None:
    sources = read_sources(SOURCES_FILE)
    if not sources:
        print("Keine Quellen in sources.csv eingetragen.")
        return
    outputs = _prepare_outputs(sources)
    _write_outputs(outputs)


if __name__ == "__main__":
    try:
        main()
    except (OSError, URLError, ValueError) as error:
        sys.exit(f"Vokabelimport fehlgeschlagen: {error}")
