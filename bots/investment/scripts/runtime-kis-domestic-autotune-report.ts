#!/usr/bin/env node
// @ts-nocheck

import * as db from '../shared/db.ts';
import { getInvestmentRuntimeConfig } from '../shared/runtime-config.ts';
import { getParameterGovernance } from '../shared/runtime-parameter-governance.ts';
import { buildRuntimeKisOrderPressureReport } from './runtime-kis-order-pressure-report.ts';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';
import { buildInvestmentCliInsight } from '../shared/cli-insight.ts';

function parseArgs(argv = process.argv.slice(2)) {
  const daysArg = argv.find((arg) => arg.startsWith('--days='));
  return {
    days: Math.max(1, Number(daysArg?.split('=')[1] || 14)),
    json: argv.includes('--json'),
  };
}

async function loadSignalRows(days = 14) {
  const safeDays = Math.max(1, Number(days || 14));
  return db.query(
    `SELECT
       status,
       COALESCE(NULLIF(block_code, ''), 'none') AS block_code,
       COUNT(*)::int AS cnt
     FROM investment.signals
     WHERE exchange = 'kis'
       AND action = 'BUY'
       AND created_at > now() - INTERVAL '${safeDays} days'
     GROUP BY 1, 2
     ORDER BY cnt DESC, status ASC`
  );
}

async function loadTradeRows(days = 14) {
  const safeDays = Math.max(1, Number(days || 14));
  return db.query(
    `SELECT
       paper,
       side,
       COUNT(*)::int AS cnt
     FROM investment.trades
     WHERE exchange = 'kis'
       AND executed_at > now() - INTERVAL '${safeDays} days'
     GROUP BY 1, 2
     ORDER BY 1 ASC, 2 ASC`
  );
}

function summarizeSignals(rows = []) {
  const totalBuy = rows.reduce((sum, row) => sum + Number(row?.cnt || 0), 0);
  const executedSignals = rows
    .filter((row) => String(row?.status || '') === 'executed')
    .reduce((sum, row) => sum + Number(row?.cnt || 0), 0);
  const failedSignals = rows
    .filter((row) => String(row?.status || '') === 'failed')
    .reduce((sum, row) => sum + Number(row?.cnt || 0), 0);
  const topBlocks = rows
    .filter((row) => String(row?.status || '') === 'failed')
    .map((row) => ({ code: row.block_code, count: Number(row.cnt || 0) }))
    .sort((a, b) => b.count - a.count || String(a.code).localeCompare(String(b.code)));
  return {
    totalBuy,
    executedSignals,
    failedSignals,
    executionRate: totalBuy > 0 ? Number(((executedSignals / totalBuy) * 100).toFixed(1)) : 0,
    topBlocks,
  };
}

function summarizeTrades(rows = []) {
  return {
    realBuyTrades: rows
      .filter((row) => row.paper === false && String(row.side || '').toLowerCase() === 'buy')
      .reduce((sum, row) => sum + Number(row?.cnt || 0), 0),
    paperBuyTrades: rows
      .filter((row) => row.paper === true && String(row.side || '').toLowerCase() === 'buy')
      .reduce((sum, row) => sum + Number(row?.cnt || 0), 0),
  };
}

function buildCandidate(config, signalSummary, orderPressureSummary) {
  const orderMetrics = orderPressureSummary?.decision?.metrics || {};
  const totalOrderPressure = Number(orderMetrics.total || 0);
  if (totalOrderPressure >= 5) {
    const key = 'runtime_config.luna.stockOrderDefaults.kis.buyDefault';
    const current = Number(config.luna?.stockOrderDefaults?.kis?.buyDefault || 500000);
    const suggested = Math.max(200000, current - 50000);
    if (suggested === current) return null;
    return {
      key,
      current,
      suggested,
      action: 'adjust',
      confidence: 'medium',
      reason: `최근 국내장 주문 초과 압력 ${totalOrderPressure}건이라 기본 주문금액을 낮춰 체결 전환을 비교할 수 있습니다.`,
      governance: getParameterGovernance(key),
    };
  }

  if (signalSummary.totalBuy >= 8 && signalSummary.executedSignals > 0 && signalSummary.executionRate < 40) {
    const key = 'runtime_config.luna.minConfidence.live.kis';
    const current = Number(config.luna?.minConfidence?.live?.kis || 0.22);
    const suggested = Math.max(0.12, Number((current - 0.02).toFixed(2)));
    if (suggested === current) return null;
    return {
      key,
      current,
      suggested,
      action: 'adjust',
      confidence: 'low',
      reason: `국내장 LIVE 실행률이 ${signalSummary.executionRate}%로 낮아 최소 확신도를 소폭 완화해 비교할 수 있습니다.`,
      governance: getParameterGovernance(key),
    };
  }
  return null;
}

