'use strict';

/**
 * Migration 001 — Initial Schema
 *
 * 최초 스키마: analysis, signals, trades, positions
 * 이미 initSchema()로 생성된 테이블이므로 up()은 no-op.
 * down()은 모든 테이블 삭제 (데이터 손실 주의).
 */

exports.version = 1;
exports.name    = 'initial_schema';
exports.date    = '2026-03-01';

async function up(db) {
  // initSchema()에서 CREATE TABLE IF NOT EXISTS로 이미 생성
  // 마이그레이션 추적용 — 실제 DDL 없음
  await db.run(`
    CREATE TABLE IF NOT EXISTS analysis (
      id         VARCHAR DEFAULT gen_random_uuid()::VARCHAR,
      symbol     VARCHAR NOT NULL,
      analyst    VARCHAR NOT NULL,
      signal     VARCHAR NOT NULL,
      confidence DOUBLE,
      reasoning  TEXT,
      metadata   JSON,
      created_at TIMESTAMP DEFAULT now()
    )
  `);
  await db.run(`
    CREATE TABLE IF NOT EXISTS signals (
      id          VARCHAR DEFAULT gen_random_uuid()::VARCHAR,
      symbol      VARCHAR NOT NULL,
      action      VARCHAR NOT NULL,
      amount_usdt DOUBLE,
      confidence  DOUBLE,
      reasoning   TEXT,
      status      VARCHAR DEFAULT 'pending',
      created_at  TIMESTAMP DEFAULT now()
    )
  `);
  await db.run(`
    CREATE TABLE IF NOT EXISTS trades (
      id          VARCHAR DEFAULT gen_random_uuid()::VARCHAR,
      signal_id   VARCHAR,
      symbol      VARCHAR NOT NULL,
      side        VARCHAR NOT NULL,
      amount      DOUBLE,
      price       DOUBLE,
      total_usdt  DOUBLE,
      dry_run     BOOLEAN DEFAULT true,
      executed_at TIMESTAMP DEFAULT now()
    )
  `);
  await db.run(`
    CREATE TABLE IF NOT EXISTS positions (
      symbol         VARCHAR PRIMARY KEY,
      amount         DOUBLE DEFAULT 0,
      avg_price      DOUBLE DEFAULT 0,
      unrealized_pnl DOUBLE DEFAULT 0,
      updated_at     TIMESTAMP DEFAULT now()
    )
  `);
}

async function down(db) {
  // 경고: 데이터 전체 삭제
  await db.run(`DROP TABLE IF EXISTS positions`);
  await db.run(`DROP TABLE IF EXISTS trades`);
  await db.run(`DROP TABLE IF EXISTS signals`);
  await db.run(`DROP TABLE IF EXISTS analysis`);
}

module.exports = { version: exports.version, name: exports.name, up, down };
