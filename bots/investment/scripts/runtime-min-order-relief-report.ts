#!/usr/bin/env node
// @ts-nocheck

import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';
import { getInvestmentRuntimeConfig } from '../shared/runtime-config.ts';
import { buildInvestmentCliInsight } from '../shared/cli-insight.ts';
import { buildRuntimeMinOrderPressureReport } from './runtime-min-order-pressure-report.ts';

function parseArgs(argv = process.argv.slice(2)) {
  const daysArg = argv.find((arg) => arg.startsWith('--days='));
  return {
    days: Math.max(7, Number(daysArg?.split('=')[1] || 14)),
    json: argv.includes('--json'),
  };
}

function parseKrw(reason = '') {
  const match = String(reason).match(/([\d,]+) KRW \(([\d,]+) KRW < ([\d,]+) KRW\)/);
  if (!match) return { gap: null, attempted: null, required: null };
  return {
    gap: Number(String(match[1]).replace(/,/g, '')),
    attempted: Number(String(match[2]).replace(/,/g, '')),
    required: Number(String(match[3]).replace(/,/g, '')),
  };
}

function formatKrw(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return 'n/a';
  return `${Math.round(n).toLocaleString()} KRW`;
}

export function buildDecision({ pressure, runtimeConfig }) {
  const reasons = [...(pressure?.decision?.reasons || [])];
  const runtimeGap = parseKrw(reasons.find((item) => String(item).startsWith('runtime gap ')) || '');
  const pressureMetrics = pressure?.decision?.metrics || {};

  const defaults = runtimeConfig?.luna?.stockOrderDefaults?.kis || {};
  const thresholds = runtimeConfig?.nemesis?.thresholds || {};
  const buyDefault = Number(defaults.buyDefault || 0);
  const minOrder = Number(defaults.min || 0);
  const maxOrder = Number(defaults.max || 0);
  const starterApprove = Number(thresholds.stockStarterApproveDomestic || 0);
  const attempted = Number(runtimeGap.attempted || pressureMetrics.maxGapAttempted || 0);
  const required = Number(runtimeGap.required || pressureMetrics.maxGapRequired || 0);
  const gap = Number(runtimeGap.gap || pressureMetrics.maxGap || 0);
  const blockedByOrderCap = required > 0 && maxOrder > 0 && required > maxOrder;
  const sizingFloorNeeded = required > 0
    && attempted > 0
    && attempted < required
    && required <= (buyDefault || required)
    && required <= (maxOrder || required);
  const candidateBuyDefault = required > 0 ? Math.min(required, maxOrder || required) : null;
  const candidateStarterApprove = required > 0 ? Math.min(required, maxOrder || required) : null;

  let status = 'relief_idle';
  let headline = 'min-order 완화 후보가 아직 뚜렷하지 않습니다.';
  const actionItems = [];

  if (String(pressure?.decision?.status || '').includes('pressure')) {
    if (blockedByOrderCap) {
      status = 'relief_blocked_by_order_cap';
      headline = 'required notional이 국내장 주문 상한을 넘어 allow 파라미터만으로는 해소되지 않습니다.';
      actionItems.push('국내장 주문 상한 자체를 바꿀지, 아니면 해당 조건을 예외 전략으로 분리할지 판단합니다.');
    } else if (sizingFloorNeeded) {
      status = 'relief_sizing_floor_needed';
      headline = '최소 주문금액은 주문 상한 안에 있으나 실제 sizing이 그 아래로 잘리고 있습니다.';
      actionItems.push('승인된 국내장 매수 후보는 최종 수량 산정 단계에서 minOrder 이상으로 올리거나, 올릴 수 없으면 후보를 제외합니다.');
      actionItems.push('position cap/잔여 예산이 minOrder 미만으로 자르는 경우는 autotune 후보가 아니라 sizing floor 정책으로 분리합니다.');
    } else if (candidateStarterApprove && candidateStarterApprove > starterApprove) {
      status = 'relief_candidate_ready';
      headline = 'starter approve와 기본 주문값 조정으로 완화 후보를 만들 수 있습니다.';
      actionItems.push('starter approve를 candidate 수준까지 올리는 synthetic 비교 후보를 만듭니다.');
      if (candidateBuyDefault > buyDefault) {
        actionItems.push('buyDefault를 같이 올렸을 때 gap이 해소되는지도 함께 비교합니다.');
      }
    } else {
      status = 'relief_observe';
      headline = '병목은 보이지만 현재 값 조합만으로 당장 완화 후보를 만들긴 어렵습니다.';
      actionItems.push('추가 runtime 표본을 더 쌓아 required notional 분포를 확인합니다.');
    }
  }

  if (actionItems.length === 0) {
    actionItems.push('현재 min-order 병목과 allow 후보 상태를 계속 누적합니다.');
  }

  return {
    status,
    headline,
    reasons,
    actionItems,
    metrics: {
      gap,
      attempted,
      required,
      buyDefault,
      minOrder,
      maxOrder,
      starterApprove,
      candidateBuyDefault,
      candidateStarterApprove,
      blockedByOrderCap,
      sizingFloorNeeded,
    },
  };
}

