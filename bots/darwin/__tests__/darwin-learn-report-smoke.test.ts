'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const learn = require('../lib/learn-report.ts');

function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'darwin-learn-report-'));
  const learningsPath = path.join(tmp, 'learnings.md');
  fs.writeFileSync(learningsPath, [
    '2026-07-04 | proposal=a | reason=predicate_failed | details=x',
    '2026-07-04 | proposal=b | reason=timeout | details=y',
    '2026-06-01 | proposal=old | reason=old | details=z',
  ].join('\n'), 'utf8');

  try {
    const report = learn.collectLearnReport({
      now: '2026-07-05T00:00:00.000Z',
      sinceDays: 7,
      learningsPath,
      keywordEvolutionCount: 4,
      proposals: [
        { id: 'm1', status: 'measured', measurement: { predicate_results: [{ ok: true }, { ok: false }] } },
        { id: 'a1', status: 'adopted', measurement: { predicate_results: [{ ok: true }] } },
        { id: 'x1', status: 'archived' },
      ],
    });
    assert.strictEqual(report.newLearningLines, 2);
    assert.strictEqual(report.topReasons[0].count, 1);
    assert.strictEqual(report.proposalStats.measured, 1);
    assert.strictEqual(report.proposalStats.adopted, 1);
    assert.strictEqual(report.proposalStats.archived, 1);
    assert.strictEqual(report.proposalStats.predicatePassed, 2);
    assert.strictEqual(report.proposalStats.predicateFailed, 1);
    assert.strictEqual(report.proposalStats.predicatePassRate, 66.7);
    assert.strictEqual(report.keywordEvolutionCount, 4);
    assert.match(learn.formatLearnReportBlock(report), /LEARN/);
    console.log('✅ darwin learn report smoke ok');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

main();
