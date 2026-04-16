#!/usr/bin/env node
'use strict';

const path = require('path');
const env = require('../../../packages/core/lib/env');
const { backfillRecentGeneralTitleAlignment } = require(path.join(env.PROJECT_ROOT, 'bots/blog/lib/marketing-digest.ts'));

function parseArgs(argv = []) {
  const args = {
    json: argv.includes('--json'),
    dryRun: argv.includes('--dry-run'),
    limit: 10,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === '--limit') {
      args.limit = Math.max(1, Number(argv[i + 1] || 10));
    }
  }

  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const result = await backfillRecentGeneralTitleAlignment({
    dryRun: args.dryRun,
    limit: args.limit,
  });

  if (args.json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  console.log(`[title-alignment backfill] scanned=${result.scanned} inferred=${result.inferred} updated=${result.updated} source=${result.source} dryRun=${result.dryRun}`);
  if (result.sourceReason) {
    console.log(`  fallback: ${String(result.sourceReason).slice(0, 160)}`);
  }
  for (const item of result.items.slice(0, 10)) {
    const suffix = item.titleOverlap !== undefined ? ` overlap=${item.titleOverlap}` : '';
    console.log(`- #${item.postId || 'n/a'} [${item.category || 'unknown'}] ${item.status}${suffix} ${item.title || ''}`);
  }
}

main().catch((error) => {
  console.error('[title-alignment backfill] 실패:', error?.message || error);
  process.exit(1);
});
