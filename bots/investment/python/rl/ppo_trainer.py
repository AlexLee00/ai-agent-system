#!/usr/bin/env python3
"""Phase 7 PPO trainer shadow scaffold.

No training is started unless a future promotion path adds an explicit command.
The current --test path reports optional dependency readiness and a deterministic
contract sample.
"""

from __future__ import annotations

import argparse
import importlib.util
import json
from datetime import datetime, timezone

from luna_trading_env import contract_summary


OPTIONAL_DEPS = {
    "finrl": "finrl",
    "stable_baselines3": "stable_baselines3",
    "gymnasium": "gymnasium",
    "torch": "torch",
    "numpy": "numpy",
    "pandas": "pandas",
}


def dependency_status():
    loaded = {name: importlib.util.find_spec(module) is not None for name, module in OPTIONAL_DEPS.items()}
    missing = [name for name, ok in loaded.items() if not ok]
    return {"loaded": loaded, "missing": missing}


def run_test():
    deps = dependency_status()
    return {
        "ok": True,
        "status": "ready" if not deps["missing"] else "missing_optional_deps",
        "optional_dependencies": deps,
        "training_started": False,
        "model_written": False,
        "shadow_only": True,
        "environment_contract": contract_summary(),
        "sample_plan": {
            "algorithm": "PPO",
            "episodes": 100,
            "walk_forward": True,
            "promotion_required": True,
        },
        "generated_at": datetime.now(timezone.utc).isoformat(),
    }


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--test", action="store_true")
    parser.add_argument("--json", action="store_true")
    args = parser.parse_args()
    if not args.test:
        raise SystemExit("Phase 7 trainer is shadow-only. Use --test --json.")
    result = run_test()
    if args.json:
        print(json.dumps(result, ensure_ascii=False, indent=2))
    else:
        print(result)


if __name__ == "__main__":
    main()
