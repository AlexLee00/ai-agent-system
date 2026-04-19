# LLM 라우팅 V2 아키텍처

> 작성: 2026-04-19 (56차 세션)

## 개요

Team Jay LLM 라우팅 인프라 고도화 결과물. 7 Phase에 걸쳐 구축된 5계층 아키텍처.

```
┌────────────────────────────────────────────────────────────────────┐
│  Layer 0: packages/elixir_core/lib/jay/llm/ (공용 레이어)           │
│    Jay.Core.LLM.Policy (Behaviour)                                 │
│    Jay.Core.LLM.Selector (use macro — 팀별 주입)                   │
│    Jay.Core.LLM.Recommender (7차원 룰)                             │
│    Jay.Core.LLM.CostTracker (GenServer 매크로)                     │
│    Jay.Core.LLM.RoutingLog (DB 기록)                               │
│    Jay.Core.LLM.HubClient (Hub HTTP)                               │
│    Jay.Core.LLM.Models (모델 SSoT)                                 │
│    Jay.Core.LLM.Telemetry (:telemetry 이벤트)                      │
└────────────────────────────────────────────────────────────────────┘
                              ↓
┌────────────────────────────────────────────────────────────────────┐
│  Layer 1: 팀별 Selector 얇은 래퍼                                   │
│    Luna.V2.LLM.Selector  (use Jay.Core.LLM.Selector)              │
│    Sigma.V2.LLM.Selector (use Jay.Core.LLM.Selector)              │
│    Darwin.V2.LLM.Selector (use Jay.Core.LLM.Selector)             │
│                                                                    │
│  팀별 Policy 모듈:                                                  │
│    Luna.V2.LLM.Policy    (12 에이전트 정책)                         │
│    Sigma.V2.LLM.Policy   (Sigma 특화 정책)                         │
│    Darwin.V2.LLM.Policy  (Darwin 특화 정책)                        │
└────────────────────────────────────────────────────────────────────┘
                              ↓
┌────────────────────────────────────────────────────────────────────┐
│  Layer 2: Hub BudgetGuardian (TypeScript Singleton)                │
│    bots/hub/lib/budget-guardian.ts                                 │
│    - 8팀 quota + Global $80/day + Emergency $100                   │
│    - 60초 DB 갱신, 80%/100% Telegram 경고                          │
│    - GET /hub/budget/usage, POST /hub/budget/reserve               │
└────────────────────────────────────────────────────────────────────┘
                              ↓
┌────────────────────────────────────────────────────────────────────┐
│  Layer 3: Hub LLM Cache (PostgreSQL)                               │
│    bots/hub/lib/llm/cache.ts                                       │
│    - SHA256 프롬프트 해시 기반                                      │
│    - TTL: realtime 24h / analysis 7d / research 30d                │
│    - 매일 04:00 KST 만료 캐시 삭제 (ai.hub.llm-cache-cleanup)      │
└────────────────────────────────────────────────────────────────────┘
                              ↓
┌────────────────────────────────────────────────────────────────────┐
│  Layer 4: Hub Unified Caller                                       │
│    bots/hub/lib/llm/unified-caller.ts                              │
│    순서: Budget → Cache → Claude Code OAuth → Groq 폴백 → 캐시저장 │
│    Primary:  Claude Code OAuth (claude-haiku/sonnet/opus)          │
│    Fallback: Groq (GROQ_MODEL → llm-models.json SSoT)             │
└────────────────────────────────────────────────────────────────────┘
                              ↓
┌────────────────────────────────────────────────────────────────────┐
│  Layer 5: 관측성                                                   │
│    GET /hub/llm/dashboard — Chart.js 실시간 시각화 (30초 갱신)      │
│    GET /hub/llm/health    — OAuth + Groq + Budget + Cache 헬스     │
│    GET /hub/llm/stats     — API JSON 통계                          │
│    GET /hub/llm/cache-stats — Cache hit/cost 절감                  │
└────────────────────────────────────────────────────────────────────┘
```

## 파일 목록

### Elixir (packages/elixir_core)

