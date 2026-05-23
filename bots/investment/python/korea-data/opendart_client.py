#!/usr/bin/env python3
"""Open DART adapter for Luna.

This adapter is optional. It uses dart-fss when installed, but always supports
`--doctor` without importing the package so launchd/smoke can verify readiness
without mutating the Python environment.
"""

from __future__ import annotations

import argparse
import io
import json
import os
import sys
import urllib.parse
import urllib.request
import zipfile
import xml.etree.ElementTree as ET
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


def _resolve_base_url() -> str:
    return (
        os.environ.get("OPENDART_BASE_URL")
        or os.environ.get("OPEN_DART_BASE_URL")
        or "https://opendart.fss.or.kr/api"
    ).strip().rstrip("/")


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
        "corpCodeXmlFallbackAvailable": True,
        "apiKey": _redacted_presence(api_key),
        "shadowOnly": True,
        "installHint": "python3 -m pip install -r bots/investment/python/korea-data/requirements.txt",
    }


def _download_corp_code_rows(api_key: str) -> list[Dict[str, Any]]:
    base_url = _resolve_base_url()
    params = urllib.parse.urlencode({"crtfc_key": api_key})
    url = f"{base_url}/corpCode.xml?{params}"
    with urllib.request.urlopen(url, timeout=20) as response:  # noqa: S310 - official OpenDART HTTPS endpoint
        payload = response.read()
    with zipfile.ZipFile(io.BytesIO(payload)) as archive:
        xml_name = next((name for name in archive.namelist() if name.lower().endswith(".xml")), None)
        if not xml_name:
            raise RuntimeError("corp_code_xml_missing_in_zip")
        xml_bytes = archive.read(xml_name)
    root = ET.fromstring(xml_bytes)
    rows: list[Dict[str, Any]] = []
    for item in root.findall(".//list"):
        row = {child.tag: (child.text or "").strip() for child in list(item)}
        if row.get("stock_code"):
            rows.append({
                "corpCode": row.get("corp_code", ""),
                "corpName": row.get("corp_name", ""),
                "stockCode": row.get("stock_code", ""),
                "modifyDate": row.get("modify_date", ""),
            })
    return rows


def _company_from_corp_code_xml(args: argparse.Namespace, api_key: str) -> Dict[str, Any]:
    rows = _download_corp_code_rows(api_key)
    stock_code = (args.stock_code or "").strip()
    name = (args.name or "").strip()
    match = None
    if stock_code:
        match = next((row for row in rows if row.get("stockCode") == stock_code), None)
    if match is None and name:
        match = next((row for row in rows if name in row.get("corpName", "")), None)
    if match is None:
        return {"ok": False, "error": "corp_code_not_found", "stockCode": stock_code, "name": name}
    return {
        "ok": True,
        "adapter": "opendart_corpcode_xml",
        "corpCode": match.get("corpCode"),
        "stockCode": match.get("stockCode"),
        "corpName": match.get("corpName"),
        "modifyDate": match.get("modifyDate"),
        "shadowOnly": True,
    }


def run_corp_code_map(args: argparse.Namespace) -> Dict[str, Any]:
    api_key = _resolve_api_key()
    symbols = {
        item.strip()
        for item in (args.symbols or "").replace("\n", ",").split(",")
        if item.strip()
    }
    if not api_key:
        return {"ok": False, "error": "missing_opendart_api_key", "rows": []}
    try:
        rows = _download_corp_code_rows(api_key)
    except Exception as exc:  # pragma: no cover - network dependent
        return {"ok": False, "error": "corp_code_xml_fetch_failed", "detail": str(exc), "rows": []}
    filtered = [row for row in rows if not symbols or row.get("stockCode") in symbols]
    return {
        "ok": True,
        "adapter": "opendart_corpcode_xml",
        "rows": filtered,
        "rowCount": len(filtered),
        "requestedSymbols": sorted(symbols),
        "shadowOnly": True,
    }


def run_company(args: argparse.Namespace) -> Dict[str, Any]:
    dart, import_error = _import_dart_fss()
    api_key = _resolve_api_key()
    if not api_key:
        return {"ok": False, "error": "missing_opendart_api_key"}
    if dart is not None:
        try:
            dart.set_api_key(api_key=api_key)
            corp_list = dart.get_corp_list()
            corp = corp_list.find_by_stock_code(args.stock_code) if args.stock_code else corp_list.find_by_corp_name(args.name, exactly=False)[0]
            return {
                "ok": True,
                "adapter": "dart_fss",
                "corpCode": getattr(corp, "corp_code", None),
                "stockCode": getattr(corp, "stock_code", None),
                "corpName": getattr(corp, "corp_name", None),
                "shadowOnly": True,
            }
        except Exception as exc:  # pragma: no cover - network/env dependent
            import_error = str(exc)
    fallback = _company_from_corp_code_xml(args, api_key)
    if not fallback.get("ok") and import_error:
        fallback["dartFssError"] = import_error
    return fallback


def main() -> int:
    parser = argparse.ArgumentParser(description="Luna Open DART dart-fss adapter")
    parser.add_argument("--doctor", action="store_true")
    parser.add_argument("--company", action="store_true")
    parser.add_argument("--corp-code-map", action="store_true")
    parser.add_argument("--stock-code", default="")
    parser.add_argument("--name", default="")
    parser.add_argument("--symbols", default="")
    parser.add_argument("--json", action="store_true")
    args = parser.parse_args()

    if args.corp_code_map:
        result = run_corp_code_map(args)
    elif args.company:
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
