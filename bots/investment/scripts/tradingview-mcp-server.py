#!/usr/bin/env python3
"""
TradingView/Yahoo Finance MCP 서버.

사용법:
  # 서버 모드 (MCP 클라이언트 연결)
  python3 scripts/tradingview-mcp-server.py

  # 의존성 테스트
  python3 scripts/tradingview-mcp-server.py --test [--json] [--symbol BTC-USD]

  # OHLCV 직접 조회 (ohlcv-fetcher.ts 폴백 경로)
  python3 scripts/tradingview-mcp-server.py --ohlcv --symbol BTC-USD --from-date 2026-04-01 [--json]

의존성:
  pip3 install yfinance mcp --break-system-packages
"""

from __future__ import annotations

import argparse
import json
import sys
from datetime import datetime, timezone


# ── 의존성 로드 ──────────────────────────────────────────────────────────────

def load_optional_deps():
    try:
        import yfinance as yf  # type: ignore
    except Exception:
        yf = None

    try:
        from mcp.server.fastmcp import FastMCP  # type: ignore
    except Exception:
        FastMCP = None

    try:
        import pandas as pd  # type: ignore
    except Exception:
        pd = None

    return {
        "yf": yf,
        "FastMCP": FastMCP,
        "pd": pd,
    }


def emit_dependency_missing(missing: list[str], as_json: bool, install: str):
    payload = {
        "status": "dependency_missing",
        "missing": missing,
        "install": install,
    }
    if as_json:
        print(json.dumps(payload, ensure_ascii=False, indent=2))
    else:
        print("ERROR: 필수 Python 패키지가 없습니다.")
        print(f"  missing: {', '.join(missing)}")
        print(f"  install: {payload['install']}")
    return 1


# ── 데이터 수집 ───────────────────────────────────────────────────────────────

def fetch_quote(symbol: str, deps: dict):
    yf = deps["yf"]
    if yf is None:
        raise RuntimeError("yfinance가 설치되지 않았습니다.")

    ticker = yf.Ticker(symbol)
    history = ticker.history(period="5d", interval="1d")
    if history is None or history.empty:
        raise RuntimeError(f"{symbol} 데이터가 없습니다.")

    last = history.iloc[-1]
    prev = history.iloc[-2] if len(history) >= 2 else last
    close = float(last["Close"])
    prev_close = float(prev["Close"])
    change_pct = ((close - prev_close) / prev_close * 100) if prev_close else 0.0
    return {
        "symbol": symbol,
        "close": close,
        "open": float(last["Open"]),
        "high": float(last["High"]),
        "low": float(last["Low"]),
        "volume": float(last["Volume"]),
        "change_pct": round(change_pct, 2),
        "timestamp": str(history.index[-1]),
    }


def fetch_ohlcv(symbol: str, interval: str, start: str, end: str | None, deps: dict):
    yf = deps["yf"]
    if yf is None:
        raise RuntimeError("yfinance가 설치되지 않았습니다.")

    ticker = yf.Ticker(symbol)
    history = ticker.history(start=start, end=end, interval=interval)
    if history is None or history.empty:
        raise RuntimeError(f"{symbol} OHLCV 데이터가 없습니다.")

    rows = []
    for index, row in history.iterrows():
        timestamp_ms = int(index.to_pydatetime().timestamp() * 1000)
        rows.append([
            timestamp_ms,
            float(row["Open"]),
            float(row["High"]),
            float(row["Low"]),
            float(row["Close"]),
            float(row["Volume"]),
        ])
    return rows


