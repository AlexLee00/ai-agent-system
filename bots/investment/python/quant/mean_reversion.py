#!/usr/bin/env python3
"""Dependency-tolerant Luna Phase 6 mean reversion scaffold."""

from __future__ import annotations

import argparse
import json
import math
from datetime import datetime, timezone


OPTIONAL_PACKAGES = {
    "arch": "arch",
    "statsmodels": "statsmodels",
    "numpy": "numpy",
    "pandas": "pandas",
}


def load_optional_deps() -> dict:
    loaded = {}
    missing = []
    for module_name, package_name in OPTIONAL_PACKAGES.items():
        try:
            __import__(module_name)
            loaded[package_name] = True
        except Exception:
            loaded[package_name] = False
            missing.append(package_name)
    return {"loaded": loaded, "missing": missing}


def mean(values: list[float]) -> float:
    return sum(values) / len(values) if values else 0.0


def stdev(values: list[float]) -> float:
    if len(values) < 2:
        return 0.0
    avg = mean(values)
    return math.sqrt(sum((item - avg) ** 2 for item in values) / (len(values) - 1))


def rsi(values: list[float], period: int = 14) -> float | None:
    if len(values) < period + 1:
        return None
    tail = values[-(period + 1):]
    gains = 0.0
    losses = 0.0
    for index in range(1, len(tail)):
        delta = tail[index] - tail[index - 1]
        if delta >= 0:
            gains += delta
        else:
            losses += abs(delta)
    avg_gain = gains / period
    avg_loss = losses / period
    if avg_loss == 0:
        return 100.0
    rs = avg_gain / avg_loss
    return 100.0 - (100.0 / (1.0 + rs))


def deterministic_mean_reversion_fixture() -> dict:
    closes = [100, 101, 102, 101, 100, 99, 98, 99, 100, 101, 102, 103, 104, 103, 102, 101, 100, 98, 96, 94]
    avg = mean(closes[-20:])
    sigma = stdev(closes[-20:])
    z_score = (closes[-1] - avg) / sigma if sigma > 0 else 0.0
    rsi_value = rsi(closes)
    return {
        "strategy_type": "mean_reversion",
        "symbols": ["BTC/USDT"],
        "exchange": "binance",
        "market": "crypto",
        "mean_reversion_metrics": {
            "samples": len(closes),
            "sma20": round(avg, 6),
            "stdev20": round(sigma, 6),
            "rsi14": round(rsi_value, 4) if rsi_value is not None else None,
        },
        "signal": "buy_reversion_watch" if z_score <= -2 and (rsi_value or 100) <= 35 else "mean_reversion_watch",
        "z_score": round(z_score, 4),
        "shadow_only": True,
    }


def run_test(json_mode: bool = False) -> int:
    deps = load_optional_deps()
    result = {
        "ok": True,
        "status": "mean_reversion_test_ready" if not deps["missing"] else "missing_optional_deps",
        "optional_dependencies": deps,
        "sample": deterministic_mean_reversion_fixture(),
        "service_started": False,
        "generated_at": datetime.now(timezone.utc).isoformat(),
    }
    if json_mode:
        print(json.dumps(result, ensure_ascii=False, indent=2))
    else:
        print(f"{result['status']} z_score={result['sample']['z_score']}")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description="Luna mean reversion shadow CLI")
    parser.add_argument("--test", action="store_true", help="run dependency-tolerant contract smoke")
    parser.add_argument("--json", action="store_true", help="print JSON output")
    args = parser.parse_args()

    if args.test:
        return run_test(args.json)

    result = {
        "ok": True,
        "status": "mean_reversion_cli_scaffold",
        "message": "Use --test for the Phase 6 smoke contract. Long-running service mode is intentionally disabled.",
        "service_started": False,
    }
    print(json.dumps(result, ensure_ascii=False, indent=2) if args.json else result["status"])
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
