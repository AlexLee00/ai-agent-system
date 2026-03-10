'use strict';

/**
 * packages/core/lib/blog-rag-store.js — 블로그 파이프라인 RAG 중간 저장소
 *
 * 각 파이프라인 노드 실행 결과를 session_id 기반으로 저장/조회.
 * 노드 간 결합도 제거 + 부분 재실행 지원.
 * TTL: 7일 자동 만료.
 */

const pgPool = require('./pg-pool');

// ─── 스키마 초기화 ────────────────────────────────────────────────────

/**
 * blog.pipeline_store 테이블이 없으면 생성.
 * 앱 시작 시 1회 호출하거나 필요 시 호출.
 */
async function ensureSchema() {
  await pgPool.run('blog', `
    CREATE TABLE IF NOT EXISTS blog.pipeline_store (
      id         SERIAL,
      session_id TEXT NOT NULL,
      node_id    TEXT NOT NULL,
      node_group TEXT,
      data_type  TEXT NOT NULL DEFAULT 'json',
      content    TEXT,
      metadata   JSONB DEFAULT '{}',
      created_at TIMESTAMPTZ DEFAULT NOW(),
      expires_at TIMESTAMPTZ,
      PRIMARY KEY (session_id, node_id)
    )
  `);

  await pgPool.run('blog', `
    CREATE INDEX IF NOT EXISTS idx_bps_session
      ON blog.pipeline_store(session_id)
  `);
}

// ─── 저장 ─────────────────────────────────────────────────────────────

/**
 * 노드 실행 결과를 session_id + node_id 복합키로 저장.
 * 이미 존재하면 내용을 덮어씀 (ON CONFLICT DO UPDATE).
 *
 * @param {string} sessionId  - 세션 식별자 (날짜_타입_난수)
 * @param {string} nodeId     - 노드 식별자 (예: 'weather', 'it-news')
 * @param {string} nodeGroup  - 노드 그룹 (예: 'research', 'generate', 'validate')
 * @param {*}      data       - 저장할 데이터. string이면 text, 그 외는 JSON
 * @returns {Promise<void>}
 */
async function storeNodeResult(sessionId, nodeId, nodeGroup, data) {
  // 데이터 타입 판별: string → text, 그 외 → json
  const dataType = typeof data === 'string' ? 'text' : 'json';
  const content  = dataType === 'text' ? data : JSON.stringify(data);

  await pgPool.run('blog', `
    INSERT INTO blog.pipeline_store
      (session_id, node_id, node_group, data_type, content, expires_at)
    VALUES
      ($1, $2, $3, $4, $5, NOW() + INTERVAL '7 days')
    ON CONFLICT (session_id, node_id) DO UPDATE SET
      node_group = EXCLUDED.node_group,
      data_type  = EXCLUDED.data_type,
      content    = EXCLUDED.content,
      created_at = NOW(),
      expires_at = NOW() + INTERVAL '7 days'
  `, [sessionId, nodeId, nodeGroup, dataType, content]);
}

// ─── 조회 ─────────────────────────────────────────────────────────────

/**
 * 특정 노드의 결과를 1건 조회.
 * data_type이 'json'이면 자동으로 JSON.parse 후 반환.
 *
 * @param {string} sessionId
 * @param {string} nodeId
 * @returns {Promise<*|null>} 데이터 또는 null
 */
async function getNodeResult(sessionId, nodeId) {
  const row = await pgPool.get('blog', `
    SELECT data_type, content
      FROM blog.pipeline_store
     WHERE session_id = $1
       AND node_id    = $2
       AND (expires_at IS NULL OR expires_at > NOW())
     LIMIT 1
  `, [sessionId, nodeId]);

  if (!row || !row.content) return null;

  if (row.data_type === 'json') {
    try { return JSON.parse(row.content); } catch { return row.content; }
  }
  return row.content;
}

/**
 * 세션의 전체 노드 결과를 { nodeId: data } 형태로 반환.
 *
 * @param {string} sessionId
 * @returns {Promise<Object.<string, *>>}
 */
async function getSessionResults(sessionId) {
  const rows = await pgPool.query('blog', `
    SELECT node_id, data_type, content
      FROM blog.pipeline_store
     WHERE session_id = $1
       AND (expires_at IS NULL OR expires_at > NOW())
     ORDER BY created_at ASC
  `, [sessionId]);

  const result = {};
  for (const row of rows) {
    if (!row.content) continue;
    if (row.data_type === 'json') {
      try { result[row.node_id] = JSON.parse(row.content); } catch { result[row.node_id] = row.content; }
    } else {
      result[row.node_id] = row.content;
    }
  }
  return result;
}

// ─── 만료 데이터 정리 ─────────────────────────────────────────────────

/**
 * 만료된 레코드 삭제.
 * 스케줄러 또는 앱 시작 시 주기적으로 실행 권장.
 *
 * @returns {Promise<number>} 삭제된 행 수
 */
async function cleanupExpired() {
  const r = await pgPool.run('blog', `
    DELETE FROM blog.pipeline_store
     WHERE expires_at IS NOT NULL
       AND expires_at < NOW()
  `);
  return r.rowCount || 0;
}

module.exports = { ensureSchema, storeNodeResult, getNodeResult, getSessionResults, cleanupExpired };
