// @ts-nocheck
'use strict';
const fs   = require('fs');
const path = require('path');
const pgPool = require(path.join(__dirname, '../../../packages/core/lib/pg-pool'));

async function run() {
  const sql = fs.readFileSync(path.join(__dirname, '008-company-menus.sql'), 'utf-8');
  await pgPool.query('worker', sql);
  console.log('✅ 008-company-menus 마이그레이션 완료');
}

run().catch(e => { console.error('❌ 마이그레이션 실패:', e.message); process.exit(1); });
