#!/usr/bin/env python3
"""
FinRL-X Layer 3: Strategy Evolution
2026 트렌드: Continual Strategy Evolution + Memory-Augmented

자율 전략 진화:
  1. 성과 측정 → 하위 전략 식별
  2. Mutation 생성 (파라미터 조정)
  3. Shadow 검증
  4. DB strategy_mutation_events 기록
"""

from __future__ import annotations

import json
import os
import sys
from dataclasses import dataclass, field
from typing import Any, Literal, Optional
import random

import psycopg2
import psycopg2.extras

PG_DSN = os.environ.get("PG_DSN", "dbname=jay")

MutationType = Literal["tp_sl_adjust", "confidence_relax", "confidence_tighten", "regime_filter", "timeframe_shift"]


@dataclass
class StrategyCandidate:
    setup_type: str
    market: str
    avg_quality_score: float
    trade_count: int
    current_params: dict[str, Any] = field(default_factory=dict)


@dataclass
class MutationEvent:
    candidate: StrategyCandidate
    mutation_type: MutationType
    old_params: dict[str, Any]
    new_params: dict[str, Any]
    expected_improvement: float
    rationale: str


# ─── 성과 미달 전략 식별 ─────────────────────────────────────

def fetch_underperforming_strategies(conn, market: str, min_trades: int = 3) -> list[StrategyCandidate]:
    """최근 14일 성과 하위 전략 조회"""
    exchange = "binance" if market == "crypto" else "kis" if market in {"stocks", "overseas"} else market
    with conn.cursor(cursor_factory=psycopg2.extras.DictCursor) as cur:
        cur.execute("""
            SELECT
                sp.setup_type,
                sp.exchange AS market,
                AVG(sp.strategy_quality_score) AS avg_score,
                COUNT(*) AS trade_count
            FROM investment.position_strategy_profiles sp
            WHERE sp.exchange = %s
              AND sp.created_at >= NOW() - INTERVAL '14 days'
            GROUP BY sp.setup_type, sp.exchange
            HAVING COUNT(*) >= %s
               AND (AVG(sp.strategy_quality_score) < 0.45 OR AVG(sp.strategy_quality_score) IS NULL)
            ORDER BY AVG(sp.strategy_quality_score) ASC NULLS FIRST
            LIMIT 10
        """, (exchange, min_trades))
        rows = cur.fetchall()

    return [
        StrategyCandidate(
            setup_type=row["setup_type"],
            market=row["market"],
            avg_quality_score=float(row["avg_score"] or 0),
            trade_count=int(row["trade_count"] or 0),
        )
        for row in rows
    ]


# ─── Mutation 생성 ────────────────────────────────────────────

def generate_mutation(candidate: StrategyCandidate) -> Optional[MutationEvent]:
    """전략 성과에 따른 적절한 변이 생성"""
    score = candidate.avg_quality_score

    # 점수대별 mutation 전략
    if score < 0.25:
        # 심각 부진 → 레짐 필터 강화
        mutation_type: MutationType = "regime_filter"
        old_params = {"regime_filter": "none"}
        new_params = {"regime_filter": "trend_only"}
        expected = 0.15
        rationale = f"성과 {score:.2f} < 0.25 — 레짐 필터 강화"

    elif score < 0.35:
        # 부진 → 신뢰도 임계값 강화
        mutation_type = "confidence_tighten"
        old_params = {"confidence_threshold": 0.55}
        new_params = {"confidence_threshold": 0.65}
        expected = 0.10
        rationale = f"성과 {score:.2f} < 0.35 — 신뢰도 기준 강화"

    elif score < 0.45:
        # 보통 부진 → TP/SL 조정
        tp_delta = random.uniform(0.01, 0.02)
        sl_delta = random.uniform(0.005, 0.015)
        mutation_type = "tp_sl_adjust"
        old_params = {"tp_pct": 0.03, "sl_pct": 0.015}
        new_params = {"tp_pct": round(0.03 + tp_delta, 4), "sl_pct": round(0.015 + sl_delta, 4)}
        expected = 0.05
        rationale = f"성과 {score:.2f} < 0.45 — TP/SL 소폭 확대"

    else:
        return None   # 변이 불필요

    return MutationEvent(
        candidate=candidate,
        mutation_type=mutation_type,
        old_params=old_params,
        new_params=new_params,
        expected_improvement=expected,
        rationale=rationale,
    )


