#!/usr/bin/env node
// @ts-nocheck

import assert from 'node:assert/strict';
import * as db from '../shared/db.ts';
import {
  fetchPendingPosttradeCandidates,
  normalizeTradeQualityResult,
  shouldUseTradeQualityLlm,
} from '../shared/trade-quality-evaluator.ts';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';

async function runSmoke() {
  await db.initSchema();
  const retryTradeId = 910000000 + Math.floor(Math.random() * 999999);
  try {
    await db.run(
      `INSERT INTO investment.trade_quality_evaluations
         (trade_id, market_decision_score, pipeline_quality_score, monitoring_score,
          backtest_utilization_score, overall_score, category, rationale, sub_score_breakdown)
       VALUES ($1, 0.200, 0.300, 0.300, 0.200, 0.250, 'rejected', 'smoke rejected missing reflexion', '{}'::jsonb)
       ON CONFLICT (trade_id) DO UPDATE SET
         category = 'rejected',
         overall_score = 0.250,
         evaluated_at = NOW()`,
      [retryTradeId],
    );
    const all = await fetchPendingPosttradeCandidates({ limit: 5, market: 'all' });
    assert.ok(Array.isArray(all), 'candidate list array');
    assert.ok(
      all.some((item) => Number(item.tradeId) === retryTradeId && item.source === 'reflexion_retry'),
      'rejected quality rows without reflexion must re-enter posttrade queue',
    );
    const cachedQuality = normalizeTradeQualityResult(await db.get(
      `SELECT * FROM investment.trade_quality_evaluations WHERE trade_id = $1`,
      [retryTradeId],
    ));
    assert.equal(cachedQuality?.overall_score.toFixed(3), '0.250', 'cached numeric quality row is normalized');

    const crypto = await fetchPendingPosttradeCandidates({ limit: 5, market: 'crypto' });
    assert.ok(Array.isArray(crypto), 'crypto list array');
    assert.ok(crypto.every((item) => Number.isFinite(Number(item.tradeId))), 'candidate tradeId numeric');
    assert.equal(shouldUseTradeQualityLlm({ dryRun: false }, {}), false, 'apply path is no-LLM by default');
    assert.equal(
      shouldUseTradeQualityLlm({ dryRun: false }, { LUNA_POSTTRADE_EVALUATION_LLM_ENABLED: 'true' }),
      true,
      'explicit LLM env enables posttrade evaluator LLM',
    );
    assert.equal(
      shouldUseTradeQualityLlm({ dryRun: true }, { LUNA_POSTTRADE_DRY_RUN_LLM: 'true' }),
      true,
      'legacy dry-run LLM env remains supported',
    );

    return {
      ok: true,
      allCount: all.length,
      cryptoCount: crypto.length,
      llmDefault: shouldUseTradeQualityLlm({ dryRun: false }, {}),
    };
  } finally {
    await db.run(`DELETE FROM investment.luna_failure_reflexions WHERE trade_id = $1`, [retryTradeId]).catch(() => {});
    await db.run(`DELETE FROM investment.trade_quality_evaluations WHERE trade_id = $1`, [retryTradeId]).catch(() => {});
  }
}

async function main() {
  const result = await runSmoke();
  if (process.argv.includes('--json')) console.log(JSON.stringify(result, null, 2));
  else console.log('trade-quality-evaluator-smoke ok');
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({
    run: main,
    errorPrefix: '❌ trade-quality-evaluator-smoke 실패:',
  });
}
