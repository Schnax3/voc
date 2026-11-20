#!/usr/bin/env python3
"""Audio-Schneider: eine lange Aufnahme per Tastendruck in einzelne Vokabeln zerlegen.

Ablauf: Aufnahme laden, abspielen, an der Schnittstelle S drücken. Das Stück vor dem
Schnitt wird ausgeschnitten, per Spracherkennung (Whisper) benannt und als MP3 im
Zielordner gespeichert. In der Timeline ist es danach weg, es geht direkt weiter.

Start:   python scripts/audio_schneider/schneider.py --out lektionen/dec3-u2-a
Benötigt: ffmpeg im PATH; für die Spracherkennung `pip install faster-whisper`.
"""
import argparse
import json
import re
import shutil
import subprocess
import sys
import tempfile
import threading
import webbrowser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

HERE = Path(__file__).resolve().parent
FORBIDDEN = re.compile(r'[<>:"/\\|?*\x00-\x1f]')
STRIP = " .,!?;:…-–—«»\"'`"


FFMPEG_HELP = ("ffmpeg wurde nicht gefunden. Installieren: in PowerShell `winget install ffmpeg`, danach das "
               "Terminal schließen, ein neues öffnen und das Programm erneut starten.")


def run_ffmpeg(args):
    """Startet ffmpeg; gibt eine verständliche Meldung, wenn es nicht installiert oder nicht im PATH ist."""
    exe = shutil.which("ffmpeg")
    if not exe:
        raise RuntimeError(FFMPEG_HELP)
    return subprocess.run([exe, *args], capture_output=True, text=True)


def clean_name(text):
    """Macht aus erkanntem Text einen sicheren Dateinamen (ohne Endung)."""
    t = (text or "").replace("’", "'").replace("‘", "'")
    t = FORBIDDEN.sub(" ", t)
    t = re.sub(r"\s+", " ", t).strip(STRIP)
    return t[:100].strip(STRIP)


def unique_path(folder, name, ext=".mp3", ignore=None):
    """Hängt ' 2', ' 3' … an, wenn der Name schon vergeben ist."""
    p = folder / (name + ext)
    n = 2
    while p.exists() and p != ignore:
        p = folder / f"{name} {n}{ext}"
        n += 1
    return p


def chunks_from_silences(starts, ends, total, min_len=0.12, pad=0.05):
    """Teilt ein Stück an Sprechpausen in Abschnitte (Anfang, Ende) in Sekunden."""
    ends = list(ends)
    if len(starts) > len(ends):
        ends.append(total)
    chunks, pos = [], 0.0
    for a, b in zip(starts, ends):
        a = max(0.0, a)
        if a - pos >= min_len:
            chunks.append((max(0.0, pos - pad), min(total, a + pad)))
        pos = max(pos, b)
    if total - pos >= min_len:
        chunks.append((max(0.0, pos - pad), total))
    return chunks or [(0.0, total)]


class Whisper:
    """faster-whisper, lazy geladen. Fällt bei GPU-Problemen auf CPU zurück."""

    def __init__(self, model="large-v3-turbo", lang="fr", other="de"):
        self.model_name, self.lang, self.other = model, lang, other
        self.model = None
        self.ready = False
        self.error = None
        self.lock = threading.Lock()

    def load(self, device="auto", model=None):
        from faster_whisper import WhisperModel
        compute = "int8" if device == "cpu" else "auto"
        self.model = WhisperModel(model or self.model_name, device=device, compute_type=compute)
        self.ready = True

    def preload(self):
        try:
            self.load()
        except Exception as e:  # noqa: BLE001
            self.error = f"Whisper konnte nicht geladen werden: {e}"
            print(self.error, file=sys.stderr)

    def _transcribe(self, path, lang):
        segs, info = self.model.transcribe(str(path), language=lang, beam_size=5,
                                           condition_on_previous_text=False)
        return " ".join(x.text.strip() for x in segs).strip(), info

    def _classify(self, path):
        """Gibt (Sprache, Text) für einen Abschnitt zurück, entschieden nur zwischen Zielsprache und Muttersprache."""
        text, info = self._transcribe(path, None)
        probs = dict(getattr(info, "all_language_probs", None) or [])
        if self.lang in probs or self.other in probs:
            lang = self.lang if probs.get(self.lang, 0) >= probs.get(self.other, 0) else self.other
        else:
            lang = info.language
        if lang != info.language:
            text, _ = self._transcribe(path, lang)
        return lang, text

    def _french(self, chunks):
        for a, b, path in chunks:
            lang, text = self._classify(path)
            if lang == self.lang and text:
                return text, [(a, b)]
        return "", []

    def __call__(self, path, chunks=None):
        """Findet im Stück den ersten französischen Abschnitt. Gibt (Text, [(Anfang, Ende)]) zurück."""
        chunks = chunks or [(0.0, 0.0, path)]
        with self.lock:
            if self.model is None:
                if self.error:
                    return "", []
                self.load()
            try:
                return self._french(chunks)
            except Exception as e:  # noqa: BLE001  (z. B. fehlende CUDA-Bibliotheken)
                print(f"GPU/Modell-Fehler ({e}); wechsle zur CPU mit Modell 'small'.", file=sys.stderr)
                self.load(device="cpu", model="small")
                return self._french(chunks)


