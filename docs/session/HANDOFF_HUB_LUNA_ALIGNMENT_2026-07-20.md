# Hub/Luna Alignment Handoff - 2026-07-20

## Scope

- Hub exact-route quarantine and 24-hour read-only routing observation
- Luna YAML routing alignment, three-market cycle observation, and natural posttrade accumulation
- Agent/team SSOT audit and concurrent-contract state protection
- No live order, migration, secret change, commit, or push. The approved launchd reload and one guarded posttrade operational run were applied after verification.

## Implemented

- Quarantined `groq/qwen/qwen3-32b` at selector, unified caller, and direct Groq boundaries; active defaults now use `groq/openai/gpt-oss-120b`.
- Tokenized Luna YAML routes resolve through the shared routing adapter and generated policy table.
- Added read-only Hub routing observation with required-selector coverage and selector-scoped totals.
- Added read-only Luna market-cycle observation with required-market coverage. Scheduler state now preserves `lastOpenRunAt` across closed/cadence/kill-switch outcomes and refreshes it only after a completed open-market cycle.
- Natural checkpoint query failures remain query errors instead of becoming zero counts. Posttrade drill reads pending and recent closed trades without schema initialization or LLM execution.
- Posttrade worker records partial failures in heartbeat and exits non-zero for one-shot failures; `--no-auto-apply` remains enforced in the tracked plist.
- Agent contract completion changes an agent to `idle` only when the registry row is currently `active` and no other active contract remains.
- Blog competition finalization now uses the same concurrent-contract guard. Superseded competitions also terminate their linked contracts instead of leaving them active indefinitely.
- README team/agent claims were aligned to the runtime catalog: 124 agents and 8 active teams.

## Verification

- `npm run -s typecheck:strict`: pass, strict errors 0
- `npm run -s check`: pass
- `npx tsx scripts/harness-principles-audit.ts --strict --smoke`: pass
- Hub focused smokes: exact-route, 24h observation, selector, timeout, provider admission/circuit, control independence, cluster diagnostic: pass
- Luna focused smokes: natural checkpoint/recovery, market observation, ops scheduler, YAML routing: pass
- Registry SSOT and contract-state smokes: pass
- Independent review after the runtime cadence correction: no actionable P1/P2 findings
- Policy table codegen `--check --env-from-launchd`: unchanged; one known FAST/SCOUT token-source warning remains
- Tracked posttrade plist: `plutil -lint` pass
- `git diff --check`: pass

## Read-Only Operational Evidence

- Hub 24h target selectors: 8 calls, 8 successes, 0 failures/timeouts, and 7 fallback/quarantined historical attempts at final verification; Chronos selectors have no sample.
- Luna market cycles: service, scheduler, and all three market observations are healthy after the runtime cadence correction.
- Natural accumulation remains pending; query errors are zero and no output file was written.
- Posttrade drill: pending 7/7, recent closed 20, dashboard read succeeded, no LLM call or live mutation.
- Team audit: 124 agents, 8 active teams, no catalog/README drift, and no idle-agent/active-contract drift after the approved cleanup.

## Operational Apply

- Backed up the previous installed posttrade plist to `~/Library/LaunchAgents/ai.luna.posttrade-feedback-15min.plist.bak.20260720T145641Z` and reloaded the tracked guarded worker configuration.
- The installed posttrade service now runs `runtime-posttrade-feedback-worker.ts --once --market=all --limit=20 --no-auto-apply --json` every 15 minutes.
- One approved guarded run completed with exit code 0: processed 7, errors 0, reflexions 7, and `posttrade_action_auto_apply_suppressed`. The run recorded normal posttrade learning evidence, including dashboard knowledge record 6892, without live orders or strategy-parameter auto-apply.
- Restarted only `ai.hub.resource-api`; PID changed from 43493 to 73209 and `/hub/health/ready` recovered with HTTP 200 in about one second.
- A low-cost live `investment.nemesis` canary returned HTTP 200 through `groq/openai/gpt-oss-120b` with fallback count 0. No new Hub stderr was emitted.
- The first post-apply market observation exposed a false `cycle_stale`: the outer crypto probe runs every 300 seconds while the actual NIGHT_AUTO cycle is 3600 seconds. The observer now derives the effective crypto cadence from `getLunaParams()` and uses the longer runtime cadence; RED/GREEN smoke and the live read-only observation both report all three markets healthy.
- The single `LOCK_MUTATION_GUARD_SUFFIX` scheduler stderr line was historical (`2026-07-20 06:49 KST`). Current scheduler runs completed with exit code 0 and the stderr file did not change during observation.

## Agent Contract DB Cleanup

- Master approved the production DB cleanup on 2026-07-21. A read-only snapshot confirmed 104 active contracts across 13 idle agents, with no contracts created in the preceding 7 days.
- The evidence-based plan classified 25 rows as `completed` and 79 rows as `failed`: 84 competition-linked rows followed the competition terminal state, 18 direct rows had matching performance history, one direct row had a published post, and one direct row had a replacement-writer post.
- The first apply attempt updated zero rows and rolled back because JavaScript ISO timestamps omitted PostgreSQL microseconds. The v2 plan used exact epoch microseconds and then updated all 104 rows in one advisory-locked transaction.
- Post-apply verification matched all 104 planned rows, and the team SSOT audit became `healthy` with zero errors, zero warnings, and zero idle-agent/active-contract drift.
- Plan row-set SHA-256 (`JSON.stringify(plan.rows)`): `5ce4cf834fa3114cb05cd322d3fc1fb7a0a40f326997f3e5dfd1d915999f86bb`.
- Local restricted rollback artifacts: `~/.ai-agent-system/ops/db-backups/agent-contract-cleanup-20260721/` (`before-evidence.json`, `plan.json`, `rollback-plan.json`, `apply-result.json`, and the post-apply audit).

## Remaining Operations

- Five historical active contracts whose agents are also active were outside the approved 104-row mismatch scope and remain unchanged.
- The Hub 24-hour observation can remain degraded until pre-restart Qwen failures age out of the rolling window; no new exact-route Qwen execution was observed after the runtime apply.