function renderText(payload) {
  const m = payload.decision.metrics || {};
  return [
    '💡 Runtime Min Order Relief',
    `status: ${payload.decision.status}`,
    `headline: ${payload.decision.headline}`,
    payload.aiSummary ? `🔍 AI: ${payload.aiSummary}` : null,
    '',
    '현재 값:',
    `- buyDefault: ${formatKrw(m.buyDefault)}`,
    `- minOrder: ${formatKrw(m.minOrder)}`,
    `- maxOrder: ${formatKrw(m.maxOrder)}`,
    `- starterApprove: ${formatKrw(m.starterApprove)}`,
    '',
    '요구치:',
    `- attempted: ${formatKrw(m.attempted)}`,
    `- required: ${formatKrw(m.required)}`,
    `- gap: ${formatKrw(m.gap)}`,
    '',
    '완화 후보:',
    `- candidateBuyDefault: ${formatKrw(m.candidateBuyDefault)}`,
    `- candidateStarterApprove: ${formatKrw(m.candidateStarterApprove)}`,
    `- blockedByOrderCap: ${m.blockedByOrderCap ? 'yes' : 'no'}`,
    `- sizingFloorNeeded: ${m.sizingFloorNeeded ? 'yes' : 'no'}`,
    '',
    '권장 조치:',
    ...payload.decision.actionItems.map((item) => `- ${item}`),
  ].filter(Boolean).join('\n');
}

function buildRuntimeMinOrderReliefFallback(payload = {}) {
  const decision = payload.decision || {};
  const metrics = decision.metrics || {};
  if (decision.status === 'relief_blocked_by_order_cap') {
    return 'required notional이 주문 상한을 넘어, allow 파라미터 조정보다 주문 상한 또는 예외 전략 분리가 먼저 필요합니다.';
  }
  if (decision.status === 'relief_candidate_ready') {
    return 'starter approve와 기본 주문값을 함께 조정하면 min-order relief 후보를 만들 수 있는 상태입니다.';
  }
  if (decision.status === 'relief_sizing_floor_needed') {
    return '최소 주문금액 자체는 주문 상한 안에 있어, allow 조정보다 최종 sizing floor 정책을 먼저 맞추는 편이 좋습니다.';
  }
  if (decision.status === 'relief_observe') {
    return '병목은 보이지만 즉시 relief 후보를 만들 정도는 아니어서 required notional 분포를 더 누적하는 편이 좋습니다.';
  }
  return `현재 min-order relief는 급하지 않으며 gap ${formatKrw(metrics.gap)} 추이만 계속 관찰하면 됩니다.`;
}

export async function buildRuntimeMinOrderReliefReport({ days = 14, json = false } = {}) {
  const pressure = await buildRuntimeMinOrderPressureReport({ market: 'kis', days, json: true }).catch(() => null);
  const runtimeConfig = getInvestmentRuntimeConfig();
  const decision = buildDecision({ pressure, runtimeConfig });
  const payload = {
    ok: true,
    days,
    pressure,
    runtimeConfig: {
      luna: { stockOrderDefaults: runtimeConfig?.luna?.stockOrderDefaults?.kis || null },
      nemesis: { thresholds: { stockStarterApproveDomestic: runtimeConfig?.nemesis?.thresholds?.stockStarterApproveDomestic || null } },
    },
    decision,
  };
  payload.aiSummary = await buildInvestmentCliInsight({
    bot: 'runtime-min-order-relief-report',
    requestType: 'runtime-min-order-relief-report',
    title: '투자 runtime min-order relief 리포트 요약',
    data: {
      days,
      decision,
      runtimeConfig: payload.runtimeConfig,
      pressureDecision: pressure?.decision,
    },
    fallback: buildRuntimeMinOrderReliefFallback(payload),
  });
  if (json) return payload;
  return renderText(payload);
}

async function main() {
  const args = parseArgs();
  const result = await buildRuntimeMinOrderReliefReport(args);
  if (args.json) console.log(JSON.stringify(result, null, 2));
  else console.log(result);
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({
    run: main,
    errorPrefix: '❌ runtime-min-order-relief-report 오류:',
  });
}
