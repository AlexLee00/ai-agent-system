'use strict';

/**
 * 011_selector_history.ts
 *
 * 목적:
 *   - ska.selector_history 테이블 생성
 *   - 스카팀 자기 복구 Loop 2: 웹 파싱 셀렉터 버전 관리
 *
 * 상태(status):
 *   - active:      현재 사용 중 (기본값)
 *   - candidate:   LLM이 생성한 신규 셀렉터 (검증 중)
 *   - promoted:    5회 연속 성공 → 정식 승격
 *   - deprecated:  실패 누적 → 폐기
 *
 * target 예시:
 *   - naver_list, naver_detail, naver_cancel
 *   - pickko_order, pickko_member
 */

const pgPool = require('../../../packages/core/lib/pg-pool');
const SCHEMA = 'ska';

exports.version = 11;
exports.name = 'selector_history';

exports.up = async function () {
  await pgPool.run(SCHEMA, `
    CREATE SCHEMA IF NOT EXISTS ska
  `);

  await pgPool.run(SCHEMA, `
    CREATE TABLE IF NOT EXISTS ska.selector_history (
      id                BIGSERIAL    PRIMARY KEY,
      target            VARCHAR(100) NOT NULL,
      selector_css      TEXT,
      selector_xpath    TEXT,
      version           INTEGER      NOT NULL DEFAULT 1,
      status            VARCHAR(20)  NOT NULL DEFAULT 'active',
      success_count     INTEGER      NOT NULL DEFAULT 0,
      fail_count        INTEGER      NOT NULL DEFAULT 0,
      consecutive_ok    INTEGER      NOT NULL DEFAULT 0,
      consecutive_fail  INTEGER      NOT NULL DEFAULT 0,
      llm_generated     BOOLEAN      NOT NULL DEFAULT FALSE,
      llm_provider      VARCHAR(50),
      promoted_at       TIMESTAMPTZ,
      deprecated_at     TIMESTAMPTZ,
      created_at        TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
      updated_at        TIMESTAMPTZ  NOT NULL DEFAULT NOW()
    )
  `);

  // 타겟별 최신 active 셀렉터 빠른 조회
  await pgPool.run(SCHEMA, `
    CREATE INDEX IF NOT EXISTS idx_selector_history_target_status
      ON ska.selector_history (target, status)
  `);

  await pgPool.run(SCHEMA, `
    CREATE INDEX IF NOT EXISTS idx_selector_history_updated
      ON ska.selector_history (updated_at DESC)
  `);

  // updated_at 자동 갱신 트리거
  await pgPool.run(SCHEMA, `
    CREATE OR REPLACE FUNCTION ska.update_selector_updated_at()
    RETURNS TRIGGER AS $$
    BEGIN
      NEW.updated_at = NOW();
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql
  `);

  await pgPool.run(SCHEMA, `
    DROP TRIGGER IF EXISTS trg_selector_updated_at ON ska.selector_history
  `);

  await pgPool.run(SCHEMA, `
    CREATE TRIGGER trg_selector_updated_at
      BEFORE UPDATE ON ska.selector_history
      FOR EACH ROW
      EXECUTE FUNCTION ska.update_selector_updated_at()
  `);
};

exports.down = async function () {
  await pgPool.run(SCHEMA, `
    DROP TABLE IF EXISTS ska.selector_history
  `);

  await pgPool.run(SCHEMA, `
    DROP FUNCTION IF EXISTS ska.update_selector_updated_at()
  `);
};
