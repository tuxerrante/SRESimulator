#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BACKEND_DOCKERFILE="$ROOT_DIR/backend/Dockerfile"
FRONTEND_DOCKERFILE="$ROOT_DIR/frontend/Dockerfile"
DOCKERIGNORE_FILE="$ROOT_DIR/.dockerignore"

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

assert_contains() {
  local needle="$1" file="$2"
  grep -Fq -- "$needle" "$file" || fail "expected '$needle' in $file"
}

require_python39() {
  python3 - <<'PY'
import sys

if sys.version_info < (3, 9):
    raise SystemExit("python3.9+ is required by docker-image-slimming.test.sh")
PY
}

assert_exact_line() {
  local needle="$1" file="$2"
  grep -Fxq -- "$needle" "$file" || fail "expected exact line '$needle' in $file"
}

run_backend_runtime_checks() {
  require_python39
  python3 - "$BACKEND_DOCKERFILE" <<'PY'
import pathlib
import sys

path = pathlib.Path(sys.argv[1])
text = path.read_text()
stages: dict[str, list[str]] = {}
current = None

for line in text.splitlines():
    if line.startswith("FROM "):
        current = line
        stages[current] = []
    if current is not None:
        stages[current].append(line)

prod_stage = "\n".join(stages.get("FROM base AS prod-deps", []))
run_stage = "\n".join(stages.get("FROM node:24-alpine AS run", []))

if not prod_stage:
    raise SystemExit("missing 'FROM base AS prod-deps' stage")
if "RUN bun install --frozen-lockfile --production" not in prod_stage:
    raise SystemExit("prod-deps stage should install production-only dependencies with Bun")
if not run_stage:
    raise SystemExit("missing backend runtime stage")
if "COPY --from=prod-deps /app/backend/node_modules ./node_modules" not in run_stage:
    raise SystemExit("backend runtime stage should copy node_modules from prod-deps")
if "COPY --from=deps /app/backend/node_modules ./node_modules" in run_stage:
    raise SystemExit("backend runtime stage should not copy dev dependencies from deps")
if "COPY backend/src/lib/storage/migrations/ ./dist/backend/src/lib/storage/migrations/" not in run_stage:
    raise SystemExit("backend runtime stage must keep storage migrations assets")
if "COPY knowledge_base/ ../knowledge_base/" not in run_stage:
    raise SystemExit("backend runtime stage must keep knowledge_base assets")
if "COPY scenarios/ ../scenarios/" not in run_stage:
    raise SystemExit("backend runtime stage must keep scenarios assets")
PY
}

run_frontend_runtime_checks() {
  assert_contains 'COPY --from=build --chown=1001:1001 /app/frontend/.next/standalone ./' "$FRONTEND_DOCKERFILE"
  assert_contains 'COPY --from=build --chown=1001:1001 /app/frontend/.next/static ./.next/static' "$FRONTEND_DOCKERFILE"
  assert_contains 'CMD ["node", "server.js"]' "$FRONTEND_DOCKERFILE"
}

run_dockerignore_checks() {
  assert_exact_line 'docs' "$DOCKERIGNORE_FILE"
  assert_exact_line 'scripts' "$DOCKERIGNORE_FILE"
}

main() {
  run_backend_runtime_checks
  run_frontend_runtime_checks
  run_dockerignore_checks
  echo "docker image slimming tests passed."
}

main "$@"
