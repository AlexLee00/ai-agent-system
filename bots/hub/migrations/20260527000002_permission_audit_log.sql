-- Permission Tier 감사 로그 테이블
-- 모든 tool call에 대한 tier 결정 기록
CREATE TABLE IF NOT EXISTS hub.permission_audit_log (
  id          BIGSERIAL PRIMARY KEY,
  tool_name   TEXT NOT NULL,
  agent       TEXT,
  caller_team TEXT,
  tier        INTEGER NOT NULL CHECK (tier BETWEEN 1 AND 4),
  tier_name   TEXT NOT NULL CHECK (tier_name IN ('ALLOW', 'MODIFY', 'ESCALATE', 'BLOCK')),
  decision    TEXT NOT NULL CHECK (decision IN ('allowed', 'blocked', 'escalated', 'pending')),
  side_effect TEXT,
  risk_level  TEXT,
  reason      TEXT,
  trace_id    TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_permission_audit_log_created
  ON hub.permission_audit_log (created_at DESC);

CREATE INDEX IF NOT EXISTS idx_permission_audit_log_tier
  ON hub.permission_audit_log (tier, decision, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_permission_audit_log_tool
  ON hub.permission_audit_log (tool_name, created_at DESC);
