#!/usr/bin/env python3
"""
Binance Market MCP 서버.

사용법:
  # 서버 모드 (MCP 클라이언트 연결)
  python3 scripts/binance-market-mcp-server.py

  # 헬스체크 (Binance 브리지 호출)
  python3 scripts/binance-market-mcp-server.py --test [--json]

  # 시크릿/환경 진단 (실주문 없음)
  python3 scripts/binance-market-mcp-server.py --doctor [--json]

  # 시세 직접 조회
  python3 scripts/binance-market-mcp-server.py --quote --symbol BTC/USDT [--json]

  # 잔고 직접 조회
  python3 scripts/binance-market-mcp-server.py --balance [--json] [--include-zero-balances]

메모:
  - 실제 Binance API 호출은 Node `shared/binance-client.ts`를 subprocess 브리지로 호출한다.
  - 서버 모드는 python `mcp` 패키지가 필요하다.
"""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path


ROOT = Path(__file__).resolve().parent.parent


def build_node_env() -> dict:
    env = os.environ.copy()
    repo_root = str(ROOT.parent.parent)
    env.setdefault("PROJECT_ROOT", repo_root)
    env.setdefault("REPO_ROOT", repo_root)
    env.setdefault("USE_HUB_SECRETS", "true")
    env.setdefault("HUB_BASE_URL", "http://127.0.0.1:7788")
    # MCP 브리지 내부에서 binance-client가 다시 MCP를 호출하지 않도록 재귀 차단
    env.setdefault("BINANCE_MCP_BRIDGE", "1")
    env.setdefault("BINANCE_USE_MCP", "false")
    return env


def load_optional_deps():
    try:
        from mcp.server.fastmcp import FastMCP  # type: ignore
    except Exception:
        FastMCP = None
    return {"FastMCP": FastMCP}


def emit_json(payload):
    print(json.dumps(payload, ensure_ascii=False, indent=2))


def emit_dependency_missing(missing: list[str], as_json: bool, install: str):
    payload = {
        "status": "dependency_missing",
        "missing": missing,
        "install": install,
    }
    if as_json:
        emit_json(payload)
    else:
        print("ERROR: 필수 Python 패키지가 없습니다.")
        print(f"  missing: {', '.join(missing)}")
        print(f"  install: {install}")
    return 1


def parse_json_from_mixed_stdout(stdout: str) -> dict:
    lines = [line.strip() for line in (stdout or "").splitlines() if line.strip()]
    for line in reversed(lines):
        try:
            payload = json.loads(line)
            if isinstance(payload, dict):
                return payload
        except Exception:
            continue
    raise RuntimeError("Binance bridge JSON 응답을 파싱하지 못했습니다.")


