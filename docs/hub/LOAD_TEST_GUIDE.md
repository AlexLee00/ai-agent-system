# LLM Hub L5 부하 테스트 가이드

> 최종 업데이트: 2026-04-25 / L5 Stability & OAuth Decoupling 기준

---

## 목표

Hub를 단일 팀 테스트가 아니라 **다중 팀 동시 운영 부하** 기준으로 검증한다.

- sync fast-path의 응답성 유지
- admission control(`429/503 + Retry-After`) 정상 동작
- provider 장애(429/timeout) 시 retry storm 없이 bounded degradation
- 결과를 `hub.load_test_results`에 일관 형식으로 저장

---

## 테스트 단계

1. 사전 단위/스모크
2. k6 시나리오 부하
3. chaos (provider down / 429 주입)
4. 결과 저장 및 회귀 비교

---

## 1) 사전 단위/스모크

```bash
# Hub 기본 테스트
npm --prefix bots/hub test

# Hub readiness 요약(Secret 값은 출력하지 않음)
npm --prefix bots/hub run readiness

# LLM 관련 Jest 스모크
npx jest --testPathPatterns="bots/hub/__tests__/load/llm-load" --runInBand
npx jest --testPathPatterns="bots/hub/__tests__/circuit-breaker" --runInBand
npx jest --testPathPatterns="bots/hub/__tests__/local-ollama" --runInBand
```

`readiness`는 OpenClaw 독립성, OpenAI OAuth mock 경로, Claude Code OAuth CLI adapter, Telegram secret source, token-store 존재 여부를 redacted JSON으로 묶어 보여준다. `status=warn`은 배포 host에서 확인할 runtime 배선 이슈가 남았다는 뜻이며, `required_failures > 0`이면 live OAuth/Telegram 테스트 전에 먼저 수정한다.

---

## 2) k6 부하 시나리오

권장 시나리오(예: `scripts/k6/hub-llm-multiteam.js`):

- `baseline_sync`: 단일 팀 sync 10 VU / 2m
- `multiteam_peak`: 9팀 혼합 traffic 80~150 VU / 5m
- `queue_pressure`: low-latency 요청 + burst 혼합으로 admission queue 압박
- `provider_429`: 특정 provider에 429를 강제로 발생시켜 cooldown 확인

예시 실행:

```bash
export HUB_BASE_URL="http://127.0.0.1:7788"
export HUB_AUTH_TOKEN="..."

k6 run \
  -e HUB_BASE_URL="$HUB_BASE_URL" \
  -e HUB_AUTH_TOKEN="$HUB_AUTH_TOKEN" \
  bots/hub/scripts/k6/hub-llm-multiteam.js
```

---

## 3) chaos 시나리오

```bash
# local LLM 중지 (fallback/circuit 확인)
pkill -f ollama || true

# 단건 확인
curl -s -X POST "$HUB_BASE_URL/hub/llm/call" \
  -H "Authorization: Bearer $HUB_AUTH_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"prompt":"chaos-check","abstractModel":"anthropic_sonnet","callerTeam":"blog","agent":"writer"}' | jq '.'

# circuit / admission 상태 확인
curl -s -H "Authorization: Bearer $HUB_AUTH_TOKEN" "$HUB_BASE_URL/hub/llm/circuit" | jq '.'
curl -s -H "Authorization: Bearer $HUB_AUTH_TOKEN" "$HUB_BASE_URL/hub/llm/stats?hours=1" | jq '.admission'
```

---

## L5 합격 기준

| 항목 | 기준 |
| --- | --- |
| fail rate | `< 1%` |
| sync fast-path p95 | `< 10s` |
| backpressure | 과부하 시 bounded `429/503` + `Retry-After` |
| provider 429 | queue/cooldown 전환, retry storm 없음 |
| observability | `traceId`, provider attempts, circuit/admission 상태 확인 가능 |

---

## 결과 저장 표준

```sql
INSERT INTO hub.load_test_results (
  scenario,
  total_requests,
  failed_requests,
  fail_rate,
  p95_latency_ms,
  p99_latency_ms,
  avg_latency_ms,
  duration_s,
  notes
)
VALUES (
  'multiteam_peak_l5',
  12000,
  73,
  0.0061,
  1820,
  4480,
  620,
  300,
  '{"admission":{"max_in_flight":16,"max_queue":48},"providers":{"openai":"stable","groq":"fallback"}}'
);
```

---

## 운영 체크리스트

- `npm --prefix bots/hub run readiness`에서 required failure가 없는지
- retired `ai.openclaw.gateway` 없이 `/hub/alarm`이 Hub-native 경로로 응답하는지
- `/hub/oauth/:provider/status`가 expiry/canary를 제공하는지
- 토큰/시크릿 문자열이 로그/응답에 노출되지 않는지
