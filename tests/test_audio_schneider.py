import io
import json
import shutil
import subprocess
import tempfile
import threading
import unittest
import urllib.request
from contextlib import redirect_stderr
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from scripts.audio_schneider import schneider as production_sc
from tests.scripts.audio_schneider import schneider as sc

HAS_FFMPEG = shutil.which("ffmpeg") is not None


def make_audio(path, parts):
    """parts: Liste von (Frequenz, Sekunden); Frequenz 0 = Stille."""
    args = ["ffmpeg", "-y", "-v", "error"]
    labels = []
    for i, (f, d) in enumerate(parts):
        src = f"sine=frequency={f}:duration={d}" if f else f"anullsrc=r=44100:cl=mono"
        args += ["-f", "lavfi", "-t", str(d), "-i", src]
        labels.append(f"[{i}:a]")
    args += ["-filter_complex", "".join(labels) + f"concat=n={len(parts)}:v=0:a=1", str(path)]
    subprocess.run(args, check=True)


class NameTests(unittest.TestCase):
    def test_clean_name(self):
        self.assertEqual(sc.clean_name(" Le voleur. "), "Le voleur")
        self.assertEqual(sc.clean_name("l’ami"), "l'ami")
        self.assertEqual(sc.clean_name("a/b:c?"), "a b c")
        self.assertEqual(sc.clean_name("…"), "")
        self.assertEqual(sc.clean_name(None), "")

    def test_unique_path(self):
        with tempfile.TemporaryDirectory() as d:
            d = Path(d)
            (d / "Depuis.mp3").write_bytes(b"x")
            self.assertEqual(sc.unique_path(d, "Depuis").name, "Depuis 2.mp3")
            self.assertEqual(sc.unique_path(d, "Autre").name, "Autre.mp3")


class FakeModel:
    """Ersetzt faster-whisper: Abschnitt 0 = Deutsch, Abschnitt 1 = Französisch."""

    class Seg:
        def __init__(self, text):
            self.text = text

    class Info:
        def __init__(self, language, probs):
            self.language, self.all_language_probs = language, probs

    TEXTS = {"a.wav": ("Der Dieb", "de"), "b.wav": ("Le voleur.", "fr"), "c.wav": ("Erklärung", "de")}

    def transcribe(self, path, language=None, **kw):
        text, lang = self.TEXTS[Path(path).name]
        if language and language != lang:
            text = "Quatsch"
        probs = [("de", 0.7 if lang == "de" else 0.2), ("fr", 0.7 if lang == "fr" else 0.2), ("en", 0.1)]
        return [self.Seg(text)], self.Info(language or lang, probs)


