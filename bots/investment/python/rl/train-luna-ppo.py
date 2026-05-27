#!/usr/bin/env python3
"""Safe Luna PPO training entrypoint.

The default path is a dependency/contract check. Shadow training requires an
explicit confirmation token and still writes only a manifest unless the full
optional PPO stack is installed.
"""

from __future__ import annotations

import argparse
import importlib.util
import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Tuple

from luna_trading_env import LunaTradingEnv, contract_summary, fixture_sample

CONFIRM_TOKEN = "luna-ppo-shadow-train"
OPTIONAL_DEPS = {
    "stable_baselines3": "stable_baselines3",
    "gymnasium": "gymnasium",
    "torch": "torch",
    "numpy": "numpy",
    "pandas": "pandas",
}


def dependency_status():
    loaded = {}
    versions = {}
    for name, module in OPTIONAL_DEPS.items():
        found = importlib.util.find_spec(module) is not None
        loaded[name] = found
        if found:
            try:
                imported = __import__(module)
                versions[name] = getattr(imported, "__version__", None)
            except Exception as exc:
                loaded[name] = False
                versions[name] = f"import_error:{exc}"
    missing = [name for name, ok in loaded.items() if not ok]
    return {"loaded": loaded, "versions": versions, "missing": missing, "ready": not missing}


def load_samples(dataset_path: str = "") -> Tuple[List[Dict[str, Any]], List[Dict[str, Any]], str]:
    if dataset_path:
        target = Path(dataset_path).expanduser().resolve()
        if target.exists():
            payload = json.loads(target.read_text(encoding="utf-8"))
            train = payload.get("train") or payload.get("samples") or []
            validation = payload.get("validation") or []
            if isinstance(train, list) and train:
                return train, validation if isinstance(validation, list) else [], str(target)
    sample = fixture_sample()
    return [sample, sample, sample, sample], [sample], "fixture"


def evaluate_model(model: Any, samples: List[Dict[str, Any]]) -> Dict[str, Any]:
    import numpy as np

    env = LunaTradingEnv(samples or [fixture_sample()])
    obs, _info = env.reset()
    total_reward = 0.0
    actions = []
    rewards = []
    steps = 0
    terminated = False
    truncated = False
    max_steps = max(1, len(env.samples))
    while not (terminated or truncated) and steps < max_steps:
        action, _state = model.predict(obs, deterministic=True)
        action_value = float(np.asarray(action).reshape(-1)[0])
        obs, reward, terminated, truncated, _step_info = env.step(action)
        total_reward += float(reward)
        rewards.append(float(reward))
        actions.append(action_value)
        steps += 1
    positive_steps = sum(1 for reward in rewards if reward > 0)
    return {
        "steps": steps,
        "total_reward": round(total_reward, 8),
        "avg_reward": round(total_reward / max(1, steps), 8),
        "positive_reward_steps": positive_steps,
        "positive_reward_rate": round(positive_steps / max(1, steps), 4),
        "mean_action": round(float(np.mean(actions)) if actions else 0.0, 6),
        "min_action": round(float(np.min(actions)) if actions else 0.0, 6),
        "max_action": round(float(np.max(actions)) if actions else 0.0, 6),
    }


