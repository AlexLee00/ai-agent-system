#!/usr/bin/env node
// @ts-nocheck

import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';
import { getInvestmentRuntimeConfig } from '../shared/runtime-config.ts';
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

function buildDecision({ pressure, runtimeConfig }) {
  const reasons = [...(pressure?.decision?.reasons || [])];
  const runtimeGap = parseKrw(reasons.find((item) => String(item).startsWith('runtime gap ')) || '');

  const defaults = runtimeConfig?.luna?.stockOrderDefaults?.kis || {};
  const thresholds = runtimeConfig?.nemesis?.thresholds || {};
  const buyDefault = Number(defaults.buyDefault || 0);
  const minOrder = Number(defaults.min || 0);
  const maxOrder = Number(defaults.max || 0);
  const starterApprove = Number(thresholds.stockStarterApproveDomestic || 0);
  const required = Number(runtimeGap.required || 0);
  const blockedByOrderCap = required > 0 && maxOrder > 0 && required > maxOrder;
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
      gap: runtimeGap.gap,
      attempted: runtimeGap.attempted,
      required,
      buyDefault,
      minOrder,
      maxOrder,
      starterApprove,
      candidateBuyDefault,
      candidateStarterApprove,
      blockedByOrderCap,
    },
  };
}

function renderText(payload) {
  const m = payload.decision.metrics || {};
  return [
    '💡 Runtime Min Order Relief',
    `status: ${payload.decision.status}`,
    `headline: ${payload.decision.headline}`,
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
    '',
    '권장 조치:',
    ...payload.decision.actionItems.map((item) => `- ${item}`),
  ].join('\n');
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
