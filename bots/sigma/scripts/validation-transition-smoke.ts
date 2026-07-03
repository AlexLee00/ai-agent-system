#!/usr/bin/env node
// @ts-nocheck

import assert from 'node:assert/strict';
import {
  buildPredictionLedgerReport,
  buildValidationTransitionPlan,
} from '../vault/validation-transition.ts';

async function main() {
  const dueRows = [
    {
      id: 'p-validated',
      title: 'Luna win prediction',
      content: '다음 주 Luna signal will succeed.',
      meta: {
        libraryCoords: { abstraction_level: 'L0', time_stage: 'raw', validation_state: 'observed', prediction_state: 'due' },
        evidenceLinks: ['vault-entry:e1'],
      },
    },
    {
      id: 'p-contradicted',
      title: 'Hub mode prediction',
      content: 'hub.mode is enabled',
      meta: {
        libraryCoords: { abstraction_level: 'L0', time_stage: 'raw', validation_state: 'observed', prediction_state: 'due' },
        evidenceLinks: ['vault-entry:e2'],
      },
    },
    {
      id: 'p-empty',
      title: 'No evidence prediction',
      content: 'No evidence link here.',
      meta: {
        libraryCoords: { abstraction_level: 'L0', time_stage: 'raw', validation_state: 'observed', prediction_state: 'due' },
      },
    },
  ];
  const evidenceRows = [
    { id: 'e1', title: 'success evidence', content: 'vault-entry:p-validated success confirmed and observed true', meta: {} },
    { id: 'e2', title: 'failed evidence', content: 'vault-entry:p-contradicted failed and contradicted by later report', meta: {} },
  ];
  const wikiHealth = {
    contradictions: [{ subject: 'hub.mode', evidence: [] }],
  };
  const plan = buildValidationTransitionPlan({ dueRows, evidenceRows, wikiHealth });
  const byId = new Map(plan.map((item) => [item.id, item]));
  assert.equal(byId.get('p-validated').decision, 'validated');
  assert.equal(byId.get('p-validated').nextCoords.prediction_state, 'resolved');
  assert.equal(byId.get('p-contradicted').decision, 'contradicted');
  assert.equal(byId.get('p-empty').decision, 'insufficient_evidence');
  assert.equal(byId.get('p-empty').apply, false);

  const ledger = buildPredictionLedgerReport({
    now: new Date('2026-07-03T00:00:00.000Z'),
    rows: [
      ...dueRows,
      { id: 'r1', title: 'resolved ok', meta: { libraryCoords: { prediction_state: 'resolved', validation_state: 'validated' } } },
      { id: 'r2', title: 'resolved bad', meta: { libraryCoords: { prediction_state: 'resolved', validation_state: 'contradicted' } } },
    ],
  });
  assert.equal(ledger.counts.due, 3);
  assert.equal(ledger.counts.resolved, 2);
  assert.equal(ledger.accuracy, 0.5);
  assert.equal(ledger.liveMutation ?? false, false);

  console.log(JSON.stringify({ ok: true, smoke: 'sigma-validation-transition', checks: 9 }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
