#!/usr/bin/env node
// @ts-nocheck

import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';
import { loadLunaCandidateQualityCooldownSymbols } from '../shared/luna-candidate-quality-governance.ts';
import { normalizeLunaPhase2Symbol } from '../shared/luna-weight-vector.ts';
import { runCandidateBacktestRefresh } from './runtime-luna-candidate-backtest-refresh.ts';
import { runDiscoveryOrchestratorRefresh } from './runtime-discovery-orchestrator-refresh.ts';
import { runLunaCandidateBottleneckDiagnostics } from './runtime-luna-candidate-bottleneck-diagnostics.ts';
import {
  CONFIRM as QUALITY_GOVERNANCE_CONFIRM,
  runLunaCandidateQualityGovernanceShadow,
} from './runtime-luna-candidate-quality-governance-shadow.ts';
import { runLunaCommunityCoverageGate } from './runtime-luna-community-coverage-gate.ts';
import {
  CONFIRM as MARKET_SEED_CONFIRM,
  runLunaMarketCandidateSeedRefresh,
} from './runtime-luna-market-candidate-seed-refresh.ts';
import { runLunaPaperPromotionGateShadow } from './runtime-luna-paper-promotion-gate.ts';
import { runLunaPaperTradingShadow } from './runtime-luna-paper-trading-shadow.ts';
import { runLunaPhase4StrategyEnhancementShadow } from './runtime-luna-phase4-strategy-enhancement-shadow.ts';
import { runLunaPredictiveEvidenceRefresh } from './runtime-luna-predictive-evidence-refresh.ts';
import { runLunaWeightVectorShadow } from './runtime-luna-weight-vector-shadow.ts';

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

function uniqueSymbols(values = [], max = 50) {
  return [...new Set((values || [])
    .map((value) => normalizeLunaPhase2Symbol(value))
    .filter(Boolean))]
    .slice(0, Math.max(1, Number(max || 50)));
}

function symbolsFromRows(rows = [], predicate = () => true, max = 50) {
  return uniqueSymbols(
    (rows || [])
      .filter((row) => predicate(row))
      .map((row) => row?.symbol),
    max,
  );
}

