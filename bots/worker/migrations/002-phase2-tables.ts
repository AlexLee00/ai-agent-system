// @ts-nocheck
'use strict';
/**
 * migrations/002-phase2-tables.js — Phase 2 마이그레이션 실행기
 * 실행: node bots/worker/migrations/002-phase2-tables.js
 */
const fs   = require('fs');
const path = require('path');
const pgPool = require('../../../packages/core/lib/pg-pool');

async function run() {
  const sql = fs.readFileSync(path.join(__dirname, '002-phase2-tables.sql'), 'utf8');
  console.log('[migration 002] Phase 2 테이블 생성 중...');
  await pgPool.run('worker', sql);
  console.log('[migration 002] ✅ 완료: employees, attendance, sales, documents');
  process.exit(0);
}

run().catch(e => { console.error('[migration 002] ❌ 실패:', e.message); process.exit(1); });
