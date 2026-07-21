#!/usr/bin/env python3
"""
KIS Market MCP 서버.

사용법:
  # 서버 모드 (MCP 클라이언트 연결)
  python3 scripts/kis-market-mcp-server.py

  # 헬스체크 (KIS 브리지 호출)
  python3 scripts/kis-market-mcp-server.py --test [--json] [--paper]

  # 시크릿/환경 진단 (API 호출 없음)
  python3 scripts/kis-market-mcp-server.py --doctor [--json]

  # 시세 직접 조회
  python3 scripts/kis-market-mcp-server.py --quote --market domestic --symbol 005930 [--json] [--paper]
  python3 scripts/kis-market-mcp-server.py --quote --market overseas --symbol AAPL [--json]

  # 잔고 직접 조회
  python3 scripts/kis-market-mcp-server.py --balance --market domestic [--json] [--paper]
  python3 scripts/kis-market-mcp-server.py --balance --market overseas [--json] [--paper]

메모:
  - 실제 KIS API 호출은 Node `shared/kis-client.ts`를 subprocess 브리지로 호출한다.
  - 서버 모드는 python `mcp` 패키지가 필요하다.
"""

from __future__ import annotations

import argparse
import json
import math
import os
import re
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path


ROOT = Path(__file__).resolve().parent.parent

MAX_BRIDGE_PAYLOAD_BYTES = 32 * 1024
BRIDGE_SUBPROCESS_TIMEOUT_SECONDS = 30
BRIDGE_ACTION_FIELDS = {
    "health": {"paper", "domesticSymbol", "overseasSymbol"},
    "quote": {"market", "symbol", "paper"},
    "domestic_quote": {"market", "symbol", "paper"},
    "overseas_quote": {"market", "symbol", "paper"},
    "domestic_price": {"symbol", "paper"},
    "overseas_price": {"symbol", "paper"},
    "balance": {"market", "paper"},
    "domestic_balance": {"market", "paper"},
    "overseas_balance": {"market", "paper"},
    "domestic_buy": {"symbol", "amount", "amountKrw", "dryRun", "paper"},
    "domestic_sell": {"symbol", "qty", "dryRun", "paper"},
    "overseas_buy": {"symbol", "amount", "amountUsd", "dryRun", "paper"},
    "overseas_sell": {"symbol", "qty", "dryRun", "paper"},
    "domestic_fill": {"market", "symbol", "ordNo", "side", "paper"},
    "overseas_fill": {"market", "symbol", "ordNo", "side", "paper"},
    "domestic_ranking": {"endpoint", "trId", "params", "paper"},
    "volume_rank": {"paper"},
}
DOMESTIC_SYMBOL_PATTERN = re.compile(r"^[0-9]{6}$")
OVERSEAS_SYMBOL_PATTERN = re.compile(r"^[A-Z0-9][A-Z0-9.-]{0,14}$", re.IGNORECASE)
ORDER_NUMBER_PATTERN = re.compile(r"^[0-9]{1,20}$")
RANKING_ENDPOINT_PATTERN = re.compile(r"^/uapi/domestic-stock/v1/ranking/[a-z0-9-]+$")
TR_ID_PATTERN = re.compile(r"^[A-Z0-9]{8,16}$")
PARAM_KEY_PATTERN = re.compile(r"^[A-Za-z0-9_]{1,64}$")
RESERVED_JSON_KEYS = {"__proto__", "constructor", "prototype"}


def _require_bool(payload: dict, key: str):
    if key in payload and not isinstance(payload[key], bool):
        raise ValueError(f"{key} must be a boolean")


def _require_symbol(value, market: str, field: str = "symbol"):
    if not isinstance(value, str):
        raise ValueError(f"{field} must be a string")
    pattern = DOMESTIC_SYMBOL_PATTERN if market == "domestic" else OVERSEAS_SYMBOL_PATTERN
    if value != value.strip() or not pattern.fullmatch(value):
        raise ValueError(f"invalid {market} {field}")


def _require_positive_number(value, field: str, integer: bool = False):
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise ValueError(f"{field} must be a positive number")
    numeric = float(value)
    if not math.isfinite(numeric) or numeric <= 0 or (integer and not numeric.is_integer()):
        raise ValueError(f"{field} must be a positive {'integer' if integer else 'number'}")


