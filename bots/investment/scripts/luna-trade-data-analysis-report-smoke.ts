#!/usr/bin/env node
// @ts-nocheck
import assert from 'node:assert/strict';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';
import { classifySignalFailure } from '../shared/signal-failure-classifier.ts';
import { preFilterSignal } from '../shared/signal-pre-filter.ts';
import { resolveExpectedSellNoopStatus } from '../shared/trade-data-derived-guards.ts';
import { ensureRealizedPnlColumns } from '../shared/realized-pnl-calculator.ts';
import { buildTradeDataAnalysisReport, TRADE_DATA_REINFORCEMENT_CONTRACT } from '../shared/trade-data-analysis-report.ts';
import { close } from '../shared/db/core.ts';

export async function runSmoke() {
  const limitExceeded = classifySignalFailure({ block_reason: '원칙1 단일 포지션 한도 초과' });
  assert.equal(limitExceeded.kind, 'limit_exceeded');
  const brokerError = classifySignalFailure({ error: 'KIS_ERROR order_rejected' });
  assert.equal(brokerError.kind, 'broker_error');
  const unknown = classifySignalFailure({ error: 'unexpected fatal' });
  assert.equal(unknown.kind, 'other');

  const bearFiltered = preFilterSignal({
    symbol: '005930',
    exchange: 'kis',
    action: 'BUY',
    confidence: 0.8,
    marketRegime: 'trending_bear',
  }, { now: new Date('2026-04-30T01:00:00Z') });
  assert.equal(bearFiltered.ok, false);
  assert.ok(bearFiltered.blockers.includes('regime_buy_blocked'));

  const volatileFiltered = preFilterSignal({
    symbol: 'BTC/USDT',
    action: 'BUY',
    confidence: 0.8,
    volatilityBucket: 'extreme',
  });
  assert.ok(volatileFiltered.blockers.includes('extreme_volatility'));

  const expectedSellNoop = resolveExpectedSellNoopStatus({ action: 'SELL', code: 'missing_position' });
  assert.equal(expectedSellNoop.status, 'skipped_below_min');
  assert.equal(expectedSellNoop.classification, 'no_position_noop');

  const weakSymbol = preFilterSignal({ symbol: 'KITE/USDT', exchange: 'binance', action: 'BUY', confidence: 0.9 });
  assert.ok(weakSymbol.blockers.includes('trade_data_weak_symbol'));

  const defensiveDomestic = preFilterSignal({
    symbol: '006340',
    exchange: 'kis',
    action: 'BUY',
    confidence: 0.9,
    strategy_family: 'defensive_rotation',
  }, { now: new Date('2026-04-30T01:00:00Z') });
  assert.ok(defensiveDomestic.blockers.includes('domestic_defensive_rotation_validation_only'));

  await ensureRealizedPnlColumns();
  const report = await buildTradeDataAnalysisReport({ limit: 200 });
  assert.equal(report.ok, true);
  assert.ok(report.signals.total >= 0);
  assert.equal(report.reinforcementCoverage.length, TRADE_DATA_REINFORCEMENT_CONTRACT.length);
  for (const id of TRADE_DATA_REINFORCEMENT_CONTRACT) {
    assert.ok(report.reinforcementCoverage.some((item) => item.id === id && item.status === 'implemented'), `coverage ${id}`);
  }
  return {
    ok: true,
    classifier: { limitExceeded: limitExceeded.kind, brokerError: brokerError.kind, unknown: unknown.kind },
    preFilter: { bear: bearFiltered.blockers, volatile: volatileFiltered.blockers, weakSymbol: weakSymbol.blockers, defensiveDomestic: defensiveDomestic.blockers },
    sellNoop: expectedSellNoop,
    report: {
      status: report.status,
      signalTotal: report.signals.total,
      warningCount: report.warnings.length,
      coverage: report.reinforcementCoverage.length,
      realizedCoverage: report.trades.realizedPnlCoverage,
    },
  };
}

async function main() {
  try {
    const result = await runSmoke();
    if (process.argv.includes('--json')) console.log(JSON.stringify(result, null, 2));
    else console.log(`luna-trade-data-analysis-report-smoke status=${result.report.status}`);
  } finally {
    await Promise.resolve(close()).catch(() => {});
  }
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({ run: main, errorPrefix: '❌ luna-trade-data-analysis-report-smoke 실패:' });
}
