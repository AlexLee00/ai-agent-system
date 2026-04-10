#!/usr/bin/env node
// @ts-nocheck
'use strict';

const env = require('../../../packages/core/lib/env');
const { runCommentReply } = require('../lib/commenter');

async function main() {
  const testMode = process.env.BLOG_COMMENTER_TEST === 'true';
  env.printModeBanner('blog commenter');

  const result = await runCommentReply({ testMode });
  if (result?.skipped) {
    console.log(`[커멘터] 스킵: ${result.reason}`);
    return;
  }

  console.log(`detected=${result.detected} pending=${result.pending} replied=${result.replied} failed=${result.failed} skipped=${result.skipped}`);
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error('[커멘터] 실패:', error?.stack || error?.message || String(error));
    process.exit(1);
  });
