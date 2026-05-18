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
import math
import sys
import warnings
from datetime import datetime, timedelta, timezone

warnings.filterwarnings("ignore", message="urllib3 v2 only supports OpenSSL")


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
        import yfinance as yf  # type: ignore
    except Exception:
        yf = None

    try:
        import talib  # type: ignore
    except Exception:
        talib = None

    return {
        "pd": pd,
        "vbt": vbt,
        "ccxt": ccxt,
        "yf": yf,
        "talib": talib,
        "missing": missing,
    }


def fetch_ohlcv(symbol: str, days: int, deps: dict):
    pd = deps["pd"]
    ccxt = deps["ccxt"]
    yf = deps["yf"]
    if pd is None:
        raise RuntimeError("pandas가 설치되지 않았습니다.")

    end = datetime.now(timezone.utc).replace(tzinfo=None)
    start = end - timedelta(days=days)

    if "/" in symbol:
        if ccxt is None:
            raise RuntimeError("ccxt가 설치되지 않았습니다.")

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

    if yf is None:
        raise RuntimeError("yfinance가 설치되지 않았습니다.")

    ticker_symbol = map_stock_symbol(symbol)
    history = None

    for candidate in ticker_symbol:
        ticker = yf.Ticker(candidate)
        trial = ticker.history(start=start.strftime("%Y-%m-%d"), end=end.strftime("%Y-%m-%d"), interval="1h")
        if trial is not None and not trial.empty:
            history = trial
            break

    if history is None or history.empty:
        raise RuntimeError("주식 OHLCV 데이터가 없습니다.")

    history = history.reset_index()
    timestamp_col = "Datetime" if "Datetime" in history.columns else history.columns[0]
    history["timestamp"] = pd.to_datetime(history[timestamp_col])
    df = history.rename(
        columns={
            "Open": "open",
            "High": "high",
            "Low": "low",
            "Close": "close",
            "Volume": "volume",
        }
    )[["timestamp", "open", "high", "low", "close", "volume"]]
    df = df.drop_duplicates(subset=["timestamp"]).set_index("timestamp").sort_index()
    return df


def map_stock_symbol(symbol: str):
    if symbol.isdigit() and len(symbol) == 6:
        return [f"{symbol}.KS", f"{symbol}.KQ"]
    return [symbol]


def calc_rsi(close, period: int, deps: dict):
    pd = deps["pd"]
    talib = deps["talib"]
    if talib is not None:
        return pd.Series(talib.RSI(close.values, timeperiod=period), index=close.index)

    delta = close.diff()
    gain = delta.clip(lower=0).rolling(period).mean()
    loss = (-delta.clip(upper=0)).rolling(period).mean()
    rs = gain / loss.replace(0, math.nan)
    return 100 - (100 / (1 + rs))


def calc_macd(close, fast: int, slow: int, signal: int, deps: dict):
    pd = deps["pd"]
    talib = deps["talib"]
    if talib is not None:
        macd_line, macd_sig, _ = talib.MACD(
            close.values,
            fastperiod=fast,
            slowperiod=slow,
            signalperiod=signal,
        )
        return pd.Series(macd_line, index=close.index), pd.Series(macd_sig, index=close.index)

    macd_line = close.ewm(span=fast, adjust=False).mean() - close.ewm(span=slow, adjust=False).mean()
    macd_sig = macd_line.ewm(span=signal, adjust=False).mean()
    return macd_line, macd_sig


def crossed_above(left, right):
    return (left > right) & (left.shift(1) <= right.shift(1))


