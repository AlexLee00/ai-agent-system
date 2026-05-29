// @ts-nocheck

import assert from 'node:assert/strict';
import { executePaperSimulation } from '../shared/signal.ts';

const journalRows = [];
const signalUpdates = [];
const alerts = [];
const marketBuyCalls = [];
let liveOrderCalls = 0;

const mockJournal = {
  async generateTradeId() {
    return 'TRD-PAPER-SMOKE-001';
  },
  async insertJournalEntry(entry) {
    journalRows.push(entry);
  },
  async getJournalEntryByTradeId(tradeId) {
    return journalRows.find((row) => row.trade_id === tradeId) || null;
  },
  async closeJournalEntry() {
    throw new Error('closeJournalEntry not expected in buy smoke');
  },
};

const result = await executePaperSimulation({
  id: 'SIG-PAPER-SMOKE-001',
  exchange: 'binance',
  symbol: 'BTC/USDT',
  action: 'BUY',
  amount_usdt: 50,
  confidence: 0.61,
  reasoning: 'paper execution smoke',
  dataCollectionPaper: true,
}, {
  traceId: 'SIG-PAPER-SMOKE-TRACE',
  reason: 'data_collection',
  marketBuyFn: async (symbol, amountUsdt, paperMode) => {
    marketBuyCalls.push({ symbol, amountUsdt, paperMode });
    if (paperMode !== true) liveOrderCalls += 1;
    return {
      filled: 0.001,
      price: 50_000,
      cost: 50,
      dryRun: true,
    };
  },
  journal: mockJournal,
  dbRun: async (sql, params) => {
    signalUpdates.push({ sql, params });
  },
  alertPublisher: (payload) => {
    alerts.push(payload);
  },
  nowFn: () => 1_764_240_000_000,
});

assert.equal(result.executed, true);
assert.equal(result.mode, 'paper');
assert.equal(result.reason, 'data_collection');
assert.equal(result.paperPositionId, 'TRD-PAPER-SMOKE-001');

assert.equal(marketBuyCalls.length, 1);
assert.deepEqual(marketBuyCalls[0], {
  symbol: 'BTC/USDT',
  amountUsdt: 50,
  paperMode: true,
});
assert.equal(liveOrderCalls, 0);

assert.equal(journalRows.length, 1);
assert.equal(journalRows[0].is_paper, true);
assert.equal(journalRows[0].trade_mode, 'paper_data');
assert.equal(journalRows[0].execution_origin, 'paper_data_collection');
assert.equal(journalRows[0].entry_price, 50_000);
assert.equal(journalRows[0].entry_size, 0.001);
assert.equal(journalRows[0].entry_value, 50);

assert.equal(signalUpdates.length, 1);
assert.match(signalUpdates[0].sql, /paper_executed/);
assert.equal(signalUpdates[0].params[0], 'SIG-PAPER-SMOKE-TRACE');
assert.equal(signalUpdates[0].params[1], 'SIG-PAPER-SMOKE-001');

assert.equal(alerts.length, 1);
assert.equal(alerts[0].payload.paperPositionId, 'TRD-PAPER-SMOKE-001');

console.log(JSON.stringify({
  ok: true,
  paperPositionCreated: journalRows.length,
  realTradeCalls: liveOrderCalls,
  statusUpdate: signalUpdates[0].params,
}, null, 2));
