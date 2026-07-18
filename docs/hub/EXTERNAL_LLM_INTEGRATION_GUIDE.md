# Hub External LLM Integration Guide

외부 프로젝트는 Hub를 단일 LLM gateway로 사용한다. 외부 프로젝트는 OpenAI/Groq/Gemini 토큰을 직접 보유하지 않고, Hub `/hub/llm/call`, `/hub/llm/jobs`, `/hub/llm/vision`, `/hub/llm/embeddings`만 호출한다. 모델 선택, fallback, 비용 로그, BillingGuard, provider circuit은 Hub가 담당한다.

## 0. 현재 운영 기준

2026-07-18 기준 운영 Hub 연결 상태는 다음 정책을 따른다. (provider admission, total deadline, 구조화 backpressure 패치 반영)

- LaunchAgent: `ai.hub.resource-api`
- 기본 URL: `http://localhost:7788`
- 인증: `Authorization: Bearer <HUB_AUTH_TOKEN>`
- 인증 경계: 현재 legacy root bearer는 신뢰된 프로젝트 전용이다. `X-Hub-Team`은 라우팅·Job 가시성 가드이며 악의적 tenant를 격리하는 인증 수단이 아니다. 신뢰하지 않는 tenant와 root token을 공유하지 않는다.
- Gemini 정책: `HUB_LLM_GEMINI_DISABLED=true`
- Gemini 직접 호출/토큰 refresh 점검: Gemini off 상태에서는 skip
- Direct provider endpoint: 기본 차단, 외부 프로젝트 사용 금지
- Provider rate-limit 쿨다운: 기본 ON — 429/풀 고갈 provider는 최소 30초 사전 스킵 후 폴백 진행 (`HUB_LLM_RATELIMIT_COOLDOWN_ENABLED`)
- Shared admission: 실제 provider 시도 직전에 `global + team + provider` lease 획득. provider 범위 포화만 다음 provider fallback 허용
- Timeout: token-budget/runtime-purpose/selector profile과 요청 `timeoutMs` 중 가장 보수적인 값 적용. 전체 deadline과 provider별 시도 timeout을 분리
- Provider 오류 전달: upstream `429/498/503`과 `Retry-After`를 `upstreamStatus`, `retryAfterMs`, `providerBackpressure`로 보존
- 중앙 정책 오류: `limiterBackpressure`, 비용/사이클 budget 차단, provider 종료 미확인은 외부 프로젝트의 provider 직접 fallback 금지
- Async job: admission backpressure이면 기존 job ID가 `queued`로 복귀하며 Hub가 재시도. 외부 프로젝트가 같은 작업을 새 job으로 중복 제출하지 않음
- Local 모델(qwen2.5-7b): `taskType`이 `backtest_*`인 호출에만 체인 포함 (`HUB_LLM_LOCAL_BACKTEST_ONLY=true` 기본). 그 외 호출에서 local 응답을 기대하지 말 것
- Local 콜드스타트: on-demand 언로드 상태 첫 호출은 자동 재시도(최대 180s)로 처리 — 호출측 추가 조치 불필요
- 정책 엔진: `HUB_LLM_POLICY_ENGINE_MODE=shadow` 가동 중 — 외부 호출 동작에 영향 없음(비교 기록만)
- 표준 검증: `gateway-contract`, guide smoke, agent-level LLM drill

현재 운영 상태와 문서 일치 여부는 아래 명령으로 확인한다. 토큰 값은 출력하지 않는다.

```bash
launchctl print gui/$(id -u)/ai.hub.resource-api | \
  rg 'state =|pid =|HUB_LLM_GEMINI_DISABLED|HUB_BASE_URL'
test -n "$(launchctl getenv HUB_AUTH_TOKEN)" && echo "HUB_AUTH_TOKEN present"

curl -fsS "$HUB_BASE_URL/hub/health/live"
curl -fsS "$HUB_BASE_URL/hub/health/ready"
curl -fsS -H "Authorization: Bearer $HUB_AUTH_TOKEN" \
  "$HUB_BASE_URL/hub/llm/gateway-contract" | \
  jq '{ok, contractVersion, contractRevision, contextSources, requestSchemas, selectorPolicy, providerPolicy, timeoutPolicy, backpressurePolicy}'
```

## 1. 연동 원칙

