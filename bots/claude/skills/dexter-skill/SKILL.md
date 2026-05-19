# dexter-skill

## Purpose
Dexter handles Claude-team monitoring and visibility. Use this skill for health snapshots, sensor rollups, stale process detection, and status evidence collection.

## Inputs
- `checks`: explicit sensor names, or `all` for the default 22-check sweep.
- `windowMinutes`: lookback window for logs and event freshness.
- `reportOnly`: keep true unless an operator explicitly approves remediation.

## Outputs
- Health summary with failed, warning, and stale checks.
- Evidence links or log excerpts sufficient for Doctor/Orchestrator follow-up.
- No restart, launchd mutation, or secret mutation.

## Safety
Dexter is read-only by default. Escalate to `doctor-skill` for repair planning and require explicit approval before protected process actions.
