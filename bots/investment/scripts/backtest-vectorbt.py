#!/usr/bin/env python3
"""
VectorBT 기반 백테스팅 스캐폴드.

우선순위:
1. vectorbt + pandas + ccxt가 모두 있으면 실제 데이터 백테스트
2. 의존성이 없으면 설치 가이드를 포함한 안전한 JSON/텍스트 오류 출력
"""

from __future__ import annotations

import argparse
import inspect
import itertools
import json
import math
import os
import sys
import warnings
from datetime import datetime, timedelta, timezone

warnings.filterwarnings("ignore", message="urllib3 v2 only supports OpenSSL")

try:
    import numpy as _np
    from scipy import stats as _scipy_stats
except Exception:
    _np = None
    _scipy_stats = None


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

        exchange = ccxt.binance({"enableRateLimit": True})
        since = int(start.timestamp() * 1000)

        all_rows = []
        cursor = since
        limit = 1000
        while True:
            last_error = None
            rows = None
            for attempt in range(2):
                try:
                    rows = exchange.fetch_ohlcv(symbol, "5m", since=cursor, limit=limit)
                    break
                except Exception as exc:
                    last_error = exc
                    if attempt == 0:
                        import time

                        time.sleep(1.5)
            if rows is None:
                raise last_error
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
        df.attrs["luna_market_calendar"] = "crypto"
        return df

    if yf is None:
        raise RuntimeError("yfinance가 설치되지 않았습니다.")

    ticker_symbol = map_stock_symbol(symbol)
    history = None
    used_interval = None
    primary_interval = str(os.environ.get("LUNA_BT_STOCK_INTERVAL", "1h")).strip() or "1h"
    intervals = [primary_interval] + (["1d"] if primary_interval != "1d" else [])

    for interval in intervals:
        for candidate in ticker_symbol:
            try:
                trial = yf.Ticker(candidate).history(
                    start=start.strftime("%Y-%m-%d"),
                    end=end.strftime("%Y-%m-%d"),
                    interval=interval,
                )
            except Exception:
                trial = None
            if trial is not None and not trial.empty:
                history = trial
                used_interval = interval
                break
        if history is not None:
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
    df.attrs["luna_market_calendar"] = stock_market_calendar(symbol)
    df.attrs["luna_data_interval"] = used_interval
    return df


def map_stock_symbol(symbol: str):
    if symbol.isdigit() and len(symbol) == 6:
        return [f"{symbol}.KS", f"{symbol}.KQ"]
    return [symbol]


def stock_market_calendar(symbol: str) -> str:
    normalized = str(symbol or "").strip().upper()
    if normalized.isdigit() and len(normalized) == 6:
        return "domestic"
    if normalized.endswith((".KS", ".KQ")):
        return "domestic"
    return "overseas"


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


def from_signals_param_names(vbt, deps: dict) -> set:
    from_signals_params = deps.get("_from_signals_params")
    if from_signals_params is None:
        try:
            from_signals_params = set(inspect.signature(vbt.Portfolio.from_signals).parameters)
        except Exception:
            from_signals_params = set()
        deps["_from_signals_params"] = from_signals_params
    return from_signals_params


def apply_next_bar_signal_masks(entries, exits):
    next_entries = entries.fillna(False).shift(1, fill_value=False).fillna(False)
    next_exits = exits.fillna(False).shift(1, fill_value=False).fillna(False)
    if len(next_entries) > 0:
        next_entries.iloc[-1] = False
    if len(next_exits) > 0:
        next_exits.iloc[-1] = False
    return next_entries, next_exits


def run_backtest(df, params: dict, deps: dict, collect_returns: bool = False, collect_meta_labels: bool = False):
    vbt = deps["vbt"]
    pd = deps["pd"]
    if vbt is None or pd is None:
        raise RuntimeError("vectorbt 또는 pandas가 설치되지 않았습니다.")

    close = df["close"]
    tp_pct = params.get("tp_pct", 0.06)
    sl_pct = params.get("sl_pct", 0.03)
    entries, exits = build_signal_masks(df, params, deps)
    portfolio_freq = infer_portfolio_freq(df)
    realistic_costs = bool_env("LUNA_BT_REALISTIC_COSTS", False)
    next_bar_execution = bool_env("LUNA_BT_NEXT_BAR_EXECUTION_ENABLED", False)
    toss_fee_model_enabled = bool_env("LUNA_BT_TOSS_FEE_MODEL_ENABLED", False)
    slippage_pct = float_env("LUNA_BT_SLIPPAGE_PCT", 0.0005)
    from_signals_params = None
    market_calendar = params.get("market_calendar") or df.attrs.get("luna_market_calendar") or "crypto"
    fee_model_info = resolve_toss_fee_model(market_calendar, toss_fee_model_enabled)
    fees = fee_model_info["fee_pct"]
    fee_model = fee_model_info["fee_model"]

    execution_model = "same_bar_close"
    execution_price_model = "close"
    if next_bar_execution:
        entries, exits = apply_next_bar_signal_masks(entries, exits)
        execution_model = "next_bar"

    pf_kwargs = dict(
        close=close,
        entries=entries.fillna(False),
        exits=exits.fillna(False),
        tp_stop=tp_pct,
        sl_stop=sl_pct,
        init_cash=10_000,
        fees=fees,
        freq=portfolio_freq,
    )
    if next_bar_execution:
        from_signals_params = from_signals_param_names(vbt, deps)
        if "price" in from_signals_params and "open" in df.columns:
            pf_kwargs["price"] = df["open"]
            execution_price_model = "next_open"
        else:
            execution_price_model = "next_close"
    if realistic_costs:
        if from_signals_params is None:
            from_signals_params = from_signals_param_names(vbt, deps)
        if "slippage" in from_signals_params:
            pf_kwargs["slippage"] = slippage_pct
        if "high" in from_signals_params and "low" in from_signals_params and "high" in df.columns and "low" in df.columns:
            pf_kwargs["high"] = df["high"]
            pf_kwargs["low"] = df["low"]

    pf = vbt.Portfolio.from_signals(**pf_kwargs)

    stats = pf.stats()

    # OOS returns 분포 통계 — DSR Phase 1b 입력 (skew/kurt). fisher=False = Pearson 정의(정규=3)
    returns_series = None
    try:
        returns_series = pf.returns().fillna(0)
        ret_arr = finite_float_values(returns_series.dropna().values)
        if _scipy_stats is not None and len(ret_arr) >= 4:
            _sk = float(_scipy_stats.skew(ret_arr))
            _kt = float(_scipy_stats.kurtosis(ret_arr, fisher=False))
            oos_returns_skew = _sk if math.isfinite(_sk) else None
            oos_returns_kurt = _kt if math.isfinite(_kt) else None
        else:
            oos_returns_skew = None
            oos_returns_kurt = None
    except Exception:
        oos_returns_skew = None
        oos_returns_kurt = None

    result = {
        "total_return": float(stats.get("Total Return [%]", 0) or 0),
        "sharpe_ratio": float(stats.get("Sharpe Ratio", 0) or 0),
        "max_drawdown": float(stats.get("Max Drawdown [%]", 0) or 0),
        "win_rate": float(stats.get("Win Rate [%]", 0) or 0),
        "total_trades": int(stats.get("Total Trades", 0) or 0),
        "profit_factor": float(stats.get("Profit Factor", 0) or 0),
        "params": {
            **params,
            "portfolio_freq": portfolio_freq,
            "market_calendar": market_calendar,
        },
        "oos_returns_skew": oos_returns_skew,
        "oos_returns_kurt": oos_returns_kurt,
        "costs_model": "realistic" if realistic_costs else "baseline",
        "data_interval": df.attrs.get("luna_data_interval"),
        "execution_model": execution_model,
        "execution_price_model": execution_price_model,
    }
    if toss_fee_model_enabled:
        result["fee_model"] = fee_model
        result["fee_pct"] = fees
    if collect_returns:
        try:
            if returns_series is None:
                returns_series = pf.returns().fillna(0)
            result["returns_series"] = [float(x) if math.isfinite(float(x)) else 0.0 for x in returns_series.tolist()]
            result["returns_index"] = [
                int(ts.timestamp()) if hasattr(ts, "timestamp") else int(index)
                for index, ts in enumerate(returns_series.index)
            ]
        except Exception:
            result["returns_series"] = []
            result["returns_index"] = []
    if collect_meta_labels:
        result.update(compute_meta_labels(pf, deps))
    result["robust_score"] = robust_rank_score(result)
    return result


