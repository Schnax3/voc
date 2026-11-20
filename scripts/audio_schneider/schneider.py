#!/usr/bin/env python3
"""Audio-Schneider: eine lange Aufnahme per Tastendruck in einzelne Vokabeln zerlegen.

Ablauf: Aufnahme laden, abspielen, an der Schnittstelle S drücken. Das Stück vor dem
Schnitt wird ausgeschnitten, per Spracherkennung (Whisper) benannt und als MP3 im
Zielordner gespeichert. In der Timeline ist es danach weg, es geht direkt weiter.

Start:   python scripts/audio_schneider/schneider.py --out lektionen/dec2-u7a
Benötigt: ffmpeg im PATH; für die Spracherkennung `pip install faster-whisper`.
"""
import argparse
import ctypes
import json
import math
import mimetypes
import os
import re
import subprocess
import sys
import tempfile
import threading
import time
import traceback
import uuid
import webbrowser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.parse import parse_qs, quote, urljoin, urlparse
from urllib.request import Request, urlopen

HERE = Path(__file__).resolve().parent
FORBIDDEN = re.compile(r'[<>:"/\\|?*\x00-\x1f]')
STRIP = " .,!?;:…-–—«»\"'`"
_CUDA_DLL_HANDLES = []
_CUDA_DLL_DIRECTORIES = set()


def default_seedvc_reference_dir():
    local_app_data = os.environ.get("LOCALAPPDATA")
    if local_app_data:
        return Path(local_app_data) / "Audio-Schneider"
    data_home = os.environ.get("XDG_DATA_HOME")
    return Path(data_home) / "Audio-Schneider" if data_home else Path.home() / ".local" / "share" / "Audio-Schneider"


def _prepare_cuda_dll_search():
    if os.name != "nt" or not hasattr(os, "add_dll_directory"):
        return

    directories = []
    configured = os.environ.get("AUDIO_SCHNEIDER_CUDA_PATH")
    if configured:
        root = Path(configured)
        directories.extend((root, root / "bin"))

    local_root = Path(os.environ.get("LOCALAPPDATA", Path.home())) / "Audio-Schneider" / "cuda-runtime"
    directories.append(local_root)
    if local_root.is_dir():
        for dll in ("cublas64_12.dll", "cudnn64_9.dll"):
            directories.extend(path.parent for path in local_root.rglob(dll))

    cuda_path = os.environ.get("CUDA_PATH")
    if cuda_path:
        directories.append(Path(cuda_path) / "bin")
    cuda_root = Path(os.environ.get("ProgramFiles", r"C:\Program Files")) / "NVIDIA GPU Computing Toolkit" / "CUDA"
    if cuda_root.is_dir():
        directories.extend(path / "bin" for path in cuda_root.iterdir() if path.is_dir())

    nvidia_packages = Path(sys.prefix) / "Lib" / "site-packages" / "nvidia"
    if nvidia_packages.is_dir():
        directories.extend(path / "bin" for path in nvidia_packages.iterdir() if path.is_dir())

    for directory in directories:
        if not directory.is_dir():
            continue
        normalized = str(directory.resolve()).casefold()
        if normalized in _CUDA_DLL_DIRECTORIES:
            continue
        try:
            _CUDA_DLL_HANDLES.append(os.add_dll_directory(normalized))
            _CUDA_DLL_DIRECTORIES.add(normalized)
        except OSError:
            continue


def _cuda_runtime_error():
    if os.name != "nt":
        return None
    _prepare_cuda_dll_search()
    for dll in ("cublas64_12.dll", "cudnn64_9.dll"):
        try:
            _CUDA_DLL_HANDLES.append(ctypes.WinDLL(dll))
        except OSError as exc:
            return f"{dll} kann nicht geladen werden: {exc}"
    return None


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


def _ensure_av_metadata_compat():
    """Sichert av.open ab, falls eine PyAV-Version metadata_errors nicht akzeptiert."""
    try:
        import av
    except ImportError:
        return
    if getattr(av.open, "_patched_metadata_errors", False):
        return
    orig_open = av.open

    def open_compat(*args, **kwargs):
        try:
            return orig_open(*args, **kwargs)
        except TypeError as exc:
            if "metadata_errors" in kwargs and "metadata_errors" in str(exc):
                kwargs.pop("metadata_errors", None)
                return orig_open(*args, **kwargs)
            raise

    open_compat._patched_metadata_errors = True
    av.open = open_compat


