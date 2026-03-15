# Intent Engine Plan

## Goal

Extract Jay's natural-language intent stack into a reusable core module so that:

- Jay keeps its current direct-routing speed and observability
- Worker can reuse the same intent learning / promotion flow later
- team bots can share a consistent policy for:
  - slash commands
  - keyword rules
  - learned patterns
  - auto-promotion
  - rollback
  - audit history
  - model escalation

## Why Now

Jay now contains enough generic logic that keeping everything inside:

- [intent-parser.js](/Users/alexlee/projects/ai-agent-system/bots/orchestrator/lib/intent-parser.js)
- [router.js](/Users/alexlee/projects/ai-agent-system/bots/orchestrator/src/router.js)

is no longer ideal.

The current system already includes:

- deterministic slash routing
- keyword routing
- learned pattern loading
- unknown phrase capture
- auto-promotion
- rollback
- audit events
- family-based thresholds
- safe-intent policy

Those are intent-engine concerns, not Jay-only concerns.

## Current Shared Shape

The shared layer now lives in two concrete modules:

- [packages/core/lib/intent-core.js](/Users/alexlee/projects/ai-agent-system/packages/core/lib/intent-core.js)
- [packages/core/lib/intent-store.js](/Users/alexlee/projects/ai-agent-system/packages/core/lib/intent-store.js)

This is already in active use by:

- Jay orchestrator
- Worker chat / admin workspace
- Luna commander
- Ska commander
- Claude commander

So the question is no longer "whether to extract", but "how far to keep reducing app-level orchestration".

## Boundary Split

### Already In Core

The following logic is already shared:

1. Unknown phrase normalization and regex helpers
2. Learned pattern loading / reload helpers
3. Dynamic promoted-example loading
4. Auto-promotion threshold policy
5. Safe auto-promotion gating
6. Team-specific threshold metadata
7. Team intent metadata
8. Promotion candidate persistence
9. Promotion event persistence
10. Unknown phrase persistence
11. Reporting helpers for:
   - unrecognized summary/detail
   - promotion thresholds
   - promotion summary/family/event sections
   - team intent report frames
   - intent engine health frames
12. Rollback helpers for learned patterns and candidate state
13. Query builder helpers for promotions/unrecognized
14. Learned pattern file read/write helpers

### Keep In Jay

The following should remain Jay-specific:

1. Actual slash map values
2. Jay keyword inventory
3. Jay handler registry
4. Jay-specific summaries:
   - mainbot logs
   - gateway logs
   - Luna/Ska/Claude logs
   - speed-test execution
5. Jay bot command execution
6. Cross-team orchestration:
   - which shared report to call
   - which team command to wait for
   - which direct route to choose
7. Jay operational wording in Telegram responses

## Shared Modules

### intent-core

Owns:

1. Policy:
   - threshold lookup
   - safe-intent checks
   - auto-promotion decision
2. Parser helpers:
   - normalization
   - regex pattern building
   - query parsing
3. Metadata:
   - team intent metadata
   - intent health targets
4. Reporting:
   - summary/detail line builders
   - report frames
   - section templates

### intent-store

Owns:

1. Table bootstrap
2. Promotion/unrecognized reads
3. Promotion/unrecognized writes
4. Promotion state updates / rollback helpers
5. Learned pattern file storage
6. Example query helpers

## Storage Contract

The shared storage contract is now stable around:

- `unrecognized_intents`
- `intent_promotion_candidates`
- `intent_promotion_events`

The important shared rule is:

- table names stay generic
- schema names stay bot-specific
- file-based learned pattern storage stays profile-specific

## Reuse Targets

### Jay

Primary orchestrator and the most feature-rich adopter.

### Worker

Now connected:

- natural-language task intake
- unknown phrase capture
- candidate/event persistence
- admin apply/rollback
- safe auto-promotion for selected intents

Reminder:

- Worker `n8n/RAG` common-layer review is still planned after Monday unit tests.

### Team Commanders

Now connected:

- Ska operator commander
- Luna commander
- Claude commander

They already use the shared candidate/event policy and safe promotion gating.

## Migration Plan

### Completed

1. Pure helper extraction
2. Learned-pattern and file-store extraction
3. Promotion store extraction
4. Reporting helper extraction
5. Team metadata extraction
6. Worker / commander adoption

### Remaining

1. Reduce Jay `router.js` orchestration further where worthwhile
2. Decide whether slash/keyword parsing should also be lifted into a reusable runtime helper
3. Decide whether a separate `intent-report.js` module is worth introducing, or whether `intent-core.js` is sufficient

## Non-Goals

Do not move these yet:

- Jay handler switchboard
- log file path ownership
- speed-test execution
- launchd/service control
- Telegram response formatting

Those remain app-level concerns and should not be forced into the shared engine unless multiple adopters really need them.

## Recommended Next Step

Treat the shared intent engine as "operationally established".

The best next move is:

1. keep using it for new bots/features
2. only extract more if Jay orchestration becomes noisy again
3. avoid splitting `intent-core.js` prematurely unless file size or ownership actually becomes painful