def build_signal_masks(df, params: dict, deps: dict):
    close = df["close"]
    high = df["high"]
    volume = df["volume"]
    strategy = params.get("strategy", "rsi_macd_reversal")

    if strategy == "ema_trend_pullback":
        fast = params.get("ema_fast", 12)
        slow = params.get("ema_slow", 48)
        rsi_period = params.get("rsi_period", 14)
        rsi_min = params.get("rsi_min", 42)
        rsi_max = params.get("rsi_max", 72)
        rsi_exit = params.get("rsi_exit", 78)
        ema_fast = close.ewm(span=fast, adjust=False).mean()
        ema_slow = close.ewm(span=slow, adjust=False).mean()
        rsi = calc_rsi(close, rsi_period, deps)
        trend = ema_fast > ema_slow
        reclaim = crossed_above(close, ema_fast)
        entries = trend & reclaim & (rsi >= rsi_min) & (rsi <= rsi_max)
        exits = (ema_fast < ema_slow) | (close < ema_slow) | (rsi > rsi_exit)
        return entries, exits

    if strategy == "breakout_momentum":
        lookback = params.get("breakout_window", 48)
        ema_window = params.get("ema_window", 72)
        volume_mult = params.get("volume_mult", 1.15)
        prev_high = high.rolling(lookback).max().shift(1)
        volume_ma = volume.rolling(lookback).mean().shift(1)
        ema = close.ewm(span=ema_window, adjust=False).mean()
        entries = (close > prev_high) & (volume > volume_ma * volume_mult) & (close > ema)
        exits = (close < ema) | (close < prev_high * 0.985)
        return entries, exits

    if strategy == "bollinger_mean_reversion":
        window = params.get("bb_window", 20)
        std_mult = params.get("bb_std", 2.0)
        rsi_period = params.get("rsi_period", 14)
        rsi_oversold = params.get("rsi_oversold", 32)
        rsi_exit = params.get("rsi_exit", 55)
        mid = close.rolling(window).mean().shift(1)
        sd = close.rolling(window).std().shift(1)
        lower = mid - sd * std_mult
        rsi = calc_rsi(close, rsi_period, deps)
        entries = (close < lower) & (rsi < rsi_oversold)
        exits = (close > mid) | (rsi > rsi_exit)
        return entries, exits

    rsi_period = params.get("rsi_period", 14)
    macd_fast = params.get("macd_fast", 12)
    macd_slow = params.get("macd_slow", 26)
    macd_signal = params.get("macd_signal", 9)
    rsi_oversold = params.get("rsi_oversold", 30)
    rsi_overbought = params.get("rsi_overbought", 70)

    rsi = calc_rsi(close, rsi_period, deps)
    macd_line, macd_sig = calc_macd(close, macd_fast, macd_slow, macd_signal, deps)
    entries = (rsi < rsi_oversold) & (macd_line > macd_sig)
    exits = (rsi > rsi_overbought) | (macd_line < macd_sig)
    return entries, exits


def infer_portfolio_freq(df) -> str:
    try:
        if df is None or df.index is None or len(df.index) < 2:
            return "5min"
        deltas = df.index.to_series().diff().dropna().dt.total_seconds()
        if deltas.empty:
            return "5min"
        median_seconds = float(deltas.median())
    except Exception:
        return "5min"

    if median_seconds <= 10 * 60:
        return "5min"
    if median_seconds <= 2 * 3600:
        return "1h"
    return "1d"


def run_backtest(df, params: dict, deps: dict):
    vbt = deps["vbt"]
    pd = deps["pd"]
    if vbt is None or pd is None:
        raise RuntimeError("vectorbt 또는 pandas가 설치되지 않았습니다.")

    close = df["close"]
    tp_pct = params.get("tp_pct", 0.06)
    sl_pct = params.get("sl_pct", 0.03)
    entries, exits = build_signal_masks(df, params, deps)
    portfolio_freq = infer_portfolio_freq(df)

    pf = vbt.Portfolio.from_signals(
        close=close,
        entries=entries.fillna(False),
        exits=exits.fillna(False),
        tp_stop=tp_pct,
        sl_stop=sl_pct,
        init_cash=10_000,
        fees=0.001,
        freq=portfolio_freq,
    )

    stats = pf.stats()
    result = {
        "total_return": float(stats.get("Total Return [%]", 0) or 0),
        "sharpe_ratio": float(stats.get("Sharpe Ratio", 0) or 0),
        "max_drawdown": float(stats.get("Max Drawdown [%]", 0) or 0),
        "win_rate": float(stats.get("Win Rate [%]", 0) or 0),
        "total_trades": int(stats.get("Total Trades", 0) or 0),
        "profit_factor": float(stats.get("Profit Factor", 0) or 0),
        "params": {**params, "portfolio_freq": portfolio_freq},
    }
    result["robust_score"] = robust_rank_score(result)
    return result


def safe_float(value, fallback: float = 0.0) -> float:
    try:
        out = float(value)
        return out if math.isfinite(out) else fallback
    except Exception:
        return fallback


