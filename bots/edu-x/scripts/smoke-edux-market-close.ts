#!/usr/bin/env node
// @ts-nocheck
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const env = require('../../../packages/core/lib/env');
const {
  hasPublicMarketBriefDisclaimer,
} = require('../lib/edux-runtime-support.ts');

const EDUX_ROOT = path.join(env.PROJECT_ROOT, 'bots', 'edu-x');

function parseJsonFromStdout(stdout) {
  const starts = [];
  for (let i = 0; i < stdout.length; i += 1) {
    if (stdout[i] === '{') starts.push(i);
  }
  for (const start of starts) {
    try {
      return JSON.parse(stdout.slice(start));
    } catch {}
  }
  throw new Error(`JSON payload not found in stdout: ${stdout.slice(-800)}`);
}

function runRuntime(script, args = [], extraEnv = {}) {
  const stdout = execFileSync(process.execPath, [path.join(EDUX_ROOT, 'scripts', script), '--fixture', '--dry-run', '--json', ...args], {
    cwd: EDUX_ROOT,
    encoding: 'utf8',
    env: {
      ...process.env,
      EDUX_SKIP_DB: 'true',
      EDUX_DRY_RUN: 'true',
      EDUX_FORMATTER_FIXTURE: 'true',
      EDUX_DISABLE_TRADINGVIEW_READONLY: 'true',
      EDUX_DISABLE_TELEGRAM: 'true',
      ...extraEnv,
    },
    maxBuffer: 1024 * 1024 * 8,
  });
  return { stdout, result: parseJsonFromStdout(stdout) };
}

function readArtifact(result) {
  const mdPath = result.artifact?.mdPath;
  assert(mdPath, `dry-run result missing md artifact: ${JSON.stringify(result)}`);
  assert(mdPath.includes('/output/dry-run/fixture/'), `fixture dry-run must write fixture artifact: ${mdPath}`);
  return fs.readFileSync(mdPath, 'utf8');
}

function assertDryRun(result, category, slot) {
  assert.equal(result.ok, true, `${category}:${slot} should be ok`);
  assert.equal(result.status, 'dry_run', `${category}:${slot} should dry-run`);
  assert.equal(result.category, category, `${category}:${slot} category mismatch`);
  assert.equal(result.slot, slot, `${category}:${slot} slot mismatch`);
  assert.equal(result.quality?.ok, true, `${category}:${slot} quality failed: ${JSON.stringify(result.quality)}`);
  assert.equal((result.imagePaths || []).length, 0, `${category}:${slot} should be text-only`);
}

