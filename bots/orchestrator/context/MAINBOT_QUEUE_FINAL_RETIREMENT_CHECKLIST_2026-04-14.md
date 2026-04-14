# Mainbot Queue Final Retirement Checklist

## Goal

Remove the last frozen live legacy queue tables after a quiet period, while
keeping archive copies available for audit and rollback.

## Preconditions

- `ai.orchestrator` remains healthy with `MAINBOT_QUEUE_CONSUMER_ENABLED=false`
- `publishToQueue(...)` remains opt-in only
- `/tmp/mainbot-queue-usage.jsonl` stays empty during the quiet window
- no new `pending` rows appear in `claude.mainbot_queue`
- archive tables remain present:
  - `claude.mainbot_queue_archive_20260414`
  - `claude.pending_confirms_archive_20260414`
  - `claude.morning_queue_archive_20260414`

## Quiet Window Checks

Recommended checks before destructive cleanup:

1. `claude.mainbot_queue` row count unchanged
2. `claude.mainbot_queue_legacy_live` row count unchanged
3. `claude.pending_confirms` still `0`
4. `claude.morning_queue` still has no unsent rows
5. no queue telemetry file or no new queue telemetry entries
6. orchestrator health still normal

## Latest Live Verification

Latest verification snapshot on `2026-04-14`:

- `ai.orchestrator` live state: `running`
- `MAINBOT_QUEUE_CONSUMER_ENABLED=false` confirmed in launchd environment
- `/tmp/mainbot-queue-usage.jsonl`: absent
- `claude.mainbot_queue = 7`
- `claude.mainbot_queue_legacy_live = 7`
- `claude.pending_confirms = 0`
- `claude.pending_confirms_legacy_live = 0`
- `claude.morning_queue = 2`
- `claude.morning_queue_legacy_live = 2`
- `claude.mainbot_queue_legacy_live` status counts:
  - `pending = 0`
  - `deferred = 2`
  - `sent = 5`
- `claude.morning_queue_legacy_live` unsent rows:
  - `sent_at IS NULL = 0`

Interpretation:

- quiet window checks remain green
- no current signal suggests active legacy queue usage
- final destructive cleanup is operationally ready, but still requires an
  explicit go/no-go decision

## Planned Cleanup

Prepared SQL:
- [mainbot_queue_final_drop_20260414.sql](/Users/alexlee/projects/ai-agent-system/scripts/sql/mainbot_queue_final_drop_20260414.sql)
- [mainbot_queue_restore_from_archive_20260414.sql](/Users/alexlee/projects/ai-agent-system/scripts/sql/mainbot_queue_restore_from_archive_20260414.sql)

Execution order:
1. confirm quiet window checks
2. run final drop SQL
3. verify:
   - compatibility views removed
   - legacy live tables removed
   - archive tables still present
4. if rollback is needed, restore from archive SQL

## Post-Drop Verification

- `claude.mainbot_queue` no longer exists
- `claude.pending_confirms` no longer exists
- `claude.morning_queue` no longer exists
- archive tables still query successfully
- orchestrator remains healthy
- no current runtime path expects legacy queue tables

## Notes

- This is the first truly destructive step in the queue retirement sequence.
- Archive tables are the canonical rollback source after final drop.
- Prefer keeping this checklist with the archival plan until cleanup is complete.
