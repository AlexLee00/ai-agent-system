// @ts-nocheck
'use strict';

const fs = require('fs');
const path = require('path');
const pgPool = require(path.join(__dirname, '../../../packages/core/lib/pg-pool'));

async function run() {
  const sql = fs.readFileSync(path.join(__dirname, '016-document-reuse-linking.sql'), 'utf8');
  await pgPool.run('worker', sql);
  console.log('[migrate 016] worker.document_reuse_events 연결 컬럼 추가 완료');
  process.exit(0);
}

async function up() {
  const sql = fs.readFileSync(path.join(__dirname, '016-document-reuse-linking.sql'), 'utf8');
  await pgPool.run('worker', sql);
}

if (require.main === module) {
  run().catch((error) => {
    console.error('[migrate 016] 오류:', error.message);
    process.exit(1);
  });
}

module.exports = { run, up };
