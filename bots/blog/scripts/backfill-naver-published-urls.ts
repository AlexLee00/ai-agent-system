#!/usr/bin/env node
'use strict';

const { backfillNaverPublishedUrls } = require('../lib/naver-url-backfill.ts');

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
  const result = await backfillNaverPublishedUrls(args);
  if (args.json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }
  process.stdout.write(`${result}\n`);
}

main().catch((error) => {
  process.stderr.write(`❌ naver url backfill 실패: ${error?.stack || error?.message || String(error)}\n`);
  process.exit(1);
});
