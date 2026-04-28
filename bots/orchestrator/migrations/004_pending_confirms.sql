BEGIN;

CREATE SCHEMA IF NOT EXISTS claude;

CREATE TABLE IF NOT EXISTS claude.pending_confirms (
  id          BIGSERIAL    PRIMARY KEY,
  queue_id    TEXT         NOT NULL,
  confirm_key TEXT         NOT NULL UNIQUE,
  type        TEXT         NOT NULL DEFAULT 'mainbot_confirm',
  payload     JSONB        NOT NULL DEFAULT '{}'::jsonb,
  message     TEXT         NOT NULL DEFAULT '',
  status      TEXT         NOT NULL DEFAULT 'pending',
  created_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  expires_at  TIMESTAMPTZ  NOT NULL,
  resolved_at TIMESTAMPTZ
);

ALTER TABLE claude.pending_confirms
  ADD COLUMN IF NOT EXISTS type TEXT NOT NULL DEFAULT 'mainbot_confirm';

ALTER TABLE claude.pending_confirms
  ADD COLUMN IF NOT EXISTS payload JSONB NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE claude.pending_confirms
  ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

ALTER TABLE claude.pending_confirms
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

CREATE INDEX IF NOT EXISTS idx_pending_confirms_status_exp
  ON claude.pending_confirms (status, expires_at)
  WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS idx_pending_confirms_queue
  ON claude.pending_confirms (queue_id, status);

CREATE INDEX IF NOT EXISTS idx_pending_confirms_type_status_exp
  ON claude.pending_confirms (type, status, expires_at)
  WHERE status = 'pending';

COMMIT;
