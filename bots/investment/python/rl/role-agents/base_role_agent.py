#!/usr/bin/env python3
"""Deterministic shadow-only role agents for Luna RL coordination."""

from __future__ import annotations

import argparse
import json
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from luna_trading_env import FEATURE_NAMES, fixture_sample


ROLE_POLICIES = {
    "analyst": {"bias": "signal_quality", "buy_threshold": 0.18, "sell_threshold": -0.18},
    "data_scientist": {"bias": "feature_consistency", "buy_threshold": 0.12, "sell_threshold": -0.12},
    "strategy": {"bias": "strategy_fit", "buy_threshold": 0.16, "sell_threshold": -0.16},
    "trader": {"bias": "execution_timing", "buy_threshold": 0.2, "sell_threshold": -0.2},
    "risk": {"bias": "drawdown_control", "buy_threshold": 0.28, "sell_threshold": -0.08},
}


def normalize_features(raw: Dict[str, Any]) -> Dict[str, float]:
    features = raw.get("features", raw)
    return {name: float(features.get(name, 0.0) or 0.0) for name in FEATURE_NAMES}


def score_for_role(role: str, features: Dict[str, float]) -> float:
    momentum = (features["momentum5"] + features["momentum20"]) / 2.0
    confidence = (features["entryConfidence"] + features["regimeConfidence"]) / 2.0
    risk_drag = features["volatility20"] * 0.35 + features["drawdown20"] * 0.45
    factor_boost = features["factorComposite"] * 0.25 + features["statArbConfidence"] * 0.1

    if role == "analyst":
        return momentum + confidence * 0.4 - risk_drag
    if role == "data_scientist":
        return factor_boost + confidence * 0.25 - features["volatility20"] * 0.2
    if role == "strategy":
        return momentum * 0.6 + factor_boost - risk_drag * 0.5
    if role == "trader":
        return momentum * 0.8 + features["entryConfidence"] * 0.25 - risk_drag * 0.7
    if role == "risk":
        return confidence * 0.2 - risk_drag - max(0.0, -features["unrealizedPnlPct"]) * 0.5
    return 0.0


def decision(role: str, features: Dict[str, float]) -> Dict[str, Any]:
    policy = ROLE_POLICIES[role]
    score = score_for_role(role, features)
    if score >= policy["buy_threshold"]:
        action = "buy"
    elif score <= policy["sell_threshold"]:
        action = "sell"
    else:
        action = "hold"
    confidence = max(0.05, min(0.95, abs(score) + 0.35))
    return {
        "ok": True,
        "role": role,
        "action": action,
        "score": round(score, 6),
        "confidence": round(confidence, 3),
        "policy_bias": policy["bias"],
        "feature_names": FEATURE_NAMES,
        "shadow_only": True,
        "live_trade": False,
        "generated_at": datetime.now(timezone.utc).isoformat(),
    }


def main(role: str) -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--json", action="store_true")
    parser.add_argument("--test", action="store_true")
    parser.add_argument("--features-json", default="")
    args = parser.parse_args()

    if args.features_json:
        raw = json.loads(args.features_json)
    else:
        raw = fixture_sample()
    payload = decision(role, normalize_features(raw))
    if args.json:
        print(json.dumps(payload, ensure_ascii=False, indent=2))
    else:
        print(f"[luna-role-agent] role={role} action={payload['action']} confidence={payload['confidence']}")


__all__ = ["main", "decision", "normalize_features"]
