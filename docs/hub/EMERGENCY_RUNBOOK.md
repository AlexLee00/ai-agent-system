# Hub LLM 비상 대응 런북

> 최종 업데이트: 2026-04-19 / LLM Routing Hardening Phase 5

---

## 시나리오 1: Local Ollama 응답 정지 (마스터 보고 사례)

**증상**:
- `/hub/llm/circuit` 에서 `local/qwen2.5-7b` state: `OPEN`
- Luna exit_decision 지연 또는 Telegram urgent 수신
- `bots/hub/bots-hub.log` 에 `circuit CLOSED → OPEN` 로그

**자동 대응** (Phase 1 이후 자동):
1. Circuit Breaker 3회 실패 → OPEN → Groq/Claude Code로 자동 우회
2. Telegram urgent 자동 발송

**수동 확인**:
```bash
# Circuit 상태 확인
curl -s -H "Authorization: Bearer $HUB_AUTH_TOKEN" \
  http://127.0.0.1:7788/hub/llm/circuit | jq '.local_llm_circuits'

# Ollama 상태 확인
curl -s http://127.0.0.1:11434/v1/models | jq '.data[].id'
```

**Ollama 복구**:
```bash
# launchd kickstart
launchctl kickstart -k gui/$(id -u)/com.ollama.plist 2>/dev/null || \
  pkill -f ollama && sleep 3 && open -a Ollama

# 복구 확인 (30초 쿨다운 후 HALF_OPEN → CLOSED 자동)
curl -s http://127.0.0.1:11434/v1/models | jq '.data[].id'

# Circuit 수동 리셋 (즉시 복구 원할 때)
curl -X DELETE -H "Authorization: Bearer $HUB_AUTH_TOKEN" \
  "http://127.0.0.1:7788/hub/llm/circuit?target=local%2Fqwen2.5-7b"
```

**실패 지속 시**:
```bash
# Ollama 강제 비활성화 (runtime-profiles에서 local 경로 제거 효과)
launchctl setenv OLLAMA_DISABLED true
# Hub 재시작
launchctl kickstart -k gui/$(id -u)/ai.hub.resource-api
```

---

## 시나리오 2: Claude Code OAuth 토큰 만료

**증상**:
- `/hub/llm/health` 에서 `claude_code: false`
- 전체 LLM 호출이 Groq 폴백만 사용
- 비용 급증 경보

**확인**:
```bash
curl -s -H "Authorization: Bearer $HUB_AUTH_TOKEN" \
  http://127.0.0.1:7788/hub/llm/health | jq '.oauth_healthy'
```

**복구**:
```bash
# Claude Code 재인증 (DEV 머신에서)
claude auth login

# secrets-store.json 확인 (OPS에서 Hub 경유)
curl -s -H "Authorization: Bearer $HUB_AUTH_TOKEN" \
  http://127.0.0.1:7788/hub/secrets/claude | jq '.claude_access_token != null'

# Hub 재시작
launchctl kickstart -k gui/$(id -u)/ai.hub.resource-api
```

---

## 시나리오 3: Fallback Exhaustion (모든 provider 실패)

**증상**:
- Telegram urgent: `🚨 Fallback Exhaustion`
- 팀 LLM 호출 전부 실패 (`ok: false, error: fallback_exhausted`)
- `/hub/llm/circuit` 에서 여러 provider OPEN

**확인**:
```bash
# 전체 Circuit 상태
curl -s -H "Authorization: Bearer $HUB_AUTH_TOKEN" \
  http://127.0.0.1:7788/hub/llm/circuit | jq '.'

# 최근 실패 현황
curl -s -H "Authorization: Bearer $HUB_AUTH_TOKEN" \
  "http://127.0.0.1:7788/hub/llm/stats?hours=1" | jq '.totals'
```

**대응**:
1. 네트워크 연결 확인 (`ping 8.8.8.8`)
2. 각 provider 개별 테스트:
   ```bash
   # Groq
   curl -s -H "Authorization: Bearer $HUB_AUTH_TOKEN" \
     http://127.0.0.1:7788/hub/llm/groq -d '{"prompt":"test","model":"llama-3.3-70b-versatile"}' \
     -H "Content-Type: application/json" | jq '.ok'
   # Claude Code
   curl -s -H "Authorization: Bearer $HUB_AUTH_TOKEN" \
     http://127.0.0.1:7788/hub/llm/oauth -d '{"prompt":"test","model":"haiku"}' \
     -H "Content-Type: application/json" | jq '.ok'
   ```
3. 모두 실패 시 → 인터넷 연결 또는 API 제한 확인
4. 긴급: Luna crypto 포지션만 수동 관리, 나머지 자동 시스템 일시 중단

---

## 빠른 진단 명령어

```bash
# 전체 LLM 상태 요약
curl -s -H "Authorization: Bearer $HUB_AUTH_TOKEN" \
  http://127.0.0.1:7788/hub/llm/health | jq '.'

# Provider 통계 (최근 1시간)
curl -s -H "Authorization: Bearer $HUB_AUTH_TOKEN" \
  "http://127.0.0.1:7788/hub/llm/stats?hours=1" | jq '.totals'

# Circuit Breaker 상태
curl -s -H "Authorization: Bearer $HUB_AUTH_TOKEN" \
  http://127.0.0.1:7788/hub/llm/circuit | jq '.local_llm_circuits'

# Prometheus 메트릭
curl -s -H "Authorization: Bearer $HUB_AUTH_TOKEN" \
  http://127.0.0.1:7788/hub/metrics/json | jq '.summary'
```

---

## Kill Switch 목록

| 환경변수 | 효과 | 기본값 |
|---------|------|--------|
| `HUB_BUDGET_GUARDIAN_ENABLED=false` | 예산 제한 해제 | true |
| `OLLAMA_DISABLED=true` | local/qwen 경로 비활성화 | 없음 |
| `HUB_CIRCUIT_BREAKER_SHADOW=true` | CB 관찰만 (차단 없음) | 없음 |

```bash
# Kill Switch 적용 + Hub 재시작
launchctl setenv OLLAMA_DISABLED true
launchctl kickstart -k gui/$(id -u)/ai.hub.resource-api
```