def robust_rank_score(item: dict) -> float:
    sharpe = safe_float(item.get("sharpe_ratio"))
    total_return = safe_float(item.get("total_return"))
    max_drawdown = abs(safe_float(item.get("max_drawdown"), 100.0))
    win_rate = safe_float(item.get("win_rate"))
    total_trades = safe_float(item.get("total_trades"))
    profit_factor = safe_float(item.get("profit_factor"))

    # Raw Sharpe over-ranks tiny trade samples. Promotion uses walk-forward
    # averages, so rank each grid by a conservative robustness proxy first.
    trade_confidence = min(1.0, max(0.0, total_trades / 50.0))
    drawdown_score = max(0.0, 1.0 - max(0.0, max_drawdown - 18.0) / 42.0)
    win_score = min(1.0, max(0.0, win_rate / 55.0))
    return_score = min(1.0, max(-1.0, total_return / 50.0))
    profit_score = min(1.0, max(0.0, profit_factor - 1.0))

    return (
        sharpe * trade_confidence * drawdown_score * 0.62
        + return_score * 0.16
        + win_score * 0.12
        + profit_score * 0.10
    )


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
                        "strategy": "rsi_macd_reversal",
                        **macd_cfg,
                    }
                    try:
                        results.append(run_backtest(df, params, deps))
                    except Exception as exc:
                        results.append({
                            "error": str(exc),
                            "params": params,
                        })

    for ema_cfg in [
        {"ema_fast": 8, "ema_slow": 34},
        {"ema_fast": 12, "ema_slow": 48},
        {"ema_fast": 21, "ema_slow": 72},
    ]:
        for rsi_band in [
            {"rsi_min": 38, "rsi_max": 70},
            {"rsi_min": 45, "rsi_max": 78},
        ]:
            for sl_pct, tp_pct in [(0.025, 0.05), (0.035, 0.075), (0.05, 0.10)]:
                params = {
                    "strategy": "ema_trend_pullback",
                    "rsi_period": 14,
                    "rsi_exit": 82,
                    "sl_pct": sl_pct,
                    "tp_pct": tp_pct,
                    **ema_cfg,
                    **rsi_band,
                }
                try:
                    results.append(run_backtest(df, params, deps))
                except Exception as exc:
                    results.append({"error": str(exc), "params": params})

    for breakout_window in [24, 48, 96]:
        for volume_mult in [1.0, 1.25]:
            for sl_pct, tp_pct in [(0.025, 0.05), (0.04, 0.08), (0.06, 0.12)]:
                params = {
                    "strategy": "breakout_momentum",
                    "breakout_window": breakout_window,
                    "ema_window": max(48, breakout_window),
                    "volume_mult": volume_mult,
                    "sl_pct": sl_pct,
                    "tp_pct": tp_pct,
                }
                try:
                    results.append(run_backtest(df, params, deps))
                except Exception as exc:
                    results.append({"error": str(exc), "params": params})

    for bb_window in [20, 40]:
        for rsi_oversold in [28, 34]:
            for sl_pct, tp_pct in [(0.02, 0.04), (0.03, 0.06), (0.05, 0.09)]:
                params = {
                    "strategy": "bollinger_mean_reversion",
                    "bb_window": bb_window,
                    "bb_std": 2.0,
                    "rsi_period": 14,
                    "rsi_oversold": rsi_oversold,
                    "rsi_exit": 55,
                    "sl_pct": sl_pct,
                    "tp_pct": tp_pct,
                }
                try:
                    results.append(run_backtest(df, params, deps))
                except Exception as exc:
                    results.append({"error": str(exc), "params": params})

    results = [item for item in results if "error" not in item]
    results.sort(
        key=lambda item: (
            item.get("robust_score", robust_rank_score(item)),
            item.get("sharpe_ratio", 0),
        ),
        reverse=True,
    )
    return results


def sanitize_json_value(value):
    if isinstance(value, dict):
        return {key: sanitize_json_value(item) for key, item in value.items()}
    if isinstance(value, list):
        return [sanitize_json_value(item) for item in value]
    if isinstance(value, float):
        return value if math.isfinite(value) else None
    return value


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
        print(json.dumps(sanitize_json_value(result), ensure_ascii=False, indent=2))
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
