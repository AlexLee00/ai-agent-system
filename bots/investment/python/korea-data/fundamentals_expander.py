#!/usr/bin/env python3
"""
Fundamentals Expander — KOSPI 전 종목 펀더멘털 자동 확장
마스터 목표: corp_fundamentals 245건 → 5,000+ 종목

실행: launchd ai.luna.fundamentals-expander-daily.plist
     또는 python3 fundamentals_expander.py [--limit N] [--batch-size N]
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
from datetime import datetime
from typing import Optional

import psycopg2
import psycopg2.extras
import requests

# ─── 설정 ────────────────────────────────────────────────────

OPENDART_API_KEY = os.environ.get("OPENDART_API_KEY", "")
OPENDART_BASE_URL = os.environ.get("OPENDART_BASE_URL", "https://opendart.fss.or.kr/api")
PG_DSN = os.environ.get(
    "PG_DSN",
    "host=localhost port=5432 dbname=jay user=postgres"
)

# 일일 처리 한도 (기본 200건 — API 부하 제한)
DEFAULT_DAILY_LIMIT = 200
DEFAULT_BATCH_SIZE = 20
API_DELAY_SECONDS = 0.5    # API 호출 간 딜레이

# 최신 보고서 코드 (연간 11011, Q1 11013, Q2 11012, Q3 11014)
REPRT_CODES = ["11011", "11013", "11012", "11014"]
CURRENT_YEAR = str(datetime.now().year)

# ─── DB 헬퍼 ─────────────────────────────────────────────────

def get_db_conn():
    return psycopg2.connect(PG_DSN)

def get_symbols_without_fundamentals(conn, limit: int) -> list[dict]:
    """corp_financial_reports에 있지만 corp_fundamentals에 없는 종목"""
    with conn.cursor(cursor_factory=psycopg2.extras.DictCursor) as cur:
        cur.execute("""
            SELECT DISTINCT
                cfr.stock_code,
                cfr.corp_code,
                cfr.company_name,
                cfr.bsns_year,
                cfr.reprt_code
            FROM investment.corp_financial_reports cfr
            LEFT JOIN investment.corp_fundamentals cf
                ON cf.stock_code = cfr.stock_code
                AND cf.bsns_year = cfr.bsns_year
                AND cf.reprt_code = cfr.reprt_code
            WHERE cf.id IS NULL
              AND cfr.stock_code IS NOT NULL
              AND cfr.stock_code != ''
            ORDER BY cfr.bsns_year DESC, cfr.stock_code
            LIMIT %s
        """, (limit,))
        return [dict(row) for row in cur.fetchall()]

def upsert_fundamentals(conn, data: dict) -> bool:
    """corp_fundamentals UPSERT"""
    try:
        with conn.cursor() as cur:
            cur.execute("""
                INSERT INTO investment.corp_fundamentals (
                    stock_code, corp_code, company_name, bsns_year, reprt_code,
                    per, pbr, roe, roa, eps, bps,
                    market_cap, debt_ratio, current_ratio,
                    operating_margin, net_margin,
                    revenue_growth, updated_at
                ) VALUES (
                    %(stock_code)s, %(corp_code)s, %(company_name)s,
                    %(bsns_year)s, %(reprt_code)s,
                    %(per)s, %(pbr)s, %(roe)s, %(roa)s, %(eps)s, %(bps)s,
                    %(market_cap)s, %(debt_ratio)s, %(current_ratio)s,
                    %(operating_margin)s, %(net_margin)s,
                    %(revenue_growth)s, NOW()
                )
                ON CONFLICT (stock_code, bsns_year, reprt_code)
                DO UPDATE SET
                    per = EXCLUDED.per,
                    pbr = EXCLUDED.pbr,
                    roe = EXCLUDED.roe,
                    roa = EXCLUDED.roa,
                    eps = EXCLUDED.eps,
                    bps = EXCLUDED.bps,
                    market_cap = EXCLUDED.market_cap,
                    debt_ratio = EXCLUDED.debt_ratio,
                    current_ratio = EXCLUDED.current_ratio,
                    operating_margin = EXCLUDED.operating_margin,
                    net_margin = EXCLUDED.net_margin,
                    revenue_growth = EXCLUDED.revenue_growth,
                    updated_at = NOW()
            """, data)
        conn.commit()
        return True
    except Exception as e:
        conn.rollback()
        print(f"[FundamentalsExpander] DB 오류 ({data.get('stock_code')}): {e}", file=sys.stderr)
        return False

# ─── OpenDART API 호출 ────────────────────────────────────────

def fetch_finstate_from_reports(corp_code: str, bsns_year: str, reprt_code: str) -> Optional[dict]:
    """corp_financial_reports에서 직접 집계 (API 추가 호출 없이)"""
    # 이미 DB에 재무보고서 데이터가 있으므로 DB에서 계산
    return None


def calc_fundamentals_from_db(conn, stock_code: str, bsns_year: str, reprt_code: str) -> Optional[dict]:
    """corp_financial_reports 데이터로 펀더멘털 지표 계산"""
    with conn.cursor(cursor_factory=psycopg2.extras.DictCursor) as cur:
        cur.execute("""
            SELECT account_nm, account_id, thstrm_amount, frmtrm_amount, sj_div, fs_div
            FROM investment.corp_financial_reports
            WHERE stock_code = %s AND bsns_year = %s AND reprt_code = %s
        """, (stock_code, bsns_year, reprt_code))
        rows = cur.fetchall()

    if not rows:
        return None

    # 계정과목 매핑
    amounts: dict[str, float] = {}
    for row in rows:
        acct = row["account_nm"] or row["account_id"] or ""
        try:
            val = float(str(row["thstrm_amount"]).replace(",", "") or 0)
            amounts[acct] = val
        except (ValueError, TypeError):
            pass

    # 핵심 지표 추출 (계정과목명 유사성 기반)
    def find(keywords: list[str], default=0.0) -> float:
        for key, val in amounts.items():
            for kw in keywords:
                if kw in key:
                    return val
        return default

    revenue = find(["매출액", "영업수익"])
    op_income = find(["영업이익"])
    net_income = find(["당기순이익"])
    total_assets = find(["자산총계", "총자산"])
    total_equity = find(["자본총계", "총자본"])
    total_debt = find(["부채총계", "총부채"])

    # 비율 계산 (0 나누기 방지)
    def safe_div(a, b, default=None):
        return (a / b) if b and b != 0 else default

    roe = safe_div(net_income, total_equity)
    roa = safe_div(net_income, total_assets)
    debt_ratio = safe_div(total_debt, total_equity)
    operating_margin = safe_div(op_income, revenue)
    net_margin = safe_div(net_income, revenue)

    return {
        "roe": round(roe * 100, 2) if roe is not None else None,
        "roa": round(roa * 100, 2) if roa is not None else None,
        "debt_ratio": round(debt_ratio * 100, 2) if debt_ratio is not None else None,
        "operating_margin": round(operating_margin * 100, 2) if operating_margin is not None else None,
        "net_margin": round(net_margin * 100, 2) if net_margin is not None else None,
    }


def fetch_fnltt_from_dart(corp_code: str, bsns_year: str, reprt_code: str) -> Optional[dict]:
    """OpenDART fnlttSinglAcnt API로 PER/EPS 등 조회"""
    if not OPENDART_API_KEY:
        return None

    url = f"{OPENDART_BASE_URL}/fnlttSinglAcnt.json"
    params = {
        "crtfc_key": OPENDART_API_KEY,
        "corp_code": corp_code,
        "bsns_year": bsns_year,
        "reprt_code": reprt_code,
        "fs_div": "CFS",  # 연결재무제표
    }

    try:
        resp = requests.get(url, params=params, timeout=10)
        resp.raise_for_status()
        data = resp.json()

        if data.get("status") != "000":
            return None

        result: dict = {}
        for item in (data.get("list") or []):
            acct = item.get("account_nm", "")
            val_str = str(item.get("thstrm_amount", "") or "").replace(",", "")
            try:
                val = float(val_str) if val_str else None
            except ValueError:
                val = None

            if "주당순이익" in acct and val is not None:
                result["eps"] = val
            elif "주당순자산" in acct and val is not None:
                result["bps"] = val

        return result if result else None
    except Exception as e:
        print(f"[FundamentalsExpander] DART API 오류 ({corp_code}): {e}", file=sys.stderr)
        return None

# ─── 메인 ─────────────────────────────────────────────────────

def expand_fundamentals(limit: int = DEFAULT_DAILY_LIMIT, batch_size: int = DEFAULT_BATCH_SIZE):
    print(f"[FundamentalsExpander] 시작 — 한도={limit}, 배치={batch_size}")

    conn = get_db_conn()
    symbols = get_symbols_without_fundamentals(conn, limit)
    print(f"[FundamentalsExpander] 처리 대상: {len(symbols)}종목")

    success = 0
    failed = 0

    for i, sym in enumerate(symbols):
        stock_code = sym["stock_code"]
        corp_code = sym["corp_code"]
        bsns_year = sym["bsns_year"]
        reprt_code = sym["reprt_code"]
        company_name = sym["company_name"]

        # DB 기반 지표 계산
        calc = calc_fundamentals_from_db(conn, stock_code, bsns_year, reprt_code)

        # DART API로 EPS/BPS 추가 (API 키 있는 경우)
        dart_extra = {}
        if corp_code and OPENDART_API_KEY:
            dart_extra = fetch_fnltt_from_dart(corp_code, bsns_year, reprt_code) or {}
            time.sleep(API_DELAY_SECONDS)

        data = {
            "stock_code": stock_code,
            "corp_code": corp_code or "",
            "company_name": company_name or "",
            "bsns_year": bsns_year,
            "reprt_code": reprt_code,
            "per": None,   # 시가총액 없이는 계산 불가
            "pbr": None,
            "roe": (calc or {}).get("roe"),
            "roa": (calc or {}).get("roa"),
            "eps": dart_extra.get("eps"),
            "bps": dart_extra.get("bps"),
            "market_cap": None,
            "debt_ratio": (calc or {}).get("debt_ratio"),
            "current_ratio": None,
            "operating_margin": (calc or {}).get("operating_margin"),
            "net_margin": (calc or {}).get("net_margin"),
            "revenue_growth": None,
        }

        if upsert_fundamentals(conn, data):
            success += 1
            if (i + 1) % batch_size == 0:
                print(f"[FundamentalsExpander] 진행: {i+1}/{len(symbols)} (성공 {success}, 실패 {failed})")
        else:
            failed += 1

    conn.close()
    print(f"[FundamentalsExpander] 완료 — 성공={success}, 실패={failed}")
    return success, failed


def main():
    parser = argparse.ArgumentParser(description="Luna Fundamentals Expander")
    parser.add_argument("--limit", type=int, default=DEFAULT_DAILY_LIMIT, help="일일 처리 한도")
    parser.add_argument("--batch-size", type=int, default=DEFAULT_BATCH_SIZE, help="배치 크기")
    args = parser.parse_args()

    success, failed = expand_fundamentals(limit=args.limit, batch_size=args.batch_size)
    sys.exit(0 if failed == 0 else 1)


if __name__ == "__main__":
    main()
