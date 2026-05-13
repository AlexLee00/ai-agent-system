# Hub External LLM Integration Guide

외부 프로젝트는 Hub를 단일 LLM gateway로 사용한다. 외부 프로젝트는 OpenAI/Groq/Gemini 토큰을 직접 보유하지 않고, Hub `/hub/llm/call`, `/hub/llm/jobs`, `/hub/llm/vision`, `/hub/llm/embeddings`만 호출한다. 모델 선택, fallback, 비용 로그, BillingGuard, provider circuit은 Hub가 담당한다.

## 1. 연동 원칙

- 외부 프로젝트는 provider 직접 엔드포인트(`/hub/llm/oauth`, `/hub/llm/groq`)를 사용하지 않는다. 기본 운영에서는 차단된다.
- 기본 경로는 `POST /hub/llm/call`이다. 오래 걸리는 작업은 `POST /hub/llm/jobs`를 사용한다.
- 이미지/차트 분석은 `POST /hub/llm/vision`, RAG embedding은 `POST /hub/llm/embeddings`를 사용한다.
- 모델명 대신 `callerTeam + agent` 또는 `selectorKey`를 보낸다. Hub selector가 primary/fallback chain을 결정한다.
- 모든 요청은 `Authorization: Bearer <HUB_AUTH_TOKEN>`을 사용한다.
- 외부 프로젝트별 `callerTeam`, `agent`, `taskType`, `requestId`를 항상 넣어 비용/장애/품질 추적이 가능하게 한다.
- secret, 원문 OAuth token, provider API key는 외부 프로젝트에 배포하지 않는다.

## 2. 사전 준비

Hub 접근 정보는 외부 프로젝트의 런타임 환경변수로 둔다.

```bash
export HUB_BASE_URL="http://localhost:7788"
export HUB_AUTH_TOKEN="..."
export HUB_CALLER_TEAM="external-blog"
export HUB_AGENT="writer"
```

운영망에서 사용할 때는 `HUB_BASE_URL`을 내부 DNS 또는 reverse proxy 주소로 바꾼다. 외부 공개망 노출이 필요하면 TLS, IP allowlist, token rotation을 먼저 적용한다.

## 3. Health Check

인증 없이 live/readiness만 확인할 수 있다.

```bash
curl -fsS "$HUB_BASE_URL/hub/health/live"
curl -fsS "$HUB_BASE_URL/hub/health/ready"
```

LLM health, stats 등 `/hub/llm/*` 경로는 Bearer 인증이 필요하다.

```bash
curl -fsS \
  -H "Authorization: Bearer $HUB_AUTH_TOKEN" \
  "$HUB_BASE_URL/hub/llm/health"
```

외부 프로젝트가 런타임에서 계약을 자동 점검해야 하면 Stage C의 기계 판독 계약을 조회한다.

```bash
curl -fsS \
  -H "Authorization: Bearer $HUB_AUTH_TOKEN" \
  "$HUB_BASE_URL/hub/llm/gateway-contract"
```

이 endpoint는 provider 호출을 하지 않는다. 인증, endpoint, header, 필수 body, selector 정책, 관측 필드를 JSON으로 반환한다.

## 4. 동기 호출

`/hub/llm/call`은 짧은 응답, classification, summarization, JSON extraction 같은 fast path에 사용한다.

```bash
curl -fsS "$HUB_BASE_URL/hub/llm/call" \
  -H "Authorization: Bearer $HUB_AUTH_TOKEN" \
  -H "Content-Type: application/json" \
  -H "X-Hub-Team: external-blog" \
  -H "X-Hub-Agent: writer" \
  -H "X-Hub-Priority: normal" \
  -d '{
    "callerTeam": "external-blog",
    "agent": "writer",
    "taskType": "draft_outline",
    "requestId": "external-blog-20260513-0001",
    "abstractModel": "anthropic_haiku",
    "systemPrompt": "Return concise Korean.",
    "prompt": "네이버 블로그 글의 5개 섹션 outline을 작성해줘.",
    "timeoutMs": 45000,
    "maxBudgetUsd": 0.05,
    "cacheEnabled": false
  }'
```

