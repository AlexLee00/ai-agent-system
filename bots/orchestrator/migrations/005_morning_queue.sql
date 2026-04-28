BEGIN;

CREATE SCHEMA IF NOT EXISTS claude;

CREATE TABLE IF NOT EXISTS claude.morning_queue (
  id          BIGSERIAL   PRIMARY KEY,
  queue_id    TEXT        NOT NULL,
  summary     TEXT        NOT NULL DEFAULT '',
  bot_list    JSONB       NOT NULL DEFAULT '[]'::jsonb,
  event_count INTEGER     NOT NULL DEFAULT 1,
  deferred_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  sent_at     TIMESTAMPTZ
);

ALTER TABLE claude.morning_queue
  ADD COLUMN IF NOT EXISTS queue_id TEXT NOT NULL DEFAULT 'legacy';

ALTER TABLE claude.morning_queue
  ADD COLUMN IF NOT EXISTS summary TEXT NOT NULL DEFAULT '';

ALTER TABLE claude.morning_queue
  ADD COLUMN IF NOT EXISTS bot_list JSONB NOT NULL DEFAULT '[]'::jsonb;

ALTER TABLE claude.morning_queue
  ADD COLUMN IF NOT EXISTS event_count INTEGER NOT NULL DEFAULT 1;

ALTER TABLE claude.morning_queue
  ADD COLUMN IF NOT EXISTS deferred_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

ALTER TABLE claude.morning_queue
  ADD COLUMN IF NOT EXISTS sent_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_morning_queue_unsent_deferred
  ON claude.morning_queue (deferred_at ASC)
  WHERE sent_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_morning_queue_queue_id
  ON claude.morning_queue (queue_id);

COMMIT;
