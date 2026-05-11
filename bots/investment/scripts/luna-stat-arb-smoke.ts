#!/usr/bin/env node

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  buildMeanReversionShadow,
  buildPairsTradingShadow,
  defaultStatArbPairs,
} from '../shared/stat-arb-shadow.ts';
import { runLunaStatArbShadow } from './runtime-luna-stat-arb-shadow.ts';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';

function fixtureBars(start = 100, drift = 1, count = 40) {
  return Array.from({ length: count }, (_, index) => {
    const close = start + index * drift + Math.sin(index / 3) * 2;
    return {
      close,
      high: close + 1,
      low: close - 1,
      volume: 1000 + index * 10,
    };
  });
}

function fakeDeps({ existingShadow = false } = {}) {
  const inserts = [];
  const schemaInits = [];
  return {
    inserts,
    schemaInits,
    initSchema: async () => {
      schemaInits.push(new Date().toISOString());
      return { ok: true };
    },
    listActiveEntryTriggers: async (args) => {
      if (args.exchange !== 'binance') return [];
      return [
        { symbol: 'BTC/USDT', trigger_state: 'armed' },
        { symbol: 'ETH/USDT', trigger_state: 'waiting' },
      ];
    },
    fetchBars: async (symbol) => {
      if (symbol.includes('ETH')) return fixtureBars(50, 0.48);
      if (symbol.includes('SOL')) return fixtureBars(20, 0.2);
      if (symbol.includes('000660') || symbol.includes('000270')) return fixtureBars(80, 0.35);
      if (symbol.includes('MSFT') || symbol.includes('AMD') || symbol.includes('QQQ')) return fixtureBars(150, 0.4);
      if (symbol.includes('BTC')) return fixtureBars(100, 1);
      if (/^\d{6}$/.test(symbol)) return fixtureBars(100, 0.42);
      if (/^[A-Z]{1,5}$/.test(symbol)) return fixtureBars(120, 0.5);
      return [];
    },
    query: async (sql) => {
      if (sql.includes('luna_stat_arb_shadow') && existingShadow) {
        return [{
          strategy_type: 'mean_reversion',
          symbols: ['BTC/USDT'],
          exchange: 'binance',
          market: 'crypto',
          pair_metrics: {},
          mean_reversion_metrics: { samples: 40 },
          signal: 'neutral',
          z_score: 0.2,
          confidence: 0.1,
          data_health: 'ready',
          shadow_only: true,
          observed_at: new Date().toISOString(),
        }];
      }
      return [];
    },
    run: async (sql, params) => {
      inserts.push({ sql, params });
      return { rowCount: 1 };
    },
  };
}

