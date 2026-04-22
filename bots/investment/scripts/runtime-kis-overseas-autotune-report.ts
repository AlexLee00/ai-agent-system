#!/usr/bin/env node
// @ts-nocheck

import * as db from '../shared/db.ts';
import { getInvestmentRuntimeConfig } from '../shared/runtime-config.ts';
import { getExchangeEvidenceBaseline } from '../shared/runtime-config.ts';
import { getParameterGovernance } from '../shared/runtime-parameter-governance.ts';
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
  const baseline = getExchangeEvidenceBaseline('kis_overseas');
  const lowerBound = baseline
    ? `GREATEST(now() - INTERVAL '${safeDays} days', TIMESTAMP '${baseline}')`
    : `now() - INTERVAL '${safeDays} days'`;
  return db.query(
    `SELECT
       status,
       COALESCE(NULLIF(block_code, ''), 'none') AS block_code,
       COUNT(*)::int AS cnt
     FROM investment.signals
     WHERE exchange = 'kis_overseas'
       AND action = 'BUY'
       AND created_at > ${lowerBound}
     GROUP BY 1, 2
     ORDER BY cnt DESC, status ASC`
  );
}

async function loadTradeRows(days = 14) {
  const safeDays = Math.max(1, Number(days || 14));
  const baseline = getExchangeEvidenceBaseline('kis_overseas');
  const lowerBound = baseline
    ? `GREATEST(now() - INTERVAL '${safeDays} days', TIMESTAMP '${baseline}')`
    : `now() - INTERVAL '${safeDays} days'`;
  return db.query(
    `SELECT
       paper,
       side,
       COUNT(*)::int AS cnt
     FROM investment.trades
     WHERE exchange = 'kis_overseas'
       AND executed_at > ${lowerBound}
     GROUP BY 1, 2
     ORDER BY 1 ASC, 2 ASC`
  );
}

function countByStatus(rows = [], status = '') {
  return rows
    .filter((row) => String(row?.status || '') === status)
    .reduce((sum, row) => sum + Number(row?.cnt || 0), 0);
}

function summarizeSignals(rows = []) {
  const totalBuy = rows.reduce((sum, row) => sum + Number(row?.cnt || 0), 0);
  const executedSignals = countByStatus(rows, 'executed');
  const failedSignals = countByStatus(rows, 'failed');
  const topBlocks = rows
    .filter((row) => String(row?.status || '') === 'failed')
    .map((row) => ({ code: row.block_code, count: Number(row.cnt || 0) }))
    .sort((a, b) => b.count - a.count || String(a.code).localeCompare(String(b.code)));
  const mockUnsupported = topBlocks.find((row) => row.code === 'mock_operation_unsupported')?.count || 0;
  const effectiveTopBlocks = topBlocks.filter((row) => row.code !== 'mock_operation_unsupported');
  const effectiveFailedSignals = effectiveTopBlocks.reduce((sum, row) => sum + Number(row.count || 0), 0);
  const minOrderNotional = topBlocks.find((row) => row.code === 'min_order_notional')?.count || 0;

  return {
    totalBuy,
    executedSignals,
    failedSignals,
    effectiveFailedSignals,
    executionRate: totalBuy > 0 ? Number(((executedSignals / totalBuy) * 100).toFixed(1)) : 0,
    topBlocks,
    effectiveTopBlocks,
    mockUnsupported,
    minOrderNotional,
  };
}

function summarizeTrades(rows = []) {
  const realBuyTrades = rows
    .filter((row) => row.paper === false && String(row.side || '').toLowerCase() === 'buy')
    .reduce((sum, row) => sum + Number(row?.cnt || 0), 0);
  const paperBuyTrades = rows
    .filter((row) => row.paper === true && String(row.side || '').toLowerCase() === 'buy')
    .reduce((sum, row) => sum + Number(row?.cnt || 0), 0);
  return {
    realBuyTrades,
    paperBuyTrades,
  };
}

function buildCandidate(config, signalSummary) {
  if (signalSummary.totalBuy < 8 || signalSummary.executedSignals <= 0) return null;

  if (signalSummary.minOrderNotional >= 5) {
    const key = 'runtime_config.luna.stockOrderDefaults.kis_overseas.min';
    const current = Number(config.luna?.stockOrderDefaults?.kis_overseas?.min || 200);
    const suggested = Math.max(current, Math.min(400, current + 25));
    if (suggested === current) return null;
    return {
      key,
      current,
      suggested,
      action: 'adjust',
      confidence: 'medium',
      reason: `최근 해외장 BUY 실패 ${signalSummary.failedSignals}건 중 최소 주문금액 미달이 ${signalSummary.minOrderNotional}건이라 주문 floor를 소폭 상향해 비교할 수 있습니다.`,
      governance: getParameterGovernance(key),
    };
  }

  if (signalSummary.executionRate < 40 && signalSummary.effectiveFailedSignals >= 3) {
    const key = 'runtime_config.luna.minConfidence.live.kis_overseas';
    const current = Number(config.luna?.minConfidence?.live?.kis_overseas || 0.22);
    const suggested = Math.max(0.12, Number((current - 0.02).toFixed(2)));
    if (suggested === current) return null;
    return {
      key,
      current,
      suggested,
      action: 'adjust',
      confidence: 'low',
      reason: `최근 해외장 LIVE 실행률이 ${signalSummary.executionRate}%로 낮아 최소 확신도를 소폭 완화해 비교할 수 있습니다.`,
      governance: getParameterGovernance(key),
    };
  }

  return null;
}

