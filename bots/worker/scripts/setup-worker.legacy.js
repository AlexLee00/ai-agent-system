'use strict';

/**
 * scripts/setup-worker.js — 워커팀 기본 마이그레이션 일괄 실행
 */

const path = require('path');
const { createAgentMemory } = require('../../../packages/core/lib/agent-memory');

const setupMemory = createAgentMemory({ agentId: 'worker.setup', team: 'worker' });

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
  '../migrations/013-ai-policy.js',
  '../migrations/014-document-extraction.js',
  '../migrations/015-document-reuse-events.js',
  '../migrations/016-document-reuse-linking.js',
  '../migrations/017-system-preferences.js',
  '../migrations/018-monitoring-history.js',
  '../migrations/019-monitoring-change-notes.js',
  '../migrations/020-expenses.js',
  '../migrations/021-company-deactivation-meta.js',
];

function buildSetupMemoryQuery(kind) {
  return [
    'worker setup',
    kind,
    `${migrations.length}-migrations`,
  ].filter(Boolean).join(' ');
}

async function main() {
  const memoryQuery = buildSetupMemoryQuery('success');
  const episodicHint = await setupMemory.recallCountHint(memoryQuery, {
    type: 'episodic',
    limit: 2,
    threshold: 0.33,
    title: '최근 유사 setup',
    separator: 'pipe',
    metadataKey: 'kind',
    labels: {
      success: '성공',
      failure: '실패',
    },
    order: ['failure', 'success'],
  }).catch(() => '');
  const semanticHint = await setupMemory.recallHint(`${memoryQuery} consolidated setup pattern`, {
    type: 'semantic',
    limit: 2,
    threshold: 0.28,
    title: '최근 통합 패턴',
    separator: 'newline',
  }).catch(() => '');
  for (const rel of migrations) {
    const mod = require(path.join(__dirname, rel));
    if (typeof mod.up === 'function') {
      await mod.up();
    }
  }
  if (episodicHint) console.log(episodicHint.trimStart());
  if (semanticHint) console.log(semanticHint.trimStart());
  await setupMemory.remember([
    'worker setup 완료',
    `migrationCount: ${migrations.length}`,
  ].join('\n'), 'episodic', {
    importance: 0.64,
    expiresIn: 1000 * 60 * 60 * 24 * 30,
    metadata: {
      kind: 'success',
      migrationCount: migrations.length,
    },
  }).catch(() => {});
  await setupMemory.consolidate({
    olderThanDays: 14,
    limit: 10,
  }).catch(() => {});
  console.log('✅ worker setup 완료');
}

if (require.main === module) {
  main().then(() => process.exit(0)).catch((e) => {
    setupMemory.remember([
      'worker setup 실패',
      `reason: ${e.message}`,
      `migrationCount: ${migrations.length}`,
    ].join('\n'), 'episodic', {
      importance: 0.8,
      expiresIn: 1000 * 60 * 60 * 24 * 30,
      metadata: {
        kind: 'failure',
        migrationCount: migrations.length,
        reason: e.message,
      },
    }).catch(() => {});
    setupMemory.consolidate({
      olderThanDays: 14,
      limit: 10,
    }).catch(() => {});
    console.error('❌ worker setup 실패:', e.message);
    process.exit(1);
  });
}

module.exports = { main };