# ─── Shadow 검증 ─────────────────────────────────────────────

def validate_mutation_in_shadow(mutation: MutationEvent, recent_scores: list[float]) -> bool:
    """간단한 Shadow 검증 — 최근 성과 트렌드 확인"""
    if not recent_scores:
        return True  # 데이터 없으면 일단 적용

    trend = recent_scores[-1] - recent_scores[0] if len(recent_scores) >= 2 else 0
    # 하락 트렌드일 때만 변이 허용
    return trend <= 0 or mutation.expected_improvement > 0.12


# ─── DB 기록 ─────────────────────────────────────────────────

def record_mutation_event(conn, mutation: MutationEvent) -> bool:
    """strategy_mutation_events에 기록"""
    try:
        with conn.cursor() as cur:
            cur.execute("""
                INSERT INTO investment.strategy_mutation_events (
                    event_type, lifecycle_phase,
                    old_setup_type, new_setup_type,
                    validity_score, predictive_score,
                    created_at
                ) VALUES (%s, %s, %s, %s, %s, %s, NOW())
            """, (
                mutation.mutation_type,
                "shadow",
                mutation.candidate.setup_type,
                json.dumps({
                    "mutation_type": mutation.mutation_type,
                    "new_params": mutation.new_params,
                    "rationale": mutation.rationale,
                }),
                mutation.candidate.avg_quality_score,
                mutation.candidate.avg_quality_score + mutation.expected_improvement,
            ))
        conn.commit()
        return True
    except Exception as e:
        conn.rollback()
        print(f"[Layer3] mutation 기록 오류: {e}", file=sys.stderr)
        return False


# ─── 메인 진화 루프 ──────────────────────────────────────────

def run_strategy_evolution(market: str, dry_run: bool = False) -> dict:
    """전략 진화 실행"""
    print(f"[StrategyEvolution] {market} 시작 (dry_run={dry_run})")

    conn = psycopg2.connect(PG_DSN)
    candidates = fetch_underperforming_strategies(conn, market)
    print(f"[StrategyEvolution] 부진 전략 {len(candidates)}개 발견")

    mutations_generated = 0
    mutations_applied = 0

    for candidate in candidates:
        mutation = generate_mutation(candidate)
        if mutation is None:
            continue

        mutations_generated += 1

        # Shadow 검증 (최근 점수 임시 리스트)
        recent = [candidate.avg_quality_score] * 3  # 실제로는 DB에서 조회
        validated = validate_mutation_in_shadow(mutation, recent)

        if not validated:
            print(f"[StrategyEvolution] {candidate.setup_type}: shadow 검증 실패 — 건너뜀")
            continue

        if not dry_run:
            success = record_mutation_event(conn, mutation)
            if success:
                mutations_applied += 1
                print(f"[StrategyEvolution] ✅ {candidate.setup_type}: {mutation.mutation_type} 적용")
        else:
            mutations_applied += 1
            print(f"[StrategyEvolution] [DRY] {candidate.setup_type}: {mutation.mutation_type} → {mutation.new_params}")

    conn.close()

    result = {
        "market": market,
        "candidates_found": len(candidates),
        "mutations_generated": mutations_generated,
        "mutations_applied": mutations_applied,
    }
    print(f"[StrategyEvolution] 완료: {result}")
    return result


if __name__ == "__main__":
    import argparse
    parser = argparse.ArgumentParser()
    parser.add_argument("--market", default="crypto", choices=["crypto", "stocks", "overseas"])
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()

    run_strategy_evolution(args.market, dry_run=args.dry_run)
