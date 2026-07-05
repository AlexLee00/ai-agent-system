#!/usr/bin/env node
// @ts-nocheck
'use strict';

const assert = require('node:assert/strict');
const {
  COMMENT_LEARNING_STRATEGY_VERSION,
  buildCommentLearningEventPayload,
  recordCommentLearningEvent,
  deriveNeighborLearningType,
} = require('../lib/comment-learning.ts');
const {
  buildCommentStrategyReportFromRows,
} = require('../lib/comment-strategy-evolver.ts');
const { COMMENT_TYPE_STRATEGIES } = require('../lib/comment-classifier.ts');

function makePool({ tablePresent = false } = {}) {
  const writes = [];
  return {
    writes,
    query: async (_schema, sql) => {
      if (/to_regclass/i.test(String(sql))) {
        return [{ regclass: tablePresent ? 'blog.comment_learning_events' : null }];
      }
      return [];
    },
    run: async (_schema, sql, params) => {
      writes.push({ sql: String(sql || ''), params });
      return { rowCount: 1 };
    },
  };
}

async function main() {
  const payload = buildCommentLearningEventPayload({
    source: 'own',
    commentId: 10,
    type: '질문',
    outcome: { success: true },
  });
  assert.equal(payload.strategyVersion, COMMENT_LEARNING_STRATEGY_VERSION);
  assert.equal(payload.source, 'own');
  assert.equal(payload.type, '질문');

  const missingPool = makePool({ tablePresent: false });
  const skipped = await recordCommentLearningEvent(payload, { pool: missingPool });
  assert.equal(skipped.skipped, true);
  assert.equal(missingPool.writes.length, 0);

  const presentPool = makePool({ tablePresent: true });
  const recorded = await recordCommentLearningEvent(payload, { pool: presentPool });
  assert.equal(recorded.ok, true);
  assert.equal(recorded.skipped, false);
  assert.equal(presentPool.writes.length, 1);

  assert.equal(deriveNeighborLearningType({ source_type: 'commenter_network' }), 'neighbor:commenter_network');

  const report = buildCommentStrategyReportFromRows({
    ownComments: [
      { status: 'replied', meta: { classification: { type: '기타' } } },
      { status: 'replied', meta: { classification: { type: '기타' } } },
      { status: 'skipped', meta: { classification: { type: '기타' } } },
      { status: 'replied', meta: { classification: { type: '질문' } } },
      { status: 'skipped', meta: { classification: { type: '질문' } } },
    ],
    neighborComments: [
      { status: 'posted', source_type: 'commenter_network', meta: {} },
      { status: 'skipped', source_type: 'commenter_network', meta: {} },
    ],
    actionRows: [],
  }, { weekKey: '2026-W27', minSamples: 2, maxOtherRatio: 0.25, minSuccessRate: 0.8 });
  assert.equal(report.shadowOnly, true);
  assert.equal(report.liveMutation, false);
  assert.ok(report.proposals.length >= 1);
  assert.ok(report.vaultContribution?.meta?.libraryCoords?.validation_state === 'unverified');

  const classifierTypes = Object.keys(COMMENT_TYPE_STRATEGIES).sort();
  assert.deepEqual(classifierTypes, ['감사', '공감', '기타', '스팸', '제안', '질문'].sort());

  console.log(JSON.stringify({
    ok: true,
    recordedWrites: presentPool.writes.length,
    proposals: report.proposals,
    classifierTypes,
  }, null, 2));
}

main().catch((error) => {
  console.error(error.stack || error.message || String(error));
  process.exit(1);
});
