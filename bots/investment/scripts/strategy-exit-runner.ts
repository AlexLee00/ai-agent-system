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
    minutesBack: values.minutes ? Math.max(10, Number(values.minutes)) : 180,
  };
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

function buildExitReason(candidate) {
  const exitPlan = normalizeExitPlan(candidate?.strategyProfile?.exitPlan);
  const primary = String(exitPlan.primaryExit || '').trim();
  if (primary) return `strategy_exit:${primary}`;
  return `strategy_exit:${candidate.reasonCode || 'reeval_exit'}`;
}

function applyExitPlanGuard(candidate) {
  const exitPlan = normalizeExitPlan(candidate?.strategyProfile?.exitPlan);
  if (!exitPlan || Object.keys(exitPlan).length === 0) {
    return { allowed: true, level: 'fallback', reason: null };
  }

  const minHoldHours = safeNumber(exitPlan.minHoldHours, 0);
  const mildLossGracePct = safeNumber(exitPlan.mildLossGracePct, null);
  const hardReason = isHardExitReason(candidate.reasonCode);

  if (!hardReason && minHoldHours > 0 && candidate.heldHours < minHoldHours) {
    return {
      allowed: false,
      level: 'guarded',
      reason: `전략 최소 보유시간 ${minHoldHours}h 미만 (${candidate.heldHours.toFixed(1)}h)`,
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
      reason: `전략 손실 유예 ${mildLossGracePct}% 범위 내 (${candidate.pnlPct.toFixed(2)}%)`,
    };
  }

  return { allowed: true, level: 'ready', reason: null };
}

function mapCandidate(row, strategyProfile = null) {
  const heldHours = heldHoursFromEntry(row?.positionSnapshot?.entryTime);
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
    strategyProfile: strategyProfile ? {
      strategyName: strategyProfile.strategy_name || null,
      setupType: strategyProfile.setup_type || null,
      exitPlan: strategyProfile.exit_plan || {},
      responsibilityPlan: strategyProfile.strategy_context?.responsibilityPlan || {},
    } : null,
  };
  const guard = applyExitPlanGuard(candidate);
  return {
    ...candidate,
    exitReasonOverride: buildExitReason(candidate),
    executionGuard: guard,
  };
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

async function getExecutionPreflight(candidate) {
  if (!candidate) return { ok: false, lines: ['- strategy-exit 후보가 없습니다.'] };
  if (!candidate.executionGuard?.allowed) {
    return {
      ok: false,
      lines: [`- strategy exit guard: ${candidate.executionGuard.reason}`],
    };
  }
  if (candidate.exchange === 'binance') {
    return {
      ok: true,
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
      lines: [...lines, '- 현재 장외/휴장 상태라 전략 청산 실행을 보류합니다.'],
    };
  }

  if (candidate.exchange === 'kis_overseas' && modeInfo.brokerAccountMode === 'mock') {
    return {
      ok: false,
      lines: [...lines, '- 해외장 mock 계좌는 SELL 미지원으로 전략 청산을 차단합니다.'],
    };
  }

  return { ok: true, lines };
}

async function createStrategyExitSignal(candidate) {
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
    incidentLink: `strategy_exit:${candidate.reasonCode || 'reeval_exit'}`,
  });
  const signal = await db.getSignalById(signalId);
  return {
    ...signal,
    exchange: candidate.exchange,
    trade_mode: candidate.tradeMode,
    exit_reason_override: candidate.exitReasonOverride,
  };
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
    const payload = {
      mode: 'preview',
      candidate,
      preflight,
      executeCommand: `env PAPER_MODE=false node bots/investment/scripts/strategy-exit-runner.ts --symbol=${candidate.symbol} --exchange=${candidate.exchange} --trade-mode=${candidate.tradeMode} --execute --confirm=strategy-exit`,
    };
    if (options.json) return console.log(JSON.stringify(payload, null, 2));
    console.log(JSON.stringify(payload, null, 2));
    return;
  }

  if (options.confirm !== 'strategy-exit') {
    throw new Error('실행하려면 --confirm=strategy-exit 가 필요합니다.');
  }
  if (!preflight.ok) {
    throw new Error(`strategy-exit preflight blocked: ${preflight.lines.join(' | ')}`);
  }

  const result = await executeCandidate(candidate);
  const payload = {
    mode: 'execute',
    candidate,
    preflight,
    result,
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