class WhisperLogicTests(unittest.TestCase):
    def test_preload_uses_cpu_before_first_cut_when_cuda_runtime_is_missing(self):
        w = production_sc.Whisper()
        loads = []

        def fake_load(device="auto", model=None):
            loads.append((device, model))
            w.active_device, w.active_model, w.ready = device, model, True
            w.model = FakeModel()

        w.load = fake_load
        stderr = io.StringIO()
        with patch.object(production_sc, "_cuda_runtime_error", return_value="missing cublas64_12.dll"), \
                redirect_stderr(stderr):
            w.preload()

        self.assertEqual(loads, [("cpu", "small")])
        self.assertEqual(w.gpu_error, "missing cublas64_12.dll")
        self.assertIn("starte CPU", stderr.getvalue())
        self.assertNotIn("Traceback", stderr.getvalue())

    def test_cpu_uses_greedy_decoding_to_reduce_latency(self):
        class Model:
            def __init__(self):
                self.beam_sizes = []

            def transcribe(self, path, **options):
                self.beam_sizes.append(options["beam_size"])
                return [], SimpleNamespace()

        model = Model()
        w = production_sc.Whisper()
        w.model, w.active_device = model, "cpu"
        w._transcribe(Path("sample.wav"), "fr")

        self.assertEqual(model.beam_sizes, [1])

    def test_gpu_keeps_default_beam_size(self):
        class Model:
            def __init__(self):
                self.beam_sizes = []

            def transcribe(self, path, **options):
                self.beam_sizes.append(options["beam_size"])
                return [], SimpleNamespace()

        model = Model()
        w = production_sc.Whisper()
        w.model, w.active_device = model, "cuda"
        w._transcribe(Path("sample.wav"), "fr")

        self.assertEqual(model.beam_sizes, [5])

    def test_picks_first_french_chunk(self):
        w = sc.Whisper()
        w.model, w.ready = FakeModel(), True
        chunks = [(0.0, 0.8, Path("a.wav")), (1.4, 2.6, Path("b.wav")), (3.0, 4.0, Path("c.wav"))]
        self.assertEqual(w(Path("x.wav"), chunks), ("Le voleur.", [(1.4, 2.6)]))

    def test_reports_chunk_progress_without_transcript_text(self):
        w = production_sc.Whisper()
        w.model, w.ready = FakeModel(), True
        events = []

        result = w(
            Path("x.wav"),
            [(0.0, 0.8, Path("a.wav")), (1.4, 2.6, Path("b.wav"))],
            progress=lambda stage, message, **details: events.append((stage, message, details)),
        )

        self.assertEqual(result, ("Le voleur.", [(1.4, 2.6)]))
        self.assertIn("whisper_chunk", [event[0] for event in events])
        self.assertIn("whisper_decode", [event[0] for event in events])
        self.assertIn("whisper_language", [event[0] for event in events])
        self.assertNotIn("Le voleur", str(events))

    def test_forced_french_retry_checks_latest_chunk_first(self):
        class Model:
            def __init__(self):
                self.calls = []

            def transcribe(self, path, language=None, **options):
                self.calls.append((Path(path).name, language))
                text = "Le voleur" if Path(path).name == "french.wav" else "Quatsch"
                return [FakeModel.Seg(text)], SimpleNamespace(language=language, all_language_probs=[])

        model = Model()
        w = production_sc.Whisper()
        w.model, w.ready, w.active_device = model, True, "cpu"

        text, ranges = w(
            Path("source.wav"),
            [(0, 1, Path("german.wav")), (1, 2, Path("french.wav"))],
            force_language=True,
        )

        self.assertEqual((text, ranges), ("Le voleur", [(1, 2)]))
        self.assertEqual(model.calls, [("french.wav", "fr")])

    def test_no_french_gives_nothing(self):
        w = sc.Whisper()
        w.model, w.ready = FakeModel(), True
        self.assertEqual(w(Path("x.wav"), [(0, 1, Path("a.wav"))]), ("", []))

    def test_gpu_failure_falls_back_to_cpu_without_traceback(self):
        class BrokenGpuModel:
            def transcribe(self, *args, **kwargs):
                raise RuntimeError("Library cublas64_12.dll is not found")

        w = production_sc.Whisper()
        w.model, w.ready = BrokenGpuModel(), True
        loaded = []

        def load(device="auto", model=None):
            loaded.append((device, model))
            w.model = FakeModel()
            w.ready = True

        w.load = load
        stderr = io.StringIO()
        with redirect_stderr(stderr):
            result = w(Path("x.wav"), [(0.0, 1.0, Path("b.wav"))])

        self.assertEqual(result, ("Le voleur.", [(0.0, 1.0)]))
        self.assertEqual(loaded, [("cpu", "small")])
        self.assertIn("wechsle zur CPU", stderr.getvalue())
        self.assertNotIn("Traceback", stderr.getvalue())

    def test_diagnostics_distinguish_non_target_language_from_empty_audio(self):
        w = production_sc.Whisper()
        w.model, w.ready = FakeModel(), True

        self.assertEqual(w(Path("x.wav"), [(0.0, 0.8, Path("a.wav"))]), ("", []))
        chunk = w.last_debug["chunks"][0]
        self.assertEqual(chunk, {
            "index": 0, "start": 0.0, "end": 0.8,
            "language": "de", "characters": len("Der Dieb"), "outcome": "other_language",
        })
        self.assertNotIn("Der Dieb", str(w.last_debug))

    def test_cut_returns_stt_diagnostics_for_browser(self):
        diagnostics = {"model": "small", "device": "cpu", "chunks": []}

        class StubStt:
            wants_chunks = False
            last_debug = diagnostics

            def __call__(self, path, chunks=None):
                return "", []

        with tempfile.TemporaryDirectory() as d:
            work = Path(d) / "work"
            cutter = production_sc.Cutter(Path(d) / "out", StubStt(), work)
            work.mkdir()
            cutter.save_upload("source.m4a", b"source")
            cutter._ffmpeg = lambda src, dest, *args, **kwargs: Path(dest).write_bytes(b"audio")

            result = cutter.cut(0, 1, trim=False)

        self.assertEqual(result["stt_debug"], diagnostics)

    def test_cut_forces_target_language_by_default(self):
        class Model:
            def __init__(self):
                self.calls = []

            def transcribe(self, path, language=None, **options):
                self.calls.append((Path(path).name, language))
                text = "Le voleur" if Path(path).name == "french.wav" else "Quatsch"
                return [FakeModel.Seg(text)], SimpleNamespace(language=language, all_language_probs=[])

        with tempfile.TemporaryDirectory() as d:
            work, out = Path(d) / "work", Path(d) / "out"
            work.mkdir()
            stt = production_sc.Whisper()
            stt.model, stt.ready, stt.active_device = Model(), True, "cpu"
            cutter = production_sc.Cutter(out, stt, work)
            cutter.save_upload("source.m4a", b"source")
            cutter._ffmpeg = lambda src, dest, *args, **kwargs: Path(dest).write_bytes(b"audio")
            cutter._chunks = lambda wav, tag: [
                (0, 1, work / "german.wav"), (1, 2, work / "french.wav")
            ]

            result = cutter.cut(0, 2, trim=False)

        self.assertEqual(result["name"], "Le voleur")
        self.assertEqual(stt.model.calls, [("french.wav", "fr")])

    def test_http_cut_exposes_progress_job(self):
        with tempfile.TemporaryDirectory() as d:
            work, out = Path(d) / "work", Path(d) / "out"
            work.mkdir()
            cutter = production_sc.Cutter(out, None, work)
            cutter.save_upload("source.m4a", b"source")
            cutter._ffmpeg = lambda src, dest, *args, **kwargs: Path(dest).write_bytes(b"audio")
            server = ThreadingHTTPServer(("127.0.0.1", 0), production_sc.make_handler(cutter, {"stt": "none"}))
            threading.Thread(target=server.serve_forever, daemon=True).start()
            base_url = f"http://127.0.0.1:{server.server_port}"
            try:
                body = json.dumps({"job_id": "progress-test", "start": 0, "end": 1}).encode()
                request = urllib.request.Request(base_url + "/cut", data=body, method="POST")
                result = json.loads(urllib.request.urlopen(request).read())
                job = json.loads(urllib.request.urlopen(base_url + "/job?id=progress-test&after=0").read())
            finally:
                server.shutdown()
                server.server_close()

        self.assertEqual(result["job_id"], "progress-test")
        self.assertEqual(job["status"], "complete")
        self.assertIn("audio_extract", [event["stage"] for event in job["events"]])
        self.assertIn("save_done", [event["stage"] for event in job["events"]])
        self.assertEqual(job["result"]["name"], result["name"])

    def test_http_retry_recognition_forces_french_without_changing_audio(self):
        class Model:
            def __init__(self):
                self.calls = []

            def transcribe(self, path, language=None, **options):
                self.calls.append(language)
                return [FakeModel.Seg("Le voleur")], SimpleNamespace(language=language, all_language_probs=[])

        with tempfile.TemporaryDirectory() as d:
            work, out = Path(d) / "work", Path(d) / "out"
            work.mkdir()
            stt = production_sc.Whisper()
            stt.model, stt.ready = Model(), True
            cutter = production_sc.Cutter(out, stt, work)
            cutter.save_upload("source.m4a", b"source")
            clip = out / "Segment 1.mp3"
            clip.write_bytes(b"already converted audio")
            cutter._ffmpeg = lambda src, dest, *args, **kwargs: Path(dest).write_bytes(b"retry wav")
            cutter._chunks = lambda wav, tag: [
                (0, 1, work / "german.wav"), (1, 2, work / "french.wav")
            ]
            server = ThreadingHTTPServer(("127.0.0.1", 0), production_sc.make_handler(cutter, {"stt": "whisper"}))
            threading.Thread(target=server.serve_forever, daemon=True).start()
            try:
                body = json.dumps({
                    "name": "Segment 1", "start": 0, "end": 2, "trim": False,
                }).encode()
                request = urllib.request.Request(
                    f"http://127.0.0.1:{server.server_port}/retry-recognition",
                    data=body, method="POST",
                )
                result = json.loads(urllib.request.urlopen(request).read())
            finally:
                server.shutdown()
                server.server_close()

            self.assertEqual(result["text"], "Le voleur")
            self.assertTrue(result["recognized"])
            self.assertEqual(stt.model.calls, ["fr"])
            self.assertEqual(clip.read_bytes(), b"already converted audio")

    def test_http_handler_ignores_client_disconnect_while_sending(self):
        handler_type = production_sc.make_handler(None, {})
        handler = handler_type.__new__(handler_type)
        handler.send_response = lambda code: None
        handler.send_header = lambda name, value: None
        handler.end_headers = lambda: None

        class DisconnectedWriter:
            def write(self, body):
                raise ConnectionAbortedError("client closed connection")

        handler.wfile = DisconnectedWriter()
        handler._send(200, b"{}")

        self.assertTrue(handler.close_connection)