- 외부 프로젝트는 provider 직접 엔드포인트(`/hub/llm/oauth`, `/hub/llm/groq`)를 사용하지 않는다. 기본 운영에서는 차단된다.
- 기본 경로는 `POST /hub/llm/call`이다. 오래 걸리는 작업은 `POST /hub/llm/jobs`를 사용한다.
- 이미지/차트 분석은 `POST /hub/llm/vision`, RAG embedding은 `POST /hub/llm/embeddings`를 사용한다.
- 모델명 대신 `callerTeam + agent` 또는 `selectorKey`를 보낸다. Hub selector가 primary/fallback chain을 결정한다.
- 모든 요청은 `Authorization: Bearer <HUB_AUTH_TOKEN>`을 사용한다.
- 외부 프로젝트별 `callerTeam`, `agent`, `taskType`, `requestId`를 항상 넣어 비용/장애/품질 추적이 가능하게 한다.
- `selectorKey` 없이 runtime profile로 라우팅할 때는 `callerTeam + runtimePurpose`를 Hub에 먼저 등록한다. 승인된 `selectorKey`를 명시하는 외부 프로젝트도 온보딩 때 고정 purpose 목록을 합의하고 `taskType`을 같은 값으로 맞춘다.
- `timeoutMs`는 전체 호출 상한이다. 등록된 기본값보다 짧게 끝내야 할 때만 낮추며, 장문 writer는 최대 600초를 허용한다.
- 오류 문자열에서 상태를 추정하지 않고 HTTP status, `Retry-After`, body의 구조화 필드를 사용한다.
- `limiterBackpressure=true`, `providerBackpressure`, 중앙 budget 차단 응답에서는 외부 provider 직접 fallback을 절대 수행하지 않는다.
- secret, 원문 OAuth token, provider API key는 외부 프로젝트에 배포하지 않는다.
- `HUB_LLM_GEMINI_DISABLED=true` 운영 중에는 Gemini route가 selector/caller/direct OAuth 경로에서 제거되며, 외부 프로젝트는 Gemini provider를 기대값으로 고정하지 않는다.

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

이 endpoint는 provider 호출을 하지 않는다. 인증, endpoint, header, 필수 body, selector 정책, 관측 필드를 JSON으로 반환한다. 새 연동은 `contractVersion` 호환 여부와 `contractRevision`을 기록하고, `contextSources` 및 `requestSchemas`의 endpoint별 `requiredBody`, `requiredContext`, `oneOfBody`를 모두 검사한다. 최상위 `requiredBody`는 구형 소비자 호환용이며 `syncCall`과 `asyncJob`에만 적용된다.

## 4. 동기 호출

`/hub/llm/call`은 짧은 응답, classification, summarization, JSON extraction 같은 fast path에 사용한다.

```bash
curl -fsS "$HUB_BASE_URL/hub/llm/call" \
  -H "Authorization: Bearer $HUB_AUTH_TOKEN" \
  -H "Content-Type: application/json" \
  -H "X-Hub-Team: external-blog" \
  -H "X-Hub-Agent: smoke" \
  -H "X-Hub-Priority: normal" \
  -d '{
    "callerTeam": "external-blog",
    "agent": "smoke",
    "selectorKey": "blog.star.summarize",
    "runtimePurpose": "draft_outline",
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
  "provider": "groq",
  "result": "...",
  "durationMs": 243,
  "fallbackCount": 0,
  "selectorKey": "blog.star.summarize",
  "selected_route": "groq/llama-3.1-8b-instant",
  "budgetGuardStatus": "allowed",
  "providerTiers": [
    { "provider": "groq", "route": "groq/llama-3.1-8b-instant", "tier": 2, "fallbackIndex": 0 }
  ],
  "traceId": "..."
}
```

Gemini off 운영 중 정상 응답의 `provider` 또는 `selected_route`에 `gemini-*`가 나오면 가이드/운영 불일치로 본다.

긴 글쓰기/고품질 작성 경로는 `blog.pos.writer` 또는 `blog.gems.writer`처럼 Claude/OpenAI selector를 사용한다. canonical `callerTeam=blog` writer는 전체 600초, provider별 시도 420초까지 허용된다. 다른 외부 팀은 기본 180초 상한을 따르며, 더 긴 작업은 `/hub/llm/jobs`를 사용하거나 Hub 운영 담당에게 전용 timeout profile 등록을 요청한다.

## 5. Selector 지정 방식

권장 순서는 다음과 같다.