def run_node_binance_bridge(action: str, payload: dict | None = None) -> dict:
    payload_json = json.dumps(payload or {}, ensure_ascii=False)
    node_code = f"""
import * as binance from './shared/binance-client.ts';
import {{ initHubSecrets, loadSecrets, getTradingMode, isPaperMode, getInvestmentTradeMode }} from './shared/secrets.ts';

const action = {json.dumps(action)};
const payload = {payload_json};

const asNumber = (value, fallback = 0) => {{
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}};

const normalizeSymbol = (value) => {{
  const text = String(value || '').trim().toUpperCase();
  if (!text) return 'BTC/USDT';
  if (text.includes('/')) return text;
  if (text.endsWith('USDT')) return `${{text.slice(0, -4)}}/USDT`;
  return `${{text}}/USDT`;
}};

try {{
  const hubSecretsLoaded = await initHubSecrets().catch(() => false);

  if (action === 'health') {{
    const symbol = normalizeSymbol(payload.symbol || 'BTC/USDT');
    const quote = await binance.getBinanceTickerSnapshot(symbol);
    const balance = await binance.getBinanceBalanceSnapshot({{ omitZeroBalances: true }});
    console.log(JSON.stringify({{
      status: 'ok',
      action,
      symbol,
      quote,
      usdtFree: Number(balance?.free?.USDT || 0),
      nonZeroAssetCount: Object.keys(balance?.total || {{}}).length,
      hubSecretsLoaded: Boolean(hubSecretsLoaded),
    }}));
  }} else if (action === 'quote') {{
    const symbol = normalizeSymbol(payload.symbol || 'BTC/USDT');
    const quote = await binance.getBinanceTickerSnapshot(symbol);
    console.log(JSON.stringify({{
      status: 'ok',
      action,
      symbol,
      quote,
    }}));
  }} else if (action === 'balance') {{
    const omitZeroBalances = payload.omitZeroBalances !== false;
    const balance = await binance.getBinanceBalanceSnapshot({{ omitZeroBalances }});
    console.log(JSON.stringify({{
      status: 'ok',
      action,
      omitZeroBalances,
      balance,
    }}));
  }} else if (action === 'market_buy') {{
    const symbol = normalizeSymbol(payload.symbol || 'BTC/USDT');
    const amountUsdt = asNumber(payload.amountUsdt ?? payload.amount, 0);
    if (!(amountUsdt > 0)) throw new Error('market_buy requires positive amountUsdt');
    const order = await binance.createBinanceMarketBuy(symbol, amountUsdt);
    console.log(JSON.stringify({{
      status: 'ok',
      action,
      symbol,
      amountUsdt,
      order,
    }}));
  }} else if (action === 'market_sell') {{
    const symbol = normalizeSymbol(payload.symbol || 'BTC/USDT');
    const amount = asNumber(payload.amount, 0);
    if (!(amount > 0)) throw new Error('market_sell requires positive amount');
    const order = await binance.createBinanceMarketSell(symbol, amount);
    console.log(JSON.stringify({{
      status: 'ok',
      action,
      symbol,
      amount,
      order,
    }}));
  }} else if (action === 'fetch_order') {{
    const symbol = normalizeSymbol(payload.symbol || 'BTC/USDT');
    const orderId = String(payload.orderId || '').trim();
    if (!orderId) throw new Error('fetch_order requires orderId');
    const order = await binance.fetchBinanceOrder(orderId, symbol);
    console.log(JSON.stringify({{
      status: 'ok',
      action,
      symbol,
      orderId,
      order,
    }}));
  }} else if (action === 'open_orders') {{
    const symbol = String(payload.symbol || '').trim();
    const normalizedSymbol = symbol ? normalizeSymbol(symbol) : '';
    const orders = await binance.getBinanceOpenOrders(normalizedSymbol);
    console.log(JSON.stringify({{
      status: 'ok',
      action,
      symbol: normalizedSymbol || null,
      count: Array.isArray(orders) ? orders.length : 0,
      orders: Array.isArray(orders) ? orders : [],
    }}));
  }} else if (action === 'doctor') {{
    const s = loadSecrets();
    console.log(JSON.stringify({{
      status: 'ok',
      action,
      hubSecretsLoaded: Boolean(hubSecretsLoaded),
      mode: {{
        tradingMode: getTradingMode(),
        paperMode: isPaperMode(),
        investmentTradeMode: getInvestmentTradeMode(),
      }},
      secrets: {{
        apiKey: Boolean(s?.binance_api_key),
        apiSecret: Boolean(s?.binance_api_secret),
        testnet: Boolean(s?.binance_testnet),
        symbolCount: Array.isArray(s?.binance_symbols) ? s.binance_symbols.length : 0,
      }},
      env: {{
        binanceUseMcp: process.env.BINANCE_USE_MCP || null,
        binanceMcpBridge: process.env.BINANCE_MCP_BRIDGE || null,
      }},
    }}));
  }} else {{
    throw new Error(`Unsupported bridge action: ${{action}}`);
  }}
}} catch (error) {{
  console.error(error?.message || String(error));
  process.exit(1);
}}
"""

    proc = subprocess.run(
        ["node", "--input-type=module", "-e", node_code],
        cwd=str(ROOT),
        env=build_node_env(),
        capture_output=True,
        text=True,
        check=False,
    )
    if proc.returncode != 0:
        stderr = (proc.stderr or "").strip()
        stdout = (proc.stdout or "").strip()
        message = stderr or stdout or "node binance bridge failed"
        raise RuntimeError(message)
    return parse_json_from_mixed_stdout(proc.stdout or "")


