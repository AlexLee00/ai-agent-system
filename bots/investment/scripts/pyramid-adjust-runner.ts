#!/usr/bin/env node
// @ts-nocheck

import * as db from '../shared/db.ts';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';
import { reevaluateOpenPositions } from '../shared/position-reevaluator.ts';
import { executeSignal as executeCryptoSignal } from '../team/hephaestos.ts';
import { executeSignal as executeDomesticSignal, executeOverseasSignal } from '../team/hanul.ts';
import { getKisExecutionModeInfo, getKisMarketStatus, getKisOverseasMarketStatus } from '../shared/secrets.ts';
import { buildPositionScopeKey, recordLifecyclePhaseSnapshot } from '../shared/lifecycle-contract.ts';
import { resolvePositionLifecycleFlags } from '../shared/position-lifecycle-flags.ts';
import { adjustLunaBuyCandidate, getLunaBuyingPowerSnapshot } from '../shared/capital-manager.ts';

const DEFAULT_MAX_PYRAMID_COUNT = 3;
const DEFAULT_DEDUPE_WINDOW_MINUTES = 180;

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

function isAutonomousExecutionContext(args = {}) {
  const confirm = String(args?.confirm || '').trim();
  const runContext = String(args?.runContext || '').trim();
  return confirm === 'position-runtime-autopilot' || runContext === 'position-runtime-autopilot';
}

