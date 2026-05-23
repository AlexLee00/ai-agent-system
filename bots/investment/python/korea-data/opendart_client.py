#!/usr/bin/env python3
"""Open DART adapter for Luna.

This adapter is optional. It uses dart-fss when installed, but always supports
`--doctor` without importing the package so launchd/smoke can verify readiness
without mutating the Python environment.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from typing import Any, Dict


def _redacted_presence(value: str | None) -> Dict[str, Any]:
    return {
        "present": bool(value and not value.startswith("<") and not value.upper().startswith("TODO")),
        "valueRedacted": True,
    }


def _resolve_api_key() -> str:
    return (
        os.environ.get("OPENDART_API_KEY")
        or os.environ.get("OPEN_DART_API_KEY")
        or os.environ.get("DART_API_KEY")
        or ""
    ).strip()


def _import_dart_fss():
    try:
        import dart_fss as dart  # type: ignore
        return dart, None
    except Exception as exc:  # pragma: no cover - depends on local env
        return None, str(exc)


def run_doctor() -> Dict[str, Any]:
    dart, import_error = _import_dart_fss()
    api_key = _resolve_api_key()
    return {
        "ok": True,
        "adapter": "opendart_dart_fss",
        "dartFssAvailable": dart is not None,
        "dartFssImportError": import_error,
        "apiKey": _redacted_presence(api_key),
        "shadowOnly": True,
        "installHint": "python3 -m pip install -r bots/investment/python/korea-data/requirements.txt",
    }


def run_company(args: argparse.Namespace) -> Dict[str, Any]:
    dart, import_error = _import_dart_fss()
    api_key = _resolve_api_key()
    if dart is None:
        return {"ok": False, "error": "dart_fss_missing", "detail": import_error}
    if not api_key:
        return {"ok": False, "error": "missing_opendart_api_key"}
    dart.set_api_key(api_key=api_key)
    corp_list = dart.get_corp_list()
    corp = corp_list.find_by_stock_code(args.stock_code) if args.stock_code else corp_list.find_by_corp_name(args.name, exactly=False)[0]
    return {
        "ok": True,
        "corpCode": getattr(corp, "corp_code", None),
        "stockCode": getattr(corp, "stock_code", None),
        "corpName": getattr(corp, "corp_name", None),
        "shadowOnly": True,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="Luna Open DART dart-fss adapter")
    parser.add_argument("--doctor", action="store_true")
    parser.add_argument("--company", action="store_true")
    parser.add_argument("--stock-code", default="")
    parser.add_argument("--name", default="")
    parser.add_argument("--json", action="store_true")
    args = parser.parse_args()

    if args.company:
        result = run_company(args)
    else:
        result = run_doctor()

    if args.json:
        print(json.dumps(result, ensure_ascii=False, indent=2))
    else:
        print(result)
    return 0 if result.get("ok") else 1


if __name__ == "__main__":
    sys.exit(main())
