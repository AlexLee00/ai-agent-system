# Report Deprecation Matrix

> Generated: 2026-05-03 KST
> Scope: read-only matrix. This document does not unload or disable any launchd job.

## Digest Targets

| Digest | Launchd | Schedule | Coverage |
| --- | --- | --- | --- |
| hourly-status | `ai.hub.hourly-status-digest` | hourly | Hub/team health, routing readiness, high-level runtime status |
| daily-metrics | `ai.hub.daily-metrics-digest` | daily 09:00 | Daily alarm/LLM/team metrics and operational counters |
| weekly-audit | `ai.hub.weekly-audit-digest` | weekly Monday 10:00 | Safety, regression, policy, and audit coverage |
| weekly-advisory | `ai.hub.weekly-advisory-digest` | weekly Monday 11:00 | Master-review recommendations, noisy producers, tuning proposals |
| incident-summary | `ai.hub.incident-summary` | daily 18:00 | Roundtable/auto_dev incident summary and unresolved items |

## Summary

| Class | Count |
| --- | ---: |
| 즉시 비활성화 후보 | 9 |
| 1주 grace 후보 | 20 |
| 3주 grace 후보 | 12 |
| 유지 권장 | 10 |
| Total candidates | 51 |

## Candidate Matrix

| Class | Source | Launchd | Script | Replacement | Rationale |
| --- | --- | --- | --- | --- | --- |
| 1주 grace 후보 | local | `ai.blog.daily` | `bots/blog/scripts/run-daily.ts` | daily-metrics | covered by daily-metrics; compare for one week before unload |
| 즉시 비활성화 후보 | local | `ai.blog.health-check` | `bots/blog/scripts/health-check.ts` | hourly-status | covered by hourly status digest; safe to retire after parallel comparison |
| 즉시 비활성화 후보 | local | `ai.blog.instagram-token-health` | `bots/blog/scripts/monitor-instagram-token.ts` | hourly-status | covered by hourly status digest; safe to retire after parallel comparison |
| 1주 grace 후보 | repo | `ai.blog.marketing-report` | `-` | hourly-status | covered by hourly-status; compare for one week before unload |
| 1주 grace 후보 | repo | `ai.blog.phase1-report` | `-` | hourly-status | covered by hourly-status; compare for one week before unload |
| 3주 grace 후보 | local | `ai.blog.weekly-evolution` | `bots/blog/scripts/weekly-evolution.ts` | hourly-status | risk-sensitive signal; keep three-week grace before unload |
| 유지 권장 | local | `ai.claude.codex-notifier` | `bots/claude/scripts/codex-notifier-runner.ts` | weekly-advisory | contains live/action/daemon semantics; keep until separate owner review |
| 1주 grace 후보 | local | `ai.claude.daily-report` | `-` | daily-metrics | covered by daily-metrics; compare for one week before unload |
| 1주 grace 후보 | local | `ai.claude.dexter.daily` | `bots/claude/src/dexter.js` | daily-metrics | covered by daily-metrics; compare for one week before unload |
| 유지 권장 | local | `ai.claude.dexter.quick` | `bots/claude/src/dexter-quickcheck.ts` | hourly-status | insufficient replacement confidence; keep pending manual review |
| 즉시 비활성화 후보 | local | `ai.claude.health-check` | `bots/claude/scripts/health-check.ts` | hourly-status | covered by hourly status digest; safe to retire after parallel comparison |
| 즉시 비활성화 후보 | local | `ai.claude.health-dashboard` | `bots/claude/scripts/health-dashboard-server.js` | hourly-status | covered by hourly status digest; safe to retire after parallel comparison |
| 유지 권장 | local | `ai.claude.speed-test` | `-` | hourly-status | insufficient replacement confidence; keep pending manual review |
| 1주 grace 후보 | local | `ai.claude.weekly-report` | `-` | hourly-status | covered by hourly-status; compare for one week before unload |
| 1주 grace 후보 | local | `ai.darwin.weekly-ops-report` | `bots/darwin/scripts/darwin-weekly-ops-report.ts` | hourly-status | covered by hourly-status; compare for one week before unload |
| 3주 grace 후보 | local | `ai.darwin.weekly-review` | `bots/darwin/scripts/darwin-weekly-review.ts` | weekly-audit | risk-sensitive signal; keep three-week grace before unload |
| 3주 grace 후보 | local | `ai.darwin.weekly.autonomous` | `bots/darwin/lib/research-scanner.ts` | hourly-status | risk-sensitive signal; keep three-week grace before unload |
| 1주 grace 후보 | repo | `ai.hub.alarm-noise-report` | `bots/hub/scripts/alarm-noise-report.ts` | hourly-status | covered by hourly-status; compare for one week before unload |
| 유지 권장 | repo | `ai.hub.alarm-stale-auto-repair` | `bots/hub/scripts/alarm-auto-repair-stale-scan.ts` | incident-summary | insufficient replacement confidence; keep pending manual review |
| 3주 grace 후보 | repo | `ai.hub.llm-load-test-weekly` | `-` | hourly-status | risk-sensitive signal; keep three-week grace before unload |
| 3주 grace 후보 | local | `ai.hub.llm-model-check` | `scripts/check-llm-model-updates.ts` | hourly-status | risk-sensitive signal; keep three-week grace before unload |
| 3주 grace 후보 | local | `ai.hub.llm-oauth-monitor` | `bots/hub/scripts/run-oauth-monitor.ts` | hourly-status | risk-sensitive signal; keep three-week grace before unload |
| 유지 권장 | local | `ai.investment.daily-feedback` | `bots/investment/scripts/daily-trade-feedback.ts` | daily-metrics | contains live/action/daemon semantics; keep until separate owner review |
| 즉시 비활성화 후보 | local | `ai.investment.health-check` | `bots/investment/scripts/health-check.ts` | hourly-status | covered by hourly status digest; safe to retire after parallel comparison |
| 즉시 비활성화 후보 | repo | `ai.investment.luna-l5-readiness` | `bots/investment/scripts/luna-l5-readiness-report.ts` | hourly-status | covered by hourly status digest; safe to retire after parallel comparison |
| 1주 grace 후보 | local | `ai.investment.market-alert-crypto-daily` | `bots/investment/scripts/market-alert.ts` | daily-metrics | covered by daily-metrics; compare for one week before unload |
| 1주 grace 후보 | local | `ai.investment.reporter` | `bots/investment/team/reporter.ts` | hourly-status | covered by hourly-status; compare for one week before unload |
| 유지 권장 | local | `ai.jay.growth` | `-` | hourly-status | insufficient replacement confidence; keep pending manual review |
| 즉시 비활성화 후보 | local | `ai.legal.health-check` | `bots/legal/scripts/health-check.js` | hourly-status | covered by hourly status digest; safe to retire after parallel comparison |
| 1주 grace 후보 | local | `ai.llm.daily-report` | `bots/hub/scripts/llm-daily-report.ts` | daily-metrics | covered by daily-metrics; compare for one week before unload |
| 유지 권장 | local | `ai.luna.7day-natural-checkpoint` | `bots/investment/scripts/runtime-luna-7day-natural-checkpoint.ts` | hourly-status | insufficient replacement confidence; keep pending manual review |
| 1주 grace 후보 | local | `ai.luna.daily-backtest` | `bots/investment/scripts/runtime-luna-daily-backtest.ts` | daily-metrics | covered by daily-metrics; compare for one week before unload |
| 1주 grace 후보 | repo | `ai.luna.daily-report` | `bots/investment/scripts/luna-daily-report.ts` | daily-metrics | covered by daily-metrics; compare for one week before unload |
| 유지 권장 | local | `ai.luna.trade-journal-dashboard` | `bots/investment/scripts/runtime-trade-journal-dashboard-html.ts` | hourly-status | contains live/action/daemon semantics; keep until separate owner review |
| 3주 grace 후보 | repo | `ai.luna.weekly-review` | `bots/investment/scripts/luna-weekly-review.ts` | weekly-audit | risk-sensitive signal; keep three-week grace before unload |
| 1주 grace 후보 | local | `ai.sigma.daily` | `-` | daily-metrics | covered by daily-metrics; compare for one week before unload |
| 1주 grace 후보 | local | `ai.sigma.daily-report` | `bots/sigma/ts/src/sigma-daily-report.ts` | daily-metrics | covered by daily-metrics; compare for one week before unload |
| 3주 grace 후보 | local | `ai.sigma.weekly-review` | `bots/sigma/ts/src/sigma-weekly-review.ts` | weekly-audit | risk-sensitive signal; keep three-week grace before unload |
| 즉시 비활성화 후보 | local | `ai.ska.dashboard` | `bots/reservation/scripts/dashboard-server.ts` | hourly-status | covered by hourly status digest; safe to retire after parallel comparison |
| 1주 grace 후보 | local | `ai.ska.forecast-daily` | `-` | daily-metrics | covered by daily-metrics; compare for one week before unload |
| 3주 grace 후보 | local | `ai.ska.forecast-weekly` | `-` | hourly-status | risk-sensitive signal; keep three-week grace before unload |
| 즉시 비활성화 후보 | local | `ai.ska.health-check` | `bots/reservation/scripts/health-check.ts` | hourly-status | covered by hourly status digest; safe to retire after parallel comparison |
| 유지 권장 | local | `ai.ska.kiosk-monitor` | `-` | hourly-status | insufficient replacement confidence; keep pending manual review |
| 유지 권장 | local | `ai.ska.naver-monitor` | `-` | hourly-status | insufficient replacement confidence; keep pending manual review |
| 1주 grace 후보 | local | `ai.ska.pickko-daily-audit` | `-` | weekly-audit | covered by weekly-audit; compare for one week before unload |
| 1주 grace 후보 | local | `ai.ska.pickko-daily-summary` | `-` | daily-metrics | covered by daily-metrics; compare for one week before unload |
| 3주 grace 후보 | local | `ai.ska.rebecca-weekly` | `-` | hourly-status | risk-sensitive signal; keep three-week grace before unload |
| 3주 grace 후보 | local | `ai.ska.today-audit` | `-` | weekly-audit | risk-sensitive signal; keep three-week grace before unload |
| 1주 grace 후보 | local | `ai.steward.daily` | `bots/orchestrator/src/steward.ts` | daily-metrics | covered by daily-metrics; compare for one week before unload |
| 3주 grace 후보 | local | `ai.steward.weekly` | `bots/orchestrator/src/steward.ts` | hourly-status | risk-sensitive signal; keep three-week grace before unload |
| 1주 grace 후보 | local | `ai.write.daily` | `bots/orchestrator/src/write.js` | daily-metrics | covered by daily-metrics; compare for one week before unload |

