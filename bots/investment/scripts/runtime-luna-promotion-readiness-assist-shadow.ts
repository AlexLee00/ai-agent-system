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
import {
  LUNA_PROMOTION_ENTRY_TRIGGER_BRIDGE_CONFIRM,
} from '../shared/luna-promotion-entry-trigger-bridge.ts';
import { runLunaPromotionEntryTriggerBridge } from './runtime-luna-promotion-entry-trigger-bridge.ts';
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

function actionSymbolsForTargets(targets = [], action = '') {
  return unique(
    targets
      .filter((target) => target.recommendedAssistActions.includes(action))
      .map((target) => target.symbol),
  );
}

function symbolsOptionArg(symbols = []) {
  return symbols.length ? ` --symbols=${symbols.join(',')}` : '';
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

function promotionReadySourceItems(gateReport = {}) {
  return (gateReport.items || [])
    .filter((item) => item.promotionCandidate === true || item.promotion_candidate === true)
    .map((item) => ({
      symbol: String(item.symbol || '').trim().toUpperCase(),
      market: String(item.market || 'crypto').trim().toLowerCase(),
      exchange: item.exchange || null,
      readinessScore: n(item.readinessScore, 1),
      promotionBlockerClass: 'ready_for_master_review',
      cycleCount: n(item.cycleCount ?? item.cycle_count, 0),
      passCount: n(item.passCount ?? item.pass_count, 0),
      consecutivePasses: n(item.consecutivePasses ?? item.consecutive_passes, 0),
      avgConfidence: n(item.avgConfidence ?? item.avg_confidence, 0),
      recommendedAssistActions: [
        'promotion_entry_trigger_bridge_shadow',
        'promotion_entry_trigger_materialize_dry_run',
        'master_review_only',
      ],
      nextRequiredEvidence: item.nextRequiredEvidence || [{
        type: 'entry_trigger_bridge',
        action: 'stage_shadow_entry_trigger_bridge',
        detail: 'Promotion-ready shadow evidence exists; stage bridge evidence before any master-approved active trigger materialization.',
      }],
    }))
    .filter((item) => item.symbol);
}

export function buildLunaPromotionReadinessAssistPlan(gateReport = {}, options = {}) {
  const maxTargets = Math.max(1, n(options.maxTargets || 8, 8));
  const promotionReadyTargets = promotionReadySourceItems(gateReport);
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

  const actionTargets = [...promotionReadyTargets, ...selectedTargets];
  const actions = new Set(actionTargets.flatMap((target) => target.recommendedAssistActions));
  actions.delete('master_review_only');
  const promotionReadySymbols = actionSymbolsForTargets(promotionReadyTargets, 'promotion_entry_trigger_bridge_shadow');
  const backtestSymbols = actionSymbolsForTargets(selectedTargets, 'candidate_backtest_refresh');
  const predictiveSymbols = actionSymbolsForTargets(selectedTargets, 'predictive_evidence_refresh');
  const strategySymbols = actionSymbolsForTargets(selectedTargets, 'strategy_enhancement_shadow');
  const governanceSymbols = actionSymbolsForTargets(selectedTargets, 'candidate_quality_governance_shadow');
  const weightSymbols = actionSymbolsForTargets(selectedTargets, 'weight_vector_shadow');
  const paperTradingSymbols = actionSymbolsForTargets(selectedTargets, 'paper_trading_shadow');
  const promotionGateSymbols = actionSymbolsForTargets(selectedTargets, 'paper_promotion_gate_shadow');
  const mArg = marketArg(options.market || 'all');
  const limitArg = ` --limit=${Math.max(1, n(options.limit || 100, 100))}`;
  const hoursArg = ` --hours=${Math.max(1, n(options.hours || 168, 168))}`;
  const plannedCommands = [];
  if (actions.has('promotion_entry_trigger_bridge_shadow')) {
    plannedCommands.push(`npm --prefix bots/investment run -s runtime:luna-promotion-entry-trigger-bridge -- --json --apply --confirm=${LUNA_PROMOTION_ENTRY_TRIGGER_BRIDGE_CONFIRM}${mArg} --exchange=binance${hoursArg}${limitArg}${symbolsOptionArg(promotionReadySymbols)}`);
  }
  if (actions.has('promotion_entry_trigger_materialize_dry_run')) {
    plannedCommands.push(`npm --prefix bots/investment run -s runtime:luna-promotion-entry-trigger-materialize -- --json --dry-run${mArg} --exchange=binance${hoursArg}${limitArg}${symbolsOptionArg(promotionReadySymbols)}`);
  }
  if (actions.has('candidate_backtest_refresh')) {
    plannedCommands.push(`npm --prefix bots/investment run -s runtime:luna-candidate-backtest-refresh -- --json --force${mArg}${limitArg}${symbolsOptionArg(backtestSymbols)}`);
  }
  if (actions.has('predictive_evidence_refresh')) {
    plannedCommands.push(`npm --prefix bots/investment run -s runtime:luna-predictive-evidence-refresh -- --json${mArg}${limitArg}${symbolsOptionArg(predictiveSymbols)}`);
  }
  if (actions.has('strategy_enhancement_shadow')) {
    plannedCommands.push(`npm --prefix bots/investment run -s runtime:luna-phase4-strategy-enhancement-shadow -- --json --apply --confirm=luna-phase4-strategy-enhancement-shadow${mArg}${limitArg}${symbolsOptionArg(strategySymbols)}`);
  }
  if (actions.has('candidate_quality_governance_shadow')) {
    plannedCommands.push(`npm --prefix bots/investment run -s runtime:luna-candidate-quality-governance -- --json --apply --confirm=${QUALITY_GOVERNANCE_CONFIRM}${mArg}${limitArg}${symbolsOptionArg(governanceSymbols)}`);
  }
  if (actions.has('weight_vector_shadow')) {
    plannedCommands.push(`npm --prefix bots/investment run -s runtime:luna-weight-vector-shadow -- --json --apply --confirm=luna-weight-vector-shadow${mArg}${limitArg}${symbolsOptionArg(weightSymbols)}`);
  }
  if (actions.has('paper_trading_shadow')) {
    plannedCommands.push(`npm --prefix bots/investment run -s runtime:luna-paper-trading-shadow -- --json --apply --confirm=luna-paper-trading-shadow${mArg}${limitArg}${symbolsOptionArg(paperTradingSymbols)}`);
  }
  if (actions.has('paper_promotion_gate_shadow')) {
    plannedCommands.push(`npm --prefix bots/investment run -s runtime:luna-paper-promotion-gate -- --json --apply --confirm=luna-paper-promotion-gate-shadow${mArg}${hoursArg} --limit=1000${symbolsOptionArg(promotionGateSymbols)}`);
  }

  return {
    ok: true,
    status: promotionReadyTargets.length > 0 || selectedTargets.length > 0
      ? 'luna_promotion_readiness_assist_planned'
      : 'luna_promotion_readiness_assist_no_targets',
    promotionReadyTargets,
    selectedTargets,
    actionSummary: {
      byBlockerClass: countBy(actionTargets, (target) => target.promotionBlockerClass),
      byAction: countBy(actionTargets.flatMap((target) => target.recommendedAssistActions), (action) => action),
      promotionReadySymbols,
      backtestSymbols,
      predictiveSymbols,
      strategySymbols,
      governanceSymbols,
      weightSymbols,
      paperTradingSymbols,
      promotionGateSymbols,
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
    promotionEntryTriggerBridge: null,
    backtestRefresh: null,
    predictiveRefresh: null,
    strategyEnhancementShadow: null,
    candidateQualityGovernance: null,
    weightVectorShadow: null,
    paperTradingShadow: null,
    paperPromotionGate: null,
  };
  const actions = new Set(plan.selectedTargets.flatMap((target) => target.recommendedAssistActions));
  for (const target of plan.promotionReadyTargets || []) {
    for (const action of target.recommendedAssistActions || []) actions.add(action);
  }
  const promotionReadySymbols = plan.actionSummary.promotionReadySymbols || [];
  const backtestSymbols = plan.actionSummary.backtestSymbols || [];
  const predictiveSymbols = plan.actionSummary.predictiveSymbols || [];
  const strategySymbols = plan.actionSummary.strategySymbols || [];
  const governanceSymbols = plan.actionSummary.governanceSymbols || [];
  const weightSymbols = plan.actionSummary.weightSymbols || [];
  const paperTradingSymbols = plan.actionSummary.paperTradingSymbols || [];
  const promotionGateSymbols = plan.actionSummary.promotionGateSymbols || [];

  if (apply && !dryRun && (plan.selectedTargets.length > 0 || (plan.promotionReadyTargets || []).length > 0)) {
    if (actions.has('promotion_entry_trigger_bridge_shadow')) {
      executed.promotionEntryTriggerBridge = deps.runPromotionBridge
        ? await deps.runPromotionBridge({ json: true, apply: true, dryRun: false, confirm: LUNA_PROMOTION_ENTRY_TRIGGER_BRIDGE_CONFIRM, market, exchange: 'binance', hours, limit, symbols: promotionReadySymbols.join(',') })
        : await withSuppressedStdout(json, () => runLunaPromotionEntryTriggerBridge({
          json: true,
          apply: true,
          dryRun: false,
          confirm: LUNA_PROMOTION_ENTRY_TRIGGER_BRIDGE_CONFIRM,
          market,
          exchange: 'binance',
          hours,
          limit,
          symbols: promotionReadySymbols.join(','),
        }));
    }
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
        ? await deps.runPredictive({ json: true, dryRun: false, market, limit, symbols: predictiveSymbols.join(',') })
        : await withSuppressedStdout(json, () => runLunaPredictiveEvidenceRefresh({
          json: true,
          dryRun: false,
          market,
          limit,
          symbols: predictiveSymbols.join(','),
        }));
    }
    if (actions.has('strategy_enhancement_shadow')) {
      executed.strategyEnhancementShadow = deps.runStrategy
        ? await deps.runStrategy({ json: true, apply: true, dryRun: false, confirm: 'luna-phase4-strategy-enhancement-shadow', market, limit, symbols: strategySymbols.join(',') })
        : await withSuppressedStdout(json, () => runLunaPhase4StrategyEnhancementShadow({
          json: true,
          apply: true,
          dryRun: false,
          confirm: 'luna-phase4-strategy-enhancement-shadow',
          market,
          limit,
          symbols: strategySymbols.join(','),
        }));
    }
    if (actions.has('candidate_quality_governance_shadow')) {
      executed.candidateQualityGovernance = deps.runGovernance
        ? await deps.runGovernance({ json: true, apply: true, dryRun: false, confirm: QUALITY_GOVERNANCE_CONFIRM, market, limit, symbols: governanceSymbols.join(',') })
        : await withSuppressedStdout(json, () => runLunaCandidateQualityGovernanceShadow({
          json: true,
          apply: true,
          dryRun: false,
          confirm: QUALITY_GOVERNANCE_CONFIRM,
          market,
          limit,
          symbols: governanceSymbols.join(','),
        }));
    }
    if (actions.has('weight_vector_shadow')) {
      executed.weightVectorShadow = deps.runWeight
        ? await deps.runWeight({ json: true, apply: true, dryRun: false, confirm: 'luna-weight-vector-shadow', market, limit, symbols: weightSymbols.join(',') })
        : await withSuppressedStdout(json, () => runLunaWeightVectorShadow({
          json: true,
          apply: true,
          dryRun: false,
          confirm: 'luna-weight-vector-shadow',
          market,
          limit,
          symbols: weightSymbols.join(','),
        }));
    }
    if (actions.has('paper_trading_shadow')) {
      executed.paperTradingShadow = deps.runPaperTrading
        ? await deps.runPaperTrading({ json: true, apply: true, dryRun: false, confirm: 'luna-paper-trading-shadow', market, limit, symbols: paperTradingSymbols.join(',') })
        : await withSuppressedStdout(json, () => runLunaPaperTradingShadow({
          json: true,
          apply: true,
          dryRun: false,
          confirm: 'luna-paper-trading-shadow',
          market,
          limit,
          symbols: paperTradingSymbols.join(','),
        }));
    }
    if (actions.has('paper_promotion_gate_shadow')) {
      executed.paperPromotionGate = deps.runGate
        ? await deps.runGate({ json: true, fixture, apply: true, dryRun: false, confirm: 'luna-paper-promotion-gate-shadow', market, hours, limit: 1000, symbols: promotionGateSymbols.join(',') })
        : await withSuppressedStdout(json, () => runLunaPaperPromotionGateShadow({
          json: true,
          fixture,
          apply: true,
          dryRun: false,
          confirm: 'luna-paper-promotion-gate-shadow',
          market,
          hours,
          limit: 1000,
          symbols: promotionGateSymbols.join(','),
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