export async function runLunaStatArbSmoke() {
  const investmentRoot = path.resolve(import.meta.dirname, '..');
  const migration = fs.readFileSync(path.join(investmentRoot, 'migrations/20260512_luna_stat_arb_shadow.sql'), 'utf8');
  const bootstrap = fs.readFileSync(path.join(investmentRoot, 'shared/db/schema/tables/bootstrap.ts'), 'utf8');
  assert.match(migration, /luna_stat_arb_shadow/);
  assert.match(migration, /pair_metrics/);
  assert.match(migration, /mean_reversion_metrics/);
  assert.match(bootstrap, /CREATE TABLE IF NOT EXISTS luna_stat_arb_shadow/);
  assert.match(bootstrap, /idx_luna_stat_arb_shadow_symbols/);

  assert.deepEqual(defaultStatArbPairs('binance')[0], ['BTC/USDT', 'ETH/USDT']);
  assert.deepEqual(defaultStatArbPairs('kis')[0], ['005930', '000660']);

  const pairShadow = buildPairsTradingShadow({
    symbols: ['BTC/USDT', 'ETH/USDT'],
    exchange: 'binance',
    barsA: fixtureBars(100, 1),
    barsB: fixtureBars(50, 0.5),
  });
  assert.equal(pairShadow.ok, true);
  assert.equal(pairShadow.strategyType, 'pairs_trading');
  assert.equal(pairShadow.dataHealth, 'ready');
  assert.equal(pairShadow.shadowOnly, true);

  const mrShadow = buildMeanReversionShadow({
    symbol: 'BTC/USDT',
    exchange: 'binance',
    bars: fixtureBars(100, -0.25),
  });
  assert.equal(mrShadow.ok, true);
  assert.equal(mrShadow.strategyType, 'mean_reversion');
  assert.equal(mrShadow.dataHealth, 'ready');

  const insufficient = buildPairsTradingShadow({
    symbols: ['005930', '000660'],
    exchange: 'kis',
    barsA: [],
    barsB: [],
  });
  assert.equal(insufficient.dataHealth, 'insufficient');
  assert.equal(insufficient.signal, 'missing_data');

  const dryDeps = fakeDeps();
  const planned = await runLunaStatArbShadow({
    apply: false,
    force: false,
    confirm: '',
    exchanges: ['binance'],
    strategy: 'all',
    limit: 5,
    hours: 24,
    ttlMinutes: 240,
    lookbackDays: 90,
  }, dryDeps);
  assert.equal(planned.status, 'luna_stat_arb_shadow_planned');
  assert.equal(planned.summary.liveMutation, false);
  assert.equal(dryDeps.inserts.length, 0);
  assert.equal(dryDeps.schemaInits.length, 0);

  const kisPlanned = await runLunaStatArbShadow({
    apply: false,
    force: false,
    confirm: '',
    exchanges: ['kis'],
    strategy: 'all',
    limit: 5,
    hours: 24,
    ttlMinutes: 240,
    lookbackDays: 90,
  }, fakeDeps());
  assert.equal(kisPlanned.status, 'luna_stat_arb_shadow_planned');
  assert.equal(kisPlanned.summary.insufficient, 0);
  assert.equal(kisPlanned.rows.some((row) => row?.evidence?.source === 'missing_external_price_history'), false);

  const overseasPlanned = await runLunaStatArbShadow({
    apply: false,
    force: false,
    confirm: '',
    exchanges: ['kis_overseas'],
    strategy: 'all',
    limit: 5,
    hours: 24,
    ttlMinutes: 240,
    lookbackDays: 90,
  }, fakeDeps());
  assert.equal(overseasPlanned.status, 'luna_stat_arb_shadow_planned');
  assert.equal(overseasPlanned.summary.insufficient, 0);
  assert.equal(overseasPlanned.rows.some((row) => row?.evidence?.source === 'missing_external_price_history'), false);

  const applyDeps = fakeDeps();
  const written = await runLunaStatArbShadow({
    apply: true,
    force: false,
    confirm: 'luna-stat-arb-shadow',
    exchanges: ['binance'],
    strategy: 'mean_reversion',
    limit: 2,
    hours: 24,
    ttlMinutes: 240,
    lookbackDays: 90,
  }, applyDeps);
  assert.equal(written.status, 'luna_stat_arb_shadow_written');
  assert.equal(written.summary.written > 0, true);
  assert.equal(applyDeps.schemaInits.length, 1);
  assert.equal(JSON.parse(applyDeps.inserts[0].params[1]).length, 1);

  const cachedDeps = fakeDeps({ existingShadow: true });
  const cached = await runLunaStatArbShadow({
    apply: false,
    force: false,
    confirm: '',
    exchanges: ['binance'],
    strategy: 'mean_reversion',
    symbol: 'BTC/USDT',
    limit: 1,
    hours: 24,
    ttlMinutes: 240,
    lookbackDays: 90,
  }, cachedDeps);
  assert.equal(cached.status, 'luna_stat_arb_shadow_cached');
  assert.equal(cached.summary.cached, 1);

  return {
    ok: true,
    smoke: 'luna-stat-arb-phase6',
    planned: planned.summary.planned,
    kisPlanned: kisPlanned.summary.planned,
    overseasPlanned: overseasPlanned.summary.planned,
    written: written.summary.written,
    cached: cached.summary.cached,
  };
}

async function main() {
  const result = await runLunaStatArbSmoke();
  console.log(JSON.stringify(result, null, 2));
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({
    run: main,
    errorPrefix: 'luna stat arb smoke failed:',
  });
}
