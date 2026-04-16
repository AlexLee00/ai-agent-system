// @ts-nocheck
'use strict';

const fs = require('fs');
const path = require('path');
const pgPool = require(path.join(__dirname, '../../../packages/core/lib/pg-pool'));

async function run() {
  const sql = fs.readFileSync(path.join(__dirname, '015-document-reuse-events.sql'), 'utf8');
  await pgPool.run('worker', sql);
  console.log('[migrate 015] worker.document_reuse_events 테이블 추가 완료');
  process.exit(0);
}

async function up() {
  const sql = fs.readFileSync(path.join(__dirname, '015-document-reuse-events.sql'), 'utf8');
  await pgPool.run('worker', sql);
}

if (require.main === module) {
  run().catch((error) => {
    console.error('[migrate 015] 오류:', error.message);
    process.exit(1);
  });
}

module.exports = { run, up };
