#!/usr/bin/env tsx
// @ts-nocheck
'use strict';

const path = require('path');
const env = require('../../../packages/core/lib/env');
const { evaluateBlogV3PromotionGate } = require(
  path.join(env.PROJECT_ROOT, 'bots/blog/lib/blog-v3-unified.ts')
);

async function main() {
  const json = process.argv.includes('--json');
  const strict = process.argv.includes('--strict');
  const noFail = process.argv.includes('--no-fail');
  const report = await evaluateBlogV3PromotionGate();
  if (json) console.log(JSON.stringify(report));
  else {
    console.log(`[blog-v3-shadow-gate] promotionReady=${report.promotionReady}`);
    console.log(JSON.stringify(report.checks || {}, null, 2));
  }
  if (strict && !report.promotionReady && !noFail) process.exit(1);
}

main().catch((error) => {
  const result = { ok: false, promotionReady: false, error: error?.message || String(error) };
  if (process.argv.includes('--json')) console.log(JSON.stringify(result));
  else console.error('[blog-v3-shadow-gate] failed:', result.error);
  process.exit(process.argv.includes('--no-fail') ? 0 : 1);
});
