#!/usr/bin/env node
// @ts-nocheck

import * as db from '../shared/db.ts';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';
import {
  buildLunaCandidateBottleneckRows,
  ensureLunaCandidateBottleneckSchema,
  fixtureCandidateBottleneckInputs,
  insertLunaCandidateBottleneckShadow,
  loadLunaCandidateBottleneckInputs,
} from '../shared/luna-candidate-bottleneck-diagnostics.ts';
import { normalizeLunaPhase2Symbol } from '../shared/luna-weight-vector.ts';

const CONFIRM = 'luna-candidate-bottleneck-shadow';

function argValue(name: string, fallback = null) {
  const prefix = `--${name}=`;
  const found = process.argv.find((item) => item.startsWith(prefix));
  return found ? found.slice(prefix.length) : fallback;
}

function hasFlag(name: string) {
  return process.argv.includes(`--${name}`);
}

function symbolsFrom(value: any = '') {
  const values = Array.isArray(value) ? value : String(value || '').split(',');
  return [...new Set(values.map((symbol) => normalizeLunaPhase2Symbol(symbol)).filter(Boolean))];
}

function countBy(rows: any[] = [], key: string) {
  return rows.reduce((acc, row) => {
    const value = row?.[key] || 'unknown';
    acc[value] = (acc[value] || 0) + 1;
    return acc;
  }, {});
}

function topPrimaryBlockers(rows: any[] = [], limit = 8) {
  const counts = countBy(rows, 'primaryBlocker');
  return Object.entries(counts)
    .filter(([blocker]) => blocker !== 'unknown')
    .map(([blocker, count]) => ({ blocker, count }))
    .sort((a, b) => Number(b.count) - Number(a.count) || String(a.blocker).localeCompare(String(b.blocker)))
    .slice(0, limit);
}

export async function runLunaCandidateBottleneckDiagnostics(options: any = {}, deps: any = {}) {
  const apply = options.apply === true;
  const dryRun = options.dryRun === true || !apply;
  const fixture = options.fixture === true;
  const json = options.json === true;
  const confirm = String(options.confirm || '');
  const limit = Math.max(1, Number(options.limit || process.env.LUNA_CANDIDATE_BOTTLENECK_LIMIT || 50));
  const market = options.market || null;
  const requestedSymbols = symbolsFrom(options.symbols || process.env.LUNA_CANDIDATE_BOTTLENECK_SYMBOLS || '');

  if (apply && options.dryRun === true) {
    throw new Error('runtime:luna-candidate-bottleneck-diagnostics cannot combine --apply with --dry-run');
  }
  if (apply && confirm !== CONFIRM) {
    throw new Error(`runtime:luna-candidate-bottleneck-diagnostics apply requires --confirm=${CONFIRM}`);
  }

  const rawInputs = fixture
    ? fixtureCandidateBottleneckInputs()
    : deps.loadInputs
      ? await deps.loadInputs({ limit, market, symbols: requestedSymbols })
      : await loadLunaCandidateBottleneckInputs({ limit, market, symbols: requestedSymbols });
  const inputs = requestedSymbols.length
    ? rawInputs.filter((input) => {
      const candidate = input.candidate || input;
      return requestedSymbols.includes(normalizeLunaPhase2Symbol(candidate.symbol || input.symbol));
    })
    : rawInputs;
  const rows = buildLunaCandidateBottleneckRows(inputs, {
    staleBacktestHours: Number(options.staleBacktestHours || process.env.LUNA_BACKTEST_STALE_HOURS || 24),
    stalePredictiveHours: Number(options.stalePredictiveHours || process.env.LUNA_PREDICTIVE_STALE_HOURS || 24 * 7),
  });

  if (apply && !dryRun && rows.length > 0) {
    if (deps.ensureSchema) await deps.ensureSchema();
    else {
      await db.initSchema();
      await ensureLunaCandidateBottleneckSchema();
    }
    for (const row of rows) {
      if (deps.insertRow) await deps.insertRow(row);
      else await insertLunaCandidateBottleneckShadow(row);
    }
  }

  const summary = {
    total: rows.length,
    bySeverity: countBy(rows, 'severity'),
    byAction: countBy(rows, 'recommendedAction'),
    topPrimaryBlockers: topPrimaryBlockers(rows),
    traceFields: [
      'backtestFresh',
      'backtestGateStatus',
      'backtestBlockReasons',
      'backtestUnstableOrUnrealistic',
      'predictiveDecision',
      'communityEvidenceCount24h',
      'communitySourceCount24h',
      'primaryBlocker',
      'recommendedRefreshCommand',
    ],
    averagePenalty: rows.length
      ? Number((rows.reduce((sum, row) => sum + Number(row.candidateSelectionPenalty || 0), 0) / rows.length).toFixed(4))
      : 0,
    liveMutation: false,
  };
  const payload = {
    ok: true,
    status: apply ? 'luna_candidate_bottleneck_shadow_written' : 'luna_candidate_bottleneck_planned',
    phase: 'luna_candidate_quality_feedback',
    dryRun,
    apply,
    fixture,
    writeMode: apply ? 'shadow-apply' : 'plan-only',
    shadowMode: true,
    confirmToken: CONFIRM,
    market: market || 'all',
    requestedSymbols,
    summary,
    rows,
  };

  if (!json) {
    console.log(`[luna-candidate-bottleneck] ${payload.status} total=${summary.total} actions=${JSON.stringify(summary.byAction)}`);
  }
  return payload;
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({
    run: async () => runLunaCandidateBottleneckDiagnostics({
      json: hasFlag('json'),
      dryRun: hasFlag('dry-run'),
      apply: hasFlag('apply'),
      fixture: hasFlag('fixture'),
      limit: Number(argValue('limit', process.env.LUNA_CANDIDATE_BOTTLENECK_LIMIT || 50)),
      market: argValue('market', null),
      symbols: argValue('symbols', process.env.LUNA_CANDIDATE_BOTTLENECK_SYMBOLS || ''),
      confirm: argValue('confirm', ''),
      staleBacktestHours: Number(argValue('stale-backtest-hours', process.env.LUNA_BACKTEST_STALE_HOURS || 24)),
      stalePredictiveHours: Number(argValue('stale-predictive-hours', process.env.LUNA_PREDICTIVE_STALE_HOURS || 24 * 7)),
    }),
    onSuccess: async (result) => console.log(JSON.stringify(result, null, 2)),
    errorPrefix: 'runtime-luna-candidate-bottleneck-diagnostics error:',
  });
}
