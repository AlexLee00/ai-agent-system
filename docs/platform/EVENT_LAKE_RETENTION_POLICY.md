# Event Lake Retention Policy P1

## Decision

Do not enable the current deletion path. TASK-0076 adopts a staged policy:

1. Unknown or durable event types default to **keep**.
2. Only an explicit allowlist can become retention-eligible.
3. Every eligible population must be written to an immutable archive manifest,
   restored in isolation, and verified before deletion.
4. Deletion must target the exact verified population, not a broad time range.
5. Native partitioning is deferred. The sidecar draft is a tested fallback if
   high-frequency `tv.bar` ingest returns.

The existing `scripts/runtime-event-lake-retention.ts` remains useful for
read-only measurement and archive experiments, but its `--apply` mode is not
approved: it can archive one month and then delete candidates from all months,
or delete without an archive. `scripts/runtime-event-lake-retention-v2-draft.ts`
therefore exposes a read-only plan only and has no apply path.

## Read-Only Measurement

Measured 2026-07-19 KST with bounded read-only queries.

| Metric | Current | Audit baseline (2026-07-07) | Finding |
|---|---:|---:|---|
| Rows | 464,319 | 32,011,004 | July 10 rebuild/ingest reduction removed the bulk |
| 24h / 7d ingest | 2,288 / 9,626 | 171k / 3.35M `tv.bar` | Current rate is low |
| Heap / indexes / total | 264 / 156 / 451 MiB | 26.9 GiB total | Dead-row estimate is low (19); physical bloat was not measured |
| `tv.bar` | 31,377 | 31.6M | No `tv.bar` rows are older than 30 days |
| Non-bar older than 90d | 208,051 | 79 | Blanket deletion is unsafe despite the count |
| Duplicate indexes | 6 pairs, about 86 MiB | not recorded | Separate master-gated cleanup candidate |

The table has 13 indexes. Five functional pairs plus the duplicate cycle-id
expression index repeat the same keys under pre/post-rebuild names. Dropping any
index is outside this task; validate query usage and locks in a maintenance task.

### Current source mix

| Source class | Rows | 24h | 7d | Requirement |
|---|---:|---:|---:|---|
| `port_*` | 325,199 | 646 | 4,351 | 90d hot for bounded runtime diagnostics; archive before removal |
| `hub_*` | 42,227 | 1,571 | 4,584 | Mixed active lifecycle/audit; keep until classified |
| `ska_*` | 32,555 | 1 | 7 | Audit/escalation semantics; keep |
| `luna.tv.bar.*` | 31,377 | 0 | 217 | 30d hot; reconstructable raw market telemetry |
| `beam_*` | 14,355 | 0 | 3 | Latest-state semantics; keep until projected |
| `phase3_*` | 5,135 | 48 | 336 | P5 latest-state dependency; keep |
| all other classes | 13,472 | 70 | 132 | Unknown/durable default keep |

The source classes were measured in separate bounded snapshots while ingestion
continued, so their sum is one row above the point-in-time total. `n_dead_tup`
does not measure physical heap/index bloat; a future maintenance-window audit
should use `pgstattuple_approx` or page-density evidence. Duplicate indexes are
reported separately and are not treated as bloat evidence.

## Consumer Inventory

| Consumer class | Effective window or semantic requirement | Hot-retention conclusion |
|---|---|---|
| Core search/stats/commands/inbox, Hub event routes, Sigma feedback, Scout intel | Defaults 24h; command origin 7d; caller windows can be uncapped; feedback updates by row ID | Do not blanket-delete |
| Elixir EventLake cache/stats | Latest 1,000 non-bar; all-retained-history stats; failures are count-limited | Keep unknown types |
| Cycle and Jay autonomy | All-history max/latest cycle, latest state/phase, recovery/audit fallback | Project durable state before retention |
| P5 diagnostics and Hub health | Latest `phase3_shadow_report`; currently no freshness gate | Keep; add freshness in a separate task |
| Alarm stack | 5m-24h normal windows; active auto-repair lifecycle is unbounded until terminal | Terminal rows may be classifiable later; active rows keep |
| Dashboard/project visibility | 24h panels plus latest/count-limited project, task, growth, and cycle events | Keep unknown types |
| Hub operations | 24h/7d reports; trace default 168h and capped at 30d | 30d is enough only for proven telemetry |
| Luna | Health 6h, Scout 24h, bottleneck 6h/24h/7d, KIS funnel 168h | 30d is enough only for proven telemetry |
| Blog | 7d/14d reads plus all-history feedback and Phase 3 backfill | Keep durable/backfill types |
| SKA and Claude | 6h/24h diagnostics; intended 7d/14d readers contain schema drift | Fix readers before relying on them |
| DR/backup | Full hot-table dump; backup snapshots retained 14d; cold CSV is not restored by consumers | Restore drill required before delete |

