#!/usr/bin/env node
// @ts-nocheck

import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';
import { buildInvestmentCliInsight } from '../shared/cli-insight.ts';
import { annotateRuntimeSuggestions } from '../shared/runtime-parameter-governance.ts';
import { getCapitalConfigWithOverrides } from '../shared/capital-manager.ts';
import { buildRuntimeBinanceCircuitBreakerReport } from './runtime-binance-circuit-breaker-report.ts';
import { buildRuntimeBinanceCapitalGuardReport } from './runtime-binance-capital-guard-report.ts';
import { buildRuntimeBinanceCorrelationGuardReport } from './runtime-binance-correlation-guard-report.ts';

function parseArgs(argv = process.argv.slice(2)) {
  const daysArg = argv.find((arg) => arg.startsWith('--days='));
  return {
    days: Math.max(7, Number(daysArg?.split('=')[1] || 14)),
    json: argv.includes('--json'),
  };
}

function round(value, digits = 2) {
  const factor = 10 ** digits;
  return Math.round(Number(value) * factor) / factor;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function buildGuardSuggestions({ capitalPolicy, correlation, circuit, capitalGuard }) {
  const suggestions = [];
  const correlationTotal = Number(correlation?.decision?.metrics?.total || 0);
  const circuitTotal = Number(circuit?.decision?.metrics?.total || 0);
  const capitalGuardTotal = Number(capitalGuard?.decision?.metrics?.total || 0);
  const correlationShare = capitalGuardTotal > 0
    ? round((Number(capitalGuard?.decision?.metrics?.correlationGuard || 0) / capitalGuardTotal) * 100, 1)
    : 0;
  const currentMaxSameDirection = Number(capitalPolicy?.max_same_direction_positions || 3);
  const currentMaxConcurrentPositions = Number(capitalPolicy?.max_concurrent_positions || 3);
  const currentCooldownMinutes = Number(capitalPolicy?.cooldown_minutes || 60);
  const currentCooldownLossStreak = Number(capitalPolicy?.cooldown_after_loss_streak || 3);

  if (correlationTotal >= 10 && correlationShare >= 70) {
    suggestions.push({
      key: 'capital_management.max_same_direction_positions',
      current: currentMaxSameDirection,
      suggested: clamp(currentMaxSameDirection + 1, 1, 6),
      action: currentMaxSameDirection < 6 ? 'adjust' : 'observe',
      confidence: currentMaxSameDirection < 6 ? 'medium' : 'low',
      reason: `최근 correlation guard ${correlationTotal}건이 capital guard의 ${correlationShare}%를 차지합니다. same-direction long 슬롯을 1칸 더 열어 대표 후보 패스와 함께 비교할 가치가 있습니다.`,
    });
  }

  const maxPositionsTotal = Number(capitalGuard?.decision?.metrics?.maxPositions || 0);
  if (maxPositionsTotal >= 2) {
    suggestions.push({
      key: 'capital_management.max_concurrent_positions',
      current: currentMaxConcurrentPositions,
      suggested: clamp(currentMaxConcurrentPositions + 1, 1, 8),
      action: currentMaxConcurrentPositions < 8 ? 'adjust' : 'observe',
      confidence: currentMaxConcurrentPositions < 8 ? 'medium' : 'low',
      reason: `최근 max positions 차단 ${maxPositionsTotal}건이 확인돼 동시 포지션 수를 1칸 더 열어 실제 executed 전환이 늘어나는지 비교할 가치가 있습니다.`,
    });
  }

  if (circuitTotal >= 10) {
    suggestions.push({
      key: 'capital_management.cooldown_minutes',
      current: currentCooldownMinutes,
      suggested: clamp(currentCooldownMinutes - 15, 30, 360),
      action: currentCooldownMinutes > 30 ? 'adjust' : 'observe',
      confidence: currentCooldownMinutes > 30 ? 'medium' : 'low',
      reason: `최근 circuit breaker ${circuitTotal}건이 반복돼 연속 손실 쿨다운 시간이 길게 작동하고 있습니다. ${currentCooldownMinutes}분 쿨다운을 소폭 줄여 dry-run 비교 후보로 볼 수 있습니다.`,
    });
  }

  if (circuitTotal >= 18 && currentCooldownLossStreak < 5) {
    suggestions.push({
      key: 'capital_management.cooldown_after_loss_streak',
      current: currentCooldownLossStreak,
      suggested: clamp(currentCooldownLossStreak + 1, 2, 5),
      action: 'observe',
      confidence: 'low',
      reason: `연속 손실 기준 ${currentCooldownLossStreak}회가 현재 pressure 구간에서 다소 민감할 수 있습니다. 다만 손실 리스크가 커서 즉시 상향보다 관찰 후보로만 유지합니다.`,
    });
  }

  return annotateRuntimeSuggestions(suggestions).map((item) => ({
    ...item,
    governance: {
      ...item.governance,
      current: item.current,
    },
  }));
}

function buildDecision({ capitalPolicy, suggestions, correlation, circuit, capitalGuard }) {
  const actionable = suggestions.filter((item) => item.action === 'adjust');
  const observeOnly = suggestions.filter((item) => item.action === 'observe');
  const reasons = [
    `correlation guard: ${correlation?.decision?.status || 'unknown'}`,
    `capital guard: ${capitalGuard?.decision?.status || 'unknown'}`,
    `circuit breaker: ${circuit?.decision?.status || 'unknown'}`,
    `current normal lane: same-direction ${capitalPolicy?.max_same_direction_positions || 'n/a'} / cooldown ${capitalPolicy?.cooldown_minutes || 'n/a'}분 / loss streak ${capitalPolicy?.cooldown_after_loss_streak || 'n/a'}회`,
  ];

  let status = 'crypto_guard_autotune_idle';
  let headline = '지금은 crypto guard autotune 후보가 두드러지지 않습니다.';
  const actionItems = [];

  if (actionable.length > 0) {
    status = 'crypto_guard_autotune_ready';
    headline = 'crypto guard 병목을 줄일 후보가 준비됐습니다.';
    actionItems.push('rank 1 조정 후보를 dry-run override로 먼저 비교합니다.');
    actionItems.push('대표 후보 패스 적용 후 correlation/circuit 감소 추세를 같이 봅니다.');
  } else if (observeOnly.length > 0) {
    status = 'crypto_guard_autotune_watch';
    headline = 'crypto guard pressure는 보이지만 즉시 조정보다 관찰이 우선입니다.';
    actionItems.push('observe 후보의 pressure 추세를 2~3 사이클 더 누적합니다.');
  } else {
    actionItems.push('현재 설정을 유지하며 correlation/circuit 추세만 관찰합니다.');
  }

  return {
    status,
    headline,
    reasons,
    actionItems,
    metrics: {
      actionableCount: actionable.length,
      observeCount: observeOnly.length,
      correlationTotal: Number(correlation?.decision?.metrics?.total || 0),
      circuitTotal: Number(circuit?.decision?.metrics?.total || 0),
      capitalGuardTotal: Number(capitalGuard?.decision?.metrics?.total || 0),
    },
  };
}

function renderText(payload) {
  return [
    '🧪 Runtime Crypto Guard Autotune',
    `status: ${payload.decision.status}`,
    `headline: ${payload.decision.headline}`,
    payload.aiSummary ? `🔍 AI: ${payload.aiSummary}` : null,
    '',
    '근거:',
    ...payload.decision.reasons.map((reason) => `- ${reason}`),
    '',
    '후보:',
    ...(payload.suggestions.length > 0
      ? payload.suggestions.map((item) =>
          `- ${item.key} | ${item.action} | ${item.current} -> ${item.suggested} | ${item.confidence} | ${item.reason}`,
        )
      : ['- 후보 없음']),
    '',
    '권장 조치:',
    ...payload.decision.actionItems.map((item) => `- ${item}`),
  ].filter(Boolean).join('\n');
}

function buildFallback(payload = {}) {
  const decision = payload.decision || {};
  const metrics = decision.metrics || {};
  if (decision.status === 'crypto_guard_autotune_ready') {
    return `correlation ${metrics.correlationTotal || 0}건 / circuit ${metrics.circuitTotal || 0}건 기준으로 crypto guard 조정 후보를 dry-run으로 검토할 수 있습니다.`;
  }
  if (decision.status === 'crypto_guard_autotune_watch') {
    return `crypto guard pressure는 보이지만 아직은 조정보다 관찰 후보가 더 우세합니다.`;
  }
  return '지금은 crypto guard autotune 후보가 두드러지지 않아 현 설정을 유지하며 추세만 관찰하면 됩니다.';
}

export async function buildRuntimeCryptoGuardAutotuneReport({ days = 14, json = false } = {}) {
  const [capitalPolicy, correlation, circuit, capitalGuard] = await Promise.all([
    getCapitalConfigWithOverrides('binance', 'normal'),
    buildRuntimeBinanceCorrelationGuardReport({ days, json: true }).catch(() => null),
    buildRuntimeBinanceCircuitBreakerReport({ days, json: true }).catch(() => null),
    buildRuntimeBinanceCapitalGuardReport({ days, json: true }).catch(() => null),
  ]);

  const suggestions = buildGuardSuggestions({ capitalPolicy, correlation, circuit, capitalGuard });
  const decision = buildDecision({ capitalPolicy, suggestions, correlation, circuit, capitalGuard });
  const payload = {
    ok: true,
    days,
    capitalPolicy,
    correlation,
    circuit,
    capitalGuard,
    suggestions,
    decision,
  };

  payload.aiSummary = await buildInvestmentCliInsight({
    bot: 'runtime-crypto-guard-autotune-report',
    requestType: 'runtime-crypto-guard-autotune-report',
    title: '투자 crypto guard autotune 리포트 요약',
    data: {
      days,
      decision,
      suggestions,
      correlation: correlation?.decision,
      circuit: circuit?.decision,
      capitalGuard: capitalGuard?.decision,
    },
    fallback: buildFallback(payload),
  });

  if (json) return payload;
  return renderText(payload);
}

async function main() {
  const args = parseArgs();
  const result = await buildRuntimeCryptoGuardAutotuneReport(args);
  if (args.json) console.log(JSON.stringify(result, null, 2));
  else console.log(result);
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({
    run: main,
    errorPrefix: '❌ runtime-crypto-guard-autotune-report 오류:',
  });
}