function safeNumber(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function buildPyramidIdempotencyKey(candidate) {
  const runtimeState = candidate?.runtimeState || {};
  const runtimeVersion = Number(runtimeState?.version);
  const versionToken = Number.isFinite(runtimeVersion) ? `v${runtimeVersion}` : 'v0';
  const updatedToken = String(runtimeState?.updatedAt || '').replace(/[^0-9a-z]/gi, '').slice(0, 20) || 'no_runtime_ts';
  return [
    'pyramid_adjust',
    'v1',
    candidate.symbol,
    candidate.exchange,
    candidate.tradeMode || 'normal',
    candidate.reasonCode || 'unknown',
    versionToken,
    updatedToken,
    safeNumber(candidate.adjustmentRatio).toFixed(4),
    safeNumber(candidate.amountUsdt).toFixed(2),
  ].join(':');
}

function getMaxPyramidCount() {
  const parsed = Number(process.env.LUNA_DYNAMIC_POSITION_MAX_PYRAMID_COUNT || DEFAULT_MAX_PYRAMID_COUNT);
  return Number.isFinite(parsed) ? Math.max(1, Math.floor(parsed)) : DEFAULT_MAX_PYRAMID_COUNT;
}

function getPyramidDedupeWindowMinutes() {
  const parsed = Number(process.env.LUNA_DYNAMIC_POSITION_DEDUPE_MINUTES || DEFAULT_DEDUPE_WINDOW_MINUTES);
  return Number.isFinite(parsed) ? Math.max(5, Math.floor(parsed)) : DEFAULT_DEDUPE_WINDOW_MINUTES;
}

function mapCandidate(row) {
  const sizing = row?.dynamicPositionSizing
    || row?.runtimeState?.marketState?.positionSizingSnapshot
    || row?.runtimeState?.policyMatrix?.positionSizing
    || null;
  const positionAmount = safeNumber(row?.positionSnapshot?.amount);
  const avgPrice = safeNumber(row?.positionSnapshot?.avgPrice);
  const estimatedNotional = positionAmount * avgPrice;
  const adjustmentRatio = safeNumber(sizing?.adjustmentRatio);
  const amountUsdt = Math.max(0, estimatedNotional * adjustmentRatio);
  return {
    exchange: row.exchange,
    symbol: row.symbol,
    tradeMode: row.tradeMode || 'normal',
    pnlPct: safeNumber(row.pnlPct),
    reasonCode: sizing?.reasonCode || row.reasonCode || 'pyramid_continuation',
    reason: row.reason || null,
    adjustmentRatio,
    amountUsdt,
    positionAmount,
    avgPrice,
    estimatedNotional,
    sizingDecision: sizing,
    runtimeState: row.runtimeState || null,
    executionIntent: row.executionIntent || row.runtimeState?.executionIntent || null,
  };
}

async function loadCandidates({ tradeMode = null, minutesBack = 180 } = {}) {
  const report = await reevaluateOpenPositions({
    exchange: null,
    paper: false,
    tradeMode,
    minutesBack,
    persist: false,
  });
  return (report.rows || [])
    .filter((row) => ['binance', 'kis', 'kis_overseas'].includes(row.exchange))
    .map(mapCandidate)
    .filter((candidate) => (
      candidate?.sizingDecision?.enabled === true
      && candidate?.sizingDecision?.mode === 'pyramid'
      && candidate.amountUsdt > 0
    ));
}

export function buildPyramidSafetyReport({
  candidate = null,
  flags = null,
  duplicateSignal = null,
  priorPyramidCount = 0,
  capitalCheck = null,
  maxPyramidCount = DEFAULT_MAX_PYRAMID_COUNT,
} = {}) {
  const blockers = [];
  const warnings = [];
  const adjustmentRatio = safeNumber(candidate?.adjustmentRatio);
  const amountUsdt = safeNumber(candidate?.amountUsdt);
  const maxPyramidRatio = safeNumber(flags?.phaseE?.maxPyramidRatio, 0.25);

  if (!candidate) blockers.push('pyramid_candidate_missing');
  if (flags?.phaseE?.enabled !== true) blockers.push('dynamic_position_sizing_disabled');
  if (!(adjustmentRatio > 0)) blockers.push('pyramid_adjustment_ratio_invalid');
  if (maxPyramidRatio > 0 && adjustmentRatio > maxPyramidRatio) blockers.push('pyramid_adjustment_ratio_above_cap');
  if (!(amountUsdt > 0)) blockers.push('pyramid_amount_invalid');
  if (duplicateSignal) blockers.push('recent_duplicate_buy_signal');
  if (Number(priorPyramidCount || 0) >= Number(maxPyramidCount || DEFAULT_MAX_PYRAMID_COUNT)) blockers.push('max_pyramid_count_reached');
  if (candidate?.executionIntent?.executionAllowed === false) blockers.push('runtime_execution_guard_blocked');
  if (candidate?.runtimeState?.policyMatrix?.portfolioReflexiveBias?.blockPyramid === true) blockers.push('portfolio_reflexive_blocks_pyramid');
  if (capitalCheck && !['accepted', 'reduced'].includes(String(capitalCheck.result || ''))) {
    blockers.push(`capital_${capitalCheck.result || 'blocked'}`);
  }
  if (capitalCheck?.result === 'reduced') warnings.push('pyramid_amount_reduced_by_capital_gate');

  return {
    ok: blockers.length === 0,
    blockers,
    warnings,
    priorPyramidCount: Number(priorPyramidCount || 0),
    maxPyramidCount: Number(maxPyramidCount || DEFAULT_MAX_PYRAMID_COUNT),
    maxPyramidRatio,
    adjustedAmountUsdt: capitalCheck?.adjustedAmount && Number(capitalCheck.adjustedAmount) > 0
      ? Number(capitalCheck.adjustedAmount)
      : amountUsdt,
    capitalCheck: capitalCheck || null,
  };
}

async function getPriorPyramidCount(candidate) {
  const scopeKey = buildPositionScopeKey(candidate.symbol, candidate.exchange, candidate.tradeMode || 'normal');
  const events = await db.getLifecycleEventsForScope(scopeKey, { limit: 100 }).catch(() => []);
  return (events || []).filter((event) => (
    String(event?.owner_agent || event?.ownerAgent || '') === 'pyramid_adjust_runner'
    && String(event?.phase || '') === 'phase4_execute'
    && String(event?.event_type || event?.eventType || '') === 'completed'
  )).length;
}

async function getExecutionPreflight(candidate, { strictCapital = false } = {}) {
  if (!candidate) return { ok: false, lines: ['- pyramid-adjust 후보가 없습니다.'] };
  const flags = resolvePositionLifecycleFlags();
  const [duplicateSignal, priorPyramidCount] = await Promise.all([
    db.getRecentSignalDuplicate({
      symbol: candidate.symbol,
      action: 'BUY',
      exchange: candidate.exchange,
      tradeMode: candidate.tradeMode || 'normal',
      minutesBack: getPyramidDedupeWindowMinutes(),
    }).catch(() => null),
    getPriorPyramidCount(candidate),
  ]);
  const capitalCheck = strictCapital
    ? await getLunaBuyingPowerSnapshot(candidate.exchange, candidate.tradeMode || 'normal')
      .then((snapshot) => adjustLunaBuyCandidate(candidate.amountUsdt, snapshot))
      .catch((error) => ({
        result: 'blocked_balance_unavailable',
        desiredAmount: candidate.amountUsdt,
        adjustedAmount: 0,
        minOrderAmount: 0,
        reason: `capital_snapshot_error:${error?.message || String(error)}`,
      }))
    : null;
  const safety = buildPyramidSafetyReport({
    candidate,
    flags,
    duplicateSignal,
    priorPyramidCount,
    capitalCheck,
    maxPyramidCount: getMaxPyramidCount(),
  });
  if (!safety.ok) {
    return {
      ok: false,
      safety,
      lines: [`- pyramid safety blocked: ${safety.blockers.join(', ') || 'unknown'}`],
    };
  }
  if (candidate.exchange === 'binance') return { ok: true, lines: ['- 암호화폐 pyramid-adjust는 현재 실행 가능'], safety };

  const modeInfo = getKisExecutionModeInfo(candidate.exchange === 'kis' ? '국내주식' : '해외주식');
  const marketStatus = candidate.exchange === 'kis' ? await getKisMarketStatus() : getKisOverseasMarketStatus();
  const lines = [
    `- accountMode: ${modeInfo.brokerAccountMode}`,
    `- executionMode: ${modeInfo.executionMode}`,
    `- marketStatus: ${marketStatus.reason}`,
  ];
  if (!marketStatus.isOpen) return { ok: false, lines: [...lines, '- 현재 장외/휴장 상태라 pyramid-adjust 실행을 보류합니다.'] };
  return { ok: true, lines, safety };
}

async function createPyramidSignal(candidate) {
  const idempotencyKey = buildPyramidIdempotencyKey(candidate);
  const inserted = await db.insertSignalIfFresh({
    symbol: candidate.symbol,
    action: 'BUY',
    amountUsdt: candidate.amountUsdt,
    confidence: 1,
    reasoning: `동적 포지션 sizing pyramid 실행 (${candidate.reasonCode})`,
    exchange: candidate.exchange,
    tradeMode: candidate.tradeMode,
    nemesisVerdict: 'approved',
    approvedAt: new Date().toISOString(),
    executionOrigin: 'strategy',
    qualityFlag: 'trusted',
    excludeFromLearning: false,
    incidentLink: `pyramid_adjust:${candidate.reasonCode}`,
    dedupeWindowMinutes: getPyramidDedupeWindowMinutes(),
  });
  const signalId = inserted.id;
  const signal = await db.getSignalById(signalId);
  return {
    ...signal,
    exchange: candidate.exchange,
    trade_mode: candidate.tradeMode,
    _idempotencyKey: idempotencyKey,
    _duplicateSignal: inserted.duplicate === true,
  };
}

async function executePyramidSignal(signal) {
  if (signal.exchange === 'binance') return executeCryptoSignal(signal);
  if (signal.exchange === 'kis') return executeDomesticSignal(signal);
  if (signal.exchange === 'kis_overseas') return executeOverseasSignal(signal);
  throw new Error(`지원하지 않는 exchange: ${signal.exchange}`);
}

function renderPreview(candidates) {
  return [
    '🧱 pyramid-adjust 실행 preview',
    '',
    `- 후보 수: ${candidates.length}건`,
    ...candidates.map((candidate) => `- ${candidate.symbol} | ${candidate.exchange} | pnl=${candidate.pnlPct.toFixed(2)}% | add=${candidate.amountUsdt.toFixed(2)} | ratio=${candidate.adjustmentRatio} | reason=${candidate.reasonCode}`),
    '',
    '- 실제 실행은 `--symbol`, `--execute`, `--confirm=pyramid-adjust`가 모두 필요합니다.',
  ].join('\n');
}

async function main() {
  const args = parseArgs();
  const candidates = await loadCandidates({ tradeMode: args.tradeMode, minutesBack: args.minutesBack });
  if (!args.symbol) {
    const payload = { mode: 'preview', ok: true, totalCandidates: candidates.length, candidates };
    if (args.json) { console.log(JSON.stringify(payload, null, 2)); return; }
    console.log(renderPreview(candidates));
    return;
  }

  const candidate = candidates.find((item) => (
    item.symbol === args.symbol
    && (!args.exchange || item.exchange === args.exchange)
    && (!args.tradeMode || item.tradeMode === args.tradeMode)
  )) || null;
  if (!candidate) throw new Error(`pyramid-adjust 후보를 찾지 못했습니다: ${args.symbol}`);

  const preflight = await getExecutionPreflight(candidate, { strictCapital: args.execute === true });
  const executableCandidate = preflight?.safety?.adjustedAmountUsdt > 0
    ? { ...candidate, amountUsdt: preflight.safety.adjustedAmountUsdt }
    : candidate;
  if (!args.execute) {
    const payload = { mode: 'preview', ok: true, candidate, preflight };
    if (args.json) { console.log(JSON.stringify(payload, null, 2)); return; }
    console.log(renderPreview([candidate]));
    return;
  }

  if (!isAutonomousExecutionContext(args) && args.confirm !== 'pyramid-adjust') {
    throw new Error('실행하려면 --confirm=pyramid-adjust 또는 --confirm=position-runtime-autopilot 가 필요합니다.');
  }
  if (!preflight.ok) throw new Error(`pyramid-adjust preflight blocked: ${preflight.lines.join(' | ')}`);

  const signal = await createPyramidSignal(executableCandidate);
  await recordLifecyclePhaseSnapshot({
    symbol: executableCandidate.symbol,
    exchange: executableCandidate.exchange,
    tradeMode: executableCandidate.tradeMode,
    phase: 'phase3_approve',
    ownerAgent: 'pyramid_adjust_runner',
    eventType: 'completed',
    inputSnapshot: { recommendation: 'ADJUST', reasonCode: executableCandidate.reasonCode, preflight },
    outputSnapshot: { signalId: signal.id, idempotencyKey: signal._idempotencyKey, amountUsdt: executableCandidate.amountUsdt },
    policySnapshot: executableCandidate.runtimeState?.policyMatrix || {},
    idempotencyKey: `phase3:pyramid_adjust:${signal._idempotencyKey}`,
  }).catch(() => null);

  let result = null;
  let error = null;
  try {
    result = await executePyramidSignal(signal);
  } catch (err) {
    error = err;
  }
  await recordLifecyclePhaseSnapshot({
    symbol: executableCandidate.symbol,
    exchange: executableCandidate.exchange,
    tradeMode: executableCandidate.tradeMode,
    phase: 'phase4_execute',
    ownerAgent: 'pyramid_adjust_runner',
    eventType: error ? 'failed' : 'completed',
    inputSnapshot: { signalId: signal.id, idempotencyKey: signal._idempotencyKey },
    outputSnapshot: { ok: !error, error: error?.message || null, result },
    policySnapshot: executableCandidate.runtimeState?.policyMatrix || {},
    idempotencyKey: `phase4:pyramid_adjust:${signal._idempotencyKey}`,
  }).catch(() => null);
  if (error) throw error;

  const payload = { mode: 'execute', ok: true, candidate: executableCandidate, preflight, signalId: signal.id, result };
  if (args.json) { console.log(JSON.stringify(payload, null, 2)); return; }
  console.log('✅ pyramid-adjust 실행 완료');
  console.log(JSON.stringify(payload, null, 2));
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({
    before: () => db.initSchema(),
    run: () => main(),
    onError: async (error) => {
      console.error(`[pyramid-adjust-runner] ${error?.stack || error?.message || String(error)}`);
    },
  });
}
