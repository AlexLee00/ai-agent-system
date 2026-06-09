#!/usr/bin/env node

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { buildStressTestShadow, HISTORICAL_STRESS_SCENARIOS } from '../shared/quant/stress-test.ts';
import { runLunaMonteCarloStressShadow } from './runtime-luna-monte-carlo-stress-shadow.ts';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';

type FakeInsert = {
  sql: string;
  params: unknown[];
};

type FakeDepsOptions = {
  existingShadow?: boolean;
};

function fixtureBars(start = 100, drift = 0.2, count = 90) {
  return Array.from({ length: count }, (_, index) => {
    const close = start + index * drift + Math.sin(index / 4) * 2;
    return {
      close,
      high: close + 1,
      low: close - 1,
      volume: 1000 + index * 10,
    };
  });
}

function fakeDeps({ existingShadow = false }: FakeDepsOptions = {}) {
  const inserts: FakeInsert[] = [];
  const schemaInits: string[] = [];
  return {
    inserts,
    schemaInits,
    initSchema: async () => {
      schemaInits.push(new Date().toISOString());
      return { ok: true };
    },
    fetchBars: async () => fixtureBars(),
    query: async (sql: string) => {
      if (sql.includes('luna_risk_simulation_shadow') && existingShadow) {
        return [{
          analysis_type: 'stress_test',
          symbols: ['BTC/USDT'],
          exchange: 'binance',
          market: 'crypto',
          scenario: '2022_luna_ftx',
          simulations: 1,
          var_95: 0.45,
          var_99: 0.55,
          cvar_95: 0.53,
          cvar_99: 0.62,
          max_loss_estimate: 0.7,
          recovery_days_estimate: 90,
          risk_limits: { dailyLossPct: 0.05 },
          scenario_metrics: { riskLevel: 'critical' },
          data_health: 'ready',
          context_evidence: { source: 'fixture' },
          shadow_only: true,
          observed_at: new Date().toISOString(),
        }];
      }
      return [];
    },
    run: async (sql: string, params: unknown[]) => {
      inserts.push({ sql, params });
      return { rowCount: 1 };
    },
  };
}

export async function runLunaStressTestSmoke() {
  const investmentRoot = path.resolve(import.meta.dirname, '..');
  const migration = fs.readFileSync(path.join(investmentRoot, 'migrations/20260512_luna_risk_simulation_shadow.sql'), 'utf8');
  const bootstrap = fs.readFileSync(path.join(investmentRoot, 'shared/db/schema/tables/bootstrap.ts'), 'utf8');
  assert.match(migration, /scenario_metrics/);
  assert.match(bootstrap, /idx_luna_risk_simulation_shadow_market_scenario/);
  assert.deepEqual(Object.keys(HISTORICAL_STRESS_SCENARIOS).sort(), [
    '2008_financial_crisis',
    '2018_btc_crash',
    '2020_covid_crash',
    '2022_luna_ftx',
  ].sort());

  const stress = buildStressTestShadow({
    symbols: ['BTC/USDT'],
    exchange: 'binance',
    scenario: '2022_luna_ftx',
    barsBySymbol: { 'BTC/USDT': fixtureBars() },
  }, { source: 'fixture' });
  assert.equal(stress.ok, true);
  assert.equal(stress.analysisType, 'stress_test');
  assert.equal(stress.shadowOnly, true);
  assert.equal(stress.liveMutation, false);
  assert.equal(stress.scenarioMetrics.riskLevel, 'critical');
  assert.equal(stress.scenarioMetrics.killSwitchWouldTrigger, true);

  const dryDeps = fakeDeps();
  const planned = await runLunaMonteCarloStressShadow({
    apply: false,
    force: false,
    json: true,
    confirm: '',
    exchanges: ['binance'],
    analysis: 'stress_test',
    symbol: 'BTC/USDT',
    symbols: [],
    scenarios: ['2008_financial_crisis', '2022_luna_ftx'],
    limit: 2,
    hours: 24,
    ttlMinutes: 240,
    lookbackDays: 90,
    simulations: 200,
    horizonDays: 20,
  }, dryDeps);
  assert.equal(planned.status, 'luna_monte_carlo_stress_shadow_planned');
  assert.ok(planned.summary);
  assert.equal(planned.summary.planned, 2);
  assert.equal(dryDeps.inserts.length, 0);
  assert.equal(dryDeps.schemaInits.length, 0);

  const applyDeps = fakeDeps();
  const written = await runLunaMonteCarloStressShadow({
    apply: true,
    force: false,
    json: true,
    confirm: 'luna-monte-carlo-stress-shadow',
    exchanges: ['binance'],
    analysis: 'stress_test',
    symbol: 'BTC/USDT',
    symbols: [],
    scenarios: ['2022_luna_ftx'],
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
  assert.equal(applyDeps.inserts[0].params[0], 'stress_test');

  const cached = await runLunaMonteCarloStressShadow({
    apply: false,
    force: false,
    json: true,
    confirm: '',
    exchanges: ['binance'],
    analysis: 'stress_test',
    symbol: 'BTC/USDT',
    symbols: [],
    scenarios: ['2022_luna_ftx'],
    limit: 1,
    hours: 24,
    ttlMinutes: 240,
    lookbackDays: 90,
    simulations: 200,
    horizonDays: 20,
  }, fakeDeps({ existingShadow: true }));
  assert.equal(cached.status, 'luna_monte_carlo_stress_shadow_cached');
  assert.ok(cached.summary);
  assert.equal(cached.summary.cached, 1);

  return {
    ok: true,
    smoke: 'luna-stress-test-phase8',
    planned: planned.summary.planned,
    written: written.summary.written,
    cached: cached.summary.cached,
    riskLevel: stress.scenarioMetrics.riskLevel,
  };
}

async function main() {
  const result = await runLunaStressTestSmoke();
  console.log(JSON.stringify(result, null, 2));
}

if (isDirectExecution(import.meta.url)) {
  await (runCliMain as any)({
    run: main,
    errorPrefix: 'luna stress test smoke failed:',
  });
}
