# Hub LLM 라우팅 엔드포인트

> 작성: CODEX_LLM_ROUTING_REFACTOR / 2026-04-18

## 개요

Hub `/hub/llm/*` 엔드포인트는 Claude Code OAuth (Primary) + Groq (Fallback) 이중 체인을 제공합니다.
시그마/다윈 Elixir 에이전트가 Anthropic API를 직접 호출하는 대신 이 엔드포인트를 사용합니다.

## 엔드포인트

### POST /hub/llm/call — Primary + Fallback 통합 체인

**요청**:
```json
{
  "prompt": "한국의 수도는?",
  "abstractModel": "anthropic_haiku",
  "systemPrompt": "선택 사항",
  "jsonSchema": {},
  "timeoutMs": 60000,
  "agent": "darwin.evaluator",
  "callerTeam": "sigma",
  "urgency": "medium",
  "taskType": "evaluation_scoring"
}
```

**abstractModel 값**:
- `anthropic_haiku` → Claude Code haiku / Groq llama-3.1-8b-instant
- `anthropic_sonnet` → Claude Code sonnet / Groq llama-3.3-70b-versatile
- `anthropic_opus` → Claude Code opus / Groq qwen-qwq-32b

**응답**:
```json
{
  "ok": true,
  "provider": "claude-code-oauth",
  "result": "서울",
  "durationMs": 5200,
  "totalCostUsd": 0.0003,
  "fallbackCount": 0
}
```

**provider 값**: `claude-code-oauth` | `groq` | `failed`

### POST /hub/llm/oauth — Claude Code OAuth 단독 호출

```json
{ "prompt": "...", "model": "haiku" }
```

### POST /hub/llm/groq — Groq 단독 호출

```json
{ "prompt": "...", "model": "llama-3.3-70b-versatile" }
```

### GET /hub/llm/stats — provider × team × agent 집계

```
GET /hub/llm/stats?hours=24
GET /hub/llm/stats?hours=24&team=sigma
GET /hub/llm/stats?hours=168
```

**응답 예시**:
```json
{
  "ok": true,
  "hours": 24,
  "team": "all",
  "groq_pool_size": 9,
  "totals": { "total_calls": 120, "total_cost_usd": 0.05, "success_rate": 0.98 },
  "summary": [...],
  "by_agent": [...],
  "by_hour": [...]
}
```

## 인증

모든 LLM 엔드포인트에 Bearer 토큰 필수:

```
Authorization: Bearer <HUB_AUTH_TOKEN>
```

## Rate Limiting

LLM 전용: `30 req/min`

## Kill Switch

```bash
# Elixir 측 환경변수
LLM_HUB_ROUTING_ENABLED=false   # 기본값 (직접 Anthropic API 사용)
LLM_HUB_ROUTING_SHADOW=true     # Shadow 병렬 실행 (결과는 직접 호출 반환)
```

## Provider 매핑

| Abstract Model | Primary (OAuth) | Fallback (Groq) |
|---------------|----------------|----------------|
| anthropic_haiku | claude haiku | llama-3.1-8b-instant |
| anthropic_sonnet | claude sonnet | llama-3.3-70b-versatile |
| anthropic_opus | claude opus | qwen-qwq-32b |

## DB 로깅

모든 호출 결과는 `llm_routing_log` 테이블에 비동기 기록됩니다.

```sql
SELECT provider, caller_team, COUNT(*), AVG(duration_ms), SUM(cost_usd)
FROM llm_routing_log
WHERE created_at > NOW() - INTERVAL '24 hours'
GROUP BY provider, caller_team;
```

## Groq 계정 풀

`secrets-store.json` → `groq.accounts` 배열에서 랜덤 선택.
429 발생 시 해당 키 1분 블랙리스트 → 자동 다음 키 사용.
