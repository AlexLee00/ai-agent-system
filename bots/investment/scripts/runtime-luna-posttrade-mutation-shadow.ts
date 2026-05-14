#!/usr/bin/env node
// @ts-nocheck

import * as db from '../shared/db.ts';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';
import {
  buildPosttradeMutationCandidates,
  ensureLunaPhase3Schema,
  insertPosttradeMutationShadow,
  loadRecentLossTrades,
} from '../shared/luna-phase3-posttrade-mutation.ts';

const CONFIRM = 'luna-phase3-posttrade-mutation';

function argValue(name: string, fallback = null) {
  const prefix = `--${name}=`;
  const found = process.argv.find((item) => item.startsWith(prefix));
  return found ? found.slice(prefix.length) : fallback;
}

function hasFlag(name: string) {
  return process.argv.includes(`--${name}`);
}

function fixtureTrades() {
  const now = Date.parse('2026-05-14T00:00:00.000Z');
  return [
    {
      id: 'fixture-btc-loss-1',
      trade_id: 'fixture-btc-loss-1',
      symbol: 'BTC/USDT',
      market: 'crypto',
      exchange: 'binance',
      status: 'closed',
      is_paper: false,
      exit_time: now,
      pnl_percent: -1.4,
      pnl_net: -0.7,
      strategy_family: 'momentum_rotation',
    },
    {
      id: 'fixture-btc-loss-2',
      trade_id: 'fixture-btc-loss-2',
      symbol: 'BTC/USDT',
      market: 'crypto',
      exchange: 'binance',
      status: 'closed',
      is_paper: false,
      exit_time: now - 60_000,
      pnl_percent: -3.2,
      pnl_net: -1.6,
      strategy_family: 'momentum_rotation',
    },
    {
      id: 'fixture-eth-loss-1',
      trade_id: 'fixture-eth-loss-1',
      symbol: 'ETH/USDT',
      market: 'crypto',
      exchange: 'binance',
      status: 'closed',
      is_paper: false,
      exit_time: now - 120_000,
      pnl_percent: -0.8,
      pnl_net: -0.4,
      strategy_family: 'trend_following',
    },
  ];
}

export async function runLunaPosttradeMutationShadow(options: any = {}, deps: any = {}) {
  const apply = options.apply === true;
  const dryRun = options.dryRun === true || !apply;
  const fixture = options.fixture === true;
  const json = options.json === true;
  const confirm = String(options.confirm || '');
  const days = Math.max(1, Number(options.days || process.env.LUNA_PHASE3_POSTTRADE_DAYS || 14));
  const limit = Math.max(1, Number(options.limit || process.env.LUNA_PHASE3_POSTTRADE_LIMIT || 200));
  const market = options.market || null;

  if (apply && options.dryRun === true) {
    throw new Error('runtime:luna-posttrade-mutation-shadow cannot combine --apply with --dry-run');
  }
  if (apply && confirm !== CONFIRM) {
    throw new Error(`runtime:luna-posttrade-mutation-shadow apply requires --confirm=${CONFIRM}`);
  }

  const trades = fixture
    ? fixtureTrades()
    : deps.loadTrades
      ? await deps.loadTrades({ days, limit, market })
      : await loadRecentLossTrades({ days, limit, market });
  const candidates = buildPosttradeMutationCandidates(trades, options);

  if (apply && !dryRun && candidates.length > 0) {
    if (deps.ensureSchema) await deps.ensureSchema();
    else {
      await db.initSchema();
      await ensureLunaPhase3Schema();
    }
    for (const candidate of candidates) {
      if (deps.insertCandidate) await deps.insertCandidate(candidate);
      else await insertPosttradeMutationShadow(candidate);
    }
  }

  const summary = {
    scannedLossTrades: trades.length,
    staged: candidates.length,
    candidateDownweight: candidates.filter((row) => row.mutationType === 'candidate_downweight').length,
    sizeMultiplier: candidates.filter((row) => row.mutationType === 'size_multiplier').length,
    setupBlock: candidates.filter((row) => row.mutationType === 'setup_block').length,
    liveMutation: false,
  };

  const payload = {
    ok: true,
    status: apply ? 'luna_phase3_posttrade_mutation_shadow_written' : 'luna_phase3_posttrade_mutation_shadow_planned',
    phase: 'luna_phase3_codex_p1',
    task: 'posttrade_staged_mutation',
    dryRun,
    apply,
    fixture,
    writeMode: apply ? 'shadow-apply' : 'plan-only',
    shadowMode: true,
    requiresMasterConfirm: candidates.length > 0,
    confirmToken: CONFIRM,
    days,
    market: market || 'all',
    summary,
    candidates,
  };

  if (!json) {
    console.log(`[luna-phase3-posttrade] ${payload.status} scanned=${summary.scannedLossTrades} staged=${summary.staged}`);
  }
  return payload;
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({
    run: async () => runLunaPosttradeMutationShadow({
      json: hasFlag('json'),
      dryRun: hasFlag('dry-run'),
      apply: hasFlag('apply'),
      fixture: hasFlag('fixture'),
      days: Number(argValue('days', process.env.LUNA_PHASE3_POSTTRADE_DAYS || 14)),
      limit: Number(argValue('limit', process.env.LUNA_PHASE3_POSTTRADE_LIMIT || 200)),
      market: argValue('market', null),
      confirm: argValue('confirm', ''),
    }),
    onSuccess: async (result) => console.log(JSON.stringify(result, null, 2)),
    errorPrefix: 'runtime-luna-posttrade-mutation-shadow error:',
  });
}