class Whisper:
    """faster-whisper, lazy geladen. Fällt bei GPU-Problemen auf CPU zurück."""

    def __init__(self, model="large-v3-turbo", lang="fr", other="de"):
        self.model_name, self.lang, self.other = model, lang, other
        self.model = None
        self.active_model, self.active_device = model, "auto"
        self.ready = False
        self.error = None
        self.gpu_error = None
        self.fallback_reason = None
        self.last_debug = None
        self.lock = threading.Lock()

    def load(self, device="auto", model=None):
        _prepare_cuda_dll_search()
        _ensure_av_metadata_compat()
        import ctranslate2
        from faster_whisper import WhisperModel
        selected_model = model or self.model_name
        active_device = device
        if device == "auto":
            active_device = "cuda" if ctranslate2.get_cuda_device_count() else "cpu"
        compute = "int8" if active_device == "cpu" else "auto"
        self.model = WhisperModel(selected_model, device=device, compute_type=compute)
        self.active_model, self.active_device = selected_model, active_device
        self.ready = True
        self.error = None

    def preload(self):
        try:
            self.gpu_error = _cuda_runtime_error()
            if self.gpu_error:
                self.fallback_reason = self.gpu_error
                print(f"GPU-Laufzeit nicht verfügbar ({self.gpu_error}); starte CPU mit Modell 'small'.",
                      file=sys.stderr)
                self.load(device="cpu", model="small")
            else:
                try:
                    self.load()
                except Exception as e:  # noqa: BLE001
                    self.gpu_error = str(e)
                    self.fallback_reason = self.gpu_error
                    print(f"GPU-Modell konnte nicht gestartet werden ({e}); starte CPU mit Modell 'small'.",
                          file=sys.stderr)
                    self.load(device="cpu", model="small")
        except Exception as e:  # noqa: BLE001
            self.error = f"Whisper konnte auch auf der CPU nicht geladen werden: {e}"
            print(self.error, file=sys.stderr)
            traceback.print_exc()

    def _transcribe(self, path, lang, progress=None):
        beam_size = 1 if self.active_device == "cpu" else 5
        segs, info = self.model.transcribe(str(path), language=lang, beam_size=beam_size,
                                           condition_on_previous_text=False)
        texts = []
        for index, segment in enumerate(segs, 1):
            texts.append(segment.text.strip())
            if progress:
                progress("whisper_decode", f"Whisper hat Textsegment {index} verarbeitet")
        return " ".join(texts).strip(), info

    def _classify(self, path, progress=None, force_language=False):
        """Gibt (Sprache, Text) für einen Abschnitt zurück, entschieden nur zwischen Zielsprache und Muttersprache."""
        if force_language:
            if progress:
                progress("whisper_forced_language", f"Whisper transkribiert gezielt auf {self.lang}")
            text, _ = self._transcribe(path, self.lang, progress)
            if progress:
                progress("whisper_language", f"Erzwungene Sprache: {self.lang}")
            return self.lang, text
        text, info = self._transcribe(path, None, progress)
        probs = dict(getattr(info, "all_language_probs", None) or [])
        if self.lang in probs or self.other in probs:
            lang = self.lang if probs.get(self.lang, 0) >= probs.get(self.other, 0) else self.other
        else:
            lang = info.language
        if progress:
            progress("whisper_language", f"Sprachentscheidung: {lang}")
        if lang != info.language:
            if progress:
                progress("whisper_retry", f"Abschnitt wird gezielt mit Sprache {lang} transkribiert")
            text, _ = self._transcribe(path, lang, progress)
        return lang, text

    def _french(self, chunks, progress=None, force_language=False):
        indexed_chunks = list(enumerate(chunks))
        if force_language:
            indexed_chunks.reverse()
        for attempt, (i, (a, b, path)) in enumerate(indexed_chunks, 1):
            if progress:
                progress("whisper_chunk", f"Whisper analysiert Teil {attempt}/{len(chunks)}",
                         start=round(a, 2), end=round(b, 2), index=i + 1, attempt=attempt, total=len(chunks))
            lang, text = self._classify(path, progress, force_language)
            outcome = "accepted" if lang == self.lang and text else "empty" if not text else "other_language"
            self.last_debug["chunks"].append({
                "index": i, "start": round(a, 2), "end": round(b, 2),
                "language": lang, "characters": len(text), "outcome": outcome,
            })
            if progress:
                progress("whisper_chunk_done", f"Teil {attempt}/{len(chunks)}: {lang}, {len(text)} Zeichen",
                         index=i + 1, attempt=attempt, total=len(chunks), language=lang,
                         characters=len(text), outcome=outcome)
            if lang == self.lang and text:
                return text, [(a, b)]
        return "", []

    def __call__(self, path, chunks=None, progress=None, force_language=False):
        """Findet im Stück den ersten französischen Abschnitt. Gibt (Text, [(Anfang, Ende)]) zurück."""
        chunks = chunks or [(0.0, 0.0, path)]
        with self.lock:
            self.last_debug = {
                "model": self.active_model, "device": self.active_device,
                "fallback": ({
                    "reason": self.fallback_reason, "device": "cpu", "model": "small",
                } if self.fallback_reason else None),
                "chunks": [],
            }
            if self.model is None:
                if self.error:
                    self.last_debug["error"] = self.error
                    return "", []
                self.load()
            try:
                return self._french(chunks, progress, force_language)
            except Exception as e:  # noqa: BLE001  (z. B. fehlende CUDA-Bibliotheken)
                print(f"GPU/Modell-Fehler ({e}); wechsle zur CPU mit Modell 'small'.", file=sys.stderr)
                self.gpu_error = str(e)
                self.fallback_reason = str(e)
                self.last_debug["fallback"] = {
                    "reason": str(e), "device": "cpu", "model": "small",
                }
                try:
                    self.load(device="cpu", model="small")
                    self.last_debug["model"] = self.active_model
                    self.last_debug["device"] = self.active_device
                    self.last_debug["chunks"] = []
                    if progress:
                        progress("whisper_fallback", "Whisper wechselt auf CPU-Modell small")
                    return self._french(chunks, progress, force_language)
                except Exception as fallback_error:  # noqa: BLE001
                    self.last_debug["error"] = str(fallback_error)
                    print(f"CPU-Fallback fehlgeschlagen: {fallback_error}", file=sys.stderr)
                    raise


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


