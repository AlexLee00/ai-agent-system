#!/usr/bin/env python3
from __future__ import annotations

import argparse
import importlib.util
import json
import math
import os
from contextlib import contextmanager
from pathlib import Path


BACKTEST_PATH = Path(__file__).with_name("backtest-vectorbt.py")


def load_backtest_module():
    spec = importlib.util.spec_from_file_location("luna_backtest_vectorbt", BACKTEST_PATH)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"failed to load {BACKTEST_PATH}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


@contextmanager
def patched_env(updates: dict[str, str | None]):
    previous = {key: os.environ.get(key) for key in updates}
    try:
        for key, value in updates.items():
            if value is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = value
        yield
    finally:
        for key, value in previous.items():
            if value is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = value


def build_step_trend_df(pd, periods: int = 80):
    index = pd.date_range("2026-01-01T00:00:00Z", periods=periods, freq="1D")
    close = []
    level = 100.0
    jump_points = {10, 25, 40, 55}
    for idx in range(periods):
        if idx in jump_points:
            level += 12.0
        close.append(level + idx * 0.01)
    df = pd.DataFrame(
        {
            "open": [value - 0.2 for value in close],
            "high": [value + 1.0 for value in close],
            "low": [value - 1.0 for value in close],
            "close": close,
            "volume": [1000 + idx for idx in range(periods)],
        },
        index=index,
    )
    df.attrs["luna_data_interval"] = "1d"
    df.attrs["luna_market_calendar"] = "crypto"
    return df


def build_random_like_df(pd, periods: int = 80):
    index = pd.date_range("2026-03-01T00:00:00Z", periods=periods, freq="1D")
    close = []
    for idx in range(periods):
        close.append(100.0 + math.sin(idx * 1.7) * 1.6 + math.cos(idx * 0.9) * 0.8)
    df = pd.DataFrame(
        {
            "open": [value + 0.05 for value in close],
            "high": [value + 1.0 for value in close],
            "low": [value - 1.0 for value in close],
            "close": close,
            "volume": [900 + idx for idx in range(periods)],
        },
        index=index,
    )
    df.attrs["luna_data_interval"] = "1d"
    df.attrs["luna_market_calendar"] = "crypto"
    return df


def trend_signal_masks(df, params, deps):
    pd = deps["pd"]
    entries = pd.Series(False, index=df.index)
    exits = pd.Series(False, index=df.index)
    for entry_idx, exit_idx in [(7, 12), (22, 27), (37, 42), (52, 57)]:
        entries.iloc[entry_idx] = True
        exits.iloc[exit_idx] = True
    return entries, exits


def random_signal_masks(df, params, deps):
    pd = deps["pd"]
    entries = pd.Series(False, index=df.index)
    exits = pd.Series(False, index=df.index)
    for entry_idx, exit_idx in [(5, 9), (19, 23), (33, 37), (47, 51), (61, 65)]:
        entries.iloc[entry_idx] = True
        exits.iloc[exit_idx] = True
    return entries, exits


def zero_signal_masks(df, params, deps):
    pd = deps["pd"]
    return pd.Series(False, index=df.index), pd.Series(False, index=df.index)


def run_backtest(module, deps, df, signal_builder, env: dict[str, str | None]):
    original_builder = module.build_signal_masks
    try:
        module.build_signal_masks = signal_builder
        with patched_env(env):
            return module.run_backtest(
                df,
                {"strategy": "fixture", "tp_pct": 50.0, "sl_pct": 50.0},
                deps,
            )
    finally:
        module.build_signal_masks = original_builder


def permutation_keys(payload: dict) -> set[str]:
    return {key for key in payload if key.startswith("permutation_")}