def train_ppo(args: argparse.Namespace) -> Dict[str, Any]:
    from stable_baselines3 import PPO

    train_samples, validation_samples, dataset_source = load_samples(args.dataset)
    n_steps = max(8, min(int(args.n_steps), max(8, len(train_samples))))
    batch_size = max(2, min(int(args.batch_size), n_steps))
    if n_steps % batch_size != 0:
        batch_size = max(2, min(batch_size, n_steps))

    env = LunaTradingEnv(train_samples)
    model = PPO(
        "MlpPolicy",
        env,
        verbose=0,
        seed=int(args.seed),
        n_steps=n_steps,
        batch_size=batch_size,
        learning_rate=float(args.learning_rate),
        gamma=float(args.gamma),
        device=args.device,
    )
    model.learn(total_timesteps=int(args.timesteps), progress_bar=False)

    out_dir = Path(args.output_dir).expanduser().resolve()
    out_dir.mkdir(parents=True, exist_ok=True)
    model_path = out_dir / args.model_name
    model.save(str(model_path))
    saved_path = str(model_path if str(model_path).endswith(".zip") else Path(f"{model_path}.zip"))
    eval_samples = validation_samples or train_samples
    metrics = evaluate_model(model, eval_samples)
    return {
        "dataset_source": dataset_source,
        "train_samples": len(train_samples),
        "validation_samples": len(validation_samples),
        "timesteps": int(args.timesteps),
        "n_steps": n_steps,
        "batch_size": batch_size,
        "learning_rate": float(args.learning_rate),
        "gamma": float(args.gamma),
        "model_path": saved_path,
        "evaluation": metrics,
    }


def build_manifest(args, deps, training_started=False, model_written=False, training=None):
    dataset_path = str(Path(args.dataset).expanduser().resolve()) if args.dataset else None
    return {
        "ok": True,
        "shadow_only": True,
        "algorithm": "PPO",
        "market": args.market,
        "episodes": args.episodes,
        "dataset_path": dataset_path,
        "dataset_available": Path(dataset_path).exists() if dataset_path else False,
        "training_started": training_started,
        "model_written": model_written,
        "training": training or {},
        "optional_dependencies": deps,
        "environment_contract": contract_summary(),
        "hard_limits_preserved": {
            "live_trade": False,
            "secret_change": False,
            "cutover": False,
        },
        "generated_at": datetime.now(timezone.utc).isoformat(),
    }


def write_manifest(payload, output_dir):
    out_dir = Path(output_dir).expanduser().resolve()
    out_dir.mkdir(parents=True, exist_ok=True)
    target = out_dir / "luna_ppo_shadow_manifest.json"
    target.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    return str(target)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--check", action="store_true")
    parser.add_argument("--train", action="store_true")
    parser.add_argument("--json", action="store_true")
    parser.add_argument("--market", default="crypto")
    parser.add_argument("--episodes", type=int, default=100)
    parser.add_argument("--timesteps", type=int, default=2000)
    parser.add_argument("--n-steps", type=int, default=64)
    parser.add_argument("--batch-size", type=int, default=32)
    parser.add_argument("--learning-rate", type=float, default=0.0003)
    parser.add_argument("--gamma", type=float, default=0.99)
    parser.add_argument("--seed", type=int, default=42)
    parser.add_argument("--device", default="auto")
    parser.add_argument("--confirm", default="")
    parser.add_argument("--dataset", default="")
    parser.add_argument("--output-dir", default=str(Path(__file__).resolve().parent / "models"))
    parser.add_argument("--model-name", default="luna_ppo_v1.zip")
    args = parser.parse_args()

    deps = dependency_status()
    if not args.train:
        result = build_manifest(args, deps, training_started=False, model_written=False)
    elif args.confirm != CONFIRM_TOKEN:
        result = build_manifest(args, deps, training_started=False, model_written=False)
        result["ok"] = False
        result["status"] = "confirm_required"
    elif not deps["ready"]:
        result = build_manifest(args, deps, training_started=False, model_written=False)
        result["status"] = "missing_optional_deps"
    else:
        training = train_ppo(args)
        result = build_manifest(args, deps, training_started=True, model_written=True, training=training)
        result["status"] = "ppo_model_trained"
        result["model_path"] = training["model_path"]
        result["manifest_path"] = write_manifest(result, args.output_dir)

    if args.json:
      print(json.dumps(result, ensure_ascii=False, indent=2))
    else:
      print(result)

    if not result.get("ok", False):
      raise SystemExit(1)


if __name__ == "__main__":
    main()
