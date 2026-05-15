#!/usr/bin/env node
// @ts-nocheck

import assert from 'node:assert/strict';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';
import {
  buildPhase5GeneticAlphaRows,
  buildPhase5McpBridgeRows,
  buildPhase5RlEnsembleRows,
  LUNA_PHASE5_A2A_SKILLS,
  normalizeMarketFilter,
} from '../shared/luna-phase5-codex-p3.ts';
import { runLunaPhase5Shadow } from './runtime-luna-phase5-shadow.ts';

async function expectRejectsApplyDryRun() {
  await assert.rejects(
    () => runLunaPhase5Shadow({
      fixture: true,
      apply: true,
      dryRun: true,
      confirm: 'luna-phase5-codex-p3-shadow',
      json: true,
    }),
    /cannot combine --apply with --dry-run/,
  );
}

export async function runLunaPhase5CodexP3Smoke() {
  const mcpRows = buildPhase5McpBridgeRows({ fixture: true });
  const rlRows = await buildPhase5RlEnsembleRows({ fixture: true });
  const geneticRows = await buildPhase5GeneticAlphaRows({ fixture: true });

  assert.equal(LUNA_PHASE5_A2A_SKILLS.length, 12, 'A2A skill inventory must expose 12 tools');
  assert.equal(normalizeMarketFilter('all'), null, 'market=all must not narrow Phase5 queries to crypto');
  assert.equal(normalizeMarketFilter('*'), null, 'market=* must not narrow Phase5 queries to crypto');
  assert.equal(normalizeMarketFilter('kis_overseas'), 'overseas', 'overseas market filter');
  assert.equal(mcpRows.length, 12, 'MCP bridge manifest row count');
  assert.equal(mcpRows.every((row) => row.directTradeAllowed === false), true, 'MCP bridge must block direct trading');
  assert.equal(mcpRows.every((row) => row.status === 'shadow_read_only_ready'), true, 'MCP bridge status');
  assert.equal(rlRows.length >= 3, true, 'RL ensemble fixture rows');
  assert.deepEqual(
    rlRows[0].algorithmVotes.map((vote) => vote.algorithm),
    ['ppo', 'dqn', 'lstm', 'transformer'],
    'RL ensemble must include PPO/DQN/LSTM/Transformer votes',
  );
  assert.equal(rlRows.every((row) => row.liveMutation === false && row.shadowOnly === true), true, 'RL rows are shadow-only');
  assert.equal(geneticRows.length, 2, 'Genetic alpha fixture rows');
  assert.equal(geneticRows.some((row) => row.promotionStatus === 'shadow_candidate_ready'), true, 'one genetic candidate should be ready');
  assert.equal(geneticRows.some((row) => row.blockedReasons.includes('max_drawdown_guard_blocks_live_forward')), true, 'drawdown block carried into genetic alpha');
  assert.equal(geneticRows.every((row) => row.liveMutation === false && row.shadowOnly === true), true, 'genetic rows are shadow-only');

  await expectRejectsApplyDryRun();
  const runtime = await runLunaPhase5Shadow({ fixture: true, dryRun: true, json: true });
  assert.equal(runtime.summary.mcpTools, 12, 'runtime mcp row count');
  assert.equal(runtime.summary.rlRows, rlRows.length, 'runtime rl row count');
  assert.equal(runtime.summary.geneticRows, geneticRows.length, 'runtime genetic row count');
  assert.equal(runtime.summary.liveMutation, false, 'runtime no live mutation');

  return {
    ok: true,
    smoke: 'luna-phase5-codex-p3',
    checks: {
      mcpTools: mcpRows.length,
      rlRows: rlRows.length,
      geneticRows: geneticRows.length,
      algorithms: rlRows[0].algorithmVotes.map((vote) => vote.algorithm),
      directTradeAllowed: false,
      applyDryRunRejected: true,
      marketAllFilter: 'all-markets',
      liveMutation: false,
    },
  };
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({
    run: runLunaPhase5CodexP3Smoke,
    onSuccess: async (result) => console.log(JSON.stringify(result, null, 2)),
    errorPrefix: 'luna-phase5-codex-p3-smoke error:',
  });
}