def build_test_payload(symbol: str):
    bridge = run_node_binance_bridge("health", {"symbol": symbol})
    return {
        "status": "ok",
        "server": "binance-market-mcp-server",
        "mode": "test",
        "provider": "binance_client_bridge",
        "symbol": bridge.get("symbol"),
        "lastPrice": (bridge.get("quote") or {}).get("last"),
        "usdtFree": bridge.get("usdtFree"),
        "nonZeroAssetCount": bridge.get("nonZeroAssetCount"),
        "checkedAt": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
    }


def run_test(args):
    try:
        payload = build_test_payload(symbol=args.symbol)
    except Exception as exc:
        payload = {"status": "error", "message": str(exc)}
        if args.json:
            emit_json(payload)
        else:
            print(f"ERROR: {exc}")
        return 1

    if args.json:
        emit_json(payload)
    else:
        print(
            "[Binance MCP] test ok: "
            f"{payload.get('symbol')}={payload.get('lastPrice')} usdtFree={payload.get('usdtFree')}"
        )
    return 0


def run_doctor(args):
    try:
        payload = run_node_binance_bridge("doctor", {})
    except Exception as exc:
        payload = {"status": "error", "message": str(exc)}
        if args.json:
            emit_json(payload)
        else:
            print(f"ERROR: {exc}")
        return 1

    if args.json:
        emit_json(payload)
    else:
        secrets = payload.get("secrets") or {}
        mode = payload.get("mode") or {}
        print(
            "[Binance MCP] doctor: "
            f"trading={mode.get('tradingMode')} paper={mode.get('paperMode')} tradeMode={mode.get('investmentTradeMode')} "
            f"apiKey={secrets.get('apiKey')} apiSecret={secrets.get('apiSecret')} symbolCount={secrets.get('symbolCount')}"
        )
    return 0


def run_quote(args):
    try:
        payload = run_node_binance_bridge("quote", {"symbol": args.symbol})
    except Exception as exc:
        payload = {"status": "error", "message": str(exc)}
        if args.json:
            emit_json(payload)
        else:
            print(f"ERROR: {exc}")
        return 1

    if args.json:
        emit_json(payload)
    else:
        quote = payload.get("quote") or {}
        print(
            f"[Binance MCP] quote ok: symbol={payload.get('symbol')} "
            f"last={quote.get('last')} bid={quote.get('bid')} ask={quote.get('ask')}"
        )
    return 0


def run_balance(args):
    try:
        payload = run_node_binance_bridge(
            "balance",
            {
                "omitZeroBalances": not args.include_zero_balances,
            },
        )
    except Exception as exc:
        payload = {"status": "error", "message": str(exc)}
        if args.json:
            emit_json(payload)
        else:
            print(f"ERROR: {exc}")
        return 1

    if args.json:
        emit_json(payload)
    else:
        balance = payload.get("balance") or {}
        total_assets = balance.get("total") or {}
        print(f"[Binance MCP] balance ok: assets={len(total_assets)}")
    return 0


def run_open_orders(args):
    try:
        payload = run_node_binance_bridge(
            "open_orders",
            {"symbol": args.symbol if args.symbol else ""},
        )
    except Exception as exc:
        payload = {"status": "error", "message": str(exc)}
        if args.json:
            emit_json(payload)
        else:
            print(f"ERROR: {exc}")
        return 1

    if args.json:
        emit_json(payload)
    else:
        print(f"[Binance MCP] open orders ok: count={payload.get('count')}")
    return 0


