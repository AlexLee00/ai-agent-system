#!/usr/bin/env node
'use strict';

const env = require('../../../packages/core/lib/env');
const { runCommentReply } = require('../lib/commenter.ts');
const { writeCommenterRunResult } = require('../lib/commenter-run-telemetry.ts');
const { acquireEngagementLock, releaseEngagementLock } = require('../lib/engagement-process-lock.ts');

async function main() {
  const argv = process.argv.slice(2);
  const testMode = process.env.BLOG_COMMENTER_TEST === 'true' || argv.includes('--test-mode');
  const lockState = await acquireEngagementLock();
  if (!lockState.acquired) {
    console.log(`[커멘터] 스킵: already_running pid=${lockState.lock?.pid || 'unknown'}`);
    return;
  }
  env.printModeBanner('blog commenter');
  try {
    const result = await runCommentReply({ testMode });
    writeCommenterRunResult({
      executedAt: new Date().toISOString(),
      testMode,
      ok: Boolean(result?.ok),
      skipped: Boolean(result?.skipped),
      reason: String(result?.reason || ''),
      detected: Number(result?.detected || 0),
      pending: Number(result?.pending || 0),
      replied: Number(result?.replied || 0),
      failed: Number(result?.failed || 0),
      skippedCount: Number(result?.skipped || 0),
      commentClassifications: result?.commentClassifications || {},
    });
    if (result?.ok !== true && result?.skipped === true) {
      console.log(`[커멘터] 스킵: ${result.reason}`);
      return;
    }

    console.log(`detected=${result.detected} pending=${result.pending} replied=${result.replied} failed=${result.failed} skipped=${result.skipped}`);
  } finally {
    releaseEngagementLock(lockState.lock);
  }
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    writeCommenterRunResult({
      executedAt: new Date().toISOString(),
      testMode: process.env.BLOG_COMMENTER_TEST === 'true',
      ok: false,
      skipped: false,
      reason: String(error?.message || error || ''),
      detected: 0,
      pending: 0,
      replied: 0,
      failed: 1,
      skippedCount: 0,
      commentClassifications: {},
    });
    console.error('[커멘터] 실패:', error?.stack || error?.message || String(error));
    process.exit(1);
  });
