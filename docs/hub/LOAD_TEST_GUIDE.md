# LLM Hub 부하 테스트 가이드

> 최종 업데이트: 2026-04-19 / LLM Routing Hardening Phase 3

---

## 개요

6개 시나리오로 Hub LLM 레이어의 부하 내성 검증:
1. **Baseline** — 평시 순차 호출
2. **Primary 실패 → Groq Fallback** — 폴백 체인 동작
3. **Chaos (Fallback Exhaustion)** — 모든 provider 실패 처리
4. **Runtime-Profile Chain** — local/ 경로 포함 체인
5. **Critical Chain (Luna)** — exit_decision에서 local 미사용
6. **병렬 50회** — 동시 부하 성능

---

## 테스트 실행

```bash
# Jest 기반 전체 테스트
npx jest --testPathPatterns="bots/hub/__tests__" --passWithNoTests

# 특정 시나리오만
npx jest --testPathPatterns="bots/hub/__tests__/load/llm-load"

# Circuit Breaker 단위 테스트
npx jest --testPathPatterns="bots/hub/__tests__/circuit-breaker"

# Local Ollama 테스트
npx jest --testPathPatterns="bots/hub/__tests__/local-ollama"
```

---

## 합격 기준

| 시나리오 | 합격 조건 |
|---------|----------|
| Baseline 10회 | 성공률 100% |
| 6팀 동시 | 성공률 100% |
| Primary 실패 | Groq fallback 100% |
| Chaos | ok:false + fallback_exhausted 메시지 |
| Critical Chain | callLocalOllama 미호출 |
| 병렬 50회 | 완료 < 2s, 실패율 < 5% |

---

## 실제 Hub 부하 테스트 (OPS에서)

Hub가 실행 중인 OPS 환경에서 직접 호출:

```bash
# 10회 연속 호출 시간 측정
for i in $(seq 1 10); do
  time curl -s -X POST http://127.0.0.1:7788/hub/llm/call \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer $HUB_AUTH_TOKEN" \
    -d '{"prompt":"테스트","abstractModel":"anthropic_haiku","callerTeam":"blog","agent":"default"}' | jq '.ok'
done

# Chaos 시나리오: Ollama 중단 상태에서 테스트
pkill -f ollama
curl -s -X POST http://127.0.0.1:7788/hub/llm/call \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $HUB_AUTH_TOKEN" \
  -d '{"prompt":"테스트","abstractModel":"anthropic_sonnet","callerTeam":"blog","agent":"writer"}' | jq '.'
# → local/qwen2.5-7b Circuit OPEN → Groq fallback 동작 확인

# Circuit 상태 확인
curl -s -H "Authorization: Bearer $HUB_AUTH_TOKEN" \
  http://127.0.0.1:7788/hub/llm/circuit | jq '.'

# Ollama 복구
open -a Ollama
```

---

## DB에 결과 저장

테스트 완료 후 결과를 수동으로 기록:

```sql
INSERT INTO hub.load_test_results (scenario, total_requests, failed_requests, fail_rate, p95_latency_ms, duration_s, notes)
VALUES ('baseline', 50, 0, 0.00, 850, 12, '정상 운영 상태');
```

---

## 모니터링

테스트 중 실시간 상태 확인:

```bash
# Circuit 상태
watch -n 2 "curl -s -H 'Authorization: Bearer $HUB_AUTH_TOKEN' \
  http://127.0.0.1:7788/hub/llm/circuit | jq '.local_llm_circuits'"

# Prometheus 메트릭
curl -s -H "Authorization: Bearer $HUB_AUTH_TOKEN" \
  http://127.0.0.1:7788/hub/metrics
```
