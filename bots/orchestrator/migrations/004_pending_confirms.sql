BEGIN;

CREATE TABLE IF NOT EXISTS claude.pending_confirms (
  id          BIGSERIAL    PRIMARY KEY,
  queue_id    TEXT         NOT NULL,
  confirm_key TEXT         NOT NULL UNIQUE,
  message     TEXT         NOT NULL DEFAULT '',
  status      TEXT         NOT NULL DEFAULT 'pending',
  expires_at  TIMESTAMPTZ  NOT NULL,
  resolved_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_pending_confirms_status_exp
  ON claude.pending_confirms (status, expires_at)
  WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS idx_pending_confirms_queue
  ON claude.pending_confirms (queue_id, status);

COMMIT;