function assertPublicSafety(content, label) {
  assert.equal(hasPublicMarketBriefDisclaimer(content), true, `${label} missing public disclaimer`);
  assert.equal(/[①②③④⑤⑥⑦⑧⑨⑩]/.test(content), false, `${label} should not use legacy section numbers`);
  assert.equal(/<think>|Okay, let's|N\/A|데이터 없음|\[이미지/.test(content), false, `${label} contains forbidden placeholder/leak`);
}

function main() {
  const kisClose = runRuntime('runtime-edux-kis-daily.ts', ['--slot=1600'], { EDUX_TEST_NOW: '2026-06-12T07:00:00.000Z' }).result;
  assertDryRun(kisClose, 'kis', '1600');
  assert.equal(kisClose.quality.sectionCount, 6, 'TS-EX-1: kis close should have exactly 6 section blocks');
  const kisCloseMd = readArtifact(kisClose);
  assertPublicSafety(kisCloseMd, 'kis:1600');
  assert(kisCloseMd.includes('■ 마감 확정치'), 'TS-EX-1: kis close missing close value block');
  assert(kisCloseMd.includes('■ 09:00 예고 vs 실제'), 'TS-EX-1: kis close missing morning review block');
  assert(kisCloseMd.includes('💡 왜 중요한가:'), 'TS-EX-1: kis close missing why-it-matters');
  assert(kisCloseMd.includes('22:00 미국증시 장전'), 'TS-EX-1: kis close missing next slot preview');

  const overseasClose = runRuntime('runtime-edux-overseas-daily.ts', ['--slot=0630'], { EDUX_TEST_NOW: '2026-06-12T21:30:00.000Z' }).result;
  assertDryRun(overseasClose, 'overseas', '0630');
  assert.equal(overseasClose.status, 'dry_run', 'TS-EX-2: KST Saturday 0630 should publish Friday NY close');
  assert.equal(overseasClose.quality.sectionCount, 6, 'TS-EX-2: overseas close should have exactly 6 section blocks');
  const overseasCloseMd = readArtifact(overseasClose);
  assertPublicSafety(overseasCloseMd, 'overseas:0630');
  assert(overseasCloseMd.includes('■ 3대 지수 종가'), 'TS-EX-2: overseas close missing index close block');
  assert(overseasCloseMd.includes('■ Mag7 마감'), 'TS-EX-2: overseas close missing Mag7 block');
  assert(overseasCloseMd.includes('한국 시장 시사점'), 'TS-EX-2: overseas close missing Korea implication block');
  assert(overseasCloseMd.includes('한국장 관찰 포인트'), 'TS-EX-2: overseas close missing Korea watch block');
  assert(overseasCloseMd.includes('09:00 국내증시 장전'), 'TS-EX-2: overseas close missing next slot preview');

  const weekendSkip = runRuntime('runtime-edux-kis-daily.ts', ['--slot=1600'], { EDUX_TEST_NOW: '2026-06-13T07:00:00.000Z' }).result;
  assert.equal(weekendSkip.status, 'skipped_holiday', 'TS-EX-3: weekend close slot should skipped_holiday');
  const weekendKisOpenSkip = runRuntime('runtime-edux-kis-daily.ts', ['--slot=0900'], { EDUX_TEST_NOW: '2026-06-13T00:00:00.000Z' }).result;
  assert.equal(weekendKisOpenSkip.status, 'skipped_holiday', 'TS-EX-3: weekend kis preview slot should skipped_holiday');
  const weekendOverseasOpenSkip = runRuntime('runtime-edux-overseas-daily.ts', ['--slot=2200'], { EDUX_TEST_NOW: '2026-06-14T13:00:00.000Z' }).result;
  assert.equal(weekendOverseasOpenSkip.status, 'skipped_holiday', 'TS-EX-3: weekend overseas preview slot should skipped_holiday');
  const mondayKstOverseasCloseSkip = runRuntime('runtime-edux-overseas-daily.ts', ['--slot=0630'], { EDUX_TEST_NOW: '2026-06-14T21:30:00.000Z' }).result;
  assert.equal(mondayKstOverseasCloseSkip.status, 'skipped_holiday', 'TS-EX-3: KST Monday 0630 should skip because NY market date is Sunday');

  const legacyRuns = [
    ['runtime-edux-crypto-daily.ts', 'crypto', '0600'],
    ['runtime-edux-crypto-daily.ts', 'crypto', '1400'],
    ['runtime-edux-crypto-daily.ts', 'crypto', '2230'],
    ['runtime-edux-kis-daily.ts', 'kis', '0900', '2026-06-12T00:00:00.000Z'],
    ['runtime-edux-overseas-daily.ts', 'overseas', '2200', '2026-06-12T13:00:00.000Z'],
  ];
  for (const [script, category, slot, testNow] of legacyRuns) {
    const result = runRuntime(script, [`--slot=${slot}`], testNow ? { EDUX_TEST_NOW: testNow } : {}).result;
    assertDryRun(result, category, slot);
    assertPublicSafety(readArtifact(result), `${category}:${slot}`);
  }

  const kisOpen = runRuntime('runtime-edux-kis-daily.ts', ['--slot=0900'], { EDUX_TEST_NOW: '2026-06-12T00:00:00.000Z' }).result;
  assert(Array.isArray(kisOpen.watchPoints) && kisOpen.watchPoints.length > 0, 'TS-EX-5: kis 0900 should emit watchPoints');
  assert(Array.isArray(kisClose.previousWatchPoints) && kisClose.previousWatchPoints.length > 0, 'TS-EX-5: kis 1600 should consume previousWatchPoints');
  const overseasOpen = runRuntime('runtime-edux-overseas-daily.ts', ['--slot=2200'], { EDUX_TEST_NOW: '2026-06-12T13:00:00.000Z' }).result;
  assert(Array.isArray(overseasOpen.watchPoints) && overseasOpen.watchPoints.length > 0, 'TS-EX-5: overseas 2200 should emit watchPoints');
  assert(Array.isArray(overseasClose.previousWatchPoints) && overseasClose.previousWatchPoints.length > 0, 'TS-EX-5: overseas 0630 should consume previousWatchPoints');

  console.log(JSON.stringify({
    ok: true,
    assertions: ['TS-EX-1', 'TS-EX-2', 'TS-EX-3', 'TS-EX-4', 'TS-EX-5'],
    slots: ['0600', '0630', '0900', '1400', '1600', '2200', '2230'],
  }, null, 2));
}

if (require.main === module) {
  try {
    main();
  } catch (err) {
    console.error(err);
    process.exit(1);
  }
}
