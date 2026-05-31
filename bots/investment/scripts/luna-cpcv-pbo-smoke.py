#!/usr/bin/env python3
"""Luna Phase 1c CPCV/PBO dry smoke.

DB/네트워크/거래소를 사용하지 않는 순수 행렬 검증이다.
"""

from __future__ import annotations

import importlib.util
import json
from pathlib import Path

import numpy as np


ROOT = Path(__file__).resolve().parents[3]
BACKTEST = ROOT / "bots" / "investment" / "scripts" / "backtest-vectorbt.py"


def load_backtest_module():
    spec = importlib.util.spec_from_file_location("luna_backtest_vectorbt", BACKTEST)
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


def assert_between(name: str, value: float, low: float, high: float):
    if not (low <= value <= high):
        raise AssertionError(f"{name}={value} not in [{low},{high}]")


def main() -> int:
    mod = load_backtest_module()

    rng = np.random.default_rng(7)
    random_trials = rng.normal(0, 0.01, size=(256, 20))
    case_a = mod.compute_pbo_from_returns_matrix(random_trials, n_blocks=16, min_trials=10)
    assert case_a["pbo_status"] == "ok", case_a
    assert_between("case_a.pbo", case_a["pbo"], 0.35, 0.65)

    rng = np.random.default_rng(11)
    superior_trial = rng.normal(0, 0.01, size=(256, 20))
    superior_trial[:, 0] += 0.003
    case_b = mod.compute_pbo_from_returns_matrix(superior_trial, n_blocks=16, min_trials=10)
    assert case_b["pbo_status"] == "ok", case_b
    if not (case_b["pbo"] < 0.3 and case_b["dominance_first_order"] is True):
        raise AssertionError(f"case_b unexpected: {case_b}")

    case_c_bars = mod.compute_pbo_from_returns_matrix(rng.normal(0, 0.01, size=(8, 20)), n_blocks=16, min_trials=10)
    case_c_trials = mod.compute_pbo_from_returns_matrix(rng.normal(0, 0.01, size=(256, 1)), n_blocks=16, min_trials=10)
    for label, item in [("case_c_bars", case_c_bars), ("case_c_trials", case_c_trials)]:
        if item["pbo"] is not None or not item["pbo_reasons"]:
            raise AssertionError(f"{label} did not fail gracefully: {item}")

    case_d1 = mod.compute_pbo_from_returns_matrix(random_trials, n_blocks=16, min_trials=10)
    case_d2 = mod.compute_pbo_from_returns_matrix(random_trials, n_blocks=16, min_trials=10)
    if case_d1 != case_d2:
        raise AssertionError({"case_d1": case_d1, "case_d2": case_d2})

    payload = {
        "ok": True,
        "case_a": case_a,
        "case_b": case_b,
        "case_c_bars": case_c_bars,
        "case_c_trials": case_c_trials,
        "case_d_reproducible": True,
    }
    print(json.dumps(payload, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

