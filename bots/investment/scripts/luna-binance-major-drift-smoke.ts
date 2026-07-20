#!/usr/bin/env node
// @ts-nocheck

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';
import { DEFAULT_BINANCE_MAJOR_WHITELIST } from '../shared/binance-top-volume-universe.ts';
import {
  buildBinanceMajorUniverseDrift,
  runBinanceMajorUniverseDrift,
} from '../shared/binance-major-universe-drift.ts';

function coinRows(symbols = DEFAULT_BINANCE_MAJOR_WHITELIST) {
  return symbols.map((symbol, index) => ({
    id: `coin-${symbol.toLowerCase().replace('/usdt', '')}`,
    symbol: symbol.split('/')[0].toLowerCase(),
    name: symbol.split('/')[0],
    market_cap: 1_000_000_000 - index * 1_000_000,
    market_cap_rank: index + 1,
  }));
}

function exchangeInfo(symbols = DEFAULT_BINANCE_MAJOR_WHITELIST, overrides = {}) {
  const all = [...new Set([...symbols, 'TON/USDT', 'DOT/USDT', 'USDC/USDT', 'PAXG/USDT', 'BTCUP/USDT'])];
  return {
    symbols: all.map((symbol) => ({
      symbol: symbol.replace('/', ''),
      baseAsset: symbol.split('/')[0],
      quoteAsset: 'USDT',
      status: overrides[symbol]?.status || 'TRADING',
      isSpotTradingAllowed: overrides[symbol]?.isSpotTradingAllowed ?? true,
    })),
  };
}

function changedCoinRows() {
  const retained = DEFAULT_BINANCE_MAJOR_WHITELIST.slice(0, 18);
  return [
    { id: 'usd-coin', symbol: 'usdc', name: 'USDC', market_cap: 2_000_000_000, market_cap_rank: 1 },
    { id: 'tether-gold', symbol: 'xaut', name: 'Tether Gold', market_cap: 1_900_000_000, market_cap_rank: 2 },
    { id: 'btc-up', symbol: 'btcup', name: 'BTCUP', market_cap: 1_800_000_000, market_cap_rank: 3 },
    ...retained.map((symbol, index) => ({
      id: `coin-${symbol.toLowerCase().replace('/usdt', '')}`,
      symbol: symbol.split('/')[0].toLowerCase(),
      name: symbol.split('/')[0],
      market_cap: 1_700_000_000 - index * 1_000_000,
      market_cap_rank: index + 4,
    })),
    { id: 'the-open-network', symbol: 'ton', name: 'Toncoin', market_cap: 1_200_000_000, market_cap_rank: 22 },
    { id: 'polkadot', symbol: 'dot', name: 'Polkadot', market_cap: 1_100_000_000, market_cap_rank: 23 },
    { id: 'uniswap', symbol: 'uni', name: 'Uniswap', market_cap: 900_000_000, market_cap_rank: 24 },
    { id: 'bittensor', symbol: 'tao', name: 'Bittensor', market_cap: 800_000_000, market_cap_rank: 25 },
  ];
}