def _validate_ranking_params(params):
    if not isinstance(params, dict) or len(params) > 64:
        raise ValueError("params must be an object with at most 64 fields")
    for key, value in params.items():
        if key in RESERVED_JSON_KEYS or not PARAM_KEY_PATTERN.fullmatch(str(key)):
            raise ValueError("params contains an invalid key")
        if value is not None and (isinstance(value, (dict, list)) or not isinstance(value, (str, int, float, bool))):
            raise ValueError(f"params.{key} must be a scalar JSON value")


def validate_bridge_request(action: str, payload: dict | None) -> dict:
    normalized_action = str(action or "").strip().lower()
    allowed_fields = BRIDGE_ACTION_FIELDS.get(normalized_action)
    if allowed_fields is None:
        raise ValueError(f"unsupported bridge action: {normalized_action or '<empty>'}")
    if not isinstance(payload, dict):
        raise ValueError("bridge payload must be an object")
    if not all(isinstance(key, str) for key in payload):
        raise ValueError("bridge payload keys must be strings")

    encoded = json.dumps(
        payload,
        ensure_ascii=False,
        separators=(",", ":"),
        allow_nan=False,
    ).encode("utf-8")
    if len(encoded) > MAX_BRIDGE_PAYLOAD_BYTES:
        raise ValueError(f"bridge payload exceeds {MAX_BRIDGE_PAYLOAD_BYTES} bytes")

    unknown_fields = set(payload) - allowed_fields
    if unknown_fields:
        raise ValueError(f"unexpected bridge payload fields: {', '.join(sorted(unknown_fields))}")
    if any(key in RESERVED_JSON_KEYS for key in payload):
        raise ValueError("bridge payload contains a reserved key")

    _require_bool(payload, "paper")
    _require_bool(payload, "dryRun")

    market = payload.get("market")
    if market is not None and market not in {"domestic", "overseas"}:
        raise ValueError("market must be domestic or overseas")

    forced_market = None
    if normalized_action.startswith("domestic_"):
        forced_market = "domestic"
    elif normalized_action.startswith("overseas_"):
        forced_market = "overseas"
    if forced_market and market is not None and market != forced_market:
        raise ValueError(f"{normalized_action} requires market={forced_market}")

    symbol_market = forced_market or market
    if normalized_action == "health":
        if "domesticSymbol" in payload:
            _require_symbol(payload["domesticSymbol"], "domestic", "domesticSymbol")
        if "overseasSymbol" in payload:
            _require_symbol(payload["overseasSymbol"], "overseas", "overseasSymbol")
    elif "symbol" in payload:
        _require_symbol(payload["symbol"], symbol_market or "domestic")

    if normalized_action in {"domestic_fill", "overseas_fill"}:
        if "symbol" not in payload or "ordNo" not in payload:
            raise ValueError(f"{normalized_action} requires symbol and ordNo")
        if not isinstance(payload["ordNo"], str) or not ORDER_NUMBER_PATTERN.fullmatch(payload["ordNo"].strip()):
            raise ValueError("ordNo must contain 1-20 digits")
        side = str(payload.get("side", "all")).upper()
        if side not in {"ALL", "BUY", "SELL", "01", "02"}:
            raise ValueError("side must be all, BUY, SELL, 01, or 02")

    if normalized_action in {"domestic_buy", "overseas_buy"}:
        primary = "amountKrw" if normalized_action == "domestic_buy" else "amountUsd"
        amount_field = primary if primary in payload else "amount"
        if amount_field not in payload:
            raise ValueError(f"{normalized_action} requires {primary} or amount")
        _require_positive_number(payload[amount_field], amount_field)
    if normalized_action in {"domestic_sell", "overseas_sell"}:
        if "qty" not in payload:
            raise ValueError(f"{normalized_action} requires qty")
        _require_positive_number(payload["qty"], "qty", integer=True)

    if normalized_action == "domestic_ranking":
        endpoint = payload.get("endpoint", "/uapi/domestic-stock/v1/ranking/volume")
        tr_id = payload.get("trId", "FHPST01710000")
        if not isinstance(endpoint, str) or not RANKING_ENDPOINT_PATTERN.fullmatch(endpoint):
            raise ValueError("invalid domestic ranking endpoint")
        if not isinstance(tr_id, str) or not TR_ID_PATTERN.fullmatch(tr_id):
            raise ValueError("invalid domestic ranking trId")
        _validate_ranking_params(payload.get("params", {}))

    return payload


