// @ts-nocheck
'use strict';

/**
 * 011-worker-chat.js — 자연어 업무 대화 세션/메시지 저장
 */
const pgPool = require('../../../packages/core/lib/pg-pool');

async function up() {
  await pgPool.run('worker', `
    CREATE TABLE IF NOT EXISTS worker.chat_sessions (
      id           TEXT PRIMARY KEY,
      company_id   TEXT NOT NULL REFERENCES worker.companies(id),
      user_id      INTEGER NOT NULL REFERENCES worker.users(id),
      title        TEXT NOT NULL DEFAULT '새 대화',
      channel      TEXT NOT NULL DEFAULT 'web',
      status       TEXT NOT NULL DEFAULT 'active',
      last_intent  TEXT,
      context      JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      last_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      deleted_at   TIMESTAMPTZ
    );
    CREATE INDEX IF NOT EXISTS idx_worker_chat_sessions_company_user
      ON worker.chat_sessions(company_id, user_id, last_at DESC);
  `);

  await pgPool.run('worker', `
    CREATE TABLE IF NOT EXISTS worker.chat_messages (
      id           SERIAL PRIMARY KEY,
      session_id   TEXT NOT NULL REFERENCES worker.chat_sessions(id) ON DELETE CASCADE,
      company_id   TEXT NOT NULL REFERENCES worker.companies(id),
      user_id      INTEGER REFERENCES worker.users(id),
      role         TEXT NOT NULL,
      content      TEXT,
      intent       TEXT,
      metadata     JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_worker_chat_messages_session
      ON worker.chat_messages(session_id, created_at);
  `);

  console.log('[011] worker.chat_sessions / worker.chat_messages 생성 완료');
}

if (require.main === module) {
  up().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
}

module.exports = { up };
