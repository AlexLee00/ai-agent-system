#!/usr/bin/env node
// @ts-nocheck

import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';
import { buildInvestmentCliInsight } from '../shared/cli-insight.ts';
import { buildBinanceDustSnapshot } from './liquidate-binance-dust.ts';

const DEFAULT_MAX_USDT = 10;

function parseArgs(argv = process.argv.slice(2)) {
  const maxUsdtArg = argv.find((arg) => arg.startsWith('--max-usdt='));
  return {
    maxUsdt: Math.max(0.1, Number(maxUsdtArg?.split('=')[1] || DEFAULT_MAX_USDT)),
    json: argv.includes('--json'),
  };
}

function buildDecision(snapshot) {
  const unresolvedCount = Number(snapshot.unresolvedCount || 0);
  const unresolvedTotalUsdt = Number(snapshot.unresolvedTotalUsdt || 0);
  const actionableCount = Number(snapshot.actionableCount || 0);
  const actionableTotalUsdt = Number(snapshot.actionableTotalUsdt || 0);

  let status = 'binance_dust_clean';
  let headline = '초미세 더스트가 포지션을 오염시키지 않는 안정 구간입니다.';
  const reasons = [];
  const actionItems = [];

  if (unresolvedCount === 0) {
    reasons.push('convert 불가 더스트가 없습니다.');
  } else {
    reasons.push(`convert 불가 더스트 ${unresolvedCount}개`);
    reasons.push(`총합 ${unresolvedTotalUsdt.toFixed(6)} USDT`);
  }

  if (actionableCount > 0) {
    reasons.push(`즉시 convert 가능한 dust ${actionableCount}개 (${actionableTotalUsdt.toFixed(4)} USDT)`);
  }

  if (actionableCount >= 5 || actionableTotalUsdt >= 5) {
    status = 'binance_dust_actionable';
    headline = '자동 convert로 회수할 수 있는 dust가 다시 쌓이고 있습니다.';
    actionItems.push('dust sweeper를 돌려 convert 가능 잔량을 먼저 회수합니다.');
  }

  if (unresolvedCount > 0) {
    actionItems.push('convert 불가 더스트는 포지션이 아니라 dust ledger에서만 추적합니다.');
    actionItems.push('누적 후 최소 convert 수량을 넘는 시점에만 다시 정리합니다.');
  } else {
    actionItems.push('현재 기준을 유지하며 신규 dust 누적만 관찰합니다.');
  }

  return {
    status,
    headline,
    reasons,
    actionItems,
    metrics: {
      unresolvedCount,
      unresolvedTotalUsdt,
      actionableCount,
      actionableTotalUsdt,
    },
  };
}

function renderText(payload) {
  return [
    '🧹 Runtime Binance Dust',
    `maxUsdt: ${payload.maxUsdt}`,
    `status: ${payload.decision.status}`,
    `headline: ${payload.decision.headline}`,
    payload.aiSummary ? `🔍 AI: ${payload.aiSummary}` : null,
    '',
    '근거:',
    ...payload.decision.reasons.map((reason) => `- ${reason}`),
    '',
    '남은 dust:',
    ...(payload.snapshot.unresolvedTop.length > 0
      ? payload.snapshot.unresolvedTop.map((row) => `- ${row.coin} (${Number(row.usdtValue || 0).toFixed(6)} USDT)`)
      : ['- 없음']),
    '',
    '권장 조치:',
    ...payload.decision.actionItems.map((item) => `- ${item}`),
  ].filter(Boolean).join('\n');
}

function buildFallback(payload) {
  if (payload.decision.status === 'binance_dust_actionable') {
    return '회수 가능한 dust가 다시 쌓여 있어 자동 convert를 먼저 돌리는 편이 좋습니다.';
  }
  return '초미세 dust는 작고 convert 불가 상태라 포지션이 아닌 ledger로만 관리하면 충분합니다.';
}

export async function buildRuntimeBinanceDustReport({ maxUsdt = DEFAULT_MAX_USDT, json = false } = {}) {
  const snapshot = await buildBinanceDustSnapshot({ maxUsdt });
  const decision = buildDecision(snapshot);
  const payload = {
    ok: true,
    maxUsdt,
    snapshot,
    decision,
  };
  payload.aiSummary = await buildInvestmentCliInsight({
    bot: 'runtime-binance-dust',
    requestType: 'runtime-binance-dust',
    title: '투자 바이낸스 dust 요약',
    data: {
      maxUsdt,
      snapshot,
      decision,
    },
    fallback: buildFallback(payload),
  });
  if (json) return payload;
  return renderText(payload);
}

async function main() {
  const args = parseArgs();
  const result = await buildRuntimeBinanceDustReport(args);
  if (args.json) console.log(JSON.stringify(result, null, 2));
  else console.log(result);
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({
    run: main,
    errorPrefix: '❌ runtime-binance-dust-report 오류:',
  });
}
