#!/usr/bin/env node
'use strict';

const { runNeighborSympathy } = require('../lib/commenter.ts');
const { acquireEngagementLock, releaseEngagementLock } = require('../lib/engagement-process-lock.ts');

async function main() {
  const testMode = process.argv.includes('--test-mode') || process.env.BLOG_COMMENTER_TEST === 'true';
  const json = process.argv.includes('--json');
  const lockState = await acquireEngagementLock();
  if (!lockState.acquired) {
    console.log(`SKIPPED: already_running pid=${lockState.lock?.pid || 'unknown'}`);
    return;
  }
  let result;
  try {
    result = await runNeighborSympathy({ testMode });
  } finally {
    releaseEngagementLock(lockState.lock);
  }

  if (json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (result.skipped) {
    console.log(`SKIPPED: ${result.reason}`);
    return;
  }

  console.log(`detected=${result.detected} pending=${result.pending} liked=${result.liked} failed=${result.failed} skipped=${result.skipped}`);
}

main().catch((error) => {
  console.error(`❌ ${error?.stack || error?.message || String(error)}`);
  process.exit(1);
});
