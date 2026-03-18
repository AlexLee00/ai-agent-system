#!/usr/bin/env node
'use strict';

const os = require('os');
const path = require('path');

const {
  buildSnapshot,
  persistSnapshot,
} = require('../../bots/orchestrator/scripts/log-jay-gateway-experiment.js');
const {
  safeReadSnapshots,
  buildReview,
  printHuman: printReviewHuman,
} = require('./jay-gateway-experiment-review.js');

const DEFAULT_HOURS = 24;
const DEFAULT_REVIEW_DAYS = 7;

function parseArgs(argv = process.argv.slice(2)) {
  const hoursArg = argv.find((arg) => arg.startsWith('--hours='));
  const daysArg = argv.find((arg) => arg.startsWith('--days='));
  const outputArg = argv.find((arg) => arg.startsWith('--output='));
  return {
    hours: Math.max(1, Number(hoursArg?.split('=')[1] || DEFAULT_HOURS)),
    reviewDays: Math.max(1, Number(daysArg?.split('=')[1] || DEFAULT_REVIEW_DAYS)),
    outputPath: outputArg?.split('=').slice(1).join('=') || path.join(os.homedir(), '.openclaw', 'workspace', 'jay-gateway-experiments.jsonl'),
    json: argv.includes('--json'),
  };
}

function buildRun({ hours, reviewDays, outputPath }) {
  const snapshot = buildSnapshot(hours);
  persistSnapshot(snapshot, outputPath);
  const review = buildReview(safeReadSnapshots(outputPath), reviewDays, outputPath);
  return {
    outputPath,
    snapshot,
    review,
  };
}

function printHuman(run) {
  const lines = [];
  lines.push('🤖 제이 gateway 일일 실험 실행');
  lines.push('');
  lines.push(`저장 파일: ${run.outputPath}`);
  lines.push(`기록 시각: ${run.snapshot.capturedAt}`);
  lines.push(`현재 단계: ${run.snapshot.experimentStage}`);
  lines.push(`정합성: ${run.snapshot.primaryCheck.aligned ? '일치' : '불일치'}`);
  lines.push(`최근 ${run.snapshot.observedHours}시간 rate limit: ${run.snapshot.gatewayMetrics.rateLimitCount}건 (활성 ${run.snapshot.gatewayMetrics.activeRateLimitCount}건)`);
  lines.push('');
  lines.push(printReviewHuman(run.review));
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
    process.stderr.write(`❌ jay-gateway-experiment-daily 실패: ${error?.stack || error?.message || String(error)}\n`);
    process.exit(1);
  }
}

module.exports = {
  parseArgs,
  buildRun,
  printHuman,
};