class FakeStt:
    """Für Tests: liefert 'Mot 1', 'Mot 2' … (Bereiche None = ganzes Stück)."""

    wants_chunks = False

    def __init__(self):
        self.n = 0
        self.ready = True
        self.error = None

    def __call__(self, path, chunks=None):
        self.n += 1
        return f"Mot {self.n}", None


class Cutter:
    def __init__(self, out_dir, stt=None, work_dir=None):
        self.out = Path(out_dir)
        self.out.mkdir(parents=True, exist_ok=True)
        self.work = Path(work_dir or tempfile.mkdtemp(prefix="audio-schneider-"))
        self.stt = stt
        self.lock = threading.Lock()
        self.source = None

    def save_upload(self, name, data):
        ext = Path(name).suffix.lower() or ".bin"
        self.source = self.work / f"quelle{ext}"
        self.source.write_bytes(data)
        return self.source

    def _ffmpeg(self, src, dest, start=None, end=None, af=None, mp3=False):
        cmd = ["-y", "-v", "error"]
        if start is not None:
            cmd += ["-ss", f"{start:.3f}"]
        if end is not None:
            cmd += ["-to", f"{end:.3f}"]
        cmd += ["-i", str(src), "-vn"]
        if af:
            cmd += ["-af", af]
        cmd += ["-ac", "1"] + (["-c:a", "libmp3lame", "-q:a", "3"] if mp3 else ["-c:a", "pcm_s16le", "-ar", "16000"])
        cmd.append(str(dest))
        r = run_ffmpeg(cmd)
        if r.returncode != 0 or not Path(dest).exists() or Path(dest).stat().st_size == 0:
            raise RuntimeError(r.stderr.strip() or "ffmpeg lieferte keine Datei")

    def _duration(self, path):
        r = run_ffmpeg(["-i", str(path), "-f", "null", "-"])
        m = re.search(r"Duration: (\d+):(\d+):(\d+(?:\.\d+)?)", r.stderr)
        if not m:
            raise RuntimeError("Dauer des Stücks konnte nicht ermittelt werden")
        return int(m.group(1)) * 3600 + int(m.group(2)) * 60 + float(m.group(3))

    def _chunks(self, wav, tag):
        total = self._duration(wav)
        r = run_ffmpeg(["-v", "info", "-i", str(wav), "-af", "silencedetect=noise=-38dB:d=0.3", "-f", "null", "-"])
        starts = [float(x) for x in re.findall(r"silence_start: (-?[\d.]+)", r.stderr)]
        ends = [float(x) for x in re.findall(r"silence_end: ([\d.]+)", r.stderr)]
        out = []
        for i, (a, b) in enumerate(chunks_from_silences(starts, ends, total)):
            p = self.work / f"{tag}-teil{i}.wav"
            self._ffmpeg(wav, p, a, b)
            out.append((a, b, p))
        return out

    def cut(self, start, end, trim=True, french_only=False):
        if self.source is None:
            raise RuntimeError("Noch keine Aufnahme geladen")
        if not end > start:
            raise ValueError("Ende liegt vor dem Anfang")
        tag = f"schnitt-{threading.get_ident()}-{abs(hash((start, end)))}"
        wav, tmp = self.work / f"{tag}.wav", self.work / f"{tag}.mp3"
        sil = "silenceremove=start_periods=1:start_threshold=-45dB:start_silence=0.06"
        self._ffmpeg(self.source, wav, start, end, af=f"{sil},areverse,{sil},areverse" if trim else None)
        text, ranges, parts = "", None, []
        if self.stt is not None:
            try:
                parts = self._chunks(wav, tag) if getattr(self.stt, "wants_chunks", True) else []
                text, ranges = self.stt(wav, parts)
            except Exception as e:  # noqa: BLE001
                print(f"Spracherkennung fehlgeschlagen: {e}", file=sys.stderr)
        if french_only and ranges:
            a, b = min(r[0] for r in ranges), max(r[1] for r in ranges)
            self._ffmpeg(wav, tmp, a, b, mp3=True)
        else:
            self._ffmpeg(wav, tmp, mp3=True)
        for f in [wav] + [p[2] for p in parts]:
            f.unlink(missing_ok=True)
        name = clean_name(text)
        with self.lock:
            if not name:
                n = 1
                while (self.out / f"Segment {n}.mp3").exists():
                    n += 1
                name = f"Segment {n}"
            dest = unique_path(self.out, name)
            tmp.replace(dest)
        return {"name": dest.stem, "text": text.strip()}

    def _file(self, name):
        return self.out / (Path(name).name + ".mp3")

    def rename(self, old, new):
        new = clean_name(new)
        if not new:
            raise ValueError("Leerer Name")
        src = self._file(old)
        if not src.exists():
            raise FileNotFoundError(old)
        with self.lock:
            dest = unique_path(self.out, new, ignore=src)
            src.replace(dest)
        return dest.stem

    def delete(self, name):
        p = self._file(name)
        if p.exists():
            p.unlink()
        return True


