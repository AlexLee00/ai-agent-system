# Report Deprecation Preflight

> Generated: 2026-05-02 KST
> Scope: read-only safety gate. This document does not unload or disable launchd jobs.

## Summary

- status: `immediate_unload_verified`
- immediate candidates: 9
- runtime unload ready after approval: 0
- repo-only or not loaded: 9
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
| `ai.claude.health-dashboard` | local | hourly-status | no | no_runtime_action | local candidate is not currently loaded or plist is missing |
| `ai.investment.health-check` | local | hourly-status | no | no_runtime_action | local candidate is not currently loaded or plist is missing |
| `ai.investment.luna-l5-readiness` | repo | hourly-status | no | no_runtime_action | repo template candidate only; no loaded local runtime action detected |
| `ai.legal.health-check` | local | hourly-status | no | no_runtime_action | local candidate is not currently loaded or plist is missing |
| `ai.ska.dashboard` | local | hourly-status | no | no_runtime_action | local candidate is not currently loaded or plist is missing |
| `ai.ska.health-check` | local | hourly-status | no | no_runtime_action | local candidate is not currently loaded or plist is missing |

## Next Actions

- Monitor the 5 digest jobs for information loss after immediate candidate unload.
- Keep Week 1 grace and Week 3 grace candidates loaded until their review windows complete.
- Use the retained local plist files as rollback sources if any digest coverage gap is observed.
