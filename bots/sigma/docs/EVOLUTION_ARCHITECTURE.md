# Sigma Team — Evolution Architecture (V2)

> Phase R/S/A/O/M/P 완전 구현 기준 아키텍처 (2026-04)

## 전체 흐름

```
                    ┌─────────────────────────────────────────┐
                    │           MAPE-K Loop (Phase R)          │
                    │  Monitor → Analyze → Plan → Execute      │
                    │           + Knowledge phase              │
                    └──────────────┬──────────────────────────┘
                                   │
               ┌───────────────────┼───────────────────┐
               │                   │                   │
               ▼                   ▼                   ▼
    ┌──────────────────┐  ┌─────────────────┐  ┌──────────────────┐
    │  SelfRewarding   │  │  AgenticRag     │  │  Monitoring      │
    │  (Phase S)       │  │  (Phase A)      │  │  (Phase M)       │
    │                  │  │                 │  │                  │
    │ LLM-as-Judge     │  │ QueryPlanner    │  │ daily_summary/0  │
    │ DPO preference   │  │ MultiSource     │  │ weekly_summary/0 │
    │ pairs 생성       │  │ QualityEval     │  │ Pod.Performance  │
    │                  │  │ Synthesizer     │  │                  │
    └──────┬───────────┘  └────────┬────────┘  └────────┬─────────┘
           │                       │                    │
           └───────────────────────┼────────────────────┘
                                   │
                    ┌──────────────▼──────────────┐
                    │    TelegramReporter (Phase O) │
                    │                               │
                    │  urgent    daily   weekly     │
                    │  meta      alert              │
                    │                               │
                    │  Kill Switch:                 │
                    │  SIGMA_TELEGRAM_ENHANCED      │
                    └──────────────────────────────┘
                                   │
                    ┌──────────────▼──────────────┐
                    │   PodSelectorV2 (Phase P)    │
                    │                              │
                    │  ε-greedy → UCB1             │
                    │  Thompson Sampling (Beta)    │
                    │  Contextual Bandits          │
                    │                              │
                    │  Pods: trend / growth / risk │
                    └──────────────────────────────┘
```

## Phase별 모듈 매핑

| Phase | 모듈 | Kill Switch | DB 테이블 |
|-------|------|-------------|-----------|
| R | `Sigma.V2.MapeKLoop` | — (항상 실행) | sigma_v2_directive_audit |
| S | `Sigma.V2.SelfRewarding` | `SIGMA_SELF_REWARDING_ENABLED` | sigma_dpo_preference_pairs |
| A | `Sigma.V2.Rag.AgenticRag` + 4 sub | `SIGMA_AGENTIC_RAG_ENABLED` | sigma_rag_query_log |
| O | `Sigma.V2.TelegramReporter` | `SIGMA_TELEGRAM_ENHANCED` | — |
| M | `Sigma.V2.Monitoring` | — | sigma_v2_directive_audit |
| P | `Sigma.V2.PodSelectorV2` | `SIGMA_POD_DYNAMIC_V2_ENABLED` | sigma_pod_bandit_stats |

## DB 스키마 요약

```
sigma_dpo_preference_pairs      ← SelfRewarding 출력
sigma_pod_bandit_stats          ← PodSelectorV2 UCB1/Thompson 학습
sigma_pod_selection_log         ← PodSelectorV2 선택 로그 (Contextual 학습)
sigma_pod_performance_log       ← 주기별 Pod 성과 집계
sigma_v2_directive_audit        ← Directive 실행 이력 (Monitoring 소스)
sigma_llm_cost_tracking         ← LLM 비용 추적
sigma_rag_query_log             ← RAG 쿼리 이력

(Materialized Views)
sigma_pod_performance_dashboard ← 일별 × Pod 집계
sigma_directive_effectiveness   ← 팀별 × 주별 집계
```

## 자율 진화 루프

```
1. MAPE-K 사이클 완료
   → SelfRewarding.evaluate_cycle(cycle)
   → DPO preference pair 저장
   → Reflexion (실패 Directive만)

2. 주간 지식 갱신
   → SelfRewarding.evaluate_week()
   → PodSelectorV2.update_reward(pod, team, score)
   → TelegramReporter.on_weekly_review(summary)

3. Pod 선택 최적화
   → PodSelectorV2.select_best_pod(team, ctx)
   → UCB1 / Thompson / Contextual 전략 중 선택
   → 보상 피드백 → bandit stats 업데이트
```

## 배포 구성

| 파일 | 스케줄 | 역할 |
|------|--------|------|
| `ai.sigma.daily-report.plist` | UTC 21:30 (KST 06:30) | 일일 현황 리포트 |
| `ai.sigma.weekly-review.plist` | 일요일 UTC 10:00 (KST 19:00) | 주간 회고 리포트 |
