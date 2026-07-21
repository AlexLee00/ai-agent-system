#!/usr/bin/env tsx

const assert = require('node:assert/strict');
const {
  CONTENT_HARNESS_CALIBRATION,
  classifyHarnessWouldBlock,
  evaluateHarnessR5,
} = require('../lib/content-harness.ts');
const { _testOnly: formatTest } = require('../lib/blog-format-rules.ts');
const {
  buildHarnessCrankCalibrationReport,
} = require('./harness-crank-calibration-report.ts');

const RULE_IDS = ['R1', 'R2', 'R3', 'R4', 'R5', 'R6'];

type BaselineFixture = {
  id: number;
  postType: 'lecture' | 'general';
  crank: number | null;
  legacyFailures: string[];
  calibratedFailures: string[];
};

const BASELINE: BaselineFixture[] = [
  { id: 311, postType: 'lecture', crank: 63, legacyFailures: ['R1', 'R5'], calibratedFailures: ['R1'] },
  { id: 312, postType: 'general', crank: 62, legacyFailures: ['R5'], calibratedFailures: [] },
  { id: 313, postType: 'lecture', crank: 78, legacyFailures: ['R1', 'R5'], calibratedFailures: ['R1'] },
  { id: 314, postType: 'general', crank: 63, legacyFailures: ['R5'], calibratedFailures: [] },
  { id: 315, postType: 'lecture', crank: 69, legacyFailures: ['R5', 'R6'], calibratedFailures: ['R6'] },
  { id: 316, postType: 'general', crank: 56, legacyFailures: ['R5'], calibratedFailures: [] },
  { id: 317, postType: 'lecture', crank: 69, legacyFailures: ['R5'], calibratedFailures: [] },
  { id: 318, postType: 'general', crank: 56, legacyFailures: ['R5'], calibratedFailures: [] },
  { id: 319, postType: 'lecture', crank: 63, legacyFailures: ['R5'], calibratedFailures: [] },
  { id: 320, postType: 'general', crank: 69, legacyFailures: ['R5'], calibratedFailures: [] },
  { id: 321, postType: 'lecture', crank: null, legacyFailures: ['R1', 'R5'], calibratedFailures: ['R1'] },
  { id: 322, postType: 'general', crank: null, legacyFailures: ['R5'], calibratedFailures: [] },
  { id: 323, postType: 'general', crank: 73, legacyFailures: ['R5'], calibratedFailures: [] },
  { id: 324, postType: 'lecture', crank: null, legacyFailures: ['R5'], calibratedFailures: [] },
  { id: 325, postType: 'general', crank: null, legacyFailures: ['R5'], calibratedFailures: [] },
  { id: 326, postType: 'lecture', crank: null, legacyFailures: ['R5'], calibratedFailures: [] },
  { id: 327, postType: 'general', crank: null, legacyFailures: ['R5'], calibratedFailures: ['R5'] },
  { id: 328, postType: 'lecture', crank: null, legacyFailures: ['R5'], calibratedFailures: [] },
  { id: 329, postType: 'general', crank: null, legacyFailures: ['R5'], calibratedFailures: [] },
  { id: 330, postType: 'lecture', crank: null, legacyFailures: ['R5'], calibratedFailures: [] },
  { id: 331, postType: 'general', crank: null, legacyFailures: ['R4', 'R5'], calibratedFailures: ['R4', 'R5'] },
];

function harnessReport(failures: string[], calibrated = false) {
  const rules = RULE_IDS.map((id) => ({ id, name: id, passed: !failures.includes(id) }));
  return {
    version: calibrated ? CONTENT_HARNESS_CALIBRATION.version : 'r1-r6-v1',
    would_block: calibrated
      ? classifyHarnessWouldBlock(rules)
      : failures.length > 0,
    rules,
  };
}

function main() {
  assert.equal(CONTENT_HARNESS_CALIBRATION.minNoncriticalViolations, 2);
  assert.deepEqual(CONTENT_HARNESS_CALIBRATION.criticalRules, ['R6']);
  const longParagraph = '첫 문장은 실제 운영 사례의 배경을 구체적으로 설명합니다. 둘째 문장은 관찰한 실패 원인을 숫자와 함께 기록합니다. 셋째 문장은 수정한 설정과 검증 절차를 순서대로 정리합니다. 넷째 문장은 재실행 결과와 남은 한계를 분명히 남깁니다.';
  assert.equal(formatTest.countLongParagraphs(Array(7).fill(longParagraph).join('\n\n'), 3), 7);
  assert.equal(evaluateHarnessR5({
    char_count: 6000,
    minimum_chars: 3000,
    intro_lines: 1,
    body_headings: 6,
    minimum_body_headings: 3,
    long_paragraphs_total: 4,
  }, 'general').passed, false);
  assert.equal(evaluateHarnessR5({
    char_count: 14000,
    minimum_chars: 8000,
    intro_lines: 1,
    body_headings: 10,
    minimum_body_headings: 3,
    long_paragraphs_total: 26,
  }, 'lecture').passed, true);

  const rows = BASELINE.map((row) => ({
    post_id: row.id,
    post_type: row.postType,
    crank_total: row.crank,
    harness_report: harnessReport(row.legacyFailures),
    calibrated_harness_report: harnessReport(row.calibratedFailures, true),
  }));
  const report = buildHarnessCrankCalibrationReport(rows, {
    generatedAt: '2026-07-21T00:00:00.000Z',
    minPostId: 311,
    maxPostId: 331,
  });

  assert.equal(report.harness_reports_seen, 21);
  assert.equal(report.total_samples, 11);
  assert.equal(report.pending_score_count, 10);
  assert.equal(report.scopes.all.would_block.blocked.count, 11);
  assert.equal(report.scopes.all.would_block.blocked.average, 65.55);
  assert.deepEqual(report.calibration.cohort, { min_post_id: 311, max_post_id: 331 });
  assert.equal(report.calibration.legacy_r5_passed, 0);
  assert.equal(report.calibration.calibrated_r5_passed, 19);

  const thresholds = report.calibration.scopes.all.thresholds;
  assert.equal(thresholds.find((item: { min_noncritical_violations: number }) => item.min_noncritical_violations === 1).blocked_count, 6);
  assert.equal(thresholds.find((item: { min_noncritical_violations: number }) => item.min_noncritical_violations === 2).blocked_count, 2);
  assert.equal(thresholds.find((item: { min_noncritical_violations: number }) => item.min_noncritical_violations === 3).blocked_count, 1);
  assert.equal(report.calibration.scopes.all.selected.blocked_count, 2);
  assert.equal(report.calibration.scopes.all.selected.blocked_rate, 9.52);
  assert.equal(report.calibration.scopes.all.selected.blocked_crank.average, 69);
  assert.equal(report.calibration.scopes.all.selected.clear_crank.average, 65.2);
  assert.equal(report.calibration.scopes.pos.selected.blocked_count, 1);
  assert.equal(report.calibration.scopes.general.selected.blocked_count, 1);
  assert.equal(report.calibration.causal_claim, false);

  console.log(JSON.stringify({
    ok: true,
    suite: 'harness-crank-calibration',
    baseline: {
      reports: report.harness_reports_seen,
      scored: report.total_samples,
      legacyBlocked: report.scopes.all.would_block.blocked.count,
      legacyCrank: report.scopes.all.would_block.blocked,
    },
    calibration: report.calibration,
  }, null, 2));
}

main();