function buildDecision(signalSummary, tradeSummary, orderPressureSummary, candidate = null) {
  const orderStatus = orderPressureSummary?.decision?.status || 'unknown';
  let status = 'kis_domestic_autotune_idle';
  let headline = '최근 국내장 self-tune 후보가 아직 없습니다.';
  const reasons = [
    `BUY 표본 ${signalSummary.totalBuy}건 / 실행 ${signalSummary.executedSignals}건 / 실패 ${signalSummary.failedSignals}건`,
    `실행률 ${signalSummary.executionRate}% / 실거래 BUY ${tradeSummary.realBuyTrades}건`,
    `주문 초과 압력 ${orderStatus}`,
  ];
  const actionItems = [];
  if (candidate) {
    status = 'kis_domestic_autotune_ready';
    headline = '국내장 제한적 self-tune 후보를 적용할 수 있습니다.';
    actionItems.push(`${candidate.key}를 ${candidate.current} → ${candidate.suggested}로 비교합니다.`);
  } else if (signalSummary.totalBuy > 0 || tradeSummary.realBuyTrades > 0) {
    status = 'kis_domestic_autotune_observe';
    headline = '국내장은 현재 병목이 약해 관찰 유지가 더 안전합니다.';
  }
  if (actionItems.length === 0) {
    actionItems.push('현재 국내장 실거래 흐름을 유지하며 다음 표본을 관찰합니다.');
  }
  return {
    status,
    headline,
    reasons,
    actionItems,
    metrics: {
      totalBuy: signalSummary.totalBuy,
      executedSignals: signalSummary.executedSignals,
      failedSignals: signalSummary.failedSignals,
      executionRate: signalSummary.executionRate,
      realBuyTrades: tradeSummary.realBuyTrades,
      paperBuyTrades: tradeSummary.paperBuyTrades,
      orderPressureStatus: orderStatus,
      orderPressureTotal: Number(orderPressureSummary?.decision?.metrics?.total || 0),
    },
  };
}

function renderText(payload) {
  const lines = [
    '🏦 Runtime KIS Domestic Autotune',
    `status: ${payload.decision.status}`,
    `headline: ${payload.decision.headline}`,
    payload.aiSummary ? `🔍 AI: ${payload.aiSummary}` : null,
    '',
    '근거:',
    ...payload.decision.reasons.map((item) => `- ${item}`),
    '',
    '권장 조치:',
    ...payload.decision.actionItems.map((item) => `- ${item}`),
  ];
  if (payload.candidate) {
    lines.push(`- 후보: ${payload.candidate.key} ${payload.candidate.current} -> ${payload.candidate.suggested}`);
  }
  return lines.filter(Boolean).join('\n');
}

function buildFallback(payload = {}) {
  const decision = payload.decision || {};
  if (decision.status === 'kis_domestic_autotune_ready') {
    return '국내장 병목이 확인돼 제한적 self-tune 후보를 비교할 수 있는 상태입니다.';
  }
  if (decision.status === 'kis_domestic_autotune_observe') {
    return '국내장은 현재 병목이 약해 관찰 유지가 더 안전합니다.';
  }
  return '최근 국내장 self-tune 후보는 없어 현재 흐름을 유지하며 보면 됩니다.';
}

export async function buildRuntimeKisDomesticAutotuneReport({ days = 14, json = false } = {}) {
  await db.initSchema();
  const [signalRows, tradeRows, orderPressureSummary] = await Promise.all([
    loadSignalRows(days),
    loadTradeRows(days),
    buildRuntimeKisOrderPressureReport({ days, json: true }),
  ]);
  const config = getInvestmentRuntimeConfig();
  const signalSummary = summarizeSignals(signalRows);
  const tradeSummary = summarizeTrades(tradeRows);
  const candidate = buildCandidate(config, signalSummary, orderPressureSummary);
  const decision = buildDecision(signalSummary, tradeSummary, orderPressureSummary, candidate);
  const payload = {
    ok: true,
    days,
    signalRows,
    tradeRows,
    signalSummary,
    tradeSummary,
    orderPressureSummary,
    candidate,
    decision,
  };
  payload.aiSummary = await buildInvestmentCliInsight({
    bot: 'runtime-kis-domestic-autotune-report',
    requestType: 'runtime-kis-domestic-autotune-report',
    title: '투자 국내장 self-tune 리포트 요약',
    data: { days, signalSummary, tradeSummary, candidate, decision },
    fallback: buildFallback(payload),
  });
  if (json) return payload;
  return renderText(payload);
}

async function main() {
  const args = parseArgs();
  const result = await buildRuntimeKisDomesticAutotuneReport(args);
  if (args.json) console.log(JSON.stringify(result, null, 2));
  else console.log(result);
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({
    run: main,
    errorPrefix: '❌ runtime-kis-domestic-autotune-report 오류:',
  });
}
