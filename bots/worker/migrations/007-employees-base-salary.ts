// @ts-nocheck
'use strict';
const fs   = require('fs');
const path = require('path');
const pgPool = require(path.join(__dirname, '../../../packages/core/lib/pg-pool'));

async function run() {
  const sql = fs.readFileSync(path.join(__dirname, '007-employees-base-salary.sql'), 'utf8');
  await pgPool.run('worker', sql);
  console.log('[migrate 007] employees.base_salary 컬럼 추가 완료');
  process.exit(0);
}

run().catch(e => { console.error('[migrate 007] 오류:', e.message); process.exit(1); });
