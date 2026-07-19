#!/usr/bin/env python3

import importlib.util
import math
from pathlib import Path

import pandas as pd


MODULE_PATH = Path(__file__).with_name("backtest-vectorbt.py")
SPEC = importlib.util.spec_from_file_location("luna_backtest_vectorbt", MODULE_PATH)
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


def assert_close(actual, expected, tolerance=1e-3):
    assert math.isfinite(float(actual)), f"expected finite value, got {actual}"
    assert abs(float(actual) - expected) <= tolerance, f"{actual} != {expected}"


def test_wilder_rsi():
    prices = pd.Series([
        44.34, 44.09, 44.15, 43.61, 44.33, 44.83, 45.10,
        45.42, 45.84, 46.08, 45.89, 46.03, 45.61, 46.28,
        46.28, 46.00, 46.03, 46.41, 46.22, 45.64, 46.21,
    ])
    rsi = MODULE.calc_rsi(prices, 14, {"pd": pd, "talib": None})
    expected = [70.4641, 66.2496, 66.4809, 69.3469, 66.2947, 57.9150, 62.8807]
    for actual, target in zip(rsi.iloc[14:].tolist(), expected):
        assert_close(actual, target, tolerance=0.01)


def test_causal_consensus():
    params_a = {"strategy": "rsi", "rsi_period": 14}
    params_b = {"strategy": "rsi", "rsi_period": 20}
    early_grids = [
        [{"params": params_a, "robust_score": 5.0}, {"params": params_b, "robust_score": 4.0}],
        [{"params": params_a, "robust_score": 4.5}, {"params": params_b, "robust_score": 3.5}],
    ]
    future_grid = [
        {"params": params_b, "robust_score": 100.0},
        {"params": params_a, "robust_score": -100.0},
    ]
    before = MODULE.select_causal_consensus_sequence(early_grids)
    after = MODULE.select_causal_consensus_sequence([*early_grids, future_grid])
    assert [item["signature"] for item in before] == [item["signature"] for item in after[:2]], (
        "future folds must not change earlier OOS parameter selections"
    )


def test_compounded_return():
    assert_close(MODULE.compound_return_pct([0.10, -0.05]), 4.5, tolerance=1e-9)


def test_market_session_periods_per_year():
    assert_close(MODULE.periods_per_year("1h", "crypto"), 8760.0, tolerance=1e-9)
    assert_close(MODULE.periods_per_year("1h", "overseas"), 1638.0, tolerance=1e-9)
    assert_close(MODULE.periods_per_year("5min", "domestic"), 19656.0, tolerance=1e-9)


def test_market_session_annualized_sharpe():
    returns = [0.01, -0.005, 0.007, -0.002]
    crypto = MODULE.annualized_sharpe(returns, "1h", "crypto")
    stock = MODULE.annualized_sharpe(returns, "1h", "overseas")
    assert crypto > stock
    assert_close(crypto / stock, math.sqrt(8760.0 / 1638.0), tolerance=1e-9)


if __name__ == "__main__":
    test_wilder_rsi()
    test_causal_consensus()
    test_compounded_return()
    test_market_session_periods_per_year()
    test_market_session_annualized_sharpe()
    print({"ok": True, "checks": ["wilder_rsi", "causal_consensus", "compounded_return", "market_session_periods_per_year", "market_session_annualized_sharpe"]})
