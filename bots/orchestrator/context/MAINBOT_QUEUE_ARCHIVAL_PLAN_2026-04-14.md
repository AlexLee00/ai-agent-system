# Mainbot Queue Archival Plan

## Current Live Snapshot

Checked against PostgreSQL `jay` database, `claude` schema, on 2026-04-14.

Current row counts:
- `claude.mainbot_queue`: `7`
- `claude.pending_confirms`: `0`
- `claude.morning_queue`: `2`
- `claude.mute_settings`: `0`

Active rows:
- `claude.mainbot_queue`
  - `pending = 0`
  - `deferred = 2`
  - `sent = 5`
- `claude.pending_confirms`
  - `pending = 0`
- `claude.morning_queue`
  - `sent_at IS NULL = 0`

Observed live runtime status:
- `ai.orchestrator` is running with `MAINBOT_QUEUE_CONSUMER_ENABLED=false`
- `publishToQueue(...)` requires `MAINBOT_QUEUE_PUBLISH_ENABLED=true`
- `/tmp/mainbot-queue-usage.jsonl` is still absent

Interpretation:
- no fresh queue intake is visible
- no active confirmation flow depends on `pending_confirms`
- no unsent morning briefing row depends on `morning_queue`
- remaining rows are historical residue, not current operations

## Related Tables

### `claude.mainbot_queue`

Purpose:
- legacy bot alert queue

Current status:
- retired-by-default
- retained only for historical visibility and rollback safety

### `claude.pending_confirms`

Purpose:
- approval workflow rows keyed to queue entries

Current status:
- no active rows
- can be archived together with queue retirement if no new confirmer path still writes here

### `claude.morning_queue`

Purpose:
- deferred overnight briefing batches keyed to queue entries

Current status:
- no unsent rows
- historical rows only

## Recommended Archival Order

### Phase 1. Freeze and observe

1. Keep:
   - `MAINBOT_QUEUE_CONSUMER_ENABLED=false`
   - queue publish opt-in only
2. Watch:
   - `/tmp/mainbot-queue-usage.jsonl`
   - `claude.mainbot_queue` row counts
3. Exit condition:
   - still no new queue writes
   - still no new `pending` rows

### Phase 2. Archive historical rows

Recommended archive shape:
- `claude.mainbot_queue_archive_20260414`
- `claude.morning_queue_archive_20260414`
- `claude.pending_confirms_archive_20260414`

Recommended action:
1. `CREATE TABLE ... AS SELECT * ...`
2. verify row counts
3. export optional CSV/JSON snapshot for cold storage

Why:
- preserves debugging value
- removes pressure to keep queue tables “live”

### Phase 3. Freeze writes at schema level

After archive is verified:
1. remove active producer paths or leave them guarded by explicit env opt-in only
2. consider renaming live tables to make accidental reuse harder
   - example: `mainbot_queue` -> `mainbot_queue_legacy`
3. or keep empty shell tables temporarily if rollback safety is still desired

### Phase 4. Final retirement

Only after a quiet period:
1. remove queue-specific monitoring references
2. deprecate queue migration docs
3. drop or freeze:
   - `claude.mainbot_queue`
   - `claude.pending_confirms`
   - `claude.morning_queue`

## Guardrails

- Do not archive before a quiet observation window passes.
- Do not drop `pending_confirms` and `morning_queue` separately from `mainbot_queue` without checking their foreign-key expectations and historical debugging value.
- Prefer archive-table creation before destructive cleanup.
- Treat `mainbot_queue` as historical evidence first, deletion target second.

## Suggested Next Step

The next safe operational step is:

1. keep observing runtime for a short quiet window
2. create archive tables with row-count verification
3. then decide whether live tables should be renamed, emptied, or fully retired