def main(as_json: bool = False):
    module = load_backtest_module()
    deps = module.load_optional_deps()
    missing = [name for name in ["pandas", "vectorbt"] if deps.get("pd" if name == "pandas" else "vbt") is None]
    if missing:
        raise RuntimeError(f"missing dependencies for permutation smoke: {', '.join(missing)}")

    trend_df = build_step_trend_df(deps["pd"])
    random_df = build_random_like_df(deps["pd"])
    common_env = {
        "LUNA_BT_PERMUTATION_ENABLED": "true",
        "LUNA_BT_PERMUTATION_ITERATIONS": "128",
        "LUNA_BT_PERMUTATION_SEED": "424242",
    }

    off_unset = run_backtest(module, deps, trend_df, trend_signal_masks, {
        "LUNA_BT_PERMUTATION_ENABLED": None,
        "LUNA_BT_PERMUTATION_ITERATIONS": None,
        "LUNA_BT_PERMUTATION_SEED": None,
    })
    off_false = run_backtest(module, deps, trend_df, trend_signal_masks, {
        "LUNA_BT_PERMUTATION_ENABLED": "false",
        "LUNA_BT_PERMUTATION_ITERATIONS": "128",
        "LUNA_BT_PERMUTATION_SEED": "424242",
    })
    if off_unset != off_false:
        raise AssertionError("permutation OFF/unset and OFF/false results must be exactly identical")
    if permutation_keys(off_unset):
        raise AssertionError(f"permutation fields leaked while disabled: {sorted(permutation_keys(off_unset))}")

    trend_on = run_backtest(module, deps, trend_df, trend_signal_masks, common_env)
    random_on = run_backtest(module, deps, random_df, random_signal_masks, common_env)
    zero_on = run_backtest(module, deps, trend_df, zero_signal_masks, common_env)

    for key in ["permutation_p_is", "permutation_gate", "permutation_iterations", "permutation_null_sharpe_mean"]:
        if key not in trend_on:
            raise AssertionError(f"missing permutation field: {key}")
    if trend_on["permutation_iterations"] <= 0 or trend_on["permutation_iterations"] > 128:
        raise AssertionError(f"unexpected trend iterations: {trend_on['permutation_iterations']}")
    if not (0 <= float(trend_on["permutation_p_is"]) <= 1):
        raise AssertionError(f"trend p-value out of range: {trend_on['permutation_p_is']}")
    if not (trend_on["permutation_p_is"] < 0.05):
        raise AssertionError(f"trend fixture should be better than random timing: p={trend_on['permutation_p_is']}")
    if not (random_on["permutation_p_is"] >= trend_on["permutation_p_is"]):
        raise AssertionError(
            f"random fixture p-value should not beat trend fixture: "
            f"random={random_on['permutation_p_is']}, trend={trend_on['permutation_p_is']}"
        )
    if zero_on["permutation_p_is"] is not None or zero_on["permutation_iterations"] != 0:
        raise AssertionError("zero-trade fixture must fail open with p-value None and 0 iterations")

    with patched_env({"LUNA_BT_PERMUTATION_ITERATIONS": "5000"}):
        capped = module.permutation_iteration_count()
    if capped != 1000:
        raise AssertionError(f"iteration cap mismatch: {capped}")

    entries = deps["pd"].Series([False, True, False, True, False], index=trend_df.index[:5])
    exits = deps["pd"].Series([False, False, True, True, False], index=trend_df.index[:5])
    shifted_entries, shifted_exits = module.apply_next_bar_signal_masks(entries, exits)
    if not bool(shifted_entries.iloc[2]) or bool(shifted_entries.iloc[-1]):
        raise AssertionError("next-bar entry shift regression")
    if not bool(shifted_exits.iloc[3]) or bool(shifted_exits.iloc[-1]):
        raise AssertionError("next-bar exit shift regression")

    payload = {
        "ok": True,
        "smoke": "luna-c7-permutation",
        "offFieldLeak": sorted(permutation_keys(off_unset)),
        "trendP": trend_on["permutation_p_is"],
        "randomP": random_on["permutation_p_is"],
        "zeroTradeP": zero_on["permutation_p_is"],
        "iterations": trend_on["permutation_iterations"],
        "iterationCap": capped,
        "gate": trend_on["permutation_gate"],
        "nextBarShiftPreserved": True,
    }
    if as_json:
        print(json.dumps(payload, ensure_ascii=False, indent=2))
    else:
        print(json.dumps(payload, ensure_ascii=False))
    return payload


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Luna C7 permutation smoke")
    parser.add_argument("--json", action="store_true")
    args = parser.parse_args()
    main(as_json=args.json)
