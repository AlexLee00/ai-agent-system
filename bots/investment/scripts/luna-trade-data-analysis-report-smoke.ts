#!/usr/bin/env node
// @ts-nocheck
import assert from 'node:assert/strict';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';
import { classifySignalFailure } from '../shared/signal-failure-classifier.ts';
import { preFilterSignal } from '../shared/signal-pre-filter.ts';
import { resolveExpectedSellNoopStatus } from '../shared/trade-data-derived-guards.ts';
import { ensureRealizedPnlColumns } from '../shared/realized-pnl-calculator.ts';
import { buildTradeDataAnalysisReport, TRADE_DATA_REINFORCEMENT_CONTRACT } from '../shared/trade-data-analysis-report.ts';
import { isLearningPnlValidRow } from '../shared/trade-journal-learning-guard.ts';
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
  assert.equal(bearFiltered.ok, true);
  assert.ok(bearFiltered.warnings.includes('regime_buy_probe_only'));
  assert.ok(bearFiltered.adjustments.some((item) => item.code === 'regime_buy_probe_only'));

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
  assert.equal(isLearningPnlValidRow({ pnl_amount: 1, exit_reason: 'take_profit' }), true);
  assert.equal(isLearningPnlValidRow({ pnl_amount: null, exit_reason: 'take_profit' }), false);
  assert.equal(isLearningPnlValidRow({ pnl_amount: 1, exit_reason: 'journal_reconciled_with_fill' }), false);
  assert.equal(isLearningPnlValidRow({ pnlAmount: 1, exitReason: 'sweeper_manual_dust_wallet_sync' }), false);

  const weakSymbol = preFilterSignal({ symbol: 'KITE/USDT', exchange: 'binance', action: 'BUY', confidence: 0.9 });
  assert.equal(weakSymbol.ok, true);
  assert.ok(weakSymbol.warnings.includes('trade_data_weak_symbol_development_stage'));

  const defensiveDomestic = preFilterSignal({
    symbol: '005930',
    exchange: 'kis',
    action: 'BUY',
    confidence: 0.9,
    strategy_family: 'defensive_rotation',
  }, { now: new Date('2026-04-30T01:00:00Z') });
  assert.equal(defensiveDomestic.ok, true);
  assert.ok(defensiveDomestic.warnings.includes('domestic_defensive_rotation_probe_only'));

  await ensureRealizedPnlColumns();
  const report = await buildTradeDataAnalysisReport({ limit: 200 });
  assert.equal(report.ok, true);
  assert.ok(report.signals.total >= 0);
  assert.ok(report.signals.blockedReasonTrend);
  assert.ok(report.signals.blockedReasonTrend.last24h.total >= 0);
  assert.ok(Array.isArray(report.signals.blockedReasonTrend.last24h.blockedReasons));
  assert.ok(report.signals.blockedReasonTrend.last2h.total >= 0);
  assert.ok(Array.isArray(report.signals.blockedReasonTrend.last2h.blockedReasons));
  assert.ok(report.posttrade.qualityCoverage);
  assert.ok(report.posttrade.qualityCoverage.coverage >= 0);
  assert.ok(report.hygiene);
  assert.ok(Array.isArray(report.hygiene.findings));
  assert.equal(report.reinforcementCoverage.length, TRADE_DATA_REINFORCEMENT_CONTRACT.length);
  for (const id of TRADE_DATA_REINFORCEMENT_CONTRACT) {
    assert.ok(report.reinforcementCoverage.some((item) => item.id === id && item.status === 'implemented'), `coverage ${id}`);
  }
  return {
    ok: true,
    classifier: { limitExceeded: limitExceeded.kind, brokerError: brokerError.kind, unknown: unknown.kind },
    preFilter: { bear: bearFiltered.warnings, volatile: volatileFiltered.blockers, weakSymbol: weakSymbol.blockers, defensiveDomestic: defensiveDomestic.warnings },
    sellNoop: expectedSellNoop,
    report: {
      status: report.status,
      signalTotal: report.signals.total,
      warningCount: report.warnings.length,
      coverage: report.reinforcementCoverage.length,
      realizedCoverage: report.trades.realizedPnlCoverage,
      qualityCoverage: report.posttrade.qualityCoverage,
      hygiene: {
        status: report.hygiene.status,
        severity: report.hygiene.severity,
        findingCount: report.hygiene.findings.length,
      },
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