The previous claim that 168h was the longest requirement conflated explicit
lookback windows with latest-state, cumulative, active-lifecycle, feedback-ID,
backfill, and recovery semantics.

## Alternatives

| Option | Benefit | Cost/risk | Decision |
|---|---|---|---|
| Monthly range partitions and partition drop | Predictable retention, no delete bloat | High cutover/PK/trigger/consumer risk at only 464k rows | Defer |
| Periodic blanket delete | Smallest implementation | WAL, dead tuples, VACUUM load, semantic data loss | Reject |
| Cold archive table/file plus blanket delete | Keeps history outside hot DB | Current archive/delete scopes are not coupled | Reject |
| Explicit allowlist + verified immutable archive + exact delete | Safe default, incremental rollout, low complexity | Requires manifest/restore implementation | Adopt |

Partitioning is promoted only if `tv.bar` exceeds 5 million hot rows, exceeds
100,000 rows/day for seven consecutive days, or measured retention batches cause
writer latency/autovacuum pressure. At that point use the sidecar migration draft,
shadow dual-write, and checksum comparison rather than in-place repartitioning.

## Draft Policy

| Class | Match | Hot period | Cold requirement | Default action |
|---|---|---:|---|---|
| raw bars | `luna.tv.bar.%` | 30d | immutable archive + restore proof | eligible after proof |
| ephemeral runtime | exact `port_agent_run/started/completed/failed/skipped` | 90d | immutable archive + restore proof | eligible after proof |
| all other events | no match | unbounded until classified/projected | n/a | keep |

The initial allowlist covers about 190,500 currently aged `port_*` rows. At the
current average relation density this is roughly 185 MiB of logical hot data.
Regular VACUUM would make space reusable but would not return it to the OS.
Separately removing genuinely duplicate indexes could return about 86 MiB.

## Master-Gated Application Procedure

1. Keep `EVENT_LAKE_RETENTION_ENABLED` off and do not load or kick the job.
2. Fix durable dependencies first: cycle numbering, active repair ownership, P5
   freshness, and broken SKA/Claude readers are separate tasks.
3. Implement an immutable daily archive manifest containing schema version,
   event-type scope, UTC bounds, exact IDs or exact ID ranges plus predicates,
   row count, min/max ID, and SHA-256. Use restrictive file permissions.
4. Restore each archive into an isolated database and verify schema, row count,
   IDs, and checksum. A failure blocks deletion.
5. Run candidate report-only mode and compare it with the approved allowlist.
6. In a maintenance window, acquire an advisory lock and enforce statement,
   batch, sleep, row-count, and wall-clock limits.
7. Delete only IDs represented by one verified manifest. Monitor writer latency,
   WAL, dead tuples, replication/backup health, and disk free space after each batch.
8. Stop on any mismatch. Run ordinary `VACUUM (ANALYZE)` separately; do not use
   blocking `VACUUM FULL` on the live table.
9. Observe for one full backup/restore cycle before expanding the allowlist.
10. If partitioning is later promoted, create the UTC cutover month plus at least
    two forward partitions before dual-write. Before each subsequent partition,
    prove the default partition is empty; otherwise move and verify its bounded
    rows before attaching the new partition. Never detach/drop the default.

## Rollback

- Before deletion: discard the draft manifest/job; production is unchanged.
- During deletion: stop future batches; do not reverse already committed batches
  in the hot table while writers are active.
- Restore the exact manifest population into a staging table, validate IDs and
  checksums, then master-approve a bounded `INSERT ... ON CONFLICT DO NOTHING`.
- For a future sidecar cutover, disable dual-write, point readers/writers back to
  `agent.event_lake`, and retain the sidecar until parity is re-established.

## Verification Queries

Use bounded/index-backed checks during an approved window:

```sql
SELECT COUNT(*) FROM agent.event_lake
WHERE event_type = ANY($1::text[]) AND created_at >= $2 AND created_at < $3;

SELECT n_live_tup, n_dead_tup, last_autovacuum
FROM pg_stat_user_tables
WHERE schemaname = 'agent' AND relname = 'event_lake';

SELECT pg_size_pretty(pg_total_relation_size('agent.event_lake'));
```

## Draft Artifacts

- `scripts/runtime-event-lake-retention-v2-draft.ts`: read-only allowlist planner;
  no apply path and no telemetry mutation.
- `scripts/sql/event-lake-tv-bar-partition-v2-draft.sql`: deferred sidecar DDL.
- `scripts/event-lake-retention-v2-smoke.ts`: policy unit checks and real
  PostgreSQL `pg_temp` partition insert/detach/drop simulation.
