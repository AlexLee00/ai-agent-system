#!/usr/bin/env node
// @ts-nocheck

import assert from 'node:assert/strict';
import {
  buildDreamingClusters,
  buildDreamingLitePlan,
  isDreamingDigestCandidate,
} from './sigma-dreaming-lite.ts';

async function main() {
  const rows = [
    {
      id: 'c1',
      title: 'blog_comment thanks',
      type: 'blog_comment',
      source: 'blo',
      file_path: 'library/blo/comment/1',
      content: '좋은 글입니다. 다음 글도 기대합니다.',
      meta: { libraryCoords: { abstraction_level: 'L0', time_stage: 'raw', validation_state: 'unverified', prediction_state: 'none' } },
    },
    {
      id: 'c2',
      title: 'blog_comment thanks duplicate',
      type: 'blog_comment',
      source: 'blo',
      file_path: 'library/blo/comment/2',
      content: '좋은 글입니다 다음 글도 기대합니다',
      meta: { libraryCoords: { abstraction_level: 'L0', time_stage: 'raw', validation_state: 'unverified', prediction_state: 'none' } },
    },
    {
      id: 'w1',
      title: 'luna_review high value',
      type: 'luna_review',
      source: 'luna_review',
      content: 'risk gate evidence',
      meta: { libraryCoords: { abstraction_level: 'L0', time_stage: 'raw', validation_state: 'observed', prediction_state: 'none' } },
    },
  ];

  assert.equal(isDreamingDigestCandidate(rows[0]), true);
  assert.equal(isDreamingDigestCandidate(rows[2]), false);
  const clusters = buildDreamingClusters(rows, { maxDigests: 10 });
  assert.equal(clusters.length, 1);
  assert.deepEqual(clusters[0].sourceEntryIds.sort(), ['c1', 'c2']);

  const plan = buildDreamingLitePlan({
    candidateRows: rows,
    decayRows: [{ id: 'old-1', title: 'old raw' }],
    dueRows: [{ id: 'p-1', title: 'forward due', prediction_horizon: '2026-07-02T00:00:00.000Z' }],
    date: '2026-07-03',
  });
  assert.equal(plan.digestPlans.length, 1);
  assert.equal(plan.digestPlans[0].libraryCoords.time_stage, 'digest');
  assert.match(plan.digestPlans[0].filePath, /^library\/sigma\/dreaming\/2026-07-03\/dream-[a-f0-9]{12}\.md$/);
  assert.equal(plan.decayPlans[0].nextTimeStage, 'dormant');
  assert.equal(plan.duePlans[0].nextPredictionState, 'due');
  assert.match(plan.digestPlans[0].content, /vault-entry:c1/);

  console.log(JSON.stringify({ ok: true, smoke: 'sigma-dreaming-lite', checks: 8 }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
