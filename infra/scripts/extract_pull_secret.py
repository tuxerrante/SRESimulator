#!/usr/bin/env python3
import json
import os
import pathlib
import sys


def parse_pull_secret(raw_value: str):
    candidates = [raw_value]
    if len(raw_value) >= 2 and raw_value[0] == raw_value[-1] and raw_value[0] in ("'", '"'):
        candidates.append(raw_value[1:-1])

    for candidate in candidates:
        try:
            parsed = json.loads(candidate)
            if isinstance(parsed, str):
                parsed = json.loads(parsed)
            if isinstance(parsed, dict):
                return parsed
        except json.JSONDecodeError:
            continue
    return None


def main() -> int:
    src = os.path.expanduser(os.environ.get("ARO_RP_ENV_FILE", ""))
    dst = os.path.expanduser(os.environ.get("PULL_SECRET_PATH", ""))

    if not src:
        print("ARO_RP_ENV_FILE is required")
        return 1
    if not dst:
        print("PULL_SECRET_PATH is required")
        return 1
    if not os.path.exists(src):
        print(f"Source file not found: {src}")
        return 1

    raw_value = None
    for line in pathlib.Path(src).read_text(encoding="utf-8").splitlines():
        stripped = line.strip()
        if not stripped or stripped.startswith("#"):
            continue
        if stripped.startswith("export "):
            stripped = stripped[len("export ") :]
        if stripped.startswith("PULL_SECRET="):
            raw_value = stripped.split("=", 1)[1].strip()
            break

    if raw_value is None:
        print(f"PULL_SECRET not found in {src}")
        return 1

    pull_secret_obj = parse_pull_secret(raw_value)
    if pull_secret_obj is None:
        print("Unable to parse PULL_SECRET as JSON object.")
        print("Ensure PULL_SECRET in env file is valid JSON (possibly quoted).")
        return 1

    dst_path = pathlib.Path(dst)
    dst_path.parent.mkdir(parents=True, exist_ok=True)
    dst_path.write_text(json.dumps(pull_secret_obj, separators=(",", ":")), encoding="utf-8")

    print(f"Wrote pull secret JSON to: {dst_path}")
    print(f'Set in terraform.tfvars: pull_secret_path = "{dst_path}"')
    return 0


if __name__ == "__main__":
    sys.exit(main())
