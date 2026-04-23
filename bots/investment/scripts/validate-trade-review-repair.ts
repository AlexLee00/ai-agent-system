#!/usr/bin/env node
// @ts-nocheck

import { pathToFileURL } from 'url';
import { buildTradeReviewRepairCloseout, validateTradeReview } from './validate-trade-review.ts';

const args = process.argv.slice(2);
const daysArg = args.find((arg) => arg.startsWith('--days='));
const scopeArg = args.find((arg) => arg.startsWith('--scope='));
const DAYS = daysArg ? parseInt(daysArg.split('=')[1], 10) : 90;
const FIX = args.includes('--fix') || args.includes('--apply');
const SCOPE = args.includes('--paper-only')
  ? 'paper'
  : args.includes('--live-only')
    ? 'live'
    : ['paper', 'live', 'all'].includes(scopeArg?.split('=')[1])
      ? scopeArg.split('=')[1]
      : 'all';
const INCLUDE_ITEMS = args.includes('--include-items');

function compactValidationResult(result = {}, { includeItems = false, sampleSize = 5 } = {}) {
  if (includeItems) return result;
  const items = Array.isArray(result.items) ? result.items : [];
  return {
    ...result,
    itemSamples: items.slice(0, sampleSize),
    itemsOmitted: Math.max(0, items.length - sampleSize),
    items: undefined,
  };
}

export async function runValidateTradeReviewRepair({ days = 90, scope = 'all', fix = false, includeItems = false } = {}) {
  const before = await validateTradeReview({ days, scope, fix: false });
  const repair = fix
    ? await validateTradeReview({ days, scope, fix: true })
    : {
        ...before,
        fixed: 0,
        fixedLive: 0,
        fixedPaper: 0,
      };
  const after = fix
    ? await validateTradeReview({ days, scope, fix: false })
    : before;
  const closeout = buildTradeReviewRepairCloseout({ before, repair, after, fix });

  return {
    ok: true,
    days,
    scope,
    fix,
    closeout,
    before: compactValidationResult(before, { includeItems }),
    repair: compactValidationResult(repair, { includeItems }),
    after: compactValidationResult(after, { includeItems }),
  };
}

async function main() {
  const result = await runValidateTradeReviewRepair({ days: DAYS, scope: SCOPE, fix: FIX, includeItems: INCLUDE_ITEMS });
  console.log(JSON.stringify(result, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error('❌ trade_review repair 실패:', err?.message || String(err));
    process.exit(1);
  });
}
