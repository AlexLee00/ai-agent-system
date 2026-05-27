#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
RL_DIR="$ROOT_DIR/python/rl"
PYTHON_BIN="${LUNA_PYTHON_BIN:-python3}"
JSON=false
INSTALL=false

for arg in "$@"; do
  case "$arg" in
    --json) JSON=true ;;
    --install) INSTALL=true ;;
  esac
done

if "$INSTALL"; then
  "$PYTHON_BIN" -m pip install -r "$RL_DIR/requirements.txt"
fi

"$PYTHON_BIN" - "$JSON" "$INSTALL" <<'PY'
from __future__ import annotations

import importlib.util
import json
import platform
import sys
from datetime import datetime, timezone

json_mode = sys.argv[1].lower() == "true"
install_requested = sys.argv[2].lower() == "true"

required_deps = {
    "stable_baselines3": "stable_baselines3",
    "gymnasium": "gymnasium",
    "torch": "torch",
    "numpy": "numpy",
    "pandas": "pandas",
}
optional_deps = {
    "finrl": "finrl",
}

required_loaded = {name: importlib.util.find_spec(module) is not None for name, module in required_deps.items()}
optional_loaded = {name: importlib.util.find_spec(module) is not None for name, module in optional_deps.items()}
missing = [name for name, ok in required_loaded.items() if not ok]
missing_optional = [name for name, ok in optional_loaded.items() if not ok]
payload = {
    "ok": True,
    "ready": not missing,
    "ppo_ready": not missing,
    "shadow_only": True,
    "install_requested": install_requested,
    "python": sys.executable,
    "python_version": platform.python_version(),
    "loaded": {**required_loaded, **optional_loaded},
    "missing": missing,
    "missing_optional": missing_optional,
    "generated_at": datetime.now(timezone.utc).isoformat(),
    "note": "FinRL is optional; Stable-Baselines3/Gymnasium/Torch/Numpy/Pandas are required for PPO training.",
}

if json_mode:
    print(json.dumps(payload, ensure_ascii=False, indent=2))
else:
    status = "ready" if payload["ready"] else f"missing={','.join(missing)}"
    print(f"[luna-rl-deps] {status} python={payload['python']}")
PY
