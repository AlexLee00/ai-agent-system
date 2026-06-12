# Team Jay LLM Hub 아키텍처

> 최종 업데이트: 2026-06-12 / Hardening Phase 1~5 + 신뢰성(H)·안정성(S)·정책엔진(R) 시리즈 반영

---

## 전체 구조

```
┌────────────────────────────────────────────────────────────────────┐
│  Layer 0: Circuit Breaker (packages/core/lib/local-circuit-breaker)  │
│    - provider별 상태 CLOSED / OPEN / HALF_OPEN                      │
│    - 연속 3회 실패 → OPEN (30s 쿨다운) → HALF_OPEN → CLOSED         │
│    - ProviderRegistry가 래핑: Telegram + DB 이벤트 추가              │
└────────────────────────────────────────────────────────────────────┘
                                ↓
┌────────────────────────────────────────────────────────────────────┐
│  Layer 1: Provider Registry (bots/hub/lib/llm/provider-registry)    │
│    - per-provider 통계 (latency P99, failure_rate)                   │
│    - Circuit 전환 시 Telegram 알림 + hub.circuit_events DB 기록      │
│    - getProviderStats() → /hub/metrics 노출                         │
└────────────────────────────────────────────────────────────────────┘
                                ↓
┌────────────────────────────────────────────────────────────────────┐
│  Layer 2: Unified Caller (bots/hub/lib/llm/unified-caller)          │
│    - runtime-profiles[team][agent] 기반 fallback chain 구성          │
│    - claude-code/ → Groq/ → local/ 순서 시도                        │
│    - Circuit OPEN → 즉시 다음 provider (대기 없음)                  │
│    - Fallback Exhaustion → Telegram urgent                          │
│    - team/agent 없으면 legacy 2-step (Claude Code + Groq)            │
└────────────────────────────────────────────────────────────────────┘
                                ↓
┌────────────────────────────────────────────────────────────────────┐
│  Layer 3: Critical Chain Awareness (critical-chain-registry)         │
│    - luna/exit_decision, luna/portfolio_decision → critical:true     │
│    - Critical: 첫 실패 즉시 다음, timeout 10s, local 경로 없음       │
│    - getTimeoutForChain(team, agent) → profile.timeout_ms 반환      │
└────────────────────────────────────────────────────────────────────┘
                                ↓
┌────────────────────────────────────────────────────────────────────┐
│  Layer 4: 관측성 (metrics/prometheus-exporter + /hub/llm/stats)      │
│    - GET /hub/metrics — Prometheus text 포맷                        │
│    - GET /hub/metrics/json — JSON 집계                              │
│    - GET /hub/llm/circuit — Circuit 상태 + 수동 리셋                │
│    - GET /hub/llm/stats — provider × team 통계 (24h)               │
│    - GET /hub/llm/health — OAuth/Groq/Local 건강도                  │
└────────────────────────────────────────────────────────────────────┘
```

---

## 파일 목록

### Hub (bots/hub/)

| 파일 | 역할 |
|------|------|
| `lib/llm/unified-caller.ts` | Fallback chain 조율, local/ 분기, exhaustion 감지 |
| `lib/llm/provider-registry.ts` | Circuit 래퍼 + 통계 + Telegram/DB |
| `lib/llm/local-ollama.ts` | Local Ollama HTTP 호출 (15s timeout, 빈응답 감지) |
| `lib/llm/critical-chain-registry.ts` | critical:true 판별 + timeout 조회 |
| `lib/llm/claude-code-oauth.ts` | Claude Code OAuth primary caller |
| `lib/llm/groq-fallback.ts` | Groq pool-based fallback caller |
| `lib/llm/cache.ts` | LLM 응답 캐시 (PostgreSQL) |
| `lib/runtime-profiles.ts` | 팀별 agent별 라우트 정의 (600+ 줄) |
| `lib/metrics/prometheus-exporter.ts` | /hub/metrics 텍스트+JSON |
| `lib/routes/llm.ts` | API 라우트 (call/oauth/groq/stats/circuit) |
| `migrations/20261001000040_circuit_breaker.sql` | hub.circuit_events + load_test_results |

### packages/core/lib/

| 파일 | 역할 |
|------|------|
| `local-circuit-breaker.ts` | 순수 Circuit Breaker (in-memory, URL/name 키) |
| `local-llm-client.ts` | 공용 MLX LLM 클라이언트 (팀 직접 사용) |

---

## 팀별 라우팅 정책

| 팀 | 중요 경로 | local 허용 | timeout |
|----|----------|-----------|---------|
| luna | exit_decision, portfolio_decision | ❌ | 10s |
| luna | 일반 (analyst/validator) | ✅ | 30s |
| blog | writer | ✅ | 30s |
| darwin | research | ✅ | 30s |
| 기타 | default | ✅ | 30s |

---

## API 엔드포인트

