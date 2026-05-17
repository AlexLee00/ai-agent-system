#!/usr/bin/env node
// @ts-nocheck

import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';
import { runCandidateBacktestRefresh } from './runtime-luna-candidate-backtest-refresh.ts';
import {
  CONFIRM as QUALITY_GOVERNANCE_CONFIRM,
  runLunaCandidateQualityGovernanceShadow,
} from './runtime-luna-candidate-quality-governance-shadow.ts';
import { runLunaPaperPromotionGateShadow } from './runtime-luna-paper-promotion-gate.ts';
import { runLunaPaperTradingShadow } from './runtime-luna-paper-trading-shadow.ts';
import { runLunaPhase4StrategyEnhancementShadow } from './runtime-luna-phase4-strategy-enhancement-shadow.ts';
import { runLunaPredictiveEvidenceRefresh } from './runtime-luna-predictive-evidence-refresh.ts';
import { runLunaWeightVectorShadow } from './runtime-luna-weight-vector-shadow.ts';

export const CONFIRM = 'luna-promotion-readiness-assist-shadow';

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

function marketArg(market) {
  const normalized = String(market || 'all').trim().toLowerCase() || 'all';
  return normalized === 'all' ? ' --market=all' : ` --market=${normalized}`;
}

function unique(values = []) {
  return [...new Set((values || []).map((value) => String(value || '').trim()).filter(Boolean))];
}

function countBy(rows = [], selector = () => 'unknown') {
  return rows.reduce((acc, row) => {
    const key = selector(row) || 'unknown';
    acc[key] = (acc[key] || 0) + 1;
    return acc;
  }, {});
}

function assistActionsForTarget(target = {}) {
  const cls = String(target.promotionBlockerClass || '').trim();
  if (cls === 'ready_for_master_review') return ['master_review_only'];
  if (cls === 'confidence') {
    return [
      'predictive_evidence_refresh',
      'weight_vector_shadow',
      'paper_trading_shadow',
      'paper_promotion_gate_shadow',
    ];
  }
  if (cls === 'paper_cycles' || cls === 'paper_buy_absent' || cls === 'shadow_observation') {
    return [
      'weight_vector_shadow',
      'paper_trading_shadow',
      'paper_promotion_gate_shadow',
    ];
  }
  if (cls === 'strategy_or_backtest_quality') {
    return [
      'candidate_backtest_refresh',
      'strategy_enhancement_shadow',
      'weight_vector_shadow',
      'paper_trading_shadow',
      'paper_promotion_gate_shadow',
    ];
  }
  if (cls === 'risk_quality') {
    return [
      'candidate_quality_governance_shadow',
      'paper_promotion_gate_shadow',
    ];
  }
  return [
    'weight_vector_shadow',
    'paper_trading_shadow',
    'paper_promotion_gate_shadow',
  ];
}

function normalizeAssistTarget(target = {}) {
  const symbol = String(target.symbol || '').trim().toUpperCase();
  const market = String(target.market || 'crypto').trim().toLowerCase();
  const actions = assistActionsForTarget(target);
  return {
    symbol,
    market,
    exchange: target.exchange || null,
    readinessScore: n(target.readinessScore, 0),
    promotionBlockerClass: target.promotionBlockerClass || 'unknown',
    cyclesRemaining: n(target.cyclesRemaining, 0),
    consecutivePassesRemaining: n(target.consecutivePassesRemaining, 0),
    confidenceGap: n(target.confidenceGap, 0),
    blockReasons: target.blockReasons || [],
    nextRequiredEvidence: target.nextRequiredEvidence || [],
    recommendedAssistActions: actions,
  };
}

function targetSourceItems(gateReport = {}) {
  const summaryTargets = gateReport.readinessSummary?.nextPaperCycleTargets
    || gateReport.summary?.nextPaperCycleTargets
    || [];
  if (summaryTargets.length > 0) return summaryTargets;
  return (gateReport.items || []).filter((item) => item.promotionCandidate !== true);
}

