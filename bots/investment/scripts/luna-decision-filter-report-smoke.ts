#!/usr/bin/env node
// @ts-nocheck

import assert from 'node:assert/strict';
import { buildDecisionFilterDiagnostics } from './runtime-luna-decision-filter-report.ts';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';

const now = new Date().toISOString();

function row(symbol, analyst, signal, confidence) {
  return {
    symbol,
    analyst,
    signal,
    confidence,
    reasoning: `smoke ${analyst} ${signal}`,
    created_at: now,
  };
}

export function runLunaDecisionFilterReportSmoke() {
  const rows = [
    row('NEWS/USDT', 'news', 'BUY', 0.9),
    row('NEWS/USDT', 'ta_mtf', 'HOLD', 0.62),
    row('NEWS/USDT', 'onchain', 'HOLD', 0.6),
    row('NEWS/USDT', 'sentiment', 'HOLD', 0.55),
    row('READY/USDT', 'news', 'BUY', 0.82),
    row('READY/USDT', 'ta_mtf', 'BUY', 0.8),
    row('READY/USDT', 'onchain', 'BUY', 0.76),
    row('READY/USDT', 'sentiment', 'BUY', 0.74),
    row('LOW/USDT', 'news', 'BUY', 0.51),
    row('LOW/USDT', 'ta_mtf', 'BUY', 0.52),
    row('LOW/USDT', 'onchain', 'BUY', 0.53),
    row('LOW/USDT', 'sentiment', 'BUY', 0.51),
  ];

  const diagnostics = buildDecisionFilterDiagnostics(rows, {
    exchange: 'binance',
    minConfidence: 0.7,
  });
  const bySymbol = Object.fromEntries(diagnostics.map((item) => [item.symbol, item]));

  assert.equal(bySymbol['READY/USDT'].actionability, 'likely_actionable');
  assert.equal(bySymbol['NEWS/USDT'].actionability, 'filtered_before_signal');
  assert.ok(bySymbol['NEWS/USDT'].reasons.includes('news_only_buy'));
  assert.ok(bySymbol['NEWS/USDT'].reasons.includes('technical_not_confirmed'));
  assert.ok(bySymbol['NEWS/USDT'].reasons.includes('onchain_not_confirmed'));
  assert.equal(bySymbol['LOW/USDT'].actionability, 'filtered_before_signal');
  assert.ok(bySymbol['LOW/USDT'].reasons.includes('average_confidence_below_min'));

  return {
    ok: true,
    smoke: 'luna-decision-filter-report',
    checked: diagnostics.length,
    newsOnlyReasons: bySymbol['NEWS/USDT'].reasons,
    readyActionability: bySymbol['READY/USDT'].actionability,
  };
}

async function main() {
  const result = runLunaDecisionFilterReportSmoke();
  if (process.argv.includes('--json')) console.log(JSON.stringify(result, null, 2));
  else console.log('luna-decision-filter-report-smoke ok');
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({
    run: main,
    errorPrefix: '❌ luna-decision-filter-report-smoke 실패:',
  });
}
