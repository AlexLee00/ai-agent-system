'use strict';

/**
 * 010_failure_cases.ts
 *
 * 목적:
 *   - ska.failure_cases 테이블 생성
 *   - 스카팀 자기 복구 Loop 1: 실패 수집 + 패턴 분류 + 자동 복구 기록
 *
 * 에러 유형:
 *   - network_error: 네트워크 끊김 (ECONNREFUSED 등)
 *   - selector_broken: DOM 변경으로 셀렉터 깨짐 (detached Frame 등)
 *   - timeout: 응답 지연
 *   - auth_expired: 세션 만료 (401 등)
 *   - unknown: 미분류
 */

const pgPool = require('../../../packages/core/lib/pg-pool');
const SCHEMA = 'ska';

exports.version = 10;
exports.name = 'failure_cases';

exports.up = async function () {
  // ska 스키마 생성 (없으면)
  await pgPool.run(SCHEMA, `
    CREATE SCHEMA IF NOT EXISTS ska
  `);

  await pgPool.run(SCHEMA, `
    CREATE TABLE IF NOT EXISTS ska.failure_cases (
      id            BIGSERIAL PRIMARY KEY,
      error_type    VARCHAR(50) NOT NULL,
      error_message TEXT        NOT NULL,
      agent         VARCHAR(50) NOT NULL,
      count         INTEGER     NOT NULL DEFAULT 1,
      first_seen    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      last_seen     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      auto_resolved BOOLEAN     NOT NULL DEFAULT FALSE,
      resolution    VARCHAR(100),
      resolution_at TIMESTAMPTZ,
      phase         SMALLINT    NOT NULL DEFAULT 1,
      metadata      JSONB
    )
  `);

  // (agent, error_type, error_message) 조합으로 중복 집계
  await pgPool.run(SCHEMA, `
    CREATE UNIQUE INDEX IF NOT EXISTS uniq_failure_cases_key
      ON ska.failure_cases (agent, error_type, md5(error_message))
  `);

  await pgPool.run(SCHEMA, `
    CREATE INDEX IF NOT EXISTS idx_failure_cases_agent
      ON ska.failure_cases (agent)
  `);

  await pgPool.run(SCHEMA, `
    CREATE INDEX IF NOT EXISTS idx_failure_cases_error_type
      ON ska.failure_cases (error_type)
  `);

  await pgPool.run(SCHEMA, `
    CREATE INDEX IF NOT EXISTS idx_failure_cases_last_seen
      ON ska.failure_cases (last_seen DESC)
  `);
};

exports.down = async function () {
  await pgPool.run(SCHEMA, `
    DROP TABLE IF EXISTS ska.failure_cases
  `);
};