export function buildLunaPromotionReadinessAssistPlan(gateReport = {}, options = {}) {
  const maxTargets = Math.max(1, n(options.maxTargets || 8, 8));
  const selectedTargets = [];
  const seen = new Set();
  for (const rawTarget of targetSourceItems(gateReport)
    .map(normalizeAssistTarget)
    .filter((target) => target.symbol)
    .sort((a, b) => b.readinessScore - a.readinessScore || a.symbol.localeCompare(b.symbol))) {
    const key = `${rawTarget.symbol}|${rawTarget.market}`;
    if (seen.has(key)) continue;
    seen.add(key);
    selectedTargets.push(rawTarget);
    if (selectedTargets.length >= maxTargets) break;
  }

  const actions = new Set(selectedTargets.flatMap((target) => target.recommendedAssistActions));
  actions.delete('master_review_only');
  const backtestSymbols = unique(
    selectedTargets
      .filter((target) => target.recommendedAssistActions.includes('candidate_backtest_refresh'))
      .map((target) => target.symbol),
  );
  const mArg = marketArg(options.market || 'all');
  const limitArg = ` --limit=${Math.max(1, n(options.limit || 100, 100))}`;
  const hoursArg = ` --hours=${Math.max(1, n(options.hours || 168, 168))}`;
  const plannedCommands = [];
  if (actions.has('candidate_backtest_refresh')) {
    const symbolsArg = backtestSymbols.length ? ` --symbols=${backtestSymbols.join(',')}` : '';
    plannedCommands.push(`npm --prefix bots/investment run -s runtime:luna-candidate-backtest-refresh -- --json --force${mArg}${limitArg}${symbolsArg}`);
  }
  if (actions.has('predictive_evidence_refresh')) {
    plannedCommands.push(`npm --prefix bots/investment run -s runtime:luna-predictive-evidence-refresh -- --json${mArg}${limitArg}`);
  }
  if (actions.has('strategy_enhancement_shadow')) {
    plannedCommands.push(`npm --prefix bots/investment run -s runtime:luna-phase4-strategy-enhancement-shadow -- --json --apply --confirm=luna-phase4-strategy-enhancement-shadow${mArg}${limitArg}`);
  }
  if (actions.has('candidate_quality_governance_shadow')) {
    plannedCommands.push(`npm --prefix bots/investment run -s runtime:luna-candidate-quality-governance -- --json --apply --confirm=${QUALITY_GOVERNANCE_CONFIRM}${mArg}${limitArg}`);
  }
  if (actions.has('weight_vector_shadow')) {
    plannedCommands.push(`npm --prefix bots/investment run -s runtime:luna-weight-vector-shadow -- --json --apply --confirm=luna-weight-vector-shadow${mArg}${limitArg}`);
  }
  if (actions.has('paper_trading_shadow')) {
    plannedCommands.push(`npm --prefix bots/investment run -s runtime:luna-paper-trading-shadow -- --json --apply --confirm=luna-paper-trading-shadow${mArg}${limitArg}`);
  }
  if (actions.has('paper_promotion_gate_shadow')) {
    plannedCommands.push(`npm --prefix bots/investment run -s runtime:luna-paper-promotion-gate -- --json --apply --confirm=luna-paper-promotion-gate-shadow${mArg}${hoursArg} --limit=1000`);
  }

  return {
    ok: true,
    status: selectedTargets.length > 0
      ? 'luna_promotion_readiness_assist_planned'
      : 'luna_promotion_readiness_assist_no_targets',
    selectedTargets,
    actionSummary: {
      byBlockerClass: countBy(selectedTargets, (target) => target.promotionBlockerClass),
      byAction: countBy(selectedTargets.flatMap((target) => target.recommendedAssistActions), (action) => action),
      backtestSymbols,
      liveMutation: false,
    },
    plannedCommands,
    requiredApproval: 'explicit_master_live_promotion_approval_for_any_live_priority_change',
    liveMutation: false,
  };
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

export async function runLunaPromotionReadinessAssistShadow(options = {}, deps = {}) {
  const apply = options.apply === true;
  const dryRun = options.dryRun === true || !apply;
  const fixture = options.fixture === true;
  const json = options.json === true;
  const confirm = String(options.confirm || '');
  const market = String(options.market || 'all').trim().toLowerCase() || 'all';
  const hours = Math.max(1, n(options.hours || 168, 168));
  const limit = Math.max(1, n(options.limit || 100, 100));
  const maxTargets = Math.max(1, n(options.maxTargets || 8, 8));

  if (apply && options.dryRun === true) {
    throw new Error('runtime:luna-promotion-readiness-assist cannot combine --apply with --dry-run');
  }
  if (apply && confirm !== CONFIRM) {
    throw new Error(`runtime:luna-promotion-readiness-assist apply requires --confirm=${CONFIRM}`);
  }

  const gateReport = deps.runGate
    ? await deps.runGate({ json: true, fixture, dryRun: true, apply: false, market, hours, limit: 1000 })
    : await withSuppressedStdout(json, () => runLunaPaperPromotionGateShadow({
      json: true,
      fixture,
      dryRun: true,
      apply: false,
      market,
      hours,
      limit: 1000,
    }));
  const plan = buildLunaPromotionReadinessAssistPlan(gateReport, { market, hours, limit, maxTargets });

  const executed = {
    backtestRefresh: null,
    predictiveRefresh: null,
    strategyEnhancementShadow: null,
    candidateQualityGovernance: null,
    weightVectorShadow: null,
    paperTradingShadow: null,
    paperPromotionGate: null,
  };
  const actions = new Set(plan.selectedTargets.flatMap((target) => target.recommendedAssistActions));
  const backtestSymbols = plan.actionSummary.backtestSymbols || [];

  if (apply && !dryRun && plan.selectedTargets.length > 0) {
    if (actions.has('candidate_backtest_refresh')) {
      executed.backtestRefresh = deps.runBacktest
        ? await deps.runBacktest({ json: true, dryRun: false, force: true, market, limit, symbols: backtestSymbols.join(',') })
        : await withSuppressedStdout(json, () => runCandidateBacktestRefresh({
          json: true,
          dryRun: false,
          force: true,
          market,
          limit,
          symbols: backtestSymbols.join(','),
        }));
    }
    if (actions.has('predictive_evidence_refresh')) {
      executed.predictiveRefresh = deps.runPredictive
        ? await deps.runPredictive({ json: true, dryRun: false, market, limit })
        : await withSuppressedStdout(json, () => runLunaPredictiveEvidenceRefresh({ json: true, dryRun: false, market, limit }));
    }
    if (actions.has('strategy_enhancement_shadow')) {
      executed.strategyEnhancementShadow = deps.runStrategy
        ? await deps.runStrategy({ json: true, apply: true, dryRun: false, confirm: 'luna-phase4-strategy-enhancement-shadow', market, limit })
        : await withSuppressedStdout(json, () => runLunaPhase4StrategyEnhancementShadow({
          json: true,
          apply: true,
          dryRun: false,
          confirm: 'luna-phase4-strategy-enhancement-shadow',
          market,
          limit,
        }));
    }
    if (actions.has('candidate_quality_governance_shadow')) {
      executed.candidateQualityGovernance = deps.runGovernance
        ? await deps.runGovernance({ json: true, apply: true, dryRun: false, confirm: QUALITY_GOVERNANCE_CONFIRM, market, limit })
        : await withSuppressedStdout(json, () => runLunaCandidateQualityGovernanceShadow({
          json: true,
          apply: true,
          dryRun: false,
          confirm: QUALITY_GOVERNANCE_CONFIRM,
          market,
          limit,
        }));
    }
    if (actions.has('weight_vector_shadow')) {
      executed.weightVectorShadow = deps.runWeight
        ? await deps.runWeight({ json: true, apply: true, dryRun: false, confirm: 'luna-weight-vector-shadow', market, limit })
        : await withSuppressedStdout(json, () => runLunaWeightVectorShadow({
          json: true,
          apply: true,
          dryRun: false,
          confirm: 'luna-weight-vector-shadow',
          market,
          limit,
        }));
    }
    if (actions.has('paper_trading_shadow')) {
      executed.paperTradingShadow = deps.runPaperTrading
        ? await deps.runPaperTrading({ json: true, apply: true, dryRun: false, confirm: 'luna-paper-trading-shadow', market, limit })
        : await withSuppressedStdout(json, () => runLunaPaperTradingShadow({
          json: true,
          apply: true,
          dryRun: false,
          confirm: 'luna-paper-trading-shadow',
          market,
          limit,
        }));
    }
    if (actions.has('paper_promotion_gate_shadow')) {
      executed.paperPromotionGate = deps.runGate
        ? await deps.runGate({ json: true, fixture, apply: true, dryRun: false, confirm: 'luna-paper-promotion-gate-shadow', market, hours, limit: 1000 })
        : await withSuppressedStdout(json, () => runLunaPaperPromotionGateShadow({
          json: true,
          fixture,
          apply: true,
          dryRun: false,
          confirm: 'luna-paper-promotion-gate-shadow',
          market,
          hours,
          limit: 1000,
        }));
    }
  }

  const payload = {
    ...plan,
    status: apply ? 'luna_promotion_readiness_assist_shadow_written' : plan.status,
    phase: 'luna_promotion_readiness_shadow_assist',
    dryRun,
    apply,
    fixture,
    writeMode: apply ? 'shadow-apply' : 'plan-only',
    shadowMode: true,
    confirmToken: CONFIRM,
    market,
    hours,
    limit,
    maxTargets,
    gateSummary: gateReport.summary || null,
    readinessSummary: gateReport.readinessSummary || null,
    executed,
    liveMutation: false,
  };

  if (!json) {
    console.log(`[luna-promotion-readiness-assist] ${payload.status} targets=${payload.selectedTargets.length} actions=${payload.plannedCommands.length}`);
  }
  return payload;
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({
    run: async () => runLunaPromotionReadinessAssistShadow({
      json: hasFlag('json'),
      dryRun: hasFlag('dry-run'),
      apply: hasFlag('apply'),
      fixture: hasFlag('fixture'),
      market: argValue('market', 'all'),
      hours: Number(argValue('hours', 168)),
      limit: Number(argValue('limit', 100)),
      maxTargets: Number(argValue('max-targets', 8)),
      confirm: argValue('confirm', ''),
    }),
    onSuccess: async (result) => console.log(JSON.stringify(result, null, 2)),
    errorPrefix: 'runtime-luna-promotion-readiness-assist error:',
  });
}
