#!/usr/bin/env node

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { buildMonteCarloShadow } from '../shared/quant/monte-carlo.ts';
import { binanceSymbol, runLunaMonteCarloStressShadow } from './runtime-luna-monte-carlo-stress-shadow.ts';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';

type FakeInsert = {
  sql: string;
  params: unknown[];
};

type FakeQuery = FakeInsert;

type FakeDepsOptions = {
  existingShadow?: boolean;
};

function fixtureBars(start = 100, drift = 0.8, count = 90) {
  return Array.from({ length: count }, (_, index) => {
    const close = start + index * drift + Math.sin(index / 5) * 1.2;
    return {
      close,
      high: close + 1,
      low: close - 1,
      volume: 1000 + index * 20,
    };
  });
}

function fakeDeps({ existingShadow = false }: FakeDepsOptions = {}) {
  const inserts: FakeInsert[] = [];
  const schemaInits: string[] = [];
  const queries: FakeQuery[] = [];
  return {
    inserts,
    schemaInits,
    queries,
    initSchema: async () => {
      schemaInits.push(new Date().toISOString());
      return { ok: true };
    },
    fetchBars: async (symbol: string, exchange?: string, options?: Record<string, any>) => {
      if (symbol.includes('ETH')) return fixtureBars(60, 0.45);
      if (symbol.includes('SOL')) return fixtureBars(30, 0.24);
      return fixtureBars(100, 0.75);
    },
    query: async (sql: string, params: any[] = []) => {
      queries.push({ sql, params });
      if (sql.includes('luna_risk_simulation_shadow') && existingShadow) {
        return [{
          analysis_type: 'monte_carlo',
          symbols: ['BTC/USDT'],
          exchange: 'binance',
          market: 'crypto',
          scenario: 'base',
          simulations: 1000,
          var_95: 0.08,
          var_99: 0.12,
          cvar_95: 0.10,
          cvar_99: 0.15,
          max_loss_estimate: 0.18,
          recovery_days_estimate: 24,
          risk_limits: { dailyLossPct: 0.05 },
          scenario_metrics: { inputReturns: 89 },
          data_health: 'ready',
          context_evidence: { source: 'fixture' },
          shadow_only: true,
          observed_at: new Date().toISOString(),
        }];
      }
      return [];
    },
    run: async (sql: string, params: any[] = []) => {
      inserts.push({ sql, params });
      return { rowCount: 1 };
    },
  };
}

export async function runLunaMonteCarloSmoke() {
  const investmentRoot = path.resolve(import.meta.dirname, '..');
  const migration = fs.readFileSync(path.join(investmentRoot, 'migrations/20260512_luna_risk_simulation_shadow.sql'), 'utf8');
  const bootstrap = fs.readFileSync(path.join(investmentRoot, 'shared/db/schema/tables/bootstrap.ts'), 'utf8');
  assert.match(migration, /luna_risk_simulation_shadow/);
  assert.match(migration, /var_95/);
  assert.match(migration, /cvar_99/);
  assert.match(bootstrap, /CREATE TABLE IF NOT EXISTS luna_risk_simulation_shadow/);
  assert.match(bootstrap, /idx_luna_risk_simulation_shadow_type_observed/);
  assert.equal(binanceSymbol('BINANCE:BTCUSDT'), 'BTCUSDT');
  assert.equal(binanceSymbol('BINANCE:BTC/USDT'), 'BTCUSDT');
  assert.equal(binanceSymbol('BTC/USDT'), 'BTCUSDT');

  const shadow = buildMonteCarloShadow({
    symbols: ['BTC/USDT'],
    exchange: 'binance',
    scenario: 'black_swan',
    simulations: 250,
    horizonDays: 20,
    barsBySymbol: { 'BTC/USDT': fixtureBars() },
  }, { source: 'fixture' });
  assert.equal(shadow.ok, true);
  assert.equal(shadow.analysisType, 'monte_carlo');
  assert.equal(shadow.shadowOnly, true);
  assert.equal(shadow.liveMutation, false);
  assert.equal(shadow.dataHealth, 'ready');
  assert.equal(shadow.var95 >= 0, true);
  assert.equal(shadow.cvar95 >= shadow.var95, true);

  const insufficient = buildMonteCarloShadow({ symbols: ['NEW/USDT'], exchange: 'binance', barsBySymbol: {} });
  assert.equal(insufficient.dataHealth, 'insufficient');

  const dryDeps = fakeDeps();
  const planned = await runLunaMonteCarloStressShadow({
    apply: false,
    force: false,
    json: true,
    confirm: '',
    exchanges: ['binance'],
    analysis: 'monte_carlo',
    symbol: 'BTC/USDT',
    symbols: [],
    scenarios: ['base', 'black_swan'],
    limit: 3,
    hours: 24,
    ttlMinutes: 240,
    lookbackDays: 90,
    simulations: 200,
    horizonDays: 20,
  }, dryDeps);
  assert.equal(planned.status, 'luna_monte_carlo_stress_shadow_planned');
  assert.ok(planned.summary);
  assert.equal(planned.summary.planned, 2);
  assert.equal(planned.summary.liveMutation, false);
  assert.equal(dryDeps.inserts.length, 0);
  assert.equal(dryDeps.schemaInits.length, 0);

  const applyDeps = fakeDeps();
  const written = await runLunaMonteCarloStressShadow({
    ...planned,
    apply: true,
    force: false,
    json: true,
    confirm: 'luna-monte-carlo-stress-shadow',
    exchanges: ['binance'],
    analysis: 'monte_carlo',
    symbol: 'BTC/USDT',
    symbols: [],
    scenarios: ['base'],
    limit: 1,
    hours: 24,
    ttlMinutes: 240,
    lookbackDays: 90,
    simulations: 200,
    horizonDays: 20,
  }, applyDeps);
  assert.equal(written.status, 'luna_monte_carlo_stress_shadow_written');
  assert.ok(written.summary);
  assert.equal(written.summary.written, 1);
  assert.equal(applyDeps.schemaInits.length, 1);
  assert.equal(JSON.parse(String(applyDeps.inserts[0].params[1]))[0], 'BTC/USDT');

  const cachedDeps = fakeDeps({ existingShadow: true });
  const cached = await runLunaMonteCarloStressShadow({
    apply: false,
    force: false,
    json: true,
    confirm: '',
    exchanges: ['binance'],
    analysis: 'monte_carlo',
    symbol: 'BTC/USDT',
    symbols: [],
    scenarios: ['BASE'],
    limit: 1,
    hours: 24,
    ttlMinutes: 240,
    lookbackDays: 90,
    simulations: 200,
    horizonDays: 20,
  }, cachedDeps);
  assert.equal(cached.status, 'luna_monte_carlo_stress_shadow_cached');
  assert.ok(cached.summary);
  assert.equal(cached.summary.cached, 1);
  assert.equal(cachedDeps.queries[0].params[2], 'base');

  return {
    ok: true,
    smoke: 'luna-monte-carlo-phase8',
    planned: planned.summary.planned,
    written: written.summary.written,
    cached: cached.summary.cached,
    var95: shadow.var95,
  };
}

async function main() {
  const result = await runLunaMonteCarloSmoke();
  console.log(JSON.stringify(result, null, 2));
}

if (isDirectExecution(import.meta.url)) {
  await (runCliMain as any)({
    run: main,
    errorPrefix: 'luna monte carlo smoke failed:',
  });
}
