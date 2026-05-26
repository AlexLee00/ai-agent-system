# Hub Stage B Operations

Hub Stage B closes the integration layer after Stage A. Stage A fixed the LLM selector/control-plane data path. Stage B fixes the operational path around that control plane.

## Scope

- Hub→Selector→Agent is the only normal LLM path.
- `/hub/llm/call` and `/hub/llm/jobs` validate active route targets through `bots/hub/src/llm-selector.ts`.
- Direct provider routes stay disabled by default and are only compatibility endpoints.
- Observability is generated as a JSON stability board at `bots/hub/output/hub-stage-b-stability-report.json`.
- Self-Healing is read-only by default. It may run safe diagnostics such as tier probe, but protected service recovery remains confirm-required.

## Commands

```bash
npm --prefix bots/hub run -s hub:stage-b-stability-report -- --json
npm --prefix bots/hub run -s hub:stage-b-stability-report -- --write
npm --prefix bots/hub run -s hub:stage-b-self-healing -- --json
npm --prefix bots/hub run -s check:llm-stage-b
```

Tier probe is the only Stage B apply action currently allowed by the operator:

```bash
npm --prefix bots/hub run -s hub:stage-b-self-healing -- --apply --confirm=hub-stage-b-self-healing --action=tier_probe
```

It calls `/hub/llm/tier-probe` and does not restart, unload, kill, or mutate protected launchd services.

## Safety Boundary

Never run these from Stage B automation without a separate current approval:

- `launchctl bootout`, `launchctl unload`, or `launchctl kickstart -k` on PROTECTED Hub labels.
- `kill` on protected Hub PIDs.
- secret mutation or token deletion.
- enabling direct provider routes in production.

## Observability

The Stage B report includes:

- provider tier usage from `hub.llm_request_log`;
- provider latency and slow route hotspots from `hub.llm_request_log`;
- BillingGuard usage status;
- protected Hub launchd visibility;
- expected-idle launchd jobs whose latest run exited non-zero as `protected.idleExitWarnings`;
- expected-idle diagnostics with stderr log metadata plus a safe dry-run command when the scheduled report supports one;
- provider circuit state;
- Sentry MCP readiness contract;
- Self-Healing action plan.

Sentry MCP is treated as optional enrichment. If Sentry credentials are absent, Hub incidents and reports remain the primary error system, and the report marks the mode as `adapter_ready_config_pending`.

Expected-idle non-zero launchd status is not treated as a protected service outage
when the job is loaded and otherwise healthy. Stage B keeps it as an operations
warning and attaches read-only evidence commands. Use the dry-run commands below
to verify the current code path without sending external alarms:

```bash
npm --prefix bots/hub run -s alarm:noisy-producer-auto-learn:dry-run
npm --prefix bots/hub run -s alarm:weekly-advisory-digest:dry-run
npm --prefix bots/hub run -s alarm:roundtable-reflection:dry-run
```

## Scheduled Alarm Delivery

Launchd report jobs use `bots/hub/lib/alarm/scheduled-delivery.ts` for bounded
Hub alarm retries. Retryable Hub API failures such as HTTP 429 are retried with
`HUB_SCHEDULED_ALARM_ATTEMPTS` and
`HUB_SCHEDULED_ALARM_RETRY_MAX_DELAY_MS`. If a low-risk scheduled report is
still rate-limited after retries, the job logs `deferred_retryable_failure` and
exits successfully so the generated report is not misclassified as a runtime
failure. Non-retryable failures and critical/human-action paths remain hard
failures.

## Close Criteria

- `check:llm-stage-a` passes.
- Stage B control-plane smoke passes.
- Stage B observability smoke writes the JSON report.
- Stage B self-healing smoke proves protected recovery is confirm-required.
- No PROTECTED service is restarted or killed during validation.
