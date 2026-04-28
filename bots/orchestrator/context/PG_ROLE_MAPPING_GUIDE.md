# Jay Orchestrator PG Role Mapping Guide

## Runtime Contract

- `PG_DIRECT=true` means Jay writes directly to PostgreSQL with `PG_USER` or the local OS user fallback.
- `HUB_BASE_URL + HUB_PG_USER` without `PG_DIRECT=true` means read-only Hub-routed access is expected.
- Jay write paths currently require write access to `agent` and `claude` schemas.

## Recommended Local Ops Mapping

| Context | Required Mode | Required Schemas | Notes |
| --- | --- | --- | --- |
| `ai.jay.runtime` | `direct_writer` | `agent`, `claude` | Incident loop, confirms, morning queue, commander dispatch. |
| `ai.orchestrator` | `direct_writer` | `agent`, `claude` | Runtime health/reporting and command state. |
| Dry-run/inspection tools | `hub_readonly` when possible | `public`, `agent`, `claude` | Use Hub readonly role unless the tool mutates queue state. |

## Verification

Run:

```bash
npm --prefix bots/orchestrator run -s smoke:pg-role-mapping
```

The smoke validates direct writer, Hub readonly, and implicit default mappings so PG drift is visible before runtime errors appear.
