# Report Deprecation Preflight

> Generated: 2026-05-04 KST
> Scope: read-only safety gate. This document does not unload or disable launchd jobs.

## Summary

- status: `ready_for_parallel_observation`
- immediate candidates: 9
- runtime unload ready after approval: 1
- repo-only or not loaded: 8
- blockers: 0

## Digest Runtime Status

| Digest Launchd | Loaded |
| --- | --- |
| `ai.hub.hourly-status-digest` | yes |
| `ai.hub.daily-metrics-digest` | yes |
| `ai.hub.weekly-audit-digest` | yes |
| `ai.hub.weekly-advisory-digest` | yes |
| `ai.hub.incident-summary` | yes |

## Protected Runtime Labels

| Label | Loaded |
| --- | --- |
| `ai.luna.tradingview-ws` | yes |
| `ai.investment.commander` | yes |
| `ai.claude.auto-dev.autonomous` | yes |
| `ai.hub.hourly-status-digest` | yes |
| `ai.hub.daily-metrics-digest` | yes |
| `ai.hub.weekly-audit-digest` | yes |
| `ai.hub.weekly-advisory-digest` | yes |
| `ai.hub.incident-summary` | yes |

## Immediate Candidate Preflight

| Label | Source | Replacement | Loaded | Action | Reason |
| --- | --- | --- | --- | --- | --- |
| `ai.blog.health-check` | local | hourly-status | no | no_runtime_action | local candidate is not currently loaded or plist is missing |
| `ai.blog.instagram-token-health` | local | hourly-status | no | no_runtime_action | local candidate is not currently loaded or plist is missing |
| `ai.claude.health-check` | local | hourly-status | no | no_runtime_action | local candidate is not currently loaded or plist is missing |
| `ai.claude.health-dashboard` | local | hourly-status | yes | ready_for_master_approved_unload | local launchd is loaded and covered by digest replacement |
| `ai.investment.health-check` | repo | hourly-status | no | no_runtime_action | repo template candidate only; no loaded local runtime action detected |
| `ai.investment.luna-l5-readiness` | repo | hourly-status | no | no_runtime_action | repo template candidate only; no loaded local runtime action detected |
| `ai.legal.health-check` | local | hourly-status | no | no_runtime_action | local candidate is not currently loaded or plist is missing |
| `ai.ska.dashboard` | local | hourly-status | no | no_runtime_action | local candidate is not currently loaded or plist is missing |
| `ai.ska.health-check` | local | hourly-status | no | no_runtime_action | local candidate is not currently loaded or plist is missing |

## Next Actions

- Keep all immediate candidates running during the Week 1 parallel observation window.
- Compare digest content against each candidate before any unload.
- Unload only runtime_action=ready_for_master_approved_unload candidates after explicit master approval.
