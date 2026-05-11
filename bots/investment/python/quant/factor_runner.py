#!/usr/bin/env python3
"""
Luna Phase 5 factor model CLI scaffold.

The script is intentionally non-service and dependency-tolerant. If optional
quant packages are missing, it returns a JSON contract instead of failing.
"""

from __future__ import annotations

import argparse
import json
import math
from datetime import datetime, timezone


OPTIONAL_PACKAGES = {
    "pypfopt": "PyPortfolioOpt",
    "statsmodels": "statsmodels",
    "alphalens": "alphalens",
    "empyrical": "empyrical",
    "pyfolio": "pyfolio",
    "pandas": "pandas",
    "numpy": "numpy",
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


def clamp(value: float, lo: float = 0.0, hi: float = 1.0) -> float:
    if not math.isfinite(value):
        return 0.5
    return max(lo, min(hi, value))


def deterministic_factor_fixture() -> dict:
    returns = [0.012, 0.018, -0.006, 0.021, 0.014]
    mean_return = sum(returns) / len(returns)
    volatility = math.sqrt(sum((item - mean_return) ** 2 for item in returns) / (len(returns) - 1))
    momentum = clamp(0.5 + mean_return * 10)
    volatility_score = clamp(1 - volatility / 0.08)
    liquidity_score = 0.72
    composite = round(momentum * 0.35 + volatility_score * 0.3 + liquidity_score * 0.35, 4)
    return {
        "symbol": "BTC/USDT",
        "exchange": "binance",
        "market": "crypto",
        "factor_scores": {
            "momentum": {"score": round(momentum, 4), "source": "fixture_returns"},
            "volatility": {"score": round(volatility_score, 4), "source": "fixture_returns"},
            "liquidity": {"score": liquidity_score, "source": "fixture_liquidity"},
        },
        "composite_score": composite,
        "shadow_only": True,
    }


def run_test(json_mode: bool = False) -> int:
    deps = load_optional_deps()
    result = {
        "ok": True,
        "status": "factor_runner_test_ready" if not deps["missing"] else "missing_optional_deps",
        "optional_dependencies": deps,
        "sample": deterministic_factor_fixture(),
        "service_started": False,
        "generated_at": datetime.now(timezone.utc).isoformat(),
    }
    if json_mode:
        print(json.dumps(result, ensure_ascii=False, indent=2))
    else:
        print(f"{result['status']} composite={result['sample']['composite_score']}")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description="Luna factor model shadow CLI")
    parser.add_argument("--test", action="store_true", help="run dependency-tolerant contract smoke")
    parser.add_argument("--json", action="store_true", help="print JSON output")
    args = parser.parse_args()

    if args.test:
        return run_test(args.json)

    result = {
        "ok": True,
        "status": "factor_runner_cli_scaffold",
        "message": "Use --test for the Phase 5 smoke contract. Long-running service mode is intentionally disabled.",
        "service_started": False,
    }
    print(json.dumps(result, ensure_ascii=False, indent=2) if args.json else result["status"])
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
