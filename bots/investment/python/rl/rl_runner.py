#!/usr/bin/env python3
"""Phase 7 RL inference runner shadow scaffold.

The FastAPI inference server described in the 12-week plan is intentionally not
started in this phase. The test path returns the inference contract and a
deterministic action sample.
"""

from __future__ import annotations

import argparse
import importlib.util
import json
from datetime import datetime, timezone

from luna_trading_env import FEATURE_NAMES, fixture_sample


OPTIONAL_DEPS = {
    "fastapi": "fastapi",
    "uvicorn": "uvicorn",
    "stable_baselines3": "stable_baselines3",
    "torch": "torch",
}


def dependency_status():
    loaded = {name: importlib.util.find_spec(module) is not None for name, module in OPTIONAL_DEPS.items()}
    missing = [name for name, ok in loaded.items() if not ok]
    return {"loaded": loaded, "missing": missing}


def deterministic_shadow_action(features):
    score = (
        (features.get("momentum20", 0.5) - 0.5) * 0.35
        + (features.get("factorComposite", 0.5) - 0.5) * 0.3
        + (features.get("entryConfidence", 0.5) - 0.5) * 0.2
        - features.get("volatility20", 0.0) * 0.2
        - features.get("drawdown20", 0.0) * 0.25
    )
    action = max(-1.0, min(1.0, score * 3.0))
    if action >= 0.1:
        action_type = "buy"
    elif action <= -0.1:
        action_type = "sell"
    else:
        action_type = "hold"
    return {
        "action": round(action, 6),
        "action_type": action_type,
        "confidence": round(min(1.0, 0.25 + abs(action) * 0.65), 4),
    }


def run_test():
    deps = dependency_status()
    sample = fixture_sample()
    inference = deterministic_shadow_action(sample["features"])
    return {
        "ok": True,
        "status": "ready" if not deps["missing"] else "missing_optional_deps",
        "optional_dependencies": deps,
        "service_started": False,
        "model_loaded": False,
        "shadow_only": True,
        "contract": {
            "endpoint": "POST /infer",
            "feature_names": FEATURE_NAMES,
            "output": ["action", "action_type", "confidence", "shadow_only"],
            "latency_target_ms": 50,
        },
        "sample": {
            **inference,
            "shadow_only": True,
            "model_status": "deterministic_shadow_proxy",
        },
        "generated_at": datetime.now(timezone.utc).isoformat(),
    }


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--test", action="store_true")
    parser.add_argument("--json", action="store_true")
    args = parser.parse_args()
    if not args.test:
        raise SystemExit("Phase 7 runner is shadow-only. Use --test --json.")
    result = run_test()
    if args.json:
        print(json.dumps(result, ensure_ascii=False, indent=2))
    else:
        print(result)


if __name__ == "__main__":
    main()
