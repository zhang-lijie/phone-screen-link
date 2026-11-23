"""Local, loopback-only web wizard for one-click installation.

Standard library only. Serves a single-page wizard that drives the existing
npm scripts (setup/start), writes config, and opens the browser. No data
leaves the machine; the API Key is never logged or echoed.
"""

import collections
import json
import os
import secrets
import shutil
import socket
import subprocess
import sys
import threading
import urllib.request
import webbrowser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parents[1]
STATE_DIR = PROJECT_ROOT / "state"

_log_lock = threading.Lock()
_logs = collections.deque(maxlen=200)
_session_token = secrets.token_urlsafe(24)
_server = None


def append_log(line):
    with _log_lock:
        _logs.append(str(line))


def read_log_buffer():
    with _log_lock:
        return list(_logs)


def clear_logs():
    with _log_lock:
        _logs.clear()


def check_token(headers, token, fragment):
    """The session token travels in the URL fragment and is sent as a header.

    Never accepted from the query string (leaks in logs/history). `fragment`
    is what the page read from location.hash; headers must match both.
    """
    if not token or not fragment or fragment != token:
        return False
    return headers.get("X-Token") == token


def _tool(path, name):
    found = shutil.which(name, path=path)
    return {"status": "ok" if found else "error", "path": found}


def detect_environment(path, platform_name, project_root):
    """Report tool availability and platform support without running tools."""
    supported = platform_name == "linux"
    tools = {name: _tool(path, name) for name in ("git", "npm", "node", "python3", "uvx", "uv")}
    adb = _tool(path, "adb")
    if adb["status"] != "ok":
        adb = {"status": "warning", "path": None, "hint": "系统未找到 adb，安装时会使用引擎自带的版本"}
    engine_adb = str(Path(project_root) / "engine" / "dependencies" / "adb")
    ports = {}
    for port in (8000, 8100):
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
            sock.settimeout(0.2)
            ports[str(port)] = sock.connect_ex(("127.0.0.1", port)) == 0
    return {
        "supported": supported,
        "reason": "" if supported else "仅支持 Linux x64：引擎在 macOS/Windows 上没有对应构建",
        "platform": platform_name,
        "git": tools["git"],
        "npm": tools["npm"],
        "node": tools["node"],
        "python": tools["python3"],
        "uvx": tools["uvx"] if tools["uvx"]["status"] == "ok" else tools["uv"],
        "adb": adb,
        "engine_adb": engine_adb,
        "ports": ports,
    }


# ---------------------------------------------------------------------------
# State shared with the wizard UI. Mutated by background workers under _state_lock.
_state_lock = threading.Lock()
_state = {"step": "idle", "status": "idle", "detail": "", "detect": None}


def get_state():
    with _state_lock:
        snap = dict(_state)
    snap["logs"] = read_log_buffer()
    return snap


def set_state(**fields):
    with _state_lock:
        _state.update(fields)


CHAT_DEFAULTS = {
    "enabled": True,
    "baseUrl": "http://127.0.0.1:11434/v1",
    "model": "",
    "apiKey": "",
    "maxSteps": 100,
    "screenshot": True,
}


def _write_0600(path, data):
    tmp = path.with_suffix(path.suffix + ".tmp")
    if tmp.exists():
        tmp.unlink()
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump(data, fh, ensure_ascii=False, indent=2)
        fh.write("\n")
    os.chmod(tmp, 0o600)
    os.replace(tmp, path)


def _read_config(path, defaults):
    result = dict(defaults)
    try:
        stored = json.loads(path.read_text("utf-8"))
        if isinstance(stored, dict):
            for key in defaults:
                if key in stored and type(stored[key]) is type(defaults[key]):
                    result[key] = stored[key]
    except (OSError, ValueError):
        pass
    return result


def write_chat_config(root, patch):
    """Merge a wizard patch into state/chat.json, 0600, atomic. Never logs values."""
    state = Path(root) / "state"
    state.mkdir(parents=True, exist_ok=True)
    config = _read_config(state / "chat.json", CHAT_DEFAULTS)
    for key in CHAT_DEFAULTS:
        if key not in patch:
            continue
        value = patch[key]
        if type(value) is not type(CHAT_DEFAULTS[key]):
            continue
        if key == "apiKey" and value == "":
            continue  # blank means keep the stored key
        if key == "maxSteps":
            try:
                value = max(1, min(100, int(value)))
            except (TypeError, ValueError):
                continue
        config[key] = value
    _write_0600(state / "chat.json", config)
    return config


def write_installer_config(root, serial):
    state = Path(root) / "state"
    state.mkdir(parents=True, exist_ok=True)
    config = _read_config(state / "installer.json", {"serial": ""})
    if serial:
        config["serial"] = str(serial)
    _write_0600(state / "installer.json", config)
    return config


def make_start_script(root, serial):
    root = Path(root)
    return (
        "#!/bin/sh\n"
        'cd "$(dirname "$0")"\n'
        'export PHONE_SERIAL="%s"\n'
        'export PATH="$PWD/engine/dependencies/adb:$PATH"\n'
        "exec npm start\n" % serial
    )


