#!/usr/bin/env node
'use strict';

const { requeueCourtesyReflectionCandidates } = require('../lib/commenter.ts');

function parseArgs(argv = []) {
  return {
    json: argv.includes('--json'),
    dryRun: argv.includes('--dry-run'),
    limit: (() => {
      const raw = argv.find((arg) => arg.startsWith('--limit='));
      return raw ? Number(raw.slice('--limit='.length)) : 5;
    })(),
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const result = await requeueCourtesyReflectionCandidates(args.limit, {
    dryRun: args.dryRun,
  });

  if (args.json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  console.log('[blog courtesy reply backfill]');
  console.log(`mode: ${result.dryRun ? 'dry-run' : 'apply'}`);
  console.log(`reviewed: ${result.reviewed}`);
  console.log(`requeued: ${result.requeuedCount}`);
  for (const item of result.candidates || []) {
    console.log(`- comment ${item.id} (${String(item.commenterName || 'unknown').slice(0, 24)}): ${String(item.reassessedReason || '').trim()}`);
  }
}

main().catch((error) => {
  console.error(error?.stack || error?.message || String(error));
  process.exit(1);
});