class SeedVCIntegrationTests(unittest.TestCase):
    def test_gradio_client_uploads_inputs_and_downloads_conversion(self):
        state = {"uploads": 0}

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass

            def send_body(self, body, content_type="application/json"):
                self.send_response(200)
                self.send_header("Content-Type", content_type)
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def do_POST(self):
                body = self.rfile.read(int(self.headers["Content-Length"]))
                if self.path == "/gradio_api/upload":
                    state["uploads"] += 1
                    return self.send_body(json.dumps([f"/tmp/upload{state['uploads']}.wav"]).encode())
                if self.path == "/gradio_api/call/predict":
                    state["payload"] = json.loads(body)
                    return self.send_body(b'{"event_id":"test-event"}')
                self.send_error(404)

            def do_GET(self):
                if self.path == "/gradio_api/call/predict/test-event":
                    body = ('event: progress\ndata: {"progress":0.5}\n\n'
                            'event: complete\ndata: ' + json.dumps([{
                        "path": "/tmp/converted.wav",
                        "url": "/gradio_api/file=converted.wav",
                        "orig_name": "converted.wav",
                        "mime_type": "audio/wav",
                    }]) + "\n\n").encode()
                    return self.send_body(body, "text/event-stream")
                if self.path == "/gradio_api/file=converted.wav":
                    return self.send_body(b"converted audio", "audio/wav")
                self.send_error(404)

        server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        try:
            with tempfile.TemporaryDirectory() as d:
                source = Path(d) / "source.mp3"
                reference = Path(d) / "reference.wav"
                source.write_bytes(b"source")
                reference.write_bytes(b"reference")
                progress = []
                audio, suffix = production_sc.SeedVCClient().convert(
                    source, reference, {
                        "url": f"http://127.0.0.1:{server.server_port}",
                        "convert_style": True,
                    },
                    progress=lambda stage, message, **details: progress.append((stage, message, details)),
                )
            self.assertEqual((audio, suffix), (b"converted audio", ".wav"))
            self.assertEqual(state["uploads"], 2)
            self.assertIn("seedvc_inference", [event[0] for event in progress])
            self.assertIn(50, [event[2].get("percent") for event in progress])
            self.assertEqual(
                state["payload"]["data"],
                [
                    {"path": "/tmp/upload1.wav", "meta": {"_type": "gradio.FileData"}},
                    {"path": "/tmp/upload2.wav", "meta": {"_type": "gradio.FileData"}},
                    30, 1.0, 0.0, 0.7, 0.9, 1.0, 1.0, True, False,
                ],
            )
        finally:
            server.shutdown()
            server.server_close()

    def test_cut_saves_converted_audio_and_does_not_save_on_conversion_error(self):
        class StubStt:
            wants_chunks = False

            def __call__(self, path, chunks=None):
                return "bonjour", []

        class StubSeedVC(production_sc.SeedVCClient):
            def __init__(self, events, fail=False):
                super().__init__()
                self.events, self.fail = events, fail

            def convert(self, source, reference, options, progress=None):
                self.events.append(("seedvc", Path(source).suffix, Path(reference).name, options["url"]))
                if progress:
                    progress("seedvc_stub", "Seed-VC-Test läuft")
                if self.fail:
                    raise RuntimeError("Seed-VC test error")
                return b"converted audio", ".wav"

        for fail in (False, True):
            with self.subTest(fail=fail), tempfile.TemporaryDirectory() as d:
                work, out = Path(d) / "work", Path(d) / "out"
                work.mkdir()
                events = []
                cutter = production_sc.Cutter(out, StubStt(), work)
                cutter.save_upload("source.m4a", b"source")
                reference = cutter.save_seedvc_reference("target.wav", b"reference")
                cutter.seedvc_client = StubSeedVC(events, fail)

                def fake_ffmpeg(src, dest, start=None, end=None, af=None, mp3=False):
                    events.append(("ffmpeg", Path(src).suffix, mp3))
                    Path(dest).write_bytes(b"mp3")

                cutter._ffmpeg = fake_ffmpeg
                settings = {"enabled": True, "url": "http://127.0.0.1:42003"}
                if fail:
                    with self.assertRaisesRegex(RuntimeError, "Seed-VC test error"):
                        cutter.cut(0, 1, trim=False, seedvc=settings)
                    self.assertFalse(list(out.glob("*.mp3")))
                else:
                    result = cutter.cut(0, 1, trim=False, seedvc=settings)
                    self.assertTrue((out / (result["name"] + ".mp3")).exists())
                    self.assertEqual(result["seedvc"], {"converted": True, "model": "V2"})
                    self.assertEqual(events[2], ("seedvc", ".mp3", reference.name, settings["url"]))