function buildDecision(signalSummary, tradeSummary, candidate = null) {
  const baseline = getExchangeEvidenceBaseline('kis_overseas');
  let status = 'kis_overseas_autotune_idle';
  let headline = '실계좌 전환 이후 해외장 self-tune 후보가 아직 없습니다.';
  const reasons = [
    baseline ? `실계좌 기준선: ${baseline}` : null,
    `BUY 표본 ${signalSummary.totalBuy}건 / 실행 ${signalSummary.executedSignals}건 / 실패 ${signalSummary.failedSignals}건`,
    `실효 실패 ${signalSummary.effectiveFailedSignals}건 / mock 노이즈 ${signalSummary.mockUnsupported}건`,
    `실행률 ${signalSummary.executionRate}% / 실거래 BUY ${tradeSummary.realBuyTrades}건`,
  ].filter(Boolean);
  const actionItems = [];

  if (candidate) {
    status = 'kis_overseas_autotune_ready';
    headline = '해외장 제한적 self-tune 후보를 적용할 수 있습니다.';
    actionItems.push(`${candidate.key}를 ${candidate.current} → ${candidate.suggested}로 비교합니다.`);
  } else if (signalSummary.totalBuy > 0) {
    status = 'kis_overseas_autotune_observe';
    headline = '해외장 표본은 있지만 지금은 관찰 유지가 더 안전합니다.';
  }

  const topBlock = signalSummary.effectiveTopBlocks[0] || signalSummary.topBlocks[0] || null;
  if (topBlock) {
    actionItems.push(`대표 병목은 ${topBlock.code} ${topBlock.count}건입니다.`);
  }
  if (actionItems.length === 0) {
    actionItems.push('표본을 더 누적하면서 실거래 체결 전환을 관찰합니다.');
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
      effectiveFailedSignals: signalSummary.effectiveFailedSignals,
      mockUnsupported: signalSummary.mockUnsupported,
      executionRate: signalSummary.executionRate,
      minOrderNotional: signalSummary.minOrderNotional,
      realBuyTrades: tradeSummary.realBuyTrades,
      paperBuyTrades: tradeSummary.paperBuyTrades,
      topBlock: topBlock?.code || null,
      topBlockCount: Number(topBlock?.count || 0),
    },
  };
}

function renderText(payload) {
  const lines = [
    '🌍 Runtime KIS Overseas Autotune',
    `status: ${payload.decision.status}`,
    `headline: ${payload.decision.headline}`,
    payload.aiSummary ? `🔍 AI: ${payload.aiSummary}` : null,
    '',
    '근거:',
    ...payload.decision.reasons.map((item) => `- ${item}`),
    '',
    '대표 실패:',
    ...(payload.signalSummary.effectiveTopBlocks.length > 0
      ? payload.signalSummary.effectiveTopBlocks.slice(0, 5).map((item) => `- ${item.code}: ${item.count}건`)
      : ['- 없음']),
    '',
    '권장 조치:',
    ...payload.decision.actionItems.map((item) => `- ${item}`),
    payload.candidate
      ? `- 후보: ${payload.candidate.key} ${payload.candidate.current} -> ${payload.candidate.suggested}`
      : null,
  ];
  return lines.filter(Boolean).join('\n');
}

function buildFallback(payload = {}) {
  const decision = payload.decision || {};
  if (decision.status === 'kis_overseas_autotune_ready') {
    return '해외장 실행 병목이 반복돼 제한적 self-tune 후보를 비교할 수 있는 상태입니다.';
  }
  if (decision.status === 'kis_overseas_autotune_observe') {
    return '해외장 표본은 있지만 아직은 즉시 조정보다 관찰 유지가 더 안전합니다.';
  }
  return '최근 해외장 self-tune 후보는 없어 관찰 중심으로 보면 됩니다.';
}

export async function buildRuntimeKisOverseasAutotuneReport({ days = 14, json = false } = {}) {
  await db.initSchema();
  const [signalRows, tradeRows] = await Promise.all([
    loadSignalRows(days),
    loadTradeRows(days),
  ]);
  const config = getInvestmentRuntimeConfig();
  const signalSummary = summarizeSignals(signalRows);
  const tradeSummary = summarizeTrades(tradeRows);
  const candidate = buildCandidate(config, signalSummary);
  const decision = buildDecision(signalSummary, tradeSummary, candidate);

  const payload = {
    ok: true,
    days,
    signalRows,
    tradeRows,
    signalSummary,
    tradeSummary,
    candidate,
    decision,
  };

  payload.aiSummary = await buildInvestmentCliInsight({
    bot: 'runtime-kis-overseas-autotune-report',
    requestType: 'runtime-kis-overseas-autotune-report',
    title: '투자 해외장 self-tune 리포트 요약',
    data: {
      days,
      signalSummary,
      tradeSummary,
      candidate,
      decision,
    },
    fallback: buildFallback(payload),
  });

  if (json) return payload;
  return renderText(payload);
}

async function main() {
  const args = parseArgs();
  const result = await buildRuntimeKisOverseasAutotuneReport(args);
  if (args.json) console.log(JSON.stringify(result, null, 2));
  else console.log(result);
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({
    run: main,
    errorPrefix: '❌ runtime-kis-overseas-autotune-report 오류:',
  });
}
