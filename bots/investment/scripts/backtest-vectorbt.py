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
        df.attrs["luna_market_calendar"] = "crypto"
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
    df.attrs["luna_market_calendar"] = "stock"
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

    # OOS returns 분포 통계 — DSR Phase 1b 입력 (skew/kurt). fisher=False = Pearson 정의(정규=3)
    try:
        ret_arr = pf.returns().dropna().values
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
            "market_calendar": params.get("market_calendar") or df.attrs.get("luna_market_calendar") or "crypto",
        },
        "oos_returns_skew": oos_returns_skew,
        "oos_returns_kurt": oos_returns_kurt,
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
    _ts = trial_sharpes or []
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

    best_is = is_grid[0]
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
        {"is_bars": len(is_df), "oos_bars": len(oos_df)},
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


def walk_forward(df, deps: dict, folds: int = 6, train_days: int = 90, test_days: int = 45):
    """Rolling walk-forward: fold OOS 거래를 풀링하여 저빈도 전략도 평가 가능하게 한다.

    저빈도 전략(주식 1d)은 단일 fold에서 거래 ~8건으로 insufficient_data가 됨.
    fold 6개를 누적하면 OOS ~270일·40건+으로 v2 소표본 기준(15건)을 넘긴다.
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
        all_trial_sharpes.extend(r.get("sharpe_ratio", 0) for r in grid)
        try:
            oos_raw = run_backtest(test_df, best_is["params"], deps)
        except Exception as exc:
            fold_raw.append({"fold": fold_index, "error": str(exc)})
            continue
        fold_raw.append({
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
        })

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
    # OOS returns 분포: 거래수 가중 평균 (충분한 fold만 포함)
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

    # Phase 1b: 비연율화 계수 — fold params에 portfolio_freq 저장됨 (run_backtest → IS grid 경유)
    _wf_params = usable[0].get("params") or {}
    _wf_pf = _wf_params.get("portfolio_freq", "5min")
    _wf_market = _wf_params.get("market_calendar", "crypto")
    wf_ppy = periods_per_year(_wf_pf, _wf_market)

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
    }
    aggregate["robust_score"] = robust_rank_score(aggregate)
    return aggregate


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
            wf_enabled = bool_env("LUNA_BT_WALK_FORWARD_ENABLED", False)
            if wf_enabled:
                wf_result = walk_forward(
                    df,
                    deps,
                    folds=int_env_any(["LUNA_BT_WF_FOLDS", "LUNA_BT_WALK_FORWARD_FOLDS"], 6),
                    train_days=int_env_any(["LUNA_BT_WF_TRAIN_DAYS", "LUNA_BT_WALK_FORWARD_TRAIN_DAYS"], 90),
                    test_days=int_env_any(["LUNA_BT_WF_TEST_DAYS", "LUNA_BT_WALK_FORWARD_TEST_DAYS"], 45),
                )
                split_result = None if wf_result is not None else select_on_is_evaluate_on_oos(df, deps)
                result = [item for item in [wf_result, split_result] if item is not None]
            else:
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
