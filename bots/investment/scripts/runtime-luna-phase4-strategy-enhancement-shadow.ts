#!/usr/bin/env node
// @ts-nocheck

import * as db from '../shared/db.ts';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';
import {
  buildLunaPhase4StrategyEnhancementRows,
  ensureLunaPhase4Schema,
  fixturePhase4Inputs,
  insertLunaPhase4StrategyEnhancementShadow,
  loadCachedPhase4Ohlcv,
  loadLunaPhase4Inputs,
} from '../shared/luna-phase4-live-forward.ts';
import { normalizeLunaPhase2Symbol } from '../shared/luna-weight-vector.ts';

const CONFIRM = 'luna-phase4-strategy-enhancement-shadow';

function argValue(name, fallback = null) {
  const prefix = `--${name}=`;
  const found = process.argv.find((item) => item.startsWith(prefix));
  return found ? found.slice(prefix.length) : fallback;
}

function hasFlag(name) {
  return process.argv.includes(`--${name}`);
}

function symbolsFrom(value = '') {
  const values = Array.isArray(value) ? value : String(value || '').split(',');
  return [...new Set(values.map((symbol) => normalizeLunaPhase2Symbol(symbol)).filter(Boolean))];
}

function fixtureOhlcv(inputs) {
  return Object.fromEntries((inputs || []).map((input) => {
    const candidate = input.candidate || input;
    return [`${String(candidate.symbol || '').toUpperCase()}|${String(candidate.market || 'crypto').toLowerCase()}`, input.ohlcv || []];
  }));
}

function isShadowReadyEnhancementStatus(status = '') {
  return [
    'shadow_ready',
    'shadow_ready_with_risk_tightening',
    'shadow_tuned',
    'shadow_evaluated',
  ].includes(String(status || '').trim());
}

export async function runLunaPhase4StrategyEnhancementShadow(options = {}, deps = {}) {
  const apply = options.apply === true;
  const dryRun = options.dryRun === true || !apply;
  const fixture = options.fixture === true;
  const json = options.json === true;
  const confirm = String(options.confirm || '');
  const market = options.market || null;
  const limit = Math.max(1, Number(options.limit || process.env.LUNA_PHASE4_STRATEGY_LIMIT || 50));
  const timeframe = String(options.timeframe || process.env.LUNA_PHASE4_OHLCV_TIMEFRAME || '1h');
  const requestedSymbols = symbolsFrom(options.symbols || process.env.LUNA_PHASE4_STRATEGY_SYMBOLS || '');

  if (apply && options.dryRun === true) {
    throw new Error('runtime:luna-phase4-strategy-enhancement-shadow cannot combine --apply with --dry-run');
  }
  if (apply && confirm !== CONFIRM) {
    throw new Error(`runtime:luna-phase4-strategy-enhancement-shadow apply requires --confirm=${CONFIRM}`);
  }

  const rawInputs = fixture
    ? fixturePhase4Inputs()
    : deps.loadInputs
      ? await deps.loadInputs({ limit, market, symbols: requestedSymbols })
      : await loadLunaPhase4Inputs({ limit, market, symbols: requestedSymbols });
  const inputs = requestedSymbols.length
    ? rawInputs.filter((input) => {
      const candidate = input.candidate || input;
      return requestedSymbols.includes(normalizeLunaPhase2Symbol(candidate.symbol || input.symbol));
    })
    : rawInputs;
  const ohlcvByKey = fixture
    ? fixtureOhlcv(inputs)
    : deps.loadOhlcv
      ? await deps.loadOhlcv({ inputs, timeframe, limit: 80 })
      : await loadCachedPhase4Ohlcv({ inputs, timeframe, limit: 80 });
  const rows = buildLunaPhase4StrategyEnhancementRows(inputs, ohlcvByKey);

  if (apply && !dryRun && rows.length > 0) {
    if (deps.ensureSchema) await deps.ensureSchema();
    else {
      await db.initSchema();
      await ensureLunaPhase4Schema();
    }
    for (const row of rows) {
      if (deps.insertRow) await deps.insertRow(row);
      else await insertLunaPhase4StrategyEnhancementShadow(row);
    }
  }

  const summary = {
    total: rows.length,
    shadowReady: rows.filter((row) => isShadowReadyEnhancementStatus(row.enhancementStatus)).length,
    shadowReview: rows.filter((row) => !isShadowReadyEnhancementStatus(row.enhancementStatus)).length,
    hyperoptPlanned: rows.filter((row) => row.hyperoptStatus === 'planned').length,
    hyperoptShadowEvaluated: rows.filter((row) => row.hyperoptStatus === 'shadow_evaluated').length,
    maxDrawdownBlocks: rows.filter((row) => row.maxDrawdownGuard === 'block_live_forward').length,
    liveMutation: false,
  };

  const payload = {
    ok: true,
    status: apply ? 'luna_phase4_strategy_enhancement_shadow_written' : 'luna_phase4_strategy_enhancement_shadow_planned',
    phase: 'luna_phase4_codex_p2',
    task: 'hyperopt_maxdrawdown_macd_bollinger_yfinance',
    dryRun,
    apply,
    fixture,
    writeMode: apply ? 'shadow-apply' : 'plan-only',
    shadowMode: true,
    confirmToken: CONFIRM,
    market: market || 'all',
    requestedSymbols,
    timeframe,
    summary,
    rows,
  };
  if (!json) {
    console.log(`[luna-phase4-strategy] ${payload.status} total=${summary.total} hyperopt=${summary.hyperoptPlanned} ddBlocks=${summary.maxDrawdownBlocks}`);
  }
  return payload;
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({
    run: async () => runLunaPhase4StrategyEnhancementShadow({
      json: hasFlag('json'),
      dryRun: hasFlag('dry-run'),
      apply: hasFlag('apply'),
      fixture: hasFlag('fixture'),
      limit: Number(argValue('limit', process.env.LUNA_PHASE4_STRATEGY_LIMIT || 50)),
      market: argValue('market', null),
      timeframe: argValue('timeframe', process.env.LUNA_PHASE4_OHLCV_TIMEFRAME || '1h'),
      symbols: argValue('symbols', process.env.LUNA_PHASE4_STRATEGY_SYMBOLS || ''),
      confirm: argValue('confirm', ''),
    }),
    onSuccess: async (result) => console.log(JSON.stringify(result, null, 2)),
    errorPrefix: 'runtime-luna-phase4-strategy-enhancement-shadow error:',
  });
}