function symbolsArg(symbols = []) {
  return symbols.length ? ` --symbols=${symbols.join(',')}` : '';
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

function plannedCommands({ market, limit, forceBacktest = false, plan = {}, targetSymbols = {}, backtestPeriods = null }) {
  const marketArg = market && market !== 'all' ? ` --market=${market}` : ' --market=all';
  const limitArg = ` --limit=${limit}`;
  const forceArg = forceBacktest ? ' --force' : '';
  const periodsArg = backtestPeriods ? ` --periods=${backtestPeriods}` : '';
  const commands = [];
  if (plan.discoveryRefresh) commands.push('npm --prefix bots/investment run -s runtime:luna-discovery-refresh -- --json --force --markets=crypto,domestic,overseas --limit=30 --ttl-hours=6');
  if (plan.marketCandidateSeedRefresh) commands.push(`npm --prefix bots/investment run -s runtime:luna-market-candidate-seed-refresh -- --json --apply --confirm=${MARKET_SEED_CONFIRM} --markets=domestic,overseas --limit=5`);
  if (plan.backtestRefresh || plan.marketCandidateSeedRefresh) commands.push(`npm --prefix bots/investment run -s runtime:luna-candidate-backtest-refresh -- --json${forceArg}${periodsArg}${marketArg}${limitArg}${symbolsArg(targetSymbols.backtestSymbols)}`);
  if (plan.predictiveRefresh || plan.marketCandidateSeedRefresh) commands.push(`npm --prefix bots/investment run -s runtime:luna-predictive-evidence-refresh -- --json${marketArg}${limitArg}${symbolsArg(targetSymbols.predictiveSymbols)}`);
  if (plan.strategyEnhancementShadow || plan.backtestRefresh || plan.marketCandidateSeedRefresh) commands.push(`npm --prefix bots/investment run -s runtime:luna-phase4-strategy-enhancement-shadow -- --json --apply --confirm=luna-phase4-strategy-enhancement-shadow${marketArg}${limitArg}${symbolsArg(targetSymbols.strategySymbols)}`);
  if (plan.bottleneckShadowAudit || plan.strategyEnhancementShadow || plan.backtestRefresh || plan.marketCandidateSeedRefresh) commands.push(`npm --prefix bots/investment run -s runtime:luna-candidate-bottleneck-diagnostics -- --json --apply --confirm=luna-candidate-bottleneck-shadow${marketArg}${limitArg}${symbolsArg(targetSymbols.bottleneckSymbols)}`);
  if (plan.candidateQualityGovernance) commands.push(`npm --prefix bots/investment run -s runtime:luna-candidate-quality-governance -- --json --apply --confirm=${QUALITY_GOVERNANCE_CONFIRM}${marketArg}${limitArg}${symbolsArg(targetSymbols.governanceSymbols)}`);
  if (plan.weightVectorShadow) commands.push(`npm --prefix bots/investment run -s runtime:luna-weight-vector-shadow -- --json --apply --confirm=luna-weight-vector-shadow${marketArg}${limitArg}${symbolsArg(targetSymbols.weightSymbols)}`);
  if (plan.paperTradingShadow) commands.push(`npm --prefix bots/investment run -s runtime:luna-paper-trading-shadow -- --json --apply --confirm=luna-paper-trading-shadow${marketArg}${limitArg}${symbolsArg(targetSymbols.paperTradingSymbols)}`);
  if (plan.paperPromotionGate) commands.push(`npm --prefix bots/investment run -s runtime:luna-paper-promotion-gate -- --json --apply --confirm=luna-paper-promotion-gate-shadow${marketArg} --limit=500${symbolsArg(targetSymbols.paperPromotionSymbols)}`);
  return commands;
}

function shouldRunMarketSeed(coverage = {}, initialRows = [], market = 'all') {
  const requestedMarket = String(market || 'all').toLowerCase();
  if (requestedMarket === 'crypto') return false;
  const stockMarkets = requestedMarket === 'all'
    ? ['domestic', 'overseas']
    : ['domestic', 'overseas'].filter((item) => item === requestedMarket);
  if (stockMarkets.length === 0) return false;

  const warnings = coverage?.warnings || [];
  if (warnings.some((warning) => String(warning).includes('marketwide_only_or_unmapped_symbols'))) return true;

  const rowsByMarket = countBy(initialRows, 'market');
  const markets = coverage?.markets || [];
  return stockMarkets.some((stockMarket) => {
    const coverageMarket = markets.find((item) => item.market === stockMarket) || {};
    const seedCandidateCount = n(coverageMarket.seedCandidateCount ?? coverageMarket.seed_candidate_count, 0);
    const symbolCount = n(coverageMarket.symbolCount ?? coverageMarket.symbol_count, 0);
    const activeCandidateCount = n(rowsByMarket[stockMarket], 0);
    return activeCandidateCount < 3 || (symbolCount === 0 && seedCandidateCount === 0);
  });
}

function shouldRunBacktest(initialRows = []) {
  return initialRows.some((row) => rowNeedsBacktestRefresh(row));
}

function rowNeedsBacktestRefresh(row = {}) {
  const reasons = row?.reasons || [];
  return [
    'backtest_missing_or_stale',
    'backtest_unstable_or_unrealistic',
    'backtest_unhealthy_or_would_block',
    'drawdown_high',
    'sharpe_negative',
    'win_rate_low',
  ].includes(row?.primaryBlocker) || reasons.some((reason) => String(reason).startsWith('backtest_') || [
    'drawdown_high',
    'sharpe_negative',
    'win_rate_low',
  ].includes(reason));
}

function shouldUseStabilityBacktestPeriods(initialRows = []) {
  return initialRows.some((row) => row?.primaryBlocker === 'backtest_unstable_or_unrealistic'
    || (row?.reasons || []).includes('backtest_unstable_or_unrealistic')
    || row?.recommendedAction === 'stabilize_backtest_shadow');
}

function backtestRefreshPriority(row = {}) {
  const reasons = (row?.reasons || []).map((reason) => String(reason));
  const primary = String(row?.primaryBlocker || '');
  const hasMissingOrStale = primary === 'backtest_missing_or_stale'
    || reasons.some((reason) => reason === 'backtest_missing_or_stale'
      || reason.includes('missing')
      || reason.includes('stale')
      || reason === 'no_backtest_data');
  if (hasMissingOrStale) return 0;
  if (primary === 'backtest_unstable_or_unrealistic') return 1;
  if (reasons.some((reason) => reason === 'backtest_unstable_or_unrealistic')) return 1;
  if (['drawdown_high', 'sharpe_negative', 'win_rate_low'].includes(primary)) return 1;
  if (reasons.some((reason) => ['drawdown_high', 'sharpe_negative', 'win_rate_low'].includes(reason))) return 1;
  if (primary === 'backtest_unhealthy_or_would_block') return 2;
  if (reasons.some((reason) => reason.startsWith('backtest_'))) return 2;
  return 9;
}

function isBacktestStabilizationRow(row = {}) {
  return row?.primaryBlocker === 'backtest_unstable_or_unrealistic'
    || row?.recommendedAction === 'stabilize_backtest_shadow'
    || (row?.reasons || []).includes('backtest_unstable_or_unrealistic');
}

function cooldownKey(row = {}) {
  return `${String(row?.symbol || '').toUpperCase()}|${String(row?.market || 'all').toLowerCase()}`;
}

function cooldownActionFor(row = {}, cooldownIndex = new Set()) {
  const key = cooldownKey(row);
  if (cooldownIndex instanceof Map) return cooldownIndex.get(key) || null;
  return cooldownIndex.has(key) ? 'candidate_cooldown_shadow' : null;
}

function backtestTargetSymbols(initialRows = [], maxSymbols = 12, cooldownKeys = new Set()) {
  const targets = [];
  const prioritizedRows = [...(initialRows || [])]
    .map((row, index) => ({ row, index, priority: backtestRefreshPriority(row) }))
    .sort((a, b) => a.priority - b.priority || a.index - b.index)
    .map((item) => item.row);
  for (const row of prioritizedRows) {
    const cooldownAction = cooldownActionFor(row, cooldownKeys);
    const cooldownBlocked = cooldownAction === 'backtest_stabilization_shadow'
      || (Boolean(cooldownAction) && !isBacktestStabilizationRow(row));
    if (rowNeedsBacktestRefresh(row) && row?.symbol && !cooldownBlocked) targets.push(String(row.symbol).toUpperCase());
  }
  return [...new Set(targets)].slice(0, Math.max(1, Number(maxSymbols || 12)));
}

function summarizeCooldownRows(rows = []) {
  const now = Date.now();
  const byAction = countBy(rows, 'governanceAction');
  const futureRows = (rows || [])
    .map((row) => ({ ...row, cooldownTs: Date.parse(row?.cooldownUntil || '') }))
    .filter((row) => Number.isFinite(row.cooldownTs) && row.cooldownTs > now)
    .sort((a, b) => a.cooldownTs - b.cooldownTs);
  const next = futureRows[0] || null;
  return {
    total: rows.length,
    byAction,
    backtestStabilization: n(byAction.backtest_stabilization_shadow, 0),
    candidateCooldown: n(byAction.candidate_cooldown_shadow, 0),
    nextReleaseAt: next?.cooldownUntil || null,
    nextReleaseSymbol: next?.symbol || null,
    nextReleaseMarket: next?.market || null,
  };
}

function backtestCooldownBlockedRows(initialRows = [], cooldownRows = [], max = 20) {
  const cooldownByKey = new Map((cooldownRows || []).map((row) => [row.key, row]));
  const blocked = [];
  for (const row of initialRows || []) {
    if (!rowNeedsBacktestRefresh(row)) continue;
    const cooldown = cooldownByKey.get(cooldownKey(row));
    if (!cooldown) continue;
    const action = cooldown.governanceAction || null;
    const blockedByCooldown = action === 'backtest_stabilization_shadow'
      || (Boolean(action) && !isBacktestStabilizationRow(row));
    if (!blockedByCooldown) continue;
    blocked.push({
      symbol: row.symbol,
      market: row.market,
      primaryBlocker: row.primaryBlocker,
      recommendedAction: row.recommendedAction,
      cooldownAction: action,
      cooldownUntil: cooldown.cooldownUntil || null,
    });
  }
  return blocked.slice(0, Math.max(1, Number(max || 20)));
}

function shouldRunPredictive(initialRows = []) {
  return initialRows.some((row) => (row?.reasons || []).some((reason) => String(reason).startsWith('predictive_') || reason === 'backtest_missing_or_stale' || reason === 'backtest_unhealthy_or_would_block'));
}

function needsPredictiveRefresh(row = {}) {
  return (row?.reasons || []).some((reason) => String(reason).startsWith('predictive_')
    || reason === 'backtest_missing_or_stale'
    || reason === 'backtest_unhealthy_or_would_block');
}

function shouldRunStrategy(initialRows = []) {
  return initialRows.some((row) => row?.recommendedAction === 'strategy_enhancement_shadow' || (row?.reasons || []).includes('drawdown_high'));
}

function needsStrategyRefresh(row = {}) {
  return row?.recommendedAction === 'strategy_enhancement_shadow' || (row?.reasons || []).includes('drawdown_high');
}

function shouldRunDiscoveryRefresh(initialRows = [], summary = {}) {
  if (!initialRows.length) return true;
  const monitorPasses = n(summary?.byAction?.monitor_pass_candidate, 0);
  const refreshEvidence = n(summary?.byAction?.refresh_evidence, 0);
  const strategyReview = n(summary?.byAction?.strategy_enhancement_shadow, 0);
  const quarantine = n(summary?.byAction?.quarantine_candidate_shadow, 0);
  const badCandidateRatio = (strategyReview + quarantine + refreshEvidence) / Math.max(1, initialRows.length);
  return monitorPasses === 0 || quarantine > 0 || badCandidateRatio >= 0.55;
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
  const maxBacktestSymbols = Math.max(1, n(options.maxBacktestSymbols || process.env.LUNA_CANDIDATE_QUALITY_MAX_BACKTEST_SYMBOLS || 12, 12));
  const maxPredictiveSymbols = Math.max(1, n(options.maxPredictiveSymbols || process.env.LUNA_CANDIDATE_QUALITY_MAX_PREDICTIVE_SYMBOLS || 24, 24));
  const maxStrategySymbols = Math.max(1, n(options.maxStrategySymbols || process.env.LUNA_CANDIDATE_QUALITY_MAX_STRATEGY_SYMBOLS || 16, 16));
  const maxShadowSymbols = Math.max(1, n(options.maxShadowSymbols || process.env.LUNA_CANDIDATE_QUALITY_MAX_SHADOW_SYMBOLS || 30, 30));
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
  const cooldownRows = fixture || forceBacktest
    ? []
    : await withSuppressedStdout(json, () => loadLunaCandidateQualityCooldownSymbols({ market, limit: 500 }));
  const cooldownSymbolKeys = new Map((cooldownRows || []).map((row) => [row.key, row.governanceAction]));
  const cooldownSummary = summarizeCooldownRows(cooldownRows);
  const allBacktestCooldownBlocked = backtestCooldownBlockedRows(initialRows, cooldownRows, limit);
  const backtestCooldownBlocked = allBacktestCooldownBlocked.slice(0, maxBacktestSymbols);
  const needsBacktestRefresh = shouldRunBacktest(initialRows);
  const targetedBacktestSymbols = backtestTargetSymbols(initialRows, maxBacktestSymbols, cooldownSymbolKeys);
  const targetedPredictiveSymbols = symbolsFromRows(initialRows, needsPredictiveRefresh, Math.min(limit, maxPredictiveSymbols));
  const targetedStrategySymbols = symbolsFromRows(initialRows, needsStrategyRefresh, Math.min(limit, maxStrategySymbols));
  const targetedEvidenceSymbols = symbolsFromRows(initialRows, () => true, Math.min(limit, maxShadowSymbols));
  const effectiveForceBacktest = forceBacktest || targetedBacktestSymbols.length > 0;
  const backtestPeriods = shouldUseStabilityBacktestPeriods(initialRows) ? '30,90,180,365' : null;
  const marketCandidateSeedRefresh = shouldRunMarketSeed(coverage, initialRows, market);
  const plannedBacktestRefresh = needsBacktestRefresh
    && (forceBacktest || targetedBacktestSymbols.length > 0 || marketCandidateSeedRefresh);

  const remediationPlan = {
    discoveryRefresh: shouldRunDiscoveryRefresh(initialRows, initialDiagnostics.summary),
    marketCandidateSeedRefresh,
    backtestRefresh: plannedBacktestRefresh,
    predictiveRefresh: shouldRunPredictive(initialRows),
    strategyEnhancementShadow: shouldRunStrategy(initialRows),
    bottleneckShadowAudit: initialRows.some((row) => row?.recommendedAction !== 'monitor_pass_candidate'),
    candidateQualityGovernance: initialRows.length > 0,
    weightVectorShadow: initialRows.length > 0,
    paperTradingShadow: initialRows.length > 0,
    paperPromotionGate: initialRows.length > 0,
  };
  const planned = plannedCommands({
    market,
    limit,
    forceBacktest: effectiveForceBacktest,
    plan: remediationPlan,
    backtestPeriods,
    targetSymbols: {
      backtestSymbols: targetedBacktestSymbols,
      predictiveSymbols: targetedPredictiveSymbols,
      strategySymbols: targetedStrategySymbols,
      bottleneckSymbols: targetedEvidenceSymbols,
      governanceSymbols: targetedEvidenceSymbols,
      weightSymbols: targetedEvidenceSymbols,
      paperTradingSymbols: targetedEvidenceSymbols,
      paperPromotionSymbols: targetedEvidenceSymbols,
    },
  });

  const executed = {
    discoveryRefresh: null,
    marketCandidateSeedRefresh: null,
    backtestRefresh: null,
    predictiveRefresh: null,
    strategyEnhancementShadow: null,
    bottleneckShadowAudit: null,
    candidateQualityGovernance: null,
    weightVectorShadow: null,
    paperTradingShadow: null,
    paperPromotionGate: null,
  };

  if (apply && !dryRun) {
    if (remediationPlan.discoveryRefresh) {
      executed.discoveryRefresh = await withSuppressedStdout(json, () => runDiscoveryOrchestratorRefresh({
        markets: ['crypto', 'domestic', 'overseas'],
        dryRun: false,
        skipDbWrite: false,
        limit: 30,
        timeoutMs: 8000,
        ttlHours: 6,
        force: true,
      }));
    }
    if (remediationPlan.marketCandidateSeedRefresh) {
      executed.marketCandidateSeedRefresh = await withSuppressedStdout(json, () => runLunaMarketCandidateSeedRefresh({
        json: true,
        fixture,
        apply: true,
        dryRun: false,
        confirm: MARKET_SEED_CONFIRM,
        market: 'domestic,overseas',
        limit: 5,
        ttlHours: 24,
      }));
    }
    if (remediationPlan.backtestRefresh || remediationPlan.marketCandidateSeedRefresh) {
      executed.backtestRefresh = await withSuppressedStdout(json, () => runCandidateBacktestRefresh({
        json: true,
        fixture,
        dryRun: false,
        force: effectiveForceBacktest || remediationPlan.marketCandidateSeedRefresh,
        periods: backtestPeriods || undefined,
        market,
        limit,
        symbols: targetedBacktestSymbols.join(','),
      }));
    }
    if (remediationPlan.predictiveRefresh || remediationPlan.marketCandidateSeedRefresh) {
      executed.predictiveRefresh = await withSuppressedStdout(json, () => runLunaPredictiveEvidenceRefresh({
        json: true,
        fixture,
        dryRun: false,
        market,
        limit,
        symbols: targetedPredictiveSymbols.join(','),
      }));
    }
    if (remediationPlan.strategyEnhancementShadow || remediationPlan.backtestRefresh || remediationPlan.marketCandidateSeedRefresh) {
      executed.strategyEnhancementShadow = await withSuppressedStdout(json, () => runLunaPhase4StrategyEnhancementShadow({
        json: true,
        fixture,
        apply: true,
        dryRun: false,
        confirm: 'luna-phase4-strategy-enhancement-shadow',
        market,
        limit,
        symbols: targetedStrategySymbols.join(','),
      }));
    }
    if (remediationPlan.bottleneckShadowAudit || remediationPlan.strategyEnhancementShadow || remediationPlan.backtestRefresh || remediationPlan.marketCandidateSeedRefresh) {
      executed.bottleneckShadowAudit = await withSuppressedStdout(json, () => runLunaCandidateBottleneckDiagnostics({
        json: true,
        fixture,
        apply: true,
        dryRun: false,
        confirm: 'luna-candidate-bottleneck-shadow',
        market,
        limit,
        symbols: targetedEvidenceSymbols.join(','),
      }));
    }
    if (remediationPlan.candidateQualityGovernance) {
      executed.candidateQualityGovernance = await withSuppressedStdout(json, () => runLunaCandidateQualityGovernanceShadow({
        json: true,
        fixture,
        apply: true,
        dryRun: false,
        confirm: QUALITY_GOVERNANCE_CONFIRM,
        market,
        limit,
        symbols: targetedEvidenceSymbols.join(','),
      }));
    }
    if (remediationPlan.weightVectorShadow) {
      executed.weightVectorShadow = await withSuppressedStdout(json, () => runLunaWeightVectorShadow({
        json: true,
        fixture,
        apply: true,
        dryRun: false,
        confirm: 'luna-weight-vector-shadow',
        market,
        limit,
        symbols: targetedEvidenceSymbols.join(','),
      }));
    }
    if (remediationPlan.paperTradingShadow) {
      executed.paperTradingShadow = await withSuppressedStdout(json, () => runLunaPaperTradingShadow({
        json: true,
        fixture,
        apply: true,
        dryRun: false,
        confirm: 'luna-paper-trading-shadow',
        market,
        limit,
        symbols: targetedEvidenceSymbols.join(','),
      }));
    }
    if (remediationPlan.paperPromotionGate) {
      executed.paperPromotionGate = await withSuppressedStdout(json, () => runLunaPaperPromotionGateShadow({
        json: true,
        fixture,
        apply: true,
        dryRun: false,
        confirm: 'luna-paper-promotion-gate-shadow',
        market,
        limit: 500,
        hours: 24,
        symbols: targetedEvidenceSymbols.join(','),
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
      symbols: targetedEvidenceSymbols.join(','),
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
    maxBacktestSymbols,
    maxPredictiveSymbols,
    maxStrategySymbols,
    maxShadowSymbols,
    backtestCooldownBlockedCount: allBacktestCooldownBlocked.length,
    targetedBacktestSymbols,
    backtestCooldownBlocked,
    targetedSymbols: {
      predictiveSymbols: targetedPredictiveSymbols,
      strategySymbols: targetedStrategySymbols,
      bottleneckSymbols: targetedEvidenceSymbols,
      governanceSymbols: targetedEvidenceSymbols,
      weightSymbols: targetedEvidenceSymbols,
      paperTradingSymbols: targetedEvidenceSymbols,
      paperPromotionSymbols: targetedEvidenceSymbols,
    },
    cooldownSymbolsSkipped: cooldownRows,
    cooldownSummary,
    forceBacktest: effectiveForceBacktest,
    backtestPeriods,
    coverage: {
      ok: coverage?.ok === true,
      blockers: coverage?.blockers || [],
      warnings: coverage?.warnings || [],
      summary: coverage?.summary || {},
      markets: coverage?.markets || [],
    },
    remediationPlan,
    plannedCommands: planned,
    executed,
    summary: {
      initial: initialDiagnostics.summary,
      final: finalDiagnostics?.summary || null,
      remainingByAction: byAction,
      remainingTopPrimaryBlockers: finalDiagnostics?.summary?.topPrimaryBlockers || initialDiagnostics.summary?.topPrimaryBlockers || [],
      marketSeedPlanned: remediationPlan.marketCandidateSeedRefresh,
      discoveryRefreshPlanned: remediationPlan.discoveryRefresh,
      discoveryRefresh: executed.discoveryRefresh ? {
        status: executed.discoveryRefresh.status,
        ok: executed.discoveryRefresh.ok,
        emptyMarkets: executed.discoveryRefresh.emptyMarkets,
        merged: executed.discoveryRefresh.merged,
        errorCount: executed.discoveryRefresh.stats?.errorCount ?? null,
      } : null,
      candidateQualityGovernance: executed.candidateQualityGovernance?.summary || null,
      paperPromotion: executed.paperPromotionGate?.summary || null,
      paperPromotionReadiness: executed.paperPromotionGate?.readinessSummary || null,
      weightVector: executed.weightVectorShadow?.summary || null,
      paperTrading: executed.paperTradingShadow?.summary || null,
      cooldownSummary,
      backtestCooldownBlockedCount: allBacktestCooldownBlocked.length,
      backtestCooldownBlocked: backtestCooldownBlocked.slice(0, 10),
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
      maxBacktestSymbols: Number(argValue('max-backtest-symbols', process.env.LUNA_CANDIDATE_QUALITY_MAX_BACKTEST_SYMBOLS || 12)),
      maxPredictiveSymbols: Number(argValue('max-predictive-symbols', process.env.LUNA_CANDIDATE_QUALITY_MAX_PREDICTIVE_SYMBOLS || 24)),
      maxStrategySymbols: Number(argValue('max-strategy-symbols', process.env.LUNA_CANDIDATE_QUALITY_MAX_STRATEGY_SYMBOLS || 16)),
      maxShadowSymbols: Number(argValue('max-shadow-symbols', process.env.LUNA_CANDIDATE_QUALITY_MAX_SHADOW_SYMBOLS || 30)),
      forceBacktest: hasFlag('force-backtest'),
      confirm: argValue('confirm', ''),
    }),
    onSuccess: async (result) => console.log(JSON.stringify(result, null, 2)),
    errorPrefix: 'runtime-luna-candidate-quality-remediation error:',
  });
}

export const __test = {
  backtestTargetSymbols,
  backtestCooldownBlockedRows,
  summarizeCooldownRows,
  shouldUseStabilityBacktestPeriods,
};
