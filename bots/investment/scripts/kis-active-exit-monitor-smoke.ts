#!/usr/bin/env node
// @ts-nocheck

import assert from 'node:assert/strict';
import {
  evaluateExchangeForActiveExit,
  findPendingOrApprovedSellSignal,
  insertSignalReverseExitSignal,
  parseKisActiveExitArgs,
  runKisActiveExitMonitor,
} from './kis-active-exit-monitor.ts';
import { hasPendingOrApprovedSellSignal } from './domestic-holding-monitor.ts';
import { resolveHanulSellExitReasonOverride } from '../team/hanul.ts';

const openMarket = () => ({ isOpen: true, reasonCode: 'kis_market_open' });
const closedMarket = () => ({ isOpen: false, reasonCode: 'kis_market_closed' });

function position(symbol, exchange = 'kis') {
  return {
    symbol,
    exchange,
    amount: exchange === 'kis' ? 10 : 2,
    avg_price: exchange === 'kis' ? 70000 : 100,
    current_price: exchange === 'kis' ? 68000 : 97,
    trade_mode: 'normal',
  };
}

const defaultArgs = parseKisActiveExitArgs(['--json'], {});
assert.equal(defaultArgs.dryRun, true);
assert.equal(defaultArgs.enabled, false);

const enabledArgs = parseKisActiveExitArgs(['--json'], { LUNA_KIS_ACTIVE_EXIT_ENABLED: 'true' });
assert.equal(enabledArgs.dryRun, false);
assert.equal(enabledArgs.enabled, true);

let shadowDecisionCalls = 0;
let shadowInsertCalls = 0;
const shadowResult = await runKisActiveExitMonitor({
  dryRun: true,
  enabled: false,
  exchange: 'kis',
  now: '2026-06-26T03:00:00.000Z',
}, {
  db: {
    getOpenPositions: async (exchange) => [position('005930', exchange)],
    query: async () => [],
  },
  evaluateKisMarketHours: openMarket,
  getExitDecisions: async () => {
    shadowDecisionCalls += 1;
    return { decisions: [{ symbol: '005930', action: 'SELL', confidence: 0.72, reasoning: 'reverse signal' }] };
  },
  insertSignalReverseExitSignal: async () => {
    shadowInsertCalls += 1;
    return { signalId: 1 };
  },
});
assert.equal(shadowResult.dryRun, true);
assert.equal(shadowDecisionCalls, 1);
assert.equal(shadowInsertCalls, 0);
assert.equal(shadowResult.sellCandidates.length, 1);
assert.equal(shadowResult.skipped.some((item) => item.reason === 'dry_run'), true);

let capturedInsert = null;
const applyResult = await runKisActiveExitMonitor({
  dryRun: false,
  enabled: true,
  exchange: 'kis',
  now: '2026-06-26T03:00:00.000Z',
}, {
  db: {
    getOpenPositions: async (exchange) => [position('005930', exchange)],
    query: async () => [],
    insertSignal: async (payload) => {
      capturedInsert = payload;
      return 101;
    },
  },
  evaluateKisMarketHours: openMarket,
  getExitDecisions: async () => ({
    decisions: [{ symbol: '005930', action: 'SELL', confidence: 0.66, reasoning: 'domestic reversal' }],
  }),
});
assert.equal(applyResult.dryRun, false);
assert.equal(applyResult.inserted.length, 1);
assert.equal(capturedInsert.symbol, '005930');
assert.equal(capturedInsert.action, 'SELL');
assert.equal(capturedInsert.executionOrigin, 'kis_active_exit_monitor');
assert.equal(capturedInsert.incidentLink, 'signal_reverse');
assert.equal(capturedInsert.nemesisVerdict, 'approved');
assert.equal(capturedInsert.qualityFlag, 'trusted');

const holdResult = await evaluateExchangeForActiveExit('kis', {
  dryRun: false,
  enabled: true,
}, {
  db: {
    getOpenPositions: async (exchange) => [position('005930', exchange)],
    query: async () => [],
    insertSignal: async () => {
      throw new Error('unexpected_insert');
    },
  },
  evaluateKisMarketHours: openMarket,
  getExitDecisions: async () => ({ decisions: [{ symbol: '005930', action: 'HOLD', confidence: 0.4 }] }),
});
assert.equal(holdResult.sellCandidates.length, 0);
assert.equal(holdResult.inserted.length, 0);

let closedDecisionCalls = 0;
const closedResult = await runKisActiveExitMonitor({
  dryRun: false,
  enabled: true,
  exchange: 'kis',
}, {
  db: {
    getOpenPositions: async () => {
      throw new Error('market_closed_should_short_circuit');
    },
  },
  evaluateKisMarketHours: closedMarket,
  getExitDecisions: async () => {
    closedDecisionCalls += 1;
    return { decisions: [] };
  },
});
assert.equal(closedDecisionCalls, 0);
assert.equal(closedResult.skipped.some((item) => item.reason === 'kis_market_closed'), true);

