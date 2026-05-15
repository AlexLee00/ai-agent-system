#!/usr/bin/env node
// @ts-nocheck

import assert from 'node:assert/strict';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';
import {
  auditLunaDeploymentConsistency,
  extractLunaDeploymentSpecHash,
} from '../shared/luna-deployment-spec.ts';
import { buildPosttradeMutationCandidates } from '../shared/luna-phase3-posttrade-mutation.ts';
import { buildLunaPaperTradingPlan, buildLunaWeightVector } from '../shared/luna-weight-vector.ts';
import { runLunaDeploymentConsistencyShadow } from './runtime-luna-deployment-consistency-shadow.ts';
import { runLunaPosttradeMutationShadow } from './runtime-luna-posttrade-mutation-shadow.ts';

function fixtureTrades() {
  const exitTime = Date.parse('2026-05-14T00:00:00.000Z');
  return [
    { id: '1', trade_id: '1', symbol: 'BTC/USDT', market: 'crypto', exchange: 'binance', status: 'closed', is_paper: false, exit_time: exitTime, pnl_percent: -1.2, strategy_family: 'momentum_rotation' },
    { id: '2', trade_id: '2', symbol: 'BTC/USDT', market: 'crypto', exchange: 'binance', status: 'closed', is_paper: false, exit_time: exitTime - 60_000, pnl_percent: -3.1, strategy_family: 'momentum_rotation' },
    { id: '3', trade_id: '3', symbol: 'ETH/USDT', market: 'crypto', exchange: 'binance', status: 'closed', is_paper: false, exit_time: exitTime - 120_000, pnl_percent: -0.6, strategy_family: 'trend_following' },
  ];
}

export async function runLunaPhase3CodexP1Smoke() {
  const candidates = buildPosttradeMutationCandidates(fixtureTrades());
  assert.ok(candidates.some((row) => row.mutationType === 'candidate_downweight' && row.symbol === 'BTC/USDT'), 'BTC downweight staged');
  assert.ok(candidates.some((row) => row.mutationType === 'size_multiplier' && row.symbol === 'BTC/USDT'), 'BTC size multiplier staged');
  assert.ok(candidates.some((row) => row.mutationType === 'setup_block' && row.symbol === 'BTC/USDT'), 'BTC setup block staged');
  assert.equal(candidates.every((row) => row.shadowOnly === true), true, 'all mutation candidates shadow-only');
  assert.equal(candidates.every((row) => row.requiresMasterConfirm === true), true, 'all mutation candidates require master confirm');

  const runtimeMutation = await runLunaPosttradeMutationShadow({ fixture: true, dryRun: true, apply: false, json: true });
  assert.equal(runtimeMutation.ok, true);
  assert.equal(runtimeMutation.writeMode, 'plan-only');
  assert.equal(runtimeMutation.summary.liveMutation, false);
  assert.ok(runtimeMutation.summary.staged >= 3);
  await assert.rejects(
    () => runLunaPosttradeMutationShadow({ fixture: true, dryRun: true, apply: true, confirm: 'luna-phase3-posttrade-mutation', json: true }),
    /cannot combine --apply with --dry-run/,
    'posttrade runtime rejects ambiguous dry-run apply',
  );

  const now = '2026-05-14T00:00:00.000Z';
  const weight = buildLunaWeightVector({
    asOf: now,
    candidate: { symbol: 'BTC/USDT', market: 'crypto', score: 0.9, discovered_at: now },
    backtest: { fresh: true, healthy: true, sharpe: 1.1, win_rate: 55, max_drawdown: 10, last_backtest_at: now },
    predictive: { decision: 'pass_prediction', score: 0.8, threshold: 0.55, component_coverage: 0.86, created_at: now },
    community: { avg_score: 0.4, source_count: 3, last_seen_at: now },
  });
  const paper = buildLunaPaperTradingPlan(weight, {
    position: { amount: 0, avg_price: 65000 },
    equityUsdt: 1000,
    maxOrderUsdt: 50,
    minNotionalUsdt: 5,
  });
  assert.ok(extractLunaDeploymentSpecHash(weight), 'weight vector has deployment spec hash');
  assert.equal(extractLunaDeploymentSpecHash(weight), extractLunaDeploymentSpecHash(paper), 'paper inherits spec hash');
  const audit = auditLunaDeploymentConsistency({ weightVector: weight, paperPlan: paper });
  assert.equal(audit.liveBacktestConsistent, true, 'paper and weight use same spec');
  const tamperedPaper = { ...paper, evidence: { ...paper.evidence, decisionSpecHash: 'tampered' } };
  const tamperedAudit = auditLunaDeploymentConsistency({ weightVector: weight, paperPlan: tamperedPaper });
  assert.equal(tamperedAudit.liveBacktestConsistent, false, 'spec mismatch is detected');
  assert.ok(tamperedAudit.reasons.includes('spec_hash_mismatch'));

  const consistencyRuntime = await runLunaDeploymentConsistencyShadow({ fixture: true, dryRun: true, apply: false, json: true });
  assert.equal(consistencyRuntime.ok, true);
  assert.equal(consistencyRuntime.writeMode, 'plan-only');
  assert.equal(consistencyRuntime.summary.liveMutation, false);
  assert.equal(consistencyRuntime.summary.inconsistent, 0);
  let capturedConsistencyLoadArgs = null;
  const consistencyAllMarketRuntime = await runLunaDeploymentConsistencyShadow({
    dryRun: true,
    apply: false,
    json: true,
    market: 'all',
  }, {
    loadPairs: async (args) => {
      capturedConsistencyLoadArgs = args;
      return [];
    },
  });
  assert.equal(consistencyAllMarketRuntime.ok, true);
  assert.equal(consistencyAllMarketRuntime.market, 'all');
  assert.equal(capturedConsistencyLoadArgs?.market, null, 'market=all must not collapse to crypto');
  await assert.rejects(
    () => runLunaDeploymentConsistencyShadow({ fixture: true, dryRun: true, apply: true, confirm: 'luna-deployment-consistency-shadow', json: true }),
    /cannot combine --apply with --dry-run/,
    'deployment consistency runtime rejects ambiguous dry-run apply',
  );

  return {
    ok: true,
    smoke: 'luna-phase3-codex-p1',
    posttrade: runtimeMutation.summary,
    consistency: consistencyRuntime.summary,
    specHash: extractLunaDeploymentSpecHash(weight),
  };
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({
    run: runLunaPhase3CodexP1Smoke,
    onSuccess: async (result) => console.log(JSON.stringify(result, null, 2)),
    errorPrefix: 'luna-phase3-codex-p1-smoke error:',
  });
}
