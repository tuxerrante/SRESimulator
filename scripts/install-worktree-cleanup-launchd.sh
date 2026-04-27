#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if git_common_dir="$(git -C "${SCRIPT_DIR}/.." rev-parse --git-common-dir 2>/dev/null)"; then
  DEFAULT_REPO_ROOT="$(cd "$(dirname "${git_common_dir}")" && pwd)"
else
  DEFAULT_REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
fi
LABEL="com.tuxerrante.sresimulator.worktree-cleanup"
REPO_ROOT="$DEFAULT_REPO_ROOT"
OUTPUT_PATH="${HOME}/Library/LaunchAgents/${LABEL}.plist"
LOG_DIR="${HOME}/Library/Logs/sresimulator"
MAKE_BIN="${MAKE_BIN:-}"

usage() {
  cat <<'EOF'
Usage: install-worktree-cleanup-launchd.sh [--repo-root <path>] [--output <plist-path>] [--log-dir <path>]

Write a launchd plist that runs `make cleanup-worktrees` weekly from the repo root.
EOF
}

fail() {
  echo "error: $*" >&2
  exit 1
}

normalize_dir() {
  local path=$1
  [[ -d "$path" ]] || fail "directory '$path' does not exist"
  (cd "$path" && pwd)
}

normalize_path() {
  local path=$1
  local dir
  dir="$(dirname "$path")"
  mkdir -p "$dir"
  printf '%s/%s\n' "$(cd "$dir" && pwd)" "$(basename "$path")"
}

xml_escape() {
  python3 - "$1" <<'PY'
import sys
from xml.sax.saxutils import escape

print(escape(sys.argv[1]))
PY
}

while (($#)); do
  case "$1" in
    --repo-root)
      [[ $# -ge 2 ]] || fail "--repo-root requires a value"
      REPO_ROOT=$2
      shift 2
      ;;
    --output)
      [[ $# -ge 2 ]] || fail "--output requires a value"
      OUTPUT_PATH=$2
      shift 2
      ;;
    --log-dir)
      [[ $# -ge 2 ]] || fail "--log-dir requires a value"
      LOG_DIR=$2
      shift 2
      ;;
    --label)
      [[ $# -ge 2 ]] || fail "--label requires a value"
      LABEL=$2
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      fail "unknown argument '$1'"
      ;;
  esac
done

if [[ -z "$MAKE_BIN" ]]; then
  MAKE_BIN="$(command -v make || true)"
fi
[[ -n "$MAKE_BIN" ]] || fail "make not found"

REPO_ROOT="$(normalize_dir "$REPO_ROOT")"
OUTPUT_PATH="$(normalize_path "$OUTPUT_PATH")"
mkdir -p "$LOG_DIR"
LOG_DIR="$(normalize_dir "$LOG_DIR")"

escaped_repo_root=$(xml_escape "$REPO_ROOT")
escaped_make_bin=$(xml_escape "$MAKE_BIN")
escaped_stdout=$(xml_escape "$LOG_DIR/worktree-cleanup.stdout.log")
escaped_stderr=$(xml_escape "$LOG_DIR/worktree-cleanup.stderr.log")

cat >"$OUTPUT_PATH" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${escaped_make_bin}</string>
    <string>cleanup-worktrees</string>
  </array>
  <key>WorkingDirectory</key>
  <string>${escaped_repo_root}</string>
  <key>StartCalendarInterval</key>
  <dict>
    <key>Weekday</key>
    <integer>0</integer>
    <key>Hour</key>
    <integer>4</integer>
    <key>Minute</key>
    <integer>0</integer>
  </dict>
  <key>StandardOutPath</key>
  <string>${escaped_stdout}</string>
  <key>StandardErrorPath</key>
  <string>${escaped_stderr}</string>
</dict>
</plist>
EOF

echo "Wrote launchd plist to $OUTPUT_PATH"