## Master Approval Workflow

1. Week 1: keep all candidate jobs running in parallel with the 5 digest jobs.
2. Week 2: unload only `immediate` candidates after comparing digest content.
3. Week 3: unload `week1_grace` candidates if no information loss is observed.
4. Week 4+: review `week3_grace` candidates one by one; keep action/daemon jobs.
5. Every unload requires a rollback note and a retained log path for at least 30 days.

## Unload Command Reference

```bash
# ai.blog.daily -> daily-metrics
launchctl bootout gui/$(id -u) /Users/alexlee/Library/LaunchAgents/ai.blog.daily.plist
# ai.blog.health-check -> hourly-status
launchctl bootout gui/$(id -u) /Users/alexlee/Library/LaunchAgents/ai.blog.health-check.plist
# ai.blog.instagram-token-health -> hourly-status
launchctl bootout gui/$(id -u) /Users/alexlee/Library/LaunchAgents/ai.blog.instagram-token-health.plist
# ai.blog.marketing-report -> hourly-status
launchctl bootout gui/$(id -u) /Users/alexlee/projects/ai-agent-system/bots/blog/launchd/ai.blog.marketing-report.plist
# ai.blog.phase1-report -> hourly-status
launchctl bootout gui/$(id -u) /Users/alexlee/projects/ai-agent-system/bots/blog/launchd/ai.blog.phase1-report.plist
# ai.blog.weekly-evolution -> hourly-status
launchctl bootout gui/$(id -u) /Users/alexlee/Library/LaunchAgents/ai.blog.weekly-evolution.plist
# ai.claude.daily-report -> daily-metrics
launchctl bootout gui/$(id -u) /Users/alexlee/Library/LaunchAgents/ai.claude.daily-report.plist
# ai.claude.dexter.daily -> daily-metrics
launchctl bootout gui/$(id -u) /Users/alexlee/Library/LaunchAgents/ai.claude.dexter.daily.plist
# ai.claude.health-check -> hourly-status
launchctl bootout gui/$(id -u) /Users/alexlee/Library/LaunchAgents/ai.claude.health-check.plist
# ai.claude.health-dashboard -> hourly-status
launchctl bootout gui/$(id -u) /Users/alexlee/Library/LaunchAgents/ai.claude.health-dashboard.plist
# ai.claude.weekly-report -> hourly-status
launchctl bootout gui/$(id -u) /Users/alexlee/Library/LaunchAgents/ai.claude.weekly-report.plist
# ai.darwin.weekly-ops-report -> hourly-status
launchctl bootout gui/$(id -u) /Users/alexlee/Library/LaunchAgents/ai.darwin.weekly-ops-report.plist
# ai.darwin.weekly-review -> weekly-audit
launchctl bootout gui/$(id -u) /Users/alexlee/Library/LaunchAgents/ai.darwin.weekly-review.plist
# ai.darwin.weekly.autonomous -> hourly-status
launchctl bootout gui/$(id -u) /Users/alexlee/Library/LaunchAgents/ai.darwin.weekly.autonomous.plist
# ai.hub.alarm-noise-report -> hourly-status
launchctl bootout gui/$(id -u) /Users/alexlee/projects/ai-agent-system/bots/hub/launchd/ai.hub.alarm-noise-report.plist
# ai.hub.llm-load-test-weekly -> hourly-status
launchctl bootout gui/$(id -u) /Users/alexlee/projects/ai-agent-system/bots/hub/launchd/ai.hub.llm-load-test-weekly.plist
# ai.hub.llm-model-check -> hourly-status
launchctl bootout gui/$(id -u) /Users/alexlee/Library/LaunchAgents/ai.hub.llm-model-check.plist
# ai.hub.llm-oauth-monitor -> hourly-status
launchctl bootout gui/$(id -u) /Users/alexlee/Library/LaunchAgents/ai.hub.llm-oauth-monitor.plist
# ai.investment.health-check -> hourly-status
launchctl bootout gui/$(id -u) /Users/alexlee/Library/LaunchAgents/ai.investment.health-check.plist
# ai.investment.luna-l5-readiness -> hourly-status
launchctl bootout gui/$(id -u) /Users/alexlee/projects/ai-agent-system/bots/investment/launchd/ai.investment.luna-l5-readiness.plist
# ai.investment.market-alert-crypto-daily -> daily-metrics
launchctl bootout gui/$(id -u) /Users/alexlee/Library/LaunchAgents/ai.investment.market-alert-crypto-daily.plist
# ai.investment.reporter -> hourly-status
launchctl bootout gui/$(id -u) /Users/alexlee/Library/LaunchAgents/ai.investment.reporter.plist
# ai.legal.health-check -> hourly-status
launchctl bootout gui/$(id -u) /Users/alexlee/Library/LaunchAgents/ai.legal.health-check.plist
# ai.llm.daily-report -> daily-metrics
launchctl bootout gui/$(id -u) /Users/alexlee/Library/LaunchAgents/ai.llm.daily-report.plist
# ai.luna.daily-backtest -> daily-metrics
launchctl bootout gui/$(id -u) /Users/alexlee/Library/LaunchAgents/ai.luna.daily-backtest.plist
# ai.luna.daily-report -> daily-metrics
launchctl bootout gui/$(id -u) /Users/alexlee/projects/ai-agent-system/bots/investment/launchd/ai.luna.daily-report.plist
# ai.luna.weekly-review -> weekly-audit
launchctl bootout gui/$(id -u) /Users/alexlee/projects/ai-agent-system/bots/investment/launchd/ai.luna.weekly-review.plist
# ai.sigma.daily -> daily-metrics
launchctl bootout gui/$(id -u) /Users/alexlee/Library/LaunchAgents/ai.sigma.daily.plist
# ai.sigma.daily-report -> daily-metrics
launchctl bootout gui/$(id -u) /Users/alexlee/Library/LaunchAgents/ai.sigma.daily-report.plist
# ai.sigma.weekly-review -> weekly-audit
launchctl bootout gui/$(id -u) /Users/alexlee/Library/LaunchAgents/ai.sigma.weekly-review.plist
# ai.ska.dashboard -> hourly-status
launchctl bootout gui/$(id -u) /Users/alexlee/Library/LaunchAgents/ai.ska.dashboard.plist
# ai.ska.forecast-daily -> daily-metrics
launchctl bootout gui/$(id -u) /Users/alexlee/Library/LaunchAgents/ai.ska.forecast-daily.plist
# ai.ska.forecast-weekly -> hourly-status
launchctl bootout gui/$(id -u) /Users/alexlee/Library/LaunchAgents/ai.ska.forecast-weekly.plist
# ai.ska.health-check -> hourly-status
launchctl bootout gui/$(id -u) /Users/alexlee/Library/LaunchAgents/ai.ska.health-check.plist
# ai.ska.pickko-daily-audit -> weekly-audit
launchctl bootout gui/$(id -u) /Users/alexlee/Library/LaunchAgents/ai.ska.pickko-daily-audit.plist
# ai.ska.pickko-daily-summary -> daily-metrics
launchctl bootout gui/$(id -u) /Users/alexlee/Library/LaunchAgents/ai.ska.pickko-daily-summary.plist
# ai.ska.rebecca-weekly -> hourly-status
launchctl bootout gui/$(id -u) /Users/alexlee/Library/LaunchAgents/ai.ska.rebecca-weekly.plist
# ai.ska.today-audit -> weekly-audit
launchctl bootout gui/$(id -u) /Users/alexlee/Library/LaunchAgents/ai.ska.today-audit.plist
# ai.steward.daily -> daily-metrics
launchctl bootout gui/$(id -u) /Users/alexlee/Library/LaunchAgents/ai.steward.daily.plist
# ai.steward.weekly -> hourly-status
launchctl bootout gui/$(id -u) /Users/alexlee/Library/LaunchAgents/ai.steward.weekly.plist
# ai.write.daily -> daily-metrics
launchctl bootout gui/$(id -u) /Users/alexlee/Library/LaunchAgents/ai.write.daily.plist
```
