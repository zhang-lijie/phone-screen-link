#!/bin/sh
# One-click bootstrap for phone-screen-link (Linux x64 only).
# Two modes:
#   1. Run next to installer/server.py (extracted release): start the wizard here.
#   2. Downloaded alone via curl: fetch the release tarball into the fixed
#      install dir and start the wizard there.
set -eu

INSTALL_DIR="$HOME/.local/share/phone-screen-link"
RELEASE_URL="https://github.com/zhang-lijie/phone-screen-link/releases/download/v1.0.0/phone-screen-link-1.0.0.tar.gz"
DRY_RUN="${PHONE_SCREEN_LINK_DRY_RUN:-0}"

if [ "$(uname -s)" != "Linux" ]; then
  echo "仅支持 Linux x64；当前系统: $(uname -s)" >&2
  exit 1
fi

if ! command -v python3 >/dev/null 2>&1; then
  echo "需要 python3（安装向导用它启动本地服务）。请先安装 python3。" >&2
  exit 1
fi

echo "安装目录: $INSTALL_DIR"

if [ "$DRY_RUN" = "1" ]; then
  echo "dry-run: 跳过实际执行"
  exit 0
fi

# Mode 1: running from an extracted project (has installer/server.py beside us).
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
if [ -f "$SCRIPT_DIR/installer/server.py" ]; then
  cd "$SCRIPT_DIR"
  exec python3 installer/server.py
fi

# Mode 2: downloaded alone. Use the existing install if present; else fetch.
if [ -f "$INSTALL_DIR/installer/server.py" ]; then
  cd "$INSTALL_DIR"
  exec python3 installer/server.py
fi

echo "首次安装，正在下载 $RELEASE_URL" >&2
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
if command -v curl >/dev/null 2>&1; then
  curl -fsSL "$RELEASE_URL" -o "$TMP/pkg.tar.gz"
elif command -v wget >/dev/null 2>&1; then
  wget -q "$RELEASE_URL" -O "$TMP/pkg.tar.gz"
else
  echo "需要 curl 或 wget 下载安装包。" >&2
  exit 1
fi
mkdir -p "$TMP/extract"
tar xzf "$TMP/pkg.tar.gz" -C "$TMP/extract"
SRC=$(find "$TMP/extract" -mindepth 1 -maxdepth 1 -type d | head -n 1)
mkdir -p "$INSTALL_DIR"
cp -R "$SRC"/. "$INSTALL_DIR"/
chmod +x "$INSTALL_DIR/install.sh" 2>/dev/null || true
cd "$INSTALL_DIR"
exec python3 installer/server.py
