#!/usr/bin/env python3
"""
VectorBT 기반 백테스팅 스캐폴드.

우선순위:
1. vectorbt + pandas + ccxt가 모두 있으면 실제 데이터 백테스트
2. 의존성이 없으면 설치 가이드를 포함한 안전한 JSON/텍스트 오류 출력
"""

from __future__ import annotations

import argparse
import json
import sys
from datetime import datetime, timedelta, timezone


def load_optional_deps():
    missing = []

    try:
        import pandas as pd  # type: ignore
    except Exception:
        pd = None
        missing.append("pandas")

    try:
        import vectorbt as vbt  # type: ignore
    except Exception:
        vbt = None
        missing.append("vectorbt")

    try:
        import ccxt  # type: ignore
    except Exception:
        ccxt = None
        missing.append("ccxt")

    try:
        import talib  # type: ignore
    except Exception:
        talib = None

    return {
        "pd": pd,
        "vbt": vbt,
        "ccxt": ccxt,
        "talib": talib,
        "missing": missing,
    }


def fetch_ohlcv(symbol: str, days: int, deps: dict):
    pd = deps["pd"]
    ccxt = deps["ccxt"]
    if pd is None or ccxt is None:
        raise RuntimeError("pandas 또는 ccxt가 설치되지 않았습니다.")

    end = datetime.now(timezone.utc).replace(tzinfo=None)
    start = end - timedelta(days=days)
    exchange = ccxt.binance()
    since = int(start.timestamp() * 1000)

    all_rows = []
    cursor = since
    limit = 1000
    while True:
        rows = exchange.fetch_ohlcv(symbol, "5m", since=cursor, limit=limit)
        if not rows:
            break
        all_rows.extend(rows)
        if len(rows) < limit:
            break
        cursor = rows[-1][0] + 1

    if not all_rows:
        raise RuntimeError("OHLCV 데이터가 없습니다.")

    df = pd.DataFrame(all_rows, columns=["timestamp", "open", "high", "low", "close", "volume"])
    df["timestamp"] = pd.to_datetime(df["timestamp"], unit="ms")
    df = df.drop_duplicates(subset=["timestamp"]).set_index("timestamp").sort_index()
    return df


def run_backtest(df, params: dict, deps: dict):
    vbt = deps["vbt"]
    talib = deps["talib"]
    pd = deps["pd"]
    if vbt is None or pd is None:
        raise RuntimeError("vectorbt 또는 pandas가 설치되지 않았습니다.")

    close = df["close"]
    high = df["high"]
    low = df["low"]

    rsi_period = params.get("rsi_period", 14)
    macd_fast = params.get("macd_fast", 12)
    macd_slow = params.get("macd_slow", 26)
    macd_signal = params.get("macd_signal", 9)
    rsi_oversold = params.get("rsi_oversold", 30)
    rsi_overbought = params.get("rsi_overbought", 70)
    tp_pct = params.get("tp_pct", 0.06)
    sl_pct = params.get("sl_pct", 0.03)

    if talib is not None:
        rsi = pd.Series(talib.RSI(close.values, timeperiod=rsi_period), index=close.index)
        macd_line, macd_sig, _ = talib.MACD(
            close.values,
            fastperiod=macd_fast,
            slowperiod=macd_slow,
            signalperiod=macd_signal,
        )
        macd_line = pd.Series(macd_line, index=close.index)
        macd_sig = pd.Series(macd_sig, index=close.index)
    else:
        rsi = vbt.RSI.run(close, window=rsi_period).rsi
        macd_ind = vbt.MACD.run(
            close,
            fast_window=macd_fast,
            slow_window=macd_slow,
            signal_window=macd_signal,
        )
        macd_line = macd_ind.macd
        macd_sig = macd_ind.signal

    entries = (rsi < rsi_oversold) & (macd_line > macd_sig)
    exits = (rsi > rsi_overbought) | (macd_line < macd_sig)

    pf = vbt.Portfolio.from_signals(
        close=close,
        entries=entries.fillna(False),
        exits=exits.fillna(False),
        tp_stop=tp_pct,
        sl_stop=sl_pct,
        init_cash=10_000,
        fees=0.001,
        freq="5min",
    )

    stats = pf.stats()
    return {
        "total_return": float(stats.get("Total Return [%]", 0) or 0),
        "sharpe_ratio": float(stats.get("Sharpe Ratio", 0) or 0),
        "max_drawdown": float(stats.get("Max Drawdown [%]", 0) or 0),
        "win_rate": float(stats.get("Win Rate [%]", 0) or 0),
        "total_trades": int(stats.get("Total Trades", 0) or 0),
        "profit_factor": float(stats.get("Profit Factor", 0) or 0),
        "params": params,
    }