class SeedVCClient:
    """Lokaler HTTP-Client für die dokumentierte Seed-VC-Gradio-API."""

    def __init__(self, timeout=600):
        self.timeout = timeout
        self.lock = threading.Lock()

    def _request(self, request):
        try:
            with urlopen(request, timeout=self.timeout) as response:
                return response.read()
        except HTTPError as exc:
            detail = exc.read().decode("utf-8", errors="replace")
            raise RuntimeError(f"Seed-VC HTTP {exc.code}: {detail or exc.reason}") from exc
        except URLError as exc:
            raise RuntimeError(f"Seed-VC nicht erreichbar: {exc.reason}") from exc

    @staticmethod
    def _base_url(value):
        parsed = urlparse((value or "").strip())
        try:
            parsed.port
        except ValueError as exc:
            raise ValueError("Ungültiger Port in der Seed-VC-Adresse") from exc
        if (parsed.scheme != "http" or parsed.hostname not in ("127.0.0.1", "localhost", "::1")
                or parsed.username or parsed.password or parsed.path not in ("", "/")
                or parsed.query or parsed.fragment):
            raise ValueError("Seed-VC muss über eine lokale HTTP-Adresse erreichbar sein")
        return f"http://{parsed.netloc}"

    def _upload(self, base_url, path, role, progress=None):
        if progress:
            progress(f"seedvc_upload_{role}", f"Seed-VC lädt {role}-Audio hoch")
        path = Path(path)
        boundary = uuid.uuid4().hex
        filename = role + (path.suffix or ".wav")
        content_type = mimetypes.guess_type(filename)[0] or "application/octet-stream"
        body = (
            f"--{boundary}\r\n"
            f'Content-Disposition: form-data; name="files"; filename="{filename}"\r\n'
            f"Content-Type: {content_type}\r\n\r\n"
        ).encode("ascii") + path.read_bytes() + f"\r\n--{boundary}--\r\n".encode("ascii")
        request = Request(
            base_url + "/gradio_api/upload", data=body, method="POST",
            headers={"Content-Type": f"multipart/form-data; boundary={boundary}"},
        )
        try:
            result = json.loads(self._request(request))
        except json.JSONDecodeError as exc:
            raise RuntimeError("Seed-VC lieferte beim Upload keine gültige JSON-Antwort") from exc
        entry = result[0] if isinstance(result, list) and result else result
        path_value = entry.get("path") if isinstance(entry, dict) else entry
        if not isinstance(path_value, str) or not path_value:
            raise RuntimeError("Seed-VC lieferte keinen Upload-Pfad zurück")
        if progress:
            progress(f"seedvc_upload_{role}_done", f"Seed-VC hat {role}-Audio empfangen",
                     bytes=path.stat().st_size)
        return {"path": path_value, "meta": {"_type": "gradio.FileData"}}

    @staticmethod
    def _number(options, key, default, minimum, maximum, integer=False):
        try:
            value = float(options.get(key, default))
        except (TypeError, ValueError) as exc:
            raise ValueError(f"Ungültiger Seed-VC-Wert für {key}") from exc
        if not math.isfinite(value) or value < minimum or value > maximum or (integer and not value.is_integer()):
            raise ValueError(f"Seed-VC-Wert {key} muss zwischen {minimum} und {maximum} liegen")
        return int(value) if integer else value

    def _settings_payload(self, source, reference, options):
        anonymization_only = bool(options.get("anonymization_only", False))
        if reference is None and not anonymization_only:
            raise ValueError("Für Seed-VC bitte eine Referenzaufnahme auswählen oder Anonymisierung aktivieren")
        return [
            source,
            reference,
            self._number(options, "diffusion_steps", 30, 1, 200, integer=True),
            self._number(options, "length_adjust", 1.0, 0.5, 2.0),
            self._number(options, "intelligebility_cfg_rate", 0.0, 0.0, 1.0),
            self._number(options, "similarity_cfg_rate", 0.7, 0.0, 1.0),
            self._number(options, "top_p", 0.9, 0.1, 1.0),
            self._number(options, "temperature", 1.0, 0.1, 2.0),
            self._number(options, "repetition_penalty", 1.0, 1.0, 3.0),
            bool(options.get("convert_style", False)),
            anonymization_only,
        ]

    def validate(self, reference_path, options):
        base_url = self._base_url(options.get("url"))
        source = {"path": "source", "meta": {"_type": "gradio.FileData"}}
        reference = {"path": "reference", "meta": {"_type": "gradio.FileData"}} if reference_path else None
        self._settings_payload(source, reference, options)
        return base_url

    def _predict(self, base_url, payload, progress=None):
        request = Request(
            base_url + "/gradio_api/call/predict",
            data=json.dumps({"data": payload}).encode("utf-8"),
            method="POST",
            headers={"Content-Type": "application/json"},
        )
        try:
            response = json.loads(self._request(request))
        except json.JSONDecodeError as exc:
            raise RuntimeError("Seed-VC lieferte beim Start der Umwandlung keine gültige JSON-Antwort") from exc
        event_id = response.get("event_id") if isinstance(response, dict) else None
        if not event_id:
            raise RuntimeError("Seed-VC lieferte keine Ereignis-ID für die Umwandlung")
        if progress:
            progress("seedvc_queued", "Seed-VC hat die Umwandlung angenommen")
        request = Request(base_url + "/gradio_api/call/predict/" + quote(str(event_id), safe=""))
        event = ""
        try:
            with urlopen(request, timeout=self.timeout) as response_stream:
                for raw_line in response_stream:
                    line = raw_line.decode("utf-8", errors="replace").strip()
                    if line.startswith("event:"):
                        event = line[6:].strip()
                    elif line.startswith("data:"):
                        data = line[5:].strip()
                        if event == "error":
                            raise RuntimeError(f"Seed-VC-Umwandlung fehlgeschlagen: {data}")
                        if event == "complete":
                            try:
                                return json.loads(data)
                            except json.JSONDecodeError as exc:
                                raise RuntimeError("Seed-VC lieferte ein ungültiges Umwandlungsergebnis") from exc
                        if progress and event not in ("", "heartbeat"):
                            details = {"event": event}
                            try:
                                event_data = json.loads(data)
                            except json.JSONDecodeError:
                                event_data = None
                            candidates = event_data if isinstance(event_data, list) else [event_data]
                            for item in candidates:
                                if isinstance(item, dict):
                                    value = item.get("progress")
                                    if isinstance(value, (int, float)) and 0 <= value <= 1:
                                        details["percent"] = round(value * 100)
                                        break
                            progress("seedvc_inference", "Seed-VC rechnet", **details)
        except HTTPError as exc:
            detail = exc.read().decode("utf-8", errors="replace")
            raise RuntimeError(f"Seed-VC HTTP {exc.code}: {detail or exc.reason}") from exc
        except URLError as exc:
            raise RuntimeError(f"Seed-VC nicht erreichbar: {exc.reason}") from exc
        raise RuntimeError("Seed-VC-Verbindung endete ohne fertiges Umwandlungsergebnis")

    def convert(self, source_path, reference_path, options, progress=None):
        base_url = self.validate(reference_path, options)
        if progress:
            progress("seedvc_wait", "Warte auf Seed-VC, da nur eine Umwandlung gleichzeitig läuft")
        with self.lock:
            if progress:
                progress("seedvc_start", "Seed-VC-Umwandlung wird vorbereitet")
            source = self._upload(base_url, source_path, "source", progress)
            reference = self._upload(base_url, reference_path, "reference", progress) if reference_path else None
            if progress:
                progress("seedvc_submit", "Seed-VC startet die Sprachumwandlung")
            result = self._predict(base_url, self._settings_payload(source, reference, options), progress)
            output = result[0] if isinstance(result, list) and result else result
            if not isinstance(output, dict):
                raise RuntimeError("Seed-VC lieferte keine Audiodatei zurück")
            output_url = output.get("url")
            output_path = output.get("path")
            if output_url:
                file_url = urljoin(base_url + "/", output_url)
            elif output_path:
                file_url = base_url + "/gradio_api/file=" + quote(output_path, safe="/")
            else:
                raise RuntimeError("Seed-VC-Ergebnis enthält keinen Dateipfad")
            parsed_base, parsed_file = urlparse(base_url), urlparse(file_url)
            if (parsed_file.scheme, parsed_file.hostname, parsed_file.port) != (
                    parsed_base.scheme, parsed_base.hostname, parsed_base.port):
                raise RuntimeError("Seed-VC lieferte eine Datei außerhalb des lokalen Servers")
            if progress:
                progress("seedvc_download", "Seed-VC fertig; Ergebnis wird heruntergeladen")
            request = Request(file_url)
            audio = self._request(request)
            if not audio:
                raise RuntimeError("Seed-VC lieferte eine leere Audiodatei")
            original = output.get("orig_name") or output_path or ""
            suffix = Path(original).suffix or mimetypes.guess_extension(output.get("mime_type", "")) or ".wav"
            if progress:
                progress("seedvc_download_done", "Seed-VC-Ergebnis heruntergeladen", bytes=len(audio))
            return audio, suffix


