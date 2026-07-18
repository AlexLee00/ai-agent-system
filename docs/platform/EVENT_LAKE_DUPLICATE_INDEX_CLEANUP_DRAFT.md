# Event Lake Duplicate Index Cleanup Draft

Status: design only. No DDL was executed. Snapshot: 2026-07-19 08:04:56 KST,
PostgreSQL 17.9, `transaction_read_only=on` for the audit session.

## Decision

Keep the canonical indexes created by `packages/core/lib/event-lake.ts` and
`packages/core/lib/cycle.ts`. The six `_new_*` candidates are exact catalog
equivalents: access method, keys/expressions, sort options, opclasses,
predicates, and validity flags match. Each pair is bidirectionally covering;
there is no strict superset. The `_new_pkey` index is excluded because it backs
the primary-key constraint.

`pg_stat_database.stats_reset` was `NULL`. PostgreSQL started at
2026-07-13 08:42:26 KST, so `idx_scan` is supporting evidence rather than an
equal-duration rate. The candidates may have different creation ages and
`pg_stat_statements` is not installed.

A read-only recheck at 2026-07-19 08:24:11 KST found all seven `_new_*`
indexes valid and ready. Only the cumulative expression-candidate count had
changed, from 2,472 to 2,475; this does not change the equivalence decision.

## Full Inventory

| Keep | Keep size / scans | Candidate | Candidate size / scans | Exact definition |
|---|---:|---|---:|---|
| `event_lake_created_at_desc_idx` | 8024 kB / 35,890 | `event_lake_new_created_at_idx` | 13 MB / 6 | btree `(created_at DESC)` |
| `event_lake_event_type_created_at_idx` | 17 MB / 277,325 | `event_lake_new_event_type_created_at_idx` | 27 MB / 51 | btree `(event_type, created_at DESC)` |
| `idx_event_lake_cycle_id` | 3200 kB / 0 | `event_lake_new_expr_idx` | 3272 kB / 2,472 | btree `((metadata->>'cycle_id'))` |
| `event_lake_severity_created_at_idx` | 11 MB / 0 | `event_lake_new_severity_created_at_idx` | 18 MB / 0 | btree `(severity, created_at DESC)` |
| `event_lake_tags_gin_idx` | 3528 kB / 0 | `event_lake_new_tags_idx` | 6304 kB / 0 | GIN `(tags)` |
| `event_lake_team_created_at_idx` | 12 MB / 11,853 | `event_lake_new_team_created_at_idx` | 19 MB / 3 | btree `(team, created_at DESC)` |

Removing only those six candidates would reclaim 90,587,136 bytes, about
86 MiB, reducing event-lake index storage from roughly 156 MB to 70 MB.

## Plain EXPLAIN

The audit used `EXPLAIN` only, never `ANALYZE`, with a five-second statement
timeout. Representative consumers selected a surviving canonical index:

| Consumer shape | Selected plan |
|---|---|
| Dashboard tail ordered by creation | incremental sort over `event_lake_created_at_desc_idx` |
| `hub_alarm` in the last 60 minutes | index scan on `event_lake_event_type_created_at_idx` |
| Darwin team tail | index scan on `event_lake_team_created_at_idx` |
| Error severity in the last 24 hours | index scan on `event_lake_severity_created_at_idx` |
| Cycle-id lookup | index scan on `event_lake_new_expr_idx`, exact twin of `idx_event_lake_cycle_id` |
| Command lifecycle event set | index scan on `event_lake_event_type_created_at_idx` |

The expression candidate is currently selected for cycle lookups, but its
canonical twin has an identical definition and is not a strict subset. It is
therefore removed last. No production tags predicate was found; both GIN twins
show zero scans.

## Master-Gated Procedure

1. Re-run the catalog equivalence, size, validity, readiness, dependency, and
   `idx_scan` queries. Stop if any definition or constraint dependency changed.
2. Save fresh `pg_get_indexdef` output for the candidate being removed.
3. Use a dedicated autocommit session. Do not use `BEGIN`; PostgreSQL forbids
   `DROP INDEX CONCURRENTLY` inside a transaction block.
4. Set bounded `lock_timeout` and `statement_timeout`, then copy one uncommented
   DROP statement from `scripts/sql/event-lake-duplicate-index-cleanup-draft.sql`.
5. Check `indisvalid`/`indisready`, table/index size, and the matching plain
   EXPLAIN before continuing. Stop on any unexpected plan or lock timeout.
6. Remove in this order: severity, tags, team, created-at, event-type, cycle-id
   expression. Observe normal traffic between statements.
7. If a regression appears, stop and recreate only removed indexes in reverse
   order with the preserved `CREATE INDEX CONCURRENTLY` statement. A failed
   concurrent build may leave an invalid index; inspect and clean that artifact
   explicitly before retrying.

## Partition Policy

This cleanup does not promote partitioning. The deferred sidecar policy in
`EVENT_LAKE_RETENTION_POLICY.md` remains authoritative. If partitioning is later
promoted, create only the six canonical logical indexes on each required
partition/partitioned parent; do not recreate the `_new_*` aliases. Validate
default-partition emptiness and dual-write parity before attachment as already
required by that policy.