def grid_search(df, deps: dict):
    results = []
    rsi_periods = [10, 14, 20]
    macd_configs = [
        {"macd_fast": 12, "macd_slow": 26, "macd_signal": 9},
        {"macd_fast": 8, "macd_slow": 21, "macd_signal": 5},
        {"macd_fast": 5, "macd_slow": 13, "macd_signal": 3},
    ]
    sl_pcts = [0.02, 0.03, 0.05]
    tp_pcts = [0.04, 0.06, 0.08]

    for rsi_period in rsi_periods:
        for macd_cfg in macd_configs:
            for sl_pct in sl_pcts:
                for tp_pct in tp_pcts:
                    params = {
                        "rsi_period": rsi_period,
                        "rsi_oversold": 30,
                        "rsi_overbought": 70,
                        "sl_pct": sl_pct,
                        "tp_pct": tp_pct,
                        **macd_cfg,
                    }
                    try:
                        results.append(run_backtest(df, params, deps))
                    except Exception as exc:
                        results.append({
                            "error": str(exc),
                            "params": params,
                        })

    results = [item for item in results if "error" not in item]
    results.sort(key=lambda item: item.get("sharpe_ratio", 0), reverse=True)
    return results


def emit_missing_dependency_error(missing: list[str], as_json: bool):
    payload = {
        "status": "dependency_missing",
        "missing": missing,
        "install": "pip3 install vectorbt pandas numpy ccxt --break-system-packages",
    }
    if as_json:
        print(json.dumps(payload, ensure_ascii=False, indent=2))
    else:
        print("ERROR: 필수 Python 패키지가 없습니다.")
        print(f"  missing: {', '.join(missing)}")
        print(f"  install: {payload['install']}")
    return 1


def main():
    parser = argparse.ArgumentParser(description="VectorBT 백테스팅")
    parser.add_argument("--symbol", default="BTC/USDT")
    parser.add_argument("--days", type=int, default=90)
    parser.add_argument("--grid", action="store_true")
    parser.add_argument("--json", action="store_true")
    parser.add_argument("--tp", type=float, default=0.06)
    parser.add_argument("--sl", type=float, default=0.03)
    args = parser.parse_args()

    deps = load_optional_deps()
    if deps["missing"]:
        return emit_missing_dependency_error(deps["missing"], args.json)

    try:
        df = fetch_ohlcv(args.symbol, args.days, deps)
        if args.grid:
            result = grid_search(df, deps)[:10]
        else:
            result = run_backtest(df, {"tp_pct": args.tp, "sl_pct": args.sl}, deps)
    except Exception as exc:
        payload = {"status": "error", "message": str(exc)}
        if args.json:
            print(json.dumps(payload, ensure_ascii=False, indent=2))
        else:
            print(f"ERROR: {exc}")
        return 1

    if args.json:
        print(json.dumps(result, ensure_ascii=False, indent=2))
        return 0

    if args.grid:
        print(f"[VectorBT] top results for {args.symbol}")
        for index, item in enumerate(result[:5], start=1):
            print(
                f"  #{index}: sharpe={item['sharpe_ratio']:.2f} "
                f"return={item['total_return']:.1f}% "
                f"mdd={item['max_drawdown']:.1f}% "
                f"win={item['win_rate']:.1f}% "
                f"params={item['params']}"
            )
    else:
        print(f"[VectorBT] {args.symbol}")
        print(f"  return: {result['total_return']:.1f}%")
        print(f"  sharpe: {result['sharpe_ratio']:.2f}")
        print(f"  mdd:    {result['max_drawdown']:.1f}%")
        print(f"  win:    {result['win_rate']:.1f}%")
        print(f"  trades: {result['total_trades']}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
