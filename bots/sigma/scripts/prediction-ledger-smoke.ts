#!/usr/bin/env node
// @ts-nocheck

import assert from 'node:assert/strict';
import { buildRuntimePredictionLedgerReport } from './sigma-prediction-ledger-report.ts';

async function main() {
  const rows = [
    { id: 'f1', title: 'forward', meta: { libraryCoords: { prediction_state: 'forward', validation_state: 'observed' } } },
    { id: 'd1', title: 'due', meta: { libraryCoords: { prediction_state: 'due', validation_state: 'observed', prediction_horizon: '2026-07-02T00:00:00.000Z' } } },
    { id: 'v1', title: 'validated', meta: { libraryCoords: { prediction_state: 'resolved', validation_state: 'validated' } } },
    { id: 'c1', title: 'contradicted', meta: { libraryCoords: { prediction_state: 'resolved', validation_state: 'contradicted' } } },
  ];
  const calls = [];
  const report = await buildRuntimePredictionLedgerReport({
    limit: 10,
    now: new Date('2026-07-03T00:00:00.000Z'),
    queryReadonly: async (schema, sql, params = []) => {
      calls.push({ schema, sql, params });
      assert.equal(schema, 'sigma');
      assert.match(String(sql).trim(), /^SELECT/i);
      assert.equal(/\b(INSERT|UPDATE|DELETE|ALTER|CREATE|DROP|TRUNCATE)\b/i.test(sql), false);
      if (String(sql).includes('information_schema.columns')) return [];
      return rows;
    },
  });
  assert.equal(report.dryRun, true);
  assert.equal(report.liveMutation, false);
  assert.equal(report.counts.forward, 1);
  assert.equal(report.counts.due, 1);
  assert.equal(report.counts.validated, 1);
  assert.equal(report.counts.contradicted, 1);
  assert.equal(report.accuracy, 0.5);
  assert.ok(calls.length >= 2);

  console.log(JSON.stringify({ ok: true, smoke: 'sigma-prediction-ledger', checks: 9 }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
