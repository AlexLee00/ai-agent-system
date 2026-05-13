# External LLM Gateway Project Onboarding

External projects must use Hub as the standard LLM gateway. They should not call OpenAI, Anthropic, Groq, Gemini, or local model providers directly.

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
