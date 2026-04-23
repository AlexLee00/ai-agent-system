#!/usr/bin/env node
// @ts-nocheck

import * as db from '../shared/db.ts';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';
import { reevaluateOpenPositions } from '../shared/position-reevaluator.ts';
import { executeSignal as executeCryptoSignal } from '../team/hephaestos.ts';

function parseArgs(argv = process.argv.slice(2)) {
  const values = {};
  for (const arg of argv) {
    if (!arg.startsWith('--')) continue;
    const [rawKey, ...rest] = arg.slice(2).split('=');
    values[rawKey] = rest.length > 0 ? rest.join('=') : true;
  }

  return {
    json: Boolean(values.json),
    execute: Boolean(values.execute),
    symbol: values.symbol ? String(values.symbol).toUpperCase() : null,
    tradeMode: values['trade-mode'] ? String(values['trade-mode']) : null,
    confirm: values.confirm ? String(values.confirm) : null,
    ratio: values.ratio != null ? Number(values.ratio) : null,
    minutesBack: values.minutes ? Math.max(10, Number(values.minutes)) : 180,
  };
}

function getDefaultPartialExitRatio(reasonCode) {
  switch (String(reasonCode || '')) {
    case 'profit_lock_candidate':
      return 0.5;
    case 'tv_trend_weakening':
    case 'tv_1d_bearish_reversal':
      return 0.4;
    case 'tv_4h_momentum_cooling':
    case 'tv_1d_momentum_cooling':
    case 'weak_support':
      return 0.25;
    default:
      return 0.33;
  }
}

function normalizeSetupType(value) {
  const normalized = String(value || '').trim().toLowerCase();
  return normalized || null;
}

function getExitPlanRatio(exitPlan = null, reasonCode = null) {
  const ratios = exitPlan?.partialExitRatios;
  if (!ratios || typeof ratios !== 'object') return null;
  const value = ratios?.[reasonCode];
  return normalizeRatio(value);
}

function getResponsibilityPlan(strategyProfile = null) {
  const plan =
    strategyProfile?.strategy_context?.responsibilityPlan
    || strategyProfile?.strategyContext?.responsibilityPlan
    || strategyProfile?.responsibilityPlan;
  return plan && typeof plan === 'object' ? plan : {};
}

function tuneRatioByResponsibilityPlan(ratio, reasonCode, responsibilityPlan = {}) {
  let adjusted = Number(ratio);
  if (!Number.isFinite(adjusted) || adjusted <= 0) return ratio;

  const executionMission = String(responsibilityPlan?.executionMission || '').trim().toLowerCase();
  const riskMission = String(responsibilityPlan?.riskMission || '').trim().toLowerCase();
  const watchMission = String(responsibilityPlan?.watchMission || '').trim().toLowerCase();

  if (executionMission === 'partial_adjust_executor') adjusted += 0.05;
  if (executionMission === 'precision_execution') adjusted -= 0.03;

  if (riskMission === 'strict_risk_gate') adjusted += 0.05;
  if (riskMission === 'soft_sizing_preference') adjusted += 0.02;

  if (watchMission === 'backtest_drift_watcher' && String(reasonCode || '').startsWith('backtest_drift')) {
    adjusted += 0.05;
  }
  if (watchMission === 'risk_sentinel' && String(reasonCode || '').includes('trend')) {
    adjusted += 0.03;
  }

  return normalizeRatio(adjusted) ?? ratio;
}

function getStrategyAwarePartialExitRatio(reasonCode, strategyProfile = null) {
  const exitPlanRatio = getExitPlanRatio(strategyProfile?.exit_plan || strategyProfile?.exitPlan, reasonCode);
  const responsibilityPlan = getResponsibilityPlan(strategyProfile);
  if (exitPlanRatio != null) return tuneRatioByResponsibilityPlan(exitPlanRatio, reasonCode, responsibilityPlan);
  const base = getDefaultPartialExitRatio(reasonCode);
  const setupType = normalizeSetupType(strategyProfile?.setup_type);
  let ratio = base;

  switch (setupType) {
    case 'mean_reversion':
      if (reasonCode === 'profit_lock_candidate') ratio = 0.65;
      else if (reasonCode === 'mean_reversion_profit_take') ratio = 0.6;
      else ratio = Math.max(base, 0.5);
      break;
    case 'breakout':
      if (reasonCode === 'profit_lock_candidate') ratio = 0.4;
      else ratio = Math.min(base, 0.35);
      break;
    case 'trend_following':
    case 'momentum_rotation':
      if (reasonCode === 'trend_following_trail') ratio = 0.25;
      else if (reasonCode === 'profit_lock_candidate') ratio = 0.33;
      else ratio = Math.min(base, 0.3);
      break;
    default:
      ratio = base;
      break;
  }

  return tuneRatioByResponsibilityPlan(ratio, reasonCode, responsibilityPlan);
}

