#!/usr/bin/env node
// @ts-nocheck

import * as db from '../shared/db.ts';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';
import { reevaluateOpenPositions } from '../shared/position-reevaluator.ts';
import { executeSignal as executeCryptoSignal } from '../team/hephaestos.ts';
import { executeSignal as executeDomesticSignal, executeOverseasSignal } from '../team/hanul.ts';
import {
  getKisExecutionModeInfo,
  getKisMarketStatus,
  getKisOverseasMarketStatus,
} from '../shared/secrets.ts';
import { publishToMainBot } from '../shared/mainbot-client.ts';
import { beginCloseout, finalizeCloseout } from '../shared/position-closeout-engine.ts';
import { recordLifecyclePhaseSnapshot } from '../shared/lifecycle-contract.ts';

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
    exchange: values.exchange ? String(values.exchange) : null,
    tradeMode: values['trade-mode'] ? String(values['trade-mode']) : null,
    confirm: values.confirm ? String(values.confirm) : null,
    runContext: values['run-context'] ? String(values['run-context']) : null,
    minutesBack: values.minutes ? Math.max(10, Number(values.minutes)) : 180,
  };
}

function isAutonomousExecutionContext(options = {}) {
  const confirm = String(options?.confirm || '').trim();
  const runContext = String(options?.runContext || '').trim();
  return confirm === 'position-runtime-autopilot'
    || runContext === 'position-runtime-autopilot'
    || runContext === 'phase6-autopilot';
}

function getMarketLabel(exchange) {
  switch (exchange) {
    case 'binance': return '암호화폐';
    case 'kis': return '국내장';
    case 'kis_overseas': return '국외장';
    default: return exchange || 'unknown';
  }
}

