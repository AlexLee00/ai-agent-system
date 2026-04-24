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
    payload_json = json.dumps(payload or {}, ensure_ascii=False)
    node_code = f"""
import * as kis from './shared/kis-client.ts';
import {{ initHubSecrets }} from './shared/secrets.ts';

const action = {json.dumps(action)};
const payload = {payload_json};
const paper = payload.paper === true;

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
  }} else if (action === 'quote') {{
    const market = String(payload.market || 'domestic');
    const symbol = String(payload.symbol || (market === 'overseas' ? 'AAPL' : '005930')).toUpperCase();
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
  }} else if (action === 'balance') {{
    const market = String(payload.market || 'domestic');
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
  }} else {{
    throw new Error(`unsupported action: ${{action}}`);
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

    mcp.run()
    return 0


def main():
    parser = argparse.ArgumentParser(description="KIS Market MCP 서버")
    parser.add_argument("--test", action="store_true", help="KIS 브리지 헬스체크")
    parser.add_argument("--doctor", action="store_true", help="KIS 시크릿/환경 진단 (API 호출 없음)")
    parser.add_argument("--quote", action="store_true", help="KIS 시세 조회")
    parser.add_argument("--balance", action="store_true", help="KIS 잔고 조회")
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

    return run_server(deps)


if __name__ == "__main__":
    sys.exit(main())
