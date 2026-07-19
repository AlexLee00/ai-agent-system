# External LLM Gateway Project Onboarding

External projects must use Hub as the standard LLM gateway. They should not call OpenAI, Anthropic, Groq, Gemini, or local model providers directly.

## Current Hub Policy

- Standard Hub URL: `http://localhost:7788`
- LaunchAgent: `ai.hub.resource-api`
- Auth: `Authorization: Bearer <HUB_AUTH_TOKEN>`
- Trust boundary: the legacy root bearer is only for trusted projects. `X-Hub-Team` is not tenant authentication; never share the root token with an untrusted tenant.
- Gemini: retired. `HUB_LLM_GEMINI_DISABLED=true` is declaration-only and cannot re-enable the provider.
- Gemini re-enable policy: reviewed code change only (`code_change_only`), never an environment toggle.
- Direct provider routes: `disabled_by_default`
- Provider secrets/OAuth tokens: Hub only, never copied into external projects
- Admission: provider 시도 직전에 `global + team + provider` lease를 획득
- Timeout: 요청 전체 deadline과 provider별 시도 timeout을 분리
- Retry contract: `upstreamStatus`, `retryAfterMs`, `providerBackpressure`, `limiterBackpressure`, `admissionScope` 사용

Check the live contract before wiring a project:

```bash
curl -fsS -H "Authorization: Bearer $HUB_AUTH_TOKEN" \
  "$HUB_BASE_URL/hub/llm/gateway-contract" | \
  jq '{ok, contractVersion, contractRevision, contextSources, requestSchemas, selectorPolicy, providerPolicy, timeoutPolicy, backpressurePolicy}'
```

Reject an unsupported `contractVersion`, record `contractRevision`, and validate each endpoint's `requiredBody`, `requiredContext`, and `oneOfBody` against `contextSources`. Do not infer one endpoint's request shape from the legacy top-level `requiredBody` field.

Require `providerPolicy.geminiRetired=true` and `geminiReenablePolicy=code_change_only`. Never pin an external project to a Gemini selector.

## Required Request Shape

```bash
curl -sS "$HUB_BASE_URL/hub/llm/call" \
  -H "Authorization: Bearer $HUB_AUTH_TOKEN" \
  -H "Content-Type: application/json" \
  -H "X-Hub-Team: justin-court-appraisal" \
  -H "X-Hub-Agent: justin" \
  -d '{
    "callerTeam": "justin-court-appraisal",
    "agent": "justin",
    "selectorKey": "justin.stage-3",
    "runtimePurpose": "external_case_analysis",
    "taskType": "external_case_analysis",
    "abstractModel": "anthropic_haiku",
    "prompt": "Analyze this case summary...",
    "timeoutMs": 45000,
    "maxBudgetUsd": 0.05
  }'
```

## Rules

- Use `callerTeam`, `agent`, an approved `selectorKey`, and a stable `runtimePurpose`/`taskType` pair.
- Register `callerTeam + runtimePurpose` before omitting `selectorKey`. Until then, always send the approved selector explicitly.
- Set `maxBudgetUsd` on every request.
- Treat `timeoutMs` as the total call deadline. Use the registered profile default unless the caller needs a shorter limit. Canonical `callerTeam=blog` writers may use `600000` ms total and `420000` ms per provider attempt; other external teams use the 180-second default or an async job until a dedicated profile is approved.
- Keep provider credentials only in Hub. External projects receive no provider API key and no OAuth token.
- Parse structured Hub errors before text: `upstreamStatus`, `retryAfterMs`, `providerBackpressure`, `limiterBackpressure`, and `admissionScope`.
- Never bypass Hub with a direct provider fallback. Retry the same Hub request after `retryAfterMs`, or move it to the caller queue.
- For `/hub/llm/jobs`, send `callerTeam` explicitly, and keep polling the same job ID when status returns to `queued`; do not submit a duplicate job.
- Send the same canonical `X-Hub-Team` on async Job create/list/status/result requests. A conflicting body/header team returns `400`, missing read context returns `400`, and cross-team reads return `404`.
- Read route decisions and cost from `hub.llm_request_log`.
- Use `/hub/llm/gateway-contract` before integration tests to verify endpoint policy.
- Use agent-level LLM drill after route changes:

```bash
HUB_MULTI_AGENT_LLM_DRILL_CONCURRENCY=1 \
HUB_MULTI_AGENT_LLM_DRILL_DELAY_MS=2000 \
HUB_MULTI_AGENT_LLM_DRILL_MAX_TOKENS=8 \
npm --prefix bots/hub run -s team:agent-llm-drill:live -- --teams=all --primary-only
```

## Stage D Canary

Use this dry-run selector and contract check first:

```bash
npm --prefix bots/hub run -s llm:stage-d-external-gateway-canary
```

Only after a current approval and cost cap:

```bash
HUB_AUTH_TOKEN=... npm --prefix bots/hub run -s llm:stage-d-external-gateway-canary -- --apply --confirm=hub-stage-d-external-gateway-canary
```

The canary project is `justin-court-appraisal`, routed by `selectorKey=justin.stage-3` and `runtimePurpose=external_gateway_canary`. Normal case-analysis requests use the stable `external_case_analysis` purpose shown above.

For full Node.js/Python clients, Vision/Embedding examples, error classification, and observability checks, follow `docs/hub/EXTERNAL_LLM_INTEGRATION_GUIDE.md`.