function safeNumber(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function formatHours(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 'n/a';
  return n.toFixed(1);
}

function formatPct(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 'n/a';
  return n.toFixed(2);
}

function heldHoursFromEntry(entryTime) {
  if (!entryTime) return 0;
  const ts = new Date(entryTime).getTime();
  if (!Number.isFinite(ts) || ts <= 0) return 0;
  return Math.max(0, (Date.now() - ts) / 3600000);
}

function isHardExitReason(reasonCode) {
  return new Set([
    'stop_loss_threshold',
    'backtest_drift_exit',
    'mtf_bearish_consensus_exit',
    'tv_4h_bearish_reversal',
    'breakout_failed',
  ]).has(String(reasonCode || ''));
}

function normalizeExitPlan(exitPlan = null) {
  return exitPlan && typeof exitPlan === 'object' ? exitPlan : {};
}

function normalizeResponsibilityPlan(plan = null) {
  return plan && typeof plan === 'object' ? plan : {};
}

function normalizeExecutionPlan(plan = null) {
  return plan && typeof plan === 'object' ? plan : {};
}

function normalizeFamilyPerformanceFeedback(feedback = null) {
  return feedback && typeof feedback === 'object' ? feedback : {};
}

function buildFamilyFeedbackIncidentSuffix(strategyProfile = null) {
  const feedback = normalizeFamilyPerformanceFeedback(strategyProfile?.familyPerformanceFeedback);
  const bias = String(feedback?.bias || '').trim();
  if (!bias || bias === 'unknown') return '';
  const family = String(feedback?.family || strategyProfile?.setupType || 'unknown').trim();
  const winRate = feedback?.winRatePct != null ? `:winRate=${feedback.winRatePct}` : '';
  const avgPnl = feedback?.avgPnlPercent != null ? `:avgPnl=${feedback.avgPnlPercent}` : '';
  return `:family_bias=${bias}:family=${family}${winRate}${avgPnl}`;
}

function buildExitReason(candidate) {
  const exitPlan = normalizeExitPlan(candidate?.strategyProfile?.exitPlan);
  const primary = String(exitPlan.primaryExit || '').trim();
  if (primary) return `strategy_exit:${primary}`;
  return `strategy_exit:${candidate.reasonCode || 'reeval_exit'}`;
}

export function applyExitPlanGuard(candidate) {
  const exitPlan = normalizeExitPlan(candidate?.strategyProfile?.exitPlan);
  const responsibilityPlan = normalizeResponsibilityPlan(candidate?.strategyProfile?.responsibilityPlan);
  const executionPlan = normalizeExecutionPlan(candidate?.strategyProfile?.executionPlan);
  const familyFeedback = normalizeFamilyPerformanceFeedback(candidate?.strategyProfile?.familyPerformanceFeedback);
  if (!exitPlan || Object.keys(exitPlan).length === 0) {
    return { allowed: true, level: 'fallback', reason: null };
  }

  let minHoldHours = safeNumber(exitPlan.minHoldHours, 0);
  let mildLossGracePct = safeNumber(exitPlan.mildLossGracePct, null);
  const hardReason = isHardExitReason(candidate.reasonCode);
  const riskMission = String(responsibilityPlan?.riskMission || '').trim().toLowerCase();
  const watchMission = String(responsibilityPlan?.watchMission || '').trim().toLowerCase();
  const exitUrgency = String(executionPlan?.exitUrgency || '').trim().toLowerCase();
  const familyBias = String(familyFeedback?.bias || '').trim();

  if (!hardReason) {
    if (exitUrgency === 'high') {
      minHoldHours *= 0.65;
      if (Number.isFinite(mildLossGracePct)) mildLossGracePct *= 0.65;
    } else if (exitUrgency === 'watchful') {
      minHoldHours *= 0.85;
      if (Number.isFinite(mildLossGracePct)) mildLossGracePct *= 0.85;
    }

    if (familyBias === 'downweight_by_pnl') {
      minHoldHours *= 0.75;
      if (Number.isFinite(mildLossGracePct)) mildLossGracePct *= 0.7;
    } else if (familyBias === 'downweight_by_win_rate') {
      minHoldHours *= 0.88;
      if (Number.isFinite(mildLossGracePct)) mildLossGracePct *= 0.85;
    } else if (familyBias === 'upweight_candidate') {
      minHoldHours *= 1.1;
      if (Number.isFinite(mildLossGracePct)) mildLossGracePct *= 1.1;
    }

    if (riskMission === 'strict_risk_gate') {
      minHoldHours *= 0.75;
      if (Number.isFinite(mildLossGracePct)) mildLossGracePct *= 0.7;
    } else if (riskMission === 'execution_safeguard') {
      minHoldHours *= 1.2;
      if (Number.isFinite(mildLossGracePct)) mildLossGracePct *= 1.15;
    }

    if (watchMission === 'backtest_drift_watcher' && String(candidate.reasonCode || '').startsWith('backtest_drift')) {
      minHoldHours *= 0.5;
    }
    if (watchMission === 'risk_sentinel' && String(candidate.reasonCode || '').includes('bearish')) {
      minHoldHours *= 0.8;
    }
  }

  if (!hardReason && minHoldHours > 0 && candidate.heldHours < minHoldHours) {
    return {
      allowed: false,
      level: 'guarded',
      reason: `전략 최소 보유시간 ${formatHours(minHoldHours)}h 미만 (${formatHours(candidate.heldHours)}h)`,
    };
  }

  if (
    !hardReason
    && Number.isFinite(mildLossGracePct)
    && candidate.pnlPct < 0
    && candidate.pnlPct > mildLossGracePct
  ) {
    return {
      allowed: false,
      level: 'guarded',
      reason: `전략 손실 유예 ${formatPct(mildLossGracePct)}% 범위 내 (${formatPct(candidate.pnlPct)}%)`,
    };
  }

  return { allowed: true, level: 'ready', reason: null };
}

function mapCandidate(row, strategyProfile = null) {
  const heldHours = heldHoursFromEntry(row?.positionSnapshot?.entryTime);
  const strategyProfileSnapshot = strategyProfile ? {
    id: strategyProfile.id || null,
    strategyName: strategyProfile.strategy_name || null,
    setupType: strategyProfile.setup_type || null,
    exitPlan: strategyProfile.exit_plan || {},
    strategyState: strategyProfile.strategy_state || {},
    executionPlan: strategyProfile.strategy_context?.executionPlan || {},
    familyPerformanceFeedback: strategyProfile.strategy_context?.familyPerformanceFeedback || {},
    responsibilityPlan: strategyProfile.strategy_context?.responsibilityPlan || {},
    positionRuntimeState: strategyProfile.strategy_state?.positionRuntimeState || null,
  } : null;
  const candidate = {
    exchange: row.exchange,
    symbol: row.symbol,
    tradeMode: row.tradeMode || 'normal',
    pnlPct: safeNumber(row.pnlPct),
    reasonCode: row.reasonCode || null,
    reason: row.reason || null,
    positionAmount: safeNumber(row?.positionSnapshot?.amount),
    positionValue: safeNumber(row?.positionSnapshot?.amount) * safeNumber(row?.positionSnapshot?.avgPrice),
    heldHours,
    executionIntent: row.executionIntent
      || strategyProfileSnapshot?.positionRuntimeState?.executionIntent
      || null,
    strategyProfile: strategyProfileSnapshot,
  };
  const guard = applyExitPlanGuard(candidate);
  if (candidate.strategyProfile) {
    candidate.strategyProfile.strategyState = {
      ...(candidate.strategyProfile.strategyState || {}),
      latestExitGuardReason: guard.reason || null,
      latestFamilyPerformanceBias: candidate.strategyProfile.familyPerformanceFeedback?.bias || null,
    };
  }
  return {
    ...candidate,
    exitReasonOverride: buildExitReason(candidate),
    signalIncidentLink: `${buildExitReason(candidate)}${buildFamilyFeedbackIncidentSuffix(candidate.strategyProfile)}`,
    executionGuard: guard,
  };
}

async function syncStrategyExitCandidateStates(candidates = [], phase = 'preview') {
  for (const candidate of candidates) {
    if (!candidate?.symbol || !candidate?.exchange || !candidate?.strategyProfile) continue;
    const timestamp = new Date().toISOString();
    const lifecycleStatus =
      phase === 'execute'
        ? 'exit_executing'
        : candidate?.executionGuard?.allowed
          ? 'exit_ready'
          : 'exit_guarded';
    await db.updatePositionStrategyProfileState(candidate.symbol, {
      exchange: candidate.exchange,
      tradeMode: candidate.tradeMode,
      strategyState: {
        lifecycleStatus,
        latestRecommendation: 'EXIT',
        latestReasonCode: candidate.reasonCode || null,
        latestReason: candidate.reason || null,
        latestExitGuardReason: candidate?.executionGuard?.reason || null,
        latestExecutionPlan: candidate?.strategyProfile?.executionPlan || null,
        latestFamilyPerformanceBias: candidate?.strategyProfile?.familyPerformanceFeedback?.bias || null,
        latestExecutionMission: candidate?.strategyProfile?.responsibilityPlan?.executionMission || null,
        latestRiskMission: candidate?.strategyProfile?.responsibilityPlan?.riskMission || null,
        latestWatchMission: candidate?.strategyProfile?.responsibilityPlan?.watchMission || null,
        latestExecutionIntent: candidate?.executionIntent || null,
        updatedBy: phase === 'execute' ? 'strategy_exit_runner_execute' : 'strategy_exit_runner_preview',
        updatedAt: timestamp,
      },
      lastEvaluationAt: timestamp,
      lastAttentionAt: timestamp,
    }).catch(() => null);
  }
}

async function loadCandidates({ exchange = null, tradeMode = null, minutesBack = 180 } = {}) {
  const report = await reevaluateOpenPositions({
    exchange,
    paper: false,
    tradeMode,
    minutesBack,
    persist: false,
  });

  const rows = (report.rows || [])
    .filter((row) => row.recommendation === 'EXIT' && row.ignored !== true);

  const mapped = await Promise.all(rows.map(async (row) => {
    const strategyProfile = await db.getPositionStrategyProfile(row.symbol, {
      exchange: row.exchange,
      tradeMode: row.tradeMode || 'normal',
    }).catch(() => null);
    return mapCandidate(row, strategyProfile);
  }));

  return mapped;
}

export async function buildStrategyExitSummary({
  exchange = null,
  tradeMode = null,
  minutesBack = 180,
} = {}) {
  const candidates = await loadCandidates({ exchange, tradeMode, minutesBack });
  await syncStrategyExitCandidateStates(candidates, 'preview');
  const ready = candidates.filter((candidate) => candidate.executionGuard?.allowed);
  const guarded = candidates.filter((candidate) => candidate.executionGuard?.allowed === false);
  let status = 'strategy_exit_idle';
  let headline = '현재 전략 청산 preview 후보가 없습니다.';

  if (candidates.length > 0) {
    status = ready.length > 0 ? 'strategy_exit_ready' : 'strategy_exit_guarded';
    headline = ready.length > 0
      ? `전략 청산 preview ${ready.length}건이 실행 가능 상태입니다.`
      : `전략 청산 preview ${guarded.length}건이 전략 가드로 보류 중입니다.`;
  }

  const reasons = [];
  if (ready.length > 0) {
    const topReady = ready
      .slice()
      .sort((a, b) => Math.abs(Number(b.pnlPct || 0)) - Math.abs(Number(a.pnlPct || 0)))
      .slice(0, 3)
      .map((candidate) => `${candidate.symbol} ${candidate.reasonCode || 'strategy_exit'} (${candidate.strategyProfile?.setupType || 'no_strategy'})`);
    if (topReady.length > 0) reasons.push(`실행 가능: ${topReady.join(', ')}`);
  }
  if (guarded.length > 0) {
    const topGuarded = guarded
      .slice(0, 2)
      .map((candidate) => `${candidate.symbol} ${candidate.executionGuard?.reason || 'guarded'}`);
    if (topGuarded.length > 0) reasons.push(`보류: ${topGuarded.join(' | ')}`);
  }

  return {
    status,
    headline,
    reasons,
    metrics: {
      totalCandidates: candidates.length,
      ready: ready.length,
      guarded: guarded.length,
    },
    candidates,
  };
}

function pickCandidate(candidates, { symbol, exchange = null, tradeMode = null }) {
  if (!symbol) return null;
  return candidates.find((candidate) =>
    candidate.symbol === symbol
    && (!exchange || candidate.exchange === exchange)
    && (!tradeMode || candidate.tradeMode === tradeMode)
  ) || null;
}

export async function getExecutionPreflight(candidate) {
  if (!candidate) {
    return {
      ok: false,
      code: 'strategy_exit_candidate_not_found',
      lines: ['- strategy-exit 후보가 없습니다.'],
    };
  }
  if (!candidate.executionGuard?.allowed) {
    return {
      ok: false,
      code: 'strategy_exit_guard_blocked',
      lines: [`- strategy exit guard: ${candidate.executionGuard.reason}`],
    };
  }
  if (candidate.exchange === 'binance') {
    return {
      ok: true,
      code: 'strategy_exit_runner_preflight_clear',
      lines: ['- 암호화폐 전략 청산은 현재 실행 가능'],
    };
  }

  const modeInfo = getKisExecutionModeInfo(candidate.exchange === 'kis' ? '국내주식' : '해외주식');
  const marketStatus = candidate.exchange === 'kis'
    ? await getKisMarketStatus()
    : getKisOverseasMarketStatus();

  const lines = [
    `- accountMode: ${modeInfo.brokerAccountMode}`,
    `- executionMode: ${modeInfo.executionMode}`,
    `- marketStatus: ${marketStatus.reason}`,
  ];

  if (!marketStatus.isOpen) {
    return {
      ok: false,
      code: 'strategy_exit_market_closed',
      lines: [...lines, '- 현재 장외/휴장 상태라 전략 청산 실행을 보류합니다.'],
    };
  }

  if (candidate.exchange === 'kis_overseas' && modeInfo.brokerAccountMode === 'mock') {
    return {
      ok: false,
      code: 'strategy_exit_overseas_mock_sell_blocked',
      lines: [...lines, '- 해외장 mock 계좌는 SELL 미지원으로 전략 청산을 차단합니다.'],
    };
  }

  return { ok: true, code: 'strategy_exit_runner_preflight_clear', lines };
}

function summarizeStrategyExitRunnerCandidate(candidate = null, fallback = {}) {
  if (!candidate) {
    return {
      exchange: fallback.exchange || null,
      symbol: fallback.symbol || null,
      tradeMode: fallback.tradeMode || 'normal',
      found: false,
    };
  }
  return {
    exchange: candidate.exchange || null,
    symbol: candidate.symbol || null,
    tradeMode: candidate.tradeMode || 'normal',
    reasonCode: candidate.reasonCode || null,
    heldHours: candidate.heldHours ?? null,
    pnlPct: candidate.pnlPct ?? null,
    positionAmount: candidate.positionAmount ?? null,
    positionValue: candidate.positionValue ?? null,
    executionGuard: candidate.executionGuard || null,
    found: true,
  };
}

export async function buildStrategyExitRunnerPreflightForDispatchCandidate(dispatchCandidate = {}, {
  minutesBack = 180,
} = {}) {
  const runnerArgs = dispatchCandidate?.runnerArgs || {};
  const symbol = String(dispatchCandidate?.symbol || runnerArgs.symbol || '').toUpperCase();
  const exchange = dispatchCandidate?.exchange || runnerArgs.exchange || null;
  const tradeMode = dispatchCandidate?.tradeMode || runnerArgs['trade-mode'] || runnerArgs.tradeMode || null;
  if (!symbol) {
    return {
      ok: false,
      code: 'strategy_exit_symbol_missing',
      lines: ['- strategy-exit runner preflight: symbol이 없습니다.'],
      candidate: summarizeStrategyExitRunnerCandidate(null, { exchange, symbol, tradeMode }),
    };
  }

  const candidates = await loadCandidates({
    exchange,
    tradeMode,
    minutesBack,
  });
  const candidate = pickCandidate(candidates, { symbol, exchange, tradeMode });
  const preflight = await getExecutionPreflight(candidate);
  return {
    ...preflight,
    ok: preflight.ok === true,
    code: preflight.code || (preflight.ok ? 'strategy_exit_runner_preflight_clear' : 'strategy_exit_runner_preflight_blocked'),
    candidate: summarizeStrategyExitRunnerCandidate(candidate, { exchange, symbol, tradeMode }),
  };
}

async function createStrategyExitSignal(candidate) {
  const incidentLink = candidate.signalIncidentLink || `${candidate.exitReasonOverride}${buildFamilyFeedbackIncidentSuffix(candidate.strategyProfile)}`;
  const idempotencyKey = buildStrategyExitIdempotencyKey(candidate);
  const signalId = await db.insertSignal({
    symbol: candidate.symbol,
    action: 'SELL',
    amountUsdt: candidate.positionValue,
    confidence: 1,
    reasoning: `승인형 strategy-exit 실행 (${candidate.reasonCode})`,
    exchange: candidate.exchange,
    tradeMode: candidate.tradeMode,
    nemesisVerdict: 'approved',
    approvedAt: new Date().toISOString(),
    executionOrigin: 'strategy',
    qualityFlag: 'trusted',
    excludeFromLearning: false,
    incidentLink,
  });
  const signal = await db.getSignalById(signalId);
  return {
    ...signal,
    exchange: candidate.exchange,
    trade_mode: candidate.tradeMode,
    exit_reason_override: incidentLink,
    _idempotencyKey: idempotencyKey,
    _regime: candidate?.strategyProfile?.positionRuntimeState?.regime || null,
    _setupType: candidate?.strategyProfile?.setupType || null,
    _strategyFamily: candidate?.strategyProfile?.familyPerformanceFeedback?.family || null,
    _familyBias: candidate?.strategyProfile?.familyPerformanceFeedback?.bias || null,
    _positionValue: candidate.positionValue,
  };
}

export function buildStrategyExitIdempotencyKey(candidate) {
  const symbol = String(candidate?.symbol || 'UNKNOWN');
  const exchange = String(candidate?.exchange || 'unknown');
  const tradeMode = String(candidate?.tradeMode || 'normal');
  const reasonCode = String(candidate?.reasonCode || 'exit');
  const strategyProfileId = String(candidate?.strategyProfile?.id || 'profile_unknown');
  const strategyName = String(candidate?.strategyProfile?.strategyName || 'strategy_unknown');
  const setupType = String(candidate?.strategyProfile?.setupType || 'setup_unknown');
  const runtimeState = candidate?.strategyProfile?.positionRuntimeState || {};
  const runtimeVersion = Number(runtimeState?.version);
  const runtimeVersionToken = Number.isFinite(runtimeVersion) ? `v${runtimeVersion}` : 'v0';
  const runtimeUpdatedAt = String(runtimeState?.updatedAt || runtimeState?.updated_at || '').trim();
  const runtimeUpdatedToken = runtimeUpdatedAt
    ? runtimeUpdatedAt.replace(/[^0-9a-z]/gi, '').slice(0, 20)
    : 'no_runtime_ts';
  const positionAmount = Number(candidate?.positionAmount || 0);
  const positionValue = Number(candidate?.positionValue || 0);
  return [
    'strategy_exit',
    'v2',
    symbol,
    exchange,
    tradeMode,
    reasonCode,
    strategyProfileId,
    strategyName,
    setupType,
    runtimeVersionToken,
    runtimeUpdatedToken,
    positionAmount.toFixed(8),
    positionValue.toFixed(2),
  ].join(':');
}

async function executeCandidate(candidate) {
  const signal = await createStrategyExitSignal(candidate);
  if (candidate.exchange === 'binance') return executeCryptoSignal(signal);
  if (candidate.exchange === 'kis') return executeDomesticSignal(signal);
  if (candidate.exchange === 'kis_overseas') return executeOverseasSignal(signal);
  throw new Error(`지원하지 않는 exchange: ${candidate.exchange}`);
}

async function main() {
  const options = parseArgs();
  const candidates = await loadCandidates({
    exchange: options.exchange,
    tradeMode: options.tradeMode,
    minutesBack: options.minutesBack,
  });

  if (!options.symbol) {
    const payload = {
      mode: 'preview',
      ok: true,
      totalCandidates: candidates.length,
      candidates,
      usage: [
        'node bots/investment/scripts/strategy-exit-runner.ts --symbol=TAO/USDT --exchange=binance',
        'env PAPER_MODE=false node bots/investment/scripts/strategy-exit-runner.ts --symbol=TAO/USDT --exchange=binance --execute --confirm=strategy-exit',
      ],
    };
    if (options.json) return console.log(JSON.stringify(payload, null, 2));
    console.log(JSON.stringify(payload, null, 2));
    return;
  }

  const candidate = pickCandidate(candidates, options);
  if (!candidate) {
    throw new Error(`strategy-exit 후보를 찾지 못했습니다: symbol=${options.symbol}${options.exchange ? ` exchange=${options.exchange}` : ''}`);
  }

  const preflight = await getExecutionPreflight(candidate);
  if (!options.execute) {
    await syncStrategyExitCandidateStates([candidate], 'preview');
    const payload = {
      mode: 'preview',
      ok: preflight.ok === true,
      status: preflight.ok === true ? 'strategy_exit_preview_clear' : 'strategy_exit_preview_blocked',
      candidate,
      preflight,
      executeCommand: `env PAPER_MODE=false node bots/investment/scripts/strategy-exit-runner.ts --symbol=${candidate.symbol} --exchange=${candidate.exchange} --trade-mode=${candidate.tradeMode} --execute --confirm=strategy-exit`,
    };
    if (options.json) return console.log(JSON.stringify(payload, null, 2));
    console.log(JSON.stringify(payload, null, 2));
    return;
  }

  const autonomousContext = isAutonomousExecutionContext(options);
  if (!autonomousContext && options.confirm !== 'strategy-exit') {
    throw new Error('실행하려면 --confirm=strategy-exit 또는 --confirm=position-runtime-autopilot 가 필요합니다.');
  }
  if (!preflight.ok) {
    throw new Error(`strategy-exit preflight blocked: ${preflight.lines.join(' | ')}`);
  }

  await syncStrategyExitCandidateStates([candidate], 'execute');
  const signal = await createStrategyExitSignal(candidate);
  const lifecyclePolicySnapshot = candidate?.strategyProfile?.positionRuntimeState?.policyMatrix
    || candidate?.executionIntent?.policyMatrix
    || {};
  await recordLifecyclePhaseSnapshot({
    symbol: candidate.symbol,
    exchange: candidate.exchange,
    tradeMode: candidate.tradeMode,
    phase: 'phase3_approve',
    ownerAgent: 'strategy_exit_runner',
    eventType: 'completed',
    inputSnapshot: {
      recommendation: 'EXIT',
      reasonCode: candidate.reasonCode,
      preflight,
    },
    outputSnapshot: {
      signalId: signal.id,
      incidentLink: signal.exit_reason_override,
      idempotencyKey: signal._idempotencyKey,
    },
    policySnapshot: lifecyclePolicySnapshot,
    idempotencyKey: `phase3:strategy_exit:${signal._idempotencyKey}`,
  }).catch(() => null);

  const closeoutCtx = {
    symbol: candidate.symbol,
    exchange: candidate.exchange,
    tradeMode: candidate.tradeMode,
    closeoutType: 'full_exit',
    reasonCode: candidate.reasonCode,
    incidentLink: signal.exit_reason_override,
    plannedRatio: 1.0,
    plannedNotional: signal._positionValue,
    regime: signal._regime,
    setupType: signal._setupType,
    strategyFamily: signal._strategyFamily,
    familyBias: signal._familyBias,
    idempotencyKey: signal._idempotencyKey,
    cooldownMinutes: 60,
  };
  const beginResult = await beginCloseout(closeoutCtx).catch(async (error) => {
    const reason = `closeout_guard_error:${error?.message || String(error)}`;
    await publishToMainBot({
      from_bot: 'luna',
      event_type: 'system_error',
      alert_level: 3,
      message: `⚠️ [phase6] strategy-exit closeout guard exception\nsymbol=${candidate.symbol}\nexchange=${candidate.exchange}\ncloseoutType=full_exit\nreason=${reason}`,
      payload: {
        closeoutType: 'full_exit',
        closeout_guard_error: reason,
        symbol: candidate.symbol,
        exchange: candidate.exchange,
        tradeMode: candidate.tradeMode,
        idempotencyKey: signal._idempotencyKey,
      },
    }).catch(() => null);
    return { ok: false, reason };
  });
  if (!beginResult.ok) {
    await recordLifecyclePhaseSnapshot({
      symbol: candidate.symbol,
      exchange: candidate.exchange,
      tradeMode: candidate.tradeMode,
      phase: 'phase4_execute',
      ownerAgent: 'strategy_exit_runner',
      eventType: 'blocked',
      inputSnapshot: {
        signalId: signal.id,
        idempotencyKey: signal._idempotencyKey,
      },
      outputSnapshot: {
        reason: beginResult.reason || 'closeout_preflight_blocked',
      },
      policySnapshot: lifecyclePolicySnapshot,
      idempotencyKey: `phase4:block:strategy_exit:${signal._idempotencyKey}`,
    }).catch(() => null);
    throw new Error(`strategy-exit closeout guard: ${beginResult.reason}`);
  }
  await recordLifecyclePhaseSnapshot({
    symbol: candidate.symbol,
    exchange: candidate.exchange,
    tradeMode: candidate.tradeMode,
    phase: 'phase4_execute',
    ownerAgent: 'strategy_exit_runner',
    eventType: 'started',
    inputSnapshot: {
      signalId: signal.id,
      idempotencyKey: signal._idempotencyKey,
      plannedRatio: 1.0,
      plannedNotional: signal._positionValue,
    },
    policySnapshot: lifecyclePolicySnapshot,
    idempotencyKey: `phase4:start:strategy_exit:${signal._idempotencyKey}`,
  }).catch(() => null);

  let executeResult = null;
  let executeError = null;
  try {
    if (signal.exchange === 'binance') executeResult = await executeCryptoSignal(signal);
    else if (signal.exchange === 'kis') executeResult = await executeDomesticSignal(signal);
    else if (signal.exchange === 'kis_overseas') executeResult = await executeOverseasSignal(signal);
    else throw new Error(`지원하지 않는 exchange: ${signal.exchange}`);
  } catch (err) {
    executeError = err;
  }

  const closeoutResult = await finalizeCloseout(
    closeoutCtx,
    signal.id,
    executeResult,
    executeError,
  ).catch(() => null);
  const executionFailed = Boolean(executeError || closeoutResult?.ok === false);
  await recordLifecyclePhaseSnapshot({
    symbol: candidate.symbol,
    exchange: candidate.exchange,
    tradeMode: candidate.tradeMode,
    phase: 'phase4_execute',
    ownerAgent: 'strategy_exit_runner',
    eventType: executionFailed ? 'failed' : 'completed',
    inputSnapshot: {
      signalId: signal.id,
      idempotencyKey: signal._idempotencyKey,
    },
    outputSnapshot: {
      ok: !executionFailed,
      closeoutReviewId: closeoutResult?.reviewId || null,
      error: executeError?.message || closeoutResult?.error || null,
    },
    policySnapshot: lifecyclePolicySnapshot,
    idempotencyKey: `phase4:result:strategy_exit:${signal._idempotencyKey}`,
  }).catch(() => null);

  if (executeError) throw executeError;
  if (closeoutResult?.ok === false) {
    throw new Error(`strategy-exit execution unsuccessful: ${closeoutResult.error || closeoutResult.reviewStatus || 'unknown'}`);
  }

  const payload = {
    mode: 'execute',
    ok: true,
    runContext: options.runContext || null,
    executionStatus: closeoutResult?.reviewStatus === 'pending' ? 'pending' : 'executed',
    reviewStatus: closeoutResult?.reviewStatus || 'completed',
    candidate,
    preflight,
    signalId: signal.id,
    result: executeResult,
    closeoutReviewId: closeoutResult?.reviewId || null,
  };
  if (options.json) return console.log(JSON.stringify(payload, null, 2));
  console.log(JSON.stringify(payload, null, 2));
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({
    before: () => db.initSchema(),
    run: () => main(),
    onError: async (error) => {
      console.error(`[strategy-exit-runner] ${error?.stack || error?.message || String(error)}`);
    },
  });
}