def resolve_toss_fee_model(market_calendar, enabled: bool = False) -> dict:
    if enabled and str(market_calendar or "").lower() in {"domestic", "kis_domestic", "kr"}:
        return {
            "fee_model": "toss_free",
            "fee_pct": float_env("LUNA_BT_TOSS_DOMESTIC_FEE_PCT", 0.0),
        }
    return {
        "fee_model": "legacy",
        "fee_pct": 0.001,
    }


def safe_float(value, fallback: float = 0.0) -> float:
    try:
        out = float(value)
        return out if math.isfinite(out) else fallback
    except Exception:
        return fallback


def finite_float_values(values) -> list[float]:
    out: list[float] = []
    for value in values or []:
        try:
            number = float(value)
        except Exception:
            continue
        if math.isfinite(number):
            out.append(number)
    return out


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


def bool_env(name: str, default: bool = False) -> bool:
    raw = str(os.environ.get(name, "")).strip().lower()
    if not raw:
        return default
    return raw in {"1", "true", "yes", "on", "enabled", "shadow"}


def int_env(name: str, default: int) -> int:
    try:
        value = int(os.environ.get(name, default))
        return value if value > 0 else default
    except Exception:
        return default


def int_env_any(names: list[str], default: int) -> int:
    for name in names:
        raw = os.environ.get(name)
        if raw is None or str(raw).strip() == "":
            continue
        try:
            value = int(raw)
            return value if value > 0 else default
        except Exception:
            return default
    return default


def float_env(name: str, default: float) -> float:
    try:
        value = float(os.environ.get(name, default))
        return value if math.isfinite(value) else default
    except Exception:
        return default


def _param_signature(params: dict) -> str:
    runtime_keys = {"portfolio_freq", "market_calendar"}
    items = {key: value for key, value in (params or {}).items() if key not in runtime_keys}
    return json.dumps(items, sort_keys=True, default=str)