class Cutter:
    def __init__(self, out_dir, stt=None, work_dir=None, seedvc_reference_dir=None):
        self.out = Path(out_dir)
        self.out.mkdir(parents=True, exist_ok=True)
        self.work = Path(work_dir or tempfile.mkdtemp(prefix="audio-schneider-"))
        self.stt = stt
        self.seedvc_reference_dir = Path(seedvc_reference_dir) if seedvc_reference_dir else None
        self.lock = threading.Lock()
        self.source = None
        self.seedvc_client = SeedVCClient()
        self.seedvc_reference = None
        self.seedvc_reference_name = None
        self.restore_default_seedvc_reference()

    def save_upload(self, name, data):
        ext = Path(name).suffix.lower() or ".m4a"
        self.source = self.work / f"quelle{ext}"
        self.source.write_bytes(data)
        return self.source

    def _set_seedvc_reference(self, name, data):
        if not data:
            raise ValueError("Die Seed-VC-Referenzdatei ist leer")
        ext = Path(name).suffix.lower() or ".wav"
        self.work.mkdir(parents=True, exist_ok=True)
        self.seedvc_reference = self.work / f"seedvc-referenz{ext}"
        self.seedvc_reference.write_bytes(data)
        self.seedvc_reference_name = Path(name).name
        return self.seedvc_reference

    def save_seedvc_reference(self, name, data, save_default=True):
        if not data:
            raise ValueError("Die Seed-VC-Referenzdatei ist leer")
        ext = Path(name).suffix.lower() or ".wav"
        if save_default and self.seedvc_reference_dir:
            self.seedvc_reference_dir.mkdir(parents=True, exist_ok=True)
            persistent = self.seedvc_reference_dir / f"seedvc-reference{ext}"
            temporary = self.seedvc_reference_dir / f".seedvc-reference-{uuid.uuid4().hex}.tmp"
            try:
                temporary.write_bytes(data)
                temporary.replace(persistent)
            finally:
                temporary.unlink(missing_ok=True)
            for old_reference in self.seedvc_reference_dir.glob("seedvc-reference.*"):
                if old_reference != persistent and old_reference.is_file():
                    old_reference.unlink()
        return self._set_seedvc_reference(name, data)

    def restore_default_seedvc_reference(self):
        if not self.seedvc_reference_dir or not self.seedvc_reference_dir.is_dir():
            return None
        references = [
            path for path in self.seedvc_reference_dir.glob("seedvc-reference.*")
            if path.is_file()
        ]
        if not references:
            references = [
                path for path in self.seedvc_reference_dir.iterdir()
                if path.is_file() and (mimetypes.guess_type(path.name)[0] or "").startswith("audio/")
            ]
        if len(references) > 1:
            raise RuntimeError(
                f"Mehrere mögliche Seed-VC-Referenzen in {self.seedvc_reference_dir}; "
                "bitte nur eine Audiodatei oder eine Datei namens seedvc-reference.<Endung> behalten"
            )
        if not references:
            return None
        path = references[0]
        self._set_seedvc_reference(path.name, path.read_bytes())
        return self.seedvc_reference_name

    def _ffmpeg(self, src, dest, start=None, end=None, af=None, mp3=False):
        cmd = ["ffmpeg", "-y", "-v", "error"]
        if start is not None:
            cmd += ["-ss", f"{start:.3f}"]
        if end is not None:
            cmd += ["-to", f"{end:.3f}"]
        cmd += ["-i", str(src), "-vn", "-map_metadata", "-1"]
        if af:
            cmd += ["-af", af]
        if mp3:
            cmd += ["-ac", "1", "-c:a", "libmp3lame", "-q:a", "3", "-f", "mp3"]
        else:
            cmd += ["-ac", "1", "-c:a", "pcm_s16le", "-ar", "16000", "-f", "wav"]
        cmd.append(str(dest))
        r = subprocess.run(cmd, capture_output=True, text=True)
        if r.returncode != 0 or not Path(dest).exists() or Path(dest).stat().st_size == 0:
            raise RuntimeError(r.stderr.strip() or "ffmpeg lieferte keine Datei")

    def _duration(self, path):
        r = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", str(path)],
                           capture_output=True, text=True)
        return float(r.stdout.strip() or 0)

    def _chunks(self, wav, tag):
        total = self._duration(wav)
        r = subprocess.run(["ffmpeg", "-v", "info", "-i", str(wav), "-af", "silencedetect=noise=-38dB:d=0.15",
                            "-f", "null", "-"], capture_output=True, text=True)
        starts = [float(x) for x in re.findall(r"silence_start: (-?[\d.]+)", r.stderr)]
        ends = [float(x) for x in re.findall(r"silence_end: ([\d.]+)", r.stderr)]
        out = []
        i = 0
        for a, b in chunks_from_silences(starts, ends, total):
            spans = [(a, b)]
            if b - a > 2.5:
                spans = []
                pos = a
                while pos + 2.0 < b:
                    spans.append((pos, pos + 2.0))
                    pos += 1.5
                tail_start = max(a, b - 2.0)
                if not spans or tail_start > spans[-1][0]:
                    spans.append((tail_start, b))
            for start, end in spans:
                p = self.work / f"{tag}-teil{i}.wav"
                self._ffmpeg(wav, p, start, end)
                out.append((start, end, p))
                i += 1
        return out

    def cut(self, start, end, trim=True, french_only=False, seedvc=None, progress=None):
        def report(stage, message, **details):
            if progress:
                progress(stage, message, **details)

        if self.source is None:
            raise RuntimeError("Noch keine Aufnahme geladen")
        if not end > start:
            raise ValueError("Ende liegt vor dem Anfang")
        seedvc = seedvc or {}
        seedvc_enabled = bool(seedvc.get("enabled"))
        if seedvc_enabled:
            reference = None if seedvc.get("anonymization_only") else self.seedvc_reference
            self.seedvc_client.validate(reference, seedvc)
        tag = f"schnitt-{threading.get_ident()}-{abs(hash((start, end)))}"
        wav, tmp = self.work / f"{tag}.wav", self.work / f"{tag}.mp3"
        converted_path = None
        sil = "silenceremove=start_periods=1:start_threshold=-45dB:start_silence=0.06"
        report("audio_extract", "Audio wird aus der Aufnahme ausgeschnitten", start=round(start, 2),
               end=round(end, 2), trim=trim)
        self._ffmpeg(self.source, wav, start, end, af=f"{sil},areverse,{sil},areverse" if trim else None)
        report("audio_extract_done", "Audioausschnitt erstellt", seconds=round(end - start, 2))
        text, ranges, parts, stt_error = "", None, [], None
        if self.stt is not None:
            try:
                report("whisper_chunking", "Whisper-Abschnitte werden vorbereitet")
                parts = self._chunks(wav, tag) if getattr(self.stt, "wants_chunks", True) else []
                report("whisper_start", f"Whisper beginnt mit {max(1, len(parts))} Abschnitt/Abschnitten",
                       chunks=max(1, len(parts)), model=getattr(self.stt, "active_model", None),
                       device=getattr(self.stt, "active_device", None))
                if isinstance(self.stt, Whisper):
                    text, ranges = self.stt(
                        wav, parts,
                        progress=lambda stage, message, **details: report(stage, message, **details),
                        force_language=True,
                    )
                else:
                    text, ranges = self.stt(wav, parts)
                report("whisper_done", "Whisper-Erkennung abgeschlossen", characters=len(text))
            except Exception as e:  # noqa: BLE001
                stt_error = f"{type(e).__name__}: {e}"
                report("whisper_error", f"Whisper-Fehler: {stt_error}")
                print(f"Spracherkennung fehlgeschlagen: {e}", file=sys.stderr)
                traceback.print_exc()
        try:
            if french_only and ranges:
                a, b = min(r[0] for r in ranges), max(r[1] for r in ranges)
                report("mp3_encode", "Französischer Bereich wird als MP3 gespeichert",
                       start=round(a, 2), end=round(b, 2))
                self._ffmpeg(wav, tmp, a, b, mp3=True)
            else:
                report("mp3_encode", "Schnitt wird als MP3 codiert")
                self._ffmpeg(wav, tmp, mp3=True)
            if seedvc_enabled:
                audio_data, suffix = self.seedvc_client.convert(
                    tmp, reference, seedvc,
                    progress=lambda stage, message, **details: report(stage, message, **details)
                )
                converted_path = self.work / f"{tag}-seedvc{suffix}"
                converted_path.write_bytes(audio_data)
                report("mp3_reencode", "Seed-VC-Ausgabe wird als MP3 codiert")
                self._ffmpeg(converted_path, tmp, mp3=True)
        except Exception:
            for f in [wav, tmp, converted_path] + [p[2] for p in parts]:
                if f is not None:
                    f.unlink(missing_ok=True)
            raise
        for f in [wav] + [p[2] for p in parts]:
            f.unlink(missing_ok=True)
        if converted_path:
            converted_path.unlink(missing_ok=True)
        name = clean_name(text)
        report("save_file", "Fertiger Schnitt wird im Zielordner gespeichert")
        with self.lock:
            if not name:
                n = 1
                while (self.out / f"Segment {n}.mp3").exists():
                    n += 1
                name = f"Segment {n}"
            dest = unique_path(self.out, name, ext=".mp3")
            tmp.replace(dest)
        report("save_done", "Schnitt gespeichert", name=dest.stem)
        result = {"name": dest.stem, "text": text.strip()}
        diagnostics = getattr(self.stt, "last_debug", None)
        if diagnostics is not None or stt_error:
            result["stt_debug"] = dict(diagnostics or {})
            if stt_error:
                result["stt_debug"]["error"] = stt_error
        if seedvc_enabled:
            result["seedvc"] = {"converted": True, "model": "V2"}
        return result

    def retry_recognition(self, start, end, name, trim=True):
        if self.source is None:
            raise RuntimeError("Noch keine Aufnahme geladen")
        if self.stt is None:
            raise RuntimeError("Spracherkennung ist deaktiviert")
        if not end > start:
            raise ValueError("Ende liegt vor dem Anfang")
        if not self._file(name).is_file():
            raise FileNotFoundError(name)

        tag = f"retry-{uuid.uuid4().hex}"
        wav = self.work / f"{tag}.wav"
        parts = []
        sil = "silenceremove=start_periods=1:start_threshold=-45dB:start_silence=0.06"
        try:
            self._ffmpeg(self.source, wav, start, end,
                         af=f"{sil},areverse,{sil},areverse" if trim else None)
            parts = self._chunks(wav, tag) if getattr(self.stt, "wants_chunks", True) else []
            if isinstance(self.stt, Whisper):
                text, _ = self.stt(wav, parts, force_language=True)
            else:
                text, _ = self.stt(wav, parts)
        finally:
            for path in [wav] + [part[2] for part in parts]:
                path.unlink(missing_ok=True)

        result = {"name": name, "text": text.strip(), "recognized": bool(clean_name(text))}
        diagnostics = getattr(self.stt, "last_debug", None)
        if diagnostics is not None:
            result["stt_debug"] = dict(diagnostics)
        return result

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
            dest = unique_path(self.out, new, ext=".mp3", ignore=src)
            src.replace(dest)
        return dest.stem

    def delete(self, name):
        p = self._file(name)
        if p.exists():
            p.unlink()
        return True


