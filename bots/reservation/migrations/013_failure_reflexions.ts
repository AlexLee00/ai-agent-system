'use strict';

/**
 * 013_failure_reflexions.ts
 *
 * 목적:
 *   - ska.failure_reflexions 테이블 생성
 *   - 스카팀 자기 복구 Layer 2: Reflexion + Chain-of-Hindsight
 *
 * 동일 패턴 3건+ 발생 시 LLM이 5-Why + Hindsight + avoid_pattern 생성.
 * 다음 사이클에서 avoid_pattern을 조회하여 유사 실패 사전 회피.
 *
 * 참조: Reflexion (Shinn 2023), Luna luna_failure_reflexions 패턴
 */

const pgPool = require('../../../packages/core/lib/pg-pool');
const SCHEMA = 'ska';

exports.version = 13;
exports.name = 'failure_reflexions';

exports.up = async function () {
  await pgPool.run(SCHEMA, `CREATE SCHEMA IF NOT EXISTS ska`);

  await pgPool.run(SCHEMA, `
    CREATE TABLE IF NOT EXISTS ska.failure_reflexions (
      id                BIGSERIAL    PRIMARY KEY,
      failure_case_id   BIGINT       REFERENCES ska.failure_cases(id) ON DELETE SET NULL,
      agent             TEXT         NOT NULL,
      error_type        TEXT         NOT NULL,
      five_why          JSONB,
      stage_attribution JSONB,
      hindsight         TEXT,
      avoid_pattern     JSONB,
      llm_provider      TEXT,
      created_at        TIMESTAMPTZ  NOT NULL DEFAULT NOW()
    )
  `);

  await pgPool.run(SCHEMA, `
    CREATE UNIQUE INDEX IF NOT EXISTS idx_ska_failure_reflexions_unique
      ON ska.failure_reflexions (failure_case_id)
  `);

  await pgPool.run(SCHEMA, `
    CREATE INDEX IF NOT EXISTS idx_ska_failure_reflexions_pattern
      ON ska.failure_reflexions USING GIN (avoid_pattern)
  `);

  await pgPool.run(SCHEMA, `
    CREATE INDEX IF NOT EXISTS idx_ska_failure_reflexions_agent
      ON ska.failure_reflexions (agent, error_type)
  `);

  await pgPool.run(SCHEMA, `
    CREATE INDEX IF NOT EXISTS idx_ska_failure_reflexions_created
      ON ska.failure_reflexions (created_at DESC)
  `);
};

exports.down = async function () {
  await pgPool.run(SCHEMA, `DROP TABLE IF EXISTS ska.failure_reflexions`);
};
