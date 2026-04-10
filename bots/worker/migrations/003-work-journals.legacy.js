'use strict';
const fs   = require('fs');
const path = require('path');
const pgPool = require(path.join(__dirname, '../../../packages/core/lib/pg-pool'));

async function run() {
  const sql = fs.readFileSync(path.join(__dirname, '003-work-journals.sql'), 'utf8');
  await pgPool.run('worker', sql);
  console.log('[migrate 003] work_journals 테이블 생성 완료');
  process.exit(0);
}

run().catch(e => { console.error('[migrate 003] 오류:', e.message); process.exit(1); });
