'use strict';
const fs     = require('fs');
const path   = require('path');
const pgPool = require(path.join(__dirname, '../../../packages/core/lib/pg-pool'));

async function run() {
  const sql = fs.readFileSync(path.join(__dirname, '005-phase3-tables.sql'), 'utf8');
  await pgPool.run('worker', sql);
  console.log('[migrate 005] Phase 3 테이블 생성 완료 (payroll/projects/milestones/schedules/access_log/error_log)');
  process.exit(0);
}

run().catch(e => { console.error('[migrate 005] 오류:', e.message); process.exit(1); });