| 파일 | 설명 |
|------|------|
| `lib/jay/llm/policy_behaviour.ex` | Policy Behaviour (11 콜백) |
| `lib/jay/llm/selector.ex` | Selector `use` 매크로 + Impl |
| `lib/jay/llm/recommender.ex` | 7차원 룰 기반 동적 모델 선택 |
| `lib/jay/llm/cost_tracker.ex` | GenServer 비용 추적 |
| `lib/jay/llm/routing_log.ex` | DB 라우팅 기록 |
| `lib/jay/llm/hub_client.ex` | Hub HTTP 클라이언트 |
| `lib/jay/llm/models.ex` | 모델 SSoT (get_current/get_groq_fallback/get_cost) |
| `lib/jay/llm/telemetry.ex` | :telemetry 이벤트 발행 |

### TypeScript (bots/hub)

| 파일 | 설명 |
|------|------|
| `lib/llm/unified-caller.ts` | Budget → Cache → OAuth → Groq 체인 |
| `lib/llm/cache.ts` | SHA256 캐시 (checkCache/saveCache/cleanupExpiredCache) |
| `lib/llm/oauth-monitor.ts` | 토큰 만료 모니터링 |
| `lib/budget-guardian.ts` | 팀별 quota + Emergency 차단 |
| `lib/routes/llm-dashboard.ts` | `/hub/llm/dashboard` HTML + 인라인 JS |
| `lib/routes/llm-health.ts` | `/hub/llm/health` 복합 헬스체크 |
| `lib/routes/budget.ts` | `/hub/budget/reserve`, `/hub/budget/usage` |
| `scripts/llm-cache-cleanup.ts` | 만료 캐시 삭제 + MView 갱신 |
| `scripts/test-groq-fallback.ts` | Groq 단독 운영 주기 테스트 |
| `scripts/run-oauth-monitor.ts` | OAuth 토큰 상태 확인 |

### TypeScript (packages/core)

| 파일 | 설명 |
|------|------|
| `lib/llm-models.json` | 모델 SSoT (anthropic_haiku/sonnet/opus + groq 폴백) |
| `lib/llm-models.ts` | JSON 로더 (getCurrentModel/getGroqFallback/getCost) |

### DB 테이블

| 테이블 | 설명 |
|--------|------|
| `luna_llm_routing_log` | Luna LLM 라우팅 이력 |
| `luna_llm_cost_daily` | Luna 일별 비용 집계 |
| `luna_llm_cost_tracking` | Luna 비용 추적 |
| `llm_cache` | SHA256 캐시 엔트리 |
| `llm_cache_stats` | 캐시 효율 MView (일별/타입별) |

### launchd Plists

| 파일 | 일정 |
|------|------|
| `ai.hub.llm-cache-cleanup.plist` | 매일 04:00 KST |
| `ai.hub.llm-model-check.plist` | 매주 일요일 12:00 KST |
| `ai.hub.llm-oauth-monitor.plist` | 6시간마다 (00/06/12/18 KST) |
| `ai.hub.llm-groq-fallback-test.plist` | 매주 일요일 05:00 KST |

## 7차원 Recommender 규칙

```
1. base_affinity  — 에이전트별 모델 적합도 (팀 Policy에서 주입)
2. length_bias    — 프롬프트 길이 (짧으면 haiku, 길면 sonnet/opus)
3. budget_bias    — 예산 소진율 (높으면 haiku로 강등)
4. failure_bias   — 최근 실패율 (높으면 다음 등급 상승)
5. urgency_bias   — 긴급도 (high=sonnet, low=haiku)
6. task_type_bias — 작업 유형 (constitutional_ai=opus, fast=haiku)
7. accuracy_bias  — 정확도 요구 (high=opus)
```

## Kill Switch 활성화 순서

```bash
# 1주차: Luna Selector Shadow
launchctl setenv LUNA_LLM_HUB_ROUTING_SHADOW true

# 2주차: Luna Selector 실전
launchctl setenv LUNA_LLM_HUB_ROUTING_ENABLED true

# 3주차: 공용 모듈 Shadow  
launchctl setenv JAY_CORE_LLM_SHADOW true

# 4주차: Cache 활성화
launchctl setenv HUB_LLM_CACHE_ENABLED true

# 5주차: Budget 엄격 모드
launchctl setenv HUB_BUDGET_STRICT_MODE true
```

## 테스트 현황

| 범위 | 테스트 수 |
|------|----------|
| Jay.Core.LLM.* | 47+ |
| Luna.V2.LLM.* | 159 (8 skipped) |
| Sigma.V2.LLM.* | 57 |
| Darwin.V2.LLM.* | 362 |