def build_node_env() -> dict:
    env = os.environ.copy()
    repo_root = str(ROOT.parent.parent)
    env.setdefault("PROJECT_ROOT", repo_root)
    env.setdefault("REPO_ROOT", repo_root)
    env.setdefault("USE_HUB_SECRETS", "true")
    env.setdefault("HUB_BASE_URL", "http://127.0.0.1:7788")
    # MCP 브리지 내부에서 kis-client가 다시 MCP를 호출하지 않도록 재귀를 차단한다.
    env.setdefault("KIS_MCP_BRIDGE", "1")
    env.setdefault("KIS_USE_MCP", "false")
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
    raise RuntimeError("KIS bridge JSON 응답을 파싱하지 못했습니다.")


def run_node_kis_bridge(action: str, payload: dict | None = None) -> dict:
    normalized_action = str(action or "").strip().lower()
    validated_payload = validate_bridge_request(
        normalized_action,
        {} if payload is None else payload,
    )
    bridge_input = json.dumps(
        {"action": normalized_action, "payload": validated_payload},
        ensure_ascii=False,
        separators=(",", ":"),
    )
    # Fixed runner template: request data is parsed from stdin and never interpolated into source.
    node_code = f"""
import fs from 'node:fs';
import * as kis from './shared/kis-client.ts';
import {{ initHubSecrets }} from './shared/secrets.ts';

const bridgeRequest = JSON.parse(fs.readFileSync(0, 'utf8'));
const action = bridgeRequest.action;
const payload = bridgeRequest.payload;
const paper = payload.paper === true;
const asNumber = (value, fallback = 0) => {{
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}};
const toUpper = (value) => String(value || '').trim().toUpperCase();

try {{
  await initHubSecrets();
  if (action === 'health') {{
    const domesticSymbol = String(payload.domesticSymbol || '005930');
    const overseasSymbol = String(payload.overseasSymbol || 'AAPL').toUpperCase();
    const domesticPrice = await kis.getDomesticPrice(domesticSymbol, paper);
    const overseas = await kis.getOverseasPrice(overseasSymbol);
    console.log(JSON.stringify({{
      status: 'ok',
      action,
      paper,
      domesticSymbol,
      overseasSymbol,
      domesticPrice,
      overseasPrice: Number(overseas?.price || 0),
      overseasExchangeCode: overseas?.excd || null,
    }}));
  }} else if (action === 'quote' || action === 'domestic_quote' || action === 'overseas_quote') {{
    const explicitMarket = payload.market ? String(payload.market) : null;
    const market = explicitMarket || (action === 'overseas_quote' ? 'overseas' : 'domestic');
    const defaultSymbol = market === 'overseas' ? 'AAPL' : '005930';
    const symbol = market === 'overseas'
      ? toUpper(payload.symbol || defaultSymbol)
      : String(payload.symbol || defaultSymbol);
    if (market === 'overseas') {{
      const quote = await kis.getOverseasQuoteSnapshot(symbol);
      console.log(JSON.stringify({{
        status: 'ok',
        action,
        market,
        symbol,
        quote,
      }}));
    }} else {{
      const quote = await kis.getDomesticQuoteSnapshot(symbol, paper);
      console.log(JSON.stringify({{
        status: 'ok',
        action,
        market: 'domestic',
        symbol,
        paper,
        quote,
      }}));
    }}
  }} else if (action === 'domestic_price') {{
    const symbol = String(payload.symbol || '005930');
    const price = await kis.getDomesticPrice(symbol, paper);
    console.log(JSON.stringify({{
      status: 'ok',
      action,
      market: 'domestic',
      symbol,
      paper,
      result: {{ price }},
    }}));
  }} else if (action === 'overseas_price') {{
    const symbol = toUpper(payload.symbol || 'AAPL');
    const result = await kis.getOverseasPrice(symbol);
    console.log(JSON.stringify({{
      status: 'ok',
      action,
      market: 'overseas',
      symbol,
      result,
    }}));
  }} else if (action === 'balance' || action === 'domestic_balance' || action === 'overseas_balance') {{
    const explicitMarket = payload.market ? String(payload.market) : null;
    const market = explicitMarket || (action === 'overseas_balance' ? 'overseas' : 'domestic');
    if (market === 'overseas') {{
      const balance = await kis.getOverseasBalance(paper);
      console.log(JSON.stringify({{
        status: 'ok',
        action,
        market,
        paper,
        balance,
      }}));
    }} else {{
      const balance = await kis.getDomesticBalance(paper);
      console.log(JSON.stringify({{
        status: 'ok',
        action,
        market: 'domestic',
        paper,
        balance,
      }}));
    }}
  }} else if (action === 'domestic_buy') {{
    const symbol = String(payload.symbol || '005930');
    const amountKrw = asNumber(payload.amountKrw ?? payload.amount, 0);
    const dryRun = payload.dryRun === true;
    const result = await kis.marketBuy(symbol, amountKrw, dryRun);
    console.log(JSON.stringify({{
      status: 'ok',
      action,
      market: 'domestic',
      symbol,
      dryRun,
      result,
    }}));
  }} else if (action === 'domestic_sell') {{
    const symbol = String(payload.symbol || '005930');
    const qty = asNumber(payload.qty, 0);
    const dryRun = payload.dryRun === true;
    const result = await kis.marketSell(symbol, qty, dryRun);
    console.log(JSON.stringify({{
      status: 'ok',
      action,
      market: 'domestic',
      symbol,
      dryRun,
      result,
    }}));
  }} else if (action === 'overseas_buy') {{
    const symbol = toUpper(payload.symbol || 'AAPL');
    const amountUsd = asNumber(payload.amountUsd ?? payload.amount, 0);
    const dryRun = payload.dryRun === true;
    const result = await kis.marketBuyOverseas(symbol, amountUsd, dryRun);
    console.log(JSON.stringify({{
      status: 'ok',
      action,
      market: 'overseas',
      symbol,
      dryRun,
      result,
    }}));
  }} else if (action === 'overseas_sell') {{
    const symbol = toUpper(payload.symbol || 'AAPL');
    const qty = asNumber(payload.qty, 0);
    const dryRun = payload.dryRun === true;
    const result = await kis.marketSellOverseas(symbol, qty, dryRun);
    console.log(JSON.stringify({{
      status: 'ok',
      action,
      market: 'overseas',
      symbol,
      dryRun,
      result,
    }}));
  }} else if (action === 'domestic_fill') {{
    const symbol = String(payload.symbol || '');
    const ordNo = String(payload.ordNo || '').trim();
    const side = String(payload.side || 'all').toUpperCase();
    if (!symbol || !ordNo) throw new Error('domestic_fill requires symbol and ordNo');
    if (typeof kis.getDomesticOrderFillByOrdNo !== 'function') {{
      throw new Error('getDomesticOrderFillByOrdNo not implemented');
    }}
    const result = await kis.getDomesticOrderFillByOrdNo({{
      symbol,
      ordNo,
      side,
      paper,
    }});
    console.log(JSON.stringify({{
      status: 'ok',
      action,
      market: 'domestic',
      symbol,
      ordNo,
      paper,
      result,
    }}));
  }} else if (action === 'overseas_fill') {{
    const symbol = toUpper(payload.symbol || '');
    const ordNo = String(payload.ordNo || '').trim();
    const side = String(payload.side || 'all').toUpperCase();
    if (!symbol || !ordNo) throw new Error('overseas_fill requires symbol and ordNo');
    if (typeof kis.getOverseasOrderFillByOrdNo !== 'function') {{
      throw new Error('getOverseasOrderFillByOrdNo not implemented');
    }}
    const result = await kis.getOverseasOrderFillByOrdNo({{
      symbol,
      ordNo,
      side,
      paper,
    }});
    console.log(JSON.stringify({{
      status: 'ok',
      action,
      market: 'overseas',
      symbol,
      ordNo,
      paper,
      result,
    }}));
  }} else if (action === 'domestic_ranking') {{
    const endpoint = String(payload.endpoint || '/uapi/domestic-stock/v1/ranking/volume');
    const trId = String(payload.trId || 'FHPST01710000');
    const params = payload.params && typeof payload.params === 'object' ? payload.params : {{}};
    const result = await kis.getDomesticRanking(endpoint, trId, params, paper);
    console.log(JSON.stringify({{
      status: 'ok',
      action,
      endpoint,
      trId,
      paper,
      result,
    }}));
  }} else if (action === 'volume_rank') {{
    const result = await kis.getVolumeRank(paper);
    console.log(JSON.stringify({{
      status: 'ok',
      action,
      paper,
      result,
    }}));
  }} else {{
    throw new Error(`unsupported action: ${{action}}`);
  }}
}} catch (error) {{
  console.error(error?.message || String(error));
  process.exit(1);
}}
"""

    try:
        proc = subprocess.run(
            ["node", "--input-type=module", "-e", node_code],
            cwd=str(ROOT),
            env=build_node_env(),
            input=bridge_input,
            capture_output=True,
            text=True,
            check=False,
            timeout=BRIDGE_SUBPROCESS_TIMEOUT_SECONDS,
            close_fds=True,
        )
    except subprocess.TimeoutExpired as exc:
        raise RuntimeError(
            f"KIS bridge timed out after {BRIDGE_SUBPROCESS_TIMEOUT_SECONDS}s"
        ) from exc
    if proc.returncode != 0:
        stderr = (proc.stderr or "").strip()
        stdout = (proc.stdout or "").strip()
        message = stderr or stdout or "node kis bridge failed"
        raise RuntimeError(message)
    return parse_json_from_mixed_stdout(proc.stdout or "")


