#!/usr/bin/env node
'use strict';

const { ensureSchema, collectNeighborCandidates, runNeighborCommenter } = require('../lib/commenter.ts');

async function main() {
  const testMode = process.argv.includes('--test-mode') || process.env.BLOG_COMMENTER_TEST === 'true';
  const json = process.argv.includes('--json');
  const collectOnly = process.argv.includes('--collect-only');
  const result = collectOnly
    ? (await ensureSchema(), { ok: true, collectOnly: true, candidates: await collectNeighborCandidates({ testMode }) })
    : await runNeighborCommenter({ testMode });

  if (json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (result.skipped) {
    console.log(`SKIPPED: ${result.reason}`);
    return;
  }

  console.log(`detected=${result.detected} pending=${result.pending} posted=${result.posted} failed=${result.failed} skipped=${result.skipped}`);
}

main().catch((error) => {
  console.error(`❌ ${error?.stack || error?.message || String(error)}`);
  process.exit(1);
});
