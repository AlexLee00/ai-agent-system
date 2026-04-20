#!/usr/bin/env node
// @ts-nocheck

import * as db from '../shared/db.ts';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';
import { buildInvestmentCliInsight } from '../shared/cli-insight.ts';

function parseArgs(argv = process.argv.slice(2)) {
  const daysArg = argv.find((arg) => arg.startsWith('--days='));
  return {
    days: Math.max(1, Number(daysArg?.split('=')[1] || 14)),
    json: argv.includes('--json'),
  };
}

function buildDecision(rows = []) {
  const total = rows.reduce((sum, row) => sum + Number(row.count || 0), 0);
  const byTradeMode = rows.reduce((acc, row) => {
    const tradeMode = String(row.tradeMode || 'normal');
    acc[tradeMode] = (acc[tradeMode] || 0) + Number(row.count || 0);
    return acc;
  }, {});
  const bySymbol = rows.reduce((acc, row) => {
    const symbol = String(row.symbol || 'unknown');
    acc[symbol] = (acc[symbol] || 0) + Number(row.count || 0);
    return acc;
  }, {});
  const hottestSymbols = Object.entries(bySymbol)
    .sort((a, b) => Number(b[1] || 0) - Number(a[1] || 0))
    .slice(0, 5);

  let status = 'binance_circuit_ok';
  let headline = '최근 크립토 circuit breaker 압력이 두드러지지 않습니다.';
  const reasons = [];
  const actionItems = [];

  if (total === 0) {
    reasons.push('최근 크립토 circuit breaker 차단이 없습니다.');
  } else {
    reasons.push(`최근 크립토 circuit breaker ${total}건`);
    const modeSummary = Object.entries(byTradeMode)
      .sort((a, b) => Number(b[1] || 0) - Number(a[1] || 0))
      .map(([mode, count]) => `${mode} ${count}건`)
      .join(' | ');
    if (modeSummary) reasons.push(`레인별: ${modeSummary}`);
    if (hottestSymbols.length > 0) {
      reasons.push(`집중 심볼: ${hottestSymbols.map(([symbol, count]) => `${symbol} ${count}건`).join(' | ')}`);
    }
  }

  if (total >= 10) {
    status = 'binance_circuit_pressure';
    headline = '크립토 연속 손실 쿨다운이 반복적으로 실행을 막고 있습니다.';
  } else if (total > 0) {
    status = 'binance_circuit_watch';
    headline = '크립토 연속 손실 쿨다운이 간헐적으로 관찰됩니다.';
  }

  if (status === 'binance_circuit_pressure') {
    actionItems.push('loss streak가 normal/validation 어느 레인에 더 몰리는지 우선 비교합니다.');
    actionItems.push('집중 심볼 진입 품질과 쿨다운 설정을 함께 복기합니다.');
  } else if (status === 'binance_circuit_watch') {
    actionItems.push('watch 수준으로 유지하며 다음 리포트에서 레인별/심볼별 쏠림 변화를 비교합니다.');
  } else {
    actionItems.push('현재 수준을 유지하며 신규 circuit breaker 차단만 관찰합니다.');
  }

  return {
    status,
    headline,
    reasons,
    actionItems,
    metrics: {
      total,
      normal: Number(byTradeMode.normal || 0),
      validation: Number(byTradeMode.validation || 0),
      topSymbol: hottestSymbols[0]?.[0] || null,
      topSymbolCount: Number(hottestSymbols[0]?.[1] || 0),
    },
  };
}

function renderText(payload) {
  return [
    '🧯 Runtime Binance Circuit Breaker',
    `days: ${payload.days}`,
    `status: ${payload.decision.status}`,
    `headline: ${payload.decision.headline}`,
    payload.aiSummary ? `🔍 AI: ${payload.aiSummary}` : null,
    '',
    '근거:',
    ...payload.decision.reasons.map((reason) => `- ${reason}`),
    '',
    '상위 차단:',
    ...(payload.rows.length > 0
      ? payload.rows.slice(0, 8).map((row) => `- ${row.symbol} | ${row.tradeMode} | ${row.reason} (${row.count}건)`)
      : ['- 없음']),
    '',
    '권장 조치:',
    ...payload.decision.actionItems.map((item) => `- ${item}`),
  ].filter(Boolean).join('\n');
}

function buildFallback(payload) {
  if (payload.decision.status === 'binance_circuit_pressure') {
    return '크립토 연속 손실 쿨다운이 반복돼, 레인별 손실 집중과 심볼 쏠림을 먼저 보는 것이 좋습니다.';
  }
  if (payload.decision.status === 'binance_circuit_watch') {
    return '크립토 쿨다운 차단이 간헐적으로 보여, 다음 리포트에서 normal/validation 비중 변화를 비교하면 좋습니다.';
  }
  return '최근 크립토 circuit breaker 압력은 크지 않아 현 수준 관찰이면 충분합니다.';
}

async function loadRows(days = 14) {
  const safeDays = Math.max(1, Number(days || 14));
  return db.query(`
    SELECT
      symbol,
      COALESCE(trade_mode, 'normal') AS trade_mode,
      LEFT(COALESCE(block_reason, ''), 180) AS reason,
      COUNT(*)::INTEGER AS count
    FROM investment.signals
    WHERE exchange = 'binance'
      AND status = 'failed'
      AND COALESCE(block_code, '') = 'capital_circuit_breaker'
      AND created_at > now() - INTERVAL '${safeDays} days'
    GROUP BY symbol, COALESCE(trade_mode, 'normal'), LEFT(COALESCE(block_reason, ''), 180)
    ORDER BY count DESC
    LIMIT 30
  `).then((rows) => rows.map((row) => ({
    symbol: row.symbol,
    tradeMode: row.trade_mode,
    reason: row.reason,
    count: row.count,
  })));
}

export async function buildRuntimeBinanceCircuitBreakerReport({ days = 14, json = false } = {}) {
  const rows = await loadRows(days);
  const decision = buildDecision(rows);
  const payload = {
    ok: true,
    days,
    count: rows.reduce((sum, row) => sum + Number(row.count || 0), 0),
    rows,
    decision,
  };
  payload.aiSummary = await buildInvestmentCliInsight({
    bot: 'runtime-binance-circuit-breaker',
    requestType: 'runtime-binance-circuit-breaker',
    title: '투자 크립토 circuit breaker 압박 요약',
    data: {
      days,
      count: payload.count,
      topRows: rows.slice(0, 10),
      decision,
    },
    fallback: buildFallback(payload),
  });
  if (json) return payload;
  return renderText(payload);
}

async function main() {
  const args = parseArgs();
  const result = await buildRuntimeBinanceCircuitBreakerReport(args);
  if (args.json) console.log(JSON.stringify(result, null, 2));
  else console.log(result);
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({
    run: main,
    errorPrefix: '❌ runtime-binance-circuit-breaker-report 오류:',
  });
}
