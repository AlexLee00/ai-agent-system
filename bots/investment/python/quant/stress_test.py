#!/usr/bin/env python3
"""Luna Phase 8 historical stress-test scaffold.

This CLI is deterministic and test-only. Runtime writes and live risk changes
belong to the TypeScript shadow operator with an explicit confirm gate.
"""

from __future__ import annotations

import argparse
import importlib.util
import json
import math


OPTIONAL_DEPS = ["numpy", "scipy", "arch", "empyrical"]

SCENARIOS = {
    "2008_financial_crisis": {"drawdownPct": 0.40, "months": 6},
    "2020_covid_crash": {"drawdownPct": 0.30, "months": 1},
    "2022_luna_ftx": {"drawdownPct": 0.70, "months": 3},
    "2018_btc_crash": {"drawdownPct": 0.80, "months": 12},
}


def dependency_status() -> dict:
    present = {name: importlib.util.find_spec(name) is not None for name in OPTIONAL_DEPS}
    return {
        "present": present,
        "missing_optional_deps": [name for name, ok in present.items() if not ok],
    }


def fixture_returns(count: int = 90) -> list[float]:
    return [
        0.0004 + math.sin(index / 6.0) * 0.008 - (0.035 if index in {20, 52, 75} else 0.0)
        for index in range(count)
    ]


def stress_metrics(scenario: str, returns: list[float]) -> dict:
    spec = SCENARIOS.get(scenario, SCENARIOS["2022_luna_ftx"])
    avg = sum(returns) / len(returns) if returns else 0.0
    variance = sum((value - avg) ** 2 for value in returns) / max(1, len(returns) - 1)
    volatility = math.sqrt(variance)
    max_loss = min(0.95, spec["drawdownPct"] + min(0.2, volatility * 2.5))
    return {
        "scenario": scenario,
        "var95": round(min(max_loss, spec["drawdownPct"] * 0.62), 6),
        "var99": round(min(max_loss, spec["drawdownPct"] * 0.78), 6),
        "cvar95": round(min(max_loss, spec["drawdownPct"] * 0.74), 6),
        "cvar99": round(min(max_loss, spec["drawdownPct"] * 0.88), 6),
        "maxLossEstimate": round(max_loss, 6),
        "riskLevel": "critical" if max_loss >= 0.25 else "high" if max_loss >= 0.15 else "medium",
        "killSwitchWouldTrigger": max_loss >= 0.05,
        "inputReturns": len(returns),
        "months": spec["months"],
    }


def run_test(json_output: bool) -> int:
    returns = fixture_returns()
    payload = {
        "ok": True,
        "mode": "test",
        "shadowOnly": True,
        "liveMutation": False,
        **dependency_status(),
        "scenarios": {name: stress_metrics(name, returns) for name in SCENARIOS},
    }
    if json_output:
        print(json.dumps(payload, indent=2, sort_keys=True))
    else:
        print("ok stress_test scenarios=%d" % len(payload["scenarios"]))
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description="Luna historical stress-test shadow scaffold")
    parser.add_argument("--test", action="store_true", help="run deterministic fixture self-test")
    parser.add_argument("--json", action="store_true", help="print JSON")
    args = parser.parse_args()
    if not args.test:
        payload = {
            "ok": False,
            "error": "runtime_execution_disabled",
            "hint": "Use --test --json. Phase 8 does not run a Python stress-test service.",
        }
        print(json.dumps(payload, indent=2, sort_keys=True))
        return 2
    return run_test(args.json)


if __name__ == "__main__":
    raise SystemExit(main())
