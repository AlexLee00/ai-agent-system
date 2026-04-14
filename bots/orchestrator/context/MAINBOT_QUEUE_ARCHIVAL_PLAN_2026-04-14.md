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

Archive status:
- completed on 2026-04-14
- created:
  - `claude.mainbot_queue_archive_20260414`
  - `claude.pending_confirms_archive_20260414`
  - `claude.morning_queue_archive_20260414`
- verified row counts:
  - `mainbot_queue_archive_20260414 = 7`
  - `pending_confirms_archive_20260414 = 0`
  - `morning_queue_archive_20260414 = 2`

Freeze status:
- completed on 2026-04-14
- renamed live tables:
  - `claude.mainbot_queue` -> `claude.mainbot_queue_legacy_live`
  - `claude.pending_confirms` -> `claude.pending_confirms_legacy_live`
  - `claude.morning_queue` -> `claude.morning_queue_legacy_live`
- recreated compatibility views:
  - `claude.mainbot_queue`
  - `claude.pending_confirms`
  - `claude.morning_queue`
- verified live view counts match legacy tables

Final retirement status:
- completed on 2026-04-14
- removed compatibility views:
  - `claude.mainbot_queue`
  - `claude.pending_confirms`
  - `claude.morning_queue`
- removed frozen live tables:
  - `claude.mainbot_queue_legacy_live`
  - `claude.pending_confirms_legacy_live`
  - `claude.morning_queue_legacy_live`
- archive tables remain as canonical retained legacy source

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

Status:
- completed

Completed action:
1. `CREATE TABLE ... AS SELECT * ...`
2. verified row counts
3. optional CSV/JSON cold export still pending

Why:
- preserves debugging value
- removes pressure to keep queue tables “live”

### Phase 3. Freeze writes at schema level

Status:
- completed

Completed action:
1. kept active producer paths behind explicit env opt-in
2. renamed live tables to `*_legacy_live`
3. recreated original names as read-only compatibility views
4. prepared rollback script

Prepared scripts:
- [mainbot_queue_freeze_20260414.sql](/Users/alexlee/projects/ai-agent-system/scripts/sql/mainbot_queue_freeze_20260414.sql)
- [mainbot_queue_freeze_rollback_20260414.sql](/Users/alexlee/projects/ai-agent-system/scripts/sql/mainbot_queue_freeze_rollback_20260414.sql)
- [mainbot_queue_final_drop_20260414.sql](/Users/alexlee/projects/ai-agent-system/scripts/sql/mainbot_queue_final_drop_20260414.sql)
- [mainbot_queue_restore_from_archive_20260414.sql](/Users/alexlee/projects/ai-agent-system/scripts/sql/mainbot_queue_restore_from_archive_20260414.sql)
- [MAINBOT_QUEUE_FINAL_RETIREMENT_CHECKLIST_2026-04-14.md](/Users/alexlee/projects/ai-agent-system/bots/orchestrator/context/MAINBOT_QUEUE_FINAL_RETIREMENT_CHECKLIST_2026-04-14.md)

Recommended freeze mode:
- rename live tables to `*_legacy_live`
- recreate original names as read-only views
- this keeps historical reads working but blocks fresh writes loudly

### Phase 4. Final retirement

Status:
- completed

Completed action:
1. completed quiet-window verification
2. ran final destructive cleanup SQL
3. removed compatibility views
4. removed `*_legacy_live` frozen tables
5. kept archive tables as rollback source

## Guardrails

- Do not archive before a quiet observation window passes.
- Do not drop `pending_confirms` and `morning_queue` separately from `mainbot_queue` without checking their foreign-key expectations and historical debugging value.
- Prefer archive-table creation before destructive cleanup.
- Treat `mainbot_queue` as historical evidence first, deletion target second.

## Suggested Next Step

The next safe operational step is:

1. keep archive tables retained for audit / rollback
2. leave restore SQL available unless policy changes
3. treat `mainbot_queue` as fully retired from live runtime and live DB surface
