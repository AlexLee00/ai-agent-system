'use strict';

/**
 * scripts/setup-worker.js — 워커팀 기본 마이그레이션 일괄 실행
 */

const path = require('path');

const migrations = [
  '../migrations/001-init-schema.js',
  '../migrations/002-phase2-tables.js',
  '../migrations/003-work-journals.js',
  '../migrations/004-admin-columns.js',
  '../migrations/005-phase3-tables.js',
  '../migrations/006-companies-extra.js',
  '../migrations/007-employees-base-salary.js',
  '../migrations/008-company-menus.js',
  '../migrations/009-trace-id.js',
  '../migrations/010-claude-code-chat.js',
  '../migrations/011-worker-chat.js',
  '../migrations/012-ai-feedback.js',
];

async function main() {
  for (const rel of migrations) {
    const mod = require(path.join(__dirname, rel));
    if (typeof mod.up === 'function') {
      await mod.up();
    }
  }
  console.log('✅ worker setup 완료');
}

if (require.main === module) {
  main().then(() => process.exit(0)).catch((e) => {
    console.error('❌ worker setup 실패:', e.message);
    process.exit(1);
  });
}

module.exports = { main };
