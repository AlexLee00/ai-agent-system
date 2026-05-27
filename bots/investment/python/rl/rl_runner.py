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
from pathlib import Path

from luna_trading_env import FEATURE_NAMES, LunaTradingEnv, fixture_sample


MODEL_DEPS = {
    "stable_baselines3": "stable_baselines3",
    "gymnasium": "gymnasium",
    "torch": "torch",
    "numpy": "numpy",
}
SERVICE_DEPS = {
    "fastapi": "fastapi",
    "uvicorn": "uvicorn",
}


def dependency_status():
    model_loaded = {name: importlib.util.find_spec(module) is not None for name, module in MODEL_DEPS.items()}
    service_loaded = {name: importlib.util.find_spec(module) is not None for name, module in SERVICE_DEPS.items()}
    missing_model = [name for name, ok in model_loaded.items() if not ok]
    missing_service = [name for name, ok in service_loaded.items() if not ok]
    return {
        "loaded": {**model_loaded, **service_loaded},
        "missing": missing_model,
        "missing_service_optional": missing_service,
        "model_ready": not missing_model,
    }


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


def load_features(raw_json: str = ""):
    if raw_json:
        payload = json.loads(raw_json)
        return payload.get("features", payload)
    return fixture_sample()["features"]


def model_action(features, model_path: str):
    import numpy as np
    from stable_baselines3 import PPO

    target = Path(model_path).expanduser().resolve()
    if not target.exists():
        return None
    sample = {"features": {name: float(features.get(name, 0.0)) for name in FEATURE_NAMES}, "next_return": 0.0}
    env = LunaTradingEnv([sample])
    obs, _info = env.reset()
    model = PPO.load(str(target), env=env, device="auto")
    action, _state = model.predict(obs, deterministic=True)
    action_value = float(np.asarray(action).reshape(-1)[0])
    if action_value >= 0.1:
        action_type = "buy"
    elif action_value <= -0.1:
        action_type = "sell"
    else:
        action_type = "hold"
    return {
        "action": round(action_value, 6),
        "action_type": action_type,
        "confidence": round(min(1.0, 0.3 + abs(action_value) * 0.6), 4),
        "model_status": "ppo_model_loaded",
        "model_path": str(target),
    }


def run_test(model_path: str = "", features_json: str = ""):
    deps = dependency_status()
    features = load_features(features_json)
    default_model = Path(__file__).resolve().parent / "models" / "luna_ppo_v1.zip"
    model_target = model_path or str(default_model)
    inference = None
    if deps["model_ready"]:
        try:
            inference = model_action(features, model_target)
        except Exception as exc:
            inference = {"model_status": f"ppo_model_load_failed:{type(exc).__name__}", "model_error": str(exc)}
    if not inference or "action" not in inference:
        inference = {
            **deterministic_shadow_action(features),
            "model_status": inference.get("model_status") if isinstance(inference, dict) else "deterministic_shadow_proxy",
            "model_error": inference.get("model_error") if isinstance(inference, dict) else None,
        }
    return {
        "ok": True,
        "status": "ready" if deps["model_ready"] else "missing_model_deps",
        "optional_dependencies": deps,
        "service_started": False,
        "model_loaded": inference.get("model_status") == "ppo_model_loaded",
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
        },
        "generated_at": datetime.now(timezone.utc).isoformat(),
    }


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--test", action="store_true")
    parser.add_argument("--json", action="store_true")
    parser.add_argument("--model-path", default="")
    parser.add_argument("--features-json", default="")
    args = parser.parse_args()
    if not args.test:
        raise SystemExit("Phase 7 runner is shadow-only. Use --test --json.")
    result = run_test(model_path=args.model_path, features_json=args.features_json)
    if args.json:
        print(json.dumps(result, ensure_ascii=False, indent=2))
    else:
        print(result)


if __name__ == "__main__":
    main()
