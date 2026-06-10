#!/usr/bin/env python3
"""
FinRL-X Layer 4: Performance Optimization
시스템 레벨 최적화 — 에이전트 풀 + 환경 + 전략 통합 성과 관리

기능:
  - 에이전트별 성과 리포트
  - 환경(레짐) 적합성 평가
  - 최적 에이전트 조합 추천
  - M4 Max 36GB 활용 비용 모니터링
"""

from __future__ import annotations

import os
import sys
from dataclasses import dataclass
from typing import Any, Optional

import psycopg2
import psycopg2.extras

PG_DSN = os.environ.get("PG_DSN", "dbname=jay")


@dataclass
class SystemPerformanceReport:
    date: str
    market: str
    total_trades: int
    avg_quality_score: float
    best_agent_combo: list[str]
    regime_fit_score: float       # 현재 전략이 현재 레짐에 맞는 정도 (0~1)
    recommended_mutations: list[str]
    llm_cost_usd: float
    summary: str


def fetch_agent_performance(conn, market: str, days: int = 7) -> list[dict]:
    """에이전트별 최근 N일 성과"""
    with conn.cursor(cursor_factory=psycopg2.extras.DictCursor) as cur:
        cur.execute("""
            SELECT
                agent_name,
                market,
                current_level,
                invocation_count,
                success_count,
                CASE WHEN invocation_count > 0
                     THEN ROUND(success_count::numeric / invocation_count, 3)
                     ELSE 0 END AS success_rate
            FROM investment.agent_curriculum_state
            WHERE market = %s
            ORDER BY success_count DESC
        """, (market,))
        return [dict(row) for row in cur.fetchall()]


def fetch_llm_cost_today(conn) -> float:
    """오늘 LLM 비용 합계"""
    try:
        with conn.cursor() as cur:
            cur.execute("""
                SELECT COALESCE(SUM(cost_usd), 0) AS total_cost
                FROM investment.llm_routing_log
                WHERE created_at >= CURRENT_DATE
            """)
            return float(cur.fetchone()[0] or 0)
    except Exception:
        return 0.0


def fetch_regime_distribution(conn, market: str, days: int = 7) -> dict[str, int]:
    """최근 N일 레짐 분포"""
    try:
        with conn.cursor(cursor_factory=psycopg2.extras.DictCursor) as cur:
            cur.execute("""
                SELECT
                    evidence_snapshot->>'regime' AS regime,
                    COUNT(*) AS cnt
                FROM investment.position_signal_history
                WHERE market = %s
                  AND created_at >= NOW() - (%s || ' days')::interval
                  AND evidence_snapshot->>'regime' IS NOT NULL
                GROUP BY evidence_snapshot->>'regime'
                ORDER BY cnt DESC
            """, (market, str(days)))
            return {row["regime"]: int(row["cnt"]) for row in cur.fetchall()}
    except Exception:
        return {}


def calc_regime_fit_score(regime_dist: dict[str, int], current_strategies: list[str]) -> float:
    """레짐 분포와 현재 전략의 적합도 (0~1)"""
    if not regime_dist:
        return 0.5

    dominant_regime = max(regime_dist, key=regime_dist.get) if regime_dist else "unknown"
    total = sum(regime_dist.values()) or 1
    dominant_ratio = regime_dist.get(dominant_regime, 0) / total

    # 전략이 레짐에 맞는지 단순 체크
    regime_strategy_map = {
        "bull": ["momentum", "breakout", "trend"],
        "bear": ["defensive", "short", "hedge"],
        "sideways": ["mean_reversion", "range", "stat_arb"],
        "volatile": ["volatility", "option", "hedge"],
    }
    aligned_keywords = regime_strategy_map.get(dominant_regime, [])
    strategy_fit = any(
        any(kw in s.lower() for kw in aligned_keywords)
        for s in current_strategies
    )

    base_score = dominant_ratio * 0.6
    fit_bonus = 0.4 if strategy_fit else 0.0
    return min(1.0, base_score + fit_bonus)


def select_best_agent_combo(agents: list[dict], top_n: int = 5) -> list[str]:
    """성과 기반 최적 에이전트 조합 선택"""
    if not agents:
        return []

    # 역할 다양성 보장하며 상위 에이전트 선택
    from layer2_agent_pool import AGENT_REGISTRY  # noqa: local import
    role_counts: dict[str, int] = {}
    selected: list[str] = []

    sorted_agents = sorted(agents, key=lambda x: x.get("success_rate", 0), reverse=True)
    for ag in sorted_agents:
        if len(selected) >= top_n:
            break
        role = AGENT_REGISTRY.get(ag["agent_name"], "data_scientist")
        if role_counts.get(role, 0) < 2:  # 역할당 최대 2명
            selected.append(ag["agent_name"])
            role_counts[role] = role_counts.get(role, 0) + 1

    return selected


def generate_optimization_report(market: str) -> SystemPerformanceReport:
    """시스템 전체 성과 리포트 생성"""
    from datetime import date

    conn = psycopg2.connect(PG_DSN)

    agent_perf = fetch_agent_performance(conn, market)
    llm_cost = fetch_llm_cost_today(conn)
    regime_dist = fetch_regime_distribution(conn, market)

    # 평균 품질 점수
    try:
        with conn.cursor() as cur:
            cur.execute("""
                SELECT AVG(overall_score), COUNT(*)
                FROM investment.trade_quality_evaluations
                WHERE created_at >= CURRENT_DATE - INTERVAL '7 days'
            """)
            row = cur.fetchone()
            avg_score = float(row[0] or 0)
            total_trades = int(row[1] or 0)
    except Exception:
        avg_score, total_trades = 0.0, 0

    current_strategies = [ag["agent_name"] for ag in agent_perf[:5]]
    regime_fit = calc_regime_fit_score(regime_dist, current_strategies)

    try:
        best_combo = select_best_agent_combo(agent_perf)
    except ImportError:
        best_combo = [ag["agent_name"] for ag in agent_perf[:5]]

    # 권장 변이
    recommended = []
    if avg_score < 0.4:
        recommended.append("confidence_threshold_raise")
    if regime_fit < 0.4:
        recommended.append("regime_strategy_realign")
    if llm_cost > 1.0:
        recommended.append("llm_cost_reduce_local_model")

    conn.close()

    summary = (
        f"시스템 성과: avg_quality={avg_score:.2f}, trades={total_trades}, "
        f"regime_fit={regime_fit:.2f}, llm_cost=${llm_cost:.4f}, "
        f"권장 변이={len(recommended)}개"
    )

    return SystemPerformanceReport(
        date=date.today().isoformat(),
        market=market,
        total_trades=total_trades,
        avg_quality_score=avg_score,
        best_agent_combo=best_combo,
        regime_fit_score=regime_fit,
        recommended_mutations=recommended,
        llm_cost_usd=llm_cost,
        summary=summary,
    )


if __name__ == "__main__":
    import argparse
    parser = argparse.ArgumentParser()
    parser.add_argument("--market", default="crypto")
    args = parser.parse_args()

    report = generate_optimization_report(args.market)
    print(f"[Layer4] {report.summary}")
    print(f"[Layer4] 최적 조합: {report.best_agent_combo}")
    print(f"[Layer4] 권장 변이: {report.recommended_mutations}")