def compute_indicators(symbol: str, interval: str, deps: dict) -> dict:
    """RSI, MACD, 볼린저 밴드 계산 (pandas 기반, ta-lib 없이 동작)"""
    yf = deps["yf"]
    pd = deps["pd"]
    if yf is None:
        raise RuntimeError("yfinance가 설치되지 않았습니다.")
    if pd is None:
        raise RuntimeError("pandas가 설치되지 않았습니다.")

    ticker = yf.Ticker(symbol)
    history = ticker.history(period="90d", interval=interval)
    if history is None or history.empty:
        raise RuntimeError(f"{symbol} 데이터가 없습니다.")

    close = history["Close"]

    # RSI (14)
    delta = close.diff()
    gain = delta.clip(lower=0).rolling(14).mean()
    loss = (-delta.clip(upper=0)).rolling(14).mean()
    rs = gain / loss.replace(0, 1e-10)
    rsi = (100 - 100 / (1 + rs)).iloc[-1]

    # MACD (12, 26, 9)
    ema12 = close.ewm(span=12, adjust=False).mean()
    ema26 = close.ewm(span=26, adjust=False).mean()
    macd_line = ema12 - ema26
    macd_signal = macd_line.ewm(span=9, adjust=False).mean()
    macd_hist = macd_line - macd_signal

    # 볼린저 밴드 (20, 2σ)
    sma20 = close.rolling(20).mean()
    std20 = close.rolling(20).std()
    bb_upper = sma20 + 2 * std20
    bb_lower = sma20 - 2 * std20
    current = float(close.iloc[-1])
    bb_pct = float((current - bb_lower.iloc[-1]) / (bb_upper.iloc[-1] - bb_lower.iloc[-1]))

    return {
        "symbol": symbol,
        "interval": interval,
        "close": current,
        "rsi": round(float(rsi), 2),
        "macd": round(float(macd_line.iloc[-1]), 4),
        "macd_signal": round(float(macd_signal.iloc[-1]), 4),
        "macd_hist": round(float(macd_hist.iloc[-1]), 4),
        "bb_upper": round(float(bb_upper.iloc[-1]), 4),
        "bb_middle": round(float(sma20.iloc[-1]), 4),
        "bb_lower": round(float(bb_lower.iloc[-1]), 4),
        "bb_pct": round(bb_pct, 4),
        "signal": _classify_signal(float(rsi), float(macd_hist.iloc[-1]), bb_pct),
        "timestamp": str(history.index[-1]),
    }


def _classify_signal(rsi: float, macd_hist: float, bb_pct: float) -> str:
    bullish = (rsi < 50 and macd_hist > 0) or (bb_pct < 0.2)
    bearish = (rsi > 60 and macd_hist < 0) or (bb_pct > 0.8)
    if bullish and not bearish:
        return "bullish"
    if bearish and not bullish:
        return "bearish"
    return "neutral"


# ── 테스트 / CLI 모드 ─────────────────────────────────────────────────────────

def build_test_payload(symbol: str, deps: dict):
    quote = fetch_quote(symbol, deps)
    return {
        "status": "ok",
        "server": "tradingview-mcp-server",
        "mode": "test",
        "provider": "yfinance",
        "symbol": symbol,
        "quote": quote,
        "capabilities": ["quote", "ohlcv", "indicators"],
        "checkedAt": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
    }


def run_test(args, deps):
    if deps["yf"] is None:
        return emit_dependency_missing(["yfinance"], args.json, "pip3 install yfinance")
    try:
        payload = build_test_payload(args.symbol, deps)
    except Exception as exc:
        payload = {"status": "error", "message": str(exc)}
        if args.json:
            print(json.dumps(payload, ensure_ascii=False, indent=2))
        else:
            print(f"ERROR: {exc}")
        return 1

    if args.json:
        print(json.dumps(payload, ensure_ascii=False, indent=2))
    else:
        print(f"[TradingView MCP] test ok: {payload['symbol']}")
        print(f"  close: {payload['quote']['close']}")
        print(f"  change: {payload['quote']['change_pct']}%")
        print(f"  ts:    {payload['quote']['timestamp']}")
    return 0


def run_ohlcv(args, deps):
    if deps["yf"] is None:
        return emit_dependency_missing(["yfinance"], args.json, "pip3 install yfinance")
    if not args.from_date:
        payload = {"status": "error", "message": "--from-date is required with --ohlcv"}
        if args.json:
            print(json.dumps(payload, ensure_ascii=False, indent=2))
        else:
            print(f"ERROR: {payload['message']}")
        return 1

    try:
        rows = fetch_ohlcv(args.symbol, args.interval, args.from_date, args.to_date, deps)
        payload = {
            "status": "ok",
            "provider": "yfinance",
            "symbol": args.symbol,
            "interval": args.interval,
            "count": len(rows),
            "rows": rows,
        }
    except Exception as exc:
        payload = {"status": "error", "message": str(exc)}
        if args.json:
            print(json.dumps(payload, ensure_ascii=False, indent=2))
        else:
            print(f"ERROR: {exc}")
        return 1

    if args.json:
        print(json.dumps(payload, ensure_ascii=False, indent=2))
    else:
        print(f"[TradingView MCP] ohlcv ok: {payload['symbol']} {payload['interval']} count={payload['count']}")
    return 0


def run_indicators_cli(args, deps):
    missing = []
    if deps["yf"] is None:
        missing.append("yfinance")
    if deps["pd"] is None:
        missing.append("pandas")
    if missing:
        return emit_dependency_missing(missing, args.json, "pip3 install yfinance pandas")

    try:
        payload = compute_indicators(args.symbol, args.interval, deps)
        payload["status"] = "ok"
    except Exception as exc:
        payload = {"status": "error", "message": str(exc)}
        if args.json:
            print(json.dumps(payload, ensure_ascii=False, indent=2))
        else:
            print(f"ERROR: {exc}")
        return 1

    if args.json:
        print(json.dumps(payload, ensure_ascii=False, indent=2))
    else:
        print(f"[TradingView MCP] indicators: {payload['symbol']} {payload['interval']}")
        print(f"  close: {payload['close']}")
        print(f"  rsi:   {payload['rsi']}")
        print(f"  macd:  {payload['macd']} (signal={payload['macd_signal']})")
        print(f"  bb_pct:{payload['bb_pct']} → {payload['signal']}")
    return 0


