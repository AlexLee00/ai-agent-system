#!/usr/bin/env node
// @ts-nocheck

import * as db from '../shared/db.ts';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';
import {
  buildPhase5GeneticAlphaRows,
  buildPhase5McpBridgeRows,
  buildPhase5RlEnsembleRows,
  ensureLunaPhase5Schema,
  insertPhase5GeneticAlphaRow,
  insertPhase5McpBridgeRow,
  insertPhase5RlEnsembleRow,
} from '../shared/luna-phase5-codex-p3.ts';

const CONFIRM = 'luna-phase5-codex-p3-shadow';

function argValue(name, fallback = null) {
  const prefix = `--${name}=`;
  const found = process.argv.find((item) => item.startsWith(prefix));
  return found ? found.slice(prefix.length) : fallback;
}

function hasFlag(name) {
  return process.argv.includes(`--${name}`);
}

function normalizeTask(value = 'all') {
  const raw = String(value || 'all').toLowerCase();
  if (['mcp', 'rl', 'genetic', 'all'].includes(raw)) return raw;
  return 'all';
}

export async function runLunaPhase5Shadow(options = {}) {
  const apply = options.apply === true;
  const dryRun = options.dryRun === true || !apply;
  const fixture = options.fixture === true;
  const json = options.json === true;
  const confirm = String(options.confirm || '');
  const task = normalizeTask(options.task || 'all');
  const limit = Math.max(1, Number(options.limit || 50));
  const market = options.market || null;
  const generation = Math.max(1, Number(options.generation || 1));

  if (apply && options.dryRun === true) {
    throw new Error('runtime:luna-phase5-shadow cannot combine --apply with --dry-run');
  }
  if (apply && confirm !== CONFIRM) {
    throw new Error(`runtime:luna-phase5-shadow apply requires --confirm=${CONFIRM}`);
  }

  const rows = {
    mcp: task === 'all' || task === 'mcp' ? buildPhase5McpBridgeRows({ fixture }) : [],
    rl: task === 'all' || task === 'rl' ? await buildPhase5RlEnsembleRows({ fixture, limit, market }) : [],
    genetic: task === 'all' || task === 'genetic'
      ? await buildPhase5GeneticAlphaRows({ fixture, limit, market, generation })
      : [],
  };

  if (apply) {
    await db.initSchema();
    await ensureLunaPhase5Schema();
    for (const row of rows.mcp) await insertPhase5McpBridgeRow(row);
    for (const row of rows.rl) await insertPhase5RlEnsembleRow(row);
    for (const row of rows.genetic) await insertPhase5GeneticAlphaRow(row);
  }

  const summary = {
    mcpTools: rows.mcp.length,
    rlRows: rows.rl.length,
    rlBuy: rows.rl.filter((row) => row.actionType === 'buy').length,
    rlHold: rows.rl.filter((row) => row.actionType === 'hold').length,
    rlSell: rows.rl.filter((row) => row.actionType === 'sell').length,
    geneticRows: rows.genetic.length,
    geneticReady: rows.genetic.filter((row) => row.promotionStatus === 'shadow_candidate_ready').length,
    geneticObserve: rows.genetic.filter((row) => row.promotionStatus !== 'shadow_candidate_ready').length,
    liveMutation: false,
    externalInferenceCalls: 0,
    serviceStarted: false,
  };

  const payload = {
    ok: true,
    status: apply ? 'luna_phase5_codex_p3_shadow_written' : 'luna_phase5_codex_p3_shadow_planned',
    phase: 'luna_phase5_codex_p3',
    task,
    dryRun,
    apply,
    fixture,
    writeMode: apply ? 'shadow-apply' : 'plan-only',
    shadowMode: true,
    confirmToken: CONFIRM,
    market: market || 'all',
    generation,
    summary,
    rows,
  };

  if (!json) {
    console.log(`[luna-phase5] ${payload.status} mcp=${summary.mcpTools} rl=${summary.rlRows} genetic=${summary.geneticRows}`);
  }
  return payload;
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({
    run: async () => runLunaPhase5Shadow({
      json: hasFlag('json'),
      dryRun: hasFlag('dry-run'),
      apply: hasFlag('apply'),
      fixture: hasFlag('fixture'),
      task: argValue('task', 'all'),
      market: argValue('market', null),
      limit: Number(argValue('limit', 50)),
      generation: Number(argValue('generation', 1)),
      confirm: argValue('confirm', ''),
    }),
    onSuccess: async (result) => console.log(JSON.stringify(result, null, 2)),
    errorPrefix: 'runtime-luna-phase5-shadow error:',
  });
}
