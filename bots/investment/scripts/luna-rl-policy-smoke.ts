#!/usr/bin/env node

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  buildRlPolicyShadow,
  buildRlStateVector,
} from '../shared/rl-policy-shadow.ts';
import { runLunaRlPolicyShadow } from './runtime-luna-rl-policy-shadow.ts';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';

type Bar = {
  close: number;
  high: number;
  low: number;
  volume: number;
};

type FakeInsert = {
  sql: string;
  params: unknown[];
};

type FakeDeps = {
  inserts: FakeInsert[];
  schemaInits: string[];
  initSchema: () => Promise<{ ok: boolean }>;
  listActiveEntryTriggers: (args: { exchange?: string }) => Promise<Array<{ symbol: string; trigger_state: string }>>;
  fetchBars: (symbol: string) => Promise<Bar[]>;
  query: (sql: string) => Promise<Array<Record<string, unknown>>>;
  run: (sql: string, params: unknown[]) => Promise<{ rowCount: number }>;
};

function fixtureBars(start = 100, drift = 1, count = 40) {
  return Array.from({ length: count }, (_, index) => {
    const close = start + index * drift + Math.sin(index / 4) * 1.5;
    return {
      close,
      high: close + 1,
      low: close - 1,
      volume: 1000 + index * 10,
    };
  });
}

