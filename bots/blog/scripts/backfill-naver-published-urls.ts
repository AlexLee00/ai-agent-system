#!/usr/bin/env node
'use strict';

const { backfillNaverPublishedUrls } = require('../lib/naver-url-backfill.ts');
const { writeNaverUrlBackfillTelemetry } = require('../lib/naver-url-backfill-telemetry.ts');

function parseArgs(argv = process.argv.slice(2)) {
  const get = (name) => argv.find((arg) => arg.startsWith(`--${name}=`))?.split('=').slice(1).join('=');
  return {
    days: Number(get('days') || 14),
    limit: Number(get('limit') || 20),
    postId: get('post-id') ? Number(get('post-id')) : null,
    write: argv.includes('--write'),
    json: argv.includes('--json'),
    minConfidence: Number(get('min-confidence') || 0.9),
  };
}

async function main() {
  const args = parseArgs();
  const startedAt = new Date().toISOString();
  try {
    const result = await backfillNaverPublishedUrls(args);
    writeNaverUrlBackfillTelemetry({
      checkedAt: new Date().toISOString(),
      startedAt,
      ok: true,
      dryRun: result?.dryRun !== false,
      scanned: Number(result?.scanned || 0),
      matched: Number(result?.matched || 0),
      unmatched: Number(result?.unmatched || 0),
      skippedLowConfidence: Number(result?.skippedLowConfidence || 0),
      minConfidence: Number(result?.minConfidence || 0.9),
      blogId: String(result?.blogId || ''),
      rssSourceUrl: String(result?.rssSourceUrl || ''),
      applied: result?.dryRun === false
        ? Number(result?.matched || 0) - Number(result?.skippedLowConfidence || 0)
        : 0,
      unmatchedRows: Array.isArray(result?.unmatchedRows) ? result.unmatchedRows.slice(0, 5) : [],
      matches: Array.isArray(result?.matches) ? result.matches.slice(0, 5) : [],
    });
    if (args.json) {
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      return;
    }
    process.stdout.write(`${result}\n`);
  } catch (error) {
    writeNaverUrlBackfillTelemetry({
      checkedAt: new Date().toISOString(),
      startedAt,
      ok: false,
      dryRun: !args.write,
      scanned: 0,
      matched: 0,
      unmatched: 0,
      skippedLowConfidence: 0,
      minConfidence: Number(args.minConfidence || 0.9),
      error: String(error?.message || error || 'unknown_error'),
    });
    throw error;
  }
}

main().catch((error) => {
  process.stderr.write(`❌ naver url backfill 실패: ${error?.stack || error?.message || String(error)}\n`);
  process.exit(1);
});
