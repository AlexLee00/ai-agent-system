// @ts-nocheck
'use strict';

/**
 * bots/worker/migrations/001-init-schema.js
 * worker 스키마 초기 생성 (Node.js 실행 방식)
 *
 * 실행: node bots/worker/migrations/001-init-schema.js
 */

const path   = require('path');
const pgPool = require(path.join(__dirname, '../../../packages/core/lib/pg-pool'));

async function up() {
  // worker 스키마는 public 풀로 생성 (아직 worker 풀 없음)
  const pool = pgPool.getPool('public');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    await client.query(`CREATE SCHEMA IF NOT EXISTS worker`);

    await client.query(`
      CREATE TABLE IF NOT EXISTS worker.companies (
        id          TEXT PRIMARY KEY,
        name        TEXT NOT NULL,
        created_at  TIMESTAMPTZ DEFAULT NOW(),
        updated_at  TIMESTAMPTZ DEFAULT NOW(),
        deleted_at  TIMESTAMPTZ
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS worker.users (
        id            SERIAL PRIMARY KEY,
        company_id    TEXT REFERENCES worker.companies(id),
        username      TEXT UNIQUE NOT NULL,
        password_hash TEXT NOT NULL,
        role          TEXT NOT NULL CHECK (role IN ('master','admin','member')),
        name          TEXT NOT NULL,
        email         TEXT,
        telegram_id   BIGINT,
        created_at    TIMESTAMPTZ DEFAULT NOW(),
        updated_at    TIMESTAMPTZ DEFAULT NOW(),
        deleted_at    TIMESTAMPTZ
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS worker.audit_log (
        id          SERIAL PRIMARY KEY,
        company_id  TEXT NOT NULL,
        user_id     INTEGER,
        action      TEXT NOT NULL,
        target      TEXT NOT NULL,
        target_id   INTEGER,
        detail      JSONB,
        ip_address  TEXT,
        created_at  TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS worker.approval_requests (
        id            SERIAL PRIMARY KEY,
        company_id    TEXT NOT NULL,
        requester_id  INTEGER NOT NULL,
        approver_id   INTEGER,
        category      TEXT NOT NULL,
        action        TEXT NOT NULL,
        target_table  TEXT NOT NULL,
        target_id     INTEGER,
        payload       JSONB NOT NULL,
        status        TEXT DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected','cancelled')),
        priority      TEXT DEFAULT 'normal'  CHECK (priority IN ('normal','urgent')),
        reject_reason TEXT,
        approved_at   TIMESTAMPTZ,
        rejected_at   TIMESTAMPTZ,
        created_at    TIMESTAMPTZ DEFAULT NOW(),
        updated_at    TIMESTAMPTZ DEFAULT NOW(),
        deleted_at    TIMESTAMPTZ
      )
    `);

    await client.query(`CREATE INDEX IF NOT EXISTS idx_worker_users_company      ON worker.users (company_id)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_worker_audit_company_time ON worker.audit_log (company_id, created_at)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_worker_approval_company   ON worker.approval_requests (company_id, status)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_worker_approval_approver  ON worker.approval_requests (approver_id, status)`);

    await client.query('COMMIT');
    console.log('✅ worker 스키마 마이그레이션 완료');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

if (require.main === module) {
  up().then(() => process.exit(0)).catch(e => { console.error('❌', e.message); process.exit(1); });
}

module.exports = { up };