| 메서드 | 경로 | 설명 |
|--------|------|------|
| POST | `/hub/llm/call` | 통합 LLM 호출 (Circuit Breaker 포함) |
| POST | `/hub/llm/oauth` | Claude Code OAuth 단독 |
| POST | `/hub/llm/groq` | Groq 단독 |
| GET | `/hub/llm/stats` | provider × team 통계 |
| GET/DELETE | `/hub/llm/circuit` | Circuit 상태 조회 / 리셋 |
| GET | `/hub/llm/health` | OAuth/Groq/Local 건강도 |
| GET | `/hub/metrics` | Prometheus text 포맷 |
| GET | `/hub/metrics/json` | JSON 메트릭 |

---

## Circuit Breaker 동작

```
1. callLocalOllama 호출
2. registry.canCall(providerKey) 체크
   → OPEN: 즉시 circuit_open 에러 반환 (fetch 미호출)
3. fetch 성공 + 응답 길이 ≥ 3:
   → registry.recordSuccess(provider, latencyMs)
4. 실패 (timeout/empty/5xx/network):
   → registry.recordFailure(provider, reason)
   → 3회 연속 실패 → isCircuitOpen=true
5. 30s 후 → HALF_OPEN (probe 1회 허용)
6. probe 성공 → CLOSED (Telegram 복구 알림)
7. probe 실패 → OPEN (60s 쿨다운 — 2배)
```

---

## 4주 전환 로드맵

| 주 | 내용 |
|---|------|
| Week 1 | Phase 1 배포, DB 마이그레이션 적용, 로그 모니터링 |
| Week 2 | Circuit Breaker 실전 차단 확인 (Ollama 수동 중단 테스트) |
| Week 3 | Luna critical chain 검증 (exit_decision → local 미경유 확인) |
| Week 4 | /hub/metrics Grafana 연결, 주간 부하 테스트 자동화 |


## 2026-06 신뢰성·정책 계층 (H/S/R 시리즈 — 2026-06-12)

기존 Hardening(Circuit Breaker/Provider Registry) 위에 추가된 계층. 상세 설계는 각 설계서가 원천이며
본 섹션은 연결 관점 요약이다.

### 라우팅 정책 현행 (2026-06-12)
- darwin/sigma 표준 체인: `openai-oauth(mini|perf) -> groq_scout` (local·gemini 제거,
  `HUB_DARWIN_SIGMA_GROQ_FALLBACK_ENABLED` 기본 true / false=openai 단독). edison/verifier/commander는 anthropic 계열 유지.
- 알람 해석기 4종(work/report/error/critical): `groq primary + openai-oauth 폴백` (구 local 단일점 폐지).
- local(qwen2.5-7b)은 `backtest_*` taskType 전용 (`HUB_LLM_LOCAL_BACKTEST_ONLY`, 전 팀 전역 가드).
  local-embedding은 별개 provider로 영향 없음.
- 정책 표면 전수 스냅샷: `docs/hub/snapshots/` + `npm run llm:policy-table-codegen` / `--engine` diff.

### 신뢰성 계층 (실행층)
- **Provider rate-limit 쿨다운** (unified-caller): 429/풀 고갈 provider를 최소 30s 사전 스킵.
  전 체인 쿨다운 시 마지막 1개는 시도(완전 불능 방지). env `HUB_LLM_RATELIMIT_COOLDOWN_ENABLED|_MIN_MS`.
- **Local 콜드스타트 2단 타임아웃** (local-ollama): 1차 30s -> timeout 시 1회 재시도 180s.
  재시도 성공은 회로 무손상. env `HUB_LLM_LOCAL_TIMEOUT_MS|_COLD_START_TIMEOUT_MS|_COLD_RETRY_ENABLED`.

### 정책 엔진 (R 시리즈, shadow 가동 중)
- `HUB_LLM_POLICY_ENGINE_MODE=off|shadow|team:<csv>(R3)` — 현재 shadow: 신구 체인 비교를
  `hub.llm_policy_shadow_log`에 기록, 라이브 동작 영향 0.
- 구성: `packages/core/lib/llm-policy-table.ts`(codegen 산출) + `llm-policy-engine.ts`.
  매칭 team은 selectorKey 접두사 기준(키가 정책을 결정 — 교차 팀 alias 안전).

### 자동 승급 게이트 (H6 패턴)
- `npm --prefix bots/hub run -s runtime:hub-llm-promotion-gate -- --json --gate=GATE-H|GATE-H3|GATE-R`
- 상태머신 blocked -> contract_only -> shadow_ready_data_pending -> ready_for_master_review.
  `--apply` 영구 차단 — 승급 실행은 마스터 env 전환만.

### 운영 노트
- plist env **변경** 반영은 `kickstart -k`로 불충분 — `bootout` 후 `bootstrap`으로 job definition 재로드 필요.
  (env 변경 없는 코드 재기동은 kickstart 충분.)
- 추적: docs/hub/HUB_LLM_IMPROVEMENT_TRACKER.md / 설계서: HUB_LLM_RELIABILITY_DESIGN_2026-06.md,
  HUB_SYSTEM_STABILITY_DESIGN_2026-06.md, HUB_LLM_POLICY_ENGINE_DESIGN_2026-06.md