def run_bridge_action(args):
    payload = {}
    if args.payload_json:
        try:
            payload = json.loads(args.payload_json)
            if not isinstance(payload, dict):
                raise ValueError("payload_json must decode to an object")
        except Exception as exc:
            message = f"payload_json parse failed: {exc}"
            if args.json:
                emit_json({"status": "error", "message": message})
            else:
                print(f"ERROR: {message}")
            return 1

    try:
        result = run_node_binance_bridge(args.bridge_action, payload)
    except Exception as exc:
        payload = {"status": "error", "message": str(exc), "action": args.bridge_action}
        if args.json:
            emit_json(payload)
        else:
            print(f"ERROR: {exc}")
        return 1

    if args.json:
        emit_json(result)
    else:
        print(f"[Binance MCP] bridge ok: action={args.bridge_action}")
    return 0


def run_server(deps):
    FastMCP = deps["FastMCP"]
    if FastMCP is None:
        return emit_dependency_missing(
            ["mcp"],
            False,
            "pip3 install mcp --break-system-packages",
        )

    mcp = FastMCP("binance-market-mcp-server")

    @mcp.tool()
    def health_check(symbol: str = "BTC/USDT") -> dict:
        try:
            return build_test_payload(symbol=symbol)
        except Exception as exc:
            return {"status": "error", "message": str(exc)}

    @mcp.tool()
    def get_binance_quote(symbol: str = "BTC/USDT") -> dict:
        try:
            return run_node_binance_bridge("quote", {"symbol": symbol})
        except Exception as exc:
            return {"status": "error", "message": str(exc)}

    @mcp.tool()
    def get_binance_balance(omit_zero_balances: bool = True) -> dict:
        try:
            return run_node_binance_bridge("balance", {"omitZeroBalances": omit_zero_balances})
        except Exception as exc:
            return {"status": "error", "message": str(exc)}

    @mcp.tool()
    def get_binance_order(symbol: str = "BTC/USDT", order_id: str = "") -> dict:
        try:
            return run_node_binance_bridge(
                "fetch_order",
                {"symbol": symbol, "orderId": order_id},
            )
        except Exception as exc:
            return {"status": "error", "message": str(exc)}

    @mcp.tool()
    def get_binance_open_orders(symbol: str = "") -> dict:
        try:
            return run_node_binance_bridge(
                "open_orders",
                {"symbol": symbol},
            )
        except Exception as exc:
            return {"status": "error", "message": str(exc)}

    @mcp.tool()
    def get_binance_secret_status() -> dict:
        try:
            return run_node_binance_bridge("doctor", {})
        except Exception as exc:
            return {"status": "error", "message": str(exc)}

    mcp.run()
    return 0


def main():
    parser = argparse.ArgumentParser(description="Binance Market MCP 서버")
    parser.add_argument("--test", action="store_true", help="Binance 브리지 헬스체크")
    parser.add_argument("--doctor", action="store_true", help="Binance 시크릿/환경 진단")
    parser.add_argument("--quote", action="store_true", help="Binance 시세 조회")
    parser.add_argument("--balance", action="store_true", help="Binance 잔고 조회")
    parser.add_argument("--open-orders", action="store_true", help="Binance 미체결 주문 조회")
    parser.add_argument("--bridge-action", default="", help="내부 브리지 액션 직접 실행 (JSON 출력 권장)")
    parser.add_argument("--payload-json", default="", help="bridge-action payload JSON 문자열")
    parser.add_argument("--symbol", default="")
    parser.add_argument("--order-id", default="")
    parser.add_argument("--include-zero-balances", action="store_true")
    parser.add_argument("--json", action="store_true")
    args = parser.parse_args()

    deps = load_optional_deps()

    if args.test:
        return run_test(args)
    if args.doctor:
        return run_doctor(args)
    if args.quote:
        return run_quote(args)
    if args.balance:
        return run_balance(args)
    if args.open_orders:
        return run_open_orders(args)
    if args.bridge_action:
        return run_bridge_action(args)

    return run_server(deps)


if __name__ == "__main__":
    sys.exit(main())
