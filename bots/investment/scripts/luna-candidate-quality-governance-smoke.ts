#!/usr/bin/env node
// @ts-nocheck

import assert from 'node:assert/strict';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';
import {
  buildLunaCandidateQualityGovernanceRows,
  fixtureCandidateQualityGovernanceInputs,
} from '../shared/luna-candidate-quality-governance.ts';
import { CONFIRM, runLunaCandidateQualityGovernanceShadow } from './runtime-luna-candidate-quality-governance-shadow.ts';

export async function runLunaCandidateQualityGovernanceSmoke() {
  await assert.rejects(
    () => runLunaCandidateQualityGovernanceShadow({ fixture: true, apply: true, dryRun: true, confirm: CONFIRM, json: true }),
    /cannot combine --apply with --dry-run/,
  );
  await assert.rejects(
    () => runLunaCandidateQualityGovernanceShadow({ fixture: true, apply: true, json: true }),
    /requires --confirm=luna-candidate-quality-governance-shadow/,
  );

  const rows = buildLunaCandidateQualityGovernanceRows(fixtureCandidateQualityGovernanceInputs(), {
    now: '2026-05-17T00:00:00.000Z',
  });
  const neg = rows.find((row) => row.symbol === 'NEG/USDT');
  const alpha = rows.find((row) => row.symbol === 'ALPHA/USDT');
  const miss = rows.find((row) => row.symbol === 'MISS/USDT');
  const pass = rows.find((row) => row.symbol === 'BTC/USDT');

  assert.equal(rows.length, 4, 'fixture governance row count');
  assert.equal(neg?.governanceAction, 'candidate_cooldown_shadow', 'quarantine maps to cooldown');
  assert.equal(neg?.skipBacktestUntilCooldown, true, 'cooldown row skips repeated backtest');
  assert.equal(neg?.replacementNeeded, true, 'cooldown row needs replacement discovery');
  assert.ok(neg?.cooldownUntil, 'cooldown row has cooldown_until');
  assert.equal(alpha?.governanceAction, 'strategy_repair_shadow', 'repairable unhealthy candidate maps to strategy repair');
  assert.equal(miss?.governanceAction, 'refresh_backtest_priority', 'missing/stale candidate maps to refresh priority');
  assert.equal(pass?.governanceAction, 'promotion_monitor_shadow', 'pass candidate maps to promotion monitor');
  assert.equal(rows.every((row) => row.shadowOnly === true && row.liveMutation === false), true, 'shadow-only rows');
  assert.equal(rows.every((row) => !String(row.recommendedNextCommand || '').includes('launchctl')), true, 'commands avoid launchctl');

  const runtime = await runLunaCandidateQualityGovernanceShadow({ fixture: true, dryRun: true, json: true });
  assert.equal(runtime.ok, true, 'runtime ok');
  assert.equal(runtime.writeMode, 'plan-only', 'plan-only write mode');
  assert.equal(runtime.summary.liveMutation, false, 'runtime no live mutation');
  assert.equal(runtime.summary.byAction.candidate_cooldown_shadow, 1, 'cooldown count');
  assert.equal(runtime.summary.refreshPriority, 1, 'refresh priority count');
  assert.equal(runtime.summary.strategyRepair, 1, 'strategy repair count');

  return {
    ok: true,
    smoke: 'luna-candidate-quality-governance',
    checks: {
      rows: rows.length,
      actions: runtime.summary.byAction,
      cooldown: runtime.summary.cooldown,
      refreshPriority: runtime.summary.refreshPriority,
      strategyRepair: runtime.summary.strategyRepair,
      liveMutation: false,
      applyDryRunRejected: true,
      confirmGuard: true,
    },
  };
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({
    run: runLunaCandidateQualityGovernanceSmoke,
    onSuccess: async (result) => console.log(JSON.stringify(result, null, 2)),
    errorPrefix: 'luna-candidate-quality-governance-smoke error:',
  });
}
