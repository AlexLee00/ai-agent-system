#!/usr/bin/env node
// @ts-nocheck

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { buildFactorModelShadow, rankFactorModelShadows } from '../shared/factor-model-shadow.ts';
import { runLunaFactorModelShadow } from './runtime-luna-factor-model-shadow.ts';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';

function fixtureTrigger(symbol = 'BTC/USDT', exchange = 'binance') {
  return {
    id: `factor-trigger-${symbol}`,
    symbol,
    exchange,
    trigger_state: 'armed',
    confidence: 0.72,
    predictive_score: 0.7,
    target_price: 100,
    trigger_context: {
      hints: { atr: 2 },
    },
    trigger_meta: {
      quoteVolume: 180000000,
      bars: [
        { close: 92, high: 94, low: 90, volume: 100 },
        { close: 94, high: 95, low: 91, volume: 120 },
        { close: 96, high: 98, low: 95, volume: 130 },
        { close: 99, high: 101, low: 97, volume: 160 },
        { close: 103, high: 105, low: 100, volume: 190 },
      ],
      fundamentals: exchange === 'binance' ? null : { pe: 16, pb: 1.4, roe: 0.14, margin: 0.12, debtToEquity: 0.5 },
    },
  };
}

function fakeDeps({ existingShadow = false } = {}) {
  const inserts = [];
  const schemaInits = [];
  const listCalls = [];
  return {
    inserts,
    schemaInits,
    listCalls,
    initSchema: async () => {
      schemaInits.push(new Date().toISOString());
      return { ok: true };
    },
    listActiveEntryTriggers: async (args) => {
      listCalls.push(args);
      if (args.exchange === 'binance') return [fixtureTrigger('BTC/USDT', 'binance'), fixtureTrigger('ETH/USDT', 'binance')].slice(0, Number(args.limit || 2));
      if (args.exchange === 'kis_overseas') return [fixtureTrigger('NVDA', 'kis_overseas')].slice(0, Number(args.limit || 1));
      return [];
    },
    fetchMarketFactorContext: async (candidate) => candidate,
    query: async (sql) => {
      if (sql.includes('luna_factor_model_shadow') && existingShadow) {
        return [{
          symbol: 'BTC/USDT',
          exchange: 'binance',
          market: 'crypto',
          factor_scores: { momentum: { score: 0.7, available: true } },
          composite_score: 0.7,
          rank: 1,
          allocation_hint: { tier: 'medium_shadow_candidate' },
          data_health: 'ready',
          shadow_only: true,
          observed_at: new Date().toISOString(),
        }];
      }
      if (sql.includes('market_regime_snapshots')) {
        return [{
          market: 'crypto',
          regime: 'trending_bull',
          confidence: 0.8,
          indicators: { marketReturn: 0.04 },
          captured_at: new Date().toISOString(),
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

export async function runLunaFactorModelSmoke() {
  const investmentRoot = path.resolve(import.meta.dirname, '..');
  const migration = fs.readFileSync(path.join(investmentRoot, 'migrations/20260512_luna_factor_model_shadow.sql'), 'utf8');
  const bootstrap = fs.readFileSync(path.join(investmentRoot, 'shared/db/schema/tables/bootstrap.ts'), 'utf8');
  assert.match(migration, /luna_factor_model_shadow/);
  assert.match(migration, /factor_scores/);
  assert.match(migration, /allocation_hint/);
  assert.match(bootstrap, /CREATE TABLE IF NOT EXISTS luna_factor_model_shadow/);
  assert.match(bootstrap, /idx_luna_factor_model_shadow_symbol_observed/);

  const cryptoShadow = buildFactorModelShadow({
    symbol: 'BTC/USDT',
    exchange: 'binance',
    confidence: 0.75,
    predictiveScore: 0.72,
    quoteVolume: 200000000,
    bars: fixtureTrigger().trigger_meta.bars,
  }, { marketContext: { marketReturn: 0.02 } });
  assert.equal(cryptoShadow.ok, true);
  assert.equal(cryptoShadow.market, 'crypto');
  assert(cryptoShadow.compositeScore > 0.5);
  assert.equal(cryptoShadow.factorScores.value, undefined);
  assert.notEqual(cryptoShadow.dataHealth, 'insufficient');

  const stockShadow = buildFactorModelShadow({
    symbol: 'NVDA',
    exchange: 'kis_overseas',
    confidence: 0.7,
    fundamentals: { pe: 20, pb: 2, roe: 0.18, margin: 0.2, debtToEquity: 0.3 },
    bars: fixtureTrigger('NVDA', 'kis_overseas').trigger_meta.bars,
  }, { marketContext: { marketReturn: 0.01 } });
  assert.equal(stockShadow.market, 'overseas');
  assert.equal(stockShadow.factorScores.value.available, true);
  assert.equal(stockShadow.factorScores.quality.available, true);

  const ranked = rankFactorModelShadows([cryptoShadow, { ...cryptoShadow, symbol: 'ETH/USDT', compositeScore: 0.51 }]);
  assert.equal(ranked.find((row) => row.symbol === 'BTC/USDT').rank, 1);
  assert.equal(ranked.find((row) => row.symbol === 'ETH/USDT').rank, 2);

  const dryDeps = fakeDeps();
  const planned = await runLunaFactorModelShadow({
    apply: false,
    confirm: '',
    exchanges: ['binance'],
    limit: 5,
    hours: 24,
    ttlMinutes: 240,
  }, dryDeps);
  assert.equal(planned.status, 'luna_factor_model_shadow_planned');
  assert.equal(planned.summary.llmCalls, 0);
  assert.equal(planned.summary.liveMutation, false);
  assert.equal(dryDeps.inserts.length, 0);
  assert.equal(dryDeps.schemaInits.length, 0);
  assert.equal(dryDeps.listCalls[0].states.includes('fired'), true);

  const applyDeps = fakeDeps();
  const written = await runLunaFactorModelShadow({
    apply: true,
    confirm: 'luna-factor-model-shadow',
    exchanges: ['binance'],
    limit: 5,
    hours: 24,
    ttlMinutes: 240,
  }, applyDeps);
  assert.equal(written.status, 'luna_factor_model_shadow_written');
  assert.equal(written.summary.written, 2);
  assert.equal(applyDeps.schemaInits.length, 1);
  assert.equal(applyDeps.inserts.length, 2);
  assert.equal(JSON.parse(applyDeps.inserts[0].params[3]).momentum.available, true);

  const cachedDeps = fakeDeps({ existingShadow: true });
  const cached = await runLunaFactorModelShadow({
    apply: false,
    confirm: '',
    exchanges: ['binance'],
    limit: 1,
    hours: 24,
    ttlMinutes: 240,
  }, cachedDeps);
  assert.equal(cached.status, 'luna_factor_model_shadow_cached');
  assert.equal(cached.summary.cached, 1);
  assert.equal(cachedDeps.inserts.length, 0);

  return {
    ok: true,
    smoke: 'luna-factor-model-phase5',
    planned: planned.summary.planned,
    written: written.summary.written,
    cached: cached.summary.cached,
  };
}

async function main() {
  const result = await runLunaFactorModelSmoke();
  console.log(JSON.stringify(result, null, 2));
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({
    run: main,
    errorPrefix: '❌ luna factor model smoke 실패:',
  });
}