function normalizeRatio(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  if (parsed >= 1) return 1;
  return Number(parsed.toFixed(4));
}

function mapCandidate(row, strategyProfile = null, overrideRatio = null) {
  const ratio = normalizeRatio(overrideRatio) ?? getStrategyAwarePartialExitRatio(row.reasonCode, strategyProfile);
  const positionAmount = Number(row?.positionSnapshot?.amount || 0);
  const avgPrice = Number(row?.positionSnapshot?.avgPrice || 0);
  const estimatedNotional = positionAmount * avgPrice;
  const estimatedExitAmount = positionAmount * ratio;
  return {
    exchange: row.exchange,
    symbol: row.symbol,
    tradeMode: row.tradeMode || 'normal',
    pnlPct: Number(row.pnlPct || 0),
    reasonCode: row.reasonCode || null,
    reason: row.reason || null,
    partialExitRatio: ratio,
    positionAmount,
    avgPrice,
    estimatedNotional,
    estimatedExitAmount,
    strategyProfile: strategyProfile ? {
      strategyName: strategyProfile.strategy_name || null,
      setupType: strategyProfile.setup_type || null,
      exitPlan: strategyProfile.exit_plan || strategyProfile.exitPlan || null,
      strategyState: strategyProfile.strategy_state || {},
      responsibilityPlan: strategyProfile.strategy_context?.responsibilityPlan || {},
    } : null,
  };
}

async function syncPartialAdjustCandidateStates(candidates = [], phase = 'preview') {
  for (const candidate of candidates) {
    if (!candidate?.symbol || !candidate?.exchange || !candidate?.strategyProfile) continue;
    const lifecycleStatus = phase === 'execute' ? 'adjust_executing' : 'adjust_preview';
    const attentionAt = new Date().toISOString();
    await db.updatePositionStrategyProfileState(candidate.symbol, {
      exchange: candidate.exchange,
      tradeMode: candidate.tradeMode,
      strategyState: {
        lifecycleStatus,
        latestRecommendation: 'ADJUST',
        latestReasonCode: candidate.reasonCode || null,
        latestReason: candidate.reason || null,
        latestPartialExitRatio: candidate.partialExitRatio,
        latestExecutionMission: candidate?.strategyProfile?.responsibilityPlan?.executionMission || null,
        latestRiskMission: candidate?.strategyProfile?.responsibilityPlan?.riskMission || null,
        latestWatchMission: candidate?.strategyProfile?.responsibilityPlan?.watchMission || null,
        updatedBy: phase === 'execute' ? 'partial_adjust_runner_execute' : 'partial_adjust_runner_preview',
        updatedAt: attentionAt,
      },
      lastEvaluationAt: attentionAt,
      lastAttentionAt: attentionAt,
    }).catch(() => null);
  }
}

function pickCandidate(candidates, symbol, tradeMode = null) {
  if (!symbol) return null;
  return candidates.find((candidate) => (
    candidate.symbol === symbol
      && (!tradeMode || candidate.tradeMode === tradeMode)
  )) || null;
}

function renderPreview(candidates) {
  const lines = [
    '🪶 partial-adjust 승인형 실행 preview',
    '',
    `- 후보 수: ${candidates.length}건`,
  ];

  for (const candidate of candidates) {
    lines.push(
      `- ${candidate.symbol} | ${candidate.tradeMode} | pnl=${candidate.pnlPct.toFixed(2)}% | ratio=${candidate.partialExitRatio} | reason=${candidate.reasonCode}`,
    );
  }

  lines.push('');
  lines.push('- 실제 실행은 `--symbol`, `--execute`, `--confirm=partial-adjust`가 모두 필요합니다.');
  return lines.join('\n');
}

