#!/usr/bin/env tsx
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { analyzeLoadTest } = require('../../../tests/load/analyze-results.ts');

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function writeK6Fixture(resultsDir: string, scenario: string): void {
  const rows = [
    { type: 'Point', metric: 'http_req_duration', data: { value: 100 } },
    { type: 'Point', metric: 'http_req_duration', data: { value: 200 } },
    { type: 'Point', metric: 'http_req_failed', data: { value: 0 } },
    { type: 'Point', metric: 'http_req_failed', data: { value: 0 } },
  ];
  fs.writeFileSync(
    path.join(resultsDir, `${scenario}.json`),
    `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`,
    'utf8',
  );
}

async function main() {
  const resultsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'load-test-skip-chaos-'));
  try {
    for (const scenario of ['baseline', 'peak', 'multi-team']) {
      writeK6Fixture(resultsDir, scenario);
    }

    const result = await analyzeLoadTest(resultsDir, {
      skippedScenarios: ['chaos'],
      persist: false,
      sendReport: false,
    });

    assert(result.skipped.includes('chaos'), 'chaos must be reported as skipped');
    assert(!result.missing.includes('chaos'), 'skipped chaos must not be reported as missing');
    assert(result.message.includes('ℹ️ 건너뜀: chaos'), 'report must show chaos as skipped');
    assert(!result.message.includes('⚠️ 결과 파일 없음: chaos'), 'report must not warn for skipped chaos');
    assert(Object.keys(result.summary).length === 3, 'expected three executed scenario summaries');

    console.log('load_test_skip_chaos_smoke_ok');
  } finally {
    fs.rmSync(resultsDir, { recursive: true, force: true });
  }
}

main().catch((error: any) => {
  console.error('[load-test-skip-chaos-smoke] failed:', error?.message || error);
  process.exit(1);
});