def make_handler(cutter, info):
    jobs = {}
    jobs_lock = threading.Lock()

    def create_job(job_id):
        now = time.monotonic()
        with jobs_lock:
            expired = [key for key, job in jobs.items()
                       if job["status"] != "running" and now - job["updated"] > 3600]
            for key in expired:
                del jobs[key]
            if len(jobs) >= 100:
                finished = sorted(
                    ((job["updated"], key) for key, job in jobs.items() if job["status"] != "running")
                )
                for _, key in finished[:len(jobs) - 99]:
                    del jobs[key]
            jobs[job_id] = {
                "status": "running", "stage": "starting", "message": "Schnitt wird gestartet",
                "started": now, "updated": now, "sequence": 0, "events": [],
            }
        update_job(job_id, "starting", "Schnittauftrag angenommen")

    def update_job(job_id, stage, message, status=None, **details):
        now = time.monotonic()
        with jobs_lock:
            job = jobs.get(job_id)
            if job is None:
                return
            if status:
                job["status"] = status
            job["stage"] = stage
            job["message"] = message
            job["updated"] = now
            job["sequence"] += 1
            job["events"].append({
                "sequence": job["sequence"], "elapsed": round(now - job["started"], 1),
                "stage": stage, "message": message, "details": details,
            })
            if len(job["events"]) > 2000:
                del job["events"][:len(job["events"]) - 2000]
            elapsed = now - job["started"]
        print(f"[Audio-Schneider] Schnitt {job_id[:8]} +{elapsed:.1f}s {stage}: {message}", flush=True)

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *a):
            pass

        def _send(self, code, body=b"", ctype="application/json"):
            try:
                self.send_response(code)
                self.send_header("Content-Type", ctype)
                self.send_header("Content-Length", str(len(body)))
                self.send_header("Cache-Control", "no-store")
                self.end_headers()
                self.wfile.write(body)
            except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
                self.close_connection = True

        def _json(self, obj, code=200):
            self._send(code, json.dumps(obj, ensure_ascii=False).encode())

        def do_GET(self):
            u = urlparse(self.path)
            if u.path in ("/", "/index.html"):
                self._send(200, (HERE / "index.html").read_bytes(), "text/html; charset=utf-8")
            elif u.path == "/info":
                stt = cutter.stt
                self._json({"out": str(cutter.out), "stt": info["stt"],
                            "ready": bool(getattr(stt, "ready", True)) if stt else True,
                            "error": getattr(stt, "error", None),
                            "gpu_error": getattr(stt, "gpu_error", None),
                            "device": getattr(stt, "active_device", None),
                            "model": getattr(stt, "active_model", None),
                            "seedvc_reference": cutter.seedvc_reference_name,
                            "project_key": str(cutter.out.resolve())})
            elif u.path == "/job":
                query = parse_qs(u.query)
                job_id = query.get("id", [""])[0]
                try:
                    after = max(0, int(query.get("after", ["0"])[0]))
                except ValueError:
                    return self._json({"error": "Ungültige Fortschrittsposition"}, 400)
                with jobs_lock:
                    job = jobs.get(job_id)
                    if job is None:
                        return self._json({"error": "Schnittauftrag nicht gefunden"}, 404)
                    now = time.monotonic()
                    result = {
                        "status": job["status"], "stage": job["stage"], "message": job["message"],
                        "elapsed": round(now - job["started"], 1), "sequence": job["sequence"],
                        "events": [event for event in job["events"] if event["sequence"] > after],
                        "result": job.get("result"),
                    }
                self._json(result)
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
                    name = parse_qs(u.query).get("name", ["quelle.m4a"])[0]
                    cutter.save_upload(name, raw)
                    return self._json({"ok": True})
                if u.path == "/seedvc/reference":
                    name = parse_qs(u.query).get("name", ["referenz.wav"])[0]
                    save_default = parse_qs(u.query).get("default", ["true"])[0].lower() != "false"
                    cutter.save_seedvc_reference(name, raw, save_default=save_default)
                    return self._json({"ok": True, "name": cutter.seedvc_reference_name})
                if u.path == "/seedvc/reference/default":
                    name = cutter.restore_default_seedvc_reference()
                    return self._json({"ok": True, "name": name})
                data = json.loads(raw or b"{}")
                if u.path == "/retry-recognition":
                    return self._json(cutter.retry_recognition(
                        float(data["start"]), float(data["end"]), data["name"],
                        bool(data.get("trim", True)),
                    ))
                if u.path == "/cut":
                    job_id = data.get("job_id") or uuid.uuid4().hex
                    if not isinstance(job_id, str) or not re.fullmatch(r"[A-Za-z0-9_-]{1,80}", job_id):
                        raise ValueError("Ungültige Schnitt-ID")
                    create_job(job_id)
                    try:
                        result = cutter.cut(
                            float(data["start"]), float(data["end"]),
                            bool(data.get("trim", True)), bool(data.get("french_only", False)),
                            data.get("seedvc"),
                            progress=lambda stage, message, **details: update_job(
                                job_id, stage, message, **details
                            ),
                        )
                    except Exception as exc:
                        update_job(job_id, "failed", f"Schnitt fehlgeschlagen: {type(exc).__name__}: {exc}",
                                   status="failed")
                        raise
                    with jobs_lock:
                        jobs[job_id]["result"] = {
                            "name": result["name"], "seedvc": result.get("seedvc"),
                        }
                    update_job(job_id, "complete", "Schnitt vollständig verarbeitet", status="complete")
                    result["job_id"] = job_id
                    return self._json(result)
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

    stt = None
    if a.stt == "whisper":
        stt = Whisper(a.model, a.lang, a.other_lang)
        threading.Thread(target=stt.preload, daemon=True).start()
    elif a.stt == "fake":
        stt = FakeStt()
    cutter = Cutter(a.out, stt, seedvc_reference_dir=default_seedvc_reference_dir())
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