def run_node_kis_secret_doctor() -> dict:
    node_code = """
import { initHubSecrets, isKisPaper, getTradingMode, getKisAccount, loadSecrets } from './shared/secrets.ts';

try {
  const hubSecretsLoaded = await initHubSecrets();
  const s = loadSecrets();
  const account = getKisAccount();
  const payload = {
    status: 'ok',
    action: 'doctor',
    hubSecretsLoaded: Boolean(hubSecretsLoaded),
    mode: {
      tradingMode: getTradingMode(),
      kisPaper: isKisPaper(),
    },
    secrets: {
      live: {
        appKey: Boolean(s?.kis_app_key),
        appSecret: Boolean(s?.kis_app_secret),
      },
      paper: {
        appKey: Boolean(s?.kis_paper_app_key),
        appSecret: Boolean(s?.kis_paper_app_secret),
      },
      account: {
        accountNumber: Boolean(s?.kis_account_number),
        paperAccountNumber: Boolean(s?.kis_paper_account_number),
        cano: Boolean(account?.cano),
        acntPrdtCd: Boolean(account?.acntPrdtCd),
      },
    },
    env: {
      kisMode: process.env.KIS_MODE || null,
      paperMode: process.env.PAPER_MODE || null,
    },
  };
  console.log(JSON.stringify(payload));
} catch (error) {
  console.error(error?.message || String(error));
  process.exit(1);
}
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
        message = stderr or stdout or "node kis secret doctor failed"
        raise RuntimeError(message)
    return parse_json_from_mixed_stdout(proc.stdout or "")


def build_test_payload(paper: bool = False):
    bridge = run_node_kis_bridge(
        "health",
        {
            "paper": paper,
            "domesticSymbol": "005930",
            "overseasSymbol": "AAPL",
        },
    )
    return {
        "status": "ok",
        "server": "kis-market-mcp-server",
        "mode": "test",
        "provider": "kis_client_bridge",
        "paper": paper,
        "domesticSymbol": bridge.get("domesticSymbol"),
        "overseasSymbol": bridge.get("overseasSymbol"),
        "domesticPrice": bridge.get("domesticPrice"),
        "overseasPrice": bridge.get("overseasPrice"),
        "overseasExchangeCode": bridge.get("overseasExchangeCode"),
        "checkedAt": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
    }


def run_test(args):
    try:
        payload = build_test_payload(paper=args.paper)
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
            "[KIS MCP] test ok: "
            f"domestic={payload.get('domesticSymbol')}:{payload.get('domesticPrice')} "
            f"overseas={payload.get('overseasSymbol')}:{payload.get('overseasPrice')}"
        )
    return 0


def run_quote(args):
    try:
        payload = run_node_kis_bridge(
            "quote",
            {
                "market": args.market,
                "symbol": args.symbol,
                "paper": args.paper,
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
        quote = payload.get("quote") or {}
        if args.market == "overseas":
            print(f"[KIS MCP] quote ok: {payload.get('symbol')} price={quote.get('price')} excd={quote.get('excd')}")
        else:
            print(f"[KIS MCP] quote ok: {payload.get('symbol')} price={quote.get('price')} volume={quote.get('volume')}")
    return 0


def run_balance(args):
    try:
        payload = run_node_kis_bridge(
            "balance",
            {
                "market": args.market,
                "paper": args.paper,
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
        holdings = balance.get("holdings") or []
        print(f"[KIS MCP] balance ok: market={payload.get('market')} paper={payload.get('paper')} holdings={len(holdings)}")
    return 0


def run_doctor(args):
    try:
        payload = run_node_kis_secret_doctor()
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
        live = secrets.get("live") or {}
        paper = secrets.get("paper") or {}
        account = secrets.get("account") or {}
        mode = payload.get("mode") or {}
        print(
            "[KIS MCP] doctor: "
            f"mode(trading={mode.get('tradingMode')}, kisPaper={mode.get('kisPaper')}) "
            f"live(appKey={live.get('appKey')}, appSecret={live.get('appSecret')}) "
            f"paper(appKey={paper.get('appKey')}, appSecret={paper.get('appSecret')}) "
            f"account(number={account.get('accountNumber')}, cano={account.get('cano')}, code={account.get('acntPrdtCd')})"
        )
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
        result = run_node_kis_bridge(args.bridge_action, payload)
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
        print(f"[KIS MCP] bridge ok: action={args.bridge_action}")
    return 0


def run_server(deps):
    FastMCP = deps["FastMCP"]
    if FastMCP is None:
        return emit_dependency_missing(
            ["mcp"],
            False,
            "pip3 install mcp --break-system-packages",
        )

    mcp = FastMCP("kis-market-mcp-server")

    @mcp.tool()
    def health_check(paper: bool = False) -> dict:
        try:
            return build_test_payload(paper=paper)
        except Exception as exc:
            return {"status": "error", "message": str(exc)}

    @mcp.tool()
    def get_kis_quote(market: str = "domestic", symbol: str = "005930", paper: bool = False) -> dict:
        try:
            return run_node_kis_bridge(
                "quote",
                {
                    "market": market,
                    "symbol": symbol,
                    "paper": paper,
                },
            )
        except Exception as exc:
            return {"status": "error", "message": str(exc)}

    @mcp.tool()
    def get_kis_balance(market: str = "domestic", paper: bool = False) -> dict:
        try:
            return run_node_kis_bridge(
                "balance",
                {
                    "market": market,
                    "paper": paper,
                },
            )
        except Exception as exc:
            return {"status": "error", "message": str(exc)}

    @mcp.tool()
    def get_kis_secret_status() -> dict:
        try:
            return run_node_kis_secret_doctor()
        except Exception as exc:
            return {"status": "error", "message": str(exc)}

    @mcp.tool()
    def get_kis_order_fill(
        market: str = "domestic",
        symbol: str = "005930",
        ord_no: str = "",
        side: str = "all",
        paper: bool = False,
    ) -> dict:
        action = "overseas_fill" if market == "overseas" else "domestic_fill"
        try:
            return run_node_kis_bridge(
                action,
                {
                    "market": market,
                    "symbol": symbol,
                    "ordNo": ord_no,
                    "side": side,
                    "paper": paper,
                },
            )
        except Exception as exc:
            return {"status": "error", "message": str(exc)}

    # This local bridge deliberately supports stdio only. Remote HTTP/SSE requires
    # a separate authenticated deployment contract and is not enabled here.
    mcp.run(transport="stdio")
    return 0


def main():
    parser = argparse.ArgumentParser(description="KIS Market MCP 서버")
    parser.add_argument("--test", action="store_true", help="KIS 브리지 헬스체크")
    parser.add_argument("--doctor", action="store_true", help="KIS 시크릿/환경 진단 (API 호출 없음)")
    parser.add_argument("--quote", action="store_true", help="KIS 시세 조회")
    parser.add_argument("--balance", action="store_true", help="KIS 잔고 조회")
    parser.add_argument("--bridge-action", default="", help="내부 브리지 액션 직접 실행 (JSON 출력 권장)")
    parser.add_argument("--payload-json", default="", help="bridge-action payload JSON 문자열")
    parser.add_argument("--market", choices=["domestic", "overseas"], default="domestic")
    parser.add_argument("--symbol", default="005930")
    parser.add_argument("--paper", action="store_true")
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
    if args.bridge_action:
        return run_bridge_action(args)

    return run_server(deps)


if __name__ == "__main__":
    sys.exit(main())
