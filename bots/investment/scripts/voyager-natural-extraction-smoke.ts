#!/usr/bin/env node
// @ts-nocheck
import assert from 'node:assert/strict';
import {
  buildVoyagerNaturalExtractionPlan,
  onTradeClosedForVoyager,
} from '../shared/voyager-natural-extraction-trigger.ts';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';

export async function runSmoke() {
  const pending = buildVoyagerNaturalExtractionPlan({ closedTradeCount: 2, minTradeCount: 3 });
  assert.equal(pending.ready, false);
  assert.equal(pending.status, 'pending_closed_trade_accumulation');

  let extractCalls = 0;
  const ready = await onTradeClosedForVoyager(
    { market: 'crypto' },
    {
      closedTradeCount: 3,
      minTradeCount: 3,
      dryRun: true,
      extractFn: async (opts) => {
        extractCalls++;
        assert.equal(opts.dryRun, true);
        return { ok: true, candidates: 5, extracted: 2, dryRun: true };
      },
    },
  );
  assert.equal(ready.status, 'dry_run_extraction_ready');
  assert.equal(ready.productionSkillPromoted, false);
  assert.equal(extractCalls, 1);

  const blocked = await onTradeClosedForVoyager(
    { market: 'crypto' },
    { closedTradeCount: 3, minTradeCount: 3, dryRun: false, extractFn: async () => ({ ok: true }) },
  );
  assert.equal(blocked.status, 'apply_blocked');
  return { ok: true, pending, readyStatus: ready.status, blockedStatus: blocked.status };
}

async function main() {
  const result = await runSmoke();
  if (process.argv.includes('--json')) console.log(JSON.stringify(result, null, 2));
  else console.log('✅ voyager-natural-extraction-smoke');
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({ run: main, errorPrefix: '❌ voyager-natural-extraction-smoke 실패:' });
}