# ── FastMCP 서버 모드 ─────────────────────────────────────────────────────────

def run_server(deps):
    """FastMCP 서버 런타임: MCP 클라이언트에 도구 제공"""
    FastMCP = deps["FastMCP"]
    if FastMCP is None:
        print("ERROR: mcp 패키지가 없습니다.")
        print("  install: pip3 install mcp --break-system-packages")
        return 1

    mcp = FastMCP("tradingview-mcp-server")

    @mcp.tool()
    def get_quote(symbol: str) -> dict:
        """
        Yahoo Finance에서 시세 조회.

        Args:
            symbol: 심볼 (예: BTC-USD, AAPL, 005930.KS)

        Returns:
            close, open, high, low, volume, change_pct, timestamp
        """
        try:
            return fetch_quote(symbol, deps)
        except Exception as exc:
            return {"status": "error", "message": str(exc)}

    @mcp.tool()
    def get_ohlcv(
        symbol: str,
        interval: str = "1h",
        start: str = "2026-01-01",
        end: str | None = None,
    ) -> dict:
        """
        Yahoo Finance에서 OHLCV 기간 데이터 조회.

        Args:
            symbol: 심볼 (예: BTC-USD, AAPL)
            interval: 봉 단위 (1m, 5m, 15m, 1h, 1d)
            start: 시작 날짜 (YYYY-MM-DD)
            end: 종료 날짜 (YYYY-MM-DD, 미입력 시 오늘)

        Returns:
            rows: [[timestamp_ms, open, high, low, close, volume], ...]
        """
        try:
            rows = fetch_ohlcv(symbol, interval, start, end, deps)
            return {
                "status": "ok",
                "symbol": symbol,
                "interval": interval,
                "count": len(rows),
                "rows": rows[:500],  # 최대 500봉
            }
        except Exception as exc:
            return {"status": "error", "message": str(exc)}

    @mcp.tool()
    def get_indicators(symbol: str, interval: str = "1h") -> dict:
        """
        RSI, MACD, 볼린저 밴드 기술 지표 계산.

        Args:
            symbol: 심볼 (예: BTC-USD, AAPL)
            interval: 봉 단위 (1h, 4h, 1d)

        Returns:
            rsi, macd, macd_signal, macd_hist, bb_upper, bb_middle, bb_lower, bb_pct, signal
        """
        try:
            result = compute_indicators(symbol, interval, deps)
            result["status"] = "ok"
            return result
        except Exception as exc:
            return {"status": "error", "message": str(exc)}

    @mcp.tool()
    def get_multi_quote(symbols: list[str]) -> dict:
        """
        여러 심볼 시세 일괄 조회.

        Args:
            symbols: 심볼 목록 (최대 10개)

        Returns:
            quotes: {symbol: quote_data, ...}
        """
        results = {}
        for symbol in symbols[:10]:
            try:
                results[symbol] = fetch_quote(symbol, deps)
            except Exception as exc:
                results[symbol] = {"status": "error", "message": str(exc)}
        return {"status": "ok", "quotes": results}

    mcp.run()
    return 0


# ── 엔트리포인트 ───────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description="TradingView/Yahoo Finance MCP 서버")
    parser.add_argument("--test", action="store_true", help="의존성 및 시세 fetch 테스트")
    parser.add_argument("--ohlcv", action="store_true", help="OHLCV 직접 조회 (ohlcv-fetcher.ts 폴백)")
    parser.add_argument("--indicators", action="store_true", help="기술 지표 계산")
    parser.add_argument("--json", action="store_true", help="JSON 출력")
    parser.add_argument("--symbol", default="BTC-USD", help="심볼 (기본: BTC-USD)")
    parser.add_argument("--interval", default="1h", help="봉 단위 (기본: 1h)")
    parser.add_argument("--from-date", default=None, dest="from_date")
    parser.add_argument("--to-date", default=None, dest="to_date")
    args = parser.parse_args()

    deps = load_optional_deps()

    if args.test:
        return run_test(args, deps)

    if args.ohlcv:
        return run_ohlcv(args, deps)

    if args.indicators:
        return run_indicators_cli(args, deps)

    # 서버 런타임 모드
    return run_server(deps)


if __name__ == "__main__":
    sys.exit(main())