const duplicateResult = await evaluateExchangeForActiveExit('kis', {
  dryRun: false,
  enabled: true,
}, {
  db: {
    getOpenPositions: async (exchange) => [position('005930', exchange)],
    query: async () => [],
    insertSignal: async () => {
      throw new Error('duplicate_should_skip_insert');
    },
  },
  evaluateKisMarketHours: openMarket,
  getExitDecisions: async () => ({ decisions: [{ symbol: '005930', action: 'SELL', confidence: 0.7 }] }),
  findPendingOrApprovedSellSignal: async () => ({ id: 202 }),
});
assert.equal(duplicateResult.inserted.length, 0);
assert.equal(duplicateResult.skipped.some((item) => item.reason === 'duplicate_sell_signal' && item.signalId === 202), true);

const exchangesSeen = [];
const filteredResult = await runKisActiveExitMonitor({
  dryRun: true,
  exchange: 'kis',
}, {
  db: {
    getOpenPositions: async (exchange) => {
      exchangesSeen.push(exchange);
      return [position(exchange === 'kis' ? '005930' : 'AAPL', exchange)];
    },
    query: async () => [],
  },
  evaluateKisMarketHours: openMarket,
  getExitDecisions: async () => ({ decisions: [] }),
});
assert.deepEqual(filteredResult.exchanges, ['kis']);
assert.deepEqual(exchangesSeen, ['kis']);

const allResult = await runKisActiveExitMonitor({
  dryRun: true,
  exchange: 'all',
}, {
  db: {
    getOpenPositions: async (exchange) => [position(exchange === 'kis' ? '005930' : 'AAPL', exchange)],
    query: async () => [],
  },
  evaluateKisMarketHours: openMarket,
  getExitDecisions: async (positions, exchange) => ({
    decisions: [{ symbol: positions[0].symbol, action: exchange === 'kis_overseas' ? 'SELL' : 'HOLD' }],
  }),
});
assert.deepEqual(allResult.exchanges, ['kis', 'kis_overseas']);
assert.equal(allResult.sellCandidates.length, 1);
assert.equal(allResult.sellCandidates[0].exchange, 'kis_overseas');

let helperParams = null;
const duplicateRow = await findPendingOrApprovedSellSignal({
  symbol: '005930',
  exchange: 'kis',
  tradeMode: 'normal',
}, async (_sql, params) => {
  helperParams = params;
  return [{ id: 303 }];
});
assert.equal(duplicateRow.id, 303);
assert.deepEqual(helperParams, ['005930', 'kis', 'normal']);

const domesticDuplicate = await hasPendingOrApprovedSellSignal({
  symbol: '005930',
  exchange: 'kis',
  tradeMode: 'normal',
}, async (_sql, params) => {
  assert.deepEqual(params, ['005930', 'kis', 'normal']);
  return [{ id: 404 }];
});
assert.equal(domesticDuplicate.id, 404);

let directPayload = null;
const directInsert = await insertSignalReverseExitSignal({
  symbol: '000660',
  exchange: 'kis',
  tradeMode: 'normal',
  positionValue: 550000,
  confidence: 0.61,
  reasoning: 'fixture',
  approvedAt: '2026-06-26T03:00:00.000Z',
}, {
  db: {
    insertSignal: async (payload) => {
      directPayload = payload;
      return 505;
    },
  },
});
assert.equal(directInsert.signalId, 505);
assert.equal(directPayload.incidentLink, 'signal_reverse');
assert.equal(directPayload.executionOrigin, 'kis_active_exit_monitor');

assert.equal(resolveHanulSellExitReasonOverride({ incident_link: 'signal_reverse' }), 'signal_reverse');
assert.equal(resolveHanulSellExitReasonOverride({ execution_origin: 'kis_active_exit_monitor' }), 'signal_reverse');
assert.equal(resolveHanulSellExitReasonOverride({ exit_reason_override: 'custom_exit' }), 'custom_exit');
assert.equal(resolveHanulSellExitReasonOverride({ incident_link: 'other' }), null);

const payload = {
  ok: true,
  smoke: 'kis-active-exit-monitor',
  scenarios: {
    shadowDryRun: shadowResult.sellCandidates.length,
    applyInserted: applyResult.inserted.length,
    holdSkipped: holdResult.sellCandidates.length,
    marketClosed: closedResult.skipped.length,
    duplicateSkipped: duplicateResult.skipped.length,
    allExchangeSellCandidates: allResult.sellCandidates.length,
  },
};

if (process.argv.includes('--json')) {
  console.log(JSON.stringify(payload, null, 2));
} else {
  console.log('kis-active-exit-monitor-smoke ok');
}
