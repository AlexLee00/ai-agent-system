#!/usr/bin/env python3
"""Dependency-tolerant Luna Phase 6 pairs trading scaffold."""

from __future__ import annotations

import argparse
import json
import math
from datetime import datetime, timezone


OPTIONAL_PACKAGES = {
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


def deterministic_pairs_fixture() -> dict:
    btc = [100, 102, 101, 104, 106, 107, 109, 112, 111, 115]
    eth = [50, 51, 50.5, 52, 53, 53.5, 54, 55.5, 55, 56]
    spread = [math.log(a) - 1.12 * math.log(b) for a, b in zip(btc, eth)]
    sigma = stdev(spread)
    z_score = (spread[-1] - mean(spread)) / sigma if sigma > 0 else 0.0
    return {
        "strategy_type": "pairs_trading",
        "symbols": ["BTC/USDT", "ETH/USDT"],
        "exchange": "binance",
        "market": "crypto",
        "pair_metrics": {
            "samples": len(spread),
            "hedge_ratio": 1.12,
            "spread_std": round(sigma, 6),
        },
        "signal": "pair_watch" if abs(z_score) >= 1.25 else "neutral",
        "z_score": round(z_score, 4),
        "shadow_only": True,
    }


def run_test(json_mode: bool = False) -> int:
    deps = load_optional_deps()
    result = {
        "ok": True,
        "status": "pairs_trader_test_ready" if not deps["missing"] else "missing_optional_deps",
        "optional_dependencies": deps,
        "sample": deterministic_pairs_fixture(),
        "service_started": False,
        "generated_at": datetime.now(timezone.utc).isoformat(),
    }
    if json_mode:
        print(json.dumps(result, ensure_ascii=False, indent=2))
    else:
        print(f"{result['status']} z_score={result['sample']['z_score']}")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description="Luna pairs trading shadow CLI")
    parser.add_argument("--test", action="store_true", help="run dependency-tolerant contract smoke")
    parser.add_argument("--json", action="store_true", help="print JSON output")
    args = parser.parse_args()

    if args.test:
        return run_test(args.json)

    result = {
        "ok": True,
        "status": "pairs_trader_cli_scaffold",
        "message": "Use --test for the Phase 6 smoke contract. Long-running service mode is intentionally disabled.",
        "service_started": False,
    }
    print(json.dumps(result, ensure_ascii=False, indent=2) if args.json else result["status"])
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
