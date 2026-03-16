'use strict';

const fs = require('fs');
const path = require('path');
const pgPool = require(path.join(__dirname, '../../../packages/core/lib/pg-pool'));

async function run() {
  const sql = fs.readFileSync(path.join(__dirname, '014-document-extraction.sql'), 'utf8');
  await pgPool.run('worker', sql);
  console.log('[migrate 014] worker.documents extraction 컬럼 추가 완료');
  process.exit(0);
}

if (require.main === module) {
  run().catch((error) => {
    console.error('[migrate 014] 오류:', error.message);
    process.exit(1);
  });
}

module.exports = { run };
