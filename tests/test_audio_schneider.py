import json
import shutil
import subprocess
import tempfile
import threading
import unittest
import urllib.request
from http.server import ThreadingHTTPServer
from pathlib import Path

from scripts.audio_schneider import schneider as sc

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
            def __call__(self, path):
                return "Depuis."
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