def make_handler(cutter, info):
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *a):
            pass

        def _send(self, code, body=b"", ctype="application/json"):
            self.send_response(code)
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(body)

        def _json(self, obj, code=200):
            self._send(code, json.dumps(obj, ensure_ascii=False).encode())

        def do_GET(self):
            u = urlparse(self.path)
            if u.path in ("/", "/index.html"):
                self._send(200, (HERE / "index.html").read_bytes(), "text/html; charset=utf-8")
            elif u.path == "/favicon.ico":
                self._send(204)
            elif u.path == "/info":
                stt = cutter.stt
                self._json({"out": str(cutter.out), "stt": info["stt"],
                            "ready": bool(getattr(stt, "ready", True)) if stt else True,
                            "error": getattr(stt, "error", None)})
            elif u.path == "/clip":
                name = parse_qs(u.query).get("name", [""])[0]
                p = cutter._file(name)
                if p.exists():
                    self._send(200, p.read_bytes(), "audio/mpeg")
                else:
                    self._send(404)
            else:
                self._send(404)

        def do_POST(self):
            u = urlparse(self.path)
            n = int(self.headers.get("Content-Length") or 0)
            raw = self.rfile.read(n) if n else b""
            try:
                if u.path == "/upload":
                    name = parse_qs(u.query).get("name", ["quelle"])[0]
                    cutter.save_upload(name, raw)
                    return self._json({"ok": True})
                data = json.loads(raw or b"{}")
                if u.path == "/cut":
                    return self._json(cutter.cut(float(data["start"]), float(data["end"]),
                                                 bool(data.get("trim", True)), bool(data.get("french_only", False))))
                if u.path == "/rename":
                    return self._json({"name": cutter.rename(data["name"], data["new"])})
                if u.path == "/delete":
                    return self._json({"ok": cutter.delete(data["name"])})
                self._send(404)
            except Exception as e:  # noqa: BLE001
                self._json({"error": str(e)}, 400)

    return Handler


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--out", default="ausschnitte", help="Zielordner für die MP3-Dateien (z. B. der Lektionsordner)")
    ap.add_argument("--stt", default="whisper", choices=["whisper", "none", "fake"],
                    help="Spracherkennung: whisper (Standard), none (Namen später von Hand) oder fake (Test)")
    ap.add_argument("--model", default="large-v3-turbo", help="Whisper-Modell, z. B. small, medium, large-v3-turbo")
    ap.add_argument("--lang", default="fr", help="Sprache der Vokabeln (Standard fr)")
    ap.add_argument("--other-lang", default="de", help="Zweite Sprache in der Aufnahme (Standard de)")
    ap.add_argument("--port", type=int, default=8765)
    ap.add_argument("--no-browser", action="store_true")
    a = ap.parse_args(argv)

    if not shutil.which("ffmpeg"):
        print("\nACHTUNG: " + FFMPEG_HELP + "\n", file=sys.stderr)
    stt = None
    if a.stt == "whisper":
        stt = Whisper(a.model, a.lang, a.other_lang)
        threading.Thread(target=stt.preload, daemon=True).start()
    elif a.stt == "fake":
        stt = FakeStt()
    cutter = Cutter(a.out, stt)
    server = ThreadingHTTPServer(("127.0.0.1", a.port), make_handler(cutter, {"stt": a.stt}))
    url = f"http://127.0.0.1:{a.port}/"
    print(f"Audio-Schneider läuft: {url}\nZielordner: {cutter.out.resolve()}\nBeenden mit Strg+C")
    if not a.no_browser:
        webbrowser.open(url)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
