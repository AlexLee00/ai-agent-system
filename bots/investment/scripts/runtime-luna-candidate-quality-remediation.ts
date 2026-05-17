#!/usr/bin/env node
// @ts-nocheck

import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';
import { runCandidateBacktestRefresh } from './runtime-luna-candidate-backtest-refresh.ts';
import { runLunaCandidateBottleneckDiagnostics } from './runtime-luna-candidate-bottleneck-diagnostics.ts';
import { runLunaCommunityCoverageGate } from './runtime-luna-community-coverage-gate.ts';
import { runLunaPhase4StrategyEnhancementShadow } from './runtime-luna-phase4-strategy-enhancement-shadow.ts';
import { runLunaPredictiveEvidenceRefresh } from './runtime-luna-predictive-evidence-refresh.ts';

export const CONFIRM = 'luna-candidate-quality-remediation-shadow';

function argValue(name, fallback = null) {
  const prefix = `--${name}=`;
  const found = process.argv.find((item) => item.startsWith(prefix));
  return found ? found.slice(prefix.length) : fallback;
}

function hasFlag(name) {
  return process.argv.includes(`--${name}`);
}

function n(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function countBy(rows = [], key) {
  return rows.reduce((acc, row) => {
    const value = row?.[key] || 'unknown';
    acc[value] = (acc[value] || 0) + 1;
    return acc;
  }, {});
}

function fixtureCoverageGate() {
  return {
    ok: true,
    fixture: true,
    blockers: [],
    warnings: [],
    summary: { totalMarkets: 3, passMarkets: 3, totalEvents: 36, totalUniqueSources: 9 },
    markets: [
      { market: 'crypto', pass: true, eventCount: 20, uniqueSourceCount: 4 },
      { market: 'domestic', pass: true, eventCount: 8, uniqueSourceCount: 3 },
      { market: 'overseas', pass: true, eventCount: 8, uniqueSourceCount: 3 },
    ],
  };
}

function plannedCommands({ market, limit, forceBacktest = false }) {
  const marketArg = market && market !== 'all' ? ` --market=${market}` : ' --market=all';
  const limitArg = ` --limit=${limit}`;
  const forceArg = forceBacktest ? ' --force' : '';
  return [
    `npm --prefix bots/investment run -s runtime:luna-candidate-backtest-refresh -- --json${forceArg}${marketArg}${limitArg}`,
    `npm --prefix bots/investment run -s runtime:luna-predictive-evidence-refresh -- --json${marketArg}${limitArg}`,
    `npm --prefix bots/investment run -s runtime:luna-phase4-strategy-enhancement-shadow -- --json --apply --confirm=luna-phase4-strategy-enhancement-shadow${marketArg}${limitArg}`,
    `npm --prefix bots/investment run -s runtime:luna-candidate-bottleneck-diagnostics -- --json --apply --confirm=luna-candidate-bottleneck-shadow${marketArg}${limitArg}`,
  ];
}

function shouldRunBacktest(initialRows = []) {
  return initialRows.some((row) => [
    'backtest_missing_or_stale',
    'backtest_unhealthy_or_would_block',
    'drawdown_high',
    'sharpe_negative',
    'win_rate_low',
  ].includes(row?.primaryBlocker) || (row?.reasons || []).some((reason) => String(reason).startsWith('backtest_')));
}

function shouldRunPredictive(initialRows = []) {
  return initialRows.some((row) => (row?.reasons || []).some((reason) => String(reason).startsWith('predictive_') || reason === 'backtest_missing_or_stale' || reason === 'backtest_unhealthy_or_would_block'));
}

function shouldRunStrategy(initialRows = []) {
  return initialRows.some((row) => row?.recommendedAction === 'strategy_enhancement_shadow' || (row?.reasons || []).includes('drawdown_high'));
}

async function withSuppressedStdout(enabled, fn) {
  if (!enabled) return fn();
  const originalLog = console.log;
  console.log = () => {};
  try {
    return await fn();
  } finally {
    console.log = originalLog;
  }
}

export async function runLunaCandidateQualityRemediation(options = {}) {
  const apply = options.apply === true;
  const dryRun = options.dryRun === true || !apply;
  const fixture = options.fixture === true;
  const json = options.json === true;
  const confirm = String(options.confirm || '');
  const market = String(options.market || 'all').trim().toLowerCase() || 'all';
  const limit = Math.max(1, n(options.limit || process.env.LUNA_CANDIDATE_QUALITY_REMEDIATION_LIMIT || 50, 50));
  const forceBacktest = options.forceBacktest === true || String(process.env.LUNA_CANDIDATE_QUALITY_FORCE_BACKTEST || '').toLowerCase() === 'true';

  if (apply && options.dryRun === true) {
    throw new Error('runtime:luna-candidate-quality-remediation cannot combine --apply with --dry-run');
  }
  if (apply && confirm !== CONFIRM) {
    throw new Error(`runtime:luna-candidate-quality-remediation apply requires --confirm=${CONFIRM}`);
  }

  const coverage = fixture
    ? fixtureCoverageGate()
    : await withSuppressedStdout(json, () => runLunaCommunityCoverageGate({ json: true }));
  const initialDiagnostics = await withSuppressedStdout(json, () => runLunaCandidateBottleneckDiagnostics({
    json: true,
    dryRun: true,
    fixture,
    market,
    limit,
  }));
  const initialRows = initialDiagnostics.rows || [];
  const planned = plannedCommands({ market, limit, forceBacktest });

  const remediationPlan = {
    backtestRefresh: shouldRunBacktest(initialRows),
    predictiveRefresh: shouldRunPredictive(initialRows),
    strategyEnhancementShadow: shouldRunStrategy(initialRows),
    bottleneckShadowAudit: initialRows.some((row) => row?.recommendedAction !== 'monitor_pass_candidate'),
  };

  const executed = {
    backtestRefresh: null,
    predictiveRefresh: null,
    strategyEnhancementShadow: null,
    bottleneckShadowAudit: null,
  };

  if (apply && !dryRun) {
    if (remediationPlan.backtestRefresh) {
      executed.backtestRefresh = await withSuppressedStdout(json, () => runCandidateBacktestRefresh({
        json: true,
        fixture,
        dryRun: false,
        force: forceBacktest,
        market,
        limit,
      }));
    }
    if (remediationPlan.predictiveRefresh) {
      executed.predictiveRefresh = await withSuppressedStdout(json, () => runLunaPredictiveEvidenceRefresh({
        json: true,
        fixture,
        dryRun: false,
        market,
        limit,
      }));
    }
    if (remediationPlan.strategyEnhancementShadow) {
      executed.strategyEnhancementShadow = await withSuppressedStdout(json, () => runLunaPhase4StrategyEnhancementShadow({
        json: true,
        fixture,
        apply: true,
        dryRun: false,
        confirm: 'luna-phase4-strategy-enhancement-shadow',
        market,
        limit,
      }));
    }
    if (remediationPlan.bottleneckShadowAudit) {
      executed.bottleneckShadowAudit = await withSuppressedStdout(json, () => runLunaCandidateBottleneckDiagnostics({
        json: true,
        fixture,
        apply: true,
        dryRun: false,
        confirm: 'luna-candidate-bottleneck-shadow',
        market,
        limit,
      }));
    }
  }

  const finalDiagnostics = apply && !dryRun
    ? await withSuppressedStdout(json, () => runLunaCandidateBottleneckDiagnostics({
      json: true,
      dryRun: true,
      fixture,
      market,
      limit,
    }))
    : null;
  const finalRows = finalDiagnostics?.rows || initialRows;
  const byAction = countBy(finalRows, 'recommendedAction');

  const payload = {
    ok: true,
    status: apply ? 'luna_candidate_quality_remediation_shadow_written' : 'luna_candidate_quality_remediation_planned',
    phase: 'luna_candidate_quality_feedback',
    dryRun,
    apply,
    fixture,
    writeMode: apply ? 'shadow-apply' : 'plan-only',
    shadowMode: true,
    confirmToken: CONFIRM,
    market,
    limit,
    forceBacktest,
    coverage: {
      ok: coverage?.ok === true,
      blockers: coverage?.blockers || [],
      warnings: coverage?.warnings || [],
      summary: coverage?.summary || {},
    },
    remediationPlan,
    plannedCommands: planned,
    executed,
    summary: {
      initial: initialDiagnostics.summary,
      final: finalDiagnostics?.summary || null,
      remainingByAction: byAction,
      remainingTopPrimaryBlockers: finalDiagnostics?.summary?.topPrimaryBlockers || initialDiagnostics.summary?.topPrimaryBlockers || [],
      liveMutation: false,
    },
  };

  if (!json) {
    console.log(`[luna-candidate-quality] ${payload.status} market=${market} plan=${JSON.stringify(remediationPlan)} remaining=${JSON.stringify(byAction)}`);
  }
  return payload;
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({
    run: async () => runLunaCandidateQualityRemediation({
      json: hasFlag('json'),
      dryRun: hasFlag('dry-run'),
      apply: hasFlag('apply'),
      fixture: hasFlag('fixture'),
      market: argValue('market', process.env.LUNA_CANDIDATE_QUALITY_REMEDIATION_MARKET || 'all'),
      limit: Number(argValue('limit', process.env.LUNA_CANDIDATE_QUALITY_REMEDIATION_LIMIT || 50)),
      forceBacktest: hasFlag('force-backtest'),
      confirm: argValue('confirm', ''),
    }),
    onSuccess: async (result) => console.log(JSON.stringify(result, null, 2)),
    errorPrefix: 'runtime-luna-candidate-quality-remediation error:',
  });
}
