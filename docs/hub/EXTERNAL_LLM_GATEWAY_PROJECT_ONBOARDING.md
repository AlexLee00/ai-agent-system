# External LLM Gateway Project Onboarding

External projects must use Hub as the standard LLM gateway. They should not call OpenAI, Anthropic, Groq, Gemini, or local model providers directly.

## Current Hub Policy

- Standard Hub URL: `http://localhost:7788`
- LaunchAgent: `ai.hub.resource-api`
- Auth: `Authorization: Bearer <HUB_AUTH_TOKEN>`
- Gemini disabled flag: `HUB_LLM_GEMINI_DISABLED=true`
- Direct provider routes: `disabled_by_default`
- Provider secrets/OAuth tokens: Hub only, never copied into external projects

Check the live contract before wiring a project:

```bash
curl -fsS -H "Authorization: Bearer $HUB_AUTH_TOKEN" \
  "$HUB_BASE_URL/hub/llm/gateway-contract" | \
  jq '{ok, contractVersion, selectorPolicy, providerPolicy}'
```

If `providerPolicy.geminiDisabled=true`, do not pin any external project to a Gemini-only selector.

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
    "taskType": "external_case_analysis",
    "prompt": "Analyze this case summary...",
    "maxBudgetUsd": 0.05
  }'
```

## Rules

- Use `callerTeam`, `agent`, and an approved `selectorKey`.
- Set `maxBudgetUsd` on every request.
- Keep provider credentials only in Hub. External projects receive no provider API key and no OAuth token.
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

The canary project is `justin-court-appraisal`, routed by `selectorKey=justin.stage-3`.