function fakeDeps({ existingShadow = false } = {}): FakeDeps {
  const inserts: FakeInsert[] = [];
  const schemaInits: string[] = [];
  return {
    inserts,
    schemaInits,
    initSchema: async () => {
      schemaInits.push(new Date().toISOString());
      return { ok: true };
    },
    listActiveEntryTriggers: async (args) => {
      if (args.exchange !== 'binance') return [];
      return [{ symbol: 'BTC/USDT', trigger_state: 'armed' }];
    },
    fetchBars: async (symbol: string) => {
      if (symbol.includes('ETH')) return fixtureBars(60, 0.45);
      if (symbol.includes('SOL')) return fixtureBars(30, 0.18);
      if (/^\d{6}$/.test(symbol)) return fixtureBars(100, 0.32);
      if (/^[A-Z]{1,5}$/.test(symbol)) return fixtureBars(150, 0.55);
      return fixtureBars(100, 0.8);
    },
    query: async (sql: string) => {
      if (sql.includes('luna_rl_policy_shadow') && existingShadow) {
        return [{
          symbol: 'BTC/USDT',
          exchange: 'binance',
          market: 'crypto',
          state_vector: { featureNames: ['momentum20'], values: [0.6] },
          action: 0.12,
          action_type: 'buy',
          action_size_pct: 0.0144,
          confidence: 0.42,
          reward_estimate: 0.02,
          model_status: 'missing_optional_deps_or_model',
          data_health: 'ready',
          context_evidence: { source: 'fixture' },
          shadow_only: true,
          observed_at: new Date().toISOString(),
        }];
      }
      if (sql.includes('luna_factor_model_shadow')) {
        return [{
          symbol: 'BTC/USDT',
          exchange: 'binance',
          market: 'crypto',
          factor_scores: { momentum: { score: 0.7 } },
          composite_score: 0.72,
          rank: 1,
          allocation_hint: { tier: 'strong_shadow_candidate' },
          data_health: 'ready',
          observed_at: new Date().toISOString(),
        }];
      }
      if (sql.includes('luna_stat_arb_shadow')) {
        return [{
          strategy_type: 'mean_reversion',
          symbols: ['BTC/USDT'],
          exchange: 'binance',
          market: 'crypto',
          signal: 'mean_reversion_watch',
          z_score: -1.6,
          confidence: 0.45,
          data_health: 'ready',
          observed_at: new Date().toISOString(),
        }];
      }
      if (sql.includes('luna_regime_llm_shadow')) {
        return [{
          market: 'crypto',
          rule_regime: 'trending_bull',
          rule_confidence: 0.62,
          llm_regime: 'trending_bull',
          llm_confidence: 0.66,
          match: true,
          captured_at: new Date().toISOString(),
        }];
      }
      if (sql.includes('luna_entry_llm_shadow')) {
        return [{
          symbol: 'BTC/USDT',
          exchange: 'binance',
          market: 'crypto',
          trigger_id: 'trigger-1',
          llm_fire: true,
          llm_confidence: 0.68,
          dynamic_threshold: 0.6,
          position_size_pct: 0.06,
          reasoning: 'fixture entry shadow',
          observed_at: new Date().toISOString(),
        }];
      }
      if (sql.includes('investment.positions')) {
        return [{
          symbol: 'BTC/USDT',
          exchange: 'binance',
          amount: 0.01,
          avg_price: 80000,
          unrealized_pnl: 0.02,
          paper: false,
          updated_at: new Date().toISOString(),
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

export async function runLunaRlPolicySmoke() {
  const investmentRoot = path.resolve(import.meta.dirname, '..');
  const migration = fs.readFileSync(path.join(investmentRoot, 'migrations/20260512_luna_rl_policy_shadow.sql'), 'utf8');
  const bootstrap = fs.readFileSync(path.join(investmentRoot, 'shared/db/schema/tables/bootstrap.ts'), 'utf8');
  assert.match(migration, /luna_rl_policy_shadow/);
  assert.match(migration, /state_vector/);
  assert.match(migration, /reward_estimate/);
  assert.match(bootstrap, /CREATE TABLE IF NOT EXISTS luna_rl_policy_shadow/);
  assert.match(bootstrap, /idx_luna_rl_policy_shadow_market_action/);

  const state = buildRlStateVector({
    symbol: 'BTC/USDT',
    exchange: 'binance',
    bars: fixtureBars(),
    factorEvidence: { compositeScore: 0.7 },
    entryEvidence: { confidence: 0.68 },
    regimeEvidence: { confidence: 0.62 },
  });
  assert.equal(state.values.length, 12);
  assert.equal(state.dataHealth, 'ready');

  const policy = buildRlPolicyShadow({
    symbol: 'BTC/USDT',
    exchange: 'binance',
    bars: fixtureBars(),
    factorEvidence: { compositeScore: 0.72 },
    statArbEvidence: { confidence: 0.45 },
    entryEvidence: { confidence: 0.68 },
    regimeEvidence: { confidence: 0.62 },
  });
  assert.equal(policy.ok, true);
  assert.equal(policy.shadowOnly, true);
  assert.equal(policy.liveMutation, false);
  assert.equal(['buy', 'hold', 'sell'].includes(policy.actionType), true);

  const noPositionSellSuppressed = buildRlPolicyShadow({
    symbol: 'RISK/USDT',
    exchange: 'binance',
    bars: fixtureBars(100, -1.2),
    portfolio: { positionPct: 0, cashPct: 1 },
  });
  assert.equal(noPositionSellSuppressed.actionType, 'hold');
  assert.equal(noPositionSellSuppressed.evidence.sellSuppressedNoPosition, true);

  const insufficient = buildRlPolicyShadow({ symbol: '005930', exchange: 'kis', bars: [] });
  assert.equal(insufficient.dataHealth, 'insufficient');

  const dryDeps = fakeDeps();
  const planned = await runLunaRlPolicyShadow({
    apply: false,
    force: false,
    json: false,
    confirm: '',
    exchanges: ['binance'],
    symbol: null,
    limit: 3,
    hours: 24,
    ttlMinutes: 240,
    lookbackDays: 90,
    maxInferenceCalls: 0,
  }, dryDeps);
  assert.equal(planned.status, 'luna_rl_policy_shadow_planned');
  assert.ok(planned.summary);
  assert.equal(planned.summary.liveMutation, false);
  assert.equal(planned.summary.externalInferenceCalls, 0);
  assert.equal(dryDeps.inserts.length, 0);
  assert.equal(dryDeps.schemaInits.length, 0);
  const btcRuntimeRow = planned.rows.find((row) => row.symbol === 'BTC/USDT');
  assert.ok(btcRuntimeRow);
  const btcEvidence = btcRuntimeRow.evidence as Record<string, any>;
  assert.equal(btcEvidence.regimeSource, 'investment.luna_regime_llm_shadow');
  assert.equal(btcEvidence.entrySource, 'investment.luna_entry_llm_shadow');
  assert.equal(btcEvidence.factorSource, 'investment.luna_factor_model_shadow');
  assert.equal(btcEvidence.statArbSource, 'investment.luna_stat_arb_shadow');
  assert.equal(btcEvidence.sellSuppressedNoPosition, false);

  const applyDeps = fakeDeps();
  const written = await runLunaRlPolicyShadow({
    apply: true,
    force: false,
    json: false,
    confirm: 'luna-rl-policy-shadow',
    exchanges: ['binance'],
    symbol: 'BTC/USDT',
    limit: 1,
    hours: 24,
    ttlMinutes: 240,
    lookbackDays: 90,
    maxInferenceCalls: 0,
  }, applyDeps);
  assert.equal(written.status, 'luna_rl_policy_shadow_written');
  assert.ok(written.summary);
  assert.equal(written.summary.written, 1);
  assert.equal(applyDeps.schemaInits.length, 1);
  assert.equal(JSON.parse(String(applyDeps.inserts[0].params[3])).values.length, 12);

  const cachedDeps = fakeDeps({ existingShadow: true });
  const cached = await runLunaRlPolicyShadow({
    apply: false,
    force: false,
    json: false,
    confirm: '',
    exchanges: ['binance'],
    symbol: 'BTC/USDT',
    limit: 1,
    hours: 24,
    ttlMinutes: 240,
    lookbackDays: 90,
    maxInferenceCalls: 0,
  }, cachedDeps);
  assert.equal(cached.status, 'luna_rl_policy_shadow_cached');
  assert.ok(cached.summary);
  assert.equal(cached.summary.cached, 1);

  return {
    ok: true,
    smoke: 'luna-rl-policy-phase7',
    planned: planned.summary.planned,
    written: written.summary.written,
    cached: cached.summary.cached,
    actionType: policy.actionType,
  };
}

async function main() {
  const result = await runLunaRlPolicySmoke();
  console.log(JSON.stringify(result, null, 2));
}

if (isDirectExecution(import.meta.url)) {
  await (runCliMain as (opts: { run: () => Promise<void>; errorPrefix?: string }) => Promise<void>)({
    run: main,
    errorPrefix: 'luna rl policy smoke failed:',
  });
}
