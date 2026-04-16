// @ts-nocheck
'use strict';
const fs   = require('fs');
const path = require('path');
const pgPool = require(path.join(__dirname, '../../../packages/core/lib/pg-pool'));

async function run() {
  const sql = fs.readFileSync(path.join(__dirname, '004-admin-columns.sql'), 'utf8');
  await pgPool.run('worker', sql);
  console.log('[migrate 004] users 관리 컬럼 추가 완료 (channel, must_change_pw, last_login_at)');
  process.exit(0);
}

run().catch(e => { console.error('[migrate 004] 오류:', e.message); process.exit(1); });
