// @ts-nocheck
'use strict';

const path = require('path');
const { spawnSync } = require('child_process');
const { buildReview } = require('./llm-selector-speed-review.js');

const SPEED_TEST_SCRIPT = path.join(__dirname, '..', 'speed-test.js');
const DEFAULT_DAYS = 7;

function parseArgs(argv = process.argv.slice(2)) {
  const daysArg = argv.find((arg) => arg.startsWith('--days='));
  return {
    days: Math.max(1, Number(daysArg?.split('=')[1] || DEFAULT_DAYS)),
    json: argv.includes('--json'),
    skipTest: argv.includes('--skip-test'),
  };
}

function runSpeedTest() {
  const result = spawnSync(process.execPath, [SPEED_TEST_SCRIPT], {
    cwd: path.join(__dirname, '..', '..'),
    env: { ...process.env, FORCE_COLOR: '0' },
    encoding: 'utf8',
  });

  const stdout = result.stdout || '';
  const stderr = result.stderr || '';
  const failureDetail = stderr.trim()
    || stdout.split('\n').map((line) => line.trim()).filter(Boolean).reverse()
      .find((line) => line.includes('❌') || line.includes('실패'))
    || '';

  return {
    status: result.status,
    ok: result.status === 0,
    stdout,
    stderr,
    failureDetail,
  };
}

function buildRun({ days, skipTest }) {
  const speedTest = skipTest ? {
    ok: true,
    skipped: true,
    status: 0,
    stdout: '',
    stderr: '',
    failureDetail: '',
  } : runSpeedTest();

  const review = buildReview(undefined, days);
  return {
    executedAt: new Date().toISOString(),
    speedTest,
    review,
  };
}

function printHuman(run) {
  const lines = [];
  lines.push('⚡ LLM selector speed 일일 실행');
  lines.push('');
  if (run.speedTest.skipped) {
    lines.push('speed-test: skip');
  } else {
    lines.push(`speed-test: ${run.speedTest.ok ? 'ok' : 'failed'} (status ${run.speedTest.status})`);
  }
  lines.push(`review period: ${run.review.days}일`);
  lines.push(`snapshot count: ${run.review.snapshotCount}`);
  lines.push(`current: ${run.review.currentPrimary || '-'}`);
  lines.push(`recommended: ${run.review.latestRecommended || '-'}`);
  lines.push(`recommendation: ${run.review.recommendation}`);
  if (run.review.topModels.length) {
    lines.push('');
    lines.push('top models:');
    for (const item of run.review.topModels.slice(0, 3)) {
      lines.push(`- ${item.modelId} | ttft ${item.avgTtft ?? '-'}ms | total ${item.avgTotal ?? '-'}ms | success ${item.successRatePct}%`);
    }
  }
  if (!run.speedTest.ok && run.speedTest.stderr) {
    lines.push('');
    lines.push(`speed-test error: ${run.speedTest.stderr.trim()}`);
  } else if (!run.speedTest.ok && run.speedTest.failureDetail) {
    lines.push('');
    lines.push(`speed-test error: ${run.speedTest.failureDetail}`);
  }
  return lines.join('\n');
}

function main() {
  const args = parseArgs();
  const run = buildRun(args);
  if (args.json) {
    process.stdout.write(`${JSON.stringify(run, null, 2)}\n`);
    return;
  }
  process.stdout.write(`${printHuman(run)}\n`);
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`❌ llm-selector-speed-daily 실패: ${error?.stack || error?.message || String(error)}\n`);
    process.exit(1);
  }
}

module.exports = {
  parseArgs,
  buildRun,
  printHuman,
};