1. 외부 프로젝트가 이미 Hub registry에 등록된 팀/에이전트라면 `callerTeam + agent`를 사용한다.
2. registry에 아직 등록되지 않은 외부 프로젝트는 `callerTeam + agent + selectorKey`를 사용한다.
3. `chain` 직접 지정은 기본 차단된다. 운영 예외가 필요하면 Hub 쪽에서 별도 승인과 환경 게이트를 설정해야 한다.

현재 Gemini 비활성 정책:

- `HUB_LLM_GEMINI_DISABLED=true`이면 `gemini-oauth`, `gemini-cli-oauth`, `gemini-codeassist-oauth`는 실행 전 제거된다.
- Gemini만 남은 selector는 `gemini_provider_disabled`로 실패한다.
- Gemini token refresh/monitor는 off 상태에서 skip되어 불필요한 인증 경고를 만들지 않는다.
- Gemini OAuth 인증 참고는 `docs/hub/OAUTH_REAUTH_GUIDE.md`의 "Gemini OAuth 연결"을 따른다. 실제 provider 재활성화는 Hub 운영 담당의 별도 승인 후 진행한다.

예시:

```json
{
  "callerTeam": "blog",
  "agent": "pos",
  "runtimePurpose": "writer",
  "taskType": "writer",
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
  "runtimePurpose": "external_blog_post",
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
  "runtimePurpose": "writer",
  "taskType": "writer",
  "abstractModel": "anthropic_haiku",
  "prompt": "..."
}
```

## 6. 비동기 Job 호출

긴 리서치, 다문서 요약, 긴 JSON extraction은 `/hub/llm/jobs`를 사용한다.

사용 endpoint:

- `POST /hub/llm/jobs`
- `GET /hub/llm/jobs?limit=<1..100>`
- `GET /hub/llm/jobs/:id`
- `GET /hub/llm/jobs/:id/result`

```bash
JOB_ID="$(
  curl -fsS "$HUB_BASE_URL/hub/llm/jobs" \
    -H "Authorization: Bearer $HUB_AUTH_TOKEN" \
    -H "Content-Type: application/json" \
    -H "X-Hub-Team: external-research" \
    -d '{
      "callerTeam": "external-research",
      "agent": "summarizer",
      "selectorKey": "darwin.agent_policy",
      "runtimePurpose": "synthesis",
      "taskType": "synthesis",
      "requestId": "external-research-20260513-0001",
      "abstractModel": "anthropic_sonnet",
      "prompt": "긴 자료를 한국어로 요약해줘.",
      "timeoutMs": 180000,
      "maxBudgetUsd": 0.25
    }' | jq -r .jobId
)"

curl -fsS \
  -H "Authorization: Bearer $HUB_AUTH_TOKEN" \
  -H "X-Hub-Team: external-research" \
  "$HUB_BASE_URL/hub/llm/jobs/$JOB_ID"

curl -fsS \
  -H "Authorization: Bearer $HUB_AUTH_TOKEN" \
  -H "X-Hub-Team: external-research" \
  "$HUB_BASE_URL/hub/llm/jobs/$JOB_ID/result"
```

Job 생성과 목록·상태·결과 조회에는 같은 `X-Hub-Team`을 사용한다. 생성 header와 body가 다르면 `400 callerTeam_mismatch`, 조회 헤더가 없으면 `400 callerTeam_required`, 다른 팀 Job이면 `404 llm_job_not_found`다. 외부 프로젝트는 다른 팀 이름으로 Job을 조회하거나 팀 헤더를 생략하지 않는다. 이 가드는 실수성 교차 조회를 막지만, 공유 legacy root bearer를 가진 악의적 호출자의 팀 사칭까지 막는 tenant 인증은 아니다.

`status=queued`와 `retryAfterMs`가 반환되면 같은 job ID를 계속 조회한다. admission backpressure 때문에 새 job을 다시 만들면 동일 작업이 중복 실행될 수 있다.

## 7. Vision/Embedding 호출

차트, UI screenshot, 이미지 검수는 `/hub/llm/vision`을 사용한다. 외부 프로젝트는 이미지 base64만 보내고 provider token은 보유하지 않는다.

```bash
curl -fsS "$HUB_BASE_URL/hub/llm/vision" \
  -H "Authorization: Bearer $HUB_AUTH_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "callerTeam": "external-chart",
    "agent": "vision",
    "selectorKey": "investment.agent_policy",
    "runtimePurpose": "chart_vision",
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
    "runtimePurpose": "rag_embedding",
    "taskType": "rag_embedding",
    "input": "검색에 사용할 문서 텍스트",
    "timeoutMs": 30000
  }'
```

