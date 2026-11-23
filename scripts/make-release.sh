#!/bin/sh
# Build a release tarball from a git tag (never from the working tree).
# Usage: make-release.sh [--dir OUT] TAG
#   OUT   output directory (default: current directory)
#   TAG   git tag, e.g. v1.0.0
set -eu

OUT="."
TAG=""
while [ $# -gt 0 ]; do
  case "$1" in
    --dir) OUT="$2"; shift 2 ;;
    *) TAG="$1"; shift ;;
  esac
done

if [ -z "$TAG" ]; then
  echo "usage: make-release.sh [--dir OUT] TAG" >&2
  exit 2
fi

VER="${TAG#v}"
TOP="phone-screen-link-$VER"
TAR="$OUT/$TOP.tar.gz"
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT
mkdir -p "$WORK/$TOP"

# Archive the tagged tree; our own code + installer only. No engine/node_modules/state.
git archive "$TAG" | tar -x -C "$WORK/$TOP"

# Remove paths that must not ship in a source-style release bundle.
rm -rf "$WORK/$TOP"/tests \
       "$WORK/$TOP/engine" \
       "$WORK/$TOP/node_modules" \
       "$WORK/$TOP/state" \
       "$WORK/$TOP/.git" \
       "$WORK/$TOP/.superpowers" \
       "$WORK/$TOP/.worktrees"
find "$WORK/$TOP" -name '*.log' -type f -delete
chmod +x "$WORK/$TOP/install.sh" 2>/dev/null || true

mkdir -p "$OUT"
tar czf "$TAR" -C "$WORK" "$TOP"
echo "built $TAR"