class ChunkTests(unittest.TestCase):
    def test_chunks_from_silences(self):
        c = sc.chunks_from_silences([1.0], [1.6], 2.6)
        self.assertEqual(len(c), 2)
        self.assertAlmostEqual(c[0][1], 1.05)
        self.assertAlmostEqual(c[1][0], 1.55)
        self.assertEqual(sc.chunks_from_silences([], [], 2.0), [(0.0, 2.0)])
        # Stille bis zum Ende (kein silence_end)
        self.assertEqual(len(sc.chunks_from_silences([1.0], [], 2.0)), 1)

    def test_audio_chunks_use_short_pauses_and_overlapping_windows(self):
        def split(total, silence_output):
            with tempfile.TemporaryDirectory() as d:
                work = Path(d) / "work"
                cutter = production_sc.Cutter(Path(d) / "out", work_dir=work)
                work.mkdir()
                cutter._duration = lambda path: total
                intervals = []
                cutter._ffmpeg = lambda src, dest, start, end: (
                    intervals.append((start, end)), Path(dest).write_bytes(b"wav")
                )
                result = SimpleNamespace(stderr=silence_output, returncode=0)
                with patch.object(production_sc.subprocess, "run", return_value=result) as run:
                    chunks = cutter._chunks(Path("source.wav"), "test")
                self.assertIn("silencedetect=noise=-38dB:d=0.15", run.call_args.args[0])
                self.assertEqual(intervals, [(a, b) for a, b, _ in chunks])
                return [(a, b) for a, b, _ in chunks]

        windows = split(3.49, "")
        self.assertEqual(windows[0], (0.0, 2.0))
        self.assertAlmostEqual(windows[1][0], 1.49)
        self.assertEqual(windows[1][1], 3.49)
        self.assertEqual(
            split(3.5, "silence_start: 1.0\nsilence_end: 1.2"),
            [(0.0, 1.05), (1.15, 3.5)],
        )


