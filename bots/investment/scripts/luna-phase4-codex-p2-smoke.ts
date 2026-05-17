#!/usr/bin/env node
// @ts-nocheck

import assert from 'node:assert/strict';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';
import {
  buildLunaPhase4LiveForwardRows,
  buildLunaPhase4StrategyEnhancementRows,
  fixturePhase4Inputs,
} from '../shared/luna-phase4-live-forward.ts';
import { runLunaLiveForwardValidationShadow } from './runtime-luna-live-forward-validation-shadow.ts';
import { runLunaPhase4StrategyEnhancementShadow } from './runtime-luna-phase4-strategy-enhancement-shadow.ts';

function fixtureOhlcv(inputs) {
  return Object.fromEntries((inputs || []).map((input) => {
    const candidate = input.candidate || input;
    return [`${String(candidate.symbol || '').toUpperCase()}|${String(candidate.market || 'crypto').toLowerCase()}`, input.ohlcv || []];
  }));
}

async function expectRejectsApplyDryRun() {
  await assert.rejects(
    () => runLunaLiveForwardValidationShadow({ fixture: true, apply: true, dryRun: true, confirm: 'luna-phase4-live-forward-shadow', json: true }),
    /cannot combine --apply with --dry-run/,
  );
  await assert.rejects(
    () => runLunaPhase4StrategyEnhancementShadow({ fixture: true, apply: true, dryRun: true, confirm: 'luna-phase4-strategy-enhancement-shadow', json: true }),
    /cannot combine --apply with --dry-run/,
  );
}

export async function runLunaPhase4CodexP2Smoke() {
  const inputs = fixturePhase4Inputs();
  const liveRows = buildLunaPhase4LiveForwardRows(inputs);
  const strategyRows = buildLunaPhase4StrategyEnhancementRows(inputs, fixtureOhlcv(inputs));

  assert.equal(liveRows.length, 4, 'live-forward fixture row count');
  assert.equal(strategyRows.length, 4, 'strategy fixture row count');
  assert.equal(liveRows.some((row) => row.liveForwardStatus === 'shadow_pass'), true, 'one fixture should pass shadow review');
  assert.equal(liveRows.some((row) => row.liveForwardStatus === 'shadow_hold'), true, 'one fixture should remain hold');
  assert.equal(liveRows.find((row) => row.symbol === 'BNB/USDT')?.liveForwardStatus, 'shadow_pass', 'non-community crypto pre-market evidence should not be blocked by community diversity');
  assert.equal(liveRows.find((row) => row.symbol === 'NVDA')?.liveForwardStatus, 'shadow_pass', 'non-community overseas evidence should not be blocked by crypto community diversity');
  assert.equal(liveRows.find((row) => row.symbol === 'DOGE/USDT')?.reasons.includes('community_source_diversity_low'), true, 'crypto hype fixture still requires community diversity');
  assert.equal(liveRows.every((row) => row.shadowOnly === true && row.liveMutation === false), true, 'live-forward rows are shadow-only');
  assert.equal(liveRows.every((row) => row.evidence?.llmGateway?.directProviderCall === false), true, 'Hub LLM route metadata forbids direct provider');
  assert.equal(strategyRows.some((row) => row.hyperoptStatus === 'shadow_evaluated_blocked'), true, 'weak fixture should evaluate and block unsafe hyperopt');
  assert.equal(strategyRows.some((row) => row.maxDrawdownGuard === 'block_live_forward'), true, 'high drawdown fixture should block live-forward');
  assert.equal(strategyRows.every((row) => row.bestParams?.paperOnlyDays === 7), true, 'strategy params stay paper-first');
  assert.equal(strategyRows.every((row) => row.shadowOnly === true && row.liveMutation === false), true, 'strategy rows are shadow-only');

  await expectRejectsApplyDryRun();
  const liveRuntime = await runLunaLiveForwardValidationShadow({ fixture: true, dryRun: true, json: true });
  const strategyRuntime = await runLunaPhase4StrategyEnhancementShadow({ fixture: true, dryRun: true, json: true });
  assert.equal(liveRuntime.summary.total, 4, 'live runtime fixture count');
  assert.equal(strategyRuntime.summary.total, 4, 'strategy runtime fixture count');
  assert.equal(liveRuntime.summary.liveMutation, false, 'live runtime no mutation');
  assert.equal(strategyRuntime.summary.liveMutation, false, 'strategy runtime no mutation');

  return {
    ok: true,
    smoke: 'luna-phase4-codex-p2',
    checks: {
      liveForwardRows: liveRows.length,
      strategyRows: strategyRows.length,
      shadowPass: liveRows.filter((row) => row.liveForwardStatus === 'shadow_pass').length,
      hyperoptPlanned: strategyRows.filter((row) => row.hyperoptStatus === 'planned').length,
      hyperoptShadowBlocked: strategyRows.filter((row) => row.hyperoptStatus === 'shadow_evaluated_blocked').length,
      maxDrawdownBlocks: strategyRows.filter((row) => row.maxDrawdownGuard === 'block_live_forward').length,
      applyDryRunRejected: true,
      liveMutation: false,
    },
  };
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({
    run: runLunaPhase4CodexP2Smoke,
    onSuccess: async (result) => console.log(JSON.stringify(result, null, 2)),
    errorPrefix: 'luna-phase4-codex-p2-smoke error:',
  });
}