정상 응답 예시:

```json
{
  "ok": true,
  "provider": "gemini-cli-oauth",
  "result": "...",
  "durationMs": 7244,
  "fallbackCount": 0,
  "selectorKey": "blog.pos.writer",
  "selected_route": "gemini-cli-oauth/gemini-2.5-flash",
  "budgetGuardStatus": "allowed",
  "providerTiers": [
    { "provider": "gemini-cli-oauth", "route": "gemini-cli-oauth/gemini-2.5-flash", "tier": 3, "fallbackIndex": 0 },
    { "provider": "openai-oauth", "route": "openai-oauth/gpt-5.4", "tier": 1, "fallbackIndex": 1 }
  ],
  "traceId": "..."
}
```

## 5. Selector 지정 방식

권장 순서는 다음과 같다.

1. 외부 프로젝트가 이미 Hub registry에 등록된 팀/에이전트라면 `callerTeam + agent`를 사용한다.
2. registry에 아직 등록되지 않은 외부 프로젝트는 `callerTeam + agent + selectorKey`를 사용한다.
3. `chain` 직접 지정은 기본 차단된다. 운영 예외가 필요하면 Hub 쪽에서 별도 승인과 환경 게이트를 설정해야 한다.

예시:

```json
{
  "callerTeam": "blog",
  "agent": "pos",
  "taskType": "external_blog_post",
  "abstractModel": "anthropic_haiku",
  "prompt": "..."
}
```

미등록 외부 프로젝트의 표준 예시는 다음과 같다.

```json
{
  "callerTeam": "external-blog",
  "agent": "writer",
  "selectorKey": "blog.pos.writer",
  "taskType": "external_blog_post",
  "requestId": "external-blog-20260513-0001",
  "abstractModel": "anthropic_haiku",
  "prompt": "...",
  "maxBudgetUsd": 0.05
}
```

이 방식은 비용/장애 집계는 `external-blog.writer`로 남기고, 모델 라우팅은 Hub가 승인한 `blog.pos.writer` selector를 사용한다.

```json
{
  "callerTeam": "blog",
  "agent": "pos",
  "selectorKey": "blog.pos.writer",
  "taskType": "external_blog_post",
  "abstractModel": "anthropic_haiku",
  "prompt": "..."
}
```

## 6. 비동기 Job 호출

긴 리서치, 다문서 요약, 긴 JSON extraction은 `/hub/llm/jobs`를 사용한다.

사용 endpoint:

- `POST /hub/llm/jobs`
- `GET /hub/llm/jobs/:id`
- `GET /hub/llm/jobs/:id/result`

```bash
JOB_ID="$(
  curl -fsS "$HUB_BASE_URL/hub/llm/jobs" \
    -H "Authorization: Bearer $HUB_AUTH_TOKEN" \
    -H "Content-Type: application/json" \
    -d '{
      "callerTeam": "external-research",
      "agent": "summarizer",
      "taskType": "long_research_summary",
      "requestId": "external-research-20260513-0001",
      "abstractModel": "anthropic_sonnet",
      "prompt": "긴 자료를 한국어로 요약해줘.",
      "timeoutMs": 180000,
      "maxBudgetUsd": 0.25
    }' | jq -r .jobId
)"

curl -fsS \
  -H "Authorization: Bearer $HUB_AUTH_TOKEN" \
  "$HUB_BASE_URL/hub/llm/jobs/$JOB_ID"

curl -fsS \
  -H "Authorization: Bearer $HUB_AUTH_TOKEN" \
  "$HUB_BASE_URL/hub/llm/jobs/$JOB_ID/result"
```

## 7. Vision/Embedding 호출

차트, UI screenshot, 이미지 검수는 `/hub/llm/vision`을 사용한다. 외부 프로젝트는 이미지 base64만 보내고 provider token은 보유하지 않는다.

