// @ts-nocheck
'use strict';

const os = require('os');
const path = require('path');

const {
  buildSnapshot,
  persistSnapshotWithFallback,
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
  let snapshot = null;
  let snapshotError = null;
  let persisted = false;
  let finalOutputPath = outputPath;
  let fallbackUsed = false;

  try {
    snapshot = buildSnapshot(hours);
    const persistResult = persistSnapshotWithFallback(snapshot, outputPath);
    persisted = Boolean(persistResult.ok);
    if (!persistResult.ok) {
      throw persistResult.error;
    }
    finalOutputPath = persistResult.outputPath;
    fallbackUsed = Boolean(persistResult.fallbackUsed);
  } catch (error) {
    snapshotError = error?.stack || error?.message || String(error);
  }

  const review = buildReview(safeReadSnapshots(finalOutputPath), reviewDays, finalOutputPath);
  return {
    outputPath: finalOutputPath,
    requestedOutputPath: outputPath,
    snapshot,
    snapshotError,
    persisted,
    fallbackUsed,
    review,
  };
}

function printHuman(run) {
  const lines = [];
  lines.push('🤖 제이 gateway 일일 실험 실행');
  lines.push('');
  lines.push(`저장 파일: ${run.outputPath}`);
  if (run.snapshot) {
    lines.push(`기록 시각: ${run.snapshot.capturedAt}`);
    lines.push(`현재 단계: ${run.snapshot.experimentStage}`);
    lines.push(`정합성: ${run.snapshot.primaryCheck.aligned ? '일치' : '불일치'}`);
    lines.push(`최근 ${run.snapshot.observedHours}시간 rate limit: ${run.snapshot.gatewayMetrics.rateLimitCount}건 (활성 ${run.snapshot.gatewayMetrics.activeRateLimitCount}건)`);
  } else {
    lines.push('기록 시각: 이번 실행에서 새 스냅샷 저장 실패');
    lines.push(`실패 사유: ${run.snapshotError || '원인 확인 필요'}`);
  }
  lines.push(`스냅샷 저장: ${run.persisted ? '성공' : '실패'}`);
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
