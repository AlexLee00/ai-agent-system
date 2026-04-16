// @ts-nocheck
'use strict';
/**
 * 010-claude-code-chat.js — Claude Code 채팅 세션/메시지 DB 저장
 * 디바이스 간 동기화를 위해 PostgreSQL에 저장
 */
const pgPool = require('../../../packages/core/lib/pg-pool');

async function up() {
  await pgPool.run('worker', `
    CREATE TABLE IF NOT EXISTS claude_code_sessions (
      id         TEXT        PRIMARY KEY,
      title      TEXT        NOT NULL DEFAULT '새 세션',
      started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      last_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  await pgPool.run('worker', `
    CREATE TABLE IF NOT EXISTS claude_code_messages (
      id         SERIAL      PRIMARY KEY,
      session_id TEXT        NOT NULL REFERENCES claude_code_sessions(id) ON DELETE CASCADE,
      role       TEXT        NOT NULL,   -- 'user' | 'assistant' | 'tool'
      content    TEXT,                   -- user / assistant 텍스트
      tool_name  TEXT,                   -- tool 호출 이름
      tool_input JSONB,                  -- tool 입력값
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_code_messages_session
      ON claude_code_messages(session_id, created_at);
  `);

  console.log('[010] claude_code_sessions / claude_code_messages 생성 완료');
}

up().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
