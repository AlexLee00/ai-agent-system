'use strict';

/**
 * 012-ai-feedback.js — AI feedback session/event 레이어
 */
const path = require('path');
const pgPool = require(path.join(__dirname, '../../../packages/core/lib/pg-pool'));
const {
  ensureAiFeedbackTables,
} = require(path.join(__dirname, '../../../packages/core/lib/ai-feedback-store'));

async function up() {
  await ensureAiFeedbackTables(pgPool, { schema: 'worker' });

  await pgPool.run('worker', `
    ALTER TABLE worker.agent_tasks
      ADD COLUMN IF NOT EXISTS feedback_session_id BIGINT REFERENCES worker.ai_feedback_sessions(id);
    ALTER TABLE worker.approval_requests
      ADD COLUMN IF NOT EXISTS feedback_session_id BIGINT REFERENCES worker.ai_feedback_sessions(id);

    CREATE INDEX IF NOT EXISTS idx_worker_agent_tasks_feedback_session
      ON worker.agent_tasks(feedback_session_id);
    CREATE INDEX IF NOT EXISTS idx_worker_approval_feedback_session
      ON worker.approval_requests(feedback_session_id);
  `);

  console.log('[012] worker.ai_feedback_sessions / worker.ai_feedback_events 생성 완료');
}

if (require.main === module) {
  up().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
}

module.exports = { up };
