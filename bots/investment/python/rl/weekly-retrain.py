#!/usr/bin/env python3
"""Weekly Luna PPO shadow retrain orchestrator.

This wrapper coordinates dependency checks, data preparation, and the safe PPO
entrypoint. It never promotes or live-trades; promotion output is advisory only.
"""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List

CONFIRM_TOKEN = "luna-ppo-shadow-train"


def run_json(cmd: List[str], cwd: Path) -> Dict[str, Any]:
    completed = subprocess.run(cmd, cwd=str(cwd), text=True, capture_output=True, timeout=30 * 60, check=False)
    if completed.returncode != 0:
        return {
            "ok": False,
            "command": cmd,
            "returncode": completed.returncode,
            "stdout": completed.stdout[-2000:],
            "stderr": completed.stderr[-2000:],
        }
    try:
        return json.loads(completed.stdout or "{}")
    except json.JSONDecodeError as exc:
        return {"ok": False, "command": cmd, "error": f"invalid_json:{exc}", "stdout": completed.stdout[-2000:]}


def promotion_gate(data: Dict[str, Any], deps: Dict[str, Any], train: Dict[str, Any], min_samples: int) -> Dict[str, Any]:
    validation = data.get("validation") or []
    rewards = [float(sample.get("reward") or 0.0) for sample in validation]
    avg_validation_reward = sum(rewards) / max(1, len(rewards))
    checks = {
        "dependencies_ready": bool(deps.get("ready")),
        "enough_samples": int(data.get("samples") or 0) >= min_samples,
        "validation_positive": avg_validation_reward > 0,
        "training_started": bool(train.get("training_started")),
        "model_written": bool(train.get("model_written")),
    }
    return {
        "ready_for_promotion": all(checks.values()),
        "checks": checks,
        "avg_validation_reward": round(avg_validation_reward, 6),
        "min_samples": min_samples,
        "advisory_only": True,
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--json", action="store_true")
    parser.add_argument("--train", action="store_true")
    parser.add_argument("--fixture", action="store_true")
    parser.add_argument("--confirm", default="")
    parser.add_argument("--timesteps", type=int, default=2000)
    parser.add_argument("--episodes", type=int, default=100)
    parser.add_argument("--min-samples", type=int, default=50)
    args = parser.parse_args()

    rl_dir = Path(__file__).resolve().parent
    project_root = rl_dir.parents[3]
    py = sys.executable

    deps = run_json(["bash", str(rl_dir / "check-deps.sh"), "--json"], project_root)
    data_cmd = [py, str(rl_dir / "prepare-training-data.py"), "--json", "--write", "--output-dir", str(rl_dir / "data")]
    if args.fixture:
        data_cmd.append("--fixture")
    data = run_json(data_cmd, project_root)

    train_cmd = [
        py,
        str(rl_dir / "train-luna-ppo.py"),
        "--json",
        "--market",
        "crypto",
        "--episodes",
        str(max(1, args.episodes)),
        "--timesteps",
        str(max(1, args.timesteps)),
    ]
    if data.get("output_path"):
        train_cmd.extend(["--dataset", str(data["output_path"])])
    if args.train:
        train_cmd.append("--train")
        if args.confirm:
            train_cmd.extend(["--confirm", args.confirm])
    else:
        train_cmd.append("--check")
    train = run_json(train_cmd, project_root)

    payload = {
        "ok": bool(deps.get("ok")) and bool(data.get("ok")) and bool(train.get("ok")),
        "shadow_only": True,
        "deps": deps,
        "data": {
            "source": data.get("source"),
            "samples": data.get("samples"),
            "train_samples": data.get("train_samples"),
            "validation_samples": data.get("validation_samples"),
            "avg_reward": data.get("avg_reward"),
        },
        "train": train,
        "promotion_gate": promotion_gate(data, deps, train, args.min_samples),
        "hard_limits_preserved": {
            "live_trade": False,
            "secret_change": False,
            "cutover": False,
            "auto_promotion": False,
        },
        "generated_at": datetime.now(timezone.utc).isoformat(),
    }

    if args.json:
        print(json.dumps(payload, ensure_ascii=False, indent=2))
    else:
        gate = payload["promotion_gate"]
        print(f"[luna-ppo-weekly] ok={payload['ok']} promotion={gate['ready_for_promotion']} samples={payload['data']['samples']}")
    if not payload["ok"]:
        raise SystemExit(1)


if __name__ == "__main__":
    main()
