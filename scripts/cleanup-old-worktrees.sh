#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if git_common_dir="$(git -C "${SCRIPT_DIR}/.." rev-parse --git-common-dir 2>/dev/null)"; then
  DEFAULT_ROOT="$(cd "$(dirname "${git_common_dir}")" && pwd)"
else
  DEFAULT_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
fi
DAYS=14
DRY_RUN=false
ROOT_DIR="$DEFAULT_ROOT"
TARGET_NAMES=(node_modules .next dist coverage .cache build out .turbo tmp .pytest_cache)

usage() {
  cat <<'EOF'
Usage: cleanup-old-worktrees.sh [--root <repo-root>] [--days <n>] [--dry-run]

Remove generated directories from old worktrees without touching source files,
branches, or worktree registrations.
EOF
}

fail() {
  echo "error: $*" >&2
  exit 1
}

dir_mtime() {
  local path=$1
  if stat -f %m "$path" >/dev/null 2>&1; then
    stat -f %m "$path"
  else
    stat -c %Y "$path"
  fi
}

dir_size_kb() {
  local path=$1
  du -sk "$path" | awk '{print $1}'
}

human_size() {
  python3 - "$1" <<'PY'
import sys

size = float(sys.argv[1])
for unit in ("KB", "MB", "GB", "TB"):
    if size < 1024 or unit == "TB":
        print(f"{size:.1f}{unit}")
        break
    size /= 1024
PY
}

matches=()
removed_count=0
removed_kb=0

while (($#)); do
  case "$1" in
    --root)
      [[ $# -ge 2 ]] || fail "--root requires a value"
      ROOT_DIR=$2
      shift 2
      ;;
    --days)
      [[ $# -ge 2 ]] || fail "--days requires a value"
      DAYS=$2
      shift 2
      ;;
    --dry-run)
      DRY_RUN=true
      shift
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

[[ $DAYS =~ ^[0-9]+$ ]] || fail "--days must be an integer"
[[ -d "$ROOT_DIR" ]] || fail "root directory '$ROOT_DIR' does not exist"

WORKTREES_DIR="$ROOT_DIR/.worktrees"
[[ -d "$WORKTREES_DIR" ]] || fail "worktrees directory '$WORKTREES_DIR' does not exist"

now_epoch=$(date +%s)
cutoff_seconds=$((DAYS * 24 * 60 * 60))

while IFS= read -r -d '' worktree; do
  worktree_mtime=$(dir_mtime "$worktree")
  age_seconds=$((now_epoch - worktree_mtime))
  if ((age_seconds < cutoff_seconds)); then
    continue
  fi

  bases=("$worktree")
  while IFS= read -r -d '' child; do
    bases+=("$child")
  done < <(find "$worktree" -mindepth 1 -maxdepth 1 -type d -print0)

  for base in "${bases[@]}"; do
    for name in "${TARGET_NAMES[@]}"; do
      candidate="$base/$name"
      if [[ -d "$candidate" ]]; then
        matches+=("$candidate")
      fi
    done
  done
done < <(find "$WORKTREES_DIR" -mindepth 1 -maxdepth 1 -type d -print0)

if ((${#matches[@]} == 0)); then
  echo "No matching generated directories found in worktrees older than ${DAYS} days."
  exit 0
fi

for path in "${matches[@]}"; do
  size_kb=$(dir_size_kb "$path")
  removed_kb=$((removed_kb + size_kb))
  if [[ "$DRY_RUN" == true ]]; then
    echo "Would remove $path"
  else
    rm -rf "$path"
    echo "Removed $path"
  fi
  removed_count=$((removed_count + 1))
done

action="Matched"
[[ "$DRY_RUN" == true ]] || action="Removed"
echo "${action} directories: ${removed_count}"
echo "Approx reclaimed space: $(human_size "$removed_kb")"
