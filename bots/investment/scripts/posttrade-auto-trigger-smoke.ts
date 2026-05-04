#!/usr/bin/env node
// @ts-nocheck
import assert from 'node:assert/strict';
import {
  buildPosttradeAutoTrigger,
  summarizePosttradeTriggers,
  onTradeClosed,
} from '../shared/posttrade-auto-trigger.ts';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';

export async function runSmoke() {
  // 플랜 빌더
  const close = buildPosttradeAutoTrigger({ id: 301, side: 'SELL', symbol: 'BTC/USDT' });
  assert.equal(close.shouldTrigger, true);
  assert.ok(close.pipeline.includes('agent_memory_write'));
  assert.ok(close.pipeline.includes('realized_pnl'), 'realized_pnl 단계 포함');

  const open = buildPosttradeAutoTrigger({ id: 302, side: 'BUY', symbol: 'ETH/USDT' });
  assert.equal(open.shouldTrigger, false);
  assert.equal(open.pipeline.length, 0);

  const summary = summarizePosttradeTriggers([{ side: 'BUY' }, { side: 'SELL' }, { closed: true }]);
  assert.equal(summary.total, 3);
  assert.equal(summary.triggerable, 2);

  // onTradeClosed — BUY 거래는 skip
  const skipResult = await onTradeClosed({ id: 't-buy', side: 'BUY', symbol: 'BTC/USDT' });
  assert.equal(skipResult.status, 'skipped');

  // onTradeClosed — SELL 거래지만 env 미설정 → disabled (DB 접근 없음)
  const disabledResult = await onTradeClosed(
    { id: 't-sell', side: 'SELL', symbol: 'BTC/USDT', exchange: 'binance' },
    { force: false, dryRun: true },
  );
  assert.ok(['disabled', 'dry_run'].includes(disabledResult.status), `status=${disabledResult.status}`);

  return { ok: true, close, open, summary, skipResult, disabledResult };
}

async function main() {
  const result = await runSmoke();
  if (process.argv.includes('--json')) console.log(JSON.stringify(result, null, 2));
  else console.log('✅ posttrade-auto-trigger-smoke');
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({ run: main, errorPrefix: '❌ posttrade-auto-trigger-smoke 실패:' });
}
