# Darwin V2 Evolution Architecture

> 작성: 코덱스 / 2026-04-19 (CODEX_DARWIN_EVOLUTION Phase R-M 완료)

## 전체 레이어 구조

```
Layer 0: Hub LLM Routing (Phase 3 완료)
  - Darwin.V2.LLM.Selector → Hub /llm/call (Claude Code OAuth + Groq 폴백)

Layer 1: Monitor (Darwin.V2.MapeKLoop)
  - Community Scanner 4종 (HN/Reddit/OpenReview/ArxivRSS)
  - Darwin.V2.ResearchMonitor (진행 중 품질 추적)
  - Darwin.V2.AutonomyLevel (L3→L4→L5 승격 조건)

Layer 2: Analyze (Darwin.V2.Rag.AgenticRag)
  - QueryPlanner → sub-query 분해
  - MultiSourceRetriever → L2 memory + past cycles 병렬 검색
  - QualityEvaluator → 품질 점수 + 재검색 판정
  - ResponseSynthesizer → 통합 응답
  - 기존 SelfRAG 4-gate는 kill switch OFF 시 fallback

Layer 3: Plan (Darwin.V2.Cycle.Plan + Commander)
  - Adaptive Priority Engine (자율 레벨 + 자원 기반)
  - Risk Gate (darwin_principles.yaml 원칙 사전 차단)
  - ResearchRegistry 단계 전이 기록

Layer 4: Execute (Darwin.V2.Cycle.Implement/Verify/Apply)
  - Edison (TS 구현자) + Proof-R (TS 검증자) 호출
  - Sandbox 격리 강화 (L5 자율 시에도)
  - ResearchRegistry.link_effect (구현 효과 기록)

Layer 5: Knowledge (Self-Rewarding + ESPL + Research Registry)
  - Darwin.V2.SelfRewarding: LLM-as-a-Judge DPO 선호 쌍 축적
  - Darwin.V2.ESPL: 프롬프트 주간 진화
  - Darwin.V2.ResearchRegistry: 논문 라이프사이클 완전 추적
  - Darwin.V2.MetaReview: 크로스사이클 교훈 합성
```

## 7단계 사이클 → MAPE-K 매핑

| MAPE-K | 다윈 사이클 | 모듈 |
|--------|------------|------|
| Monitor | DISCOVER | Cycle.Discover + CommunityScanner |
| Analyze | EVALUATE | Cycle.Evaluate + AgenticRag |
| Plan | PLAN | Cycle.Plan + AgenticRag + Commander |
| Execute | IMPLEMENT + VERIFY + APPLY | Cycle.Implement/Verify/Apply |
| Knowledge | LEARN | Cycle.Learn + SelfRewarding + ESPL |

## Kill Switch 체계

| 환경변수 | 기본값 | 기능 |
|---------|--------|------|
| DARWIN_V2_ENABLED | false | V2 전체 |
| DARWIN_CYCLE_ENABLED | false | 7단계 사이클 |
| DARWIN_SHADOW_ENABLED | false | Shadow Mode |
| DARWIN_MAPEK_ENABLED | false | MAPE-K 루프 |
| DARWIN_SELF_REWARDING_ENABLED | false | DPO 선호 학습 |
| DARWIN_AGENTIC_RAG_ENABLED | false | Agentic RAG |
| DARWIN_RESEARCH_REGISTRY_ENABLED | false | Research Registry |
| DARWIN_TELEGRAM_ENHANCED_ENABLED | false | 5채널 리포트 |
| DARWIN_L5_ENABLED | false | L5 완전자율 (절대 자동 flip 금지) |

## 데이터 흐름

```
[CommunityScanner] → [Cycle.Discover] → ResearchRegistry(discovered)
                                       ↓
[AgenticRag]      → [Cycle.Evaluate] → ResearchRegistry(evaluated)
                                       ↓
[AgenticRag]      → [Cycle.Plan]     → ResearchRegistry(planned)
                                       ↓
                     [Cycle.Implement]→ ResearchRegistry(implemented)
                                       ↓
                     [Cycle.Verify]  → ResearchRegistry(verified)
                                       ↓
                     [Cycle.Apply]   → ResearchRegistry(applied) + link_effect
                                       ↓
[SelfRewarding]   → [Cycle.Learn]   → ResearchRegistry(measured)
                                       ↓
                    [MapeKLoop] ← 다음 사이클 환류
```

## DB 스키마 (신규 5개 테이블)

- `darwin_dpo_preference_pairs` — Self-Rewarding 선호 쌍
- `darwin_recommender_history` — LLM affinity 재조정 이력
- `darwin_research_registry` — 논문 운영 객체
- `darwin_research_effects` — 논문→구현 효과 링크
- `darwin_autonomy_promotion_log` — 자율 레벨 승격 후보 이력
- `darwin_autonomy_dashboard` — Materialized View (30일 집계)

## 테스트 현황

- 기존 Phase 0~8: 386 tests, 0 failures (16 excluded)
- Phase R-M 신규 테스트 포함

## 참조

- CODEX_DARWIN_EVOLUTION.md (구현 프롬프트)
- AUTONOMY_PROMOTION_GUIDE.md (승격 절차)
- SOUL.md (7원칙), PRINCIPLES.md (연구 원칙)
