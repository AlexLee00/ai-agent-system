-- Symphony Tasks: 클로드팀 Symphony Orchestrator 통합 태스크 큐
-- Phase 1: Control Plane (GitHub Issues + Hub /tasks) 연동

CREATE SCHEMA IF NOT EXISTS agent;

CREATE TABLE IF NOT EXISTS agent.symphony_tasks (
  id                   TEXT PRIMARY KEY,
  source               TEXT NOT NULL,                      -- 'github' | 'telegram' | 'hub'
  target_team          TEXT NOT NULL,                      -- 'claude'|'luna'|'blog'|'ska'|'darwin'|'sigma'
  ticket_type          TEXT,                               -- 'code-patch'|'analysis'|'auto-dev'|...
  title                TEXT NOT NULL,
  body                 TEXT,
  priority             TEXT NOT NULL DEFAULT 'normal',     -- 'low'|'normal'|'high'
  status               TEXT NOT NULL DEFAULT 'todo',       -- 'todo'|'in_progress'|'review'|'done'|'blocked'
  workspace_id         TEXT,                               -- git worktree ID
  source_ref           TEXT,                               -- GitHub issue number 등 원본 ID
  ticket_external_id   TEXT,                               -- GitHub issue URL 등 전체 참조
  assignee             TEXT,                               -- 담당 agent 이름
  pr_url               TEXT,
  error_msg            TEXT,
  metadata             JSONB,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_symphony_tasks_status
  ON agent.symphony_tasks (status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_symphony_tasks_team_status
  ON agent.symphony_tasks (target_team, status);

CREATE INDEX IF NOT EXISTS idx_symphony_tasks_source_ref
  ON agent.symphony_tasks (source_ref)
  WHERE source_ref IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_symphony_tasks_ext_id
  ON agent.symphony_tasks (ticket_external_id)
  WHERE ticket_external_id IS NOT NULL;

-- updated_at 자동 갱신 트리거
CREATE OR REPLACE FUNCTION agent.symphony_tasks_set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS symphony_tasks_updated_at ON agent.symphony_tasks;
CREATE TRIGGER symphony_tasks_updated_at
  BEFORE UPDATE ON agent.symphony_tasks
  FOR EACH ROW EXECUTE FUNCTION agent.symphony_tasks_set_updated_at();
