import shutil
import subprocess
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


@unittest.skipUnless(shutil.which("node"), "node nicht installiert")
class GeheimTests(unittest.TestCase):
    def test_roundtrip_with_webcrypto(self):
        r = subprocess.run(["node", "tests/geheim.test.cjs"], cwd=ROOT, capture_output=True, text=True)
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)

    def test_no_secrets_writes_nothing(self):
        import os, tempfile
        with tempfile.TemporaryDirectory() as d:
            out = Path(d) / "geheim.json"
            env = {k: v for k, v in os.environ.items() if not k.startswith("DRIVE_")}
            r = subprocess.run(["node", "scripts/encrypt_link.cjs", str(out)], cwd=ROOT, env=env, capture_output=True, text=True)
            self.assertEqual(r.returncode, 0)
            self.assertFalse(out.exists())
            env.update(DRIVE_LINK="https://x.example/a", DRIVE_PASSWORT="pw")
            subprocess.run(["node", "scripts/encrypt_link.cjs", str(out)], cwd=ROOT, env=env, check=True, capture_output=True)
            self.assertTrue(out.exists())
            self.assertNotIn("x.example", out.read_text())


if __name__ == "__main__":
    unittest.main()
