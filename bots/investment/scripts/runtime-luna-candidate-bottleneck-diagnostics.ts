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

function numberOption(options: any = {}, name: string, envName: string, fallback: number) {
  const raw = options[name] ?? process.env[envName];
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function countReason(rows: any[] = [], reason: string) {
  return rows.filter((row) => Array.isArray(row?.reasons) && row.reasons.includes(reason)).length;
}

function isBacktestGatePredictiveBlock(row: any = {}) {
  const decision = String(row?.predictiveDecision || '').trim().toLowerCase();
  const blockedReason = String(row?.predictiveBlockedReason || '').trim().toLowerCase();
  return decision === 'block_backtest_gate'
    || blockedReason.startsWith('backtest_')
    || blockedReason.includes('backtest');
}

function buildBacktestQualityTarget(rows: any[] = [], summary: any = {}, options: any = {}) {
  const total = rows.length;
  const actionableRows = rows.filter((row) => row?.qualityGovernanceCooldownActive !== true);
  const targetRows = actionableRows.length > 0 ? actionableRows : rows;
  const targetTotal = targetRows.length;
  const cooldownSuppressed = total - targetTotal;
  const passCandidates = targetRows.filter((row) => row?.severity === 'pass' || row?.recommendedAction === 'monitor_pass_candidate').length;
  const passRate = targetTotal > 0 ? passCandidates / targetTotal : 1;
  const missingOrStale = countReason(targetRows, 'backtest_missing_or_stale');
  const unstableOrUnrealistic = countReason(targetRows, 'backtest_unstable_or_unrealistic');
  const unhealthyOrWouldBlock = countReason(targetRows, 'backtest_unhealthy_or_would_block');
  const blockerSeverity = targetRows.filter((row) => row?.severity === 'blocker').length;
  const averagePenalty = targetRows.length
    ? Number((targetRows.reduce((sum, row) => sum + Number(row.candidateSelectionPenalty || 0), 0) / targetRows.length).toFixed(4))
    : 0;
  const minPassCount = Math.min(targetTotal, Math.max(0, Math.ceil(numberOption(options, 'targetMinPassCount', 'LUNA_BACKTEST_TARGET_MIN_PASS_COUNT', Math.max(3, targetTotal * 0.1)))));
  const minPassRate = numberOption(options, 'targetMinPassRate', 'LUNA_BACKTEST_TARGET_MIN_PASS_RATE', 0.1);
  const maxMissingOrStale = Math.max(0, Math.floor(numberOption(options, 'targetMaxMissingOrStale', 'LUNA_BACKTEST_TARGET_MAX_MISSING_OR_STALE', 0)));
  const maxUnstableOrUnrealistic = Math.max(0, Math.floor(numberOption(options, 'targetMaxUnstableOrUnrealistic', 'LUNA_BACKTEST_TARGET_MAX_UNSTABLE_OR_UNREALISTIC', Math.floor(targetTotal * 0.4))));
  const maxUnhealthyOrWouldBlock = Math.max(0, Math.floor(numberOption(options, 'targetMaxUnhealthyOrWouldBlock', 'LUNA_BACKTEST_TARGET_MAX_UNHEALTHY_OR_WOULD_BLOCK', Math.floor(targetTotal * 0.4))));
  const maxAveragePenalty = numberOption(options, 'targetMaxAveragePenalty', 'LUNA_BACKTEST_TARGET_MAX_AVERAGE_PENALTY', 0.5);
  const maxBlockerSeverity = Math.max(0, Math.floor(numberOption(options, 'targetMaxBlockerSeverity', 'LUNA_BACKTEST_TARGET_MAX_BLOCKER_SEVERITY', 0)));
  const checks = [
    { name: 'min_pass_candidates', current: passCandidates, target: minPassCount, ok: passCandidates >= minPassCount },
    { name: 'min_pass_rate', current: Number(passRate.toFixed(4)), target: minPassRate, ok: passRate >= minPassRate },
    { name: 'max_missing_or_stale', current: missingOrStale, target: maxMissingOrStale, ok: missingOrStale <= maxMissingOrStale },
    { name: 'max_unstable_or_unrealistic', current: unstableOrUnrealistic, target: maxUnstableOrUnrealistic, ok: unstableOrUnrealistic <= maxUnstableOrUnrealistic },
    { name: 'max_unhealthy_or_would_block', current: unhealthyOrWouldBlock, target: maxUnhealthyOrWouldBlock, ok: unhealthyOrWouldBlock <= maxUnhealthyOrWouldBlock },
    { name: 'max_average_penalty', current: averagePenalty, target: maxAveragePenalty, ok: averagePenalty <= maxAveragePenalty },
    { name: 'max_blocker_severity', current: blockerSeverity, target: maxBlockerSeverity, ok: blockerSeverity <= maxBlockerSeverity },
  ];
  const gaps = checks.filter((check) => !check.ok);
  return {
    achieved: gaps.length === 0,
    mode: 'shadow_actionable_quality_slo',
    total,
    targetTotal,
    cooldownSuppressed,
    passCandidates,
    passRate: Number(passRate.toFixed(4)),
    missingOrStale,
    unstableOrUnrealistic,
    unhealthyOrWouldBlock,
    blockerSeverity,
    averagePenalty,
    checks,
    gaps,
    recommendedLoop: [
      'npm --prefix bots/investment run -s runtime:luna-candidate-backtest-refresh -- --json --force --periods=30,90,180,365 --market=all --max-runtime-ms=240000',
      'npm --prefix bots/investment run -s runtime:luna-candidate-bottleneck-diagnostics -- --json --dry-run --market=all',
    ],
  };
}

function buildPredictiveQualityTarget(rows: any[] = [], options: any = {}) {
  const total = rows.length;
  const targetRows = rows.filter((row) => !isBacktestGatePredictiveBlock(row));
  const backtestGateSuppressed = total - targetRows.length;
  const minCoverage = numberOption(options, 'targetMinPredictiveCoverage', 'LUNA_PREDICTIVE_TARGET_MIN_COVERAGE', 0.75);
  const maxBlocked = Math.max(0, Math.floor(numberOption(options, 'targetMaxPredictiveBlocked', 'LUNA_PREDICTIVE_TARGET_MAX_BLOCKED', 0)));
  const maxMissingOrStale = Math.max(0, Math.floor(numberOption(options, 'targetMaxPredictiveMissingOrStale', 'LUNA_PREDICTIVE_TARGET_MAX_MISSING_OR_STALE', 0)));
  const maxCoverageLow = Math.max(0, Math.floor(numberOption(options, 'targetMaxPredictiveCoverageLow', 'LUNA_PREDICTIVE_TARGET_MAX_COVERAGE_LOW', 0)));
  const predictiveBlocked = countReason(targetRows, 'predictive_blocked');
  const predictiveMissingOrStale = countReason(targetRows, 'predictive_missing_or_stale');
  const predictiveCoverageLow = countReason(targetRows, 'predictive_coverage_low');
  const passCandidates = targetRows.filter((row) => row?.recommendedAction === 'monitor_pass_candidate' || String(row?.predictiveDecision || '').toLowerCase() === 'fire').length;
  const coverageRows = targetRows
    .map((row) => Number(row?.predictiveCoverage))
    .filter((value) => Number.isFinite(value));
  const minObservedCoverage = coverageRows.length ? Number(Math.min(...coverageRows).toFixed(4)) : null;
  const avgObservedCoverage = coverageRows.length
    ? Number((coverageRows.reduce((sum, value) => sum + value, 0) / coverageRows.length).toFixed(4))
    : null;
  const checks = [
    { name: 'max_predictive_blocked', current: predictiveBlocked, target: maxBlocked, ok: predictiveBlocked <= maxBlocked },
    { name: 'max_predictive_missing_or_stale', current: predictiveMissingOrStale, target: maxMissingOrStale, ok: predictiveMissingOrStale <= maxMissingOrStale },
    { name: 'max_predictive_coverage_low', current: predictiveCoverageLow, target: maxCoverageLow, ok: predictiveCoverageLow <= maxCoverageLow },
    { name: 'min_predictive_component_coverage', current: minObservedCoverage, target: minCoverage, ok: minObservedCoverage == null ? targetRows.length === 0 : minObservedCoverage >= minCoverage },
  ];
  const gaps = checks.filter((check) => !check.ok);
  const refreshSymbols = targetRows
    .filter((row) => (row?.reasons || []).some((reason) => String(reason).startsWith('predictive_')))
    .map((row) => row.symbol);
  const backtestGateSuppressedSymbols = rows
    .filter((row) => isBacktestGatePredictiveBlock(row))
    .map((row) => row.symbol);
  return {
    achieved: gaps.length === 0,
    mode: 'shadow_predictive_quality_slo',
    total,
    targetTotal: targetRows.length,
    backtestGateSuppressed,
    backtestGateSuppressedSymbols,
    passCandidates,
    predictiveBlocked,
    predictiveMissingOrStale,
    predictiveCoverageLow,
    minObservedCoverage,
    avgObservedCoverage,
    checks,
    gaps,
    refreshSymbols,
    recommendedLoop: refreshSymbols.length
      ? [
        `npm --prefix bots/investment run -s runtime:luna-predictive-evidence-refresh -- --json --dry-run --market=all --symbols=${refreshSymbols.join(',')}`,
        `npm --prefix bots/investment run -s runtime:luna-candidate-bottleneck-diagnostics -- --json --dry-run --market=all --symbols=${refreshSymbols.join(',')}`,
      ]
      : [
        'npm --prefix bots/investment run -s runtime:luna-predictive-evidence-refresh -- --json --dry-run --market=all --limit=20',
      ],
    liveMutation: false,
  };
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
    selectionPolicy: 'quality_adjusted_score_desc_with_prior_bottleneck_penalty',
    priorPenaltyApplied: rows.filter((row) => Number(row.priorCandidateSelectionPenalty || 0) > 0).length,
    traceFields: [
      'backtestFresh',
      'backtestGateStatus',
      'backtestBlockReasons',
      'backtestPeriodSummary',
      'backtestStrategyFamilies',
      'backtestFailingPeriods',
      'backtestUnstableOrUnrealistic',
      'predictiveDecision',
      'predictiveScore',
      'predictiveCoverage',
      'predictiveBlockedReason',
      'communityEvidenceCount24h',
      'communitySourceCount24h',
      'primaryBlocker',
      'recommendedRefreshCommand',
      'binanceTop30Rank',
      'inBinanceTop30Universe',
      'top30Blocker',
      'liquidationCandidate',
    ],
    averagePenalty: rows.length
      ? Number((rows.reduce((sum, row) => sum + Number(row.candidateSelectionPenalty || 0), 0) / rows.length).toFixed(4))
      : 0,
    liveMutation: false,
  };
  summary.backtestQualityTarget = buildBacktestQualityTarget(rows, summary, options);
  summary.predictiveQualityTarget = buildPredictiveQualityTarget(rows, options);
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
