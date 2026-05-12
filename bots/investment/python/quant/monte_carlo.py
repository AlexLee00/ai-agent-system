#!/usr/bin/env python3
"""Luna Phase 8 Monte Carlo scaffold.

This CLI is intentionally test-only. It does not start a service, mutate live
configuration, place orders, or write model artifacts.
"""

from __future__ import annotations

import argparse
import importlib.util
import json
import math
import random
from typing import Iterable


OPTIONAL_DEPS = ["numpy", "scipy", "arch", "empyrical"]


def dependency_status() -> dict:
    present = {name: importlib.util.find_spec(name) is not None for name in OPTIONAL_DEPS}
    return {
        "present": present,
        "missing_optional_deps": [name for name, ok in present.items() if not ok],
    }


def fixture_returns(count: int = 90) -> list[float]:
    return [
        0.0008 + math.sin(index / 7.0) * 0.006 - (0.025 if index in {35, 72} else 0.0)
        for index in range(count)
    ]


def percentile(sorted_values: list[float], p: float) -> float:
    if not sorted_values:
        return 0.0
    idx = max(0, min(len(sorted_values) - 1, int(p * (len(sorted_values) - 1))))
    return sorted_values[idx]


def tail_average(sorted_values: list[float], p: float) -> float:
    if not sorted_values:
        return 0.0
    count = max(1, math.ceil(len(sorted_values) * p))
    return sum(sorted_values[:count]) / count


def monte_carlo_var(
    returns: Iterable[float],
    simulations: int = 500,
    horizon_days: int = 20,
    seed: int = 42,
) -> dict:
    values = [float(value) for value in returns]
    avg = sum(values) / len(values) if values else 0.0
    variance = sum((value - avg) ** 2 for value in values) / max(1, len(values) - 1)
    sigma = max(0.0001, math.sqrt(variance))
    rng = random.Random(seed)
    outcomes = []
    for _ in range(max(100, simulations)):
        cumulative = 1.0
        for _day in range(max(1, horizon_days)):
            shock = rng.gauss(avg, sigma)
            cumulative *= 1.0 + shock
        outcomes.append(cumulative - 1.0)
    outcomes.sort()
    p5 = percentile(outcomes, 0.05)
    p1 = percentile(outcomes, 0.01)
    return {
        "var95": round(abs(min(0.0, p5)), 6),
        "var99": round(abs(min(0.0, p1)), 6),
        "cvar95": round(abs(min(0.0, tail_average(outcomes, 0.05))), 6),
        "cvar99": round(abs(min(0.0, tail_average(outcomes, 0.01))), 6),
        "maxLossEstimate": round(abs(min(0.0, min(outcomes))), 6),
        "simulations": max(100, simulations),
        "horizonDays": max(1, horizon_days),
        "inputReturns": len(values),
    }


def run_test(json_output: bool) -> int:
    deps = dependency_status()
    metrics = monte_carlo_var(fixture_returns())
    payload = {
        "ok": True,
        "mode": "test",
        "shadowOnly": True,
        "liveMutation": False,
        **deps,
        "metrics": metrics,
    }
    if json_output:
        print(json.dumps(payload, indent=2, sort_keys=True))
    else:
        print(f"ok monte_carlo var95={metrics['var95']}")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description="Luna Monte Carlo shadow scaffold")
    parser.add_argument("--test", action="store_true", help="run deterministic fixture self-test")
    parser.add_argument("--json", action="store_true", help="print JSON")
    args = parser.parse_args()
    if not args.test:
        payload = {
            "ok": False,
            "error": "runtime_execution_disabled",
            "hint": "Use --test --json. Phase 8 does not run a service or live Monte Carlo batch from Python.",
        }
        print(json.dumps(payload, indent=2, sort_keys=True))
        return 2
    return run_test(args.json)


if __name__ == "__main__":
    raise SystemExit(main())