## 8. Node.js 최소 클라이언트

```js
import { randomUUID } from "node:crypto";

const NO_DIRECT_FALLBACK_CODES = new Set([
  "budget_exceeded",
  "cycle_budget_exceeded",
  "job_enqueue_failed",
  "llm_total_deadline_exceeded",
  "provider_termination_unconfirmed",
  "token_budget_exceeded",
]);

function hubErrorCode(payload) {
  if (payload?.providerBackpressure?.kind) return String(payload.providerBackpressure.kind);
  if (payload?.error && typeof payload.error === "object") {
    return String(payload.error.code || payload.code || "hub_call_failed");
  }
  return String(payload?.code || payload?.error || payload?.reason || "hub_call_failed").split(":")[0];
}

function retryAfterMs(response, payload) {
  const bodyValue = Number(payload?.retryAfterMs || payload?.providerBackpressure?.retryAfterMs || 0);
  if (Number.isFinite(bodyValue) && bodyValue > 0) return Math.round(bodyValue);

  const header = response.headers.get("retry-after");
  if (!header) return 0;
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000);
  const at = Date.parse(header);
  return Number.isFinite(at) ? Math.max(0, at - Date.now()) : 0;
}

export class HubGatewayError extends Error {
  constructor(response, payload) {
    const code = hubErrorCode(payload);
    super(`hub_llm_failed status=${response.status} code=${code}`);
    this.name = "HubGatewayError";
    this.code = code;
    this.httpStatus = response.status;
    this.upstreamStatus = Number(payload?.upstreamStatus || 0);
    this.retryAfterMs = retryAfterMs(response, payload);
    this.providerBackpressure = payload?.providerBackpressure || null;
    this.limiterBackpressure = payload?.limiterBackpressure === true;
    this.admissionScope = payload?.admissionScope || null;
    this.noDirectFallback = this.limiterBackpressure
      || Boolean(this.providerBackpressure)
      || code.startsWith("shared_limiter_")
      || NO_DIRECT_FALLBACK_CODES.has(code);
    this.payload = payload;
  }
}

export async function callHubLlm({
  prompt,
  systemPrompt,
  callerTeam = process.env.HUB_CALLER_TEAM || "external",
  agent = process.env.HUB_AGENT || "default",
  selectorKey,
  runtimePurpose = "external_llm_call",
  taskType = runtimePurpose,
  requestId = randomUUID(),
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
      selectorKey,
      runtimePurpose,
      taskType,
      requestId,
      abstractModel,
      timeoutMs,
      maxBudgetUsd,
      cacheEnabled: false,
    }),
    signal: AbortSignal.timeout(timeoutMs + 5000),
  });

  const decoded = await response.json().catch(() => null);
  const payload = decoded && typeof decoded === "object" && !Array.isArray(decoded)
    ? decoded
    : {};
  if (!response.ok || payload.ok !== true) {
    throw new HubGatewayError(response, payload);
  }
  return payload;
}
```

`HubGatewayError.noDirectFallback=true`이거나 Hub transport가 실패하면 provider SDK로 우회하지 않는다. `retryAfterMs` 이후 같은 Hub 요청을 재시도하거나 상위 큐로 넘긴다. canonical Blog writer가 600초 profile을 사용할 때만 `timeoutMs: 600000`을 명시해 클라이언트 transport도 먼저 종료되지 않게 한다.

## 9. Python 최소 클라이언트

