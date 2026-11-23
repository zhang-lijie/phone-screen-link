import os
import stat
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from installer import server as srv


class TokenTest(unittest.TestCase):
    def test_token_from_fragment_is_accepted_and_query_rejected(self):
        token = "t0"
        self.assertTrue(srv.check_token({"X-Token": token}, token, fragment=token))
        self.assertFalse(srv.check_token({"X-Token": token}, token, fragment="other"))
        self.assertFalse(srv.check_token({}, token, fragment=token))
        self.assertFalse(srv.check_token({"X-Token": token}, token, fragment=None))


class DetectTest(unittest.TestCase):
    def test_detect_marks_missing_git_as_error_and_adb_as_warning(self):
        with tempfile.TemporaryDirectory() as d:
            result = srv.detect_environment(path=d, platform_name="linux", project_root=d)
        self.assertEqual(result["git"]["status"], "error")
        self.assertEqual(result["adb"]["status"], "warning")
        self.assertTrue(result["engine_adb"].endswith("engine/dependencies/adb"))

    def test_detect_rejects_unsupported_platform(self):
        result = srv.detect_environment(path="/usr/bin", platform_name="darwin", project_root="/x")
        self.assertFalse(result["supported"])
        self.assertIn("Linux", result["reason"])

    def test_detect_reports_ready_when_tools_present(self):
        with tempfile.TemporaryDirectory() as d:
            for name in ("git", "npm", "node", "python3", "uvx"):
                p = Path(d) / name
                p.write_text("#!/bin/sh\n")
                p.chmod(0o755)
            result = srv.detect_environment(path=d, platform_name="linux", project_root=d)
        self.assertEqual(result["git"]["status"], "ok")
        self.assertEqual(result["uvx"]["status"], "ok")
        self.assertTrue(result["supported"])


class LogBufferTest(unittest.TestCase):
    def test_log_buffer_caps_at_200(self):
        srv.clear_logs()
        for i in range(300):
            srv.append_log(f"line {i}")
        logs = srv.read_log_buffer()
        self.assertEqual(len(logs), 200)
        self.assertEqual(logs[-1], "line 299")


if __name__ == "__main__":
    unittest.main()


class ConfigTest(unittest.TestCase):
    def test_write_chat_config_merges_and_keeps_key(self):
        with tempfile.TemporaryDirectory() as d:
            root = Path(d)
            cfg = root / "state" / "chat.json"
            cfg.parent.mkdir()
            cfg.write_text('{"apiKey":"K","model":"old"}')
            result = srv.write_chat_config(root, {"apiKey": "", "model": "new"})
            self.assertEqual(result["model"], "new")
            self.assertEqual(result["apiKey"], "K")
            self.assertEqual(stat.S_IMODE(cfg.stat().st_mode), 0o600)
            self.assertFalse(list(cfg.parent.glob("*.tmp")))

    def test_write_chat_config_clamps_maxsteps(self):
        with tempfile.TemporaryDirectory() as d:
            root = Path(d)
            a = srv.write_chat_config(root, {"maxSteps": 200})
            b = srv.write_chat_config(root, {"maxSteps": 0})
            self.assertEqual(a["maxSteps"], 100)
            self.assertEqual(b["maxSteps"], 1)

    def test_make_start_script_prepends_engine_adb_and_serial(self):
        with tempfile.TemporaryDirectory() as d:
            root = Path(d)
            script = srv.make_start_script(root, "SERIAL123")
            self.assertIn('export PHONE_SERIAL="SERIAL123"', script)
            self.assertIn("engine/dependencies/adb", script)
            self.assertIn("exec npm start", script)

    def test_config_never_logged(self):
        srv.clear_logs()
        with tempfile.TemporaryDirectory() as d:
            srv.write_chat_config(Path(d), {"apiKey": "SECRET"})
        self.assertNotIn("SECRET", "\n".join(srv.read_log_buffer()))


class InstallShTest(unittest.TestCase):
    def test_install_sh_bootstrap_directory(self):
        with tempfile.TemporaryDirectory() as d:
            env = os.environ.copy()
            env["HOME"] = d
            env["PHONE_SCREEN_LINK_DRY_RUN"] = "1"
            proc = subprocess.run(["bash", str(Path(__file__).resolve().parents[1] / "install.sh")],
                                  capture_output=True, text=True, env=env, cwd=d)
            out = proc.stdout + proc.stderr
            self.assertIn(".local/share/phone-screen-link", out)
            self.assertEqual(proc.returncode, 0)