class RenameTests(unittest.TestCase):
    def test_rename_only_moves_existing_seedvc_audio(self):
        class UnexpectedStt:
            def __call__(self, *args, **kwargs):
                raise AssertionError("Whisper must not run while renaming")

        class UnexpectedSeedVC:
            def convert(self, *args, **kwargs):
                raise AssertionError("Seed-VC must not run while renaming")

        with tempfile.TemporaryDirectory() as d:
            out, work = Path(d) / "out", Path(d) / "work"
            out.mkdir()
            original = out / "Segment 1.mp3"
            original.write_bytes(b"already converted audio")
            cutter = production_sc.Cutter(out, UnexpectedStt(), work)
            cutter.seedvc_client = UnexpectedSeedVC()

            name = cutter.rename("Segment 1", "Le voleur")

            renamed = out / "Le voleur.mp3"
            self.assertEqual(name, "Le voleur")
            self.assertFalse(original.exists())
            self.assertEqual(renamed.read_bytes(), b"already converted audio")


class SeedVCReferencePersistenceTests(unittest.TestCase):
    def test_selected_reference_persists_and_is_restored_as_default(self):
        with tempfile.TemporaryDirectory() as d:
            root = Path(d)
            reference_dir = root / "references"
            work = root / "work"
            cutter = production_sc.Cutter(
                root / "out", work_dir=work, seedvc_reference_dir=reference_dir
            )
            cutter.save_seedvc_reference("My Voice.mp3", b"persistent voice")

            next_cutter = production_sc.Cutter(
                root / "other-out", work_dir=root / "next-work",
                seedvc_reference_dir=reference_dir,
            )

            self.assertEqual(next_cutter.seedvc_reference_name, "seedvc-reference.mp3")
            self.assertEqual(next_cutter.seedvc_reference.read_bytes(), b"persistent voice")

    def test_project_reference_does_not_replace_persistent_default(self):
        with tempfile.TemporaryDirectory() as d:
            root = Path(d)
            reference_dir = root / "references"
            cutter = production_sc.Cutter(
                root / "out", seedvc_reference_dir=reference_dir
            )
            cutter.save_seedvc_reference("Default.wav", b"default voice")
            cutter.save_seedvc_reference("Project.wav", b"project voice", save_default=False)

            self.assertEqual(
                (reference_dir / "seedvc-reference.wav").read_bytes(),
                b"default voice",
            )
            self.assertEqual(cutter.restore_default_seedvc_reference(), "seedvc-reference.wav")
            self.assertEqual(cutter.seedvc_reference.read_bytes(), b"default voice")

    def test_single_named_audio_file_is_loaded_from_default_directory(self):
        with tempfile.TemporaryDirectory() as d:
            root = Path(d)
            reference_dir = root / "references"
            reference_dir.mkdir()
            reference_file = reference_dir / "French-Male-Voiceover-Jan.mp3"
            reference_file.write_bytes(b"named default voice")

            cutter = production_sc.Cutter(
                root / "out", seedvc_reference_dir=reference_dir
            )

            self.assertEqual(cutter.seedvc_reference_name, reference_file.name)
            self.assertEqual(cutter.seedvc_reference.read_bytes(), b"named default voice")


