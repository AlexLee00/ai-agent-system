#!/usr/bin/env python3
"""
Toss Market Intel MCP 서버.

사용법:
  # 서버 모드 (MCP 클라이언트 연결)
  python3 scripts/toss-market-mcp-server.py

  # 의존성/브리지 테스트
  python3 scripts/toss-market-mcp-server.py --test [--json]

  # 구조화된 토스 인텔 직접 조회
  python3 scripts/toss-market-mcp-server.py --intel [--dry-run] [--json] [--limit 10]

메모:
  - 실제 데이터 수집은 기존 Node collector(collectTossMarketIntel)를 subprocess로 호출한다.
  - MCP 서버 모드는 python `mcp` 패키지가 필요하다.
"""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path


ROOT = Path(__file__).resolve().parent.parent


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


def run_node_toss_intel(dry_run: bool = False, limit: int = 10, headless: bool = True) -> dict:
    node_code = f"""
import {{ collectTossMarketIntel }} from './team/toss-market-intel.ts';
const result = await collectTossMarketIntel({{
  dryRun: {str(dry_run).lower()},
  limit: {int(limit)},
  headless: {str(headless).lower()},
}});
console.log(JSON.stringify(result));
"""
    proc = subprocess.run(
        ["node", "--input-type=module", "-e", node_code],
        cwd=str(ROOT),
        capture_output=True,
        text=True,
        check=False,
    )
    if proc.returncode != 0:
        stderr = (proc.stderr or "").strip()
        stdout = (proc.stdout or "").strip()
        message = stderr or stdout or "node toss collector failed"
        raise RuntimeError(message)
    output = (proc.stdout or "").strip()
    if not output:
        raise RuntimeError("empty response from toss collector")
    return json.loads(output)


def build_test_payload():
    result = run_node_toss_intel(dry_run=True, limit=5, headless=True)
    return {
        "status": "ok",
        "server": "toss-market-mcp-server",
        "mode": "test",
        "provider": "toss_web_bridge",
        "quality": result.get("quality", {}),
        "signals": len(result.get("signals", []) or []),
        "sectionCounts": result.get("sectionCounts", {}),
        "checkedAt": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
    }


def run_test(args):
    try:
        payload = build_test_payload()
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
        print(f"[Toss MCP] test ok: signals={payload['signals']}")
        print(f"  quality: {payload['quality'].get('status')}")
        print(f"  sections: {payload['sectionCounts']}")
    return 0


def run_intel(args):
    try:
        payload = run_node_toss_intel(
            dry_run=args.dry_run,
            limit=args.limit,
            headless=not args.no_headless,
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
        print(f"[Toss MCP] intel ok: {payload.get('quality', {}).get('status')} signals={len(payload.get('signals', []) or [])}")
    return 0


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--test", action="store_true")
    parser.add_argument("--intel", action="store_true")
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--json", action="store_true")
    parser.add_argument("--limit", type=int, default=10)
    parser.add_argument("--no-headless", action="store_true")
    args = parser.parse_args()

    deps = load_optional_deps()

    if args.test:
        return run_test(args)
    if args.intel:
        return run_intel(args)

    if deps["FastMCP"] is None:
        return emit_dependency_missing(
            ["mcp"],
            args.json,
            "pip3 install mcp --break-system-packages",
        )

    FastMCP = deps["FastMCP"]
    mcp = FastMCP("toss-market-mcp-server")

    @mcp.tool()
    def health_check() -> dict:
      return build_test_payload()

    @mcp.tool()
    def collect_toss_market_intel(dry_run: bool = False, limit: int = 10, headless: bool = True) -> dict:
      return run_node_toss_intel(dry_run=dry_run, limit=limit, headless=headless)

    @mcp.tool()
    def get_toss_screening_candidates(dry_run: bool = False, limit: int = 10, headless: bool = True) -> dict:
      payload = run_node_toss_intel(dry_run=dry_run, limit=limit, headless=headless)
      return {
          "source": payload.get("source"),
          "fetchedAt": payload.get("fetchedAt"),
          "quality": payload.get("quality"),
          "signals": payload.get("signals", []),
      }

    @mcp.tool()
    def get_toss_sections(dry_run: bool = False, limit: int = 10, headless: bool = True) -> dict:
      payload = run_node_toss_intel(dry_run=dry_run, limit=limit, headless=headless)
      return {
          "source": payload.get("source"),
          "fetchedAt": payload.get("fetchedAt"),
          "quality": payload.get("quality"),
          "sectionCounts": payload.get("sectionCounts", {}),
          "sections": payload.get("sections", {}),
      }

    mcp.run()
    return 0


if __name__ == "__main__":
    sys.exit(main())