```python
import os
from datetime import datetime, timezone
from email.utils import parsedate_to_datetime
import uuid
import requests


class HubGatewayError(RuntimeError):
    def __init__(self, response: requests.Response, payload: dict):
        provider_backpressure = payload.get("providerBackpressure") or None
        error = payload.get("error")
        if isinstance(provider_backpressure, dict) and provider_backpressure.get("kind"):
            code = str(provider_backpressure["kind"])
        elif isinstance(error, dict):
            code = str(error.get("code") or payload.get("code") or "hub_call_failed")
        else:
            code = str(payload.get("code") or error or payload.get("reason") or "hub_call_failed").split(":")[0]

        retry_after_ms = int(payload.get("retryAfterMs") or 0)
        if not retry_after_ms and isinstance(provider_backpressure, dict):
            retry_after_ms = int(provider_backpressure.get("retryAfterMs") or 0)
        if not retry_after_ms and response.headers.get("Retry-After"):
            header = response.headers["Retry-After"]
            try:
                retry_after_ms = round(float(header) * 1000)
            except ValueError:
                try:
                    retry_at = parsedate_to_datetime(header)
                    if retry_at.tzinfo is None:
                        retry_at = retry_at.replace(tzinfo=timezone.utc)
                    retry_after_ms = max(0, round((retry_at - datetime.now(timezone.utc)).total_seconds() * 1000))
                except (TypeError, ValueError):
                    retry_after_ms = 0

        super().__init__(f"hub_llm_failed status={response.status_code} code={code}")
        self.code = code
        self.http_status = response.status_code
        self.upstream_status = int(payload.get("upstreamStatus") or 0)
        self.retry_after_ms = retry_after_ms
        self.provider_backpressure = provider_backpressure
        self.limiter_backpressure = payload.get("limiterBackpressure") is True
        self.admission_scope = payload.get("admissionScope")
        self.no_direct_fallback = (
            self.limiter_backpressure
            or bool(provider_backpressure)
            or code.startswith("shared_limiter_")
            or code in {
                "budget_exceeded",
                "cycle_budget_exceeded",
                "job_enqueue_failed",
                "llm_total_deadline_exceeded",
                "provider_termination_unconfirmed",
                "token_budget_exceeded",
            }
        )
        self.payload = payload


def call_hub_llm(
    prompt: str,
    *,
    selector_key: str,
    runtime_purpose: str = "external_llm_call",
    timeout_ms: int = 45_000,
    request_id=None,
) -> dict:
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
            "selectorKey": selector_key,
            "runtimePurpose": runtime_purpose,
            "taskType": runtime_purpose,
            "requestId": request_id or str(uuid.uuid4()),
            "abstractModel": "anthropic_haiku",
            "timeoutMs": timeout_ms,
            "maxBudgetUsd": 0.05,
            "cacheEnabled": False,
        },
        timeout=(5, (timeout_ms + 5_000) / 1000),
    )
    try:
        payload = response.json()
    except ValueError:
        payload = {}
    if not isinstance(payload, dict):
        payload = {}
    if not response.ok or payload.get("ok") is not True:
        raise HubGatewayError(response, payload)
    return payload
```

Python 호출부도 `HubGatewayError.retry_after_ms`를 재시도 기준으로 사용하며 provider 직접 fallback은 구현하지 않는다.

## 10. 에러 처리 계약

외부 프로젝트는 아래 에러를 재시도/중단 정책에 반영한다.

