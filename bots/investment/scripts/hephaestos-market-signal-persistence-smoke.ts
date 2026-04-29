#!/usr/bin/env node
// @ts-nocheck

import assert from 'assert/strict';
import { createMarketSignalPersistence } from '../team/hephaestos/market-signal-persistence.ts';

const calls = [];
const rows = [
  {
    id: 'sig-stale',
    symbol: 'ORCA/USDT',
    action: 'BUY',
    created_at: new Date(Date.now() - 45 * 60 * 1000).toISOString(),
    confidence: 0.72,
    amount_usdt: 100,
  },
];

const persistence = createMarketSignalPersistence({
  SIGNAL_STATUS: { FAILED: 'failed' },
  db: {
    query: async (sql, args) => {
      calls.push(['query', sql, args]);
      return rows;
    },
    updateSignalBlock: async (...args) => calls.push(['updateSignalBlock', ...args]),
  },
  getInvestmentExecutionRuntimeConfig: () => ({
    pendingQueue: {
      stalePendingMinutes: 30,
    },
  }),
});

const trusted = persistence.buildSignalQualityContext({
  execution_origin: 'strategy',
  quality_flag: 'trusted',
});
assert.deepEqual(trusted, {
  executionOrigin: 'strategy',
  qualityFlag: 'trusted',
  excludeFromLearning: false,
  incidentLink: null,
});

const reconciled = persistence.buildSignalQualityContext({
  block_code: 'position_balance_reconciled',
  execution_origin: 'strategy',
  quality_flag: 'trusted',
});
assert.equal(reconciled.executionOrigin, 'reconciliation');
assert.equal(reconciled.qualityFlag, 'degraded');
assert.equal(reconciled.excludeFromLearning, true);
assert.equal(reconciled.incidentLink, 'position_balance_reconciled');

const staleRows = await persistence.cleanupStalePendingSignals({
  exchange: 'binance',
  tradeMode: 'normal',
});
assert.equal(staleRows.length, 1);
const block = calls.find((item) => item[0] === 'updateSignalBlock');
assert.equal(block[1], 'sig-stale');
assert.equal(block[2].status, 'failed');
assert.equal(block[2].code, 'stale_pending_signal');
assert.equal(block[2].meta.stalePendingMinutes, 30);
assert.equal(block[2].meta.execution_blocked_by, 'approval_gate');

const payload = {
  ok: true,
  smoke: 'hephaestos-market-signal-persistence',
  qualityContext: reconciled,
  staleCount: staleRows.length,
};

if (process.argv.includes('--json')) {
  console.log(JSON.stringify(payload, null, 2));
} else {
  console.log('✅ hephaestos market signal persistence smoke passed');
}