async function loadCandidates({ tradeMode = null, minutesBack = 180, ratio = null } = {}) {
  const report = await reevaluateOpenPositions({
    exchange: 'binance',
    paper: false,
    tradeMode,
    minutesBack,
    persist: false,
  });

  const rows = (report.rows || [])
    .filter((row) => row.exchange === 'binance' && row.recommendation === 'ADJUST');

  const mapped = await Promise.all(rows.map(async (row) => {
    const strategyProfile = await db.getPositionStrategyProfile(row.symbol, {
      exchange: row.exchange,
      tradeMode: row.tradeMode || 'normal',
    }).catch(() => null);
    return mapCandidate(row, strategyProfile, ratio);
  }));

  return mapped.filter((row) => row.partialExitRatio > 0 && row.positionAmount > 0);
}

async function createPartialAdjustSignal(candidate) {
  const signalId = await db.insertSignal({
    symbol: candidate.symbol,
    action: 'SELL',
    amountUsdt: candidate.estimatedNotional,
    confidence: 1,
    reasoning: `승인형 partial-adjust 실행 (${candidate.reasonCode})`,
    exchange: 'binance',
    tradeMode: candidate.tradeMode,
    nemesisVerdict: 'approved',
    approvedAt: new Date().toISOString(),
    partialExitRatio: candidate.partialExitRatio,
    executionOrigin: 'strategy',
    qualityFlag: 'trusted',
    excludeFromLearning: false,
    incidentLink: `partial_adjust:${candidate.reasonCode}`,
  });

  const signal = await db.getSignalById(signalId);
  return {
    ...signal,
    exchange: 'binance',
    trade_mode: candidate.tradeMode,
    exit_reason_override: `partial_adjust:${candidate.reasonCode}`,
    partial_exit_ratio: candidate.partialExitRatio,
  };
}

async function main() {
  const args = parseArgs();
  const candidates = await loadCandidates({
    tradeMode: args.tradeMode,
    minutesBack: args.minutesBack,
    ratio: args.ratio,
  });

  if (!args.symbol) {
    await syncPartialAdjustCandidateStates(candidates, 'preview');
    const payload = {
      mode: 'preview',
      totalCandidates: candidates.length,
      candidates,
      usage: [
        'node bots/investment/scripts/partial-adjust-runner.ts --symbol=RUNE/USDT',
        'env PAPER_MODE=false node bots/investment/scripts/partial-adjust-runner.ts --symbol=RUNE/USDT --execute --confirm=partial-adjust',
      ],
    };
    if (args.json) {
      console.log(JSON.stringify(payload, null, 2));
      return;
    }
    console.log(renderPreview(candidates));
    return;
  }

  const candidate = pickCandidate(candidates, args.symbol, args.tradeMode);
  if (!candidate) {
    throw new Error(`partial-adjust 후보를 찾지 못했습니다: symbol=${args.symbol}${args.tradeMode ? ` tradeMode=${args.tradeMode}` : ''}`);
  }

  if (!args.execute) {
    await syncPartialAdjustCandidateStates([candidate], 'preview');
    const payload = {
      mode: 'preview',
      candidate,
      executeCommand: `env PAPER_MODE=false node bots/investment/scripts/partial-adjust-runner.ts --symbol=${candidate.symbol} --trade-mode=${candidate.tradeMode} --execute --confirm=partial-adjust`,
    };
    if (args.json) {
      console.log(JSON.stringify(payload, null, 2));
      return;
    }
    console.log(renderPreview([candidate]));
    console.log('');
    console.log(`- 실행 명령: ${payload.executeCommand}`);
    return;
  }

  if (args.confirm !== 'partial-adjust') {
    throw new Error('실행하려면 --confirm=partial-adjust 가 필요합니다.');
  }

  await syncPartialAdjustCandidateStates([candidate], 'execute');
  const signal = await createPartialAdjustSignal(candidate);
  const result = await executeCryptoSignal(signal);
  const payload = {
    mode: 'execute',
    candidate,
    signalId: signal.id,
    result,
  };

  if (args.json) {
    console.log(JSON.stringify(payload, null, 2));
    return;
  }

  console.log('✅ partial-adjust 승인형 실행 완료');
  console.log(JSON.stringify(payload, null, 2));
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({
    before: () => db.initSchema(),
    run: () => main(),
    onError: async (error) => {
      console.error(`[partial-adjust-runner] ${error?.stack || error?.message || String(error)}`);
    },
  });
}