```bash
curl -fsS "$HUB_BASE_URL/hub/llm/vision" \
  -H "Authorization: Bearer $HUB_AUTH_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "callerTeam": "external-chart",
    "agent": "vision",
    "selectorKey": "hub._default",
    "taskType": "chart_vision",
    "prompt": "이 차트의 패턴과 리스크를 JSON으로 요약해줘.",
    "imageBase64": "<base64_png>",
    "mimeType": "image/png",
    "timeoutMs": 45000,
    "maxBudgetUsd": 0.05
  }'
```

RAG 벡터 생성은 `/hub/llm/embeddings`를 사용한다. 반환 dimension은 Hub embedding backend에 따라 달라질 수 있으므로 외부 DB vector column과 맞는지 초기 온보딩 때 확인한다.

```bash
curl -fsS "$HUB_BASE_URL/hub/llm/embeddings" \
  -H "Authorization: Bearer $HUB_AUTH_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "callerTeam": "external-research",
    "agent": "rag",
    "selectorKey": "hub._default",
    "taskType": "rag_embedding",
    "input": "검색에 사용할 문서 텍스트",
    "timeoutMs": 30000
  }'
```

## 8. Node.js 최소 클라이언트

```js
export async function callHubLlm({
  prompt,
  systemPrompt,
  callerTeam = process.env.HUB_CALLER_TEAM || "external",
  agent = process.env.HUB_AGENT || "default",
  taskType = "external_llm_call",
  abstractModel = "anthropic_haiku",
  timeoutMs = 45000,
  maxBudgetUsd = 0.05,
}) {
  const baseUrl = (process.env.HUB_BASE_URL || "http://localhost:7788").replace(/\/+$/, "");
  const token = process.env.HUB_AUTH_TOKEN;
  if (!token) throw new Error("HUB_AUTH_TOKEN is required");

  const response = await fetch(`${baseUrl}/hub/llm/call`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "X-Hub-Team": callerTeam,
      "X-Hub-Agent": agent,
      "X-Hub-Priority": "normal",
    },
    body: JSON.stringify({
      prompt,
      systemPrompt,
      callerTeam,
      agent,
      taskType,
      abstractModel,
      timeoutMs,
      maxBudgetUsd,
      cacheEnabled: false,
    }),
    signal: AbortSignal.timeout(timeoutMs + 5000),
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload.ok === false) {
    throw new Error(`hub_llm_failed status=${response.status} error=${payload.error?.code || payload.error || "unknown"}`);
  }
  return payload;
}
```

## 9. Python 최소 클라이언트

```python
import os
import requests


def call_hub_llm(prompt: str, *, task_type: str = "external_llm_call") -> dict:
    base_url = os.environ.get("HUB_BASE_URL", "http://localhost:7788").rstrip("/")
    token = os.environ["HUB_AUTH_TOKEN"]
    caller_team = os.environ.get("HUB_CALLER_TEAM", "external")
    agent = os.environ.get("HUB_AGENT", "default")

    response = requests.post(
        f"{base_url}/hub/llm/call",
        headers={
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/json",
            "X-Hub-Team": caller_team,
            "X-Hub-Agent": agent,
            "X-Hub-Priority": "normal",
        },
        json={
            "prompt": prompt,
            "callerTeam": caller_team,
            "agent": agent,
            "taskType": task_type,
            "abstractModel": "anthropic_haiku",
            "timeoutMs": 45000,
            "maxBudgetUsd": 0.05,
            "cacheEnabled": False,
        },
        timeout=50,
    )
    payload = response.json()
    if not response.ok or payload.get("ok") is False:
        raise RuntimeError(f"hub_llm_failed status={response.status_code} error={payload.get('error')}")
    return payload
```

## 10. 에러 처리 계약

외부 프로젝트는 아래 에러를 재시도/중단 정책에 반영한다.