| HTTP/status | 의미 | 권장 처리 |
| --- | --- | --- |
| `401 missing_bearer_token`, `401 invalid_bearer_token` | 인증 실패 | token 재주입 또는 배포 중단 |
| `403 llm_non_llm_target_blocked` | non-LLM 역할 호출 | 코드 버그로 보고, 재시도 금지 |
| `403 llm_route_target_not_active` 계열 | 미등록/비활성 target | Hub registry 등록 요청 |
| `400 invalid_llm_call_payload` | payload 스키마 오류 | 요청 생성 코드 수정 |
| `ok=false`, `llm_selector_chain_required` | selectorKey 미매칭 (주원인: **팀 prefix 누락** — `alarm.interpreter.work`가 아니라 `hub.alarm.interpreter.work`) | selectorKey를 팀 prefix 포함 정식 키로 수정 |
| `429` + `providerBackpressure.kind=provider_rate_limit` | 실제 provider rate limit | `retryAfterMs` 또는 `Retry-After` 이후 같은 Hub 요청 재시도 |
| `429` + `limiterBackpressure=true`, `admissionScope=provider:*` | 해당 provider 범위 capacity 포화 | Hub가 다른 provider를 이미 검토한 결과이므로 직접 fallback 금지, backoff |
| `503` + `providerBackpressure.kind=provider_unavailable` | 실제 provider 과부하/일시 장애 | `retryAfterMs` 기반 Hub 재시도 |
| `503` + `limiterBackpressure=true` | global/team admission 또는 lease 안전 실패 | 직접 fallback 금지, 상위 큐로 이관 |
| `504 llm_total_deadline_exceeded` | 요청 전체 deadline 소진 | 요청 축소 또는 `/hub/llm/jobs`로 전환 |
| `provider_termination_unconfirmed` | provider 프로세스 종료 미확인 | 자동 우회 금지, incident 발행 |
| `token_budget_exceeded`, `budget_exceeded`, `cycle_budget_exceeded` | 중앙 비용 정책 차단 | 예산/요청 수정, provider 우회 금지 |
| `ok=false`, `gemini_provider_disabled` | Gemini 비활성 상태에서 Gemini-only 경로 요청 | selectorKey 또는 Hub registry를 OpenAI/Groq/Claude/Local 포함 경로로 수정 |
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
  fallback_count,
  admission_fallback_count,
  admission_rejections,
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
- 사용할 `agent`, `runtimePurpose`, `taskType` 목록을 정하고 purpose 문자열을 고정한다.
- Hub registry/selector에 필요한 route target을 등록한다.
- `selectorKey` 없이 라우팅할 프로젝트는 `callerTeam + runtimePurpose` runtime profile도 등록한다.
- registry 등록 전에는 승인된 `selectorKey`를 함께 전송한다.
- non-LLM 역할은 LLM 호출 대상에서 제외한다.
- 외부 프로젝트에는 `HUB_BASE_URL`, `HUB_AUTH_TOKEN`, `HUB_CALLER_TEAM`, `HUB_AGENT`만 주입한다.
- 런타임 시작 시 `/hub/llm/gateway-contract`를 조회해 계약 버전과 필수 header/body를 확인한다.
- staging에서 `/hub/llm/call` 1회, `/hub/llm/jobs` 1회, `/hub/llm/stats` 조회를 통과시킨다.
- 이미지/RAG 기능을 쓰는 프로젝트는 `/hub/llm/vision`, `/hub/llm/embeddings` dry-run fixture 호출도 통과시킨다.
- 운영 전 `hub.llm_request_log`에 `request_id`, `runtime_purpose`, `estimated_cost_usd`, `budget_guard_status`가 남는지 확인한다.
- fixture에서 provider `429`, admission `503`, total deadline `504`를 재현해 구조화 필드와 `Retry-After` 처리를 확인한다.
- 모든 오류 경로에서 provider API key/OAuth 없이 Hub 재시도 또는 큐 이관만 수행하는지 확인한다.
- Gemini off 운영이면 `gateway-contract.providerPolicy.geminiDisabled=true`와 agent-level drill 결과의 Gemini 잔여 `0건`을 확인한다.
- 게시/팀 운영 소스 잔여 검사는 `npm --prefix bots/hub run -s llm:gemini-residue-audit`로 확인한다.

## 13. Stage C 운영 계약

Stage C부터 외부 프로젝트 연동은 Hub 표준 LLM Gateway 계약으로 관리한다.

- Gateway contract: `GET /hub/llm/gateway-contract`
- 통합 검증: `npm --prefix bots/hub run -s llm:external-gateway-contract-smoke`
- 전체 Stage C 검증: `npm --prefix bots/hub run -s check:llm-stage-c`
- 운영 문서: `docs/hub/HUB_STAGE_C_OPERATIONS.md`
- 에이전트 단위 LLM 검증: `npm --prefix bots/hub run -s team:agent-llm-drill:live -- --teams=all --primary-only`

대량 live drill은 Hub LLM rate limit과 provider OAuth timeout 영향을 줄이기 위해 아래처럼 저속 실행한다.

```bash
HUB_MULTI_AGENT_LLM_DRILL_CONCURRENCY=1 \
HUB_MULTI_AGENT_LLM_DRILL_DELAY_MS=2000 \
HUB_MULTI_AGENT_LLM_DRILL_MAX_TOKENS=8 \
npm --prefix bots/hub run -s team:agent-llm-drill:live -- --teams=all --primary-only
```

외부 프로젝트는 장애 시 자체 provider fallback을 구현하지 않는다. Hub 응답의 `upstreamStatus`, `retryAfterMs`, `Retry-After`, `providerBackpressure`, `limiterBackpressure`, `admissionScope`, `fallbackCount`, `traceId`를 사용해 재시도/incident 정책만 수행한다.

## 14. 운영 금지 사항

- 외부 프로젝트에 provider API key 또는 OAuth token을 배포하지 않는다.
- direct provider endpoint를 사용하지 않는다.
- 임의 `chain`을 외부 프로젝트가 직접 지정하지 않는다.
- `maxBudgetUsd` 없는 대량/장문 호출을 금지한다.
- 장애 시 외부 프로젝트가 Hub/PROTECTED launchd를 재시작하지 않는다. Hub 운영 루트로 incident를 올린다.
