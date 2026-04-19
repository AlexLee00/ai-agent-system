# Team Jay LLM Hub 아키텍처

> 최종 업데이트: 2026-04-19 / LLM Routing Hardening Phase 1~5 완료

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
