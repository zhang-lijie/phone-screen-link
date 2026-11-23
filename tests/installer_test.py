import os
import stat
import subprocess
import socket
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


class ReleaseTarballTest(unittest.TestCase):
    def test_release_tarball_excludes_runtime_only_dirs(self):
        root = Path(__file__).resolve().parents[1]
        tag = "v0.0.0-release-test"
        # create a temporary tag at HEAD for git archive
        subprocess.run(["git", "tag", "-f", "-m", "release test", tag, "HEAD"], cwd=root, check=True,
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        try:
            with tempfile.TemporaryDirectory() as out:
                proc = subprocess.run(
                    ["bash", str(root / "scripts" / "make-release.sh"), "--dir", out, tag],
                    capture_output=True, text=True, cwd=root)
                self.assertEqual(proc.returncode, 0, proc.stdout + proc.stderr)
                tar = Path(out) / ("phone-screen-link-%s.tar.gz" % tag.lstrip("v"))
                self.assertTrue(tar.exists(), proc.stdout + proc.stderr)
                import tarfile
                with tarfile.open(tar) as tf:
                    names = tf.getnames()
                    top = "phone-screen-link-%s" % tag.lstrip("v")
                    self.assertTrue(any(n == top or n.startswith(top + "/") for n in names))
                    self.assertTrue(any(n.endswith("/install.sh") for n in names))
                    self.assertTrue(any(n.endswith("/package-lock.json") for n in names))
                    self.assertTrue(any(n.endswith("/LICENSE") for n in names))
                    self.assertTrue(any("installer/server.py" in n for n in names))
                    bad = ["/engine/", "/node_modules/", "/state/", "/tests/", "/.git/", ".log"]
                    for n in names:
                        self.assertFalse(any(b in n for b in bad), "unexpected path: " + n)
                    member = next(tf.getmember(n) for n in names if n.endswith("/install.sh"))
                    self.assertTrue(member.mode & stat.S_IXUSR, "install.sh must be executable")
        finally:
            subprocess.run(["git", "tag", "-d", tag], cwd=root,
                           stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


class RootIsolationTest(unittest.TestCase):
    def test_server_root_can_be_overridden_by_env(self):
        code = (
            "import os,sys;sys.path.insert(0,%r);"
            "import installer.server as s;print(s.PROJECT_ROOT)"
        ) % str(Path(__file__).resolve().parents[1])
        with tempfile.TemporaryDirectory() as d:
            env = os.environ.copy()
            env["PHONE_SCREEN_LINK_ROOT"] = d
            proc = subprocess.run([sys.executable, "-c", code], capture_output=True,
                                  text=True, env=env)
            self.assertEqual(proc.stdout.strip(), d)


class ReviewFixesTest(unittest.TestCase):
    def test_readiness_accepts_ok_without_online(self):
        ready, online, detail = srv.readiness_from_health({"ok": True, "online": False})
        self.assertTrue(ready)
        self.assertFalse(online)
        self.assertIn("等待手机", detail)
        ready, online, _ = srv.readiness_from_health({"ok": True, "online": True})
        self.assertTrue(ready and online)
        self.assertEqual(srv.readiness_from_health(None)[0], False)
        self.assertEqual(srv.readiness_from_health({"ok": False})[0], False)

    def test_config_blank_baseurl_model_keep_stored(self):
        with tempfile.TemporaryDirectory() as d:
            root = Path(d)
            srv.write_chat_config(root, {"baseUrl": "http://my-model:8000/v1", "model": "m1"})
            result = srv.write_chat_config(root, {"baseUrl": "", "model": ""})
            self.assertEqual(result["baseUrl"], "http://my-model:8000/v1")
            self.assertEqual(result["model"], "m1")

    def test_detect_rejects_non_x64(self):
        result = srv.detect_environment("/usr/bin", "linux", "/x", machine="aarch64")
        self.assertFalse(result["supported"])
        self.assertIn("Linux x64", result["reason"])

    def test_detect_marks_port_conflict(self):
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
            s.bind(("127.0.0.1", 0))
            s.listen(1)
            port = s.getsockname()[1]
            # detect while the socket is still listening
            result = srv.detect_environment("/usr/bin", "linux", "/x", probe_ports=(port,))
        self.assertTrue(result["ports"].get(str(port)))
        self.assertIn("ports", result)


class DarwinGateTest(unittest.TestCase):
    def test_detect_accepts_darwin_arm64(self):
        result = srv.detect_environment("/usr/bin", "darwin", "/x", machine="arm64")
        self.assertTrue(result["supported"])
        self.assertEqual(result["reason"], "")

    def test_detect_rejects_darwin_x64(self):
        result = srv.detect_environment("/usr/bin", "darwin", "/x", machine="x86_64")
        self.assertFalse(result["supported"])
        self.assertIn("arm64", result["reason"])

    def test_install_sh_accepts_darwin_arm64(self):
        with tempfile.TemporaryDirectory() as d:
            bindir = Path(d) / "bin"
            bindir.mkdir()
            for name, out in (("uname", None),):
                pass
            # stub uname: -s -> Darwin, -m -> arm64
            stub = bindir / "uname"
            stub.write_text('#!/bin/sh\ncase "$1" in -s) echo Darwin;; -m) echo arm64;; *) echo Darwin;; esac\n')
            stub.chmod(0o755)
            env = os.environ.copy()
            env["PATH"] = str(bindir) + os.pathsep + env.get("PATH", "")
            env["HOME"] = d
            env["PHONE_SCREEN_LINK_DRY_RUN"] = "1"
            proc = subprocess.run(["bash", str(Path(__file__).resolve().parents[1] / "install.sh")],
                                  capture_output=True, text=True, env=env, cwd=d)
            self.assertEqual(proc.returncode, 0, proc.stdout + proc.stderr)
            self.assertIn("安装目录", proc.stdout)

    def test_install_sh_rejects_darwin_x64(self):
        with tempfile.TemporaryDirectory() as d:
            bindir = Path(d) / "bin"
            bindir.mkdir()
            stub = bindir / "uname"
            stub.write_text('#!/bin/sh\ncase "$1" in -s) echo Darwin;; -m) echo x86_64;; *) echo Darwin;; esac\n')
            stub.chmod(0o755)
            env = os.environ.copy()
            env["PATH"] = str(bindir) + os.pathsep + env.get("PATH", "")
            env["HOME"] = d
            env["PHONE_SCREEN_LINK_DRY_RUN"] = "1"
            proc = subprocess.run(["bash", str(Path(__file__).resolve().parents[1] / "install.sh")],
                                  capture_output=True, text=True, env=env, cwd=d)
            self.assertNotEqual(proc.returncode, 0)
            self.assertIn("arm64", proc.stdout + proc.stderr)
