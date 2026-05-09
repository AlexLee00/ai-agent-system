#!/usr/bin/env node
// @ts-nocheck

import assert from 'node:assert/strict';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';
import {
  buildLunaRelaxedProbeRunnerPlan,
  runLunaRelaxedProbeRunner,
} from './runtime-luna-relaxed-probe-runner.ts';

function fixtureWatchlist() {
  return {
    ok: true,
    status: 'near_miss_watchlist_attention',
    summary: { count: 2, symbols: ['USUAL/USDT', 'WAIT/USDT'] },
    watchlist: [
      {
        symbol: 'USUAL/USDT',
        exchange: 'binance',
        readiness: 'relaxed_probe_watch',
        nextAction: 'run_l13_probe_with_existing_risk_and_entry_guards',
        watchReason: 'crypto_relaxed_mtf_momentum_probe',
      },
      {
        symbol: 'WAIT/USDT',
        exchange: 'binance',
        readiness: 'near_miss_watch',
        nextAction: 'refresh_onchain_and_keep_tradingview_daily_guard',
      },
    ],
  };
}

export async function runLunaRelaxedProbeRunnerSmoke() {
  const plan = buildLunaRelaxedProbeRunnerPlan(fixtureWatchlist(), { maxSymbols: 1 });
  assert.equal(plan.status, 'relaxed_probe_l13_ready');
  assert.deepEqual(plan.selectedSymbols, ['USUAL/USDT']);
  assert.equal(plan.skipped[0].symbol, 'WAIT/USDT');

  const clear = buildLunaRelaxedProbeRunnerPlan({ watchlist: [] });
  assert.equal(clear.status, 'relaxed_probe_l13_clear');

  const dryRun = await runLunaRelaxedProbeRunner({
    watchlistBuilder: async () => fixtureWatchlist(),
    recentTradeCooldownLoader: async () => new Map(),
  });
  assert.equal(dryRun.ok, true);
  assert.equal(dryRun.dryRun, true);
  assert.equal(dryRun.plan.selectedSymbols[0], 'USUAL/USDT');

  const cooldown = await runLunaRelaxedProbeRunner({
    watchlistBuilder: async () => fixtureWatchlist(),
    recentTradeCooldownLoader: async () => new Map([
      ['USUAL/USDT', { symbol: 'USUAL/USDT', action: 'SELL', status: 'executed', created_at: '2026-05-09T11:58:44.880Z' }],
    ]),
  });
  assert.equal(cooldown.status, 'relaxed_probe_l13_clear');
  assert.equal(cooldown.plan.selectedSymbols.length, 0);
  assert.equal(cooldown.plan.skipped.some((item) => item.reason === 'recent_executed_trade_cooldown'), true);

  let expiredSymbols = null;
  const cooldownApplied = await runLunaRelaxedProbeRunner({
    apply: true,
    confirm: 'luna-relaxed-probe-runner',
    watchlistBuilder: async () => fixtureWatchlist(),
    recentTradeCooldownLoader: async () => new Map([
      ['USUAL/USDT', { symbol: 'USUAL/USDT', action: 'SELL', status: 'executed', created_at: '2026-05-09T11:58:44.880Z' }],
    ]),
    expireCooldownTriggers: async ({ symbols, reason }) => {
      expiredSymbols = { symbols, reason };
      return { count: symbols.length, symbols };
    },
    collectRunner: async () => {
      throw new Error('collect must not run when cooldown removes all symbols');
    },
  });
  assert.equal(cooldownApplied.ok, true);
  assert.equal(cooldownApplied.applied, false);
  assert.equal(cooldownApplied.expiredCooldownTriggers.count, 1);
  assert.deepEqual(expiredSymbols, { symbols: ['USUAL/USDT'], reason: 'recent_executed_trade_cooldown' });

  const blocked = await runLunaRelaxedProbeRunner({
    apply: true,
    confirm: null,
    watchlistBuilder: async () => fixtureWatchlist(),
    recentTradeCooldownLoader: async () => new Map(),
    collectRunner: async () => {
      throw new Error('collect must not run without confirm');
    },
  });
  assert.equal(blocked.ok, false);
  assert.equal(blocked.status, 'relaxed_probe_l13_confirm_required');

  const calls = [];
  const applied = await runLunaRelaxedProbeRunner({
    apply: true,
    confirm: 'luna-relaxed-probe-runner',
    watchlistBuilder: async () => fixtureWatchlist(),
    recentTradeCooldownLoader: async () => new Map(),
    collectRunner: async ({ market, symbols, triggerType, meta, universeMeta }) => {
      calls.push({ type: 'collect', market, symbols, triggerType, meta, universeMeta });
      assert.equal(market, 'binance');
      assert.deepEqual(symbols, ['USUAL/USDT']);
      assert.equal(triggerType, 'relaxed_probe_l13');
      assert.equal(meta.relaxed_probe_runner, true);
      assert.equal(meta.decision_execution_skipped, false);
      assert.equal(meta.disableDiscoveryExpansion, true);
      assert.equal(meta.llm_call_policy.source_enrichment, 'technical_first_only');
      assert.deepEqual(meta.agentPlan.collect.nodeIds, ['L06', 'L02']);
      return {
        sessionId: 'relaxed-probe-session',
        symbols,
        metrics: { failedHardCoreTasks: 0, collectQuality: { status: 'ready' } },
      };
    },
    decisionRunner: async ({ sessionId, symbols, exchange, meta }) => {
      calls.push({ type: 'decision', sessionId, symbols, exchange, meta });
      assert.equal(sessionId, 'relaxed-probe-session');
      assert.deepEqual(symbols, ['USUAL/USDT']);
      assert.equal(exchange, 'binance');
      assert.equal(meta.manualUniverseMode, 'explicit_symbols');
      assert.equal(meta.disableDiscoveryExpansion, true);
      assert.equal(meta.relaxed_probe_context.bySymbol['USUAL/USDT'].watchReason, 'crypto_relaxed_mtf_momentum_probe');
      return { results: [], metrics: { bridgeStatus: 'no_symbol_decisions' } };
    },
  });
  assert.equal(applied.ok, true);
  assert.equal(applied.status, 'relaxed_probe_l13_executed');
  assert.equal(applied.collect.sessionId, 'relaxed-probe-session');
  assert.deepEqual(calls.map((item) => item.type), ['collect', 'decision']);

  return {
    ok: true,
    smoke: 'luna-relaxed-probe-runner',
    selected: plan.selectedSymbols,
    callCount: calls.length,
  };
}

async function main() {
  const result = await runLunaRelaxedProbeRunnerSmoke();
  if (process.argv.includes('--json')) console.log(JSON.stringify(result, null, 2));
  else console.log('luna-relaxed-probe-runner-smoke ok');
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({
    run: main,
    errorPrefix: '❌ luna-relaxed-probe-runner-smoke 실패:',
  });
}
