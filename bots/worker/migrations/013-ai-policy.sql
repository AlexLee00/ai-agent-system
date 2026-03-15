-- 013-ai-policy.sql
-- worker 권한별 AI UI/LLM/확인 정책 컬럼 추가

ALTER TABLE worker.companies
  ADD COLUMN IF NOT EXISTS ai_member_ui_mode TEXT NOT NULL DEFAULT 'prompt_only',
  ADD COLUMN IF NOT EXISTS ai_admin_ui_mode TEXT NOT NULL DEFAULT 'prompt_plus_dashboard',
  ADD COLUMN IF NOT EXISTS ai_member_llm_mode TEXT NOT NULL DEFAULT 'assist',
  ADD COLUMN IF NOT EXISTS ai_admin_llm_mode TEXT NOT NULL DEFAULT 'assist',
  ADD COLUMN IF NOT EXISTS ai_confirmation_mode TEXT NOT NULL DEFAULT 'required',
  ADD COLUMN IF NOT EXISTS ai_allow_admin_llm_toggle BOOLEAN NOT NULL DEFAULT TRUE;

ALTER TABLE worker.users
  ADD COLUMN IF NOT EXISTS ai_ui_mode_override TEXT,
  ADD COLUMN IF NOT EXISTS ai_llm_mode_override TEXT,
  ADD COLUMN IF NOT EXISTS ai_confirmation_mode_override TEXT;
