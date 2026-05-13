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
- BillingGuard usage status;
- protected Hub launchd visibility;
- provider circuit state;
- Sentry MCP readiness contract;
- Self-Healing action plan.

Sentry MCP is treated as optional enrichment. If Sentry credentials are absent, Hub incidents and reports remain the primary error system, and the report marks the mode as `adapter_ready_config_pending`.

## Close Criteria

- `check:llm-stage-a` passes.
- Stage B control-plane smoke passes.
- Stage B observability smoke writes the JSON report.
- Stage B self-healing smoke proves protected recovery is confirm-required.
- No PROTECTED service is restarted or killed during validation.