@unittest.skipUnless(HAS_FFMPEG, "ffmpeg fehlt")
class CutterTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        t = Path(self.tmp.name)
        self.src = t / "quelle.wav"
        make_audio(self.src, [(0, 0.5), (440, 1.0), (0, 0.4), (660, 1.0)])
        self.out = t / "out"
        self.c = sc.Cutter(self.out, sc.FakeStt(), t / "work")
        (t / "work").mkdir()
        self.c.save_upload("quelle.wav", self.src.read_bytes())

    def tearDown(self):
        self.tmp.cleanup()

    def dur(self, p):
        r = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", str(p)],
                           capture_output=True, text=True)
        return float(r.stdout)

    def test_cut_names_and_trims(self):
        r = self.c.cut(0.0, 1.6, trim=True)
        self.assertEqual(r["name"], "Mot 1")
        p = self.out / "Mot 1.mp3"
        self.assertTrue(p.exists())
        self.assertLess(self.dur(p), 1.3)  # Stille vorn abgeschnitten
        r2 = self.c.cut(0.0, 1.6, trim=False)
        self.assertGreater(self.dur(self.out / (r2["name"] + ".mp3")), 1.5)

    def test_without_stt_numbers_segments(self):
        c = sc.Cutter(self.out, None, Path(self.tmp.name) / "work")
        c.source = self.c.source
        self.assertEqual(c.cut(0, 1.5)["name"], "Segment 1")
        self.assertEqual(c.cut(1.5, 3.0)["name"], "Segment 2")

    def test_duplicate_rename_delete(self):
        class Same(sc.FakeStt):
            def __call__(self, path, chunks=None):
                return "Depuis.", None
        self.c.stt = Same()
        a = self.c.cut(0, 1.5)["name"]
        b = self.c.cut(1.5, 3.0)["name"]
        self.assertEqual((a, b), ("Depuis", "Depuis 2"))
        self.assertEqual(self.c.rename("Depuis 2", "voleur"), "voleur")
        self.assertEqual(self.c.rename("voleur", "voleur"), "voleur")
        self.c.delete("voleur")
        self.assertFalse((self.out / "voleur.mp3").exists())
        with self.assertRaises(ValueError):
            self.c.cut(2.0, 1.0)

    def test_german_then_french_in_one_clip(self):
        """Deutsch (440 Hz), Pause, Französisch (880 Hz): Pausen werden erkannt, nur der französische Teil bleibt."""
        t = Path(self.tmp.name)
        both = t / "beide.wav"
        make_audio(both, [(440, 0.8), (0, 0.7), (880, 1.2)])
        c = sc.Cutter(self.out, None, t / "work")
        c.save_upload("beide.wav", both.read_bytes())
        seen = {}

        class Stub:
            ready = True
            error = None

            def __call__(self, path, chunks=None):
                seen["n"] = len(chunks)
                a, b, _ = chunks[-1]  # der zweite Abschnitt ist das Französische
                return "Le voleur.", [(a, b)]
        c.stt = Stub()
        full = c.cut(0, 2.7, trim=True, french_only=False)
        self.assertEqual(seen["n"], 2)
        self.assertGreater(self.dur(self.out / (full["name"] + ".mp3")), 2.4)
        only = c.cut(0, 2.7, trim=True, french_only=True)
        self.assertEqual(only["name"], "Le voleur 2")
        self.assertLess(self.dur(self.out / "Le voleur 2.mp3"), 1.6)
        self.assertGreater(self.dur(self.out / "Le voleur 2.mp3"), 1.0)

    def test_http_flow(self):
        info = {"stt": "fake"}
        srv = ThreadingHTTPServer(("127.0.0.1", 0), sc.make_handler(self.c, info))
        threading.Thread(target=srv.serve_forever, daemon=True).start()
        base = f"http://127.0.0.1:{srv.server_port}"
        try:
            def post(path, data):
                req = urllib.request.Request(base + path, data=json.dumps(data).encode(), method="POST")
                return json.loads(urllib.request.urlopen(req).read())
            self.assertEqual(post("/cut", {"start": 0, "end": 1.5})["name"], "Mot 1")
            self.assertEqual(json.loads(urllib.request.urlopen(base + "/info").read())["stt"], "fake")
            self.assertTrue(urllib.request.urlopen(base + "/clip?name=Mot%201").read())
            self.assertTrue(urllib.request.urlopen(base + "/").read().startswith(b"<!doctype html>"))
            self.assertEqual(post("/delete", {"name": "../Mot 1"})["ok"], True)
            self.assertFalse((self.out / "Mot 1.mp3").exists())
        finally:
            srv.shutdown()
            srv.server_close()


if __name__ == "__main__":
    unittest.main()
