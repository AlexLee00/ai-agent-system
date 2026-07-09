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


def build_fixture_df(pd, periods: int = 8):
    index = pd.date_range("2026-01-01T00:00:00Z", periods=periods, freq="1D")
    open_values = [100 + (idx % 20) for idx in range(periods)]
    df = pd.DataFrame(
        {
            "open": open_values,
            "high": [value + 4 for value in open_values],
            "low": [value - 4 for value in open_values],
            "close": [value + (2 if idx % 2 == 0 else -1) for idx, value in enumerate(open_values)],
            "volume": [1000 + idx for idx in range(periods)],
        },
        index=index,
    )
    df.attrs["luna_data_interval"] = "1d"
    df.attrs["luna_market_calendar"] = "crypto"
    return df


def fixture_signal_masks(df, params, deps):
    pd = deps["pd"]
    entries = pd.Series(False, index=df.index)
    exits = pd.Series(False, index=df.index)
    entries.iloc[1] = True
    exits.iloc[3] = True
    return entries, exits


def assert_close(left, right, label: str):
    if math.isclose(float(left), float(right), rel_tol=0, abs_tol=1e-9):
        return
    raise AssertionError(f"{label}: {left} != {right}")


def run_fixture_backtest(module, deps, df, enabled: bool | None):
    env_value = None if enabled is None else ("true" if enabled else "false")
    with patched_env({"LUNA_BT_NEXT_BAR_EXECUTION_ENABLED": env_value}):
        return module.run_backtest(
            df,
            {"strategy": "fixture", "tp_pct": 10.0, "sl_pct": 10.0},
            deps,
        )


def compare_results(off: dict, on: dict):
    metrics = ["total_return", "win_rate", "total_trades", "max_drawdown"]
    return {
        metric: {
            "off": off.get(metric),
            "on": on.get(metric),
            "delta": (on.get(metric, 0) or 0) - (off.get(metric, 0) or 0),
        }
        for metric in metrics
    }


def format_table(comparison: dict):
    lines = ["metric                 off          on       delta"]
    for metric, values in comparison.items():
        lines.append(
            f"{metric:<18} {float(values['off'] or 0):>10.4f} "
            f"{float(values['on'] or 0):>10.4f} {float(values['delta'] or 0):>10.4f}"
        )
    return "\n".join(lines)


def main(as_json: bool = False):
    module = load_backtest_module()
    deps = module.load_optional_deps()
    missing = [name for name in ["pandas", "vectorbt"] if deps.get("pd" if name == "pandas" else "vbt") is None]
    if missing:
        raise RuntimeError(f"missing dependencies for nextbar smoke: {', '.join(missing)}")

    df = build_fixture_df(deps["pd"])
    wf_df = build_fixture_df(deps["pd"], periods=140)
    original_builder = module.build_signal_masks
    try:
        module.build_signal_masks = fixture_signal_masks
        off = run_fixture_backtest(module, deps, df, None)
        off_false = run_fixture_backtest(module, deps, df, False)
        on = run_fixture_backtest(module, deps, df, True)
        with patched_env({"LUNA_BT_NEXT_BAR_EXECUTION_ENABLED": "true"}):
            grid = module.grid_search(df, deps)
            wf = module.walk_forward(wf_df, deps, folds=2, train_days=30, test_days=30)
    finally:
        module.build_signal_masks = original_builder

    for metric in ["total_return", "win_rate", "total_trades", "max_drawdown"]:
        assert_close(off.get(metric), off_false.get(metric), f"off regression {metric}")

    grid_fixture = [{"idx": idx} for idx in range(12)]
    with patched_env({"LUNA_BT_GRID_RETURN_ALL": None}):
        default_limited = module.limit_grid_results(grid_fixture)
    with patched_env({"LUNA_BT_GRID_RETURN_ALL": "true"}):
        full_grid = module.limit_grid_results(grid_fixture)
    assert len(default_limited) == 10
    assert len(full_grid) == 12

    entries = deps["pd"].Series([False, True, False, True, False], index=df.index[:5])
    exits = deps["pd"].Series([False, False, True, True, False], index=df.index[:5])
    shifted_entries, shifted_exits = module.apply_next_bar_signal_masks(entries, exits)
    assert shifted_entries.iloc[2] is True or bool(shifted_entries.iloc[2]) is True
    assert bool(shifted_entries.iloc[-1]) is False
    assert bool(shifted_exits.iloc[3]) is True
    assert bool(shifted_exits.iloc[-1]) is False

    assert off["execution_model"] == "same_bar_close"
    assert off["execution_price_model"] == "close"
    assert on["execution_model"] == "next_bar"
    assert on["execution_price_model"] in {"next_open", "next_close"}
    assert on["execution_price_model"] == "next_open"
    assert grid and grid[0].get("execution_model") == "next_bar"
    assert wf and wf.get("execution_model") == "next_bar"
    assert wf.get("execution_price_model") == "next_open"

    comparison = compare_results(off, on)
    payload = {
        "ok": True,
        "smoke": "luna-nextbar-compare",
        "priceSupported": on["execution_price_model"] == "next_open",
        "offExecutionModel": off["execution_model"],
        "onExecutionModel": on["execution_model"],
        "onExecutionPriceModel": on["execution_price_model"],
        "gridExecutionModel": grid[0].get("execution_model"),
        "walkForwardExecutionModel": wf.get("execution_model"),
        "walkForwardExecutionPriceModel": wf.get("execution_price_model"),
        "defaultGridLimit": len(default_limited),
        "fullGridLimit": len(full_grid),
        "shiftedEntryIndex": str(shifted_entries[shifted_entries].index[0]),
        "lastRowEntry": bool(shifted_entries.iloc[-1]),
        "lastRowExit": bool(shifted_exits.iloc[-1]),
        "comparison": comparison,
        "table": format_table(comparison),
    }
    if as_json:
        print(json.dumps(payload, ensure_ascii=False, indent=2))
    else:
        print(payload["table"])
    return payload


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Luna next-bar backtest comparison smoke")
    parser.add_argument("--json", action="store_true")
    args = parser.parse_args()
    main(as_json=args.json)
