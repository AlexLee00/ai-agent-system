// @ts-nocheck
'use strict';
const fs   = require('fs');
const path = require('path');
const pgPool = require(path.join(__dirname, '../../../packages/core/lib/pg-pool'));

async function run() {
  const sql = fs.readFileSync(path.join(__dirname, '006-companies-extra.sql'), 'utf8');
  await pgPool.run('worker', sql);
  console.log('[migrate 006] companies 추가 컬럼 완료 (owner, phone, biz_number, memo)');
  process.exit(0);
}

run().catch(e => { console.error('[migrate 006] 오류:', e.message); process.exit(1); });
