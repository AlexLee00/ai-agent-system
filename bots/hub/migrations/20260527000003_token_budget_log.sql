-- Token Budget 초과/경고 이벤트 로그
CREATE TABLE IF NOT EXISTS hub.token_budget_log (
  id           BIGSERIAL PRIMARY KEY,
  agent        TEXT,
  caller_team  TEXT NOT NULL,
  event_type   TEXT NOT NULL CHECK (event_type IN ('warn_80', 'warn_100', 'blocked', 'reset', 'compaction')),
  global_used  NUMERIC(10,4),
  global_limit NUMERIC(10,4),
  team_used    NUMERIC(10,4),
  team_limit   NUMERIC(10,4),
  message      TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_token_budget_log_created
  ON hub.token_budget_log (created_at DESC);

CREATE INDEX IF NOT EXISTS idx_token_budget_log_team
  ON hub.token_budget_log (caller_team, event_type, created_at DESC);
