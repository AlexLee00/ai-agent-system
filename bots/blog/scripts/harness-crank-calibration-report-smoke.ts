#!/usr/bin/env tsx

import assert from 'node:assert/strict';
import {
  buildHarnessCrankCalibrationReport,
  fetchHarnessCrankCalibrationRows,
  formatHarnessCrankCalibrationSummary,
} from './harness-crank-calibration-report.js';

const RULE_IDS = ['R1', 'R2', 'R3', 'R4', 'R5', 'R6'];

function fixtureRow(
  postId: number,
  postType: 'lecture' | 'general',
  crankTotal: number,
  failedRules: string[] = [],
) {
  return {
    post_id: postId,
    post_type: postType,
    crank_total: crankTotal,
    harness_report: {
      would_block: failedRules.length > 0,
      rules: RULE_IDS.map((id) => ({ id, passed: !failedRules.includes(id) })),
    },
  };
}

async function main() {
  const rows = [
    fixtureRow(1, 'general', 74, ['R5']),
    fixtureRow(2, 'general', 72, ['R5']),
    fixtureRow(3, 'general', 60),
    fixtureRow(4, 'general', 62),
    fixtureRow(5, 'lecture', 70, ['R5']),
    fixtureRow(6, 'lecture', 68, ['R5']),
    fixtureRow(7, 'lecture', 66),
    fixtureRow(8, 'lecture', 64),
  ];

  const report = buildHarnessCrankCalibrationReport(rows, {
    minSamplesPerSide: 2,
    minAbsoluteDelta: 1.5,
    generatedAt: '2026-07-11T00:00:00.000Z',
  });
  assert.equal(report.total_samples, 8);
  assert.equal(report.harness_reports_seen, 8);
  assert.equal(report.pending_score_count, 0);
  assert.equal(report.scopes.general.sample_size, 4);
  assert.equal(report.scopes.pos.sample_size, 4);
  assert.equal(report.scopes.all.would_block.blocked.average, 71);
  assert.equal(report.scopes.all.would_block.clear.average, 63);
  assert.equal(report.scopes.all.rules.R5.delta, 8);
  assert.equal(report.scopes.all.rules.R5.status, 'relax_candidate');
  assert.equal(report.scopes.all.rules.R1.status, 'insufficient');
  assert.equal(report.scopes.general.rules.R5.status, 'relax_candidate');
  assert.equal(report.scopes.pos.rules.R5.status, 'relax_candidate');
  assert(report.recommendations.some((item) => item.scope === 'all' && item.rule === 'R5'));

  const pending = { ...fixtureRow(9, 'general', 0, ['R5']), crank_total: null };
  const withPending = buildHarnessCrankCalibrationReport([...rows, pending]);
  assert.equal(withPending.harness_reports_seen, 9);
  assert.equal(withPending.total_samples, 8);
  assert.equal(withPending.pending_score_count, 1);

  const empty = buildHarnessCrankCalibrationReport([], { minSamplesPerSide: 5 });
  assert.equal(empty.total_samples, 0);
  assert.equal(empty.scopes.all.rules.R5.status, 'insufficient');

  let queryCalls = 0;
  const fetched = await fetchHarnessCrankCalibrationRows({
    days: 90,
    limit: 100,
    pool: {
      queryReadonly: async (schema, sql, params) => {
        queryCalls += 1;
        assert.equal(schema, 'blog');
        assert.match(sql, /^\s*WITH latest_scores AS/i);
        assert.match(sql, /metadata->'harness_report'/);
        assert.doesNotMatch(sql, /\b(INSERT|UPDATE|DELETE|CREATE|ALTER|DROP)\b/i);
        assert.deepEqual(params, ['90', 100, 0, 2_147_483_647]);
        return rows;
      },
    },
  });
  assert.equal(queryCalls, 1);
  assert.equal(fetched.length, rows.length);

  const summary = formatHarnessCrankCalibrationSummary(report);
  assert.match(summary, /R5/);
  assert.match(summary, /완화 후보/);
  assert.match(summary, /insufficient/);

  console.log('harness-crank-calibration-report-smoke ok');
}

main().catch((error) => {
  console.error(error?.stack || error?.message || String(error));
  process.exit(1);
});