def select_consensus_params(fold_grids: list, folds_total: int):
    """Select one cross-fold parameter set by median robustness minus dispersion."""
    import statistics

    penalty = float_env("LUNA_BT_CONSENSUS_STD_PENALTY", 0.5)
    min_coverage = max(1, (folds_total + 1) // 2)
    aggregate = {}

    for grid in fold_grids:
        for item in grid:
            sig = _param_signature(item.get("params", {}))
            rec = aggregate.setdefault(sig, {"scores": [], "params": item.get("params", {})})
            rec["scores"].append(safe_float(item.get("robust_score", robust_rank_score(item)), 0.0))

    best_sig = None
    best_key = None
    best_params = None
    for sig, rec in aggregate.items():
        scores = rec["scores"]
        if len(scores) < min_coverage:
            continue
        median_score = statistics.median(scores)
        std_score = statistics.pstdev(scores) if len(scores) >= 2 else 0.0
        key = median_score - penalty * std_score
        if best_key is None or key > best_key:
            best_sig = sig
            best_key = key
            best_params = rec["params"]

    return best_params, best_sig, best_key


def _select_robust_from_grid(is_grid: list):
    """Avoid a single lucky IS peak by selecting the median candidate in top-K."""
    if not is_grid:
        return None
    top_k = min(len(is_grid), int_env("LUNA_BT_ROBUST_TOPK", 5))
    top_grid = is_grid[:top_k]
    return top_grid[len(top_grid) // 2]


def clamp(value: float, lower: float, upper: float) -> float:
    return max(lower, min(upper, value))


def deflated_sharpe(sharpe: float, n_trials: int, total_trades_oos: int) -> float:
    """다중비교 보정 — 거래 수를 독립 정보량의 보수적 근사로 사용한다."""
    if not math.isfinite(sharpe):
        return sharpe
    trials = max(2, int(n_trials or 2))
    trades = max(1, int(total_trades_oos or 1))
    expected_max = math.sqrt(2 * math.log(trials))
    penalty = expected_max / math.sqrt(trades)
    return sharpe - penalty


# --- Phase 1b: 정통 DSR/PSR 산출 (Bailey & López de Prado 2014) ---

def periods_per_year(freq: str, market: str = "crypto") -> float:
    """포트폴리오 주파수 → 연간 주기 수.

    기준: crypto 1d=365(24/7), stock 1d=252(영업일). 비연율화 변환 계수로 사용.
    """
    freq = (freq or "5min").lower().replace(" ", "")
    _map: dict[str, float] = {
        "1min": 525600.0, "1m": 525600.0,
        "5min": 105120.0, "5m": 105120.0,
        "15min": 35040.0, "15m": 35040.0,
        "30min": 17520.0, "30m": 17520.0,
        "1h": 8760.0, "1hour": 8760.0, "60min": 8760.0, "60m": 8760.0,
        "4h": 2190.0, "4hour": 2190.0, "240min": 2190.0, "240m": 2190.0,
        "1d": 365.0 if market == "crypto" else 252.0,
        "1day": 365.0 if market == "crypto" else 252.0,
        "d": 365.0 if market == "crypto" else 252.0,
    }
    return _map.get(freq, 105120.0)  # 매핑 없으면 5m 기본


def expected_max_sharpe(var_sr_unann: float, n_trials: int) -> float:
    """FST 임계 SR — N개 시도 중 무능 전략의 기대 최대 SR (비연율화).

    maxZ = (1-γ)·Φ⁻¹(1-1/N) + γ·Φ⁻¹(1-1/(N·e))    γ=Euler-Mascheroni=0.5772156649
    SR0  = sqrt(var_SR_unann) · maxZ
    """
    if _scipy_stats is None or var_sr_unann is None or not math.isfinite(var_sr_unann) or var_sr_unann <= 0:
        return 0.0
    n = max(2, int(n_trials or 2))
    gamma_em = 0.5772156649
    try:
        z1 = _scipy_stats.norm.ppf(1.0 - 1.0 / n)
        z2 = _scipy_stats.norm.ppf(1.0 - 1.0 / (n * math.e))
        max_z = (1.0 - gamma_em) * z1 + gamma_em * z2
        sr0 = math.sqrt(var_sr_unann) * max_z
        return sr0 if math.isfinite(sr0) else 0.0
    except Exception:
        return 0.0


def probabilistic_sharpe_ratio(
    sr_unann: float, sr0: float, skew, kurt, T: int
) -> "float | None":
    """DSR/PSR 산출 (Bailey & López de Prado 2014).

    DSR = Φ( (SR-SR0)·sqrt(T-1) / sqrt(1 - skew·SR + (kurt-1)/4·SR²) )

    sr_unann: 비연율화 OOS SR.  sr0: FST 임계 SR (PSR시 0.0).
    skew/kurt: Pearson 정의(정규=0/3). T: OOS bars.
    단위 주의: sr_unann·sr0 모두 비연율화(per-period)여야 함.
    """
    if _scipy_stats is None or sr_unann is None or not math.isfinite(sr_unann):
        return None
    if T is None or T < 2:
        return None
    sk = float(skew) if skew is not None and math.isfinite(float(skew)) else 0.0
    kt = float(kurt) if kurt is not None and math.isfinite(float(kurt)) else 3.0
    denom_sq = 1.0 - sk * sr_unann + (kt - 1.0) / 4.0 * sr_unann ** 2
    if denom_sq <= 0.0:
        return None
    try:
        z = (sr_unann - sr0) * math.sqrt(T - 1) / math.sqrt(denom_sq)
        prob = float(_scipy_stats.norm.cdf(z))
        return prob if math.isfinite(prob) else None
    except Exception:
        return None


def check_stability(sharpe_oos: float, total_trades_oos: int, n_obs: int,
                    overfit_gap: float, max_dd_oos: float) -> tuple:
    """OOS 지표 안정성 검사 — 위배 시 ('unstable', [reasons])"""
    min_trades = int_env("LUNA_BT_MIN_TRADES", 10)
    min_bars = int_env("LUNA_BT_MIN_BARS", 60)
    sharpe_cap = float_env("LUNA_BT_SHARPE_REALISTIC_CAP", float_env("LUNA_BT_SHARPE_CAP", 5.0))
    max_overfit_gap = float_env("LUNA_BT_MAX_OVERFIT_GAP", 2.0)
    max_dd_limit = float_env("LUNA_CANDIDATE_BACKTEST_MAX_DRAWDOWN", 30.0)

    reasons = []
    if total_trades_oos < min_trades:
        reasons.append(f"backtest_unstable_sample(oos_trades={total_trades_oos},min={min_trades})")
    if n_obs < min_bars:
        reasons.append(f"backtest_unstable_sample(oos_bars={n_obs},min={min_bars})")
    if abs(sharpe_oos) > sharpe_cap:
        reasons.append(f"unrealistic_sharpe(oos={sharpe_oos:.2f},cap={sharpe_cap})")
    if overfit_gap > max_overfit_gap:
        reasons.append(f"overfit_gap_high({overfit_gap:.2f})")
    if max_dd_oos > max_dd_limit:
        reasons.append(f"drawdown_high(oos={max_dd_oos:.1f}%)")

    return ("unstable" if reasons else "ok"), reasons


def split_is_oos(df, oos_ratio: float = 0.3):
    """시계열 순서 유지 (셔플 금지) — OOS는 항상 뒤 구간"""
    n = len(df)
    cut = max(1, min(n - 1, int(n * (1 - oos_ratio))))
    return df.iloc[:cut], df.iloc[cut:]


def aggregate_oos_result(oos_result: dict, best_is: dict, n_grid_trials: int, n_obs: int,
                         method: str, extra: dict | None = None,
                         trial_sharpes: list | None = None) -> dict:
    """IS 최적화 결과와 OOS 평가 결과를 병합하여 표준 dict를 반환한다.

    trial_sharpes: grid_search의 전체 trial SR 목록 (var_sharpe 계산용, Phase 1b DSR 입력)
    """
    sharpe_is = safe_float(best_is.get("sharpe_ratio"))
    total_trades_oos = int(safe_float(oos_result.get("total_trades")))
    max_dd_oos = abs(safe_float(oos_result.get("max_drawdown")))
    min_oos_trades = int_env("LUNA_BT_MIN_OOS_TRADES", 15)
    min_oos_bars = int_env("LUNA_BT_MIN_OOS_BARS", int_env("LUNA_BT_MIN_BARS", 60))
    raw_sharpe_oos = safe_float(oos_result.get("sharpe_ratio"))

    # var_sharpe: trial SR 분산 (selection bias 측정, DSR Phase 1b 입력)
    _ts = finite_float_values(trial_sharpes or [])
    var_sharpe = (
        float(_np.var(_ts, ddof=1))
        if _np is not None and len(_ts) >= 2
        else None
    )

    # OOS returns 분포 — run_backtest에서 이미 계산됨
    oos_returns_skew = oos_result.get("oos_returns_skew")
    oos_returns_kurt = oos_result.get("oos_returns_kurt")

    # Phase 1b: 비연율화 계수 — oos_result.params에 portfolio_freq 저장됨
    _params = (oos_result.get("params") or best_is.get("params") or {})
    _pf = _params.get("portfolio_freq") or (best_is.get("params") or {}).get("portfolio_freq", "5min")
    _market = _params.get("market_calendar") or (extra or {}).get("market", "crypto")
    ppy = periods_per_year(_pf, _market)  # periods per year (비연율화 변환 계수)

    if total_trades_oos < min_oos_trades or n_obs < min_oos_bars:
        sharpe_oos = None
        overfit_gap = None
        sharpe_oos_def = None
        oos_status = "insufficient_data"
        oos_reasons = [f"insufficient_oos_sample(trades={total_trades_oos},bars={n_obs})"]
        # Phase 1b: insufficient_data 시 DSR 필드 None
        dsr = psr = sr0 = sr_oos_unann = None
    else:
        sharpe_oos = raw_sharpe_oos
        overfit_gap = sharpe_is - sharpe_oos
        sharpe_oos_def = deflated_sharpe(sharpe_oos, n_grid_trials, total_trades_oos)
        oos_status, oos_reasons = check_stability(sharpe_oos, total_trades_oos, n_obs, overfit_gap, max_dd_oos)
        realistic_cap = float_env("LUNA_BT_SHARPE_REALISTIC_CAP", 4.0)
        if abs(sharpe_oos_def) > realistic_cap:
            oos_reasons.append(f"sharpe_out_of_realistic_range(val={sharpe_oos_def:.2f},cap={realistic_cap})")
            sharpe_oos_def = clamp(sharpe_oos_def, -realistic_cap, realistic_cap)
            oos_status = "unstable"

        # Phase 1b: 비연율화 변환 후 정통 DSR/PSR 산출
        # sr_unann = sr_ann / sqrt(ppy),  var_unann = var_ann / ppy
        sr_oos_unann = sharpe_oos / math.sqrt(ppy) if math.isfinite(sharpe_oos) else None
        var_sr_unann = (var_sharpe / ppy) if var_sharpe is not None and math.isfinite(var_sharpe) else None
        sr0 = expected_max_sharpe(var_sr_unann, n_grid_trials)
        dsr = probabilistic_sharpe_ratio(sr_oos_unann, sr0, oos_returns_skew, oos_returns_kurt, n_obs)
        psr = probabilistic_sharpe_ratio(sr_oos_unann, 0.0, oos_returns_skew, oos_returns_kurt, n_obs)

    payload = {
        **oos_result,
        "sharpe_ratio": sharpe_oos,
        "sharpe_is": sharpe_is,
        "sharpe_oos": sharpe_oos,
        "sharpe_oos_deflated": sharpe_oos_def,
        "overfit_gap": overfit_gap,
        "n_grid_trials": n_grid_trials,
        "n_obs_oos": n_obs,
        "total_trades_oos": total_trades_oos,
        "walk_forward_sharpe": None,
        "selection_method": method,
        "oos_status": oos_status,
        "oos_reasons": oos_reasons,
        "gate_status": "unstable" if oos_reasons else "ok",
        "reasons": oos_reasons,
        "params": best_is.get("params", oos_result.get("params", {})),
        # Phase 1a: DSR 입력 데이터
        "trial_sharpes": _ts,
        "var_sharpe": var_sharpe,
        "oos_returns_skew": oos_returns_skew,
        "oos_returns_kurt": oos_returns_kurt,
        "oos_bars": n_obs,  # T — OOS 관측 수 (n_obs_oos의 명시적 DSR alias)
        # Phase 1b: 정통 DSR/PSR (SHADOW — 기존 deflated_sharpe/healthy/gate_status 불변)
        "dsr": dsr,
        "psr": psr,
        "sr0": sr0,
        "sr_oos_unann": sr_oos_unann if (total_trades_oos >= min_oos_trades and n_obs >= min_oos_bars) else None,
        "periods_per_year": ppy,
        "execution_model": oos_result.get("execution_model"),
        "execution_price_model": oos_result.get("execution_price_model"),
    }
    if extra:
        payload.update(extra)
    payload["robust_score"] = robust_rank_score(payload)
    return payload


def select_on_is_evaluate_on_oos(df, deps: dict):
    """IS(앞 70%)에서 grid 최적화 → OOS(뒤 30%)에서 독립 평가 (과적합 차단)"""
    oos_ratio = float_env("LUNA_BT_OOS_RATIO", 0.3)
    is_df, oos_df = split_is_oos(df, oos_ratio)

    if len(is_df) < 30 or len(oos_df) < 10:
        return None

    is_grid = grid_search(is_df, deps)
    n_grid_trials = is_grid[0].get('n_grid_trials', 0) if is_grid else 0
    if not is_grid:
        return None

    robust_on = bool_env("LUNA_BT_ROBUST_SELECTION_ENABLED", False)
    best_is = _select_robust_from_grid(is_grid) if robust_on else is_grid[0]
    if not best_is:
        return None
    try:
        oos_result = run_backtest(oos_df, best_is['params'], deps)
    except Exception:
        return None

    # IS grid의 전체 trial SR 목록 (var_sharpe 계산용)
    trial_sharpes = [r.get("sharpe_ratio", 0) for r in is_grid]

    return aggregate_oos_result(
        oos_result,
        best_is,
        n_grid_trials,
        len(oos_df),
        "is_oos_split",
        {
            "is_bars": len(is_df),
            "oos_bars": len(oos_df),
            **({"selection_strategy": "split_robust"} if robust_on else {}),
        },
        trial_sharpes=trial_sharpes,
    )


def infer_rows_for_days(df, days: int) -> int:
    try:
        if df is None or len(df.index) < 2:
            return max(1, days)
        span_seconds = (df.index[-1] - df.index[0]).total_seconds()
        span_days = span_seconds / 86400.0
        if span_days >= 7:
            # Market-hour data (for example US/KR 1h bars) has overnight/weekend gaps.
            # Use observed rows per calendar day instead of assuming 24h continuous bars.
            rows_per_day = len(df) / max(1.0, span_days)
            return max(1, int(days * rows_per_day))
        deltas = df.index.to_series().diff().dropna().dt.total_seconds()
        median_seconds = float(deltas.median()) if not deltas.empty else 86400.0
        return max(1, int((days * 86400) / max(1.0, median_seconds)))
    except Exception:
        return max(1, days)


def walk_forward(df, deps: dict, folds: int = 5, train_days: int = 60, test_days: int = 60):
    """Rolling walk-forward: fold OOS 거래를 풀링하여 저빈도 전략도 평가 가능하게 한다.

    저빈도 전략(주식 1d)은 단일 fold에서 거래 ~8건으로 insufficient_data가 됨.
    fold 5개를 누적하면 OOS ~300일로 v2 소표본 기준(15건)을 넘길 가능성을 높인다.
    v2 거부/deflation/클램프는 풀 집계값에 1회만 적용한다.
    """
    train_rows = infer_rows_for_days(df, train_days)
    test_rows = infer_rows_for_days(df, test_days)
    min_window = train_rows + test_rows
    if len(df) < min_window or train_rows < 30 or test_rows < 10:
        return None

    windows = []
    start = 0
    while start + min_window <= len(df):
        train_start = start
        train_end = train_start + train_rows
        test_end = train_end + test_rows
        windows.append((train_start, train_end, test_end))
        start += test_rows
    windows = windows[-max(1, folds):]

    # Phase 1-1: fold별 raw 수집 (거부 없이)
    fold_raw = []
    n_trials_max = 0
    # 대표 trial SR 목록: 전체 fold의 valid grid trial SR을 fold 순으로 축적
    # (var_sharpe = selection bias 측정용, DSR Phase 1b 입력)
    all_trial_sharpes: list[float] = []
    robust_on = bool_env("LUNA_BT_ROBUST_SELECTION_ENABLED", False)
    pooled_returns_on = bool_env("LUNA_BT_POOLED_RETURNS_SHARPE", False)
    consensus_sig = None
    consensus_fold_coverage = None

    if robust_on:
        fold_grids = []
        fold_windows_kept = []
        for fold_index, (train_start, train_end, test_end) in enumerate(windows, start=1):
            train_df = df.iloc[train_start:train_end]
            grid = grid_search(train_df, deps)
            if not grid:
                continue
            n_trials_fold = grid[0].get("n_grid_trials", len(grid))
            n_trials_max = max(n_trials_max, n_trials_fold)
            all_trial_sharpes.extend(safe_float(r.get("sharpe_ratio"), 0.0) for r in grid)
            fold_grids.append(grid)
            fold_windows_kept.append((fold_index, train_start, train_end, test_end, grid))

        consensus_params, consensus_sig, _ = select_consensus_params(fold_grids, len(windows))
        if not consensus_params or not consensus_sig:
            return None
        consensus_fold_coverage = sum(
            1
            for grid in fold_grids
            if any(_param_signature(item.get("params", {})) == consensus_sig for item in grid)
        )

        for fold_index, train_start, train_end, test_end, grid in fold_windows_kept:
            test_df = df.iloc[train_end:test_end]
            is_entry = next(
                (item for item in grid if _param_signature(item.get("params", {})) == consensus_sig),
                None,
            )
            n_trials_fold = (is_entry or grid[0]).get("n_grid_trials", len(grid))
            try:
                oos_raw = run_backtest(test_df, consensus_params, deps, collect_returns=pooled_returns_on)
            except Exception as exc:
                fold_raw.append({"fold": fold_index, "error": str(exc)})
                continue
            fold_entry = {
                "fold": fold_index,
                "train_bars": train_end - train_start,
                "test_bars": len(test_df),
                "sharpe_oos_fold": safe_float(oos_raw.get("sharpe_ratio")),
                "trades_fold": int(safe_float(oos_raw.get("total_trades"))),
                "n_obs_fold": len(test_df),
                "ret_fold": safe_float(oos_raw.get("total_return")),
                "dd_fold": abs(safe_float(oos_raw.get("max_drawdown"))),
                "win_fold": safe_float(oos_raw.get("win_rate")),
                "pf_fold": safe_float(oos_raw.get("profit_factor")),
                "sharpe_is_fold": safe_float((is_entry or {}).get("sharpe_ratio")),
                "n_grid_trials_fold": n_trials_fold,
                "params": consensus_params,
                "consensus_param_signature": consensus_sig,
                # Phase 1a: fold별 OOS returns 분포 (거래수 가중 평균 집계용)
                "oos_returns_skew": oos_raw.get("oos_returns_skew"),
                "oos_returns_kurt": oos_raw.get("oos_returns_kurt"),
                "execution_model": oos_raw.get("execution_model"),
                "execution_price_model": oos_raw.get("execution_price_model"),
            }
            if pooled_returns_on:
                fold_entry["returns_series_fold"] = oos_raw.get("returns_series") or []
            fold_raw.append(fold_entry)
    else:
        for fold_index, (train_start, train_end, test_end) in enumerate(windows, start=1):
            train_df = df.iloc[train_start:train_end]
            test_df = df.iloc[train_end:test_end]
            grid = grid_search(train_df, deps)
            if not grid:
                continue
            best_is = grid[0]
            n_trials_fold = best_is.get("n_grid_trials", len(grid))
            n_trials_max = max(n_trials_max, n_trials_fold)
            # grid는 이미 error 제거 후 반환 — 전체 SR 수집 (var_sharpe 계산용)
            all_trial_sharpes.extend(safe_float(r.get("sharpe_ratio"), 0.0) for r in grid)
            try:
                oos_raw = run_backtest(test_df, best_is["params"], deps, collect_returns=pooled_returns_on)
            except Exception as exc:
                fold_raw.append({"fold": fold_index, "error": str(exc)})
                continue
            fold_entry = {
                "fold": fold_index,
                "train_bars": len(train_df),
                "test_bars": len(test_df),
                "sharpe_oos_fold": safe_float(oos_raw.get("sharpe_ratio")),
                "trades_fold": int(safe_float(oos_raw.get("total_trades"))),
                "n_obs_fold": len(test_df),
                "ret_fold": safe_float(oos_raw.get("total_return")),
                "dd_fold": abs(safe_float(oos_raw.get("max_drawdown"))),
                "win_fold": safe_float(oos_raw.get("win_rate")),
                "pf_fold": safe_float(oos_raw.get("profit_factor")),
                "sharpe_is_fold": safe_float(best_is.get("sharpe_ratio")),
                "n_grid_trials_fold": n_trials_fold,
                "params": best_is.get("params", {}),
                # Phase 1a: fold별 OOS returns 분포 (거래수 가중 평균 집계용)
                "oos_returns_skew": oos_raw.get("oos_returns_skew"),
                "oos_returns_kurt": oos_raw.get("oos_returns_kurt"),
                "execution_model": oos_raw.get("execution_model"),
                "execution_price_model": oos_raw.get("execution_price_model"),
            }
            if pooled_returns_on:
                fold_entry["returns_series_fold"] = oos_raw.get("returns_series") or []
            fold_raw.append(fold_entry)

    usable = [f for f in fold_raw if "error" not in f]
    if not usable:
        return None

    # Phase 1-2: 풀 집계 — 합계 거래수 기준
    pooled_trades = sum(f["trades_fold"] for f in usable)
    pooled_bars = sum(f["n_obs_fold"] for f in usable)
    # 거래수 가중 평균: 저거래 fold의 과대표집 방지
    total_w = max(1, pooled_trades)
    pooled_sharpe_oos = sum(f["sharpe_oos_fold"] * f["trades_fold"] for f in usable) / total_w
    pooled_sharpe_is = sum(f["sharpe_is_fold"] * f["trades_fold"] for f in usable) / total_w
    pooled_win = sum(f["win_fold"] * f["trades_fold"] for f in usable) / total_w
    pooled_pf = sum(f["pf_fold"] * f["trades_fold"] for f in usable) / total_w
    pooled_max_dd = max(f["dd_fold"] for f in usable)
    pooled_return = sum(f["ret_fold"] for f in usable) / len(usable)
    _wf_params = usable[0].get("params") or {}
    _wf_pf = _wf_params.get("portfolio_freq", "5min")
    _wf_market = _wf_params.get("market_calendar", "crypto")
    wf_ppy = periods_per_year(_wf_pf, _wf_market)
    if pooled_returns_on:
        all_oos_returns = []
        for fold in usable:
            all_oos_returns.extend(fold.get("returns_series_fold") or [])
        ret = finite_float_values(all_oos_returns)
        if len(ret) >= 2:
            import statistics

            mu = statistics.fmean(ret)
            sd = statistics.stdev(ret)
            pooled_sharpe_oos = (mu / sd) * math.sqrt(wf_ppy) if sd > 0 else 0.0
        else:
            pooled_sharpe_oos = 0.0
        # IS는 기존 거래수 가중 평균을 유지한다. 따라서 overfit_gap은
        # weighted IS - concatenated OOS로 비대칭이지만, OOS 왜곡 제거를 우선한다.
    overfit_gap = pooled_sharpe_is - pooled_sharpe_oos
    # grid trials: max 사용 (더 보수적인 deflation penalty)
    n_trials = max(2, n_trials_max)

    # Phase 1-3: v2 안전장치를 풀 집계값에 1회 적용
    min_oos_trades = int_env("LUNA_BT_MIN_OOS_TRADES", 15)
    min_oos_bars = int_env("LUNA_BT_MIN_OOS_BARS", int_env("LUNA_BT_MIN_BARS", 60))
    realistic_cap = float_env("LUNA_BT_SHARPE_REALISTIC_CAP", 4.0)

    oos_reasons = []
    if pooled_trades < min_oos_trades or pooled_bars < min_oos_bars:
        oos_status = "insufficient_data"
        oos_reasons = [f"insufficient_oos_sample(trades={pooled_trades},bars={pooled_bars})"]
        sharpe_oos_deflated = None
        sharpe_oos_out = None
        overfit_gap_out = None
    else:
        sharpe_oos_out = pooled_sharpe_oos
        overfit_gap_out = overfit_gap
        sharpe_oos_deflated = deflated_sharpe(pooled_sharpe_oos, n_trials, pooled_trades)
        _, stability_reasons = check_stability(
            pooled_sharpe_oos, pooled_trades, pooled_bars, overfit_gap, pooled_max_dd
        )
        oos_reasons = stability_reasons
        if abs(sharpe_oos_deflated) > realistic_cap:
            oos_reasons.append(
                f"sharpe_out_of_realistic_range(val={sharpe_oos_deflated:.2f},cap={realistic_cap})"
            )
            sharpe_oos_deflated = clamp(sharpe_oos_deflated, -realistic_cap, realistic_cap)
        oos_status = "unstable" if oos_reasons else "ok"

    # Phase 1a: DSR 입력 집계
    # var_sharpe: 전체 fold grid trial SR의 표본 분산 (ddof=1, 불편 추정)
    var_sharpe = (
        float(_np.var(all_trial_sharpes, ddof=1))
        if _np is not None and len(all_trial_sharpes) >= 2
        else None
    )
    # OOS returns 분포: 기본은 기존 거래수 가중 평균, pooled-return Sharpe 경로는 연결 returns 직접 통계.
    if pooled_returns_on:
        if _scipy_stats is not None and "ret" in locals() and len(ret) >= 4:
            _sk = float(_scipy_stats.skew(ret))
            _kt = float(_scipy_stats.kurtosis(ret, fisher=False))
            pooled_oos_skew = _sk if math.isfinite(_sk) else None
            pooled_oos_kurt = _kt if math.isfinite(_kt) else None
        else:
            pooled_oos_skew = None
            pooled_oos_kurt = None
    else:
        _skew_data = [(f["oos_returns_skew"], f["trades_fold"]) for f in usable if f.get("oos_returns_skew") is not None]
        _kurt_data = [(f["oos_returns_kurt"], f["trades_fold"]) for f in usable if f.get("oos_returns_kurt") is not None]
        pooled_oos_skew = (
            sum(s * w for s, w in _skew_data) / max(1, sum(w for _, w in _skew_data))
            if _skew_data else None
        )
        pooled_oos_kurt = (
            sum(k * w for k, w in _kurt_data) / max(1, sum(w for _, w in _kurt_data))
            if _kurt_data else None
        )

    if oos_status == "insufficient_data":
        wf_dsr = wf_psr = wf_sr0 = wf_sr_oos_unann = None
    else:
        # sr_unann = sr_ann / sqrt(ppy),  var_unann = var_ann / ppy
        wf_sr_oos_unann = sharpe_oos_out / math.sqrt(wf_ppy) if sharpe_oos_out is not None and math.isfinite(sharpe_oos_out) else None
        wf_var_sr_unann = (var_sharpe / wf_ppy) if var_sharpe is not None and math.isfinite(var_sharpe) else None
        wf_sr0 = expected_max_sharpe(wf_var_sr_unann, n_trials)
        wf_dsr = probabilistic_sharpe_ratio(wf_sr_oos_unann, wf_sr0, pooled_oos_skew, pooled_oos_kurt, pooled_bars)
        wf_psr = probabilistic_sharpe_ratio(wf_sr_oos_unann, 0.0, pooled_oos_skew, pooled_oos_kurt, pooled_bars)
        wf_sr0 = wf_sr0  # sr0 보존 (insufficient 아닐 때만)

    aggregate = {
        "status": oos_status,
        "selection_method": "walk_forward",
        "sharpe_ratio": sharpe_oos_out if oos_status != "insufficient_data" else None,
        "sharpe_is": pooled_sharpe_is,
        "sharpe_oos": sharpe_oos_out,
        "sharpe_oos_deflated": sharpe_oos_deflated,
        "overfit_gap": overfit_gap_out,
        "walk_forward_sharpe": sharpe_oos_out,
        "total_return": pooled_return,
        "max_drawdown": pooled_max_dd,
        "win_rate": pooled_win,
        "profit_factor": pooled_pf,
        "total_trades": pooled_trades,
        "n_grid_trials": n_trials,
        "n_obs_oos": pooled_bars,
        "total_trades_oos": pooled_trades,
        "fold_count": len(usable),
        "folds": fold_raw,
        "params": {
            "walk_forward_train_days": train_days,
            "walk_forward_test_days": test_days,
            "folds": len(usable),
            "portfolio_freq": _wf_pf,
            "market_calendar": _wf_market,
        },
        "oos_status": oos_status,
        "oos_reasons": oos_reasons,
        "gate_status": "unstable" if oos_reasons else "ok",
        "reasons": oos_reasons,
        # Phase 1a: DSR 입력 데이터
        "trial_sharpes": all_trial_sharpes,
        "var_sharpe": var_sharpe,
        "oos_returns_skew": pooled_oos_skew,
        "oos_returns_kurt": pooled_oos_kurt,
        "oos_bars": pooled_bars,  # T — n_obs_oos의 명시적 DSR alias
        # Phase 1b: 정통 DSR/PSR (SHADOW — 기존 deflated_sharpe/healthy/gate_status 불변)
        "dsr": wf_dsr,
        "psr": wf_psr,
        "sr0": wf_sr0 if oos_status != "insufficient_data" else None,
        "sr_oos_unann": wf_sr_oos_unann,
        "periods_per_year": wf_ppy,
        "costs_model": "realistic" if bool_env("LUNA_BT_REALISTIC_COSTS", False) else "baseline",
        "data_interval": df.attrs.get("luna_data_interval"),
        "execution_model": usable[0].get("execution_model"),
        "execution_price_model": usable[0].get("execution_price_model"),
    }
    if robust_on:
        aggregate.update({
            "selection_strategy": "consensus",
            "consensus_fold_coverage": consensus_fold_coverage,
            "consensus_param_signature": consensus_sig,
        })
    aggregate["robust_score"] = robust_rank_score(aggregate)
    return aggregate


def build_grid_params() -> list[dict]:
    """백테스트 파라미터 그리드. grid_search와 CPCV/PBO가 동일 그리드를 공유한다."""
    params_list: list[dict] = []
    coarse = bool_env("LUNA_BT_GRID_COARSE", False)
    rsi_periods = [14, 20] if coarse else [10, 14, 20]
    macd_configs = [
        {"macd_fast": 12, "macd_slow": 26, "macd_signal": 9},
        {"macd_fast": 8, "macd_slow": 21, "macd_signal": 5},
        {"macd_fast": 5, "macd_slow": 13, "macd_signal": 3},
    ]
    sl_pcts = [0.03, 0.05] if coarse else [0.02, 0.03, 0.05]
    tp_pcts = [0.06, 0.08] if coarse else [0.04, 0.06, 0.08]

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
                    params_list.append(params)

    for ema_cfg in [
        {"ema_fast": 8, "ema_slow": 34},
        {"ema_fast": 12, "ema_slow": 48},
        {"ema_fast": 21, "ema_slow": 72},
    ]:
        for rsi_band in [
            {"rsi_min": 38, "rsi_max": 70},
            {"rsi_min": 45, "rsi_max": 78},
        ]:
            trend_pairs = [(0.035, 0.075), (0.05, 0.10)] if coarse else [(0.025, 0.05), (0.035, 0.075), (0.05, 0.10)]
            for sl_pct, tp_pct in trend_pairs:
                params = {
                    "strategy": "ema_trend_pullback",
                    "rsi_period": 14,
                    "rsi_exit": 82,
                    "sl_pct": sl_pct,
                    "tp_pct": tp_pct,
                    **ema_cfg,
                    **rsi_band,
                }
                params_list.append(params)

    for breakout_window in [24, 48, 96]:
        for volume_mult in [1.0, 1.25]:
            breakout_pairs = [(0.04, 0.08), (0.06, 0.12)] if coarse else [(0.025, 0.05), (0.04, 0.08), (0.06, 0.12)]
            for sl_pct, tp_pct in breakout_pairs:
                params = {
                    "strategy": "breakout_momentum",
                    "breakout_window": breakout_window,
                    "ema_window": max(48, breakout_window),
                    "volume_mult": volume_mult,
                    "sl_pct": sl_pct,
                    "tp_pct": tp_pct,
                }
                params_list.append(params)

    for bb_window in [20, 40]:
        for rsi_oversold in [28, 34]:
            bb_pairs = [(0.03, 0.06), (0.05, 0.09)] if coarse else [(0.02, 0.04), (0.03, 0.06), (0.05, 0.09)]
            for sl_pct, tp_pct in bb_pairs:
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
                params_list.append(params)

    return params_list


def grid_search(df, deps: dict):
    results = []
    for params in build_grid_params():
        try:
            results.append(run_backtest(df, params, deps))
        except Exception as exc:
            results.append({
                "error": str(exc),
                "params": params,
            })

    n_total = len(results)
    results = [item for item in results if "error" not in item]
    results.sort(
        key=lambda item: (
            item.get("robust_score", robust_rank_score(item)),
            item.get("sharpe_ratio", 0),
        ),
        reverse=True,
    )
    for item in results:
        item['n_grid_trials'] = n_total
        item.setdefault('sharpe_is', item.get('sharpe_ratio'))
        item.setdefault('sharpe_oos', None)
        item.setdefault('sharpe_oos_deflated', None)
        item.setdefault('overfit_gap', None)
        item.setdefault('oos_status', None)
        item.setdefault('oos_reasons', [])
    return results


def _pbo_none(status: str, reasons: list[str], n_blocks: int, n_trials: int = 0, n_combinations: int = 0) -> dict:
    return {
        "pbo": None,
        "perf_degradation": None,
        "prob_loss": None,
        "dominance_first_order": None,
        "pbo_n_blocks": n_blocks,
        "pbo_n_combinations": n_combinations,
        "pbo_n_trials": n_trials,
        "pbo_status": status,
        "pbo_reasons": reasons,
    }


def _safe_sr(values) -> float:
    if _np is None:
        return 0.0
    arr = _np.asarray(values, dtype=float)
    if arr.size == 0:
        return 0.0
    mean = float(_np.mean(arr))
    std = float(_np.std(arr, ddof=1)) if arr.size >= 2 else 0.0
    if not math.isfinite(mean) or not math.isfinite(std) or std <= 0.0:
        return 0.0
    sr = mean / std
    return sr if math.isfinite(sr) else 0.0


def _rank_high_is_better(values, selected_index: int) -> float:
    selected = float(values[selected_index])
    less = sum(1 for value in values if float(value) < selected)
    equal = sum(1 for value in values if float(value) == selected)
    return less + (equal + 1.0) / 2.0


def compute_pbo_from_returns_matrix(returns_matrix, n_blocks: int, min_trials: int) -> dict:
    """CSCV/PBO 핵심 계산. 행=시점, 열=trial."""
    if _np is None:
        return _pbo_none("dependency_missing", ["numpy_missing"], n_blocks)
    try:
        matrix = _np.asarray(returns_matrix, dtype=float)
    except Exception as exc:
        return _pbo_none("error", [f"matrix_parse_error({exc})"], n_blocks)

    if matrix.ndim != 2:
        return _pbo_none("insufficient", [f"invalid_matrix_shape({matrix.shape})"], n_blocks)

    rows, trials = matrix.shape
    if trials < min_trials or rows < n_blocks:
        return _pbo_none(
            "insufficient",
            [f"trials={trials},bars={rows},min_trials={min_trials},n_blocks={n_blocks}"],
            n_blocks,
            trials,
        )

    block_len = rows // n_blocks
    if block_len <= 0:
        return _pbo_none("insufficient", [f"block_len={block_len},bars={rows},n_blocks={n_blocks}"], n_blocks, trials)

    usable_rows = block_len * n_blocks
    matrix = matrix[:usable_rows, :]
    blocks = [matrix[i * block_len:(i + 1) * block_len, :] for i in range(n_blocks)]
    block_sums = _np.asarray([_np.sum(block, axis=0) for block in blocks], dtype=float)
    block_sumsq = _np.asarray([_np.sum(block * block, axis=0) for block in blocks], dtype=float)
    combos = list(itertools.combinations(range(n_blocks), n_blocks // 2))
    if not combos:
        return _pbo_none("insufficient", [f"combinations=0,n_blocks={n_blocks}"], n_blocks, trials)

    lambdas: list[float] = []
    selected_is_sr: list[float] = []
    selected_oos_sr: list[float] = []
    oos_mean_sr_by_combo: list[float] = []
    eps = float_env("LUNA_PBO_RANK_EPSILON", 1e-6)

    def sr_from_block_indices(indices) -> "_np.ndarray":
        count = block_len * len(indices)
        if count < 2:
            return _np.zeros(trials, dtype=float)
        sums = _np.sum(block_sums[list(indices)], axis=0)
        sumsq = _np.sum(block_sumsq[list(indices)], axis=0)
        means = sums / count
        variances = (sumsq - (sums * sums) / count) / (count - 1)
        variances = _np.where(_np.isfinite(variances) & (variances > 0.0), variances, _np.nan)
        stds = _np.sqrt(variances)
        sr = _np.divide(means, stds, out=_np.zeros_like(means, dtype=float), where=_np.isfinite(stds) & (stds > 0.0))
        return _np.where(_np.isfinite(sr), sr, 0.0)

    for combo in combos:
        is_set = set(combo)
        is_indices = [index for index in range(n_blocks) if index in is_set]
        oos_indices = [index for index in range(n_blocks) if index not in is_set]
        if not is_indices or not oos_indices:
            continue
        is_sr_arr = sr_from_block_indices(is_indices)
        oos_sr_arr = sr_from_block_indices(oos_indices)
        oos_sr = [float(value) for value in oos_sr_arr.tolist()]
        selected = int(_np.argmax(is_sr_arr))
        rank = _rank_high_is_better(oos_sr, selected)
        omega = clamp(rank / (trials + 1.0), eps, 1.0 - eps)
        lambdas.append(math.log(omega / (1.0 - omega)))
        selected_is_sr.append(float(is_sr_arr[selected]))
        selected_oos_sr.append(float(oos_sr[selected]))
        oos_mean_sr_by_combo.append(float(_np.mean(oos_sr_arr)))

    combinations = len(lambdas)
    if combinations == 0:
        return _pbo_none("insufficient", [f"usable_combinations=0,n_blocks={n_blocks}"], n_blocks, trials)

    pbo = sum(1 for value in lambdas if value <= 0.0) / combinations
    prob_loss = sum(1 for value in selected_oos_sr if value < 0.0) / combinations
    perf_degradation = None
    if len(selected_is_sr) >= 2 and len(set(round(value, 12) for value in selected_is_sr)) >= 2:
        try:
            slope = float(_np.polyfit(selected_is_sr, selected_oos_sr, 1)[0])
            perf_degradation = slope if math.isfinite(slope) else None
        except Exception:
            perf_degradation = None
    dominance_first_order = bool(float(_np.mean(selected_oos_sr)) > float(_np.mean(oos_mean_sr_by_combo)))

    return {
        "pbo": float(pbo),
        "perf_degradation": perf_degradation,
        "prob_loss": float(prob_loss),
        "dominance_first_order": dominance_first_order,
        "pbo_n_blocks": n_blocks,
        "pbo_n_combinations": combinations,
        "pbo_n_trials": trials,
        "pbo_status": "ok",
        "pbo_reasons": [],
    }


def compute_pbo_cscv(df, deps: dict) -> dict:
    """Combinatorial Symmetric Cross-Validation 기반 PBO 기록용 SHADOW 지표."""
    n_blocks = int_env("LUNA_PBO_N_BLOCKS", 16)
    min_trials = int_env("LUNA_PBO_MIN_TRIALS", 10)
    if _np is None:
        return _pbo_none("dependency_missing", ["numpy_missing"], n_blocks)

    trial_rows = []
    for params in build_grid_params():
        try:
            result = run_backtest(df, params, deps, collect_returns=True)
        except Exception:
            continue
        returns_series = result.get("returns_series") or []
        returns_index = result.get("returns_index") or []
        if not returns_series or not returns_index or len(returns_series) != len(returns_index):
            continue
        trial_rows.append({
            "params": params,
            "returns_series": returns_series,
            "returns_index": returns_index,
        })

    if len(trial_rows) < min_trials:
        return _pbo_none(
            "insufficient",
            [f"trials={len(trial_rows)},bars=0,min_trials={min_trials},n_blocks={n_blocks}"],
            n_blocks,
            len(trial_rows),
        )

    timeline = sorted({int(ts) for row in trial_rows for ts in row["returns_index"]})
    if len(timeline) < n_blocks:
        return _pbo_none(
            "insufficient",
            [f"trials={len(trial_rows)},bars={len(timeline)},min_trials={min_trials},n_blocks={n_blocks}"],
            n_blocks,
            len(trial_rows),
        )

    rows = []
    for ts in timeline:
        values = []
        for trial in trial_rows:
            mapping = trial.get("_return_map")
            if mapping is None:
                mapping = {int(index): float(value) for index, value in zip(trial["returns_index"], trial["returns_series"])}
                trial["_return_map"] = mapping
            values.append(float(mapping.get(ts, 0.0)))
        rows.append(values)

    return compute_pbo_from_returns_matrix(rows, n_blocks=n_blocks, min_trials=min_trials)


def _meta_label_none(method: str, reasons: list[str], n_trades: int = 0) -> dict:
    return {
        "meta_label_dist": None,
        "meta_label_pos_rate": None,
        "meta_label_n_trades": n_trades,
        "meta_label_method": method,
        "meta_label_status": "insufficient" if n_trades == 0 else "error",
        "meta_label_reasons": reasons,
    }


def compute_meta_label_distribution_from_returns(returns, method: str | None = None, neutral_eps: float | None = None) -> dict:
    """거래별 Return 부호 기반 triple-barrier meta-label 분포.

    Stage 1은 방법 A만 지원한다: ret > eps = +1, ret < -eps = -1, 그 외 0.
    """
    label_method = str(method or os.environ.get("LUNA_META_LABEL_METHOD", "A")).strip().upper() or "A"
    if label_method != "A":
        return _meta_label_none(label_method, [f"unsupported_meta_label_method({label_method})"])

    eps = neutral_eps if neutral_eps is not None else float_env("LUNA_META_LABEL_NEUTRAL_EPS", 0.0)
    values = []
    iterable = [] if returns is None else returns
    for value in iterable:
        try:
            out = float(value)
        except Exception:
            continue
        if math.isfinite(out):
            values.append(out)

    if not values:
        return _meta_label_none(label_method, ["meta_label_no_trades"], 0)

    pos = sum(1 for value in values if value > eps)
    neg = sum(1 for value in values if value < -eps)
    neutral = len(values) - pos - neg
    total = len(values)
    pos_rate = pos / total if total > 0 else None
    dist = {
        "pos": pos,
        "neg": neg,
        "neutral": neutral,
        "total": total,
        "pos_rate": pos_rate,
    }
    return {
        "meta_label_dist": dist,
        "meta_label_pos_rate": pos_rate,
        "meta_label_n_trades": total,
        "meta_label_method": label_method,
        "meta_label_status": "ok",
        "meta_label_reasons": [],
    }


def _extract_trade_returns(pf) -> list[float]:
    candidates = []
    try:
        candidates.append(pf.trades.returns)
    except Exception:
        pass
    try:
        readable = pf.trades.records_readable
        readable = readable() if callable(readable) else readable
        for column in ["Return", "Return [%]", "return", "return_pct"]:
            if hasattr(readable, "columns") and column in readable.columns:
                candidates.append(readable[column])
                break
    except Exception:
        pass

    for raw in candidates:
        try:
            value = raw() if callable(raw) else raw
            if hasattr(value, "dropna"):
                value = value.dropna()
            if hasattr(value, "to_numpy"):
                values = value.to_numpy()
            elif hasattr(value, "values"):
                values = value.values
            else:
                values = value
            output = []
            for item in values:
                try:
                    number = float(item)
                except Exception:
                    continue
                if math.isfinite(number):
                    output.append(number)
            if output:
                return output
        except Exception:
            continue
    return []


def compute_meta_labels(pf, deps: dict) -> dict:
    """vectorbt Portfolio trades Return 기반 meta-label 분포 산출."""
    method = str(os.environ.get("LUNA_META_LABEL_METHOD", "A")).strip().upper() or "A"
    try:
        trade_returns = _extract_trade_returns(pf)
        return compute_meta_label_distribution_from_returns(trade_returns, method=method)
    except Exception as exc:
        return _meta_label_none(method, [f"meta_label_error({exc})"])


def _run_dry_test_meta_labels(as_json: bool = False) -> int:
    """합성 거래 결과로 triple-barrier 라벨 산출 결정성 + ε 경계 정확성 검증."""
    failures: list[str] = []

    def check(case: str, got, expected):
        if got != expected:
            failures.append(f"{case}: got={got!r} expected={expected!r}")

    # 기본 eps=0.0 분포
    d = compute_meta_label_distribution_from_returns([0.05, -0.02, 0.001, 0.0, -0.05, 0.03], neutral_eps=0.0)
    dist = d.get("meta_label_dist") or {}
    check("eps0.pos", dist.get("pos"), 3)
    check("eps0.neg", dist.get("neg"), 2)
    check("eps0.neutral", dist.get("neutral"), 1)
    check("eps0.total", dist.get("total"), 6)
    check("eps0.status", d.get("meta_label_status"), "ok")

    # ε=0.005 경계: 0.001·-0.001·0.0 전부 neutral
    d2 = compute_meta_label_distribution_from_returns([0.001, -0.001, 0.0], neutral_eps=0.005)
    dist2 = d2.get("meta_label_dist") or {}
    check("eps5.pos", dist2.get("pos"), 0)
    check("eps5.neg", dist2.get("neg"), 0)
    check("eps5.neutral", dist2.get("neutral"), 3)

    # ε=0.0 / pos_rate 결정성
    d3 = compute_meta_label_distribution_from_returns([0.1, 0.2, -0.1], neutral_eps=0.0)
    check("pos_rate", round(d3.get("meta_label_pos_rate", 0), 6), round(2 / 3, 6))

    # 거래 없음 → None
    d4 = compute_meta_label_distribution_from_returns([], neutral_eps=0.0)
    check("empty.dist", d4.get("meta_label_dist"), None)

    # 단일 극단값
    d5 = compute_meta_label_distribution_from_returns([0.99], neutral_eps=0.0)
    check("single.pos", (d5.get("meta_label_dist") or {}).get("pos"), 1)

    n_tests = 11
    if failures:
        payload = {"dry_test_meta_labels": "fail", "failures": failures, "tests": n_tests}
        if as_json:
            print(json.dumps(payload, ensure_ascii=False, indent=2))
        else:
            for fail in failures:
                print(f"  FAIL: {fail}")
        return 1

    payload = {"dry_test_meta_labels": "pass", "tests": n_tests}
    if as_json:
        print(json.dumps(payload, ensure_ascii=False, indent=2))
    else:
        print(f"[dry_test_meta_labels] PASS ({n_tests} tests)")
    return 0


def sanitize_json_value(value):
    if isinstance(value, dict):
        return {key: sanitize_json_value(item) for key, item in value.items()}
    if isinstance(value, list):
        return [sanitize_json_value(item) for item in value]
    if isinstance(value, float):
        return value if math.isfinite(value) else None
    return value


ALLOWED_UNIVERSE_SOURCES = {"seed", "discovery", "watchlist"}


def normalize_universe_source(value):
    raw = str(value or "").strip().lower()
    return raw if raw in ALLOWED_UNIVERSE_SOURCES else None


def universe_metadata(args) -> dict:
    return {
        "universe_asof": str(args.universe_asof).strip() if getattr(args, "universe_asof", None) else None,
        "universe_source": normalize_universe_source(getattr(args, "universe_source", None)),
    }


def attach_universe_metadata(result, args):
    meta = universe_metadata(args)
    if isinstance(result, list):
        return [
            {**item, **meta} if isinstance(item, dict) else item
            for item in result
        ]
    if isinstance(result, dict):
        return {**result, **meta}
    return result


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
    parser.add_argument("--pbo", action="store_true")
    parser.add_argument("--meta-labels", action="store_true")
    parser.add_argument("--dry-test-meta-labels", action="store_true")
    parser.add_argument("--json", action="store_true")
    parser.add_argument("--tp", type=float, default=0.06)
    parser.add_argument("--sl", type=float, default=0.03)
    parser.add_argument("--universe-asof", default=None)
    parser.add_argument("--universe-source", default=None)
    args = parser.parse_args()

    if args.dry_test_meta_labels:
        return _run_dry_test_meta_labels(as_json=args.json)

    deps = load_optional_deps()
    if deps["missing"]:
        return emit_missing_dependency_error(deps["missing"], args.json)

    try:
        df = fetch_ohlcv(args.symbol, args.days, deps)
        if args.grid:
            wf_enabled = bool_env("LUNA_BT_WALK_FORWARD_ENABLED", False)
            if wf_enabled:
                wf_result = walk_forward(
                    df,
                    deps,
                    folds=int_env_any(["LUNA_BT_WF_FOLDS", "LUNA_BT_WALK_FORWARD_FOLDS"], 5),
                    train_days=int_env_any(["LUNA_BT_WF_TRAIN_DAYS", "LUNA_BT_WALK_FORWARD_TRAIN_DAYS"], 60),
                    test_days=int_env_any(["LUNA_BT_WF_TEST_DAYS", "LUNA_BT_WALK_FORWARD_TEST_DAYS"], 60),
                )
                split_result = None if wf_result is not None else select_on_is_evaluate_on_oos(df, deps)
                result = [item for item in [wf_result, split_result] if item is not None]
            else:
                result = grid_search(df, deps)[:10]
            if args.pbo:
                try:
                    pbo_result = compute_pbo_cscv(df, deps)
                except Exception as pbo_exc:
                    pbo_result = _pbo_none(
                        "error",
                        [f"compute_pbo_cscv_error({pbo_exc})"],
                        int_env("LUNA_PBO_N_BLOCKS", 16),
                    )
                if isinstance(result, list):
                    result = [{**item, **pbo_result} for item in result]
            if args.meta_labels:
                try:
                    if isinstance(result, list) and result:
                        best_params = result[0].get("params")
                        if best_params and str(best_params.get("strategy", "")).strip():
                            meta_source = run_backtest(df, best_params, deps, collect_meta_labels=True)
                        else:
                            meta_grid = grid_search(df, deps)
                            meta_source = run_backtest(df, meta_grid[0]["params"], deps, collect_meta_labels=True) if meta_grid else _meta_label_none(
                                os.environ.get("LUNA_META_LABEL_METHOD", "A"),
                                ["meta_label_no_grid_results"],
                            )
                        meta_result = {
                            key: meta_source.get(key)
                            for key in [
                                "meta_label_dist",
                                "meta_label_pos_rate",
                                "meta_label_n_trades",
                                "meta_label_method",
                                "meta_label_status",
                                "meta_label_reasons",
                            ]
                        }
                    else:
                        meta_result = _meta_label_none(os.environ.get("LUNA_META_LABEL_METHOD", "A"), ["meta_label_no_grid_results"])
                except Exception as meta_exc:
                    meta_result = _meta_label_none(
                        os.environ.get("LUNA_META_LABEL_METHOD", "A"),
                        [f"compute_meta_labels_error({meta_exc})"],
                    )
                if isinstance(result, list):
                    result = [{**item, **meta_result} for item in result]
        else:
            result = run_backtest(df, {"tp_pct": args.tp, "sl_pct": args.sl}, deps)
    except Exception as exc:
        payload = {"status": "error", "message": str(exc), **universe_metadata(args)}
        if args.json:
            print(json.dumps(payload, ensure_ascii=False, indent=2))
        else:
            print(f"ERROR: {exc}")
        return 1

    result = attach_universe_metadata(result, args)

    if args.json:
        print(json.dumps(sanitize_json_value(result), ensure_ascii=False, indent=2))
        return 0

    if args.grid:
        print(f"[VectorBT] top results for {args.symbol} (walk_forward={wf_enabled})")
        for index, item in enumerate(result[:5], start=1):
            sharpe_oos = item.get('sharpe_oos')
            oos_str = f" oos_sharpe={sharpe_oos:.2f}" if sharpe_oos is not None else ""
            print(
                f"  #{index}: sharpe_is={item.get('sharpe_is', item['sharpe_ratio']):.2f}{oos_str} "
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
