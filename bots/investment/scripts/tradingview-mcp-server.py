#!/usr/bin/env python3
"""
TradingView/Yahoo Finance MCP 서버 스캐폴드.

현재 단계:
1. yfinance + mcp 설치 여부 점검
2. --test 실행 시 의존성/기본 시세 fetch 확인
3. 서버 런타임 모드는 후속 Part E 본 구현에서 확장
"""

from __future__ import annotations

import argparse
import json
import sys
from datetime import datetime


def load_optional_deps():
    missing = []

    try:
        import yfinance as yf  # type: ignore
    except Exception:
        yf = None
        missing.append("yfinance")

    try:
        from mcp.server.fastmcp import FastMCP  # type: ignore
    except Exception:
        FastMCP = None
        missing.append("mcp")

    return {
        "yf": yf,
        "FastMCP": FastMCP,
        "missing": missing,
    }


def emit_dependency_missing(missing: list[str], as_json: bool):
    payload = {
        "status": "dependency_missing",
        "missing": missing,
        "install": "pip3 install yfinance mcp-server --break-system-packages",
    }
    if as_json:
        print(json.dumps(payload, ensure_ascii=False, indent=2))
    else:
        print("ERROR: 필수 Python 패키지가 없습니다.")
        print(f"  missing: {', '.join(missing)}")
        print(f"  install: {payload['install']}")
    return 1


def fetch_quote(symbol: str, deps: dict):
    yf = deps["yf"]
    if yf is None:
        raise RuntimeError("yfinance가 설치되지 않았습니다.")

    ticker = yf.Ticker(symbol)
    history = ticker.history(period="5d", interval="1d")
    if history is None or history.empty:
        raise RuntimeError(f"{symbol} 데이터가 없습니다.")

    last = history.iloc[-1]
    return {
        "symbol": symbol,
        "close": float(last["Close"]),
        "open": float(last["Open"]),
        "high": float(last["High"]),
        "low": float(last["Low"]),
        "volume": float(last["Volume"]),
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


def build_test_payload(symbol: str, deps: dict):
    quote = fetch_quote(symbol, deps)
    return {
        "status": "ok",
        "server": "tradingview-mcp-server",
        "mode": "test",
        "provider": "yfinance",
        "symbol": symbol,
        "quote": quote,
        "capabilities": [
            "quote",
            "ohlcv",
            "technical-indicators",
        ],
        "checkedAt": datetime.utcnow().isoformat() + "Z",
    }


def main():
    parser = argparse.ArgumentParser(description="TradingView MCP server scaffold")
    parser.add_argument("--test", action="store_true")
    parser.add_argument("--ohlcv", action="store_true")
    parser.add_argument("--json", action="store_true")
    parser.add_argument("--symbol", default="BTC-USD")
    parser.add_argument("--interval", default="1h")
    parser.add_argument("--from-date", default=None)
    parser.add_argument("--to-date", default=None)
    args = parser.parse_args()

    deps = load_optional_deps()
    if deps["missing"]:
        return emit_dependency_missing(deps["missing"], args.json)

    if args.test:
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
            print(f"  ts:    {payload['quote']['timestamp']}")
        return 0

    if args.ohlcv:
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

    payload = {
        "status": "not_implemented",
        "message": "서버 런타임 모드는 Part E 본 구현에서 확장 예정입니다. 우선 --test로 의존성과 데이터 수신을 확인하세요.",
    }
    if args.json:
        print(json.dumps(payload, ensure_ascii=False, indent=2))
    else:
        print(payload["message"])
    return 0


if __name__ == "__main__":
    sys.exit(main())
