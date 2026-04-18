# 스카팀 진화 아키텍처 — Skill-Based + MAPE-K

> 작성: 2026-04-19 (CODEX_SKA_EVOLUTION Phase 7 완료)

## 전체 구조 (6 Layer)

```
Layer 0: Hub LLM Routing (V2)
         Hub /hub/llm/call → Claude Code OAuth / Groq 폴백

Layer 1: Skill Registry (TeamJay.Ska.SkillRegistry)
         GenServer + ETS — 12개 스킬 중앙 저장소
         스킬 등록/조회/실행/통계/헬스체크

Layer 2: Skills (12개)
         공통 5개: DetectSessionExpiry / NotifyFailure / PersistCycleMetrics
                   TriggerRecovery / AuditDbIntegrity
         도메인 3개: ParseNaverHtml / ClassifyKioskState / AuditPosTransactions
         분석 4개: ForecastDemand / AnalyzeRevenue / DetectAnomaly / GenerateReport

Layer 3: Agents (경량화 — 오케스트레이션만)
         Andy(네이버) / Jimmy(키오스크) / Pickko(POS)
         Rebecca(매출) / Eve(크롤링) / Forecast(예측)

Layer 4: MAPE-K Loop (TeamJay.Ska.MapeKLoop)
         Monitor → Analyze → Plan → Execute → Knowledge
         Kill Switch: SKA_MAPEK_ENABLED

Layer 5: Self-Rewarding (TeamJay.Ska.SelfRewarding)
         LLM-as-a-Judge 스킬 평가 → DPO 선호 쌍 축적
         Kill Switch: SKA_SELF_REWARDING_ENABLED

Layer 6: Agentic RAG (TeamJay.Ska.Rag.AgenticRag)
         QueryPlanner → MultiSourceRetriever → QualityEvaluator → ResponseSynthesizer
         Kill Switch: SKA_AGENTIC_RAG_ENABLED
```

## DB 테이블

| 테이블 | 용도 |
|--------|------|
| `ska_skill_execution_log` | 스킬 실행 이력 (통계) |
| `ska_cycle_metrics` | 에이전트 사이클 KPI |
| `ska_skill_performance_24h` | Materialized View — 24h 성과 |
| `ska_skill_preference_pairs` | Self-Rewarding DPO 선호 쌍 |
| `ska_skill_affinity_30d` | Materialized View — 30d affinity |

## Kill Switch 목록

| 환경변수 | 기본값 | 설명 |
|---------|--------|------|
| `SKA_SKILL_REGISTRY_ENABLED` | `true` | Skill Registry 활성화 |
| `SKA_SKILL_SHADOW_MODE` | `false` | Shadow 모드 (Legacy 병행) |
| `SKA_PYTHON_SKILL_ENABLED` | `false` | Python 스킬 활성화 |
| `SKA_MAPEK_ENABLED` | `false` | MAPE-K 루프 |
| `SKA_SELF_REWARDING_ENABLED` | `false` | Self-Rewarding |
| `SKA_AGENTIC_RAG_ENABLED` | `false` | Agentic RAG |

## 단계적 활성화 로드맵

```
Week 1: SKA_SKILL_REGISTRY_ENABLED=true (기본 true)
Week 2: Shadow 결과 검증 (7일 100% 일치 확인)
Week 3: SKA_PYTHON_SKILL_ENABLED=true
Week 4: SKA_MAPEK_ENABLED=true
Week 5: SKA_SELF_REWARDING_ENABLED=true (LLM 비용 $8/day 모니터링)
Week 6: SKA_AGENTIC_RAG_ENABLED=true
```
