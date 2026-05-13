# Hub Stage C Operations

Stage C completes the Hub stabilization plan after Stage A/B.

- Stage A fixed the LLM control plane: seed registry, selector facade, request log, BillingGuard, protected service checks.
- Stage B fixed operational visibility: selector enforcement, JSON stability report, Sentry readiness, read-only self-healing.
- Stage C fixes resilience: Backup/DRP, OWASP security hardening, chaos engineering, and external-project LLM Gateway contracts.

## Scope

Stage C is read-only by default. It does not restart protected services, mutate secrets, restore production databases, or run live provider chaos unless a current operator explicitly confirms it.

The Stage C gate covers:

- `L8 Backup + DRP`: backup command plan, canonical DB object visibility, restore dry-run contract.
- `L9 Security Hardening`: bearer auth, constant-time token compare, schema validation, direct-provider route guard, server timeout hardening, secret distribution guard.
- `L10 Chaos Engineering`: fixture chaos drills by default, live `k6` chaos behind confirm gate only.
- External LLM Gateway: `/hub/llm/gateway-contract`, integration guide, selector-key based onboarding path, observability through `hub.llm_request_log`.

## Commands

```bash
npm --prefix bots/hub run -s hub:stage-c-resilience-report -- --json
npm --prefix bots/hub run -s hub:stage-c-resilience-report -- --write
npm --prefix bots/hub run -s hub:stage-c-chaos-drill -- --json --fixture
npm --prefix bots/hub run -s check:llm-stage-c
```

The JSON report is written to:

```text
bots/hub/output/hub-stage-c-resilience-report.json
```

## Backup/DRP

Stage C produces a production-safe backup plan. The plan uses `pg_dump` only and does not restore into production.

Planned artifacts:

- Hub schema backup.
- `public.llm_routing_log` runtime log backup.
- `agent.event_lake` operational evidence backup.
- LLM support object schema backup.

Production restore is out of scope for automation. A restore must be tested against a separate database first.

## Security

Stage C maps checks to OWASP API Top 10 controls:

- Hub bearer auth protects `/hub/llm/*`.
- Tokens are compared with `crypto.timingSafeEqual`.
- LLM request payloads are validated through `zod`.
- Direct provider endpoints stay disabled by default.
- Server request/header/keep-alive timeout hardening is active.
- External projects never receive provider API keys or OAuth tokens.

Required security checks:

```bash
npm --prefix bots/hub run -s server-hardening-smoke
tsx bots/hub/scripts/secret-leak-smoke.ts
npm --prefix bots/hub run -s llm:external-integration-guide-smoke
```

## Chaos

Default chaos mode is fixture-only. It simulates:

- provider fallback exhaustion;
- BillingGuard stop state;
- request-log DB unavailability;
- OAuth/provider expiry or missing provider;
- direct provider route blocking.

Live chaos remains a human-operated task:

```bash
npm --prefix bots/hub run -s hub:stage-c-chaos-drill -- --apply --confirm=hub-stage-c-chaos
```

The Codex operator intentionally does not launch live chaos by itself. The generated response points to the explicit `k6 run tests/load/chaos.js` command.

## External LLM Gateway

External projects should call Hub instead of provider APIs.

Machine-readable contract:

```bash
curl -fsS \
  -H "Authorization: Bearer $HUB_AUTH_TOKEN" \
  "$HUB_BASE_URL/hub/llm/gateway-contract"
```

Default external onboarding path:

- Use `POST /hub/llm/call` for short calls.
- Use `POST /hub/llm/jobs` for long calls.
- Always send `callerTeam`, `agent`, `taskType`, `requestId`, and `maxBudgetUsd`.
- Use `selectorKey` until the external project has approved registry entries.
- Observe calls through `hub.llm_request_log` and `/hub/llm/stats`.

## Safety Boundary

Never run these from Stage C automation without a separate current approval:

- restore backup into the production database;
- `DROP`, `DELETE`, or `TRUNCATE` production Hub data;
- `launchctl bootout`, `launchctl unload`, or `launchctl kickstart -k` on protected labels;
- `kill` protected Hub PIDs;
- mutate secrets or OAuth tokens;
- run live chaos against production providers.

## Close Criteria

- `check:llm-stage-b` passes.
- Stage C DRP smoke passes.
- Stage C security smoke passes.
- Stage C chaos smoke passes in fixture mode.
- External integration guide and gateway contract smokes pass.
- `hub:stage-c-resilience-report -- --write` returns `stage_c_resilience_ready`.
- No protected service restart/kill and no secret mutation occurred during validation.
