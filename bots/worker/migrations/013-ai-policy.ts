// @ts-nocheck
'use strict';

const path = require('path');
const pgPool = require(path.join(__dirname, '../../../packages/core/lib/pg-pool'));

async function up() {
  await pgPool.run('worker', `
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

    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'chk_worker_companies_ai_member_ui_mode'
      ) THEN
        ALTER TABLE worker.companies
          ADD CONSTRAINT chk_worker_companies_ai_member_ui_mode
          CHECK (ai_member_ui_mode IN ('prompt_only', 'prompt_plus_dashboard', 'full_master_console'));
      END IF;

      IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'chk_worker_companies_ai_admin_ui_mode'
      ) THEN
        ALTER TABLE worker.companies
          ADD CONSTRAINT chk_worker_companies_ai_admin_ui_mode
          CHECK (ai_admin_ui_mode IN ('prompt_only', 'prompt_plus_dashboard', 'full_master_console'));
      END IF;

      IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'chk_worker_companies_ai_member_llm_mode'
      ) THEN
        ALTER TABLE worker.companies
          ADD CONSTRAINT chk_worker_companies_ai_member_llm_mode
          CHECK (ai_member_llm_mode IN ('off', 'assist', 'full'));
      END IF;

      IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'chk_worker_companies_ai_admin_llm_mode'
      ) THEN
        ALTER TABLE worker.companies
          ADD CONSTRAINT chk_worker_companies_ai_admin_llm_mode
          CHECK (ai_admin_llm_mode IN ('off', 'assist', 'full'));
      END IF;

      IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'chk_worker_companies_ai_confirmation_mode'
      ) THEN
        ALTER TABLE worker.companies
          ADD CONSTRAINT chk_worker_companies_ai_confirmation_mode
          CHECK (ai_confirmation_mode IN ('required', 'optional'));
      END IF;

      IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'chk_worker_users_ai_ui_mode_override'
      ) THEN
        ALTER TABLE worker.users
          ADD CONSTRAINT chk_worker_users_ai_ui_mode_override
          CHECK (ai_ui_mode_override IS NULL OR ai_ui_mode_override IN ('prompt_only', 'prompt_plus_dashboard', 'full_master_console'));
      END IF;

      IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'chk_worker_users_ai_llm_mode_override'
      ) THEN
        ALTER TABLE worker.users
          ADD CONSTRAINT chk_worker_users_ai_llm_mode_override
          CHECK (ai_llm_mode_override IS NULL OR ai_llm_mode_override IN ('off', 'assist', 'full'));
      END IF;

      IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'chk_worker_users_ai_confirmation_mode_override'
      ) THEN
        ALTER TABLE worker.users
          ADD CONSTRAINT chk_worker_users_ai_confirmation_mode_override
          CHECK (ai_confirmation_mode_override IS NULL OR ai_confirmation_mode_override IN ('required', 'optional'));
      END IF;
    END $$;
  `);

  console.log('[migrate 013] worker AI 정책 컬럼 추가 완료');
}

if (require.main === module) {
  up().then(() => process.exit(0)).catch((error) => {
    console.error('❌', error.message);
    process.exit(1);
  });
}

module.exports = { up };
