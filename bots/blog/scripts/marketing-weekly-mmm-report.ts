#!/usr/bin/env node
// @ts-nocheck
'use strict';

const fs = require('fs');
const path = require('path');
const env = require('../../../packages/core/lib/env');
const { buildMarketingDigest } = require(path.join(env.PROJECT_ROOT, 'bots/blog/lib/marketing-digest.ts'));
const {
  buildWeeklyMmmReport,
  formatWeeklyMmmMarkdown,
} = require(path.join(env.PROJECT_ROOT, 'bots/blog/lib/omnichannel/marketing-mmm-report.ts'));

const args = process.argv.slice(2);
const json = args.includes('--json');
const dryRun = args.includes('--dry-run');
const windowArg = args.find((arg) => arg.startsWith('--window-days='));
const windowDays = windowArg ? Number(windowArg.split('=')[1] || 7) : 7;
const OUTPUT_DIR = path.join(env.PROJECT_ROOT, 'bots/blog/output/marketing');
const JSON_PATH = path.join(OUTPUT_DIR, 'weekly-mmm-report.json');
const MD_PATH = path.join(OUTPUT_DIR, 'weekly-mmm-report.md');

function formatCliSummary(report = {}) {
  const top = Array.isArray(report.channels) ? report.channels[0] : null;
  return [
    '📈 Blog Weekly MMM-Lite',
    `confidence: ${report.confidenceLabel || 'unknown'} (${report.confidence ?? 0})`,
    `decayMultiplier: ${report.decayMultiplier ?? 1}`,
    top ? `topChannel: ${top.channel} score=${top.contributionScore}` : 'topChannel: none',
    `recommendation: ${(report.recommendations || [])[0] || 'none'}`,
    dryRun ? 'mode: dry-run (no files written)' : `written: ${JSON_PATH}`,
  ].join('\n');
}

function writeReport(report) {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  fs.writeFileSync(JSON_PATH, `${JSON.stringify(report, null, 2)}\n`);
  fs.writeFileSync(MD_PATH, formatWeeklyMmmMarkdown(report));
}

async function main() {
  const digest = await buildMarketingDigest({
    channelWindow: windowDays,
    snapshotWindow: windowDays,
  });
  const report = buildWeeklyMmmReport(digest, { windowDays });
  if (!dryRun) {
    writeReport(report);
  }

  if (json) {
    console.log(JSON.stringify({
      ok: true,
      dryRun,
      output: dryRun ? null : { json: JSON_PATH, markdown: MD_PATH },
      report,
    }, null, 2));
    return;
  }

  console.log(formatCliSummary(report));
}

main().catch((error) => {
  console.error('[marketing-weekly-mmm-report] 실패:', error.message);
  process.exit(1);
});
