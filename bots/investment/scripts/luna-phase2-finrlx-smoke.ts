#!/usr/bin/env node
// @ts-nocheck

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  buildLunaPaperTradingPlan,
  buildLunaWeightVector,
  evaluateNoLookaheadContract,
} from '../shared/luna-weight-vector.ts';
import { runLunaWeightVectorShadow } from './runtime-luna-weight-vector-shadow.ts';
import { runLunaPaperTradingShadow } from './runtime-luna-paper-trading-shadow.ts';

const now = new Date('2026-05-14T00:00:00.000Z').toISOString();
const future = new Date('2026-05-14T00:10:00.000Z').toISOString();

const pass = buildLunaWeightVector({
  asOf: now,
  candidate: { symbol: 'BTC/USDT', market: 'crypto', score: 0.9, discovered_at: now },
  backtest: { fresh: true, healthy: true, sharpe: 1.1, win_rate: 55, max_drawdown: 10, last_backtest_at: now },
  predictive: { decision: 'pass_prediction', score: 0.8, created_at: now },
  community: { avg_score: 0.4, source_count: 3, last_seen_at: now },
}, { riskBudgetUsdt: 50 });
assert.equal(pass.ok, true);
assert.equal(pass.noLookaheadOk, true);
assert.ok(['increase', 'watch'].includes(pass.signal));
assert.ok(pass.targetWeight > 0);
assert.equal(pass.shadowOnly, true);

const leak = buildLunaWeightVector({
  asOf: now,
  candidate: { symbol: 'LEAK/USDT', market: 'crypto', score: 0.9, discovered_at: future },
  backtest: { fresh: true, healthy: true, sharpe: 1, win_rate: 55, max_drawdown: 10, last_backtest_at: now },
  predictive: { decision: 'pass_prediction', score: 0.8, created_at: now },
}, { riskBudgetUsdt: 50 });
assert.equal(leak.noLookaheadOk, false);
assert.equal(leak.signal, 'hold');
assert.equal(leak.targetWeight, 0);
assert.equal(evaluateNoLookaheadContract({ asOf: now, sources: [{ source: 'future', observedAt: future }] }).ok, false);

const paper = buildLunaPaperTradingPlan(pass, {
  position: { amount: 0, avg_price: 65000 },
  equityUsdt: 1000,
  maxOrderUsdt: 50,
  minNotionalUsdt: 5,
});
assert.equal(paper.shadowOnly, true);
assert.equal(paper.paperSide, 'BUY');
assert.ok(paper.paperNotionalUsdt <= 50);

const weightInserts = [];
const weightRuntime = await runLunaWeightVectorShadow({
  json: true,
  fixture: true,
  dryRun: true,
  apply: false,
  limit: 5,
}, {
  insertWeight: async (row) => weightInserts.push(row),
});
assert.equal(weightRuntime.ok, true);
assert.equal(weightRuntime.writeMode, 'plan-only');
assert.equal(weightRuntime.summary.liveMutation, false);
assert.equal(weightInserts.length, 0);
assert.ok(weightRuntime.summary.total >= 2);

const paperInserts = [];
const paperRuntime = await runLunaPaperTradingShadow({
  json: true,
  fixture: true,
  dryRun: true,
  apply: false,
  limit: 5,
}, {
  insertPaper: async (row) => paperInserts.push(row),
});
assert.equal(paperRuntime.ok, true);
assert.equal(paperRuntime.writeMode, 'plan-only');
assert.equal(paperRuntime.summary.liveMutation, false);
assert.equal(paperInserts.length, 0);

const root = path.resolve(import.meta.dirname, '..');
const bootstrap = fs.readFileSync(path.join(root, 'shared/db/schema/tables/bootstrap.ts'), 'utf8');
assert.match(bootstrap, /luna_weight_vector_shadow/);
assert.match(bootstrap, /luna_paper_trading_shadow/);

const deploy = path.join(root, 'deploy.sh');
const bashCheck = spawnSync('bash', ['-n', deploy], { encoding: 'utf8' });
assert.equal(bashCheck.status, 0, bashCheck.stderr);
const deployBody = fs.readFileSync(deploy, 'utf8');
assert.match(deployBody, /--mode backtest\|paper\|live/);
assert.match(deployBody, /LUNA_PHASE2_LIVE_DEPLOY_ENABLED/);
assert.match(deployBody, /luna-weight-vector-shadow/);

const payload = {
  ok: true,
  smoke: 'luna-phase2-finrlx',
  pass: {
    symbol: pass.symbol,
    signal: pass.signal,
    targetWeight: pass.targetWeight,
    confidence: pass.confidence,
  },
  noLookahead: {
    leakBlocked: leak.signal === 'hold' && leak.noLookaheadOk === false,
    violations: leak.evidence.noLookahead.violations,
  },
  paper: {
    side: paper.paperSide,
    notional: paper.paperNotionalUsdt,
  },
  runtime: {
    weightWriteMode: weightRuntime.writeMode,
    paperWriteMode: paperRuntime.writeMode,
  },
};

if (process.argv.includes('--json')) {
  console.log(JSON.stringify(payload, null, 2));
} else {
  console.log('luna-phase2-finrlx-smoke ok');
}