def start_app(root):
    """Launch npm start in the background with the right PATH and serial."""
    root = Path(root)
    config = _read_config(root / "state" / "installer.json", {"serial": ""})
    serial = config.get("serial", "")
    script = root / "start.sh"
    script.write_text(make_start_script(root, serial), "utf-8")
    os.chmod(script, 0o755)

    env = os.environ.copy()
    adb_dir = str(root / "engine" / "dependencies" / "adb")
    env["PATH"] = adb_dir + os.pathsep + env.get("PATH", "")
    if serial:
        env["PHONE_SERIAL"] = serial
    log_path = root / "state" / "installer-start.log"
    log_path.parent.mkdir(parents=True, exist_ok=True)
    log = open(log_path, "ab")
    try:
        os.chmod(log_path, 0o600)
    except OSError:
        pass
    subprocess.Popen(
        ["npm", "start"], cwd=str(root), env=env, stdout=log, stderr=subprocess.STDOUT,
        start_new_session=True,
    )
    append_log("npm start launched")


def wait_for_health(timeout=90):
    import time
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            with urllib.request.urlopen("http://127.0.0.1:8100/health", timeout=2) as resp:
                data = json.loads(resp.read().decode("utf-8"))
                if data.get("online"):
                    return True
        except Exception:
            pass
        time.sleep(1)
    return False


class Handler(BaseHTTPRequestHandler):
    server_version = "PhoneScreenLinkWizard/1.0"

    def log_message(self, fmt, *args):
        # Do not log request bodies (config writes contain the API Key).
        append_log("%s - %s" % (self.address_string(), fmt % args))

    def _json(self, obj, status=200):
        body = json.dumps(obj).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _valid_request(self):
        host = self.headers.get("Host", "")
        origin = self.headers.get("Origin")
        port = self.server.server_address[1]
        if host not in ("127.0.0.1:%d" % port, "localhost:%d" % port):
            return False
        if origin and origin not in ("http://127.0.0.1:%d" % port, "http://localhost:%d" % port):
            return False
        return True

    def do_GET(self):
        if not self._valid_request():
            self._json({"error": "forbidden"}, 403)
            return
        if self.path.startswith("/api/state"):
            self._json(get_state())
            return
        if self.path.startswith("/api/"):
            self._json({"error": "not found"}, 404)
            return
        try:
            html = (Path(__file__).parent / "web" / "index.html").read_text("utf-8")
        except OSError:
            html = "<h1>Wizard UI missing</h1>"
        html = html.replace("__TOKEN__", _session_token).replace("__PORT__", str(self.server.server_address[1]))
        body = html.encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self):
        if not self._valid_request():
            self._json({"error": "forbidden"}, 403)
            return
        length = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(length) if length else b"{}"
        try:
            body = json.loads(raw.decode("utf-8"))
        except (ValueError, UnicodeDecodeError):
            self._json({"error": "invalid json"}, 400)
            return

        path = self.path.split("?", 1)[0]
        if path == "/api/state":
            self._json(get_state())
            return

        fragment = body.get("token", "")
        if not check_token(self.headers, _session_token, fragment):
            self._json({"error": "forbidden"}, 403)
            return

        if path == "/api/detect":
            result = detect_environment(os.environ.get("PATH", ""), sys.platform, str(PROJECT_ROOT))
            set_state(step="detect", detect=result, status="ok" if result["supported"] else "error",
                      detail=result["reason"] or "环境检测完成")
            self._json(result)
            return

        if path == "/api/config":
            # apiKey lives only in body; never logged.
            patch = {k: body[k] for k in CHAT_DEFAULTS if k in body}
            config = write_chat_config(PROJECT_ROOT, patch)
            write_installer_config(PROJECT_ROOT, body.get("serial", ""))
            self._json({"ok": True, "model": config.get("model", ""),
                        "hasApiKey": bool(config.get("apiKey"))})
            return

        if path == "/api/install":
            def work():
                set_state(step="install", status="running", detail="Installing dependencies")
                try:
                    for args, label in (
                        (["npm", "install"], "npm install"),
                        (["npm", "run", "setup"], "npm run setup"),
                    ):
                        append_log("$ " + label)
                        proc = subprocess.Popen(args, cwd=str(PROJECT_ROOT), stdout=subprocess.PIPE,
                                                stderr=subprocess.STDOUT, text=True)
                        for line in proc.stdout:
                            append_log(line.rstrip())
                        code = proc.wait()
                        if code != 0:
                            set_state(status="error", detail="%s failed (exit %d)" % (label, code))
                            return
                    set_state(status="ok", detail="Dependencies ready")
                except Exception as exc:
                    set_state(status="error", detail=str(exc))
            threading.Thread(target=work, daemon=True).start()
            self._json({"ok": True})
            return

        if path == "/api/start":
            try:
                start_app(PROJECT_ROOT)
                ok = wait_for_health()
                if ok:
                    set_state(step="start", status="ok", detail="投屏服务已就绪")
                else:
                    set_state(step="start", status="error", detail="服务启动超时，请查看日志")
            except Exception as exc:
                set_state(step="start", status="error", detail=str(exc))
            self._json({"ok": True})
            return

        if path == "/api/open":
            url = "http://127.0.0.1:8000/"
            try:
                opened = webbrowser.open(url)
            except Exception:
                opened = False
            if not opened:
                append_log("Open this URL in a browser: " + url)
            self._json({"ok": True, "opened": opened, "url": url})
            return

        if path == "/api/quit":
            self._json({"ok": True})
            threading.Thread(target=_server.shutdown, daemon=True).start()
            return

        self._json({"error": "not found"}, 404)


def main():
    global _server
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 0
    _server = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    actual = _server.server_address[1]
    url = "http://127.0.0.1:%d/#token=%s" % (actual, _session_token)
    print("Wizard: %s" % url)
    try:
        if not webbrowser.open(url):
            print("Open the URL above in your browser.")
    except Exception:
        print("Open the URL above in your browser.")
    try:
        _server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        _server.server_close()


if __name__ == "__main__":
    main()
