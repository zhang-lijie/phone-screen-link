# One-Click Release Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a Linux-only `v1.0.0` GitHub Release with a `curl | bash` bootstrap that lands in `~/.local/share/phone-screen-link` and opens a local web wizard for install/config/start.

**Architecture:** A POSIX `install.sh` bootstraps a stdlib-only Python loopback HTTP server (`installer/server.py`) whose single-page UI (`installer/web/index.html`) calls four APIs to detect the environment, run the existing npm scripts, write config, and launch the app. A `make-release.sh` builds the tarball from the tag; release publishing is done with `gh`.

**Tech Stack:** POSIX shell, Python 3 stdlib (`http.server`, `subprocess`, `threading`, `secrets`, `deque`, `webbrowser`), Node/npm (existing), `gh` CLI, git.

**Spec:** `docs/superpowers/specs/2026-11-23-one-click-release-design.md`

## Global Constraints

- Linux x64 only; Windows/macOS explicitly unsupported in docs and release notes.
- Release tarball excludes `engine/`, `node_modules/`, `state/`, `.git/`, `.superpowers/`, `.worktrees/`, `tests/`, `*.log`; keeps `package-lock.json`, `docs/screenshots/`, executable bit on `install.sh`, single top-level dir.
- Bootstrap install directory: `~/.local/share/phone-screen-link`; re-run with an existing install starts the wizard without overwriting user data.
- Wizard server binds `127.0.0.1` only; one token per session in URL fragment, sent as header on writes; `Host`/`Origin` checked; API Key never logged or echoed; all generated state files `0600`.
- `maxSteps` clamp 1..100 (matches code); README says 1..32 — fix it.
- Health URL is `http://127.0.0.1:8100/health`; browser URL is `http://127.0.0.1:8000/`.
- `git` and `adb` handling per spec detect (git required; system adb optional, prepend engine's adb dir to PATH on start).

## Review Focus

- Fresh user with no Node/npm: detect reports what is missing with a readable hint, not a crash — pinned by Task 2 detect tests.
- Re-run install after first setup: wizard must not overwrite `state/chat.json` or rebuild engine unnecessarily — pinned by Task 3 config-merge test and Task 4 idempotence check.
- API Key typed in wizard never appears in logs or `/api/state` — pinned by Task 3 config test.
- `curl | bash` with no existing install fetches the release tarball into the fixed directory, not /tmp — pinned by Task 4 install.sh check.
- Tarball from tag has no `engine/`/`node_modules/`/`state/` and `install.sh` is executable — pinned by Task 5 packaging test.

---

### Task 1: LICENSE and README corrections

**Files:**
- Create: `LICENSE` (MIT, Copyright 2026 zhang-lijie)
- Modify: `README.md` (one-click section at top; `maxSteps` 1..32 → 1..100; Linux-only note)

**Interfaces:** none.

- [ ] **Step 1: Add MIT LICENSE file** with standard text, `Copyright (c) 2026 zhang-lijie`.
- [ ] **Step 2: Add README "一键安装" section** before "快速开始", containing both forms: `curl -fsSL https://raw.githubusercontent.com/zhang-lijie/phone-screen-link/v1.0.0/install.sh | bash`, and download `phone-screen-link-1.0.0.tar.gz` → `tar xf` → `./install.sh`. State: Linux x64 only; install dir `~/.local/share/phone-screen-link`; existing install re-run just starts the wizard; engine fetched on first install (network required).
- [ ] **Step 3: Fix stale docs** — replace `1..32`/`1-32` with `1..100` for maxSteps; add a short "平台：仅 Linux x64" note near 快速开始.
- [ ] **Step 4: Verify** — `grep -n '1\\.\\.100' README.md` and `head -5 LICENSE`.
- [ ] **Step 5: Commit** — `git add LICENSE README.md && git commit -m "docs: MIT license and one-click install section"`.

### Task 2: installer/server.py core, token and detection

**Files:**
- Create: `installer/server.py`
- Test: `tests/installer_test.py`

**Interfaces:**
- Consumes: nothing external beyond stdlib.
- Produces: `read_env()` detection dict, `check_token(header, fragment)` bool, `Handler` class with `do_GET`/`do_POST`, `main(token?)`.

- [ ] **Step 1: Write failing tests** in `tests/installer_test.py` (Python `unittest`):
  - `test_token_from_fragment_is_accepted_and_query_rejected`: per-session token `t0`; header `X-Token: t0` accepted, wrong token rejected, token in `?token=t0` query rejected.
  - `test_detect_marks_missing_git_as_error_and_system_adb_as_warning`: call `detect_environment(path=..., platform_name='linux')` with a fake PATH containing no `git` and no `adb`; assert `git.status == 'error'` and `adb.status == 'warning'`, and `engine_adb` path is reported.
  - `test_detect_rejects_unsupported_platform`: `detect_environment(platform_name='darwin')` returns `supported=False` with reason mentioning Linux.
  - `test_log_buffer_caps_at_200`: push 300 lines, assert len == 200.
- [ ] **Step 2: Run `python3 -m unittest discover -s tests -p 'installer_test.py' -v`** → FAIL (module missing).
- [ ] **Step 3: Implement `installer/server.py`** — module-level functions with exact signatures `detect_environment(path: str, platform_name: str) -> dict`, `read_log_buffer() -> list`, `append_log(line: str)`, token helpers; a `Handler(BaseHTTPRequestHandler)` serving `GET /` (HTML with injected token in fragment), `GET /api/state`, `POST /api/detect`, `/api/install`, `/api/config`, `/api/start`, `/api/open`, `/api/quit`. Bind `('127.0.0.1', 0)`; generate token with `secrets.token_urlsafe(24)`; every POST requires `X-Token` header equal to session token and `Host`/`Origin` matching the bound address; log buffer is a lock-protected `deque(maxlen=200)`. Detection never executes external commands except `shutil.which` and `socket.connect_ex` for ports.
- [ ] **Step 4: Run the unittest command** → all pass.
- [ ] **Step 5: Commit** — `git add installer/server.py tests/installer_test.py && git commit -m "feat: loopback wizard server core with token and detection"`.

### Task 3: installer/server.py config and start wiring

**Files:**
- Modify: `installer/server.py`, `tests/installer_test.py`

**Interfaces:**
- Consumes: `Handler`, `detect_environment` from Task 2.
- Produces: `write_chat_config(root, patch, existing)` (merges, 0600, atomic), `write_installer_config(root, serial)`, `make_start_script(root, serial)`.

- [ ] **Step 1: Write failing tests** in `tests/installer_test.py`:
  - `test_write_chat_config_merges_and_keeps_key`: existing `{"apiKey":"K","model":"old"}`; patch `{"apiKey":"","model":"new"}` → result `model=new`, `apiKey=K`; file mode `0o600`; temp file removed.
  - `test_write_chat_config_clamps_maxsteps_to_100`: patch `maxSteps=200` → stored 100; `maxSteps=0` → 1.
  - `test_make_start_script_prepends_engine_adb_and_serial`: script contains `export PHONE_SERIAL="SERIAL"`, `engine/dependencies/adb`, `exec npm start`.
  - `test_config_never_logged`: calling the config write path with `apiKey='SECRET'` produces no `'SECRET'` in the log buffer.
- [ ] **Step 2: Run unittest** → FAIL.
- [ ] **Step 3: Implement** the three functions and wire them into `/api/config` and `/api/start`: `/api/start` writes installer config, generates `start.sh`, prepends `<root>/engine/dependencies/adb` to `PATH`, sets `PHONE_SERIAL` from installer config, spawns `npm start` with `start_new_session=True`, redirects stdout/stderr to `state/installer-start.log` (0600), polls `http://127.0.0.1:8100/health` until `online:true` or 90s timeout. `/api/open` calls `webbrowser.open('http://127.0.0.1:8000/')`, falling back to printing the URL if it returns false.
- [ ] **Step 4: Run unittest** → all pass.
- [ ] **Step 5: Commit** — `git add installer/server.py tests/installer_test.py && git commit -m "feat: wizard config persistence and app launch"`.

### Task 4: install.sh bootstrap and wizard UI

**Files:**
- Create: `install.sh`, `installer/web/index.html`
- Test: `tests/installer_test.py` (shell assertions via subprocess)

**Interfaces:**
- Consumes: `installer/server.py` from Tasks 2–3.
- Produces: none consumed by later code.

- [ ] **Step 1: Write failing test** `test_install_sh_bootstrap_directory`: source `install.sh` with `HOME` set to a temp dir and `PHONE_SCREEN_LINK_DRY_RUN=1`; assert computed install dir equals `<tmp>/.local/share/phone-screen-link`, and that with an existing `installer/server.py` in CWD the script execs it directly (no download).
- [ ] **Step 2: Run unittest** → FAIL.
- [ ] **Step 3: Implement `install.sh`** — POSIX shell: refuse non-Linux via `uname -s`; require `python3`; compute `INSTALL_DIR="$HOME/.local/share/phone-screen-link"`; if `$0` sits next to `installer/server.py`, `cd` there and `exec python3 installer/server.py`; otherwise (downloaded via curl) use `$INSTALL_DIR/installer/server.py` if present, else fetch `https://github.com/zhang-lijie/phone-screen-link/releases/download/v1.0.0/phone-screen-link-1.0.0.tar.gz` to a temp file, extract to a temp dir, `mkdir -p "$INSTALL_DIR"`, move the single top-level dir contents into `$INSTALL_DIR`, then `cd "$INSTALL_DIR" && exec python3 installer/server.py`. Dry-run env skips the actual exec/download after printing the computed path.
- [ ] **Step 4: Implement `installer/web/index.html`** — single self-contained page: reads token from `location.hash`, sends `X-Token` on every POST, polls `/api/state` every 500ms, four steps (detect → install → config → start) with progress/log panel, error hints, and final "打开投屏" button calling `/api/open`; no external assets.
- [ ] **Step 5: Run the unittest command** → all pass; `bash -n install.sh` clean.
- [ ] **Step 6: Commit** — `git add install.sh installer/web/index.html tests/installer_test.py && git commit -m "feat: install.sh bootstrap and local web wizard UI"`.

### Task 5: make-release.sh and end-to-end wizard verification

**Files:**
- Create: `scripts/make-release.sh`
- Modify: `tests/installer_test.py` (packaging assertions)

**Interfaces:**
- Consumes: all files from Tasks 1–4; tag `v1.0.0` (created in Task 6).
- Produces: `phone-screen-link-1.0.0.tar.gz`.

- [ ] **Step 1: Write failing test** `test_release_tarball_excludes_runtime_only_dirs`: run `bash scripts/make-release.sh --dir <tmpdir> v1.0.0` against a prepared checkout at tag; assert tar contains top-level `phone-screen-link-1.0.0/`, contains `install.sh` with executable bit, `package-lock.json`, `LICENSE`, `installer/`; excludes `engine/`, `node_modules/`, `state/`, `tests/`, `.git/`.
- [ ] **Step 2: Run unittest** → FAIL.
- [ ] **Step 3: Implement `scripts/make-release.sh`** — usage `make-release.sh [--dir OUT] TAG`; use `git archive "$TAG"` piped to `tar -x` into `<out>/phone-screen-link-1.0.0`, remove excluded paths, `chmod +x install.sh`, then `tar czf <out>/phone-screen-link-1.0.0.tar.gz -C <out> phone-screen-link-1.0.0`. Keep `docs/screenshots/`.
- [ ] **Step 4: Run unittest** → all pass.
- [ ] **Step 5: End-to-end wizard smoke** — start `python3 installer/server.py` in the project, open the printed URL with ego-browser, click through detect/install/config/start; assert the final page offers "打开投屏" and the bridge `/health` returns `online:true`. Use a throwaway config path so the live `state/chat.json` is not altered.
- [ ] **Step 6: Commit** — `git add scripts/make-release.sh tests/installer_test.py && git commit -m "feat: release tarball builder and wizard smoke test"`.

### Task 6: Publish the release

**Files:** none (git/gh operations only).

**Interfaces:** consumes tag/commit from Task 5.

- [ ] **Step 1: Preflight** — `git status --short` must show only the untracked user file `scripts/phone-root-check.sh` (do not add it); `npm test` green; `python3 -m unittest discover -s tests -p 'installer_test.py' -v` green.
- [ ] **Step 2: Push and tag** — `git push origin master && git tag v1.0.0 && git push origin v1.0.0`.
- [ ] **Step 3: Build tarball** — `bash scripts/make-release.sh . v1.0.0`.
- [ ] **Step 4: Create release** — `gh release create v1.0.0 phone-screen-link-1.0.0.tar.gz --title "v1.0.0 — Linux 一键安装" --notes "<notes: Linux x64 only; install dir; engine GPL fetched at install; MIT wrapper; quick start commands>"`.
- [ ] **Step 5: Verify** — `gh release view v1.0.0`, `curl -fsSL` the raw `install.sh` URL and the release asset URL; extract the asset in a temp dir and confirm `install.sh` executable and layout; run the exact `curl … | bash` one-liner in a throwaway HOME if feasible, otherwise document why not.
- [ ] **Step 6: Report** — give the release URL and the verification results to the human partner.
