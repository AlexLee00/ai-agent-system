#!/usr/bin/env node
// @ts-nocheck

import assert from 'assert/strict';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';
import {
  buildDiscoveryThrottleSuggestions,
  buildExchangeCutoverFilter,
  buildOverseasSuggestions,
  summarizeExchange,
} from './runtime-config-suggestions.ts';

function config() {
  return {
    luna: {
      minConfidence: { live: { kis_overseas: 0.22 } },
      stockOrderDefaults: {
        kis_overseas: { min: 250, max: 1200 },
      },
    },
  };
}

export function runRuntimeConfigSuggestionsSmoke() {
  assert.match(
    buildExchangeCutoverFilter('created_at'),
    /kis_overseas.*2026-04-23T13:01:51\.000Z/,
  );

  const summary = summarizeExchange([
    { exchange: 'kis_overseas', action: 'BUY', status: 'executed', cnt: 3 },
    { exchange: 'kis_overseas', action: 'BUY', status: 'failed', cnt: 30 },
    { exchange: 'kis_overseas', action: 'SELL', status: 'failed', cnt: 8 },
  ], [
    { exchange: 'kis_overseas', block_code: 'sec015_overseas_nemesis_bypass_guard', cnt: 24 },
    { exchange: 'kis_overseas', block_code: 'mock_operation_unsupported', cnt: 8 },
  ], [], 'kis_overseas');

  assert.equal(summary.totalBuy, 33);
  assert.equal(summary.executed, 3);
  assert.equal(summary.failed, 30);
  assert.equal(summary.buyOutcomes, 33);
  assert.equal(summary.failureRate, 90.9);

  const operational = buildOverseasSuggestions(config(), summary);
  const confidence = operational.find((item) => item.key === 'runtime_config.luna.minConfidence.live.kis_overseas');
  assert.equal(confidence?.action, 'hold');
  assert.equal(confidence?.suggested, 0.22);
  assert.match(confidence?.reason || '', /실행 권한|브로커 모드|네메시스 승인/);

  const thresholdSummary = {
    ...summary,
    topBlocks: [{ code: 'confidence_below_minimum', count: 20 }],
  };
  const threshold = buildOverseasSuggestions(config(), thresholdSummary);
  const thresholdConfidence = threshold.find((item) => item.key === 'runtime_config.luna.minConfidence.live.kis_overseas');
  assert.equal(thresholdConfidence?.action, 'adjust');
  assert.equal(thresholdConfidence?.suggested, 0.2);

  const throttle = buildDiscoveryThrottleSuggestions({
    luna: {
      discoveryThrottle: {
        maxSymbols: 16,
        maxDebateSymbols: 4,
        maxBuyCandidates: 3,
        modeOverride: '',
      },
    },
  }, {
    total: 12,
    validationRatio: 88,
    topReason: { reason: 'buying_power_unavailable' },
  }, {
    failed: 28,
    executed: 2,
  });
  const throttleMaxSymbols = throttle.find((item) => item.key === 'runtime_config.luna.discoveryThrottle.maxSymbols');
  const throttleModeOverride = throttle.find((item) => item.key === 'runtime_config.luna.discoveryThrottle.modeOverride');
  assert.equal(throttleMaxSymbols?.action, 'promote_candidate');
  assert.equal(throttleMaxSymbols?.suggested, 14);
  assert.equal(throttleModeOverride?.suggested, 'monitor_only');

  return {
    ok: true,
    failureRate: summary.failureRate,
    operationalAction: confidence?.action,
    thresholdAction: thresholdConfidence?.action,
    throttleAction: throttleMaxSymbols?.action,
  };
}

async function main() {
  const result = runRuntimeConfigSuggestionsSmoke();
  if (process.argv.includes('--json')) console.log(JSON.stringify(result, null, 2));
  else console.log('runtime config suggestions smoke ok');
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({
    run: main,
    errorPrefix: '❌ runtime config suggestions smoke 실패:',
  });
}