| HTTP/status | 의미 | 권장 처리 |
| --- | --- | --- |
| `401 missing_bearer_token`, `401 invalid_bearer_token` | 인증 실패 | token 재주입 또는 배포 중단 |
| `403 llm_non_llm_target_blocked` | non-LLM 역할 호출 | 코드 버그로 보고, 재시도 금지 |
| `403 llm_route_target_not_active` 계열 | 미등록/비활성 target | Hub registry 등록 요청 |
| `400 invalid_llm_call_payload` | payload 스키마 오류 | 요청 생성 코드 수정 |
| `429` | rate/admission 제한 | `Retry-After` 기반 backoff |
| `503` | Hub 준비 안 됨 또는 shutdown | exponential backoff |
| `ok=false`, `fallback_exhausted` | provider chain 전체 실패 | 짧은 backoff 후 1회 재시도, 이후 incident 발행 |

## 11. 관측과 비용 확인

최근 호출은 canonical view에서 확인한다.

```sql
SELECT
  created_at,
  caller_team,
  agent,
  selector_key,
  selected_route,
  provider,
  runtime_purpose,
  estimated_cost_usd,
  budget_guard_status,
  success,
  error
FROM hub.llm_request_log
WHERE caller_team = 'external-blog'
ORDER BY created_at DESC
LIMIT 20;
```

HTTP 집계는 다음을 사용한다.

```bash
curl -fsS \
  -H "Authorization: Bearer $HUB_AUTH_TOKEN" \
  "$HUB_BASE_URL/hub/llm/stats?hours=24&team=external-blog"
```

## 12. 외부 프로젝트 온보딩 체크리스트

- `callerTeam` 이름을 정한다. 예: `external-blog`, `external-research`.
- 사용할 `agent`와 `taskType` 목록을 정한다.
- Hub registry/selector에 필요한 route target을 등록한다.
- registry 등록 전에는 승인된 `selectorKey`를 함께 전송한다.
- non-LLM 역할은 LLM 호출 대상에서 제외한다.
- 외부 프로젝트에는 `HUB_BASE_URL`, `HUB_AUTH_TOKEN`, `HUB_CALLER_TEAM`, `HUB_AGENT`만 주입한다.
- 런타임 시작 시 `/hub/llm/gateway-contract`를 조회해 계약 버전과 필수 header/body를 확인한다.
- staging에서 `/hub/llm/call` 1회, `/hub/llm/jobs` 1회, `/hub/llm/stats` 조회를 통과시킨다.
- 이미지/RAG 기능을 쓰는 프로젝트는 `/hub/llm/vision`, `/hub/llm/embeddings` dry-run fixture 호출도 통과시킨다.
- 운영 전 `hub.llm_request_log`에 `request_id`, `runtime_purpose`, `estimated_cost_usd`, `budget_guard_status`가 남는지 확인한다.

## 13. Stage C 운영 계약

Stage C부터 외부 프로젝트 연동은 Hub 표준 LLM Gateway 계약으로 관리한다.

- Gateway contract: `GET /hub/llm/gateway-contract`
- 통합 검증: `npm --prefix bots/hub run -s llm:external-gateway-contract-smoke`
- 전체 Stage C 검증: `npm --prefix bots/hub run -s check:llm-stage-c`
- 운영 문서: `docs/hub/HUB_STAGE_C_OPERATIONS.md`

외부 프로젝트는 장애 시 자체 provider fallback을 구현하지 않는다. Hub 응답의 `Retry-After`, `providerBackpressure`, `fallbackCount`, `traceId`를 사용해 재시도/incident 정책만 수행한다.

## 14. 운영 금지 사항

- 외부 프로젝트에 provider API key 또는 OAuth token을 배포하지 않는다.
- direct provider endpoint를 사용하지 않는다.
- 임의 `chain`을 외부 프로젝트가 직접 지정하지 않는다.
- `maxBudgetUsd` 없는 대량/장문 호출을 금지한다.
- 장애 시 외부 프로젝트가 Hub/PROTECTED launchd를 재시작하지 않는다. Hub 운영 루트로 incident를 올린다.