export async function runLunaBinanceMajorDriftSmoke() {
  const now = new Date('2026-07-17T00:00:00.000Z');
  const currentSymbols = [...DEFAULT_BINANCE_MAJOR_WHITELIST];
  const info = exchangeInfo(currentSymbols, { 'GRAM/USDT': { status: 'BREAK' } });
  const proposal = buildBinanceMajorUniverseDrift({
    coinGeckoRows: changedCoinRows(),
    exchangeInfo: info,
    currentSymbols,
    generatedAt: now.toISOString(),
  });
  assert.equal(proposal.proposalOnly, true);
  assert.equal(proposal.autoApply, false);
  assert.deepEqual(proposal.additions.map((item) => item.symbol), ['TON/USDT', 'DOT/USDT']);
  assert.equal(proposal.removals.find((item) => item.symbol === 'UNI/USDT')?.reason, 'market_cap_rank_decline');
  assert.equal(proposal.removals.find((item) => item.symbol === 'GRAM/USDT')?.reason, 'binance_not_trading');
  assert.equal(proposal.proposedSymbols.length, 20);
  assert.equal(new Set(proposal.proposedSymbols).size, 20);
  assert.equal(proposal.proposedSymbols.includes('USDC/USDT'), false);
  assert.equal(proposal.proposedSymbols.includes('PAXG/USDT'), false);
  assert.equal(proposal.proposedSymbols.includes('BTCUP/USDT'), false);

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'luna-major-drift-'));
  const fetchCalls = [];
  const alarms = [];
  const fetchImpl = async (url) => {
    fetchCalls.push(String(url));
    return {
      ok: true,
      status: 200,
      json: async () => String(url).includes('coingecko') ? changedCoinRows() : info,
    };
  };
  try {
    const result = await runBinanceMajorUniverseDrift({
      currentSymbols,
      fetchImpl,
      snapshotDir: tmp,
      now,
      postAlarmFn: async (payload) => { alarms.push(payload); return { ok: true }; },
    });
    assert.equal(fetchCalls.filter((url) => url.includes('coingecko')).length, 1);
    assert.equal(fetchCalls.filter((url) => url.includes('binance')).length, 1);
    assert.equal(alarms.length, 1, 'a proposal must notify the master exactly once');
    assert.equal(result.alert.sent, true);
    assert.equal(result.snapshot.written, true);
    assert.equal(fs.existsSync(result.snapshot.path), true);
    assert.equal(result.mutation.whitelistChanged, false);

    const rejectedAlarm = await runBinanceMajorUniverseDrift({
      currentSymbols,
      coinGeckoRows: changedCoinRows(),
      exchangeInfo: info,
      writeSnapshot: false,
      now,
      postAlarmFn: async () => ({ ok: false, error: 'alerts_disabled' }),
    });
    assert.equal(rejectedAlarm.alert.sent, false, 'a rejected Hub alarm must not be reported as sent');
    assert.equal(rejectedAlarm.alert.reason, 'alarm_failed');
    assert.equal(rejectedAlarm.alert.result.error, 'alerts_disabled');

    const stableAlarms = [];
    const stable = await runBinanceMajorUniverseDrift({
      currentSymbols,
      fetchImpl: async (url) => ({
        ok: true,
        status: 200,
        json: async () => String(url).includes('coingecko') ? coinRows() : exchangeInfo(),
      }),
      snapshotDir: tmp,
      now: new Date('2026-07-24T00:00:00.000Z'),
      postAlarmFn: async (payload) => { stableAlarms.push(payload); return { ok: true }; },
    });
    assert.equal(stable.proposal.hasChanges, false);
    assert.equal(stableAlarms.length, 0, 'no-change reports must stay quiet');

    const incompleteAlarms = [];
    const incomplete = await runBinanceMajorUniverseDrift({
      currentSymbols,
      coinGeckoRows: coinRows().slice(0, 1),
      exchangeInfo: exchangeInfo(),
      writeSnapshot: false,
      postAlarmFn: async (payload) => { incompleteAlarms.push(payload); return { ok: true }; },
      now: new Date('2026-07-31T00:00:00.000Z'),
    });
    assert.equal(incomplete.ok, false);
    assert.equal(incomplete.alert.reason, 'proposal_incomplete');
    assert.equal(incompleteAlarms.length, 0, 'incomplete market data must fail closed without alerting');

    return {
      ok: true,
      smoke: 'luna-binance-major-drift',
      additions: proposal.additions.map((item) => item.symbol),
      removals: proposal.removals.map((item) => item.symbol),
      coinGeckoCalls: fetchCalls.filter((url) => url.includes('coingecko')).length,
      snapshot: path.basename(result.snapshot.path),
      proposalOnly: true,
    };
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({
    run: runLunaBinanceMajorDriftSmoke,
    onSuccess: (result) => console.log(JSON.stringify(result, null, 2)),
    errorPrefix: 'luna-binance-major-drift-smoke error:',
  });
}
