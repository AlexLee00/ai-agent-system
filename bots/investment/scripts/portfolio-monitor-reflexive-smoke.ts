#!/usr/bin/env node
// @ts-nocheck

import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';
import { analyzeReflexivePortfolioState } from '../shared/portfolio-reflexive-monitor.ts';
import { assertSmokePass } from '../shared/smoke-assert.ts';

export async function runPortfolioMonitorReflexiveSmoke({ json = false, strict = true } = {}) {
  const saved = process.env.LUNA_REFLEXIVE_PORTFOLIO_MONITORING_ENABLED;
  process.env.LUNA_REFLEXIVE_PORTFOLIO_MONITORING_ENABLED = 'true';
  let summary;
  try {
    const normal = analyzeReflexivePortfolioState({
      positions: [
        { exchange: 'binance', symbol: 'BTC/USDT', amount: 0.01, avg_price: 70000, notional_value: 1200, correlation: 0.4, pnlPct: 2.1, setup_type: 'trend_following' },
        { exchange: 'kis', symbol: '005930', amount: 10, avg_price: 63000, notional_value: 1200, correlation: 0.35, pnlPct: -0.4, setup_type: 'equity_swing' },
        { exchange: 'kis_overseas', symbol: 'AAPL', amount: 4, avg_price: 220, notional_value: 1200, correlation: 0.25, pnlPct: 0.9, setup_type: 'equity_swing' },
      ],
      latestRegimeByMarket: { crypto: 'trending_bull', domestic: 'ranging' },
    });
    const risky = analyzeReflexivePortfolioState({
      positions: [
        { exchange: 'binance', symbol: 'BTC/USDT', amount: 0.08, avg_price: 70000, correlation: 0.92, pnlPct: -2.4, setup_type: 'trend_following' },
        { exchange: 'binance', symbol: 'BTC/USDT', amount: 0.06, avg_price: 71000, correlation: 0.9, pnlPct: -2.8, setup_type: 'trend_following' },
        { exchange: 'kis_overseas', symbol: 'AAPL', amount: 50, avg_price: 220, correlation: 0.88, pnlPct: -2.2, setup_type: 'trend_following' },
      ],
      latestRegimeByMarket: { crypto: 'trending_bear', overseas: 'trending_bear' },
    });
    const matrixDriven = analyzeReflexivePortfolioState({
      positions: [
        { exchange: 'binance', symbol: 'BTC/USDT', amount: 0.02, avg_price: 70000, pnlPct: 1.2, setup_type: 'trend_following' },
        { exchange: 'binance', symbol: 'ETH/USDT', amount: 0.5, avg_price: 3500, pnlPct: 0.8, setup_type: 'trend_following' },
      ],
      latestRegimeByMarket: { crypto: 'trending_bull' },
      correlationMatrix: {
        'BTC/USDT': { 'ETH/USDT': 0.91 },
      },
    });

    const cases = [
      {
        name: 'normal_portfolio',
        pass: normal.protective === false,
        output: normal,
        error: normal.protective ? 'expected protective=false' : null,
      },
      {
        name: 'risky_portfolio',
        pass: risky.protective === true && Array.isArray(risky.reasonCodes) && risky.reasonCodes.length > 0,
        output: risky,
        error: risky.protective ? null : 'expected protective=true',
      },
      {
        name: 'matrix_correlation_detected',
        pass: matrixDriven.protective === true
          && matrixDriven.metrics?.correlationEvidence === 'matrix'
          && matrixDriven.reasonCodes.includes('correlation_cluster_detected'),
        output: matrixDriven,
        error: matrixDriven.reasonCodes.includes('correlation_cluster_detected') ? null : 'expected matrix correlation alert',
      },
    ];

    const passed = cases.filter((c) => c.pass).length;
    const total = cases.length;
    summary = { pass: passed === total, passed, total, results: cases };
  } finally {
    if (saved === undefined) delete process.env.LUNA_REFLEXIVE_PORTFOLIO_MONITORING_ENABLED;
    else process.env.LUNA_REFLEXIVE_PORTFOLIO_MONITORING_ENABLED = saved;
  }

  if (strict) assertSmokePass(summary, '[portfolio-monitor-reflexive-smoke]');
  if (json) return summary;
  return {
    ...summary,
    text: [
      `[portfolio-monitor-reflexive-smoke] ${summary.passed}/${summary.total} 통과`,
      ...summary.results.map((r) => `${r.pass ? '✓' : '✗'} ${r.name} -> protective=${r.output?.protective}`),
    ].join('\n'),
  };
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({
    run: async () => {
      const json = process.argv.includes('--json');
      return runPortfolioMonitorReflexiveSmoke({ json, strict: true });
    },
    onSuccess: async (result) => {
      if (result?.text) console.log(result.text);
      else console.log(JSON.stringify(result, null, 2));
    },
    errorPrefix: '[portfolio-monitor-reflexive-smoke]',
  });
}
